import type { PrismaClient } from "@prisma/client";

import {
  isSitemapAutoRefreshEnabled,
  isSitemapAutoRefreshWriteAllowed,
} from "../../src/lib/flags";
import {
  releaseSitemapGenerationLock,
  refreshStaticSitemap,
  type RefreshStaticSitemapResult,
} from "../../src/lib/seo/sitemap-refresh-state";
import {
  createSitemapFamilyBuilder,
  type BuildSitemapFamily,
} from "../../src/lib/seo/sitemap";
import {
  createHandlerRegistry,
  sanitizePersistedTaskError,
  SITEMAP_REFRESH_TASK_TYPE,
  type TaskHandler,
} from "../../src/lib/tasks";
import {
  checkEffectiveTags,
  reconcileAllEffectiveTags,
  type EffectiveTagChangeSummary,
  type EffectiveTagCheckResult,
} from "../../src/server/tagging/effective-tag-projection";

export const SITEMAP_FILE_LOCK_STALE_MS = 35 * 60 * 1_000;

export type SitemapRefreshPayload = Readonly<{
  reason: string;
  triggeredBy: string;
}>;

type Refresh = typeof refreshStaticSitemap;
type ReleaseLock = typeof releaseSitemapGenerationLock;
type ReconcileEffectiveTags = (db: PrismaClient) => Promise<EffectiveTagChangeSummary>;
type CheckEffectiveTags = (db: PrismaClient) => Promise<EffectiveTagCheckResult>;
type ReconcileLog = Pick<Console, "info" | "warn" | "error">;

export type SitemapRefreshHandlerDependencies = Readonly<{
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  buildFamily?: BuildSitemapFamily;
  refresh?: Refresh;
  releaseLock?: ReleaseLock;
  /**
   * B-38：构建站点地图之前先**只读检查**分类归属表与规则的差异（不拿任何锁）。生产默认走真实检查
   * （`checkEffectiveTags`）；单元测试注入替身。
   */
  checkEffectiveTags?: CheckEffectiveTags;
  /**
   * B-38：检查发现差异时才对账（独立事务、独占咨询锁、只写差异）。生产默认走真实对账
   * （`reconcileAllEffectiveTags`）；单元测试注入替身。
   */
  reconcileEffectiveTags?: ReconcileEffectiveTags;
  reconcileLog?: ReconcileLog;
}>;

export function parseSitemapRefreshPayload(value: unknown): SitemapRefreshPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("sitemap_refresh_payload_invalid");
  }
  const candidate = value as Partial<SitemapRefreshPayload>;
  const reason = candidate.reason?.trim();
  const triggeredBy = candidate.triggeredBy?.trim();
  if (!reason || reason.length > 500 || !triggeredBy || triggeredBy.length > 160) {
    throw new Error("sitemap_refresh_payload_invalid");
  }
  return { reason, triggeredBy };
}

function runningLock(result: RefreshStaticSitemapResult): { runId: string; startedAtMs: number } | null {
  if (result.status !== "running" || result.state.task.status !== "running") return null;
  const runId = result.state.task.runId;
  const startedAt = result.state.task.startedAt;
  if (!runId || !startedAt) return null;
  const startedAtMs = Date.parse(startedAt);
  return Number.isFinite(startedAtMs) ? { runId, startedAtMs } : null;
}

function successfulOutcome(result: RefreshStaticSitemapResult) {
  const manifest = result.state.task.manifest ?? result.state.active;
  return {
    status: "success" as const,
    result: {
      coalesced: false,
      runId: manifest?.runId ?? result.state.task.runId,
      urlCount: manifest?.urlCount ?? 0,
      manifest: manifest ?? null,
    },
  };
}

function coalescedOutcome(result: RefreshStaticSitemapResult) {
  return {
    status: "success" as const,
    result: {
      coalesced: true,
      runId: result.state.task.runId ?? null,
      urlCount: result.state.active?.urlCount ?? 0,
      manifest: result.state.active,
    },
  };
}

function lockFailure(code: string, message: string) {
  return {
    status: "failed" as const,
    error: { code, message },
  };
}

/**
 * 站点地图刷新前的兜底对账（方案 §4.3「兜底」）。CPS 自己的教训是"靠穷举写入路径来保证一致本身就是
 * 错的"，所以除了每个写入点同事务重算，再加一道与写入路径无关的兜底。
 *
 * 🔴 **先只读检查，有差异才对账**：全量对账要拿独占咨询锁（`pg_advisory_xact_lock`），后台人工改标签 /
 * 自动打标 / 目录同步在这段时间里拿共享锁会排队等；等待超过 `web_app` 的 5 秒 `lock_timeout` 就会让人工
 * 操作失败。稳定状态（差异为 0，绝大多数刷新都是）下只读检查不拿任何锁、不写任何行，所以站点地图刷新对
 * 后台操作完全无感；只有真的发现差异（漏掉的写入点、运维脚本改过真源、并发）才进入拿独占锁的对账。
 *
 * 两步都落一行结构化日志：
 *   - `effective_tag_check`：检查的三个差异计数（缺失 / 多余 / 内容不同）。0/0/0 记 info 并跳过对账；
 *     不为 0 升级成 warn（说明有漏掉的写入点，看日志即可发现）后接着对账；
 *   - `effective_tag_reconcile`：对账写了几行。检查刚发现过差异，所以这一行本身就是 warn 级别的证据。
 *
 * 🔴 失败只记错误日志（`effective_tag_check_failed` / `effective_tag_reconcile_failed`）、**不中断**站点地图构建：
 * 归属表偏旧最坏是某些书在分类页里多/少，站点地图照常按当前表内容生成；而让站点地图因为一个兜底步骤整体失败，
 * 代价更大。检查本身失败时不贸然去拿独占锁（读都读不动，说明库在忙），留给下一次刷新重试。
 */
async function reconcileEffectiveTagsBeforeSitemap(
  db: PrismaClient,
  steps: Readonly<{ check: CheckEffectiveTags; reconcile: ReconcileEffectiveTags }>,
  log: ReconcileLog,
): Promise<void> {
  const emit = (level: "info" | "warn" | "error", payload: Record<string, unknown>) => {
    try {
      log[level](JSON.stringify({ schemaVersion: 1, level, ...payload }));
    } catch {
      // 日志也写不出就算了，站点地图构建不受影响。
    }
  };
  let step: "check" | "reconcile" = "check";
  const startedAt = performance.now();
  try {
    const check = await steps.check(db);
    const checkMs = Math.round(performance.now() - startedAt);
    const differences = check.missing + check.extra + check.changed;
    emit(differences === 0 ? "info" : "warn", {
      event: "effective_tag_check",
      missing: check.missing,
      extra: check.extra,
      changed: check.changed,
      reconcile: differences > 0,
      ms: checkMs,
    });
    if (differences === 0) return;

    step = "reconcile";
    const reconcileStartedAt = performance.now();
    const summary = await steps.reconcile(db);
    const changed = summary.inserted + summary.updated + summary.deleted > 0;
    emit(changed ? "warn" : "info", {
      event: "effective_tag_reconcile",
      inserted: summary.inserted,
      updated: summary.updated,
      deleted: summary.deleted,
      ms: Math.round(performance.now() - reconcileStartedAt),
    });
  } catch (error) {
    emit("error", {
      event: step === "check" ? "effective_tag_check_failed" : "effective_tag_reconcile_failed",
      ms: Math.round(performance.now() - startedAt),
      error: sanitizePersistedTaskError(error, step === "check" ? "effective_tag_check_failed" : "effective_tag_reconcile_failed"),
    });
  }
}

export function createSitemapRefreshHandler(
  db: PrismaClient,
  dependencies: SitemapRefreshHandlerDependencies = {},
): TaskHandler {
  const refresh = dependencies.refresh ?? refreshStaticSitemap;
  const releaseLock = dependencies.releaseLock ?? releaseSitemapGenerationLock;
  const now = dependencies.now ?? (() => new Date());
  const env = dependencies.env ?? process.env;
  const effectiveTagSteps = {
    check: dependencies.checkEffectiveTags ?? checkEffectiveTags,
    reconcile: dependencies.reconcileEffectiveTags ?? reconcileAllEffectiveTags,
  };
  const reconcileLog = dependencies.reconcileLog ?? console;

  return async ({ lease, heartbeat }) => {
    if (!isSitemapAutoRefreshEnabled(env)) {
      return {
        status: "failed",
        error: { code: "feature_disabled", message: "Sitemap auto-refresh feature is disabled" },
      };
    }
    if (!isSitemapAutoRefreshWriteAllowed(env)) {
      return {
        status: "failed",
        error: { code: "write_disabled", message: "Sitemap refresh worker write gate is disabled" },
      };
    }
    const payload = parseSitemapRefreshPayload(lease.payload);
    await heartbeat();
    await reconcileEffectiveTagsBeforeSitemap(db, effectiveTagSteps, reconcileLog);
    const buildFamily = dependencies.buildFamily ?? createSitemapFamilyBuilder(db);

    const refreshOnce = () => refresh({
      buildFamily,
      rootDir: dependencies.rootDir,
      runId: lease.taskId,
      initiatedBy: payload.triggeredBy,
      reason: payload.reason,
      version: "p2-10",
      startedAt: now(),
    });

    let result = await refreshOnce();
    if (result.status === "running") {
      const activeLock = runningLock(result);
      if (!activeLock) {
        return lockFailure(
          "sitemap_lock_unverifiable",
          "Sitemap lock exists without a verifiable active generation",
        );
      }
      if (now().valueOf() - activeLock.startedAtMs <= SITEMAP_FILE_LOCK_STALE_MS) {
        return coalescedOutcome(result);
      }

      await releaseLock(dependencies.rootDir, activeLock.runId);
      result = await refreshOnce();
      if (result.status === "running") {
        const retryLock = runningLock(result);
        if (!retryLock) {
          return lockFailure(
            "sitemap_lock_unverifiable",
            "Sitemap lock exists without a verifiable active generation",
          );
        }
        if (now().valueOf() - retryLock.startedAtMs > SITEMAP_FILE_LOCK_STALE_MS) {
          return lockFailure(
            "sitemap_lock_stale_after_retry",
            "Sitemap lock remained stale after one recovery attempt",
          );
        }
        return coalescedOutcome(result);
      }
    }

    if (result.status === "success") return successfulOutcome(result);
    return {
      status: "failed",
      result: { runId: result.state.task.runId ?? lease.taskId },
      error: {
        code: "sitemap_refresh_failed",
        message: result.state.task.errorSummary ?? "Static Sitemap generation failed",
      },
    };
  };
}

export function createSitemapRefreshWorkerHandlers(
  db: PrismaClient,
  dependencies: SitemapRefreshHandlerDependencies = {},
) {
  return createHandlerRegistry({
    [SITEMAP_REFRESH_TASK_TYPE]: {
      family: "generic",
      maxAttempts: 3,
      handler: createSitemapRefreshHandler(db, dependencies),
    },
  });
}
