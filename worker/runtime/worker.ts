import type { PrismaClient } from "@prisma/client";
import {
  LeaseLostError,
  TASK_FAMILIES,
  claimPendingItem,
  finalizeTaskItem,
  heartbeatTaskItem,
  recoverExpiredItem,
  requireHandler,
  type TaskFamily,
  type TaskHandlerRegistry,
  type WorkerAllowlistConfig,
} from "../../src/lib/tasks";

export interface WorkerRuntimeOptions {
  prisma: PrismaClient;
  workerId: string;
  handlers: TaskHandlerRegistry;
  allowlist: WorkerAllowlistConfig;
  signal: AbortSignal;
  leaseMs?: number;
  pollMs?: number;
  onError?: (error: unknown) => void;
}

export interface DrainLoopOptions {
  signal: AbortSignal;
  pollMs: number;
  cycle: () => Promise<boolean>;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, ms);
    function done() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function taskTypesForFamily(
  family: TaskFamily,
  registry: TaskHandlerRegistry,
  effective: string[],
): string[] {
  return effective.filter((taskType) => registry[taskType]?.family === family);
}

export async function processOneWorkerCycle(options: WorkerRuntimeOptions): Promise<boolean> {
  if (options.signal.aborted || !options.allowlist.willConsume) return false;
  const leaseMs = options.leaseMs ?? 30_000;
  const maxAttemptsByType = Object.fromEntries(
    options.allowlist.effective.map((taskType) => [
      taskType,
      options.handlers[taskType]?.maxAttempts ?? 3,
    ]),
  );

  for (const family of TASK_FAMILIES) {
    if (options.signal.aborted) return false;
    const taskTypes = taskTypesForFamily(family, options.handlers, options.allowlist.effective);
    const recovered = await recoverExpiredItem(options.prisma, {
      family,
      taskTypes,
      maxAttemptsByType,
    });
    if (recovered) return true;
  }

  for (const family of TASK_FAMILIES) {
    if (options.signal.aborted) return false;
    const taskTypes = taskTypesForFamily(family, options.handlers, options.allowlist.effective);
    const lease = await claimPendingItem(options.prisma, {
      family,
      taskTypes,
      workerId: options.workerId,
      leaseMs,
    });
    if (!lease) continue;

    const registration = requireHandler(options.handlers, lease.taskType);
    const heartbeatController = new AbortController();
    const heartbeatPromise = (async () => {
      while (!heartbeatController.signal.aborted) {
        await sleep(Math.max(10, Math.floor(leaseMs / 3)), heartbeatController.signal);
        if (heartbeatController.signal.aborted) return;
        const retained = await heartbeatTaskItem(options.prisma, lease, leaseMs);
        if (!retained) return;
      }
    })().catch(options.onError ?? (() => undefined));

    try {
      let outcome;
      try {
        outcome = await registration.handler({
          lease,
          signal: options.signal,
          heartbeat: () => heartbeatTaskItem(options.prisma, lease, leaseMs),
        });
      } catch (error) {
        outcome = {
          status: "failed" as const,
          error: { code: "handler_failed", message: error instanceof Error ? error.message : String(error) },
        };
      }
      await finalizeTaskItem(options.prisma, lease, outcome);
    } catch (error) {
      if (!(error instanceof LeaseLostError)) throw error;
    } finally {
      heartbeatController.abort();
      await heartbeatPromise;
    }
    return true;
  }
  return false;
}

export async function runWorker(options: WorkerRuntimeOptions): Promise<void> {
  if (!options.allowlist.willConsume) return;
  await runDrainLoop({
    signal: options.signal,
    pollMs: options.pollMs ?? 1_000,
    cycle: () => processOneWorkerCycle(options),
  });
}

export async function runDrainLoop(options: DrainLoopOptions): Promise<void> {
  while (!options.signal.aborted) {
    const worked = await options.cycle();
    if (!worked && !options.signal.aborted) await sleep(options.pollMs, options.signal);
  }
}
