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
  validateTaskClaimTarget,
  type TaskClaimTarget,
  type TaskFamily,
  type TaskHandlerRegistry,
  type TaskLease,
  type TaskOutcome,
  type WorkerAllowlistConfig,
} from "../../src/lib/tasks";
import {
  DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
  validateShutdownDrainTimeoutMs,
} from "./shutdown-timeout";
import {
  projectWorkerTaskFailureEvent,
  serializeWorkerTaskFailureEvent,
  type WorkerTaskFailureEvent,
  type WorkerTaskFailureReporter,
} from "./failure-reporter";

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
  onTaskFailure?: WorkerTaskFailureReporter["onTaskFailure"];
  now?: () => Date;
  claimTarget?: TaskClaimTarget;
}

export interface DrainLoopOptions {
  signal: AbortSignal;
  pollMs: number;
  cycle: () => Promise<boolean>;
}

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

export async function emitWorkerTaskFailure(
  event: WorkerTaskFailureEvent,
  options: Pick<WorkerRuntimeOptions, "onTaskFailure" | "onError"> = {},
): Promise<void> {
  const projected = projectWorkerTaskFailureEvent(event);
  console.error(serializeWorkerTaskFailureEvent(projected));
  if (!options.onTaskFailure) return;
  try {
    await options.onTaskFailure(projected);
  } catch {
    // The notification channel is best-effort and must never stop polling.
    try {
      options.onError?.({
        code: "worker_failure_reporter_failed",
        message: "Worker failure reporter failed",
      });
    } catch {
      // An observer callback is not allowed to become a Worker failure path.
    }
  }
}

function occurredAt(options: WorkerRuntimeOptions): string {
  return (options.now?.() ?? new Date()).toISOString();
}

function waitForHandlerDrain<T>(
  handlerPromise: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<DrainResult<T>> {
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

/**
 * D-7 (`施工工单_PhaseE返工2_坏页不崩worker与免费书归一_2026-09-07.md`): the
 * incident this fixes is `finalizeTaskItem`'s own write transaction failing
 * (e.g. a DB CHECK violation on a business write nested inside it, such as
 * C-11's `paid_from_chapter` bug) with something other than `LeaseLostError`
 * — before this fix, that error was indistinguishable from any other
 * `processOneWorkerCycle` bug and was rethrown past every catch, crashing
 * the whole worker process. Extracted here as three narrow, allowlisted
 * fields only — never the raw error/message — matching the C-10 `detail`
 * channel's own contract (`src/lib/tasks/errors.ts`): `sanitizeDetail` there
 * still redacts and length-caps every string that passes through, but this
 * function is the first line of defense, since it never even reads the
 * fields (row data, SQL text) that channel wasn't designed to carry.
 */
interface FinalizeFailureDetail {
  sqlState: string | null;
  prismaCode: string | null;
  constraint: string | null;
  errorName: string;
}

function extractFinalizeFailureDetail(error: unknown): FinalizeFailureDetail {
  const candidate = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const prismaCode = typeof candidate.code === "string" ? candidate.code : null;
  const meta = candidate.meta && typeof candidate.meta === "object"
    ? (candidate.meta as Record<string, unknown>)
    : undefined;
  // Postgres SQLSTATE (e.g. "23514") surfaces as `meta.code` on Prisma's
  // P2010 "raw query failed" wrapper — see `rawSqlErrorCode` in
  // `src/lib/db/db-retry.ts`, the existing single source of truth for this
  // same extraction (reused here in spirit, not imported, since that
  // helper is typed for `Prisma.PrismaClientKnownRequestError` specifically
  // and this call site must also tolerate a plain non-Prisma `Error`).
  const sqlState = meta && typeof meta.code === "string" ? meta.code : null;
  const metaMessage = meta && typeof meta.message === "string" ? meta.message : "";
  const topMessage = typeof candidate.message === "string" ? candidate.message : "";
  // Only the matched constraint *identifier* (the regex capture group) is
  // ever kept — the surrounding message text (which is exactly where a
  // "Failing row contains (...)" clause would live) is discarded here and
  // never reaches `detail`.
  const constraintMatch = /constraint "([A-Za-z0-9_]+)"/.exec(`${metaMessage} ${topMessage}`);
  const errorName = typeof candidate.name === "string" ? candidate.name : "Error";
  return {
    sqlState,
    prismaCode,
    constraint: constraintMatch ? constraintMatch[1] : null,
    errorName,
  };
}

function buildFinalizeFailedOutcome(error: unknown): TaskOutcome {
  const detail = extractFinalizeFailureDetail(error);
  return {
    status: "failed",
    // A plain (non-null) object, not omitted: the admin task-detail read
    // projection's item-level stop-reason derivation only derives a line
    // once `result` is present and not `{ stoppedBeforeFetch: true }` — an
    // absent/null `result` would silently withhold this code from that
    // projection even after `"finalize_failed"` is added to its
    // `CATALOG_SCAN_STOP_REASONS` allowlist. (That admin module is
    // deliberately not named by path in this comment — this file is one of
    // the ones an X9 isolation test asserts can never even mention it.)
    result: {},
    error: {
      code: "finalize_failed",
      message: `Item finalize failed: ${detail.sqlState ?? detail.errorName}`,
      detail: {
        sqlState: detail.sqlState,
        prismaCode: detail.prismaCode,
        constraint: detail.constraint,
      },
    },
  };
}

/**
 * Handles a `finalizeTaskItem` failure that is not `LeaseLostError`: records
 * the item as `failed` with the redacted `finalize_failed` outcome above
 * (a second `finalizeTaskItem` call, deliberately without `protectedWrite`
 * — the business write already ran once inside the first, failed attempt;
 * this call only needs to set the terminal status/error columns) and emits
 * the usual worker-failure notification. If even that second write throws,
 * this logs one structured, itemId/attempt/errorKind-only line and returns
 * normally either way — the caller (`processOneWorkerCycle`) always
 * continues the loop rather than let the exception propagate and kill the
 * process; the existing lease-expiry recovery path is the backstop for a
 * item stuck `processing` after this.
 */
async function handleFinalizeFailure(
  options: WorkerRuntimeOptions,
  lease: TaskLease,
  finalizeError: unknown,
): Promise<void> {
  const failedOutcome = buildFinalizeFailedOutcome(finalizeError);
  try {
    await finalizeTaskItem(options.prisma, lease, failedOutcome);
    await emitWorkerTaskFailure({
      family: lease.family,
      taskType: lease.taskType,
      taskId: lease.taskId,
      itemId: lease.itemId,
      workerId: lease.workerId,
      errorKind: "finalize_failed",
      attempt: lease.attemptCount,
      source: "finalize",
      occurredAt: occurredAt(options),
    }, options);
  } catch {
    // The retried finalize itself failed too. Never rethrow from here —
    // that would reintroduce exactly the process-crashing failure mode
    // this whole function exists to remove. The item is left `processing`
    // under its current lease; `recoverExpiredItem`'s stale-lease recovery
    // (already exercised elsewhere in this file) is the backstop that
    // eventually terminalizes it.
    console.error(JSON.stringify({
      event: "worker_finalize_failed_twice",
      itemId: lease.itemId,
      attempt: lease.attemptCount,
      errorKind: "finalize_failed",
    }));
  }
}

export async function processOneWorkerCycle(options: WorkerRuntimeOptions): Promise<boolean> {
  const shutdownDrainTimeoutMs = validateShutdownDrainTimeoutMs(
    options.shutdownDrainTimeoutMs ?? DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
  );
  if (options.claimTarget !== undefined) validateTaskClaimTarget(options.claimTarget);
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
      workerId: options.workerId,
    });
    if (recovered) {
      if (recovered.action === "failed") {
        await emitWorkerTaskFailure({
          family: recovered.family,
          taskType: recovered.taskType,
          taskId: recovered.taskId,
          itemId: recovered.itemId,
          workerId: options.workerId,
          errorKind: "stale_processing",
          attempt: recovered.attemptCount,
          source: "lease_recovery",
          occurredAt: occurredAt(options),
        }, options);
      }
      return true;
    }
  }

  for (const family of TASK_FAMILIES) {
    if (options.signal.aborted) return false;
    if (options.claimTarget !== undefined && options.claimTarget.family !== family) continue;
    const taskTypes = taskTypesForFamily(family, options.handlers, options.allowlist.effective);
    const lease = await claimPendingItem(options.prisma, {
      family,
      taskTypes,
      workerId: options.workerId,
      leaseMs,
      ...(options.claimTarget === undefined ? {} : { claimTarget: options.claimTarget }),
    });
    if (!lease) continue;

    const registration = requireHandler(options.handlers, lease.taskType);
    const heartbeatController = new AbortController();
    const leaseController = new AbortController();
    const abortLeaseSignal = () => leaseController.abort(options.signal.reason);
    if (options.signal.aborted) abortLeaseSignal();
    else options.signal.addEventListener("abort", abortLeaseSignal, { once: true });
    let heartbeatEnabled = true;
    const handlerHeartbeats = new Set<Promise<boolean>>();
    const handlerHeartbeat = () => {
      if (!heartbeatEnabled) return Promise.resolve(false);
      const heartbeat = heartbeatTaskItem(options.prisma, lease, leaseMs).then(
        (retained) => {
          if (!retained) leaseController.abort(new Error("task_lease_lost"));
          return retained;
        },
        (error) => {
          // A heartbeat error leaves ownership unproven. Abort the handler's
          // external-call signal before surfacing the error.
          leaseController.abort(error);
          throw error;
        },
      );
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
        if (!retained) {
          leaseController.abort(new Error("task_lease_lost"));
          return;
        }
      }
    })().catch((error) => {
      leaseController.abort(error);
      options.onError?.(sanitizePersistedTaskError(error, "worker_runtime_error"));
    });

    try {
      const handlerPromise = registration.handler({
        lease,
        mode: lease.mode,
        signal: leaseController.signal,
        heartbeat: handlerHeartbeat,
      }).catch((error) => ({
        status: "failed" as const,
        error: sanitizePersistedTaskError(error),
      }));
      const drainResult = await waitForHandlerDrain(
        handlerPromise,
        leaseController.signal,
        shutdownDrainTimeoutMs,
      );
      if (drainResult.status === "deadline") {
        heartbeatEnabled = false;
        heartbeatController.abort();
        await heartbeatPromise;
        await Promise.allSettled(handlerHeartbeats);
        return true;
      }
      const outcome = lease.mode === "dry_run"
        ? { ...drainResult.value, protectedWrite: undefined }
        : drainResult.value;
      try {
        await finalizeTaskItem(options.prisma, lease, outcome);
      } catch (finalizeError) {
        // `LeaseLostError` keeps its pre-existing meaning (someone else now
        // owns this item's fencing token) and pre-existing handling: rethrow
        // so the unchanged outer `catch` below swallows it exactly as
        // before. Every other error here is D-7's target — a genuine write
        // failure inside `finalizeTaskItem`'s own transaction (e.g. C-11's
        // `paid_from_chapter` CHECK violation) that must fail this one item,
        // never the worker process.
        if (finalizeError instanceof LeaseLostError) throw finalizeError;
        await handleFinalizeFailure(options, lease, finalizeError);
        return true;
      }
      if (outcome.status === "failed") {
        await emitWorkerTaskFailure({
          family: lease.family,
          taskType: lease.taskType,
          taskId: lease.taskId,
          itemId: lease.itemId,
          workerId: lease.workerId,
          errorKind: sanitizePersistedTaskError(outcome.error).code,
          attempt: lease.attemptCount,
          source: "handler",
          occurredAt: occurredAt(options),
        }, options);
      }
    } catch (error) {
      if (!(error instanceof LeaseLostError)) throw error;
    } finally {
      heartbeatEnabled = false;
      heartbeatController.abort();
      leaseController.abort();
      options.signal.removeEventListener("abort", abortLeaseSignal);
      await heartbeatPromise;
      await Promise.allSettled(handlerHeartbeats);
    }
    return true;
  }
  return false;
}

export async function runWorker(options: WorkerRuntimeOptions): Promise<void> {
  const shutdownDrainTimeoutMs = validateShutdownDrainTimeoutMs(
    options.shutdownDrainTimeoutMs ?? DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
  );
  if (!options.allowlist.willConsume) return;
  await runDrainLoop({
    signal: options.signal,
    pollMs: options.pollMs ?? 1_000,
    cycle: () => processOneWorkerCycle({ ...options, shutdownDrainTimeoutMs }),
  });
}

export async function runDrainLoop(options: DrainLoopOptions): Promise<void> {
  while (!options.signal.aborted) {
    const worked = await options.cycle();
    if (!worked && !options.signal.aborted) await sleep(options.pollMs, options.signal);
  }
}
