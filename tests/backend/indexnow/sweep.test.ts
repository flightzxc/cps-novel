import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { INDEXNOW_BATCH_OPERATION_SCOPE_HASH, INDEXNOW_PROCESSING_STALE_MS } from "@/lib/indexnow/outbox-contract";
import { sweepDueIndexNowDeliveries } from "@/lib/indexnow/sweep";
import { invalidateSiteSettingCache } from "@/server/site-settings/service";

import { FakeIndexNowDb, installTestSiteUrl, testEnv } from "./fake-db";
import { ENABLED_DELIVERY_ENV, T0, runSweep, seedDueRows } from "./helpers";

installTestSiteUrl();

function newFake(): FakeIndexNowDb {
  return new FakeIndexNowDb().setNow(T0);
}

beforeEach(() => {
  invalidateSiteSettingCache();
});

describe("sweepDueIndexNowDeliveries — double-gate boundary", () => {
  it("is a no-op when both flags are off (default) — does not even run crash recovery", async () => {
    const fake = newFake();
    seedDueRows(fake, 1);
    const writes = fake.writes;
    const result = await sweepDueIndexNowDeliveries(fake.asTransactionClient(), { now: T0 }, testEnv());
    expect(result).toEqual({ recovered: 0, created: 0 });
    expect(fake.genericTasks.size).toBe(0);
    expect(fake.writes).toBe(writes);
  });

  it("is a no-op when only one of the two flags is true", async () => {
    const fake = newFake();
    seedDueRows(fake, 1);
    const result = await sweepDueIndexNowDeliveries(fake.asTransactionClient(), { now: T0 }, testEnv({ FEATURE_INDEXNOW_DELIVERY: "true" }));
    expect(result).toEqual({ recovered: 0, created: 0 });
    expect(fake.genericTasks.size).toBe(0);
  });
});

describe("sweepDueIndexNowDeliveries — one batch task per scan", () => {
  it("creates ONE batch task with ONE item (mode batch) however many rows are due — no per-row tasks", async () => {
    const fake = newFake();
    seedDueRows(fake, 250);
    const result = await runSweep(fake);
    expect(result).toEqual({ recovered: 0, created: 1 });
    expect(fake.genericTasks.size).toBe(1);
    expect(fake.genericTaskItems.size).toBe(1);
    const task = [...fake.genericTasks.values()][0]!;
    expect(task).toMatchObject({ taskType: "indexnow_delivery", operationScopeHash: INDEXNOW_BATCH_OPERATION_SCOPE_HASH, status: "pending", totalCount: 1 });
    expect(task.params).toMatchObject({ mode: "batch", reason: "sweep_due", triggeredBy: "indexnow_delivery_sweep" });
    expect(task.requestToken).toMatch(/^indexnow_delivery:batch:[0-9a-f-]{36}$/);
    const item = [...fake.genericTaskItems.values()][0]!;
    expect(item).toMatchObject({ taskId: task.id, targetType: "indexnow_batch", targetId: "batch", payload: { mode: "batch" } });
  });

  it("the scope hash is sha256('indexnow_delivery:batch')", () => {
    expect(INDEXNOW_BATCH_OPERATION_SCOPE_HASH).toBe(createHash("sha256").update("indexnow_delivery:batch").digest("hex"));
  });

  it("nothing due → nothing_due, no task", async () => {
    const fake = newFake();
    expect(await runSweep(fake)).toEqual({ recovered: 0, created: 0, reason: "nothing_due" });
    expect(fake.genericTasks.size).toBe(0);
  });

  it("a retry_wait row whose nextAttemptAt has elapsed is due; one still in the future is not", async () => {
    const fake = newFake();
    seedDueRows(fake, 1, { prefix: "future", status: "retry_wait", overrides: { nextAttemptAt: new Date(T0.getTime() + 60_000) } });
    expect(await runSweep(fake)).toMatchObject({ created: 0, reason: "nothing_due" });
    seedDueRows(fake, 1, { prefix: "due", status: "retry_wait", overrides: { nextAttemptAt: new Date(T0.getTime() - 1000) } });
    expect(await runSweep(fake)).toMatchObject({ created: 1 });
  });

  it("a pending row whose availableAt (defer) is still in the future is not due", async () => {
    const fake = newFake();
    seedDueRows(fake, 1, { overrides: { availableAt: new Date(T0.getTime() + 60_000) } });
    expect(await runSweep(fake)).toMatchObject({ created: 0, reason: "nothing_due" });
  });

  it("a second scan while the batch task is still in flight creates nothing (already_live)", async () => {
    const fake = newFake();
    seedDueRows(fake, 3);
    expect(await runSweep(fake)).toMatchObject({ created: 1 });
    expect(await runSweep(fake)).toEqual({ recovered: 0, created: 0, reason: "already_live" });
    expect(fake.genericTasks.size).toBe(1);
    expect(fake.genericTaskItems.size).toBe(1);
  });

  it("once the previous batch task finished, the next scan creates a new one", async () => {
    const fake = newFake();
    seedDueRows(fake, 3);
    await runSweep(fake);
    [...fake.genericTasks.values()][0]!.status = "completed";
    expect(await runSweep(fake)).toMatchObject({ created: 1 });
    expect(fake.genericTasks.size).toBe(2);
  });

  it("the unique scope index is what merges: createMany(skipDuplicates) loses the race quietly instead of throwing", async () => {
    const fake = newFake();
    seedDueRows(fake, 1);
    // A concurrent creator already holds the in-flight scope, but our pre-check cannot see it.
    fake.genericTasks.set("racing", { id: "racing", taskType: "indexnow_delivery", status: "pending", operationScopeHash: INDEXNOW_BATCH_OPERATION_SCOPE_HASH });
    const db = fake.asTransactionClient();
    const originalFindFirst = db.genericTask.findFirst;
    (db.genericTask as { findFirst: unknown }).findFirst = async () => null;
    const result = await sweepDueIndexNowDeliveries(db, { now: T0 }, ENABLED_DELIVERY_ENV);
    (db.genericTask as { findFirst: unknown }).findFirst = originalFindFirst;
    expect(result).toEqual({ recovered: 0, created: 0, reason: "already_live" });
    expect(fake.genericTasks.size).toBe(1);
    expect(fake.genericTaskItems.size).toBe(0);
  });

  it("calls crash recovery before sweeping (a stale processing row is recovered, then due in the same scan)", async () => {
    const fake = newFake();
    const [row] = seedDueRows(fake, 1, { status: "processing", overrides: { attemptCount: 1 } });
    fake.outbox.get(row!.outboxId)!.updatedAt = new Date(T0.getTime() - INDEXNOW_PROCESSING_STALE_MS - 60_000);
    fake.seedAttempt({ outboxId: row!.outboxId, attemptNo: 1, attemptState: "started", responseAt: null });
    const result = await runSweep(fake);
    expect(result).toMatchObject({ recovered: 1, created: 1 });
    expect(fake.outbox.get(row!.outboxId)!.status).toBe("retry_wait");
  });
});
