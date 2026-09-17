import { describe, expect, it } from "vitest";

import {
  isGlobalTaskFailureCode,
  maybeHaltTaskOnGlobalFailure,
  TASK_SYSTEM_HOLD_REASON,
} from "../../../worker/handlers/promo-link-claim-system-hold";
import { readTaskControlMarker } from "@/lib/tasks/task-control";

/**
 * Replaces the earlier 3-consecutive-failure circuit breaker
 * (`worker/handlers/promo-link-claim-circuit-breaker.ts`, deleted). The
 * Owner rejected counting for a failure class that is global to the task by
 * construction — a `DETERMINISTIC_CREDENTIAL_FAILURE_CODES` code is either
 * true for every item in the task or none of them, never "a few scattered
 * bad rows" — so this module halts on the very first occurrence, with no
 * sibling-history read at all.
 */
const TASK = "22222222-2222-4222-8222-222222222222";
const ITEM = "33333333-3333-4333-8333-333333333333";

type FakeTx = Parameters<typeof maybeHaltTaskOnGlobalFailure>[0];

function fakeTx(options: { parentStatus?: string; parentResult?: unknown }) {
  const calls = { queryRaw: 0, update: 0, updateMany: 0, audit: 0 };
  let updateArgs: { data: Record<string, unknown> } | undefined;
  const tx = {
    $queryRaw: async () => {
      calls.queryRaw += 1;
      return options.parentStatus === undefined
        ? []
        : [{ status: options.parentStatus, result: options.parentResult ?? null }];
    },
    genericTask: {
      update: async (args: { data: Record<string, unknown> }) => {
        calls.update += 1;
        updateArgs = args;
        return {};
      },
    },
    genericTaskItem: { updateMany: async () => { calls.updateMany += 1; return { count: 7 }; } },
    channelSyncTaskItem: { updateMany: async () => ({ count: 0 }) },
    operationAudit: { create: async () => { calls.audit += 1; return {}; } },
  } as unknown as FakeTx;
  return { tx, calls, updateArgsRef: () => updateArgs };
}

const det = "credential_validation_failed";

describe("promo-link-claim system hold", () => {
  describe("failure classification", () => {
    it.each(["credential_missing", "credential_expired", "credential_ambiguous", "credential_validation_failed", "credential_invalid"])(
      "counts %s as global-by-construction", (code) => expect(isGlobalTaskFailureCode(code)).toBe(true));

    it.each(["upstream_timeout", "rate_limited", "network_error", "stale_processing", "unknown", "claim_source_fields_missing"])(
      "never counts a per-row/transient class %s", (code) => expect(isGlobalTaskFailureCode(code)).toBe(false));
  });

  it("does not halt on a non-global (transient/per-row) failure, and does not even query the database", async () => {
    const { tx, calls } = fakeTx({ parentStatus: "processing" });
    expect(await maybeHaltTaskOnGlobalFailure(tx, { taskId: TASK, itemId: ITEM, failureCode: "rate_limited" }))
      .toEqual({ halted: false });
    expect(calls.queryRaw).toBe(0);
    expect(calls.update).toBe(0);
    expect(calls.updateMany).toBe(0);
    expect(calls.audit).toBe(0);
  });

  it("halts on the very first occurrence of a global-class failure — no sibling-history read, no threshold", async () => {
    const { tx, calls, updateArgsRef } = fakeTx({ parentStatus: "processing" });
    const outcome = await maybeHaltTaskOnGlobalFailure(tx, { taskId: TASK, itemId: ITEM, failureCode: det });
    expect(outcome).toEqual({ halted: true, terminatedPendingItemCount: 7 });
    // Exactly one $queryRaw call (the parent lock) — never a second query to
    // check prior sibling outcomes, unlike the old breaker.
    expect(calls.queryRaw).toBe(1);
    expect(calls.update).toBe(1);
    expect(calls.updateMany).toBe(1);
    expect(calls.audit).toBe(1);

    const data = updateArgsRef()!.data;
    expect(data.status).toBe("disabled");
    expect(data.error).toMatchObject({ code: TASK_SYSTEM_HOLD_REASON });
    const marker = readTaskControlMarker(data.result);
    expect(marker).toMatchObject({
      kind: "system_hold",
      source: "system",
      reasonCode: det,
      terminatedPendingItemCount: 7,
    });
  });

  it("records source=system and the triggering reason code so the UI can say this was the system, not a person", async () => {
    const { tx } = fakeTx({ parentStatus: "pending" });
    await maybeHaltTaskOnGlobalFailure(tx, { taskId: TASK, itemId: ITEM, failureCode: "credential_missing" });
    // Covered structurally above via readTaskControlMarker; this test pins
    // the specific field values a UI would branch on.
    const { tx: tx2, updateArgsRef } = fakeTx({ parentStatus: "pending" });
    await maybeHaltTaskOnGlobalFailure(tx2, { taskId: TASK, itemId: ITEM, failureCode: "credential_missing" });
    const marker = readTaskControlMarker(updateArgsRef()!.data.result);
    expect(marker?.source).toBe("system");
    expect(marker?.reasonCode).toBe("credential_missing");
  });

  it("does not halt a parent that already left the runnable set (idempotent/race-safe)", async () => {
    const { tx, calls } = fakeTx({ parentStatus: "disabled" });
    expect(await maybeHaltTaskOnGlobalFailure(tx, { taskId: TASK, itemId: ITEM, failureCode: det }))
      .toEqual({ halted: false });
    expect(calls.update).toBe(0);
  });

  it("preserves the taskType's own pre-existing result fields when merging the marker in", async () => {
    const { tx, updateArgsRef } = fakeTx({ parentStatus: "processing", parentResult: { someUnrelatedField: 42 } });
    await maybeHaltTaskOnGlobalFailure(tx, { taskId: TASK, itemId: ITEM, failureCode: det });
    expect(updateArgsRef()!.data.result).toMatchObject({ someUnrelatedField: 42 });
  });
});
