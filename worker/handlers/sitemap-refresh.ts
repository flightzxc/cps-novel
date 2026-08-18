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
  SITEMAP_REFRESH_TASK_TYPE,
  type TaskHandler,
} from "../../src/lib/tasks";

export const SITEMAP_FILE_LOCK_STALE_MS = 35 * 60 * 1_000;

export type SitemapRefreshPayload = Readonly<{
  reason: string;
  triggeredBy: string;
}>;

type Refresh = typeof refreshStaticSitemap;
type ReleaseLock = typeof releaseSitemapGenerationLock;

export type SitemapRefreshHandlerDependencies = Readonly<{
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  buildFamily?: BuildSitemapFamily;
  refresh?: Refresh;
  releaseLock?: ReleaseLock;
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

export function createSitemapRefreshHandler(
  db: PrismaClient,
  dependencies: SitemapRefreshHandlerDependencies = {},
): TaskHandler {
  const buildFamily = dependencies.buildFamily ?? createSitemapFamilyBuilder(db);
  const refresh = dependencies.refresh ?? refreshStaticSitemap;
  const releaseLock = dependencies.releaseLock ?? releaseSitemapGenerationLock;
  const now = dependencies.now ?? (() => new Date());
  const env = dependencies.env ?? process.env;

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
