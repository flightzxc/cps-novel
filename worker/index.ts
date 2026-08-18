import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import {
  buildWorkerAllowlist,
  createHandlerRegistry,
  sanitizePersistedTaskError,
} from "../src/lib/tasks";
import { createCredentialWorkerHandlers } from "./handlers/credential";
import { createMoboreaderWorkerHandlers } from "./handlers/moboreader";
import { createSitemapRefreshWorkerHandlers } from "./handlers/sitemap-refresh";
import { parseShutdownDrainTimeoutEnv, runWorker } from "./runtime";

export function createWorkerHandlers(prisma: PrismaClient) {
  return createHandlerRegistry({
    ...createCredentialWorkerHandlers(prisma),
    ...createMoboreaderWorkerHandlers(prisma),
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
  const handlers = createWorkerHandlers(prisma);
  const allowlist = buildWorkerAllowlist(process.env.WORKER_TASK_ALLOWLIST, handlers);
  if (allowlist.invalid.length > 0) {
    console.error(`Unregistered task types were excluded: ${allowlist.invalid.join(",")}`);
  }
  try {
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
