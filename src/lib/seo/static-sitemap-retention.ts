/**
 * B-33：静态站点地图 `releases/` 的版本保留策略。
 *
 * 目录事实（以代码为准，见 static-sitemap-generator.ts / sitemap-refresh-state.ts）：
 * - 每次刷新在 `<root>/releases/<runId>/` 下新建一个版本目录，里面是 sitemap.xml、sitemap/*.xml、manifest.json；
 *   worker 路径的 runId 是任务 UUID，人工旧路径是 `release-<ISO 时间>-<pid>[-版本]`。目录名不带可比较的时间。
 * - `<root>/current` 是指向 `releases/<runId>` 的**相对软链**，先建 `current.tmp` 再 rename 原子切换（promote）。
 *   web 每次请求都经 `current/…` 读文件，没有常驻句柄。
 * - 失败的刷新不会清理自己写了一半的目录（没有 manifest，或 manifest.promotedAt 为 null）。
 * - 同一时刻只有一个 sitemap_refresh 任务（全局 scope 部分唯一索引）+ 一把 `sitemap-generation.lock` 文件锁。
 *
 * 保留规则（promote 成功之后由 refreshStaticSitemap 调用，见 `cleanupStaticSitemapReleases`）：
 * 1. `current` 指向的版本永远保留；本次刷新的 runId 与锁文件里记录的 runId（别人正在写的）也永远保留。
 * 2. 已 promote 的版本（manifest.promotedAt 有效）按 promotedAt 取最近 `SITEMAP_RELEASE_KEEP_RECENT` 个保留，其余删除。
 * 3. 未 promote 的残留（没 manifest / promotedAt 为空 / 读不出）只有同时满足
 *    "早于 current" 且 "最后一次写入距今 >= SITEMAP_RELEASE_ORPHAN_MIN_AGE_MS" 才删除。
 * 4. 名字不是 UUID 也不是 `release-` 开头的目录、非目录条目一律不碰（只计入 ignored）。
 * 5. 任何前置条件读不清（current 不是指向 releases/ 的软链、目标不存在……）就整次不删（fail-closed）。
 *
 * 首次上线时生产上已有几百个旧目录：单次最多删 `SITEMAP_RELEASE_MAX_REMOVALS_PER_RUN` 个、
 * 最多花 `SITEMAP_RELEASE_TIME_BUDGET_MS`，先删最旧的，剩下的留给下一次刷新继续（日志里的 deferred）。
 *
 * 清理永远不改变刷新结果：本模块不抛错，结果只写一条结构化日志。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { getStaticSitemapRoot } from "@/lib/seo/static-sitemap-cache";

/**
 * 保留的已发布版本数（含 current 若它在其中）。
 *
 * 为什么是 10：回滚只需要"上一个好版本"，10 个够覆盖一次批量发布连刷几轮的回退余量；
 * web 读文件没有常驻句柄，读者最多跨一次切换，几分钟前的版本早已无人访问。
 * 体积上每个版本按 2026-10-07 的 11.8 万条 URL 估约 25–55 MB（每条 200–450 B），10 个约 0.25–0.55 GB；
 * 再多只是白占盘（生产此前一天攒 30+ 个）。
 */
export const SITEMAP_RELEASE_KEEP_RECENT = 10;

/**
 * 未 promote 的残留目录，最后一次写入距今不足这么久就当"可能还在写"，不删。
 * 取 2 小时：远大于实测 22 秒的生成耗时，也远大于 worker 把文件锁判为过期的 35 分钟
 * （worker/handlers/sitemap-refresh.ts 的 SITEMAP_FILE_LOCK_STALE_MS）；
 * 超过它仍没动静的目录只可能是失败残留或已被判过期的僵尸。
 */
export const SITEMAP_RELEASE_ORPHAN_MIN_AGE_MS = 2 * 60 * 60 * 1000;

/** 单次清理最多删多少个目录（首次上线时分批消化存量）。 */
export const SITEMAP_RELEASE_MAX_REMOVALS_PER_RUN = 100;

/** 单次清理的时间预算；用完不再开始新的删除，剩余下次继续。 */
export const SITEMAP_RELEASE_TIME_BUDGET_MS = 10_000;

/** 连续这么多个目录删除失败（典型：权限问题）就放弃本次，避免对着同一个故障空转。 */
export const SITEMAP_RELEASE_MAX_CONSECUTIVE_FAILURES = 5;

export const SITEMAP_RELEASE_CLEANUP_EVENT = "sitemap_release_cleanup";

const RELEASES_DIR = "releases";
const CURRENT_LINK = "current";
const MANIFEST_FILE = "manifest.json";
const CHILD_DIR = "sitemap";
const FAILED_NAMES_LOGGED = 5;

const UUID_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MANUAL_RELEASE_NAME = /^release-[A-Za-z0-9._-]+$/;

export type SitemapReleaseCleanupOutcome = "ok" | "partial" | "skipped" | "error";

/** 一条清理日志的完整形态；只含计数、版本目录名和错误码，不含错误消息。 */
export interface SitemapReleaseCleanupEvent {
  schemaVersion: 1;
  event: typeof SITEMAP_RELEASE_CLEANUP_EVENT;
  /** ok = 无失败；partial = 有删除失败；skipped = 前置条件不满足、什么都没删；error = 意外异常。 */
  outcome: SitemapReleaseCleanupOutcome;
  reason?: string;
  keepRecent: number;
  /** current 指向的版本目录名；读不出为 null。 */
  current: string | null;
  /** releases/ 下清理开始前的真实目录数。 */
  total: number;
  /** 清理结束后仍在的目录数（total - removed）。 */
  kept: number;
  removed: number;
  failed: number;
  /** 应删但因数量/时间/失败上限留给下次的目录数。 */
  deferred: number;
  /** 删掉的目录的文件逻辑大小之和（字节，不是磁盘块数）。 */
  freedBytes: number;
  /** 因"不够老 / 不早于 current"而保留的未 promote 残留数。 */
  keptOrphans: number;
  /** 名字不认识的目录和非目录条目数（不碰）。 */
  ignored: number;
  durationMs: number;
  failedReleases?: string[];
  errorCodes?: string[];
}

export interface SitemapReleaseCleanupOptions {
  rootDir?: string;
  /** 额外必须保留的版本目录名：本次刷新的 runId、别人持有的锁里的 runId。 */
  protectNames?: readonly string[];
  /** 锁文件存在却读不出 runId：不确定谁在写，未 promote 的残留一概不删。 */
  orphansUnsafe?: boolean;
  now?: () => number;
  removeDirectory?: (directory: string) => Promise<void>;
  log?: (event: SitemapReleaseCleanupEvent) => void;
}

interface ReleaseEntry {
  name: string;
  dir: string;
  owned: boolean;
  /** 目录、sitemap/ 子目录、manifest.json 三者 mtime 的最大值 = 最后一次写入。 */
  activityMs: number;
  /** manifest.promotedAt（已 promote 才有）。 */
  promotedAtMs: number | null;
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "UNKNOWN";
}

function defaultLog(event: SitemapReleaseCleanupEvent): void {
  const line = JSON.stringify(event);
  if (event.outcome === "ok") console.log(line);
  else console.warn(line);
}

export function isSitemapReleaseOwnedName(name: string): boolean {
  return UUID_NAME.test(name) || MANUAL_RELEASE_NAME.test(name);
}

async function removeDirectoryRecursive(directory: string): Promise<void> {
  await fs.rm(directory, { recursive: true, force: true });
}

/**
 * current 指向的版本目录名；不是软链 / 不指向 releases/ 的直接子目录 / 目标不存在 => null。
 * 用 realpath 归一化，避免 tmp 目录自身是软链（macOS /var -> /private/var）时误判。
 */
async function resolveCurrentReleaseName(rootDir: string): Promise<string | null> {
  const linkPath = path.join(rootDir, CURRENT_LINK);
  let linkStat;
  try {
    linkStat = await fs.lstat(linkPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!linkStat.isSymbolicLink()) return null;

  const target = path.resolve(rootDir, await fs.readlink(linkPath));
  let realTarget: string;
  let realReleases: string;
  try {
    realTarget = await fs.realpath(target);
    realReleases = await fs.realpath(path.join(rootDir, RELEASES_DIR));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (path.dirname(realTarget) !== realReleases) return null;
  return path.basename(realTarget);
}

async function readPromotedAtMs(
  dir: string,
): Promise<{ promotedAtMs: number | null; manifestMtimeMs: number }> {
  try {
    const manifestPath = path.join(dir, MANIFEST_FILE);
    const [raw, stat] = await Promise.all([fs.readFile(manifestPath, "utf-8"), fs.stat(manifestPath)]);
    const parsed = JSON.parse(raw) as { promotedAt?: unknown };
    const promotedAtMs = typeof parsed.promotedAt === "string" ? Date.parse(parsed.promotedAt) : Number.NaN;
    return {
      promotedAtMs: Number.isFinite(promotedAtMs) ? promotedAtMs : null,
      manifestMtimeMs: stat.mtimeMs,
    };
  } catch {
    // 没有 / 读不出 / 不是合法 JSON：一律按"未 promote"处理，走更严的残留规则。
    return { promotedAtMs: null, manifestMtimeMs: 0 };
  }
}

async function readEntry(releasesDir: string, name: string): Promise<ReleaseEntry> {
  const dir = path.join(releasesDir, name);
  const stat = await fs.lstat(dir);
  let activityMs = stat.mtimeMs;
  try {
    const child = await fs.lstat(path.join(dir, CHILD_DIR));
    if (child.isDirectory()) activityMs = Math.max(activityMs, child.mtimeMs);
  } catch {
    // 没有子目录（刚建一半）就只看目录自身。
  }
  const manifest = await readPromotedAtMs(dir);
  return {
    name,
    dir,
    owned: isSitemapReleaseOwnedName(name),
    activityMs: Math.max(activityMs, manifest.manifestMtimeMs),
    promotedAtMs: manifest.promotedAtMs,
  };
}

async function directorySizeBytes(dir: string): Promise<number> {
  let total = 0;
  for (const dirent of await fs.readdir(dir, { withFileTypes: true })) {
    const child = path.join(dir, dirent.name);
    if (dirent.isDirectory()) total += await directorySizeBytes(child);
    else if (dirent.isFile()) total += (await fs.lstat(child)).size;
  }
  return total;
}

/** 只用于排序：已 promote 看 promotedAt，否则看最后写入时间；越小越旧。 */
function versionTimeMs(entry: ReleaseEntry): number {
  return entry.promotedAtMs ?? entry.activityMs;
}

async function runCleanup(
  options: SitemapReleaseCleanupOptions,
  now: () => number,
  event: SitemapReleaseCleanupEvent,
): Promise<void> {
  const rootDir = path.resolve(options.rootDir ?? getStaticSitemapRoot());
  const releasesDir = path.join(rootDir, RELEASES_DIR);
  const remove = options.removeDirectory ?? removeDirectoryRecursive;
  const startedAt = now();

  const skip = (reason: string) => {
    event.outcome = "skipped";
    event.reason = reason;
  };

  const currentName = await resolveCurrentReleaseName(rootDir);
  event.current = currentName;
  if (currentName === null) return skip("current_unresolvable");

  let dirents;
  try {
    dirents = await fs.readdir(releasesDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return skip("releases_missing");
    throw error;
  }

  const entries: ReleaseEntry[] = [];
  for (const dirent of dirents) {
    // 软链、普通文件、隐藏条目都不是我们建的版本目录。
    if (!dirent.isDirectory() || dirent.name.startsWith(".")) {
      event.ignored += 1;
      continue;
    }
    try {
      entries.push(await readEntry(releasesDir, dirent.name));
    } catch (error) {
      // 读这个目录的元数据就失败（比如刚被别人删掉）：不碰它。
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") event.ignored += 1;
    }
  }
  event.total = entries.length;
  event.ignored += entries.filter((entry) => !entry.owned).length;

  const currentEntry = entries.find((entry) => entry.name === currentName);
  if (!currentEntry) return skip("current_target_missing");
  const currentTimeMs = versionTimeMs(currentEntry);

  const protectedNames = new Set<string>([currentName, ...(options.protectNames ?? [])]);
  const owned = entries.filter((entry) => entry.owned);

  const promoted = owned
    .filter((entry) => entry.promotedAtMs !== null)
    .sort((a, b) => (b.promotedAtMs! - a.promotedAtMs!) || (a.name < b.name ? 1 : -1));
  const recent = new Set(promoted.slice(0, SITEMAP_RELEASE_KEEP_RECENT).map((entry) => entry.name));

  const nowMs = now();
  const candidates: ReleaseEntry[] = [];
  for (const entry of owned) {
    if (protectedNames.has(entry.name)) continue;
    if (entry.promotedAtMs !== null) {
      if (!recent.has(entry.name)) candidates.push(entry);
      continue;
    }
    const olderThanCurrent = entry.activityMs < currentTimeMs;
    const idleLongEnough = nowMs - entry.activityMs >= SITEMAP_RELEASE_ORPHAN_MIN_AGE_MS;
    if (!options.orphansUnsafe && olderThanCurrent && idleLongEnough) candidates.push(entry);
    else event.keptOrphans += 1;
  }
  candidates.sort((a, b) => (versionTimeMs(a) - versionTimeMs(b)) || (a.name < b.name ? -1 : 1));

  let consecutiveFailures = 0;
  const failedNames: string[] = [];
  const codes = new Set<string>();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    const budgetSpent = event.removed + event.failed >= SITEMAP_RELEASE_MAX_REMOVALS_PER_RUN
      || now() - startedAt >= SITEMAP_RELEASE_TIME_BUDGET_MS
      || consecutiveFailures >= SITEMAP_RELEASE_MAX_CONSECUTIVE_FAILURES;
    if (budgetSpent) {
      event.deferred = candidates.length - index;
      break;
    }

    // 每个目录删之前重读一次 current：中途被别人切走就停手，绝不删当前指向的目录。
    const latestCurrent = await resolveCurrentReleaseName(rootDir);
    if (latestCurrent !== currentName) {
      event.deferred = candidates.length - index;
      event.outcome = "partial";
      event.reason = "current_changed";
      break;
    }
    if (protectedNames.has(candidate.name) || path.dirname(candidate.dir) !== releasesDir) continue;

    const bytes = await directorySizeBytes(candidate.dir).catch(() => 0);
    try {
      await remove(candidate.dir);
      event.removed += 1;
      event.freedBytes += bytes;
      consecutiveFailures = 0;
    } catch (error) {
      event.failed += 1;
      consecutiveFailures += 1;
      codes.add(errorCode(error));
      if (failedNames.length < FAILED_NAMES_LOGGED) failedNames.push(candidate.name);
    }
  }

  if (failedNames.length > 0) event.failedReleases = failedNames;
  if (codes.size > 0) event.errorCodes = [...codes].sort();
  if (event.failed > 0) event.outcome = "partial";
}

/**
 * 清理旧版本目录。永不抛错；结果以一条结构化日志输出并作为返回值给出。
 * 调用方应在 promote 成功、状态落盘、文件锁释放之后调用。
 */
export async function cleanupStaticSitemapReleases(
  options: SitemapReleaseCleanupOptions = {},
): Promise<SitemapReleaseCleanupEvent> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const event: SitemapReleaseCleanupEvent = {
    schemaVersion: 1,
    event: SITEMAP_RELEASE_CLEANUP_EVENT,
    outcome: "ok",
    keepRecent: SITEMAP_RELEASE_KEEP_RECENT,
    current: null,
    total: 0,
    kept: 0,
    removed: 0,
    failed: 0,
    deferred: 0,
    freedBytes: 0,
    keptOrphans: 0,
    ignored: 0,
    durationMs: 0,
  };

  try {
    await runCleanup(options, now, event);
  } catch (error) {
    event.outcome = "error";
    event.reason = "unexpected_error";
    event.errorCodes = [errorCode(error)];
  }
  event.kept = Math.max(0, event.total - event.removed);
  event.durationMs = Math.max(0, now() - startedAt);

  try {
    (options.log ?? defaultLog)(event);
  } catch {
    // 日志输出失败不能影响调用方。
  }
  return event;
}
