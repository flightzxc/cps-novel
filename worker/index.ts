import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { HANDLERS, buildWorkerAllowlist } from "../src/lib/tasks";
import { runWorker } from "./runtime";

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
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
