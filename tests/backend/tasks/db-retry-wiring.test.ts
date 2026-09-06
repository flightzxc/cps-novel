/**
 * P0-S2 (db-retry wiring): proves `withDbRetry` is actually reached by
 * `src/lib/tasks/store.ts`'s write entry points (`claimPendingItem`,
 * `recoverExpiredItem`, `finalizeTaskItem`, `heartbeatTaskItem`), not
 * merely imported, and that the lease-fencing contract (CLAUDE.md §5 修正
 * 3 — a fencing mismatch must reject and must never be retried) survives
 * the retry wrapper.
 *
 * `store.ts` is raw-SQL heavy and today only exercised end-to-end against a
 * real Postgres instance (`tests/integration/tasks/p1-07-postgres.test.ts`).
 * This suite does not attempt to replace that — it stubs `PrismaClient`
 * (`$transaction`, `$queryRaw`, `$executeRaw`) at the call-shape level, just
 * enough for one real pass through each function's `family: "generic"`
 * branch, so it can assert *how many times* the retry-wrapped call site was
 * actually invoked without needing a live database.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { claimPendingItem, finalizeTaskItem, heartbeatTaskItem, LeaseLostError, recoverExpiredItem } from "@/lib/tasks/store";
import type { TaskClaimTarget, TaskLease } from "@/lib/tasks/types";

function prismaError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`simulated ${code}`, { code, clientVersion: "6.19.2" });
}

/** A `PrismaClient` double whose `$transaction` rejects transiently `failures` times before delegating to `tx`. */
function fakePrisma(tx: Record<string, unknown>, failures: number) {
  const attempts = { count: 0 };
  const client = {
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      attempts.count += 1;
      if (attempts.count <= failures) throw prismaError("P1008");
      return callback(tx);
    }),
  } as unknown as PrismaClient;
  return { client, attempts };
}

describe("db-retry wiring: claimPendingItem", () => {
  it.each([
    null,
    { family: "channel_sync", taskId: "bad", itemId: "bad" },
    { family: "unknown", taskId: "00000000-0000-4000-8000-000000000001", itemId: "00000000-0000-4000-8000-000000000002" },
  ])("rejects a malformed claim target before entering a transaction", async (claimTarget) => {
    const { client, attempts } = fakePrisma({}, 0);
    await expect(claimPendingItem(client, {
      family: "channel_sync", taskTypes: ["preview"], workerId: "worker", leaseMs: 30_000,
      claimTarget: claimTarget as TaskClaimTarget,
    })).rejects.toThrow("task_claim_target_invalid");
    expect(attempts.count).toBe(0);
  });

  it("does not enter another family for a valid target", async () => {
    const { client, attempts } = fakePrisma({}, 0);
    expect(await claimPendingItem(client, {
      family: "generic", taskTypes: ["preview"], workerId: "worker", leaseMs: 30_000,
      claimTarget: { family: "channel_sync", taskId: "00000000-0000-4000-8000-000000000001", itemId: "00000000-0000-4000-8000-000000000002" },
    })).toBeNull();
    expect(attempts.count).toBe(0);
  });

  it("retries a transient P1008 failure and succeeds on the second attempt", async () => {
    const row = {
      id: "item-1", task_id: "task-1", task_type: "some_type", payload: { a: 1 },
      attempt_count: 1, lease_epoch: 1n, execution_token: "tok-1", locked_until: new Date("2026-08-18T01:00:00Z"),
      mode: "apply" as const,
    };
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([{ ...row, cursor_at: new Date(), eligible: true }]) // selectPending
      .mockResolvedValueOnce([row]) // assignLease's UPDATE ... RETURNING
      .mockResolvedValueOnce([]); // recomputeParentTask's SELECT ... FOR UPDATE
    const executeRaw = vi.fn().mockResolvedValue(1); // recomputeParentTask's UPDATE
    const tx = { $queryRaw: queryRaw, $executeRaw: executeRaw };
    const { client, attempts } = fakePrisma(tx, 1);

    const lease = await claimPendingItem(client, {
      family: "generic", taskTypes: ["some_type"], workerId: "worker-1", leaseMs: 30_000,
    });

    expect(attempts.count).toBe(2);
    expect(lease).toMatchObject({ itemId: "item-1", taskId: "task-1", workerId: "worker-1", executionToken: "tok-1" });
    // The failed first attempt never reached the callback at all (rejected
    // before invoking it), so exactly one real pass through selectPending/
    // assignLease/recomputeParentTask — not a double lease assignment.
    expect(queryRaw).toHaveBeenCalledTimes(3);
    expect(executeRaw).toHaveBeenCalledTimes(1);
  }, 10_000);
});

describe("db-retry wiring: recoverExpiredItem", () => {
  it("retries a transient P1008 failure and succeeds on the second attempt", async () => {
    const row = { id: "item-1", task_id: "task-1", task_type: "some_type", payload: null, attempt_count: 3, lease_epoch: 2n };
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([{ ...row, cursor_at: new Date(), eligible: true }]) // selectExpired
      .mockResolvedValueOnce([]); // recomputeParentTask's SELECT ... FOR UPDATE
    const executeRaw = vi.fn().mockResolvedValue(1); // requeue/fail UPDATE + recomputeParentTask's UPDATE
    const operationAuditCreate = vi.fn();
    const tx = { $queryRaw: queryRaw, $executeRaw: executeRaw, operationAudit: { create: operationAuditCreate } };
    const { client, attempts } = fakePrisma(tx, 1);

    const result = await recoverExpiredItem(client, {
      family: "generic", taskTypes: ["some_type"], maxAttemptsByType: { some_type: 5 },
    });

    expect(attempts.count).toBe(2);
    expect(result).toMatchObject({ itemId: "item-1", taskId: "task-1", action: "requeued" });
    expect(executeRaw).toHaveBeenCalledTimes(2);
    expect(operationAuditCreate).not.toHaveBeenCalled();
  }, 10_000);

  it("writes the stale terminal failure audit in the recovery transaction", async () => {
    const row = { id: "item-1", task_id: "task-1", task_type: "some_type", payload: null, attempt_count: 3, lease_epoch: 3n };
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([{ ...row, cursor_at: new Date(), eligible: true }])
      .mockResolvedValueOnce([]);
    const executeRaw = vi.fn().mockResolvedValue(1);
    const operationAuditCreate = vi.fn().mockResolvedValue({});
    const tx = { $queryRaw: queryRaw, $executeRaw: executeRaw, operationAudit: { create: operationAuditCreate } };
    const { client } = fakePrisma(tx, 0);

    const result = await recoverExpiredItem(client, {
      family: "generic",
      taskTypes: ["some_type"],
      maxAttemptsByType: { some_type: 3 },
      workerId: "recovery-worker",
    });

    expect(result).toMatchObject({ action: "failed", taskType: "some_type", attemptCount: 3 });
    expect(operationAuditCreate).toHaveBeenCalledWith({
      data: {
        actorType: "worker",
        actorId: "recovery-worker",
        action: "task_item.failed",
        entityType: "generic_task_item",
        entityId: "item-1",
        taskType: "some_type",
        taskId: "task-1",
        reason: "stale_processing",
      },
    });
  });
});

describe("db-retry wiring: finalizeTaskItem", () => {
  const lease: TaskLease = {
    family: "generic", taskType: "some_type", mode: "apply", itemId: "item-1", taskId: "task-1",
    workerId: "worker-1", executionToken: "tok-1", leaseEpoch: 1n, attemptCount: 1,
    lockedUntil: new Date("2026-08-18T01:00:00Z"), payload: null,
  };

  it("retries a transient P1008 failure and succeeds on the second attempt", async () => {
    const executeRaw = vi.fn()
      .mockResolvedValueOnce(1) // guardedFinalize's fencing UPDATE — matches, 1 row affected
      .mockResolvedValueOnce(1); // recomputeParentTask's UPDATE
    const queryRaw = vi.fn().mockResolvedValueOnce([]); // recomputeParentTask's SELECT ... FOR UPDATE
    const operationAuditCreate = vi.fn().mockResolvedValue({});
    const tx = { $executeRaw: executeRaw, $queryRaw: queryRaw, operationAudit: { create: operationAuditCreate } };
    const { client, attempts } = fakePrisma(tx, 1);

    await finalizeTaskItem(client, lease, { status: "success", result: { ok: true } });

    expect(attempts.count).toBe(2);
    expect(operationAuditCreate).toHaveBeenCalledTimes(1);
  }, 10_000);

  it("uses a protected-write override as the final terminal outcome", async () => {
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([{ id: lease.itemId }]) // assertProtectedWriteLease
      .mockResolvedValueOnce([]); // recomputeParentTask's SELECT ... FOR UPDATE
    const executeRaw = vi.fn().mockResolvedValue(1);
    const operationAuditCreate = vi.fn().mockResolvedValue({});
    const protectedWrite = vi.fn(async () => ({
      status: "failed" as const,
      result: { source: "override" },
      error: { code: "override_failure", message: "Override failure" },
    }));
    const tx = { $executeRaw: executeRaw, $queryRaw: queryRaw, operationAudit: { create: operationAuditCreate } };
    const { client } = fakePrisma(tx, 0);

    await finalizeTaskItem(client, lease, {
      status: "success",
      result: { source: "provisional" },
      protectedWrite,
    });

    expect(protectedWrite).toHaveBeenCalledWith(tx);
    const finalizeStatement = executeRaw.mock.calls[0][0] as Prisma.Sql;
    expect(finalizeStatement.values).toEqual(expect.arrayContaining([
      "failed",
      JSON.stringify({ source: "override" }),
      JSON.stringify({ code: "override_failure", message: "Override failure" }),
    ]));
    expect(finalizeStatement.values).not.toContain(JSON.stringify({ source: "provisional" }));
    expect(operationAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "task_item.failed", reason: "worker_terminal_failure" }),
    });
  });

  it("keeps the original outcome when a protected write returns no override", async () => {
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([{ id: lease.itemId }]) // assertProtectedWriteLease
      .mockResolvedValueOnce([]); // recomputeParentTask's SELECT ... FOR UPDATE
    const executeRaw = vi.fn().mockResolvedValue(1);
    const operationAuditCreate = vi.fn().mockResolvedValue({});
    const protectedWrite = vi.fn(async () => undefined);
    const tx = { $executeRaw: executeRaw, $queryRaw: queryRaw, operationAudit: { create: operationAuditCreate } };
    const { client } = fakePrisma(tx, 0);

    await finalizeTaskItem(client, lease, {
      status: "success",
      result: { source: "original" },
      protectedWrite,
    });

    const finalizeStatement = executeRaw.mock.calls[0][0] as Prisma.Sql;
    expect(finalizeStatement.values).toEqual(expect.arrayContaining([
      "success",
      JSON.stringify({ source: "original" }),
    ]));
    expect(operationAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "task_item.success", reason: null }),
    });
  });

  it.each([
    ["execution token", { ...lease, executionToken: "stale-token" }, "stale-token"],
    ["lease epoch", { ...lease, leaseEpoch: 0n }, 0n],
  ] as const)("rejects a stale %s before the protected write runs", async (_field, staleLease, staleValue) => {
    const queryRaw = vi.fn().mockResolvedValueOnce([]);
    const executeRaw = vi.fn();
    const operationAuditCreate = vi.fn();
    const protectedWrite = vi.fn(async () => ({ status: "success" as const }));
    const tx = { $executeRaw: executeRaw, $queryRaw: queryRaw, operationAudit: { create: operationAuditCreate } };
    const { client, attempts } = fakePrisma(tx, 0);

    await expect(finalizeTaskItem(client, staleLease, {
      status: "success",
      protectedWrite,
    })).rejects.toBeInstanceOf(LeaseLostError);

    const leaseAssertion = queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(leaseAssertion.values).toContain(staleValue);
    expect(attempts.count).toBe(1);
    expect(protectedWrite).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
    expect(operationAuditCreate).not.toHaveBeenCalled();
  });

  it("does not retry a lease-fencing mismatch (LeaseLostError) — rethrown on the first attempt", async () => {
    // `guardedFinalize`'s conditional UPDATE reports 0 rows affected — the
    // fencing predicate (execution_token/lease_epoch/locked_by/status) no
    // longer matches, e.g. because the lease already expired and was
    // reclaimed by `recoverExpiredItem`. Per CLAUDE.md §5 修正 3, a fencing
    // mismatch must reject and must never be retried.
    const executeRaw = vi.fn().mockResolvedValueOnce(0);
    const operationAuditCreate = vi.fn();
    const tx = { $executeRaw: executeRaw, $queryRaw: vi.fn(), operationAudit: { create: operationAuditCreate } };
    const { client, attempts } = fakePrisma(tx, 0);

    await expect(finalizeTaskItem(client, lease, { status: "success", result: {} })).rejects.toBeInstanceOf(LeaseLostError);

    expect(attempts.count).toBe(1);
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(operationAuditCreate).not.toHaveBeenCalled();
  });
});

describe("db-retry wiring: heartbeatTaskItem", () => {
  it("retries a transient P1008 failure on the single UPDATE statement and succeeds", async () => {
    const executeRaw = vi.fn()
      .mockRejectedValueOnce(prismaError("P1008"))
      .mockResolvedValueOnce(1);
    const db = { $executeRaw: executeRaw } as unknown as PrismaClient;
    const lease: TaskLease = {
      family: "generic", taskType: "some_type", mode: "apply", itemId: "item-1", taskId: "task-1",
      workerId: "worker-1", executionToken: "tok-1", leaseEpoch: 1n, attemptCount: 1,
      lockedUntil: new Date("2026-08-18T01:00:00Z"), payload: null,
    };

    const ok = await heartbeatTaskItem(db, lease, 30_000);

    expect(ok).toBe(true);
    expect(executeRaw).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("does not mask a lost lease (0 rows affected) as a retryable failure", async () => {
    const executeRaw = vi.fn().mockResolvedValueOnce(0);
    const db = { $executeRaw: executeRaw } as unknown as PrismaClient;
    const lease: TaskLease = {
      family: "generic", taskType: "some_type", mode: "apply", itemId: "item-1", taskId: "task-1",
      workerId: "worker-1", executionToken: "tok-1", leaseEpoch: 1n, attemptCount: 1,
      lockedUntil: new Date("2026-08-18T01:00:00Z"), payload: null,
    };

    const ok = await heartbeatTaskItem(db, lease, 30_000);

    expect(ok).toBe(false);
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });
});
