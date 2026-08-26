import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
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
import { parseShutdownDrainTimeoutEnv, runWorker } from "./runtime";

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
  return allowlist;
}

export function createWorkerHandlers(prisma: PrismaClient) {
  return createHandlerRegistry({
    ...createCredentialWorkerHandlers(prisma),
    ...createMoboreaderWorkerHandlers(prisma),
    ...createPromoLinkClaimWorkerHandlers(prisma),
    ...createIndexNowWorkerHandlers(prisma),
    ...createSitemapRefreshWorkerHandlers(prisma),
  });
}

export async function main(): Promise<void> {
  const shutdownDrainTimeoutMs = parseShutdownDrainTimeoutEnv(
    process.env.WORKER_SHUTDOWN_DRAIN_TIMEOUT_MS,
  );
  const prisma = new PrismaClient();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const handlers = createWorkerHandlers(prisma);
    const allowlist = resolveWorkerStartupAllowlist(
      process.env.WORKER_TASK_ALLOWLIST,
      handlers,
    );
    await runWorker({
      prisma,
      workerId: process.env.WORKER_ID ?? `worker-${process.pid}`,
      handlers,
      allowlist,
      signal: controller.signal,
      shutdownDrainTimeoutMs,
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(sanitizePersistedTaskError(error, "worker_runtime_error"));
    process.exitCode = 1;
  });
}
