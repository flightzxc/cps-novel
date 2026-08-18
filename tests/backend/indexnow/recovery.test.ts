import { describe, expect, it } from "vitest";

import { recoverStaleIndexNowDeliveries } from "@/lib/indexnow/recovery";
import { INDEXNOW_PROCESSING_STALE_MS } from "@/lib/indexnow/outbox-contract";

import { FakeIndexNowDb } from "./fake-db";

const NOW = new Date("2026-01-01T12:00:00.000Z");
const STALE_UPDATED_AT = new Date(NOW.getTime() - INDEXNOW_PROCESSING_STALE_MS - 60_000);
const FRESH_UPDATED_AT = new Date(NOW.getTime() - 60_000);

describe("recoverStaleIndexNowDeliveries", () => {
  it("ignores processing rows that are not yet stale", async () => {
    const fake = new FakeIndexNowDb();
    fake.seedOutbox({ id: "outbox-1", url: "u", revision: 1n, status: "processing", updatedAt: FRESH_UPDATED_AT, attemptCount: 1 });
    fake.seedAttempt({ outboxId: "outbox-1", attemptNo: 1, attemptState: "started", responseAt: null });

    const recovered = await recoverStaleIndexNowDeliveries(fake.asPrismaClient(), NOW);
    expect(recovered).toBe(0);
    expect(fake.outbox.get("outbox-1")!.status).toBe("processing");
  });

  it("started + no responseAt (worker died mid-flight) -> attempt unknown_outcome, row retry_wait with an immediate nextAttemptAt", async () => {
    const fake = new FakeIndexNowDb();
    fake.seedOutbox({
      id: "outbox-1",
      url: "u",
      revision: 1n,
      status: "processing",
      updatedAt: STALE_UPDATED_AT,
      attemptCount: 1,
      maxAttempts: 5,
    });
    fake.seedAttempt({ outboxId: "outbox-1", attemptNo: 1, attemptState: "started", responseAt: null });

    const recovered = await recoverStaleIndexNowDeliveries(fake.asPrismaClient(), NOW);
    expect(recovered).toBe(1);

    const row = fake.outbox.get("outbox-1")!;
    expect(row.status).toBe("retry_wait");
    expect(row.lastErrorKind).toBe("unknown_outcome");
    // Immediate retry, not exponential backoff — IndexNow submission is
    // idempotent, so there is no reason to wait.
    expect(row.nextAttemptAt?.getTime()).toBe(NOW.getTime());

    const attempt = [...fake.attempts.values()][0]!;
    expect(attempt.attemptState).toBe("unknown_outcome");
    expect(attempt.errorKind).toBe("unknown_outcome");
  });

  it("started + no responseAt, attempt budget exhausted -> dead_letter, no next attempt", async () => {
    const fake = new FakeIndexNowDb();
    fake.seedOutbox({
      id: "outbox-1",
      url: "u",
      revision: 1n,
      status: "processing",
      updatedAt: STALE_UPDATED_AT,
      attemptCount: 5,
      maxAttempts: 5,
    });
    fake.seedAttempt({ outboxId: "outbox-1", attemptNo: 5, attemptState: "started", responseAt: null });

    await recoverStaleIndexNowDeliveries(fake.asPrismaClient(), NOW);
    const row = fake.outbox.get("outbox-1")!;
    expect(row.status).toBe("dead_letter");
    expect(row.nextAttemptAt).toBeNull();
  });

  it("completed + accepted response never applied to the row (crash between attempt write and row write) -> row becomes accepted", async () => {
    const fake = new FakeIndexNowDb();
    fake.seedOutbox({ id: "outbox-1", url: "u", revision: 1n, status: "processing", updatedAt: STALE_UPDATED_AT, attemptCount: 1, maxAttempts: 5 });
    fake.seedAttempt({ outboxId: "outbox-1", attemptNo: 1, attemptState: "completed", httpStatus: 200, responseAt: new Date(STALE_UPDATED_AT.getTime() + 1000) });

    await recoverStaleIndexNowDeliveries(fake.asPrismaClient(), NOW);
    const row = fake.outbox.get("outbox-1")!;
    expect(row.status).toBe("accepted");
    expect(row.lastErrorKind).toBeNull();
    expect(row.nextAttemptAt).toBeNull();
  });

  it("completed + 5xx response never applied to the row -> reapplies retry_wait with exponential backoff (not immediate)", async () => {
    const fake = new FakeIndexNowDb();
    const responseAt = new Date(STALE_UPDATED_AT.getTime() + 1000);
    fake.seedOutbox({ id: "outbox-1", url: "u", revision: 1n, status: "processing", updatedAt: STALE_UPDATED_AT, attemptCount: 1, maxAttempts: 5 });
    fake.seedAttempt({ outboxId: "outbox-1", attemptNo: 1, attemptState: "completed", httpStatus: 500, errorKind: "http_5xx", responseAt });

    await recoverStaleIndexNowDeliveries(fake.asPrismaClient(), NOW);
    const row = fake.outbox.get("outbox-1")!;
    expect(row.status).toBe("retry_wait");
    expect(row.nextAttemptAt).not.toBeNull();
    // Backoff is measured from the attempt's own responseAt, not `now`.
    expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(responseAt.getTime());
  });

  it("completed + 400 (permanent) response never applied to the row -> reapplies permanent_failed", async () => {
    const fake = new FakeIndexNowDb();
    fake.seedOutbox({ id: "outbox-1", url: "u", revision: 1n, status: "processing", updatedAt: STALE_UPDATED_AT, attemptCount: 1, maxAttempts: 5 });
    fake.seedAttempt({ outboxId: "outbox-1", attemptNo: 1, attemptState: "completed", httpStatus: 400, errorKind: "http_4xx", responseAt: new Date() });

    await recoverStaleIndexNowDeliveries(fake.asPrismaClient(), NOW);
    expect(fake.outbox.get("outbox-1")!.status).toBe("permanent_failed");
  });

  it("a row with no attempt at all resets defensively to pending", async () => {
    const fake = new FakeIndexNowDb();
    fake.seedOutbox({ id: "outbox-1", url: "u", revision: 1n, status: "processing", updatedAt: STALE_UPDATED_AT, deliveryTaskId: "task-x" });

    await recoverStaleIndexNowDeliveries(fake.asPrismaClient(), NOW);
    const row = fake.outbox.get("outbox-1")!;
    expect(row.status).toBe("pending");
    expect(row.deliveryTaskId).toBeNull();
  });

  it("processes multiple stale rows independently and returns the total recovered count", async () => {
    const fake = new FakeIndexNowDb();
    fake.seedOutbox({ id: "outbox-1", url: "u1", revision: 1n, status: "processing", updatedAt: STALE_UPDATED_AT, attemptCount: 1, maxAttempts: 5 });
    fake.seedAttempt({ outboxId: "outbox-1", attemptNo: 1, attemptState: "started", responseAt: null });
    fake.seedOutbox({ id: "outbox-2", url: "u2", revision: 1n, status: "processing", updatedAt: STALE_UPDATED_AT, attemptCount: 1, maxAttempts: 5 });
    fake.seedAttempt({ outboxId: "outbox-2", attemptNo: 1, attemptState: "completed", httpStatus: 200, responseAt: new Date() });

    const recovered = await recoverStaleIndexNowDeliveries(fake.asPrismaClient(), NOW);
    expect(recovered).toBe(2);
    expect(fake.outbox.get("outbox-1")!.status).toBe("retry_wait");
    expect(fake.outbox.get("outbox-2")!.status).toBe("accepted");
  });
});
