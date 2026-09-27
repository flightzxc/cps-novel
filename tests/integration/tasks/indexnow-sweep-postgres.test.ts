import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { applyPublishTransition } from "@/server/publish-gate/service";
import { buildIndexNowSweepSchedule, INDEXNOW_SWEEP_TASK_TYPE } from "@/lib/tasks/indexnow-sweep";
import { runSchedulerOnce, enqueueScheduledTask, createHandlerRegistry, enqueueSitemapRefresh, claimPendingItem, finalizeTaskItem } from "@/lib/tasks";
import { sweepDueIndexNowDeliveries } from "@/lib/indexnow/sweep";
import { INDEXNOW_PROCESSING_STALE_MS } from "@/lib/indexnow/outbox-contract";
import { SCHEDULER_HANDLERS, SCHEDULES } from "../../../scheduler";
import { createWorkerHandlers, resolveWorkerStartupAllowlist } from "../../../worker";
import { createIndexNowWorkerHandlers } from "../../../worker/handlers/indexnow-delivery";
import { createIndexNowSweepHandler } from "../../../worker/handlers/indexnow-sweep";
import { createSitemapRefreshWorkerHandlers } from "../../../worker/handlers/sitemap-refresh";
import { runWorker } from "../../../worker/runtime/worker";

vi.mock("@/server/publication/revalidate", () => ({ revalidatePublicArticlePaths: vi.fn(), revalidatePublicArticleSet: vi.fn(), revalidatePublicBlogPaths: vi.fn() }));
const enabled = process.env.WO6_DATABASE_TEST === "1";
const owner = new PrismaClient({ datasourceUrl: process.env.WO6_OWNER_DATABASE_URL });
const web = new PrismaClient({ datasourceUrl: process.env.WO6_WEB_DATABASE_URL });
const worker = new PrismaClient({ datasourceUrl: process.env.WO6_WORKER_DATABASE_URL });
const scheduler = new PrismaClient({ datasourceUrl: process.env.WO6_SCHEDULER_DATABASE_URL });
const env = { NODE_ENV: "test", SITE_URL: "https://indexnow.test", FEATURE_INDEXNOW_OUTBOX: "true", INDEXNOW_OUTBOX_ALLOW_WRITE: "true",
  FEATURE_INDEXNOW_DELIVERY: "true", INDEXNOW_DELIVERY_ALLOW_WRITE: "true", FEATURE_SITEMAP_AUTO_REFRESH: "false", SITEMAP_AUTO_REFRESH_ALLOW_WRITE: "false" } as const;
const scanType = INDEXNOW_SWEEP_TASK_TYPE;
const deliveryType = "indexnow_delivery";
const lightTypes = `${scanType},${deliveryType},sitemap_refresh,sitemap.daily_fallback.v1`;
let root: string;
let endpoint: string;
let statuses: Array<number | "timeout"> = [];
let requests: Array<{ at: number; body: Record<string, unknown> }> = [];
let claimCalls = 0;
let executed: Array<{ taskId: string; workerId: string }> = [];
const loops: Array<{ controller: AbortController; finished: Promise<void>; errors: unknown[] }> = [];
const server = createServer(async (req, res) => {
  if (req.url === "/claim") { claimCalls++; setTimeout(() => res.end("{}"), 200); return; }
  let body = "";
  for await (const part of req) body += part;
  requests.push({ at: Date.now(), body: JSON.parse(body) });
  const status = statuses.shift() ?? 200;
  if (status === "timeout") return;
  res.statusCode = status;
  if (status === 429) res.setHeader("Retry-After", "1");
  res.end("local indexnow fixture");
});
async function until(predicate: () => Promise<boolean> | boolean, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const loop of loops) if (loop.errors.length) throw loop.errors[0];
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("WO6 condition timed out");
}
function startWorker(types = lightTypes, lane: "main" | "light" = "light", completed?: (taskId: string) => void) {
  const handlers = createHandlerRegistry({
    ...createWorkerHandlers(worker),
    ...createIndexNowWorkerHandlers(worker, (_url, init) => fetch(endpoint, init)),
    ...createSitemapRefreshWorkerHandlers(worker, { rootDir: path.join(root, "sitemaps"), env: { ...env, FEATURE_SITEMAP_AUTO_REFRESH: "true", SITEMAP_AUTO_REFRESH_ALLOW_WRITE: "true" } }),
    "promo_link.claim.v1": { family: "generic", handler: async () => {
      await fetch(`${endpoint}/claim`); return { status: "success" };
    } },
  });
  const observed = createHandlerRegistry(Object.fromEntries(Object.entries(handlers).map(([type, handler]) => [type, { ...handler,
    handler: async context => { executed.push({ taskId: context.lease.taskId, workerId: context.lease.workerId }); return handler.handler(context); },
    afterItemCommit: async (id: string) => { await handler.afterItemCommit?.(id); completed?.(id); },
  }])));
  const allowlist = resolveWorkerStartupAllowlist(types, observed, { info() {}, error() {} }, lane);
  const controller = new AbortController(); const errors: unknown[] = [];
  const finished = runWorker({ prisma: worker, handlers: observed, allowlist, lane, workerId: `wo6-${lane}`,
    pollMs: 1000, signal: controller.signal }).catch(error => { errors.push(error); });
  const loop = { controller, finished, errors }; loops.push(loop); return loop;
}
async function stopWorkers() {
  for (const loop of loops) loop.controller.abort();
  await Promise.all(loops.map(loop => loop.finished));
  const errors = loops.flatMap(loop => loop.errors); loops.length = 0;
  if (errors.length) throw errors[0];
}
async function publish() {
  const suffix = randomUUID().replaceAll("-", "");
  const channel = await owner.channel.create({ data: { code: suffix, name: "local" } });
  const app = await owner.sourceApp.create({ data: { code: suffix, name: "local" } });
  const channelApp = await owner.channelApp.create({ data: { channelId: channel.id, sourceAppId: app.id, externalAppId: suffix, projectType: 1 } });
  const account = await owner.channelAccount.create({ data: { channelId: channel.id, businessId: suffix, accountName: "local" } });
  const novel = await owner.novel.create({ data: { businessId: suffix, title: "WO6 fixture", description: "fixture", locale: "ko", slug: suffix, status: "ready" } });
  const source = await owner.novelSourceItem.create({ data: { channelAppId: channelApp.id, novelId: novel.id, externalBookId: suffix,
    sourceLanguageCode: "ko", title: novel.title, description: "fixture", rawPayload: {}, status: "linked" } });
  const promo = await owner.promoLink.create({ data: { novelId: novel.id, novelSourceItemId: source.id, channelAppId: channelApp.id,
    channelAccountId: account.id, offerType: "read", publicRedirectCode: suffix, idempotencyKey: suffix.padEnd(64, "0"), webUrl: "https://promo.test/book", status: "fetched" } });
  const article = await owner.article.create({ data: { novelId: novel.id, promoLinkId: promo.id, locale: "ko", slug: suffix,
    publicPageShortId: suffix.slice(0, 12), title: novel.title, body: "fixture", status: "draft" } });
  expect(await applyPublishTransition(web, { articleId: article.id, requestId: randomUUID(), actor: { type: "system", source: "wo6-test" } })).toMatchObject({ outcome: "published" });
  const row = await owner.indexNowOutbox.findFirstOrThrow({ where: { articleId: article.id } });
  expect(await owner.genericTaskItem.count({ where: { taskId: row.deliveryTaskId! } })).toBe(1);
  return row;
}
async function tick(unique = false) {
  const definition = SCHEDULES.find(s => s.scheduleKey === "indexnow.sweep")!;
  // Unique schedule identity lets independent ticks exercise fresh DB due states
  // without waiting a minute. Same-bucket/in-flight semantics are tested separately.
  if (!unique) return runSchedulerOnce(scheduler, SCHEDULER_HANDLERS, [definition]);
  const key = `wo6-${randomUUID()}`;
  return runSchedulerOnce(scheduler, SCHEDULER_HANDLERS, [{ ...definition, scheduleKey: key,
    build: date => ({ ...definition.build(date), scheduleKey: key }) }]);
}
async function scanResult(taskId: string) {
  await until(async () => (await owner.genericTaskItem.findFirst({ where: { taskId } }))?.status === "success");
  return (await owner.genericTaskItem.findFirstOrThrow({ where: { taskId } })).result;
}
async function accepted(id: string) { await until(async () => (await owner.indexNowOutbox.findUniqueOrThrow({ where: { id } })).status === "accepted"); }

describe.skipIf(!enabled).sequential("WO6 real publication, scheduler, lanes and HTTP", () => {
  beforeAll(async () => {
    expect((await owner.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`)[0].name).toMatch(/^cps_novel_wo6_/);
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    await mkdir(".tmp", { recursive: true }); root = await mkdtemp(path.resolve(".tmp/wo6-http-"));
    server.listen(0, "127.0.0.1"); await once(server, "listening"); endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  beforeEach(async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    await owner.$executeRawUnsafe("TRUNCATE generic_task, schedule_run, article, novel CASCADE");
    statuses = []; requests = []; claimCalls = 0; executed = [];
    await owner.siteSetting.upsert({ where: { id: 1 }, create: { id: 1, indexNowHost: "indexnow.test", indexNowKey: "wo6-local-test-key", indexNowKeyLocation: "https://indexnow.test/indexnow-key.txt" },
      update: { indexNowHost: "indexnow.test", indexNowKey: "wo6-local-test-key", indexNowKeyLocation: "https://indexnow.test/indexnow-key.txt" } });
  });
  afterEach(stopWorkers);
  afterAll(async () => {
    await stopWorkers(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await Promise.all([owner.$disconnect(), web.$disconnect(), worker.$disconnect(), scheduler.$disconnect()]);
    if (root) await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs();
  });
  it("uses actual roles and keeps scheduler out of outbox and secrets", async () => {
    for (const [db, role] of [[scheduler, "scheduler_app"], [worker, "worker_app"], [web, "web_app"]] as const) {
      expect((await db.$queryRaw<Array<{ role: string }>>`SELECT current_user AS role`)[0].role).toBe(role);
    }
    await expect(scheduler.$queryRaw`SELECT status FROM indexnow_outbox LIMIT 1`).rejects.toThrow(/permission denied/);
    await expect(scheduler.$queryRaw`SELECT encrypted_secret FROM channel_account_credential LIMIT 1`).rejects.toThrow(/permission denied/);
    await expect(scheduler.$queryRaw`SELECT indexnow_key FROM site_setting LIMIT 1`).rejects.toThrow(/permission denied/);
  });
  it("deduplicates simultaneous real scheduler ticks", async () => {
    const results = (await Promise.all(Array.from({ length: 6 }, () => tick()))).flat();
    expect(results.filter(r => r.status === "enqueued")).toHaveLength(1);
    expect(results.filter(r => r.status === "duplicate")).toHaveLength(5);
  });
  it.each(["pending", "processing"])("merges %s control tasks", async status => {
    await tick(); await owner.genericTask.updateMany({ data: { status } });
    expect((await tick(true))[0]).toMatchObject({ status: "skipped", skipReason: "previous_scan_in_flight" });
    expect(await owner.genericTask.count()).toBe(1);
  });
  it("skips an expired minute under scheduler_app", async () => {
    const now = (await scheduler.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0].now;
    const definition = buildIndexNowSweepSchedule();
    const value = definition.build(new Date(Math.floor(now.getTime() / 60000) * 60000 - 60000));
    expect(await enqueueScheduledTask(scheduler, SCHEDULER_HANDLERS, value)).toMatchObject({ status: "skipped", skipReason: "misfire_skip" });
    expect(await owner.genericTask.count()).toBe(0);
  });
  it.each([["false", "false"], ["true", "false"], ["false", "true"]])("closed %s/%s produces no schedule or sweep writes", async (feature, write) => {
    const row = await publish();
    vi.stubEnv("FEATURE_INDEXNOW_DELIVERY", feature); vi.stubEnv("INDEXNOW_DELIVERY_ALLOW_WRITE", write);
    expect(await tick()).toEqual([]);
    expect(await sweepDueIndexNowDeliveries(worker)).toEqual({ recovered: 0, swept: 0, skippedAlreadyLive: 0 });
    expect(await owner.scheduleRun.count()).toBe(0);
    expect(await owner.genericTask.count()).toBe(1);
    expect(await owner.indexNowOutbox.findUnique({ where: { id: row.id } })).toEqual(row);
    expect(requests).toHaveLength(0);
  });
  it("published first delivery is deduplicated by scan and sent by light with exact protocol", async () => {
    const row = await publish(); const [scheduled] = await tick();
    startWorker(scanType);
    expect(await scanResult(scheduled.taskId!)).toMatchObject({ recovered: 0, swept: 0, skippedAlreadyLive: 1 });
    await stopWorkers(); startWorker(); await accepted(row.id);
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toEqual({ host: "indexnow.test", key: "wo6-local-test-key", keyLocation: "https://indexnow.test/indexnow-key.txt", urlList: [row.url] });
    expect(executed).toContainEqual({ taskId: row.deliveryTaskId, workerId: "wo6-light" });
  });
  it.each([429, 500, 503])("%s retries only after due scan creates a new delivery", async code => {
    const row = await publish(); statuses = [code, 200]; startWorker();
    await until(async () => (await owner.indexNowOutbox.findUniqueOrThrow({ where: { id: row.id } })).status === "retry_wait");
    await stopWorkers();
    const retry = await owner.indexNowOutbox.findUniqueOrThrow({ where: { id: row.id } });
    const attempt = await owner.indexNowOutboxAttempt.findFirstOrThrow({ where: { outboxId: row.id } });
    const delay = retry.nextAttemptAt!.getTime() - attempt.responseAt!.getTime();
    expect(delay).toBeGreaterThanOrEqual(300000); expect(delay).toBeLessThan(360000);
    console.log(`WO6_RETRY http=${code} delay_ms=${delay} attempt=1`);
    const [notDue] = await tick(); startWorker(scanType);
    expect(await scanResult(notDue.taskId!)).toMatchObject({ swept: 0 }); await stopWorkers();
    expect(requests).toHaveLength(1);
    // Accelerate fixture time only, after validating the genuine backoff above.
    await owner.indexNowOutbox.update({ where: { id: row.id }, data: { nextAttemptAt: new Date(0) } });
    const [due] = await tick(true); startWorker();
    expect(await scanResult(due.taskId!)).toMatchObject({ swept: 1 }); await accepted(row.id);
    const final = await owner.indexNowOutbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(final.deliveryTaskId).not.toBe(row.deliveryTaskId); expect(final.attemptCount).toBe(2);
    expect(requests).toHaveLength(2);
  });
  it.each([403, 422])("%s is terminal and later scans never retry", async code => {
    const row = await publish(); statuses = [code]; startWorker();
    await until(async () => (await owner.indexNowOutbox.findUniqueOrThrow({ where: { id: row.id } })).status === "permanent_failed");
    await stopWorkers(); const [scheduled] = await tick(); startWorker();
    expect(await scanResult(scheduled.taskId!)).toMatchObject({ swept: 0 });
    expect(requests).toHaveLength(1);
    expect(await owner.indexNowOutbox.findUnique({ where: { id: row.id } })).toMatchObject({ nextAttemptAt: null, attemptCount: 1 });
  });
  it("recovers stale processing and delivers the unknown outcome again", async () => {
    const row = await publish();
    await owner.genericTaskItem.updateMany({ data: { status: "failed" } });
    await owner.genericTask.updateMany({ data: { status: "failed" } });
    const old = new Date(Date.now() - INDEXNOW_PROCESSING_STALE_MS - 60000);
    await owner.indexNowOutboxAttempt.create({ data: { outboxId: row.id, attemptNo: 1, outcome: "started", attemptState: "started", requestBatchId: randomUUID(), batchSize: 1, startedAt: old, requestAt: old } });
    await owner.indexNowOutbox.update({ where: { id: row.id }, data: { status: "processing", attemptCount: 1, updatedAt: old } });
    const [scheduled] = await tick(); startWorker();
    expect(await scanResult(scheduled.taskId!)).toMatchObject({ recovered: 1, swept: 1 }); await accepted(row.id);
    expect(await owner.indexNowOutboxAttempt.findFirst({ where: { outboxId: row.id, attemptNo: 1 } })).toMatchObject({ attemptState: "unknown_outcome" });
  });
  it("fences scan writes when its lease ownership is stale", async () => {
    await tick();
    const lease = (await claimPendingItem(worker, { family: "generic", taskTypes: [scanType], workerId: "wo6-light", leaseMs: 30000 }))!;
    const outcome = await createIndexNowSweepHandler()({ lease, mode: "apply", signal: new AbortController().signal, heartbeat: async () => true });
    await expect(finalizeTaskItem(worker, { ...lease, executionToken: randomUUID() }, outcome)).rejects.toThrow();
    expect(await owner.genericTaskItem.count()).toBe(1);
  });
  it("limits due work to 200 and empty outbox still admits recovery scans", async () => {
    const [empty] = await tick(); startWorker(scanType); expect(await scanResult(empty.taskId!)).toMatchObject({ swept: 0 }); await stopWorkers();
    await owner.indexNowOutbox.createMany({ data: Array.from({ length: 205 }, (_, i) => ({ url: `https://indexnow.test/${i}`, revision: 1n, eventType: "first_public_publish", locale: "ko", source: "fixture" })) });
    const [full] = await tick(true); startWorker(scanType);
    expect(await scanResult(full.taskId!)).toMatchObject({ swept: 200 });
    expect(await owner.genericTask.count({ where: { taskType: deliveryType } })).toBe(200);
  });
  it("main backlog of 20000 claims does not delay light delivery beyond a polling cycle", async () => {
    const task = await owner.genericTask.create({ data: { taskType: "promo_link.claim.v1", requestToken: randomUUID(), operationScopeHash: "a".repeat(64), totalCount: 20000, createdAt: new Date(0) } });
    await owner.$executeRaw`INSERT INTO generic_task_item(id, task_id, target_type, target_id, payload, created_at, updated_at)
      SELECT gen_random_uuid(), ${task.id}::uuid, 'novel_source_item', n::text, '{}'::jsonb, '2020-01-01'::timestamptz, now() FROM generate_series(1,20000) n`;
    startWorker("promo_link.claim.v1", "main"); startWorker();
    await until(() => claimCalls > 0);
    const row = await publish(); await accepted(row.id);
    const delivery = await owner.genericTask.findUniqueOrThrow({ where: { id: row.deliveryTaskId! } });
    const wait = delivery.startedAt!.getTime() - delivery.createdAt.getTime();
    const http = requests[0].at - delivery.createdAt.getTime();
    const remaining = await owner.genericTaskItem.count({ where: { taskId: task.id, status: "pending" } });
    console.log(`WO6_PRESSURE wait_ms=${wait} http_ms=${http} poll_ms=1000 remaining=${remaining} main_calls=${claimCalls}`);
    expect(wait).toBeLessThanOrEqual(1200); expect(http).toBeLessThanOrEqual(1250); expect(remaining).toBeGreaterThan(19000);
  });
  it("alternates delivery backlog with actual sitemap and sweep without starvation", async () => {
    const row = await publish();
    // Distinct revisions on one eligible URL represent already queued publication backlog.
    const base = await owner.indexNowOutbox.findUniqueOrThrow({ where: { id: row.id } });
    const { createIndexNowDeliveryTaskItem } = await import("@/lib/indexnow/outbox");
    for (let i = 0; i < 300; i++) {
      const next = await owner.indexNowOutbox.create({ data: { articleId: base.articleId, url: base.url, revision: BigInt(i + 1), eventType: "first_public_publish", locale: "ko", source: "fixture" } });
      await createIndexNowDeliveryTaskItem(owner, next.id, { reason: "load", triggeredBy: "test" });
    }
    const refresh = await enqueueSitemapRefresh({ reason: "wo6-load", triggeredBy: "test" }, worker, { env: { ...env, FEATURE_SITEMAP_AUTO_REFRESH: "true", SITEMAP_AUTO_REFRESH_ALLOW_WRITE: "true" } });
    if (refresh.status !== "queued") throw new Error("refresh not queued");
    const [scan] = await tick();
    const order: string[] = [];
    startWorker(lightTypes, "light", id => order.push(id));
    await until(() => order.includes(scan.taskId!));
    expect(order[0]).toBe(refresh.taskId); expect(order[1]).toBe(row.deliveryTaskId); expect(order[2]).toBe(scan.taskId);
    expect(requests.length).toBeGreaterThan(0); expect(requests.length).toBeLessThan(301);
    expect((await readdir(path.join(root, "sitemaps"))).length).toBeGreaterThan(0);
    console.log(`WO6_FAIRNESS scan_completion_position=${order.indexOf(scan.taskId!) + 1} delivered_before_scan=${requests.length} backlog=301`);
  });
  it("real 10 second timeout yields to a newly queued sitemap then retries via scan", async () => {
    const row = await publish(); statuses = ["timeout", 200]; startWorker(); await until(() => requests.length === 1);
    const queuedAt = Date.now();
    const refresh = await enqueueSitemapRefresh({ reason: "timeout", triggeredBy: "test" }, worker, { env: { ...env, FEATURE_SITEMAP_AUTO_REFRESH: "true", SITEMAP_AUTO_REFRESH_ALLOW_WRITE: "true" } });
    if (refresh.status !== "queued") throw new Error("refresh not queued");
    await until(async () => (await owner.genericTaskItem.findFirst({ where: { taskId: refresh.taskId } }))?.status === "success", 14000);
    const waited = Date.now() - queuedAt;
    const retry = await owner.indexNowOutbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(retry).toMatchObject({ status: "retry_wait", lastErrorKind: "timeout" }); expect(waited).toBeGreaterThan(9000); expect(waited).toBeLessThan(13000);
    console.log(`WO6_TIMEOUT sitemap_wait_ms=${waited} http_timeout_ms=10000`);
    await stopWorkers(); await owner.indexNowOutbox.update({ where: { id: row.id }, data: { nextAttemptAt: new Date(0) } });
    await tick(); startWorker(); await accepted(row.id);
  }, 20000);
});
