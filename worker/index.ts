import { createIndexNowSweepWorkerHandlers } from "./handlers/indexnow-sweep";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { assertCredentialKeyringReady } from "../src/lib/credentials/keyring";
import {
  buildWorkerAllowlist,
  createHandlerRegistry,
  sanitizePersistedTaskError,
  type TaskHandlerRegistry,
  type WorkerAllowlistConfig,
} from "../src/lib/tasks";
import { createCredentialWorkerHandlers } from "./handlers/credential";
import { createIndexNowWorkerHandlers } from "./handlers/indexnow-delivery";
import { createMoboreaderWorkerHandlers } from "./handlers/moboreader";
import { createPromoLinkClaimWorkerHandlers } from "./handlers/promo-link-claim";
import { createRevenueSyncWorkerHandlers } from "./handlers/revenue-sync";
import { createSitemapRefreshWorkerHandlers } from "./handlers/sitemap-refresh";
import { createHomeCarouselWorkerHandlers } from "./handlers/home-carousel";
import { createTaggingWorkerHandlers } from "./handlers/novel-tag-backfill";
import { createCatalogBatchWorkerHandlers } from "./handlers/catalog-batch";
import { createContentCreateWorkerHandlers } from "./handlers/content-create";
import { createNovelMaterializeWorkerHandlers } from "./handlers/novel-materialize";
import { createArticleGenerateWorkerHandlers } from "./handlers/article-generate";
import { createArticleGenerateBatchWorkerHandlers } from "./handlers/article-generate-batch";
import { createArticlePublishWorkerHandlers } from "./handlers/article-publish";
import { createArticlePublishBatchWorkerHandlers } from "./handlers/article-publish-batch";
import {
  createWorkerFailureWebhookReporterFromEnv,
  parseShutdownDrainTimeoutEnv,
  runWorkerProcess,
  runWorker,
} from "./runtime";

import { assertWorkerLane, parseWorkerLane, type WorkerLane } from "../src/lib/tasks/worker-lanes.mjs";
import { createSitemapDailyFallbackWorkerHandlers } from "./handlers/sitemap-daily-fallback";

export interface WorkerStartupLogger {
  info(message: string): void;
  error(message: string): void;
}

export class WorkerStartupConfigurationError extends Error {
  readonly code = "WORKER_TASK_ALLOWLIST_EMPTY";

  constructor() {
    super("WORKER_TASK_ALLOWLIST must include at least one registered task type");
    this.name = "WorkerStartupConfigurationError";
  }
}

/**
 * Validate and announce the exact task surface before polling begins. Unknown
 * values remain excluded (the runtime's fail-closed contract), but are emitted
 * at error level so an operator typo cannot leave tasks silently pending.
 */
export function resolveWorkerStartupAllowlist(
  raw: string | undefined,
  handlers: TaskHandlerRegistry,
  logger: WorkerStartupLogger = console,
  lane: WorkerLane = "main",
): WorkerAllowlistConfig {
  const allowlist = buildWorkerAllowlist(raw, handlers);
  const level = allowlist.invalid.length > 0 ? "error" : "info";
  const event = JSON.stringify({
    schemaVersion: 1,
    event: "worker_task_allowlist",
    level,
    requested: allowlist.requested,
    effective: allowlist.effective,
    invalid: allowlist.invalid,
  });
  if (level === "error") logger.error(event);
  else logger.info(event);
  if (!allowlist.willConsume) throw new WorkerStartupConfigurationError();
  try {
    assertWorkerLane(lane, allowlist.effective);
  } catch (error) {
    logger.error(JSON.stringify({ event: "worker_lane_rejected", lane, reason: (error as Error).message }));
    throw error;
  }
  return allowlist;
}

export function createWorkerHandlers(prisma: PrismaClient) {
  return createHandlerRegistry({
    ...createCredentialWorkerHandlers(prisma),
    ...createMoboreaderWorkerHandlers(prisma),
    ...createPromoLinkClaimWorkerHandlers(prisma),
    // 收益看板·账号级每日汇总（后台手动触发，不设定时任务）。调用上游，所以只在主通道白名单里。
    ...createRevenueSyncWorkerHandlers(prisma),
    ...createIndexNowWorkerHandlers(prisma),
    ...createIndexNowSweepWorkerHandlers(),
    ...createSitemapRefreshWorkerHandlers(prisma),
    ...createSitemapDailyFallbackWorkerHandlers(),
    ...createHomeCarouselWorkerHandlers(prisma),
    ...createTaggingWorkerHandlers(prisma),
    ...createCatalogBatchWorkerHandlers(prisma),
    ...createContentCreateWorkerHandlers(prisma),
    ...createNovelMaterializeWorkerHandlers(prisma),
    ...createArticleGenerateWorkerHandlers(prisma),
    ...createArticleGenerateBatchWorkerHandlers(prisma),
    // 文章后台批量发布（2026-10-06）。两个类型只在 light 通道的白名单里
    // （`APPROVED_LIGHT_TASK_TYPES`），主通道白名单不得出现。
    ...createArticlePublishBatchWorkerHandlers(prisma),
    ...createArticlePublishWorkerHandlers(prisma),
  });
}

export async function main(): Promise<void> {
  assertCredentialKeyringReady(process.env);
  const shutdownDrainTimeoutMs = parseShutdownDrainTimeoutEnv(
    process.env.WORKER_SHUTDOWN_DRAIN_TIMEOUT_MS,
  );
  const failureReporter = createWorkerFailureWebhookReporterFromEnv(process.env);
  const prisma = new PrismaClient();
  await runWorkerProcess({
    run: async (signal) => {
    const handlers = createWorkerHandlers(prisma);
    const lane = parseWorkerLane(process.env.WORKER_LANE);
    const allowlist = resolveWorkerStartupAllowlist(
      process.env.WORKER_TASK_ALLOWLIST,
      handlers,
      console,
      lane,
    );
    await runWorker({
      prisma,
      workerId: process.env.WORKER_ID ?? `worker-${process.pid}`,
      handlers,
      allowlist,
      lane,
      signal,
      shutdownDrainTimeoutMs,
      onTaskFailure: failureReporter?.onTaskFailure,
    });
    },
    disconnect: () => prisma.$disconnect(),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(sanitizePersistedTaskError(error, "worker_runtime_error"));
    process.exitCode = 1;
  });
}
