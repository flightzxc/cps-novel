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
  reconcileAllEffectiveTags,
  type EffectiveTagChangeSummary,
} from "../../src/server/tagging/effective-tag-projection";

export const SITEMAP_FILE_LOCK_STALE_MS = 35 * 60 * 1_000;

export type SitemapRefreshPayload = Readonly<{
  reason: string;
  triggeredBy: string;
}>;

type Refresh = typeof refreshStaticSitemap;
type ReleaseLock = typeof releaseSitemapGenerationLock;
type ReconcileEffectiveTags = (db: PrismaClient) => Promise<EffectiveTagChangeSummary>;
type ReconcileLog = Pick<Console, "info" | "warn" | "error">;

export type SitemapRefreshHandlerDependencies = Readonly<{
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  buildFamily?: BuildSitemapFamily;
  refresh?: Refresh;
  releaseLock?: ReleaseLock;
  /**
   * B-38：构建站点地图之前先对账一次分类归属表（独立事务、只写差异）。生产默认走真实对账
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
 * 错的"，所以除了每个写入点同事务重算，再加一道与写入路径无关的全量对账。结果落一行结构化日志：
 * 稳定状态应为 0/0/0；不为 0 说明有漏掉的写入点或发生过并发，看日志即可发现（级别升到 warn）。
 *
 * 🔴 失败只记错误日志、**不中断**站点地图构建：归属表偏旧最坏是某些书在分类页里多/少，站点地图
 * 照常按当前表内容生成；而让站点地图因为一个兜底步骤整体失败，代价更大。
 */
async function reconcileEffectiveTagsBeforeSitemap(
  db: PrismaClient,
  reconcile: ReconcileEffectiveTags,
  log: ReconcileLog,
): Promise<void> {
  const startedAt = performance.now();
  try {
    const summary = await reconcile(db);
    const ms = Math.round(performance.now() - startedAt);
    const changed = summary.inserted + summary.updated + summary.deleted > 0;
    (changed ? log.warn : log.info).call(log, JSON.stringify({
      schemaVersion: 1,
      event: "effective_tag_reconcile",
      level: changed ? "warn" : "info",
      inserted: summary.inserted,
      updated: summary.updated,
      deleted: summary.deleted,
      ms,
    }));
  } catch (error) {
    try {
      log.error(JSON.stringify({
        schemaVersion: 1,
        event: "effective_tag_reconcile_failed",
        level: "error",
        ms: Math.round(performance.now() - startedAt),
        error: sanitizePersistedTaskError(error, "effective_tag_reconcile_failed"),
      }));
    } catch {
      // 日志也写不出就算了，站点地图构建不受影响。
    }
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
  const reconcileEffectiveTags = dependencies.reconcileEffectiveTags ?? reconcileAllEffectiveTags;
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
    await reconcileEffectiveTagsBeforeSitemap(db, reconcileEffectiveTags, reconcileLog);
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
