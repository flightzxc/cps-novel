// D-7 (`施工工单_PhaseE返工2_坏页不崩worker与免费书归一_2026-09-07.md`): before
// this fix, `processOneWorkerCycle`'s `catch` only ever forgave
// `LeaseLostError` — any other failure inside `finalizeTaskItem`'s own write
// transaction (e.g. C-11's `paid_from_chapter` DB CHECK violation firing
// nested inside a handler's `protectedWrite`, or here directly inside
// `guardedFinalize`'s own status UPDATE) was rethrown past every catch in
// this file and crashed the whole worker process — the real 2026-09-07
// incident this work order's §一 describes (worker container
// `RestartCount=12`).
//
// This harness reuses `worker-failure-observability.test.ts`'s
// `handlerCyclePrisma` call-sequence shape (recovery sweep -> claim ->
// handler -> finalize, each consuming one `$queryRaw`/`$executeRaw` call in
// a fixed order against a fake `tx`) but adds control to make a specific
// `$executeRaw` call *reject* instead of resolve, to simulate the write
// transaction itself failing.
import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Prisma } from "@prisma/client";
import { buildWorkerAllowlist, createHandlerRegistry } from "@/lib/tasks";
import { processOneWorkerCycle } from "../../../worker/runtime";

afterEach(() => {
  vi.restoreAllMocks();
});

const ITEM_ID = "70000000-0000-4000-8000-000000000001";
const TASK_ID = "70000000-0000-4000-8000-000000000002";
const EXECUTION_TOKEN = "70000000-0000-4000-8000-000000000003";

/**
 * The exact shape reported in the work order's appendix evidence: a Prisma
 * `PrismaClientKnownRequestError` wrapping a raw `$executeRaw` failure
 * (code `P2010`), whose `meta.code` carries the Postgres SQLSTATE (`23514`,
 * `check_violation`) and whose `meta.message` carries Postgres's own
 * message — including the `Failing row contains (...)` clause the DB
 * appends, deliberately included here so the tests below can assert it
 * never reaches anything persisted.
 */
function checkViolationError(constraint: string) {
  return {
    name: "PrismaClientKnownRequestError",
    code: "P2010",
    meta: {
      code: "23514",
      message:
        `new row for relation "novel_source_item" violates check constraint "${constraint}"  ` +
        `Failing row contains (secret data, -3, 0, 2026-09-07 12:14:31).`,
    },
  };
}

/**
 * Builds a fake `PrismaClient` that drives `processOneWorkerCycle` through
 * exactly one recovery-sweep-finds-nothing pass, one successful claim of a
 * single `generic`/`runtime.failure` item, a handler call, and then a
 * `finalizeTaskItem` attempt whose own `guardedFinalize` UPDATE (the single
 * `tx.$executeRaw` call inside it, since this task type is not
 * `catalog_scan` and never takes the cascade branch) rejects with
 * `firstFinalizeError`. `secondFinalizeBehavior` controls what the SECOND
 * `finalizeTaskItem` attempt (D-7's retried, `protectedWrite`-free failed
 * write) does at that same call site.
 */
function buildFinalizeFailureCyclePrisma(
  firstFinalizeError: unknown,
  secondFinalizeBehavior: { succeeds: true } | { succeeds: false; error: unknown },
) {
  const candidate = {
    id: ITEM_ID,
    task_id: TASK_ID,
    task_type: "runtime.failure",
    payload: null,
    attempt_count: 2,
    lease_epoch: 2n,
    cursor_at: new Date("2026-09-07T12:14:00Z"),
    eligible: true,
  };
  const leaseRow = {
    ...candidate,
    mode: "apply" as const,
    execution_token: EXECUTION_TOKEN,
    locked_until: new Date("2026-09-07T12:15:00Z"),
  };

  const queryRaw = vi.fn()
    .mockResolvedValueOnce([]) // recovery sweep (generic family): selectExpired -> none
    .mockResolvedValueOnce([candidate]) // claim: selectPending
    .mockResolvedValueOnce([leaseRow]) // claim: assignLease
    .mockResolvedValueOnce([]); // claim: recomputeParentTask's SELECT ... FOR UPDATE

  const executeRaw = vi.fn()
    .mockResolvedValueOnce(1) // claim: recomputeParentTask's UPDATE
    .mockRejectedValueOnce(firstFinalizeError); // 1st finalizeTaskItem: guardedFinalize's UPDATE throws

  if (secondFinalizeBehavior.succeeds) {
    executeRaw.mockResolvedValueOnce(1); // 2nd finalizeTaskItem: guardedFinalize's UPDATE succeeds
    queryRaw.mockResolvedValueOnce([]); // 2nd finalizeTaskItem: recomputeParentTask's SELECT ... FOR UPDATE
    executeRaw.mockResolvedValueOnce(1); // 2nd finalizeTaskItem: recomputeParentTask's UPDATE
  } else {
    executeRaw.mockRejectedValueOnce(secondFinalizeBehavior.error); // 2nd finalizeTaskItem: guardedFinalize's UPDATE also throws
  }

  const operationAuditCreate = vi.fn().mockResolvedValue({});
  const tx = { $queryRaw: queryRaw, $executeRaw: executeRaw, operationAudit: { create: operationAuditCreate } };
  const prisma = {
    $executeRaw: executeRaw,
    $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)),
  } as unknown as PrismaClient;
  return { prisma, operationAuditCreate, executeRaw, queryRaw };
}

function handlers() {
  return createHandlerRegistry({
    "runtime.failure": {
      family: "generic",
      handler: async () => ({ status: "success" as const, result: { returnedCount: 1 } }),
    },
  });
}

describe("D-7: a finalizeTaskItem failure fails the item, never the worker process", () => {
  it("(a)(b)(c): retries with a redacted finalize_failed outcome, persists sqlState/constraint but never row data, emits source: finalize, and the cycle resolves", async () => {
    const firstError = checkViolationError("novel_source_item_metadata_check");
    const db = buildFinalizeFailureCyclePrisma(firstError, { succeeds: true });
    const onTaskFailure = vi.fn();
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(processOneWorkerCycle({
      prisma: db.prisma,
      workerId: "worker-finalize-failure",
      handlers: handlers(),
      allowlist: buildWorkerAllowlist("runtime.failure", handlers()),
      signal: new AbortController().signal,
      onTaskFailure,
      now: () => new Date("2026-09-07T12:15:32.000Z"),
    })).resolves.toBe(true); // (c) the cycle resolves, does not throw/reject

    // Exactly two finalizeTaskItem attempts happened: the first (rejected)
    // guardedFinalize UPDATE, and the second (accepted) one, plus its own
    // recomputeParentTask UPDATE. Nothing beyond that ran.
    expect(db.executeRaw).toHaveBeenCalledTimes(4);

    // (a) the retried write persists status: failed with the allowlisted
    // finalize_failed code/detail (sqlState/prismaCode/constraint only).
    const secondFinalizeStatement = db.executeRaw.mock.calls[2][0] as Prisma.Sql;
    const persistedValues = secondFinalizeStatement.values.map((value) => String(value));
    expect(persistedValues).toContain("failed");
    const persistedErrorJson = persistedValues.find((value) => value.includes("finalize_failed"));
    expect(persistedErrorJson).toBeDefined();
    const persistedError = JSON.parse(persistedErrorJson!);
    expect(persistedError).toMatchObject({
      code: "finalize_failed",
      message: "Item finalize failed: 23514",
      detail: {
        sqlState: "23514",
        prismaCode: "P2010",
        constraint: "novel_source_item_metadata_check",
      },
    });

    // (b) nothing persisted anywhere in this call ever carries the raw
    // Postgres row-data clause or the "secret" upstream content it wrapped.
    const allExecuteRawSerialized = db.executeRaw.mock.calls
      .map((call) => (call[0] as Prisma.Sql).values.map((value) => String(value)).join("|"))
      .join("\n");
    expect(allExecuteRawSerialized).not.toMatch(/Failing row/i);
    expect(allExecuteRawSerialized).not.toMatch(/secret data/i);
    expect(String(stderr.mock.calls.map((call) => call[0]))).not.toMatch(/Failing row|secret data/i);

    // source: "finalize" (distinct from the pre-existing "handler" source),
    // via the retried finalizeTaskItem call succeeding.
    expect(onTaskFailure).toHaveBeenCalledTimes(1);
    expect(onTaskFailure).toHaveBeenCalledWith({
      family: "generic",
      taskType: "runtime.failure",
      taskId: TASK_ID,
      itemId: ITEM_ID,
      workerId: "worker-finalize-failure",
      errorKind: "finalize_failed",
      attempt: 2,
      source: "finalize",
      occurredAt: "2026-09-07T12:15:32.000Z",
    });
  });

  it("(d): when the retried finalize also throws, the cycle still resolves, logs one redacted structured line, and never emits onTaskFailure", async () => {
    const firstError = checkViolationError("novel_source_item_metadata_check");
    const secondError = checkViolationError("novel_source_item_metadata_check");
    const db = buildFinalizeFailureCyclePrisma(firstError, { succeeds: false, error: secondError });
    const onTaskFailure = vi.fn();
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(processOneWorkerCycle({
      prisma: db.prisma,
      workerId: "worker-finalize-failure",
      handlers: handlers(),
      allowlist: buildWorkerAllowlist("runtime.failure", handlers()),
      signal: new AbortController().signal,
      onTaskFailure,
    })).resolves.toBe(true); // still resolves — never throws/crashes the process

    // Both finalizeTaskItem attempts ran (their guardedFinalize UPDATEs);
    // neither's failure ever propagated past processOneWorkerCycle.
    expect(db.executeRaw).toHaveBeenCalledTimes(3);
    expect(onTaskFailure).not.toHaveBeenCalled();

    // One structured itemId/attempt/errorKind-only log line, no row data.
    const lines = stderr.mock.calls.map((call) => String(call[0]));
    const doubleFailureLine = lines.find((line) => line.includes("worker_finalize_failed_twice"));
    expect(doubleFailureLine).toBeDefined();
    expect(JSON.parse(doubleFailureLine!)).toEqual({
      event: "worker_finalize_failed_twice",
      itemId: ITEM_ID,
      attempt: 2,
      errorKind: "finalize_failed",
    });
    expect(String(lines)).not.toMatch(/Failing row|secret data/i);
  });
});
