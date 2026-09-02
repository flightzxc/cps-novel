import { opendir, readFile, stat } from "node:fs/promises";
import type { Dir, Stats } from "node:fs";
import { join } from "node:path";

/**
 * `/api/health/backup` 的判定逻辑（RC-7b，直搬 CPS `v8.3.6`
 * `src/lib/health-backup-status.ts`，`baseline_commit
 * 16f2e4cfca51f46af0dede899ecf6242a770bbd0`，登记见 port-registry 报告）。
 *
 * 背景（CPS 2026-08-19/08-20 生产事故）：备份连续两晚静默失败，没有任何东西在看
 * 日志，直到人工排查才发现。这个模块的唯一职责就是不让同一件事以另一种形式重
 * 演——参见 `@/server/health/service.ts` 的 `getHealthReport` 刻意不碰数据库、
 * 而 CPS 的 `/api/health` 在同一次事故里全站数据库死透的 103 分钟内一路返回
 * 200 的教训。如果这里只回显一份写死的状态字，备份停跑之后它会永远显示 ok，
 * 是同一个坑。
 *
 * 所以核心规则只有一条：新鲜度必须在**请求时**用 now() 与"最近一次真实发生的
 * 备份"现算，绝不能只读预先算好的布尔值。
 *
 * 两个信息源，优先级明确（与 CPS 一致）：
 *   A) 状态文件（env `BACKUP_STATUS_FILE` 指向的 JSON，预期由未来的 Postgres
 *      备份脚本写出，字段与 CPS 状态文件同构：`finishedAt`/`exitCode`）。信息
 *      最全——含退出码。只要文件存在（哪怕内容坏了），一律走这条。
 *   B) 备份产物本身（env `BACKUP_OUTPUT_DIR` 目录里最新一份匹配命名规则的文件
 *      的 mtime）。只在状态文件根本不存在时才启用——一个死掉的 cron 伪造不了
 *      文件 mtime，产物比任何自我报告都可信。本仓 `infra/production-like/
 *      backup-timer.sh` 现在产出的是 `cps-novel-x8-<UTC 时间戳>.dump`（pg_dump
 *      逻辑备份），命名规则相应改为 `*.dump` / `*.sql*`，不是 CPS 的 `*.db`。
 *
 * 判定优先级：
 *   1) `BACKUP_STATUS_FILE` 已配置：
 *      1a) 文件存在但读不出 / 不是合法 JSON / 缺字段 / 超时 → failed
 *      1b) `exitCode !== 0` → failed（不看 age，哪怕刚失败）
 *      1c) `exitCode === 0` 且 age(now, finishedAt) ≥ 阈值 → stale
 *      1d) `exitCode === 0` 且 age < 阈值 → ok
 *      1e) 文件不存在（ENOENT）→ 退回 2)
 *   2) `BACKUP_STATUS_FILE` 未配置，或文件不存在：
 *      2a) `BACKUP_OUTPUT_DIR` 未配置，或目录不存在，或目录里一个匹配命名规则
 *          的产物都没有 → unconfigured
 *      2b) 有匹配产物，取最新一份（mtime 最大者，且体积 > 0）：
 *          - age < 阈值 → ok（source: output_dir）
 *          - age ≥ 阈值 → stale（source: output_dir）
 *      退路只产出 ok / stale / unconfigured，从不产出 failed——它只能观察"有没有
 *      新东西落地"，观察不到"上一次跑失败了"（那需要退出码，只有状态文件有）。
 *
 * unconfigured 为什么返回 200（与 CPS 一致，见 route.ts 头注释的完整论证）：
 * 部署这一刻备份目录里可能还没有任何匹配产物（全新环境、还没跑过第一次备份）；
 * 如果这时端点返回 503，创建监控会立刻误报。调用方必须看 `backupStatus` 字段，
 * 不能只看 HTTP 状态码——这正是外部监控必须配成 **Keyword 类型**（判据
 * `"backupStatus":"ok"`）而不是纯状态码类型的原因。
 *
 * 响应体不含路径：状态文件路径、产物目录路径、匹配到的文件名一律不进入返回值
 * 或日志之外的任何输出——只输出 `{ backupStatus, checkedAt, ageHours, source }`。
 */

export const DEFAULT_STALE_THRESHOLD_HOURS = 26;
// 本地小文件读取 / 目录扫描正常在个位数毫秒内完成；这个超时只是防御性兜底（异常
// 的挂载层/磁盘故障），不是常态路径。超时按"读不出"处理，不让请求挂起。状态文
// 件读取与产物目录扫描各自独立套用这个预算（与 CPS 一致）。
export const BACKUP_STATUS_READ_TIMEOUT_MS = 2_000;
// 目录扫描的双重界限，直接搬自 CPS：条目数超过 MAX_ARTIFACT_DIR_ENTRIES 直接放
// 弃扫描；命名匹配后真正 stat() 的候选数再设 MAX_ARTIFACT_STAT_CANDIDATES 上限。
export const MAX_ARTIFACT_DIR_ENTRIES = 5_000;
export const MAX_ARTIFACT_STAT_CANDIDATES = 500;

// 只接受 pg_dump 逻辑备份的两类常见产物命名，白名单式匹配：
//   - *.dump  —— `pg_dump -Fc`（自定义格式）默认产物，`backup-timer.sh` 现行产出
//   - *.sql / *.sql.<ext>（如 .sql.gz）—— 纯文本或压缩后的 SQL 转储
// 与 CPS 一样，白名单本身排除了不该被当成"新鲜备份"的文件（校验哨兵、暂存文
// 件等），不需要额外黑名单分支。
const ARTIFACT_NAME_PATTERN = /\.(?:dump|sql(?:\.[A-Za-z0-9]+)?)$/i;

export type BackupStatusValue = "ok" | "unconfigured" | "failed" | "stale";
export type BackupStatusSource = "status_file" | "output_dir" | "none";

export interface BackupHealthResult {
  backupStatus: BackupStatusValue;
  checkedAt: string;
  ageHours: number | null;
  source: BackupStatusSource;
}

interface RawBackupStatus {
  finishedAt: string;
  exitCode: number;
}

export interface BackupStatusOptions {
  statusFilePath?: string;
  outputDir?: string;
  thresholdHours?: number;
  now?: () => number;
  readTimeoutMs?: number;
  /** 测试注入点：默认实现读取真实文件系统。 */
  readStatusFile?: (path: string) => Promise<string>;
  openArtifactDir?: (dir: string) => Promise<Dir>;
  statArtifact?: (path: string) => Promise<Stats>;
}

function isValidRawStatus(value: unknown): value is RawBackupStatus {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.finishedAt === "string"
    && !Number.isNaN(Date.parse(v.finishedAt))
    && typeof v.exitCode === "number"
    && Number.isInteger(v.exitCode)
  );
}

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(value), ms);
    timer.unref?.();
  });
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, timeoutValue: T): Promise<T> {
  return Promise.race([work, delay(timeoutMs, timeoutValue)]);
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isDailyArtifactName(name: string): boolean {
  return ARTIFACT_NAME_PATTERN.test(name);
}

interface ArtifactCandidate {
  name: string;
  mtimeMs: number;
  size: number;
}

/** 有界地列出 $dir 顶层文件名（不递归）。返回 null 代表"这个目录不该参与判定"。 */
async function listArtifactDirBounded(
  dir: string,
  openDir: NonNullable<BackupStatusOptions["openArtifactDir"]>,
): Promise<string[] | null> {
  let handle;
  try {
    handle = await openDir(dir);
  } catch (err) {
    if (!isMissingFileError(err)) {
      console.error("[health/backup] artifact dir open error", { reasonCode: "artifact_dir_open_error" });
    }
    return null;
  }

  const names: string[] = [];
  try {
    for await (const entry of handle as AsyncIterable<{ name: string }>) {
      names.push(entry.name);
      if (names.length > MAX_ARTIFACT_DIR_ENTRIES) {
        console.error("[health/backup] artifact dir too large", { reasonCode: "artifact_dir_too_large" });
        return null;
      }
    }
  } catch {
    console.error("[health/backup] artifact dir read error", { reasonCode: "artifact_dir_read_error" });
    return null;
  } finally {
    await (handle as { close: () => Promise<void> }).close().catch(() => {});
  }
  return names;
}

async function evaluateFromOutputDir(
  outputDir: string | undefined,
  thresholdMs: number,
  now: number,
  timeoutMs: number,
  openDir: NonNullable<BackupStatusOptions["openArtifactDir"]>,
  statArtifact: NonNullable<BackupStatusOptions["statArtifact"]>,
): Promise<BackupHealthResult> {
  const trimmedDir = outputDir?.trim();
  if (!trimmedDir) {
    return { backupStatus: "unconfigured", checkedAt: new Date(now).toISOString(), ageHours: null, source: "none" };
  }

  const names = await withTimeout(listArtifactDirBounded(trimmedDir, openDir), timeoutMs, null);
  const candidateNames = (names ?? []).filter(isDailyArtifactName).slice(0, MAX_ARTIFACT_STAT_CANDIDATES);
  if (candidateNames.length === 0) {
    return { backupStatus: "unconfigured", checkedAt: new Date(now).toISOString(), ageHours: null, source: "none" };
  }

  const stats = await withTimeout(
    Promise.all(
      candidateNames.map(async (name): Promise<ArtifactCandidate | null> => {
        try {
          const st = await statArtifact(join(trimmedDir, name));
          if (!st.isFile() || st.size <= 0) return null;
          return { name, mtimeMs: st.mtimeMs, size: st.size };
        } catch {
          return null;
        }
      }),
    ),
    timeoutMs,
    null,
  );

  let newest: ArtifactCandidate | null = null;
  for (const candidate of stats ?? []) {
    if (!candidate) continue;
    if (!newest || candidate.mtimeMs > newest.mtimeMs) newest = candidate;
  }

  if (!newest) {
    return { backupStatus: "unconfigured", checkedAt: new Date(now).toISOString(), ageHours: null, source: "none" };
  }

  const ageMs = now - newest.mtimeMs;
  const ageHours = Math.max(0, ageMs) / (60 * 60 * 1000);
  return {
    backupStatus: ageMs >= thresholdMs ? "stale" : "ok",
    checkedAt: new Date(now).toISOString(),
    ageHours,
    source: "output_dir",
  };
}

export async function evaluateBackupStatus(options: BackupStatusOptions = {}): Promise<BackupHealthResult> {
  const now = (options.now ?? Date.now)();
  const timeoutMs = options.readTimeoutMs ?? BACKUP_STATUS_READ_TIMEOUT_MS;
  const envThreshold = Number(process.env.BACKUP_STALE_THRESHOLD_HOURS);
  const thresholdHours = options.thresholdHours
    ?? (Number.isFinite(envThreshold) && envThreshold > 0 ? envThreshold : DEFAULT_STALE_THRESHOLD_HOURS);
  const thresholdMs = thresholdHours * 60 * 60 * 1000;
  const readStatusFile = options.readStatusFile ?? ((path: string) => readFile(path, "utf8"));
  const openArtifactDir = options.openArtifactDir ?? ((dir: string) => opendir(dir));
  const statArtifact = options.statArtifact ?? ((path: string) => stat(path));

  const statusFilePath = (options.statusFilePath ?? process.env.BACKUP_STATUS_FILE)?.trim();

  if (statusFilePath) {
    let text: string;
    try {
      const outcome = await Promise.race([
        readStatusFile(statusFilePath).then((value) => ({ kind: "ok" as const, value })),
        delay(timeoutMs, { kind: "timeout" as const }),
      ]);
      if (outcome.kind === "timeout") {
        console.error("[health/backup] status file read timeout", { reasonCode: "read_timeout" });
        return { backupStatus: "failed", checkedAt: new Date(now).toISOString(), ageHours: null, source: "status_file" };
      }
      text = outcome.value;
    } catch (err) {
      if (isMissingFileError(err)) {
        // 状态文件根本不存在——退回观察备份产物本身，而不是直接判 unconfigured。
        return evaluateFromOutputDir(
          options.outputDir ?? process.env.BACKUP_OUTPUT_DIR,
          thresholdMs,
          now,
          timeoutMs,
          openArtifactDir,
          statArtifact,
        );
      }
      console.error("[health/backup] status file read error", { reasonCode: "read_error" });
      return { backupStatus: "failed", checkedAt: new Date(now).toISOString(), ageHours: null, source: "status_file" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.error("[health/backup] status file corrupt json", { reasonCode: "corrupt_json" });
      return { backupStatus: "failed", checkedAt: new Date(now).toISOString(), ageHours: null, source: "status_file" };
    }

    if (!isValidRawStatus(parsed)) {
      console.error("[health/backup] status file invalid shape", { reasonCode: "invalid_status_shape" });
      return { backupStatus: "failed", checkedAt: new Date(now).toISOString(), ageHours: null, source: "status_file" };
    }

    if (parsed.exitCode !== 0) {
      // 最近一次运行失败——不看 age，哪怕刚失败也必须立刻可见。
      return { backupStatus: "failed", checkedAt: new Date(now).toISOString(), ageHours: null, source: "status_file" };
    }

    const ageMs = now - Date.parse(parsed.finishedAt);
    const ageHours = Math.max(0, ageMs) / (60 * 60 * 1000);
    return {
      backupStatus: ageMs >= thresholdMs ? "stale" : "ok",
      checkedAt: new Date(now).toISOString(),
      ageHours,
      source: "status_file",
    };
  }

  return evaluateFromOutputDir(
    options.outputDir ?? process.env.BACKUP_OUTPUT_DIR,
    thresholdMs,
    now,
    timeoutMs,
    openArtifactDir,
    statArtifact,
  );
}
