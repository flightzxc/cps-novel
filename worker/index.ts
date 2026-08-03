import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import {
  HANDLERS,
  buildWorkerAllowlist,
  sanitizePersistedTaskError,
} from "../src/lib/tasks";
import { runWorker } from "./runtime";

function optionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const allowlist = buildWorkerAllowlist(process.env.WORKER_TASK_ALLOWLIST, HANDLERS);
  if (allowlist.invalid.length > 0) {
    console.error(`Unregistered task types were excluded: ${allowlist.invalid.join(",")}`);
  }
  try {
    await runWorker({
      prisma,
      workerId: process.env.WORKER_ID ?? `worker-${process.pid}`,
      handlers: HANDLERS,
      allowlist,
      signal: controller.signal,
      shutdownDrainTimeoutMs: optionalPositiveInteger(
        process.env.WORKER_SHUTDOWN_DRAIN_TIMEOUT_MS,
        "WORKER_SHUTDOWN_DRAIN_TIMEOUT_MS",
      ),
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
