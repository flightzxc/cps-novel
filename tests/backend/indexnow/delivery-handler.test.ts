import { beforeEach, describe, expect, it } from "vitest";

import { INDEXNOW_CONTROL_ACTIONS, getIndexNowDeliveryControlState, resumeIndexNowDelivery } from "@/lib/indexnow/delivery-control";
import { INDEXNOW_HTTP_BATCH_SIZE } from "@/lib/indexnow/delivery-primitives";
import { invalidateSiteSettingCache } from "@/server/site-settings/service";

import { createIndexNowDeliveryHandler } from "../../../worker/handlers/indexnow-delivery";
import { FakeIndexNowDb, TEST_SITE_URL, installTestSiteUrl, testEnv } from "./fake-db";
import {
  ENABLED_DELIVERY_ENV,
  LOCALE_OK,
  RESUME_ACTOR,
  T0,
  auditsOf,
  batchLease,
  fetchStub,
  lastBisectSnapshot,
  runDelivery,
  runSweep,
  seedDueRows,
  urlListOf,
} from "./helpers";

installTestSiteUrl();

function newFake(): FakeIndexNowDb {
  return new FakeIndexNowDb().setNow(T0);
}

beforeEach(() => {
  invalidateSiteSettingCache();
});

async function controlOf(fake: FakeIndexNowDb) {
  return getIndexNowDeliveryControlState(fake.asPrismaClient());
}

describe("batch delivery — double-gate boundary and payload shapes", () => {
  it("skips without touching the DB when the flags are off (default) — fetch is never called", async () => {
    const fake = newFake();
    seedDueRows(fake, 2);
    const before = fake.snapshot();
    const fetchImpl = fetchStub(() => ({ status: 200 }));
    const outcome = await runDelivery(fake, fetchImpl, { env: testEnv() });
    expect(outcome).toEqual({ status: "skipped", result: { reason: "delivery_disabled" } });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fake.snapshot()).toEqual(before);
  });

  it("[7] a legacy single-row item ({ outboxId }) is skipped with ZERO writes; its row goes out in the next batch", async () => {
    const fake = newFake();
    const [row] = seedDueRows(fake, 1);
    const writesBefore = fake.writes;
    const before = fake.snapshot();
    const fetchImpl = fetchStub(() => ({ status: 200 }));

    const skipped = await runDelivery(fake, fetchImpl, { payload: { outboxId: row!.outboxId } });
    expect(skipped).toEqual({ status: "skipped", result: { reason: "legacy_single_row_item", outboxId: row!.outboxId } });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fake.writes).toBe(writesBefore);
    expect(fake.snapshot()).toEqual(before);

    await runDelivery(fake, fetchImpl);
    expect(urlListOf(fetchImpl)).toEqual([row!.url]);
    expect(fake.outbox.get(row!.outboxId)!.status).toBe("accepted");
  });

  it("an item that is neither batch nor legacy throws indexnow_delivery_payload_invalid", async () => {
    const fake = newFake();
    await expect(runDelivery(fake, fetchStub(() => ({ status: 200 })), { payload: { something: "else" } })).rejects.toThrow(
      "indexnow_delivery_payload_invalid",
    );
  });
});

describe("[1] batch cap — 500 URLs per request, FIFO by createdAt", () => {
  it("501 due rows → the first item sends ONE request with exactly the 500 oldest URLs; the second item sends the remaining 1", async () => {
    const fake = newFake();
    const rows = seedDueRows(fake, INDEXNOW_HTTP_BATCH_SIZE + 1);
    const fetchImpl = fetchStub(() => ({ status: 200 }));

    const first = await runDelivery(fake, fetchImpl);
    expect(first.status).toBe("success");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const sent = urlListOf(fetchImpl, 0);
    expect(sent).toHaveLength(500);
    // The oldest 500 by createdAt, in createdAt order — NOT id order (ids run backwards in this fixture).
    expect(sent).toEqual(rows.slice(0, 500).map((row) => row.url));
    expect(sent).not.toContain(rows[500]!.url);

    // One shared request batch id, batchSize 500, for every attempt of the request.
    const attempts = [...fake.attempts.values()];
    expect(attempts).toHaveLength(500);
    expect(new Set(attempts.map((attempt) => attempt.requestBatchId)).size).toBe(1);
    expect(new Set(attempts.map((attempt) => attempt.batchSize))).toEqual(new Set([500]));
    expect(attempts.every((attempt) => attempt.attemptState === "completed" && attempt.outcome === "accepted")).toBe(true);

    const second = await runDelivery(fake, fetchImpl);
    expect(second.status).toBe("success");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(urlListOf(fetchImpl, 1)).toEqual([rows[500]!.url]);
    expect([...fake.outbox.values()].every((row) => row.status === "accepted")).toBe(true);
  });

  it("the request body carries host, key, keyLocation and the URL list; every claimed row records the delivery task id", async () => {
    const fake = newFake();
    seedDueRows(fake, 2);
    const fetchImpl = fetchStub(() => ({ status: 200 }));
    await runDelivery(fake, fetchImpl, { taskId: "task-xyz" });
    const [, init] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse(init!.body as string);
    expect(body.host).toBe("cps-novel.example");
    expect(body.key).toBe("test-index-now-key");
    expect(body.keyLocation).toBe("https://cps-novel.example/test-index-now-key.txt");
    expect([...fake.outbox.values()].every((row) => row.deliveryTaskId === "task-xyz" && row.payloadHost === "cps-novel.example")).toBe(true);
    expect([...fake.attempts.values()].every((attempt) => attempt.workerTaskId === "task-xyz")).toBe(true);
  });

  it("no due rows → success with claimed 0 and no request", async () => {
    const fake = newFake();
    const fetchImpl = fetchStub(() => ({ status: 200 }));
    const outcome = await runDelivery(fake, fetchImpl);
    expect(outcome).toMatchObject({ status: "success", result: { claimed: 0 } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("[2] 200 and 202 are both accepted", () => {
  it.each([200, 202])("HTTP %i → attempt accepted, row accepted, terminal", async (code) => {
    const fake = newFake();
    const [row] = seedDueRows(fake, 1);
    await runDelivery(fake, fetchStub(() => ({ status: code })));
    const stored = fake.outbox.get(row!.outboxId)!;
    expect(stored.status).toBe("accepted");
    expect(stored.lastHttpStatus).toBe(code);
    expect(stored.nextAttemptAt).toBeNull();
    const attempt = [...fake.attempts.values()][0]!;
    expect(attempt.outcome).toBe("accepted");
    expect(attempt.attemptState).toBe("completed");
    expect(attempt.httpStatus).toBe(code);
  });
});

describe("[3] breaker — 400/403/422 hold the batch and stop everything until a manual resume", () => {
  it.each([400, 403, 422])("HTTP %i → rows back to retry_wait (due now), breaker opens, sweep stops, delivery skips, resume re-pushes ONLY the held batch", async (code) => {
    const fake = newFake();
    const held = seedDueRows(fake, 3, { prefix: "h" });
    const fetchImpl = fetchStub(() => ({ status: code }));

    await runDelivery(fake, fetchImpl);
    for (const row of held) {
      const stored = fake.outbox.get(row.outboxId)!;
      expect(stored.status).toBe("retry_wait");
      expect(stored.lastHttpStatus).toBe(code);
      expect(stored.nextAttemptAt!.getTime()).toBe(T0.getTime()); // == response time (database clock)
      expect(stored.attemptCount).toBe(1);
    }
    const trips = auditsOf(fake, INDEXNOW_CONTROL_ACTIONS.breakerTrip);
    expect(trips).toHaveLength(1);
    expect(trips[0]!.afterSnapshot).toMatchObject({ httpStatus: code, urlCount: 3, heldRetry: false });
    const control = await controlOf(fake);
    expect(control.breaker.open).toBe(true);

    // The sweep creates no task while the breaker is open …
    expect(await runSweep(fake)).toMatchObject({ created: 0, reason: "breaker_open", breakerOpen: true });
    expect(fake.genericTasks.size).toBe(0);
    // … and a delivery item that does run sends nothing.
    const blockedFetch = fetchStub(() => ({ status: 200 }));
    expect(await runDelivery(fake, blockedFetch)).toEqual({ status: "skipped", result: { reason: "breaker_open" } });
    expect(blockedFetch).not.toHaveBeenCalled();

    // A new publication arrives while blocked.
    const fresh = seedDueRows(fake, 1, { prefix: "n", baseMs: T0.getTime() - 500 });

    // Manual resume (writes the audit event) …
    const resumed = await resumeIndexNowDelivery(fake.asPrismaClient(), { actorId: RESUME_ACTOR, reason: "key file fixed" });
    expect(resumed.resumedTripAuditId).toBe(control.breaker.open ? control.breaker.latestTripAuditId : 0n);
    expect((await controlOf(fake)).breaker.open).toBe(false);

    // … the sweep now creates the batch task, and the delivery pushes ONLY the held batch.
    expect(await runSweep(fake)).toMatchObject({ created: 1 });
    const okFetch = fetchStub(() => ({ status: 200 }));
    const result = await runDelivery(fake, okFetch);
    expect(result).toMatchObject({ status: "success", result: { mode: "held_retry", claimed: 3, httpStatus: 200 } });
    expect(urlListOf(okFetch)).toEqual(held.map((row) => row.url));
    expect(urlListOf(okFetch)).not.toContain(fresh[0]!.url);
    for (const row of held) expect(fake.outbox.get(row.outboxId)!.status).toBe("accepted");
    // The new publication is the next batch.
    await runDelivery(fake, okFetch);
    expect(urlListOf(okFetch, 1)).toEqual([fresh[0]!.url]);
  });

  it("a single failing 4xx when a row's budget is spent (attemptNo >= maxAttempts) → dead_letter instead of a held retry", async () => {
    const fake = newFake();
    const [row] = seedDueRows(fake, 1, { overrides: { attemptCount: 4, maxAttempts: 5 } });
    await runDelivery(fake, fetchStub(() => ({ status: 403 })));
    const stored = fake.outbox.get(row!.outboxId)!;
    expect(stored.attemptCount).toBe(5);
    expect(stored.status).toBe("dead_letter");
    expect(stored.nextAttemptAt).toBeNull();
  });
});

describe("[4] budget exhausted after a breaker hold → dead_letter, no bisect", () => {
  it("a held row at attemptNo == maxAttempts that fails again becomes dead_letter and no bisect is attempted", async () => {
    const fake = newFake();
    const [row] = seedDueRows(fake, 1, {
      status: "retry_wait",
      overrides: { attemptCount: 4, maxAttempts: 5, nextAttemptAt: T0, lastHttpStatus: 422 },
    });
    const fetchImpl = fetchStub(() => ({ status: 422 }));
    const outcome = await runDelivery(fake, fetchImpl);
    expect(outcome).toMatchObject({ status: "success", result: { mode: "held_retry", claimed: 1, httpStatus: 422 } });
    expect(fake.outbox.get(row!.outboxId)!.status).toBe("dead_letter");
    expect(fetchImpl).toHaveBeenCalledOnce(); // no probes
    expect(auditsOf(fake, INDEXNOW_CONTROL_ACTIONS.bisect)).toHaveLength(0);
  });

  it("a non-4xx failure at the budget still dead-letters (5xx)", async () => {
    const fake = newFake();
    const [row] = seedDueRows(fake, 1, { overrides: { attemptCount: 4, maxAttempts: 5 } });
    await runDelivery(fake, fetchStub(() => ({ status: 500 })));
    expect(fake.outbox.get(row!.outboxId)!.status).toBe("dead_letter");
  });
});

describe("other outcomes keep their existing semantics", () => {
  it("500 → retry_wait with a future nextAttemptAt, errorKind http_5xx, and NO control event", async () => {
    const fake = newFake();
    const [row] = seedDueRows(fake, 1);
    await runDelivery(fake, fetchStub(() => ({ status: 500, body: "server error" })));
    const stored = fake.outbox.get(row!.outboxId)!;
    expect(stored.status).toBe("retry_wait");
    expect(stored.nextAttemptAt!.getTime()).toBeGreaterThan(T0.getTime());
    expect(stored.lastErrorKind).toBe("http_5xx");
    expect(fake.audits.size).toBe(0);
  });

  it("a thrown network error → retry_wait with errorKind network", async () => {
    const fake = newFake();
    const [row] = seedDueRows(fake, 1);
    await runDelivery(fake, fetchStub(() => new TypeError("fetch failed")));
    expect(fake.outbox.get(row!.outboxId)!.lastErrorKind).toBe("network");
    expect(fake.outbox.get(row!.outboxId)!.status).toBe("retry_wait");
  });

  it("an AbortError (timeout) → errorKind timeout", async () => {
    const fake = newFake();
    const [row] = seedDueRows(fake, 1);
    const abort = new Error("aborted");
    abort.name = "AbortError";
    await runDelivery(fake, fetchStub(() => abort));
    expect(fake.outbox.get(row!.outboxId)!.lastErrorKind).toBe("timeout");
  });

  it("the request is aborted by the task lease's signal, not only by the 10 s timeout", async () => {
    const fake = newFake();
    seedDueRows(fake, 1);
    const lease = new AbortController();
    const handler = createIndexNowDeliveryHandler(
      fake.asPrismaClient(),
      ((_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
          lease.abort();
        })) as unknown as typeof fetch,
      ENABLED_DELIVERY_ENV,
      LOCALE_OK,
    );
    await handler({ lease: batchLease(), mode: "apply", signal: lease.signal, heartbeat: async () => true });
    const [row] = [...fake.outbox.values()];
    expect(row!.status).toBe("retry_wait");
    expect(row!.lastErrorKind).toBe("timeout");
  });
});

describe("[5] 429 — global wait", () => {
  it("429 → rows backed off, rate_limited event with waitUntil = db clock + 5 min; sweep and delivery stand still; after the wait it resumes", async () => {
    const fake = newFake();
    const rows = seedDueRows(fake, 3);
    await runDelivery(fake, fetchStub(() => ({ status: 429 })));

    const events = auditsOf(fake, INDEXNOW_CONTROL_ACTIONS.rateLimited);
    expect(events).toHaveLength(1);
    expect((events[0]!.afterSnapshot as any).waitUntil).toBe(new Date(T0.getTime() + 5 * 60_000).toISOString());
    for (const row of rows) expect(fake.outbox.get(row.outboxId)!.status).toBe("retry_wait");
    expect(auditsOf(fake, INDEXNOW_CONTROL_ACTIONS.breakerTrip)).toHaveLength(0); // 429 is not a breaker event

    // Inside the wait: no task, no request.
    fake.advance(60_000);
    expect(await runSweep(fake)).toMatchObject({
      created: 0,
      reason: "rate_limited",
      rateLimitedUntil: new Date(T0.getTime() + 5 * 60_000).toISOString(),
    });
    const waitingFetch = fetchStub(() => ({ status: 200 }));
    expect(await runDelivery(fake, waitingFetch)).toEqual({ status: "skipped", result: { reason: "rate_limited" } });
    expect(waitingFetch).not.toHaveBeenCalled();
    expect(fake.genericTasks.size).toBe(0);

    // After the wait (and after every row's backoff) delivery resumes.
    fake.setNow(new Date(T0.getTime() + 7 * 60_000));
    expect(await runSweep(fake)).toMatchObject({ created: 1 });
    const okFetch = fetchStub(() => ({ status: 200 }));
    await runDelivery(fake, okFetch);
    expect(urlListOf(okFetch)).toHaveLength(3);
    for (const row of rows) expect(fake.outbox.get(row.outboxId)!.status).toBe("accepted");
  });

  it("Retry-After longer than 5 minutes sets the wait (900 s → 15 min)", async () => {
    const fake = newFake();
    seedDueRows(fake, 2);
    await runDelivery(fake, fetchStub(() => ({ status: 429, headers: { "retry-after": "900" } })));
    const event = auditsOf(fake, INDEXNOW_CONTROL_ACTIONS.rateLimited)[0]!;
    expect((event.afterSnapshot as any).retryAfterMs).toBe(900_000);
    expect((event.afterSnapshot as any).waitUntil).toBe(new Date(T0.getTime() + 15 * 60_000).toISOString());

    fake.setNow(new Date(T0.getTime() + 10 * 60_000));
    expect(await runSweep(fake)).toMatchObject({ created: 0, reason: "rate_limited" });
    fake.setNow(new Date(T0.getTime() + 16 * 60_000));
    expect(await runSweep(fake)).toMatchObject({ created: 1 });
  });
});

describe("[6] config missing and host mismatch — no task, no request, no row written", () => {
  it.each([
    ["config missing", { indexNowHost: "", indexNowKey: "", indexNowKeyLocation: "" }, "config_missing", "configMissing"],
    ["host not equal to the SITE_URL host", { indexNowHost: "someone-else.example" }, "host_mismatch", "hostMismatch"],
  ] as const)("%s", async (_label, setting, reason, flag) => {
    const fake = newFake();
    seedDueRows(fake, 3);
    fake.seedSiteSetting(setting);
    const before = fake.snapshot();
    const writes = fake.writes;
    const fetchImpl = fetchStub(() => ({ status: 200 }));

    const swept = await runSweep(fake);
    expect(swept).toMatchObject({ created: 0, reason, [flag]: true });
    expect(fake.genericTasks.size).toBe(0);

    expect(await runDelivery(fake, fetchImpl)).toEqual({ status: "skipped", result: { reason } });
    expect(fetchImpl).not.toHaveBeenCalled();
    // Not even a lastErrorKind / updatedAt marker on the rows.
    expect(fake.writes).toBe(writes);
    expect(fake.snapshot()).toEqual(before);
  });
});

describe("[8] bisect — a held batch that fails again isolates the bad URL", () => {
  async function failTwice(fake: FakeIndexNowDb, rowCount: number, badIndex: number) {
    const rows = seedDueRows(fake, rowCount);
    const bad = rows[badIndex]!;
    const fetchImpl = fetchStub((body) => ({ status: body.urlList.includes(bad.url) ? 422 : 200 }));
    await runDelivery(fake, fetchImpl); // 422: breaker trips, the whole batch is held
    await resumeIndexNowDelivery(fake.asPrismaClient(), { actorId: RESUME_ACTOR, reason: "operator checked, retry" });
    const outcome = await runDelivery(fake, fetchImpl); // held retry fails again → bisect
    return { rows, bad, fetchImpl, outcome };
  }

  it("rule 'urlList contains X → 422, else 200': X ends permanent_failed/isolated_bad_url, everything else accepted, within the probe cap, breaker still open", async () => {
    const fake = newFake();
    const { rows, bad, fetchImpl, outcome } = await failTwice(fake, 4, 2);

    expect(outcome).toMatchObject({ status: "success", result: { mode: "held_retry", httpStatus: 422 } });
    const stored = fake.outbox.get(bad.outboxId)!;
    expect(stored.status).toBe("permanent_failed");
    expect(stored.lastErrorKind).toBe("isolated_bad_url");
    expect(stored.nextAttemptAt).toBeNull();
    for (const row of rows) if (row !== bad) expect(fake.outbox.get(row.outboxId)!.status).toBe("accepted");

    const snapshot = lastBisectSnapshot(fake);
    expect(snapshot).toMatchObject({ conclusion: "local", acceptedCount: 3, raisedMaxAttemptsBy: 9 });
    expect(snapshot.culprits).toEqual([{ outboxId: bad.outboxId, url: bad.url }]);
    const cap = 2 + 4 * Math.ceil(Math.log2(4));
    expect(snapshot.probes as number).toBeLessThanOrEqual(cap);
    expect(snapshot.probes).toBe(4);
    // 1 (first failure) + 1 (held retry) + probes
    expect(fetchImpl).toHaveBeenCalledTimes(2 + (snapshot.probes as number));

    // Max attempts were lifted for the suspects (attemptCount 2 + 9), never lowered.
    expect(fake.outbox.get(rows[0]!.outboxId)!.maxAttempts).toBe(11);

    // The breaker is NOT closed by the bisect; only a human closes it.
    expect((await controlOf(fake)).breaker.open).toBe(true);
    expect(auditsOf(fake, INDEXNOW_CONTROL_ACTIONS.bisect)[0]).toMatchObject({ actorType: "worker", entityId: "bisect" });

  });

  it("a single-row held batch that fails again is the culprit directly (no probes)", async () => {
    const fake = newFake();
    const { bad, fetchImpl } = await failTwice(fake, 1, 0);
    expect(fake.outbox.get(bad.outboxId)).toMatchObject({ status: "permanent_failed", lastErrorKind: "isolated_bad_url" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(lastBisectSnapshot(fake)).toMatchObject({ conclusion: "local", probes: 0 });
  });

  it("several culprits: probes stay within 2 + 4·⌈log2 n⌉ and every culprit is isolated (local)", async () => {
    const fake = newFake();
    const rows = seedDueRows(fake, 8);
    const bad = new Set(rows.slice(0, 3).map((row) => row.url));
    const fetchImpl = fetchStub((body) => ({ status: body.urlList.some((url) => bad.has(url)) ? 422 : 200 }));
    await runDelivery(fake, fetchImpl);
    await resumeIndexNowDelivery(fake.asPrismaClient(), { actorId: RESUME_ACTOR, reason: "retry" });
    await runDelivery(fake, fetchImpl);
    const snapshot = lastBisectSnapshot(fake);
    expect(snapshot).toMatchObject({ conclusion: "local", probes: 8, acceptedCount: 5 });
    expect(snapshot.probes as number).toBeLessThanOrEqual(2 + 4 * 3);
    expect((snapshot.culprits as unknown[]).length).toBe(3);
    for (const row of rows.slice(0, 3)) expect(fake.outbox.get(row.outboxId)!.status).toBe("permanent_failed");
    for (const row of rows.slice(3)) expect(fake.outbox.get(row.outboxId)!.status).toBe("accepted");
  });

  it("probe_cap: with many culprits the bisect stops at exactly the cap (26 for 64 rows) and leaves the rest held", async () => {
    const fake = newFake();
    const rows = seedDueRows(fake, 64);
    // 16 bad URLs, all in the first half → the second half is accepted, the first half keeps splitting.
    const bad = new Set(rows.slice(0, 32).filter((_row, index) => index % 2 === 1).map((row) => row.url));
    const fetchImpl = fetchStub((body) => ({ status: body.urlList.some((url) => bad.has(url)) ? 422 : 200 }));
    await runDelivery(fake, fetchImpl);
    await resumeIndexNowDelivery(fake.asPrismaClient(), { actorId: RESUME_ACTOR, reason: "retry" });
    await runDelivery(fake, fetchImpl);
    const snapshot = lastBisectSnapshot(fake);
    expect(snapshot).toMatchObject({ conclusion: "probe_cap", probes: 2 + 4 * Math.ceil(Math.log2(64)) });
    expect((await controlOf(fake)).breaker.open).toBe(true);
  });
});

describe("[9] bisect concludes global when both halves fail", () => {
  it("always 403 → exactly 2 extra requests, conclusion global, every row stays held, no culprit", async () => {
    const fake = newFake();
    const rows = seedDueRows(fake, 4);
    const always403 = fetchStub(() => ({ status: 403 }));
    await runDelivery(fake, always403); // trip
    await resumeIndexNowDelivery(fake.asPrismaClient(), { actorId: RESUME_ACTOR, reason: "retry" });
    await runDelivery(fake, always403); // held retry → 403 → bisect
    // 2 (batch attempts) + 2 (the two halves)
    expect(always403).toHaveBeenCalledTimes(4);
    const snapshot = lastBisectSnapshot(fake);
    expect(snapshot).toMatchObject({ conclusion: "global", probes: 2, acceptedCount: 0, culprits: [] });
    for (const row of rows) expect(fake.outbox.get(row.outboxId)!.status).toBe("retry_wait");
    expect((await controlOf(fake)).breaker.open).toBe(true);
  });
});

describe("[10] bisect interrupted by a non-4xx sub-request", () => {
  it("a 503 on the first probe stops the bisect (interrupted); untested rows stay held", async () => {
    const fake = newFake();
    const rows = seedDueRows(fake, 4);
    const calls: number[] = [];
    const fetchImpl = fetchStub((_body, call) => {
      calls.push(call);
      return { status: call === 3 ? 503 : 422 };
    });
    await runDelivery(fake, fetchImpl); // call 1 → 422
    await resumeIndexNowDelivery(fake.asPrismaClient(), { actorId: RESUME_ACTOR, reason: "retry" });
    await runDelivery(fake, fetchImpl); // call 2 → 422, call 3 (first probe) → 503
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const snapshot = lastBisectSnapshot(fake);
    expect(snapshot).toMatchObject({ conclusion: "interrupted", probes: 1, culprits: [] });
    // First half backed off after the 503; second half was never probed.
    expect(fake.outbox.get(rows[0]!.outboxId)).toMatchObject({ status: "retry_wait", lastHttpStatus: 503 });
    expect(fake.outbox.get(rows[2]!.outboxId)).toMatchObject({ status: "retry_wait", lastHttpStatus: 422 });
    expect((await controlOf(fake)).breaker.open).toBe(true);
  });

  it("a lost lease (heartbeat false) before a probe also ends the bisect as interrupted", async () => {
    const fake = newFake();
    seedDueRows(fake, 4);
    const always422 = fetchStub(() => ({ status: 422 }));
    await runDelivery(fake, always422);
    await resumeIndexNowDelivery(fake.asPrismaClient(), { actorId: RESUME_ACTOR, reason: "retry" });
    await runDelivery(fake, always422, { heartbeat: async () => false });
    expect(always422).toHaveBeenCalledTimes(2);
    expect(lastBisectSnapshot(fake)).toMatchObject({ conclusion: "interrupted", probes: 0 });
  });
});

describe("[11][22] pre-flight on the whole batch — drift, URL format, URL host", () => {
  it("[11] ineligible or URL-changed rows are cancelled (eligibility_failed) and never appear in the urlList", async () => {
    const fake = newFake();
    const rows = seedDueRows(fake, 3);
    fake.articles.get(rows[0]!.articleId)!.novelStatus = "takedown";
    fake.articles.get(rows[1]!.articleId)!.slug = "renamed-after-enqueue";
    const fetchImpl = fetchStub(() => ({ status: 200 }));

    const outcome = await runDelivery(fake, fetchImpl);
    expect(outcome).toMatchObject({ status: "success", result: { claimed: 1, cancelled: 2 } });
    expect(urlListOf(fetchImpl)).toEqual([rows[2]!.url]);
    for (const row of rows.slice(0, 2)) {
      expect(fake.outbox.get(row.outboxId)).toMatchObject({ status: "cancelled", lastErrorKind: "eligibility_failed", nextAttemptAt: null });
    }
    expect(fake.outbox.get(rows[2]!.outboxId)!.status).toBe("accepted");
  });

  it("[22] a URL with a query becomes url_invalid, a foreign host becomes url_host_mismatch; neither is sent; the diagnosis is redacted", async () => {
    const fake = newFake();
    const rows = seedDueRows(fake, 3);
    fake.outbox.get(rows[0]!.outboxId)!.url = `${TEST_SITE_URL}/novel/book-r-00000-pr00000?key=SECRETKEY123&x=1`;
    fake.outbox.get(rows[1]!.outboxId)!.url = "https://other-site.example/novel/book-r-00001-pr00001";
    const fetchImpl = fetchStub(() => ({ status: 200 }));

    const outcome = await runDelivery(fake, fetchImpl);
    expect(outcome).toMatchObject({ status: "success", result: { claimed: 1, cancelled: 2 } });
    expect(urlListOf(fetchImpl)).toEqual([rows[2]!.url]);

    const invalid = fake.outbox.get(rows[0]!.outboxId)!;
    expect(invalid).toMatchObject({ status: "cancelled", lastErrorKind: "url_invalid" });
    expect(invalid.lastErrorSummary).toContain("url_invalid");
    expect(invalid.lastErrorSummary).not.toContain("SECRETKEY123");
    expect(invalid.lastErrorSummary).toContain("key=[REDACTED]");

    const mismatch = fake.outbox.get(rows[1]!.outboxId)!;
    expect(mismatch).toMatchObject({ status: "cancelled", lastErrorKind: "url_host_mismatch" });
    expect(mismatch.lastErrorSummary).toContain("url_host_mismatch");

  });

  it("a URL longer than 2048 characters is url_invalid", async () => {
    const fake = newFake();
    const [row] = seedDueRows(fake, 1);
    fake.outbox.get(row!.outboxId)!.url = `${TEST_SITE_URL}/novel/${"a".repeat(2100)}`;
    const fetchImpl = fetchStub(() => ({ status: 200 }));
    await runDelivery(fake, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fake.outbox.get(row!.outboxId)!.lastErrorKind).toBe("url_invalid");
  });
});

describe("blog family rows survive the pre-flight (C-29b)", () => {
  const BLOG_ENV = testEnv({ FEATURE_INDEXNOW_DELIVERY: "true", INDEXNOW_DELIVERY_ALLOW_WRITE: "true", FEATURE_ARTICLE_BLOG: "true" });

  function seedBlog(fake: FakeIndexNowDb) {
    fake.seedArticle({ id: "blog-1", articleType: "blog_article", locale: "en", slug: "my-post", status: "published", updatedAt: new Date("2026-01-01T00:00:00.000Z") });
    fake.seedOutbox({
      id: "outbox-blog",
      articleId: "blog-1",
      url: `${TEST_SITE_URL}/blog/my-post`,
      revision: BigInt(new Date("2026-01-01T00:00:00.000Z").getTime()),
      createdAt: new Date(T0.getTime() - 1000),
    });
  }

  it("an eligible blog row is delivered (no throw on the missing Novel)", async () => {
    const fake = newFake();
    seedBlog(fake);
    const fetchImpl = fetchStub(() => ({ status: 200 }));
    const handler = createIndexNowDeliveryHandler(fake.asPrismaClient(), fetchImpl as unknown as typeof fetch, BLOG_ENV, { ...LOCALE_OK, env: BLOG_ENV });
    const outcome = await handler({ lease: batchLease(), mode: "apply", signal: new AbortController().signal, heartbeat: async () => true });
    expect(outcome.status).toBe("success");
    expect(fake.outbox.get("outbox-blog")!.status).toBe("accepted");
  });

  it("a blog row whose Article drifted out of eligibility (takedown) is cancelled, not thrown", async () => {
    const fake = newFake();
    seedBlog(fake);
    fake.articles.get("blog-1")!.status = "takedown";
    const fetchImpl = fetchStub(() => ({ status: 200 }));
    const handler = createIndexNowDeliveryHandler(fake.asPrismaClient(), fetchImpl as unknown as typeof fetch, BLOG_ENV, { ...LOCALE_OK, env: BLOG_ENV });
    const outcome = await handler({ lease: batchLease(), mode: "apply", signal: new AbortController().signal, heartbeat: async () => true });
    expect(outcome).toMatchObject({ status: "success", result: { claimed: 0, cancelled: 1 } });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fake.outbox.get("outbox-blog")!.status).toBe("cancelled");
  });
});

describe("[12] crash recovery — a whole batch stuck in processing is re-pushed", () => {
  it("a batch left in processing for > 35 min is recovered as unknown_outcome and re-pushed; attempt numbers increase and never repeat", async () => {
    const fake = newFake();
    const rows = seedDueRows(fake, 3, { status: "processing", overrides: { attemptCount: 1 } });
    for (const row of rows) {
      fake.seedAttempt({ outboxId: row.outboxId, attemptNo: 1, attemptState: "started", requestBatchId: "crashed-batch", batchSize: 3, requestAt: new Date(T0.getTime() - 3_600_000) });
    }

    const swept = await runSweep(fake);
    expect(swept).toMatchObject({ recovered: 3, created: 1 });
    for (const row of rows) expect(fake.outbox.get(row.outboxId)!.status).toBe("retry_wait");

    const fetchImpl = fetchStub(() => ({ status: 200 }));
    await runDelivery(fake, fetchImpl);
    expect(urlListOf(fetchImpl)).toHaveLength(3);
    for (const row of rows) {
      const stored = fake.outbox.get(row.outboxId)!;
      expect(stored.status).toBe("accepted");
      expect(stored.attemptCount).toBe(2);
      const mine = [...fake.attempts.values()].filter((attempt) => attempt.outboxId === row.outboxId).sort((a, b) => a.attemptNo - b.attemptNo);
      expect(mine.map((attempt) => attempt.attemptNo)).toEqual([1, 2]);
      expect(mine[0]!.attemptState).toBe("unknown_outcome");
      expect(mine[1]!.attemptState).toBe("completed");
    }
  });
});

describe("write-back is one transaction", () => {
  it("if the write-back fails, nothing of it is applied (rows stay processing, attempts stay started) for recovery to find", async () => {
    const fake = newFake();
    const rows = seedDueRows(fake, 2);
    const db = fake.asPrismaClient();
    // Break the second transaction (write-back) by making the control lock query throw only on a 403 response.
    const original = (db as any).$transaction;
    let transactions = 0;
    (db as any).$transaction = async (fn: any, opts: any) => {
      transactions++;
      if (transactions === 2) {
        return original(async (tx: any) => {
          await tx.indexNowOutboxAttempt.updateMany({ where: {}, data: { attemptState: "completed" } });
          throw new Error("simulated write-back failure");
        }, opts);
      }
      return original(fn, opts);
    };
    const handler = createIndexNowDeliveryHandler(db, fetchStub(() => ({ status: 200 })) as unknown as typeof fetch, ENABLED_DELIVERY_ENV, LOCALE_OK);
    await expect(handler({ lease: batchLease(), mode: "apply", signal: new AbortController().signal, heartbeat: async () => true })).rejects.toThrow(
      "simulated write-back failure",
    );
    for (const row of rows) expect(fake.outbox.get(row.outboxId)!.status).toBe("processing");
    expect([...fake.attempts.values()].every((attempt) => attempt.attemptState === "started")).toBe(true);
  });
});
