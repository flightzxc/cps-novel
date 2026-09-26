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
import { createSitemapRefreshWorkerHandlers } from "./handlers/sitemap-refresh";
import { createHomeCarouselWorkerHandlers } from "./handlers/home-carousel";
import { createTaggingWorkerHandlers } from "./handlers/novel-tag-backfill";
import { createCatalogBatchWorkerHandlers } from "./handlers/catalog-batch";
import { createContentCreateWorkerHandlers } from "./handlers/content-create";
import { createNovelMaterializeWorkerHandlers } from "./handlers/novel-materialize";
import { createArticleGenerateWorkerHandlers } from "./handlers/article-generate";
import { createArticleGenerateBatchWorkerHandlers } from "./handlers/article-generate-batch";
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
    ...createIndexNowWorkerHandlers(prisma),
    ...createSitemapRefreshWorkerHandlers(prisma),
    ...createSitemapDailyFallbackWorkerHandlers(),
    ...createHomeCarouselWorkerHandlers(prisma),
    ...createTaggingWorkerHandlers(prisma),
    ...createCatalogBatchWorkerHandlers(prisma),
    ...createContentCreateWorkerHandlers(prisma),
    ...createNovelMaterializeWorkerHandlers(prisma),
    ...createArticleGenerateWorkerHandlers(prisma),
    ...createArticleGenerateBatchWorkerHandlers(prisma),
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
    const allowlist = resolveWorkerStartupAllowlist(
      process.env.WORKER_TASK_ALLOWLIST,
      handlers,
      console,
      parseWorkerLane(process.env.WORKER_LANE),
    );
    await runWorker({
      prisma,
      workerId: process.env.WORKER_ID ?? `worker-${process.pid}`,
      handlers,
      allowlist,
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
