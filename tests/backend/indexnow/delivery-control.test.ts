import { describe, expect, it } from "vitest";

import {
  INDEXNOW_CONTROL_ACTIONS,
  INDEXNOW_CONTROL_ADVISORY_LOCK,
  INDEXNOW_CONTROL_STATE_SQL,
  IndexNowResumeRefusedError,
  deriveKeyValidation,
  getIndexNowDeliveryControlState,
  isIndexNowHostConsistent,
  listIndexNowRequestBatch,
  recordIndexNowRateLimited,
  resumeIndexNowDelivery,
  validateResumeInput,
} from "@/lib/indexnow/delivery-control";
import { INDEXNOW_PROCESSING_STALE_MS } from "@/lib/indexnow/outbox-contract";

import { FakeIndexNowDb, installTestSiteUrl } from "./fake-db";
import { RESUME_ACTOR, T0, auditsOf, seedDueRows } from "./helpers";

installTestSiteUrl();

function newFake(): FakeIndexNowDb {
  return new FakeIndexNowDb().setNow(T0);
}

function seedTrip(fake: FakeIndexNowDb, overrides: { httpStatus?: number; heldRetry?: boolean; requestBatchId?: string; createdAt?: Date } = {}) {
  return fake.seedAudit({
    action: INDEXNOW_CONTROL_ACTIONS.breakerTrip,
    entityId: "breaker",
    createdAt: overrides.createdAt ?? T0,
    afterSnapshot: {
      requestBatchId: overrides.requestBatchId ?? "batch-x",
      httpStatus: overrides.httpStatus ?? 403,
      urlCount: 7,
      heldRetry: overrides.heldRetry ?? false,
      dbNow: T0.toISOString(),
    },
  });
}

function seedResume(fake: FakeIndexNowDb, createdAt: Date = T0) {
  return fake.seedAudit({
    action: INDEXNOW_CONTROL_ACTIONS.breakerResume,
    entityId: "breaker",
    actorType: "admin",
    actorId: RESUME_ACTOR,
    reason: "fixed",
    createdAt,
    afterSnapshot: { resumedTripAuditId: "1" },
  });
}

describe("control state — breaker is 'the highest-id breaker event is a trip'", () => {
  it("no events → closed, not waiting", async () => {
    const state = await getIndexNowDeliveryControlState(newFake().asPrismaClient());
    expect(state.breaker).toEqual({ open: false });
    expect(state.rateLimit).toEqual({ waiting: false });
    expect(state.repeatAfterResume).toBe(false);
    expect(state.lastResume).toBeNull();
    expect(state.lastBisect).toBeNull();
  });

  it("a trip opens it; trippedBy is the EARLIEST trip since the last resume and the trip events are counted", async () => {
    const fake = newFake();
    const first = seedTrip(fake, { httpStatus: 422, requestBatchId: "first" });
    seedTrip(fake, { httpStatus: 403, requestBatchId: "second" });
    const state = await getIndexNowDeliveryControlState(fake.asPrismaClient());
    expect(state.breaker).toMatchObject({ open: true, breakerTripEvents: 2 });
    if (!state.breaker.open) throw new Error("unreachable");
    expect(state.breaker.trippedBy).toMatchObject({ auditId: first.id, requestBatchId: "first", httpStatus: 422, urlCount: 7, heldRetry: false });
    expect(state.repeatAfterResume).toBe(false);
  });

  it("a resume with a higher id covers every earlier trip; a LATER trip re-opens it (a new failure while resumed)", async () => {
    const fake = newFake();
    seedTrip(fake);
    seedResume(fake);
    expect((await getIndexNowDeliveryControlState(fake.asPrismaClient())).breaker.open).toBe(false);
    seedTrip(fake, { requestBatchId: "again", heldRetry: true });
    const state = await getIndexNowDeliveryControlState(fake.asPrismaClient());
    expect(state.breaker.open).toBe(true);
    if (!state.breaker.open) throw new Error("unreachable");
    expect(state.breaker.trippedBy.requestBatchId).toBe("again");
    expect(state.breaker.breakerTripEvents).toBe(1); // only trips AFTER the resume count
    expect(state.repeatAfterResume).toBe(true); // heldRetry of the current trip
    expect(state.lastResume).toMatchObject({ actorId: RESUME_ACTOR, reason: "fixed" });
  });

  it("ordering is by event id, never by created_at: a resume with a higher id but an EARLIER created_at still covers the trip", async () => {
    const fake = newFake();
    seedTrip(fake, { createdAt: new Date(T0.getTime() + 5_000) });
    seedResume(fake, new Date(T0.getTime() - 5_000));
    expect((await getIndexNowDeliveryControlState(fake.asPrismaClient())).breaker.open).toBe(false);
  });

  it("the state is read with ONE statement that selects each stream by entity_type/entity_id first (no whole-table ORDER BY id DESC)", () => {
    expect(INDEXNOW_CONTROL_STATE_SQL).toContain("entity_type = 'indexnow_delivery' AND entity_id = 'breaker'");
    expect(INDEXNOW_CONTROL_STATE_SQL).toContain("entity_type = 'indexnow_delivery' AND entity_id = 'rate_limit'");
    expect(INDEXNOW_CONTROL_STATE_SQL).toContain("entity_type = 'indexnow_delivery' AND entity_id = 'bisect'");
    expect(INDEXNOW_CONTROL_STATE_SQL.match(/AS MATERIALIZED/g)).toHaveLength(4);
    // every ORDER BY id works on a CTE (a small set), never straight on operation_audit
    expect(INDEXNOW_CONTROL_STATE_SQL).not.toMatch(/FROM operation_audit\s+ORDER BY/);
    expect(INDEXNOW_CONTROL_STATE_SQL).not.toMatch(/ORDER BY created_at/i);
    expect(INDEXNOW_CONTROL_STATE_SQL.split(";").length).toBe(1);
  });

  it("the advisory lock key is the documented, unused namespace", () => {
    expect(INDEXNOW_CONTROL_ADVISORY_LOCK).toEqual({ namespace: 50241, scope: 1 });
  });
});

describe("control state — the 429 wait comes from the event, not from any row", () => {
  it("waiting while waitUntil is in the future of the database clock; not waiting after", async () => {
    const fake = newFake();
    await recordIndexNowRateLimited(fake.asTransactionClient(), { requestBatchId: "b", retryAfterMs: 0, dbNow: T0, taskId: "t" });
    let state = await getIndexNowDeliveryControlState(fake.asPrismaClient());
    expect(state.rateLimit).toMatchObject({ waiting: true, requestBatchId: "b" });
    if (!state.rateLimit.waiting) throw new Error("unreachable");
    expect(state.rateLimit.until.getTime()).toBe(T0.getTime() + 5 * 60_000);
    fake.setNow(new Date(T0.getTime() + 5 * 60_000 + 1));
    state = await getIndexNowDeliveryControlState(fake.asPrismaClient());
    expect(state.rateLimit).toEqual({ waiting: false });
  });

  it("the deadline is max(Retry-After, 5 minutes)", async () => {
    const fake = newFake();
    const longer = await recordIndexNowRateLimited(fake.asTransactionClient(), { requestBatchId: "b", retryAfterMs: 20 * 60_000, dbNow: T0, taskId: "t" });
    const shorter = await recordIndexNowRateLimited(fake.asTransactionClient(), { requestBatchId: "b", retryAfterMs: 1_000, dbNow: T0, taskId: "t" });
    expect(longer.getTime()).toBe(T0.getTime() + 20 * 60_000);
    expect(shorter.getTime()).toBe(T0.getTime() + 5 * 60_000);
  });

  it("changing or cancelling the rows of the 429 batch does not move the deadline", async () => {
    const fake = newFake();
    const rows = seedDueRows(fake, 2);
    await recordIndexNowRateLimited(fake.asTransactionClient(), { requestBatchId: "b", retryAfterMs: 0, dbNow: T0, taskId: "t" });
    const before = await getIndexNowDeliveryControlState(fake.asPrismaClient());
    for (const row of rows) Object.assign(fake.outbox.get(row.outboxId)!, { status: "cancelled", nextAttemptAt: new Date(0) });
    const after = await getIndexNowDeliveryControlState(fake.asPrismaClient());
    expect(after.rateLimit).toEqual(before.rateLimit);
  });
});

describe("resume", () => {
  const input = { actorId: RESUME_ACTOR, reason: "key file fixed" };

  it("input validation: actor and request id must be UUIDs, reason non-empty and at most 500 characters", () => {
    expect(() => validateResumeInput({ ...input, actorId: "not-a-uuid" })).toThrow("actorId must be a UUID");
    expect(() => validateResumeInput({ ...input, requestId: "nope" })).toThrow("requestId must be a UUID");
    expect(() => validateResumeInput({ ...input, reason: "   " })).toThrow("reason must not be empty");
    expect(() => validateResumeInput({ ...input, reason: "x".repeat(501) })).toThrow("at most 500");
    expect(validateResumeInput({ ...input, reason: "x".repeat(500) }).reason).toHaveLength(500);
    expect(validateResumeInput(input).requestId).toMatch(/^[0-9a-f-]{36}$/); // generated when absent
  });

  it("refused with breaker_not_open when the newest breaker event is not a trip", async () => {
    const fake = newFake();
    await expect(resumeIndexNowDelivery(fake.asPrismaClient(), input)).rejects.toMatchObject({ code: "breaker_not_open" });
    seedTrip(fake);
    seedResume(fake);
    const refusal = await resumeIndexNowDelivery(fake.asPrismaClient(), input).catch((error) => error);
    expect(refusal).toBeInstanceOf(IndexNowResumeRefusedError);
    expect(refusal.code).toBe("breaker_not_open");
  });

  it("refused with in_flight_requests_present while a request started within 35 minutes has no response; an older orphan does not block", async () => {
    const fake = newFake();
    seedTrip(fake);
    fake.seedOutbox({ id: "o", url: "https://x.example/o", revision: 1n });
    const orphan = fake.seedAttempt({ outboxId: "o", attemptNo: 1, attemptState: "started", requestAt: new Date(T0.getTime() - INDEXNOW_PROCESSING_STALE_MS - 60_000) });
    expect((await resumeIndexNowDelivery(fake.asPrismaClient(), input)).auditId).toBeGreaterThan(0n);

    const blocked = newFake();
    seedTrip(blocked);
    blocked.seedOutbox({ id: "o", url: "https://x.example/o", revision: 1n });
    blocked.seedAttempt({ outboxId: "o", attemptNo: 1, attemptState: "started", requestAt: new Date(T0.getTime() - 60_000) });
    await expect(resumeIndexNowDelivery(blocked.asPrismaClient(), input)).rejects.toMatchObject({ code: "in_flight_requests_present" });
    expect(auditsOf(blocked, INDEXNOW_CONTROL_ACTIONS.breakerResume)).toHaveLength(0);
    void orphan;
  });

  it("writes the audit: admin actor, request id, reason, before = trip summary, after = { resumedTripAuditId }", async () => {
    const fake = newFake();
    const trip = seedTrip(fake, { httpStatus: 422, heldRetry: true, requestBatchId: "bb" });
    const requestId = "22222222-2222-4222-8222-222222222222";
    const result = await resumeIndexNowDelivery(fake.asPrismaClient(), { ...input, requestId });
    expect(result.resumedTripAuditId).toBe(trip.id);
    const [audit] = auditsOf(fake, INDEXNOW_CONTROL_ACTIONS.breakerResume);
    expect(audit).toMatchObject({ actorType: "admin", actorId: RESUME_ACTOR, requestId, reason: "key file fixed", entityType: "indexnow_delivery", entityId: "breaker" });
    expect(audit!.afterSnapshot).toEqual({ resumedTripAuditId: trip.id.toString() });
    expect(audit!.beforeSnapshot).toMatchObject({
      resumedTripAuditId: trip.id.toString(),
      trip: { requestBatchId: "bb", httpStatus: 422, heldRetry: true },
      repeatAfterResume: true,
    });
    expect((await getIndexNowDeliveryControlState(fake.asPrismaClient())).breaker.open).toBe(false);
  });

  it("replaying a request id is refused (request_id_reused) and writes nothing", async () => {
    const fake = newFake();
    seedTrip(fake);
    const requestId = "33333333-3333-4333-8333-333333333333";
    await resumeIndexNowDelivery(fake.asPrismaClient(), { ...input, requestId });
    seedTrip(fake); // breaker open again
    await expect(resumeIndexNowDelivery(fake.asPrismaClient(), { ...input, requestId })).rejects.toMatchObject({ code: "request_id_reused" });
    expect(auditsOf(fake, INDEXNOW_CONTROL_ACTIONS.breakerResume)).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("isIndexNowHostConsistent compares the configured host with the SITE_URL host (trimmed, case-insensitive)", () => {
    expect(isIndexNowHostConsistent({ host: "cps-novel.example" })).toBe(true);
    expect(isIndexNowHostConsistent({ host: "  CPS-Novel.Example " })).toBe(true);
    expect(isIndexNowHostConsistent({ host: "www.cps-novel.example" })).toBe(false);
    expect(isIndexNowHostConsistent({ host: "other.example" })).toBe(false);
  });

  it("listIndexNowRequestBatch returns every row of a request ordered by createdAt then id, with the batch's HTTP status", async () => {
    const fake = newFake();
    const rows = seedDueRows(fake, 3);
    for (const [index, row] of rows.entries()) {
      fake.seedAttempt({ outboxId: row.outboxId, attemptNo: 1, requestBatchId: "the-batch", attemptState: "completed", httpStatus: 422 });
      void index;
    }
    fake.seedAttempt({ outboxId: rows[0]!.outboxId, attemptNo: 2, requestBatchId: "another", attemptState: "completed", httpStatus: 200 });
    const listed = await listIndexNowRequestBatch(fake.asPrismaClient(), "the-batch");
    expect(listed.map((row) => row.url)).toEqual(rows.map((row) => row.url));
    expect(listed.every((row) => row.batchHttpStatus === 422)).toBe(true);
    expect(listed[0]).toMatchObject({ outboxId: rows[0]!.outboxId, locale: "en", status: "pending", attemptCount: 0, maxAttempts: 5, lastHttpStatus: null, lastErrorKind: null });
  });

  it("deriveKeyValidation maps the latest accepted status", () => {
    expect(deriveKeyValidation(200)).toBe("verified");
    expect(deriveKeyValidation(202)).toBe("pending");
    expect(deriveKeyValidation(null)).toBe("none");
    expect(deriveKeyValidation(undefined)).toBe("none");
  });
});
