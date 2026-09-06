import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildWorkerAllowlist, createHandlerRegistry } from "@/lib/tasks";
import { processOneWorkerCycle } from "../../../worker/runtime";

afterEach(() => {
  vi.restoreAllMocks();
});

function handlerCyclePrisma(
  finalizeAffected = 1,
  syntheticCatalogClose = false,
  executeRawOverride?: number[],
) {
  const candidate = {
    id: "00000000-0000-4000-8000-000000000001",
    task_id: "00000000-0000-4000-8000-000000000002",
    task_type: syntheticCatalogClose ? "catalog_scan" : "runtime.failure",
    payload: { token: "payload-secret", url: "https://secret.example" },
    attempt_count: 2,
    lease_epoch: 2n,
    cursor_at: new Date("2026-08-26T00:00:00Z"),
    eligible: true,
  };
  const leaseRow = {
    ...candidate,
    mode: "apply" as const,
    execution_token: "00000000-0000-4000-8000-000000000003",
    locked_until: new Date("2026-08-26T00:10:00Z"),
  };
  const queryRaw = vi.fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([candidate])
    .mockResolvedValueOnce([leaseRow])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([]);
  const executeRawResults = executeRawOverride ?? (syntheticCatalogClose
    ? [1, finalizeAffected, 500, 1]
    : [1, finalizeAffected, 1]);
  const executeRaw = vi.fn();
  for (const result of executeRawResults) executeRaw.mockResolvedValueOnce(result);
  const operationAuditCreate = vi.fn().mockResolvedValue({});
  const tx = { $queryRaw: queryRaw, $executeRaw: executeRaw, operationAudit: { create: operationAuditCreate } };
  let committedTransactions = 0;
  const prisma = {
    $executeRaw: executeRaw,
    $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => {
      const result = await callback(tx);
      committedTransactions += 1;
      return result;
    }),
  } as unknown as PrismaClient;
  return { prisma, operationAuditCreate, committedTransactions: () => committedTransactions };
}

function recoveryCyclePrisma(attemptCount: number) {
  const row = {
    id: "00000000-0000-4000-8000-000000000011",
    task_id: "00000000-0000-4000-8000-000000000012",
    task_type: "runtime.failure",
    payload: null,
    attempt_count: attemptCount,
    lease_epoch: BigInt(attemptCount),
    cursor_at: new Date("2026-08-25T23:00:00Z"),
    eligible: true,
  };
  const queryRaw = vi.fn().mockResolvedValueOnce([row]).mockResolvedValueOnce([]);
  const executeRaw = vi.fn().mockResolvedValue(1);
  const operationAuditCreate = vi.fn().mockResolvedValue({});
  const tx = { $queryRaw: queryRaw, $executeRaw: executeRaw, operationAudit: { create: operationAuditCreate } };
  let committed = false;
  const prisma = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => {
      const result = await callback(tx);
      committed = true;
      return result;
    }),
  } as unknown as PrismaClient;
  return { prisma, operationAuditCreate, committed: () => committed };
}

describe("X10 worker failure emission boundaries", () => {
  it("aborts the handler signal immediately when an explicit heartbeat loses ownership", async () => {
    // claim succeeds, handler heartbeat loses the fenced row, finalize also
    // loses it and is swallowed as the expected LeaseLostError boundary.
    const db = handlerCyclePrisma(1, false, [0, 0]);
    const handlerObserved = vi.fn();
    const observed: Array<boolean> = [];
    const handlers = createHandlerRegistry({
      "runtime.failure": {
        family: "generic",
        handler: async ({ signal, heartbeat }) => {
          observed.push(signal.aborted);
          observed.push(await heartbeat());
          observed.push(signal.aborted);
          handlerObserved();
          return { status: "failed", error: { code: "lease_lost" } };
        },
      },
    });

    await expect(processOneWorkerCycle({
      prisma: db.prisma,
      workerId: "worker-lease-loss",
      handlers,
      allowlist: buildWorkerAllowlist("runtime.failure", handlers),
      signal: new AbortController().signal,
    })).resolves.toBe(true);
    expect(observed).toEqual([false, false, true]);
    expect(handlerObserved).toHaveBeenCalledTimes(1);
    expect(db.operationAuditCreate).not.toHaveBeenCalled();
  });

  it("emits one redacted handler event only after finalize commits", async () => {
    const db = handlerCyclePrisma(1, true);
    const onTaskFailure = vi.fn(async (event) => {
      expect(db.committedTransactions()).toBe(3);
      expect(event).not.toHaveProperty("message");
    });
    const onError = vi.fn();
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handlers = createHandlerRegistry({
      catalog_scan: {
        family: "generic",
        handler: async () => ({
          status: "failed",
          error: {
            code: "UPSTREAM FAILED",
            message: "Bearer handler-secret https://secret.example",
            stack: "private stack",
          },
          result: {
            stopReason: "upstream_error",
            syntheticBulkClosed: 500,
            payload: "result-secret",
          },
        }),
      },
    });

    await expect(processOneWorkerCycle({
      prisma: db.prisma,
      workerId: "worker-handler",
      handlers,
      allowlist: buildWorkerAllowlist("catalog_scan", handlers),
      signal: new AbortController().signal,
      onTaskFailure,
      onError,
      now: () => new Date("2026-08-26T00:00:00.000Z"),
    })).resolves.toBe(true);

    expect(onTaskFailure).toHaveBeenCalledTimes(1);
    expect(onTaskFailure).toHaveBeenCalledWith({
      family: "generic",
      taskType: "catalog_scan",
      taskId: "00000000-0000-4000-8000-000000000002",
      itemId: "00000000-0000-4000-8000-000000000001",
      workerId: "worker-handler",
      errorKind: "upstream_failed",
      attempt: 2,
      source: "handler",
      occurredAt: "2026-08-26T00:00:00.000Z",
    });
    const line = String(stderr.mock.calls[0][0]);
    expect(JSON.parse(line)).toEqual(onTaskFailure.mock.calls[0][0]);
    expect(line).not.toMatch(/secret|message|stack|payload|url|synthetic/i);
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not emit when finalize loses its lease", async () => {
    const db = handlerCyclePrisma(0);
    const onTaskFailure = vi.fn();
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handlers = createHandlerRegistry({
      "runtime.failure": {
        family: "generic",
        handler: async () => ({ status: "failed", error: { code: "late_failure" } }),
      },
    });
    await expect(processOneWorkerCycle({
      prisma: db.prisma,
      workerId: "worker-handler",
      handlers,
      allowlist: buildWorkerAllowlist("runtime.failure", handlers),
      signal: new AbortController().signal,
      onTaskFailure,
    })).resolves.toBe(true);
    expect(onTaskFailure).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    expect(db.operationAuditCreate).not.toHaveBeenCalled();
  });

  it("emits terminal stale recovery after its durable audit commits", async () => {
    const db = recoveryCyclePrisma(3);
    const onTaskFailure = vi.fn(async () => {
      expect(db.committed()).toBe(true);
    });
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handlers = createHandlerRegistry({
      "runtime.failure": { family: "generic", handler: async () => ({ status: "success" }) },
    });
    await expect(processOneWorkerCycle({
      prisma: db.prisma,
      workerId: "worker-recovery",
      handlers,
      allowlist: buildWorkerAllowlist("runtime.failure", handlers),
      signal: new AbortController().signal,
      onTaskFailure,
      now: () => new Date("2026-08-26T00:05:00.000Z"),
    })).resolves.toBe(true);
    expect(db.operationAuditCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      action: "task_item.failed",
      reason: "stale_processing",
    }) });
    expect(onTaskFailure).toHaveBeenCalledWith(expect.objectContaining({
      source: "lease_recovery",
      errorKind: "stale_processing",
      workerId: "worker-recovery",
      attempt: 3,
    }));
    expect(stderr).toHaveBeenCalledTimes(1);
  });

  it("does not audit or alert a requeued stale lease", async () => {
    const db = recoveryCyclePrisma(1);
    const onTaskFailure = vi.fn();
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handlers = createHandlerRegistry({
      "runtime.failure": { family: "generic", maxAttempts: 3, handler: async () => ({ status: "success" }) },
    });
    await processOneWorkerCycle({
      prisma: db.prisma,
      workerId: "worker-recovery",
      handlers,
      allowlist: buildWorkerAllowlist("runtime.failure", handlers),
      signal: new AbortController().signal,
      onTaskFailure,
    });
    expect(db.operationAuditCreate).not.toHaveBeenCalled();
    expect(onTaskFailure).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it("swallows reporter failure and keeps the worker cycle successful", async () => {
    const db = handlerCyclePrisma();
    const onError = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handlers = createHandlerRegistry({
      "runtime.failure": {
        family: "generic",
        handler: async () => ({ status: "failed", error: { code: "handler_failed" } }),
      },
    });
    await expect(processOneWorkerCycle({
      prisma: db.prisma,
      workerId: "worker-handler",
      handlers,
      allowlist: buildWorkerAllowlist("runtime.failure", handlers),
      signal: new AbortController().signal,
      onTaskFailure: async () => { throw new Error("https://secret.example/hook?token=secret"); },
      onError,
    })).resolves.toBe(true);
    expect(onError).toHaveBeenCalledWith({
      code: "worker_failure_reporter_failed",
      message: "Worker failure reporter failed",
    });
    expect(JSON.stringify(onError.mock.calls)).not.toContain("secret.example");
  });
});
