import type { PrismaClient } from "@prisma/client";
import {
  LeaseLostError,
  TASK_FAMILIES,
  claimPendingItem,
  finalizeTaskItem,
  heartbeatTaskItem,
  recoverExpiredItem,
  requireHandler,
  sanitizePersistedTaskError,
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
  shutdownDrainTimeoutMs?: number;
  onError?: (error: unknown) => void;
}

export interface DrainLoopOptions {
  signal: AbortSignal;
  pollMs: number;
  cycle: () => Promise<boolean>;
}

export const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 30_000;

type DrainResult<T> =
  | { status: "completed"; value: T }
  | { status: "deadline" };

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

function waitForHandlerDrain<T>(
  handlerPromise: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<DrainResult<T>> {
  if (timeoutMs < 1) throw new Error("shutdownDrainTimeoutMs must be positive");
  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: DrainResult<T>) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      signal.removeEventListener("abort", startDeadline);
      resolve(result);
    };
    const startDeadline = () => {
      if (timeout || settled) return;
      timeout = setTimeout(() => finish({ status: "deadline" }), timeoutMs);
    };

    handlerPromise.then((value) => finish({ status: "completed", value }));
    if (signal.aborted) startDeadline();
    else signal.addEventListener("abort", startDeadline, { once: true });
  });
}

export async function processOneWorkerCycle(options: WorkerRuntimeOptions): Promise<boolean> {
  if (options.signal.aborted || !options.allowlist.willConsume) return false;
  const leaseMs = options.leaseMs ?? 30_000;
  const shutdownDrainTimeoutMs = options.shutdownDrainTimeoutMs
    ?? DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS;
  if (!Number.isFinite(shutdownDrainTimeoutMs) || shutdownDrainTimeoutMs < 1) {
    throw new Error("shutdownDrainTimeoutMs must be positive");
  }
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
    let heartbeatEnabled = true;
    const handlerHeartbeats = new Set<Promise<boolean>>();
    const handlerHeartbeat = () => {
      if (!heartbeatEnabled) return Promise.resolve(false);
      const heartbeat = heartbeatTaskItem(options.prisma, lease, leaseMs);
      handlerHeartbeats.add(heartbeat);
      void heartbeat.then(
        () => handlerHeartbeats.delete(heartbeat),
        () => handlerHeartbeats.delete(heartbeat),
      );
      return heartbeat;
    };
    const heartbeatPromise = (async () => {
      while (!heartbeatController.signal.aborted) {
        await sleep(Math.max(10, Math.floor(leaseMs / 3)), heartbeatController.signal);
        if (heartbeatController.signal.aborted || !heartbeatEnabled) return;
        const retained = await heartbeatTaskItem(options.prisma, lease, leaseMs);
        if (!retained) return;
      }
    })().catch((error) => {
      options.onError?.(sanitizePersistedTaskError(error, "worker_runtime_error"));
    });

    try {
      const handlerPromise = registration.handler({
        lease,
        signal: options.signal,
        heartbeat: handlerHeartbeat,
      }).catch((error) => ({
        status: "failed" as const,
        error: sanitizePersistedTaskError(error),
      }));
      const drainResult = await waitForHandlerDrain(
        handlerPromise,
        options.signal,
        shutdownDrainTimeoutMs,
      );
      if (drainResult.status === "deadline") {
        heartbeatEnabled = false;
        heartbeatController.abort();
        await heartbeatPromise;
        await Promise.allSettled(handlerHeartbeats);
        return true;
      }
      await finalizeTaskItem(options.prisma, lease, drainResult.value);
    } catch (error) {
      if (!(error instanceof LeaseLostError)) throw error;
    } finally {
      heartbeatEnabled = false;
      heartbeatController.abort();
      await heartbeatPromise;
      await Promise.allSettled(handlerHeartbeats);
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
