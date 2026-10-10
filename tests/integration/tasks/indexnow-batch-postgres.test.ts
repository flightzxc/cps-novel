/**
 * B-41 real-PostgreSQL verification of IndexNow batch delivery.
 *
 * Runs against a disposable database with the REAL roles: `worker_app` does the
 * scan and the delivery, `web_app` publishes, `scheduler_app` schedules — a
 * `permission denied` anywhere fails the run, which is also the proof that
 * this change needs no grants change. Wired into
 * `scripts/run-indexnow-sweep-postgres-verification.sh`.
 *
 * Sections: batch cycle · breaker/resume · 429 wait · config guards · bisect ·
 * control-plane concurrency (cases 28–34) · backfill on real tables · query
 * plan of the control-state SQL on ≥ 750k `operation_audit` rows (7.11).
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { INDEXNOW_CONTROL_ACTIONS, INDEXNOW_CONTROL_STATE_SQL, getIndexNowDeliveryControlState, lockIndexNowControl, recordIndexNowBreakerTrip, resumeIndexNowDelivery } from "@/lib/indexnow/delivery-control";
import { listPublishedWithoutIndexNowDelivery } from "@/lib/indexnow/outbox";
import { sweepDueIndexNowDeliveries } from "@/lib/indexnow/sweep";
import { INDEXNOW_BATCH_OPERATION_SCOPE_HASH } from "@/lib/indexnow/outbox-contract";
import { invalidateSiteSettingCache } from "@/server/site-settings/service";
import { buildBackfillManifest, selectBackfillCandidates } from "../../../scripts/indexnow-backfill-manifest";
import { applyBackfill, collectBackfillGlobalSummary, assertBackfillStopConditions } from "../../../scripts/indexnow-backfill-apply";
import { collectIndexNowStatus } from "../../../scripts/indexnow-status";
import { createIndexNowDeliveryHandler } from "../../../worker/handlers/indexnow-delivery";

const enabled = process.env.WO6_DATABASE_TEST === "1";
const owner = new PrismaClient({ datasourceUrl: process.env.WO6_OWNER_DATABASE_URL });
const worker = new PrismaClient({ datasourceUrl: process.env.WO6_WORKER_DATABASE_URL });
// A second pool for the "two connections" cases.
const workerB = new PrismaClient({ datasourceUrl: process.env.WO6_WORKER_DATABASE_URL });
const env = {
  NODE_ENV: "test", SITE_URL: "https://indexnow.test", FEATURE_INDEXNOW_OUTBOX: "true", INDEXNOW_OUTBOX_ALLOW_WRITE: "true",
  FEATURE_INDEXNOW_DELIVERY: "true", INDEXNOW_DELIVERY_ALLOW_WRITE: "true", INDEXNOW_BACKFILL_ALLOW_WRITE: "true", FEATURE_ARTICLE_BLOG: "true",
} as const;
const deliveryType = "indexnow_delivery";
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

let endpoint: string;
let requests: Array<{ body: { host: string; key: string; keyLocation: string; urlList: string[] } }> = [];
/** Per-test responder: HTTP status for a request body, or undefined for 200. */
let responder: ((body: { urlList: string[] }, call: number) => number | undefined) | null = null;
let statuses: number[] = [];
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const part of req) raw += part;
  const body = JSON.parse(raw);
  requests.push({ body });
  const status = statuses.shift() ?? responder?.(body, requests.length) ?? 200;
  res.statusCode = status;
  res.end("local indexnow fixture");
});

const fetchToFixture = ((_url: unknown, init?: RequestInit) => fetch(endpoint, init)) as unknown as typeof fetch;

async function blogRows(count: number, prefix = randomUUID().slice(0, 6), startMs = Date.now() - 3_600_000) {
  const ids = Array.from({ length: count }, () => randomUUID());
  await owner.article.createMany({
    data: ids.map((id, index) => ({
      id, locale: "en", slug: `${prefix}-${index}`, publicPageShortId: `${prefix}${index}`.slice(0, 32), title: "t", body: "b",
      status: "published", articleType: "blog_article", publishedAt: new Date(startMs),
    })),
  });
  await owner.indexNowOutbox.createMany({
    data: ids.map((id, index) => ({
      articleId: id, url: `https://indexnow.test/blog/${prefix}-${index}`, revision: BigInt(index + 1), eventType: "article_first_publish",
      locale: "en", source: "publish", createdAt: new Date(startMs + index * 1000),
    })),
  });
  return ids.map((id, index) => ({ articleId: id, url: `https://indexnow.test/blog/${prefix}-${index}` }));
}

function deliveryHandler(client: PrismaClient = worker) {
  return createIndexNowDeliveryHandler(client, fetchToFixture, env as unknown as NodeJS.ProcessEnv);
}
async function deliver(client: PrismaClient = worker, options: { heartbeat?: () => Promise<boolean> } = {}) {
  return deliveryHandler(client)({
    lease: { family: "generic", taskType: deliveryType, mode: "apply", itemId: randomUUID(), taskId: randomUUID(), workerId: "b41-test",
      executionToken: randomUUID(), leaseEpoch: 1n, attemptCount: 1, lockedUntil: new Date(Date.now() + 60_000), payload: { mode: "batch" } },
    mode: "apply", signal: new AbortController().signal, heartbeat: options.heartbeat ?? (async () => true),
  });
}
async function completeBatchTasks() {
  await owner.genericTask.updateMany({ where: { taskType: deliveryType, status: { in: ["pending", "processing"] } }, data: { status: "completed" } });
}
/** One minute-scan + the delivery it would have triggered, as the worker-light loop does them (real roles, no framework). */
async function scanAndDeliver() {
  const swept = await sweepDueIndexNowDeliveries(worker);
  let delivered: Awaited<ReturnType<typeof deliver>> | null = null;
  if (swept.created === 1) delivered = await deliver();
  await completeBatchTasks();
  return { swept, delivered };
}
const statusOf = async (id: string) => (await owner.indexNowOutbox.findUniqueOrThrow({ where: { id } })).status;
const rowOf = (articleId: string) => owner.indexNowOutbox.findFirstOrThrow({ where: { articleId } });
async function commitTrip(batch: string = randomUUID(), heldRetry = false) {
  await worker.$transaction(async tx => {
    await lockIndexNowControl(tx);
    await recordIndexNowBreakerTrip(tx, { requestBatchId: batch, httpStatus: 403, urlCount: 1, heldRetry, dbNow: new Date(), taskId: randomUUID() });
  });
}
const resume = (reason = "operator checked") => resumeIndexNowDelivery(worker, { actorId: randomUUID(), reason });
const control = () => getIndexNowDeliveryControlState(worker);

describe.skipIf(!enabled).sequential("B-41 IndexNow batch delivery on real PostgreSQL roles", () => {
  beforeAll(async () => {
    expect((await owner.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`)[0].name).toMatch(/^cps_novel_wo6_/);
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    server.listen(0, "127.0.0.1"); await once(server, "listening"); endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  beforeEach(async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    await owner.$executeRawUnsafe("TRUNCATE generic_task, schedule_run, article, novel, operation_audit CASCADE");
    requests = []; statuses = []; responder = null; invalidateSiteSettingCache();
    const settings = { indexNowHost: "indexnow.test", indexNowKey: "b41-local-test-key", indexNowKeyLocation: "https://indexnow.test/indexnow-key.txt" };
    await owner.siteSetting.upsert({ where: { id: 1 }, create: { id: 1, ...settings }, update: settings });
  });
  afterEach(() => { responder = null; });
  afterAll(async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await Promise.all([owner.$disconnect(), worker.$disconnect(), workerB.$disconnect()]); vi.unstubAllEnvs();
  });

  // ---------------------------------------------------------------- batch cycle
  it("501 due rows: ONE request carries exactly the 500 oldest URLs (FIFO), the next scan sends the last one — worker_app only, no permission denied", async () => {
    const rows = await blogRows(501);
    const first = await scanAndDeliver();
    expect(first.swept).toMatchObject({ created: 1 });
    expect(requests).toHaveLength(1);
    expect(requests[0].body.urlList).toEqual(rows.slice(0, 500).map(row => row.url));
    expect(requests[0].body).toMatchObject({ host: "indexnow.test", key: "b41-local-test-key", keyLocation: "https://indexnow.test/indexnow-key.txt" });
    const attempts = await owner.indexNowOutboxAttempt.findMany();
    expect(attempts).toHaveLength(500);
    expect(new Set(attempts.map(a => a.requestBatchId)).size).toBe(1);
    expect(new Set(attempts.map(a => a.batchSize))).toEqual(new Set([500]));
    expect(await owner.indexNowOutbox.count({ where: { status: "accepted" } })).toBe(500);

    const second = await scanAndDeliver();
    expect(second.swept).toMatchObject({ created: 1 });
    expect(requests).toHaveLength(2);
    expect(requests[1].body.urlList).toEqual([rows[500].url]);
    expect(await owner.indexNowOutbox.count({ where: { status: "accepted" } })).toBe(501);
    console.log(`B41_BATCH urls_first_request=${requests[0].body.urlList.length} urls_second_request=${requests[1].body.urlList.length}`);
  });

  it("202 is accepted and recorded as key_validation_pending; status reports pending, then verified after a 200", async () => {
    const [a] = await blogRows(1, "k1");
    statuses = [202]; await scanAndDeliver();
    expect(await owner.indexNowOutboxAttempt.findFirstOrThrow()).toMatchObject({ outcome: "accepted", httpStatus: 202, errorKind: "key_validation_pending" });
    expect((await collectIndexNowStatus(worker) as any).keyValidation.state).toBe("pending");
    await blogRows(1, "k2"); await scanAndDeliver();
    expect((await collectIndexNowStatus(worker) as any).keyValidation.state).toBe("verified");
    expect(await statusOf((await rowOf(a.articleId)).id)).toBe("accepted");
  });

  // -------------------------------------------------------------- breaker/resume
  it("403 opens the breaker (trip event written by worker_app); scan and delivery stand still; a worker_app resume writes the audit and only the held batch goes out", async () => {
    const held = await blogRows(3, "held");
    statuses = [403]; await scanAndDeliver();
    expect(requests).toHaveLength(1);
    for (const row of held) expect(await owner.indexNowOutbox.findFirstOrThrow({ where: { articleId: row.articleId } })).toMatchObject({ status: "retry_wait", lastHttpStatus: 403, attemptCount: 1 });
    const trips = await owner.operationAudit.findMany({ where: { action: INDEXNOW_CONTROL_ACTIONS.breakerTrip } });
    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({ actorType: "worker", entityType: "indexnow_delivery", entityId: "breaker" });
    expect(trips[0].afterSnapshot).toMatchObject({ httpStatus: 403, urlCount: 3, heldRetry: false });

    expect((await scanAndDeliver()).swept).toMatchObject({ created: 0, reason: "breaker_open", breakerOpen: true });
    expect(await deliver()).toEqual({ status: "skipped", result: { reason: "breaker_open" } });
    expect(requests).toHaveLength(1);

    const fresh = await blogRows(1, "fresh", Date.now());
    const actorId = randomUUID();
    const resumed = await resumeIndexNowDelivery(worker, { actorId, reason: "key file republished" });
    const audit = await owner.operationAudit.findFirstOrThrow({ where: { action: INDEXNOW_CONTROL_ACTIONS.breakerResume } });
    expect(audit).toMatchObject({ actorType: "admin", actorId, reason: "key file republished", entityId: "breaker" });
    expect(audit.afterSnapshot).toEqual({ resumedTripAuditId: resumed.resumedTripAuditId.toString() });
    expect((await control()).breaker.open).toBe(false);

    const after = await scanAndDeliver();
    expect(after.swept).toMatchObject({ created: 1 });
    expect(requests).toHaveLength(2);
    expect(requests[1].body.urlList).toEqual(held.map(row => row.url)); // held batch alone
    expect(requests[1].body.urlList).not.toContain(fresh[0].url);
    expect(await owner.indexNowOutbox.count({ where: { status: "accepted" } })).toBe(3);
  });

  // ------------------------------------------------------------------- 429 wait
  it("429 sets a global wait (event deadline ≥ 5 min): scan creates nothing, delivery sends nothing", async () => {
    const rows = await blogRows(2, "rl");
    statuses = [429]; await scanAndDeliver();
    const state = await control();
    expect(state.rateLimit.waiting).toBe(true);
    if (!state.rateLimit.waiting) throw new Error("unreachable");
    expect(state.rateLimit.until.getTime() - Date.now()).toBeGreaterThan(4 * 60_000);
    expect((await scanAndDeliver()).swept).toMatchObject({ created: 0, reason: "rate_limited" });
    expect(await deliver()).toEqual({ status: "skipped", result: { reason: "rate_limited" } });
    expect(requests).toHaveLength(1);
    for (const row of rows) expect(await statusOf((await rowOf(row.articleId)).id)).toBe("retry_wait");
  });

  // -------------------------------------------------------------- config guards
  it.each([
    ["config missing", { indexNowHost: "", indexNowKey: "", indexNowKeyLocation: "" }, "config_missing"],
    ["host differs from SITE_URL", { indexNowHost: "elsewhere.test" }, "host_mismatch"],
  ] as const)("%s: no task, no request, no row touched", async (_label, patch, reason) => {
    await blogRows(2, "cfg");
    await owner.siteSetting.update({ where: { id: 1 }, data: patch }); invalidateSiteSettingCache();
    const before = await owner.indexNowOutbox.findMany({ orderBy: { id: "asc" } });
    expect(await sweepDueIndexNowDeliveries(worker)).toMatchObject({ created: 0, reason });
    expect(await owner.genericTask.count()).toBe(0);
    expect(await deliver()).toEqual({ status: "skipped", result: { reason } });
    expect(requests).toHaveLength(0);
    expect(await owner.indexNowOutbox.findMany({ orderBy: { id: "asc" } })).toEqual(before);
  });

  // ---------------------------------------------------------------------- bisect
  it("a held batch that fails again is bisected under worker_app: the bad URL is isolated, max_attempts is raised, the breaker stays open", async () => {
    const rows = await blogRows(4, "bis");
    const bad = rows[2];
    responder = body => (body.urlList.includes(bad.url) ? 422 : 200);
    await scanAndDeliver(); // 422 → held
    await resume();
    await scanAndDeliver(); // held retry → 422 → bisect
    expect(await owner.indexNowOutbox.findFirstOrThrow({ where: { articleId: bad.articleId } })).toMatchObject({ status: "permanent_failed", lastErrorKind: "isolated_bad_url", nextAttemptAt: null });
    for (const row of rows.filter(r => r !== bad)) {
      expect(await owner.indexNowOutbox.findFirstOrThrow({ where: { articleId: row.articleId } })).toMatchObject({ status: "accepted", maxAttempts: 11 });
    }
    const bisect = await owner.operationAudit.findFirstOrThrow({ where: { action: INDEXNOW_CONTROL_ACTIONS.bisect } });
    expect(bisect).toMatchObject({ actorType: "worker", entityId: "bisect" });
    expect(bisect.afterSnapshot).toMatchObject({ conclusion: "local", probes: 4, acceptedCount: 3, raisedMaxAttemptsBy: 9 });
    expect((await control()).breaker.open).toBe(true);
    const status = await collectIndexNowStatus(worker) as any;
    expect(status.control.breaker.repeatAfterResume).toBe(true);
    expect(status.breaker.urls).toBe(4);
  });

  // --------------------------------------------------- control-plane concurrency
  it("[28] two connections reading the control state while a trip and then a resume commit only ever see a PREFIX of the committed events; afterwards both agree", async () => {
    let done = false;
    const rank = (s: Awaited<ReturnType<typeof control>>) => (s.breaker.open ? 1 : s.lastResume ? 2 : 0);
    const read = async (client: PrismaClient) => {
      const seen: number[] = [];
      while (!done) { seen.push(rank(await getIndexNowDeliveryControlState(client))); await sleep(2); }
      return seen;
    };
    const readers = [read(worker), read(workerB)];
    await sleep(60); await commitTrip(); await sleep(120); await resume(); await sleep(120); done = true;
    for (const seen of await Promise.all(readers)) {
      expect(seen.length).toBeGreaterThan(5);
      expect([...seen].sort((a, b) => a - b)).toEqual(seen); // never goes backwards: S0 → S1 → S2
      expect(seen[0]).toBe(0);
    }
    const [a, b] = [await getIndexNowDeliveryControlState(worker), await getIndexNowDeliveryControlState(workerB)];
    expect(rank(a)).toBe(2); expect(rank(b)).toBe(2);
    expect(a.lastResume?.auditId).toBe(b.lastResume?.auditId);
  });

  it("[29a] a trip that holds the lock blocks a concurrent resume; the resume then covers THAT trip (commit order decides)", async () => {
    await commitTrip(randomUUID());
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    let inserted!: () => void; const insertedP = new Promise<void>(r => { inserted = r; });
    const holder = worker.$transaction(async tx => {
      await lockIndexNowControl(tx);
      await recordIndexNowBreakerTrip(tx, { requestBatchId: "second-trip", httpStatus: 422, urlCount: 1, heldRetry: true, dbNow: new Date(), taskId: randomUUID() });
      inserted(); await gate;
    }, { timeout: 20_000 });
    await insertedP;
    let resumed = false;
    const resuming = resume().then(r => { resumed = true; return r; });
    await sleep(500);
    expect(resumed).toBe(false); // blocked by the lock the trip transaction holds
    release(); await holder; const result = await resuming;
    const secondTrip = await owner.operationAudit.findFirstOrThrow({ where: { action: INDEXNOW_CONTROL_ACTIONS.breakerTrip, afterSnapshot: { path: ["requestBatchId"], equals: "second-trip" } } });
    expect(result.resumedTripAuditId).toBe(secondTrip.id);
    expect((await control()).breaker.open).toBe(false);
  });

  it("[29b] a trip that commits AFTER a resume re-opens the breaker (its id is the larger one)", async () => {
    await commitTrip(); await resume();
    expect((await control()).breaker.open).toBe(false);
    await commitTrip("after-resume", true);
    const state = await control();
    expect(state.breaker.open).toBe(true);
    if (!state.breaker.open) throw new Error("unreachable");
    expect(state.breaker.trippedBy.requestBatchId).toBe("after-resume");
    expect(state.breaker.breakerTripEvents).toBe(1);
    expect(state.repeatAfterResume).toBe(true);
  });

  it("[29c] event ORDER is the id, not created_at: a resume whose transaction STARTED earlier (older created_at) but committed after the trip still covers it", async () => {
    await commitTrip();
    let releaseR!: () => void; const gateR = new Promise<void>(r => { releaseR = r; });
    let releaseT!: () => void; const gateT = new Promise<void>(r => { releaseT = r; });
    let rStarted!: () => void; const rStartedP = new Promise<void>(r => { rStarted = r; });
    let tInserted!: () => void; const tInsertedP = new Promise<void>(r => { tInserted = r; });
    // created_at below is the DATABASE DEFAULT (transaction start time), the same default every raw-SQL writer gets.
    const insertEvent = (tx: Parameters<Parameters<typeof worker.$transaction>[0]>[0], action: string, actorType: string) => tx.$executeRaw`
      INSERT INTO operation_audit (actor_type, action, entity_type, entity_id, request_id, reason, after_snapshot)
      VALUES (${actorType}, ${action}, 'indexnow_delivery', 'breaker', ${actorType === "admin" ? randomUUID() : null}, 'ordering probe',
        ${JSON.stringify({ requestBatchId: "tx-start-probe", httpStatus: 403, urlCount: 1, heldRetry: false, resumedTripAuditId: "0" })}::jsonb)`;
    const rTx = worker.$transaction(async tx => {
      rStarted(); await gateR; // the transaction (and its created_at) started BEFORE T's
      await lockIndexNowControl(tx);
      expect((await getIndexNowDeliveryControlState(tx)).breaker.open).toBe(true); // it sees T's committed trip
      await insertEvent(tx, INDEXNOW_CONTROL_ACTIONS.breakerResume, "admin");
    }, { timeout: 20_000 });
    await rStartedP; await sleep(30);
    const tTx = worker.$transaction(async tx => {
      await lockIndexNowControl(tx);
      await insertEvent(tx, INDEXNOW_CONTROL_ACTIONS.breakerTrip, "worker"); // created_at(T) > created_at(R)
      tInserted(); await gateT;
    }, { timeout: 20_000 });
    await tInsertedP; releaseR(); await sleep(300); releaseT(); await Promise.all([tTx, rTx]);
    const events = await owner.operationAudit.findMany({ where: { entityId: "breaker" }, orderBy: { id: "asc" } });
    const tripT = events[events.length - 2], resumeR = events[events.length - 1];
    expect(tripT.action).toBe(INDEXNOW_CONTROL_ACTIONS.breakerTrip);
    expect(resumeR.action).toBe(INDEXNOW_CONTROL_ACTIONS.breakerResume);
    expect(resumeR.createdAt.getTime()).toBeLessThan(tripT.createdAt.getTime()); // the trap: older created_at, larger id
    expect((await control()).breaker.open).toBe(false); // by id: closed
  });

  it("[30] a request in flight (attempt started, no response) blocks the resume with in_flight_requests_present; once it completes the resume works", async () => {
    await commitTrip();
    const [row] = await blogRows(1, "fl");
    const outbox = await rowOf(row.articleId);
    const attempt = await owner.indexNowOutboxAttempt.create({ data: { outboxId: outbox.id, attemptNo: 1, outcome: "started", attemptState: "started", requestBatchId: randomUUID(), requestAt: new Date(), batchSize: 1 } });
    await expect(resume()).rejects.toMatchObject({ code: "in_flight_requests_present" });
    expect((await control()).breaker.open).toBe(true);
    expect(await owner.operationAudit.count({ where: { action: INDEXNOW_CONTROL_ACTIONS.breakerResume } })).toBe(0);
    await owner.indexNowOutboxAttempt.update({ where: { id: attempt.id }, data: { attemptState: "completed" } });
    await expect(resume()).resolves.toMatchObject({ requestId: expect.any(String) });
  });

  it("[31] two resumes at once: exactly one wins, the other gets breaker_not_open, one audit row", async () => {
    await commitTrip();
    const results = await Promise.allSettled([resume("first"), resumeIndexNowDelivery(workerB, { actorId: randomUUID(), reason: "second" })]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: "breaker_not_open" });
    expect(await owner.operationAudit.count({ where: { action: INDEXNOW_CONTROL_ACTIONS.breakerResume } })).toBe(1);
  });

  it("[32] the 429 deadline lives in the event: cancelling or resetting the rows of the 429 batch does not move it", async () => {
    await blogRows(3, "dl");
    statuses = [429]; await scanAndDeliver();
    const before = await control();
    expect(before.rateLimit.waiting).toBe(true);
    await owner.indexNowOutbox.updateMany({ data: { status: "cancelled", nextAttemptAt: new Date(0) } });
    const afterCancel = await control();
    await owner.indexNowOutbox.updateMany({ data: { status: "pending", nextAttemptAt: null, lastHttpStatus: null, attemptCount: 0 } });
    const afterReset = await control();
    expect(afterCancel.rateLimit).toEqual(before.rateLimit);
    expect(afterReset.rateLimit).toEqual(before.rateLimit);
    expect((await scanAndDeliver()).swept).toMatchObject({ created: 0, reason: "rate_limited" });
  });

  it("[33] concurrent scans leave exactly ONE in-flight batch task; the database unique index is what refuses a second", async () => {
    await blogRows(2, "cc");
    const results = await Promise.all(Array.from({ length: 4 }, (_unused, i) =>
      (i % 2 ? workerB : worker).$transaction(tx => sweepDueIndexNowDeliveries(tx), { timeout: 20_000 })));
    expect(results.filter(r => r.created === 1)).toHaveLength(1);
    expect(results.filter(r => r.reason === "already_live")).toHaveLength(3);
    expect(await owner.genericTask.count({ where: { taskType: deliveryType, status: { in: ["pending", "processing"] } } })).toBe(1);
    expect(await owner.genericTaskItem.count({ where: { task: { taskType: deliveryType } } })).toBe(1);
    await expect(owner.genericTask.create({ data: { taskType: deliveryType, operationScopeHash: INDEXNOW_BATCH_OPERATION_SCOPE_HASH, requestToken: randomUUID(), totalCount: 1 } })).rejects.toThrow(/Unique constraint/);
  });

  it("[34] the claim transaction re-reads the control state INSIDE the lock: a trip committed between the unlocked check and the claim means zero rows claimed", async () => {
    const rows = await blogRows(3, "race");
    let tripped = false;
    const interleaved = new Proxy(worker, {
      get(target, prop) {
        if (prop === "$transaction") {
          return async (fn: unknown, options: unknown) => {
            if (!tripped) { tripped = true; await commitTrip(); } // lands after the handler's unlocked read, before its claim
            return (target.$transaction as (...a: unknown[]) => unknown).call(target, fn, options);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as PrismaClient;
    const outcome = await deliver(interleaved);
    expect(tripped).toBe(true);
    expect(outcome).toEqual({ status: "skipped", result: { reason: "breaker_open" } });
    expect(requests).toHaveLength(0);
    expect(await owner.indexNowOutboxAttempt.count()).toBe(0);
    for (const row of rows) expect(await owner.indexNowOutbox.findFirstOrThrow({ where: { articleId: row.articleId } })).toMatchObject({ status: "pending", attemptCount: 0 });
  });

  // ------------------------------------------------------------ backfill on real tables
  describe("backfill on real tables", () => {
    async function novelRows(count: number, prefix: string) {
      const suffix = randomUUID().replaceAll("-", "");
      const channel = await owner.channel.create({ data: { code: suffix, name: "local" } });
      const app = await owner.sourceApp.create({ data: { code: suffix, name: "local" } });
      const channelApp = await owner.channelApp.create({ data: { channelId: channel.id, sourceAppId: app.id, externalAppId: suffix, projectType: 1 } });
      const account = await owner.channelAccount.create({ data: { channelId: channel.id, businessId: suffix, accountName: "local" } });
      const ids = Array.from({ length: count }, () => ({ novel: randomUUID(), source: randomUUID(), promo: randomUUID(), article: randomUUID() }));
      const tag = (index: number) => `${prefix}${String(index).padStart(5, "0")}`;
      await owner.novel.createMany({ data: ids.map((id, i) => ({ id: id.novel, businessId: `${tag(i)}-${suffix}`, title: "T", description: "D", locale: "ko", slug: tag(i), status: "published" })) });
      await owner.novelSourceItem.createMany({ data: ids.map((id, i) => ({ id: id.source, channelAppId: channelApp.id, novelId: id.novel, externalBookId: `${tag(i)}-${suffix}`, sourceLanguageCode: "ko", title: "T", description: "D", rawPayload: {}, status: "linked" })) });
      await owner.promoLink.createMany({ data: ids.map((id, i) => ({ id: id.promo, novelId: id.novel, novelSourceItemId: id.source, channelAppId: channelApp.id, channelAccountId: account.id, offerType: "read", publicRedirectCode: `${tag(i)}${suffix}`.slice(0, 32), idempotencyKey: `${tag(i)}${suffix}`.padEnd(64, "0").slice(0, 64), webUrl: "https://promo.test/book", status: "fetched" })) });
      await owner.article.createMany({ data: ids.map((id, i) => ({ id: id.article, novelId: id.novel, promoLinkId: id.promo, locale: "ko", slug: tag(i), publicPageShortId: `${tag(i)}`, title: "T", body: "B", status: "published", publishedAt: new Date("2026-10-01T00:00:00Z") })) });
      return ids.map(id => id.article).sort();
    }

    it("the cursor walks ALL published novel articles across pages (1,300 rows, pages of 400), skipping those with any outbox row", async () => {
      const articles = await novelRows(1300, "cur");
      await owner.indexNowOutbox.createMany({ data: articles.slice(0, 100).map((id, i) => ({ articleId: id, url: `https://indexnow.test/has/${i}`, revision: 1n, eventType: "article_first_publish", locale: "ko", source: "publish" })) });
      const listed = await listPublishedWithoutIndexNowDelivery(worker, { pageSize: 400 });
      expect(listed.stats).toEqual({ scanned: 1300, alreadyHasDelivery: 100, ineligible: 0, eligible: 1200 });
      expect(listed.candidates.map(c => c.articleId)).toEqual(articles.slice(100));
      const selection = await selectBackfillCandidates(worker, { pageSize: 400 });
      expect(selection.candidates).toHaveLength(1200);
    });

    it("apply on real tables: chunks go out, then ONE 422 stops the next chunk until a resume (stop condition (a)), all as worker_app", async () => {
      await novelRows(6, "app");
      const selection = await selectBackfillCandidates(worker);
      const manifest = buildBackfillManifest(selection.candidates, { releaseCommit: "b41-test", expectedCount: selection.candidates.length, note: "t" });
      const lines: Array<Record<string, unknown>> = [];
      const deps = { env: env as unknown as NodeJS.ProcessEnv, log: (l: Record<string, unknown>) => lines.push(l), waitForChunk: async () => { await scanAndDeliver(); } };

      statuses = [200, 422]; // chunk 0 accepted, chunk 1 → 422
      await expect(applyBackfill(worker, manifest, { write: true, offset: 0, chunkSize: 2 }, deps)).rejects.toThrow(/breaker is open/);
      expect(await owner.indexNowOutbox.count({ where: { source: "backfill" } })).toBe(4); // chunk 2 never enqueued
      expect(await owner.indexNowOutbox.count({ where: { source: "backfill", status: "accepted" } })).toBe(2);

      await resume("config verified");
      const rerun = await applyBackfill(worker, manifest, { write: true, offset: 0, chunkSize: 2 }, deps);
      expect(rerun).toMatchObject({ alreadyHasDeliveryUrls: 4, enqueuedUrls: 2 });
      expect(await owner.indexNowOutbox.count({ where: { source: "backfill", status: "accepted" } })).toBe(6);
    });

    it("the global summary (SQL aggregates under worker_app) sees breaker, 429 wait, ratio, failed task, dead letters and invalid-URL cancellations", async () => {
      await commitTrip();
      expect((await collectBackfillGlobalSummary(worker)).breakerOpen).toBe(true);
      await resume();
      const task = await owner.genericTask.create({ data: { taskType: deliveryType, requestToken: randomUUID(), operationScopeHash: "b".repeat(64), status: "failed" } });
      await owner.indexNowOutbox.createMany({ data: [
        { url: "https://indexnow.test/s/1", revision: 1n, eventType: "e", locale: "ko", source: "backfill", status: "accepted", deliveryTaskId: task.id },
        { url: "https://indexnow.test/s/2", revision: 1n, eventType: "e", locale: "ko", source: "backfill", status: "permanent_failed" },
        { url: "https://indexnow.test/s/3", revision: 1n, eventType: "e", locale: "ko", source: "publish", status: "dead_letter" },
        { url: "https://indexnow.test/s/4", revision: 1n, eventType: "e", locale: "ko", source: "publish", status: "cancelled", lastErrorKind: "url_invalid" },
      ] });
      const summary = await collectBackfillGlobalSummary(worker);
      expect(summary).toMatchObject({ breakerOpen: false, failedDeliveryTasks: 1, deadLetterUrls: 1, invalidUrlCancelledUrls: 1, backfillUrls: { total: 2, permanentFailed: 1, deadLetter: 0 } });
      expect(() => assertBackfillStopConditions(summary)).toThrow();
    });
  });

  // ------------------------------------------------- 7.11 control-state query plan
  describe("7.11 the control-state SQL uses operation_audit_entity_created_idx on ≥ 750k rows", () => {
    const planNodes = (node: any): any[] => [node, ...(node.Plans ?? []).flatMap(planNodes)];
    async function explain(label: string) {
      const json = await worker.$queryRawUnsafe<Array<{ "QUERY PLAN": any }>>(`EXPLAIN (ANALYZE, FORMAT JSON) ${INDEXNOW_CONTROL_STATE_SQL}`);
      const root = json[0]["QUERY PLAN"][0];
      const text = await worker.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(`EXPLAIN (ANALYZE, BUFFERS) ${INDEXNOW_CONTROL_STATE_SQL}`);
      console.log(`B41_EXPLAIN_BEGIN ${label}\n${text.map(r => r["QUERY PLAN"]).join("\n")}\nB41_EXPLAIN_END ${label}`);
      const nodes = planNodes(root.Plan);
      return { root, nodes, text: text.map(r => r["QUERY PLAN"]).join("\n") };
    }
    function assertPlan(result: Awaited<ReturnType<typeof explain>>) {
      const indexNames = result.nodes.map(n => n["Index Name"]).filter(Boolean);
      expect(indexNames).toContain("operation_audit_entity_created_idx");
      expect(result.nodes.some(n => n["Node Type"] === "Seq Scan" && n["Relation Name"] === "operation_audit")).toBe(false);
      expect(indexNames).not.toContain("operation_audit_pkey"); // no walk down the primary key
      // Write-shape guard: each stream is circled FIRST (its own materialized CTE whose only
      // scan is the entity index with the literal stream name as an index condition), and only
      // then is the newest event picked from that small set. A whole-table
      // `ORDER BY id DESC LIMIT 1` has no such CTEs. (On PG 16 with fresh OR missing statistics the
      // planner would still pick the entity index for that naive form, so the plan SHAPE, not
      // the planner's mood, is what pins the form.)
      for (const stream of ["breaker", "rate", "bisect"]) {
        const cte = result.nodes.find(n => n["Subplan Name"] === `CTE ${stream}`);
        expect(cte, `CTE ${stream} present`).toBeDefined();
        const scans = planNodes(cte).filter(n => n["Relation Name"] === "operation_audit");
        expect(scans.length).toBeGreaterThan(0);
        for (const scan of scans) {
          expect(scan["Index Name"]).toBe("operation_audit_entity_created_idx");
          expect(String(scan["Index Cond"])).toContain(stream === "rate" ? "'rate_limit'" : `'${stream}'`);
        }
      }
      expect(result.root["Execution Time"]).toBeLessThan(50);
    }
    const bulk = (rows: number, label: string) => owner.$executeRawUnsafe(`
      INSERT INTO operation_audit (actor_type, actor_id, action, entity_type, entity_id, reason, created_at)
      SELECT 'admin', '11111111-1111-4111-8111-111111111111', 'bulk.update',
        (ARRAY['Article','promo_link','site_setting','novel','credential','channel_account','indexnow_outbox'])[1 + (n % 7)],
        (n % 20011)::text, '${label}', now() - (n || ' seconds')::interval
      FROM generate_series(1, ${rows}) AS n`);

    it("(a) all three streams empty and (b) a few events sandwiched between bulk rows", async () => {
      await bulk(750_000, "bulk-1");
      await owner.$executeRawUnsafe("ANALYZE operation_audit");
      expect(Number((await owner.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM operation_audit`)[0].n)).toBeGreaterThanOrEqual(750_000);
      expect((await control()).breaker.open).toBe(false); // really empty
      assertPlan(await explain("scenario-a-empty-streams"));

      // events sandwiched between more bulk rows
      await commitTrip(); await bulk(25_000, "bulk-2");
      await resume(); await bulk(25_000, "bulk-3");
      await worker.$transaction(async tx => {
        await lockIndexNowControl(tx);
        await tx.operationAudit.create({ data: { actorType: "worker", action: INDEXNOW_CONTROL_ACTIONS.rateLimited, entityType: "indexnow_delivery", entityId: "rate_limit", afterSnapshot: { requestBatchId: "x", retryAfterMs: 0, waitUntil: new Date(Date.now() + 300_000).toISOString(), dbNow: new Date().toISOString() } } });
        await tx.operationAudit.create({ data: { actorType: "worker", action: INDEXNOW_CONTROL_ACTIONS.bisect, entityType: "indexnow_delivery", entityId: "bisect", afterSnapshot: { conclusion: "local" } } });
      });
      await bulk(25_000, "bulk-4"); await commitTrip(); await bulk(25_000, "bulk-5");
      await owner.$executeRawUnsafe("ANALYZE operation_audit");
      const state = await control();
      expect(state.breaker.open).toBe(true);
      expect(state.rateLimit.waiting).toBe(true);
      expect(state.lastBisect?.snapshot).toMatchObject({ conclusion: "local" });
      assertPlan(await explain("scenario-b-events-among-bulk-rows"));
    }, 300_000);
  });
});
