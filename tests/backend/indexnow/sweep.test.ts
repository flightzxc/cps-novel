import { describe, expect, it } from "vitest";

import { sweepDueIndexNowDeliveries } from "@/lib/indexnow/sweep";

import { FakeIndexNowDb, testEnv } from "./fake-db";

const NOW = new Date("2026-01-01T12:00:00.000Z");
const ENABLED_ENV = testEnv({ FEATURE_INDEXNOW_DELIVERY: "true", INDEXNOW_DELIVERY_ALLOW_WRITE: "true" });

describe("sweepDueIndexNowDeliveries — double-gate boundary", () => {
  it("is a no-op when both flags are off (default) — does not even run crash recovery", async () => {
    const fake = new FakeIndexNowDb();
    fake.seedOutbox({ id: "outbox-1", url: "u", revision: 1n, status: "pending", availableAt: null });
    const result = await sweepDueIndexNowDeliveries(fake.asPrismaClient(), { now: NOW }, testEnv());
    expect(result).toEqual({ recovered: 0, swept: 0, skippedAlreadyLive: 0 });
    expect(fake.genericTaskItems.size).toBe(0);
  });

  it("is a no-op when only one of the two flags is true", async () => {
    const fake = new FakeIndexNowDb();
    fake.seedOutbox({ id: "outbox-1", url: "u", revision: 1n, status: "pending", availableAt: null });
    const result = await sweepDueIndexNowDeliveries(
      fake.asPrismaClient(),
      { now: NOW },
      testEnv({ FEATURE_INDEXNOW_DELIVERY: "true" }),
    );
    expect(result.swept).toBe(0);
    expect(fake.genericTaskItems.size).toBe(0);
  });
});

describe("sweepDueIndexNowDeliveries — due-row discovery and item creation", () => {
  it("creates one delivery item for a pending row with no availableAt", async () => {
    const fake = new FakeIndexNowDb();
    fake.seedOutbox({ id: "outbox-1", url: "u", revision: 1n, status: "pending", availableAt: null });
    const result = await sweepDueIndexNowDeliveries(fake.asPrismaClient(), { now: NOW }, ENABLED_ENV);
    expect(result.swept).toBe(1);
    expect(fake.genericTaskItems.size).toBe(1);
    expect(fake.outbox.get("outbox-1")!.deliveryTaskId).not.toBeNull();
  });

  it("creates an item for a retry_wait row whose nextAttemptAt has elapsed, but not one still in the future", async () => {
    const fake = new FakeIndexNowDb();
    fake.seedOutbox({ id: "due", url: "u1", revision: 1n, status: "retry_wait", nextAttemptAt: new Date(NOW.getTime() - 1000) });
    fake.seedOutbox({ id: "not-due", url: "u2", revision: 1n, status: "retry_wait", nextAttemptAt: new Date(NOW.getTime() + 60_000) });
    const result = await sweepDueIndexNowDeliveries(fake.asPrismaClient(), { now: NOW }, ENABLED_ENV);
    expect(result.swept).toBe(1);
    expect([...fake.genericTaskItems.values()][0]!.targetId).toBe("due");
  });

  it("does not sweep a pending row whose availableAt (defer) is still in the future", async () => {
    const fake = new FakeIndexNowDb();
    fake.seedOutbox({ id: "outbox-1", url: "u", revision: 1n, status: "pending", availableAt: new Date(NOW.getTime() + 60_000) });
    const result = await sweepDueIndexNowDeliveries(fake.asPrismaClient(), { now: NOW }, ENABLED_ENV);
    expect(result.swept).toBe(0);
    expect(fake.genericTaskItems.size).toBe(0);
  });

  it("never creates a second live item for a row that already has one — the no-double-processing invariant", async () => {
    const fake = new FakeIndexNowDb();
    fake.seedOutbox({ id: "outbox-1", url: "u", revision: 1n, status: "pending", availableAt: null });
    fake.genericTasks.set("task-existing", { id: "task-existing", taskType: "indexnow_delivery", status: "pending", operationScopeHash: "x" });
    fake.genericTaskItems.set("item-existing", {
      id: "item-existing",
      taskId: "task-existing",
      targetType: "indexnow_outbox",
      targetId: "outbox-1",
      status: "pending",
      payload: { outboxId: "outbox-1" },
    });

    const result = await sweepDueIndexNowDeliveries(fake.asPrismaClient(), { now: NOW }, ENABLED_ENV);
    expect(result.swept).toBe(0);
    expect(result.skippedAlreadyLive).toBe(1);
    expect(fake.genericTaskItems.size).toBe(1);
  });

  it("does sweep a row whose only prior item already reached a terminal state", async () => {
    const fake = new FakeIndexNowDb();
    fake.seedOutbox({ id: "outbox-1", url: "u", revision: 1n, status: "retry_wait", nextAttemptAt: new Date(NOW.getTime() - 1000) });
    fake.genericTasks.set("task-existing", { id: "task-existing", taskType: "indexnow_delivery", status: "completed", operationScopeHash: "x" });
    fake.genericTaskItems.set("item-existing", {
      id: "item-existing",
      taskId: "task-existing",
      targetType: "indexnow_outbox",
      targetId: "outbox-1",
      status: "success",
      payload: { outboxId: "outbox-1" },
    });

    const result = await sweepDueIndexNowDeliveries(fake.asPrismaClient(), { now: NOW }, ENABLED_ENV);
    expect(result.swept).toBe(1);
    expect(fake.genericTaskItems.size).toBe(2);
  });

  it("calls crash recovery before sweeping (a stale processing row is recovered, then re-swept in the same call if now due)", async () => {
    const fake = new FakeIndexNowDb();
    const staleUpdatedAt = new Date(NOW.getTime() - 3_600_000); // well beyond INDEXNOW_PROCESSING_STALE_MS
    fake.seedOutbox({ id: "outbox-1", url: "u", revision: 1n, status: "processing", updatedAt: staleUpdatedAt, attemptCount: 1, maxAttempts: 5 });
    fake.seedAttempt({ outboxId: "outbox-1", attemptNo: 1, attemptState: "started", responseAt: null });

    const result = await sweepDueIndexNowDeliveries(fake.asPrismaClient(), { now: NOW }, ENABLED_ENV);
    expect(result.recovered).toBe(1);
    // Recovery moves it to retry_wait with nextAttemptAt = now, so the same
    // sweep call's due-query also picks it up.
    expect(result.swept).toBe(1);
    expect(fake.outbox.get("outbox-1")!.status).toBe("retry_wait");
  });
});
