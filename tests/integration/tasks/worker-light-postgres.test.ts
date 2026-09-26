import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { buildSync } from "esbuild";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHandlerRegistry, enqueueScheduledTask, claimPendingItem, heartbeatTaskItem, finalizeTaskItem, recoverExpiredItem, enqueueSitemapRefresh } from "@/lib/tasks";
import { buildPeriodicSweepSchedule, SITEMAP_DAILY_FALLBACK_TASK_TYPE } from "@/lib/tasks/periodic-sweep";
import { createSitemapDailyFallbackHandler } from "../../../worker/handlers/sitemap-daily-fallback";

const enabled = process.env.WO5_DATABASE_TEST === "1";
const owner = new PrismaClient({ datasourceUrl: process.env.WO5_OWNER_DATABASE_URL });
const scheduler = new PrismaClient({ datasourceUrl: process.env.WO5_SCHEDULER_DATABASE_URL });
const worker = new PrismaClient({ datasourceUrl: process.env.WO5_WORKER_DATABASE_URL });
const type = SITEMAP_DAILY_FALLBACK_TASK_TYPE;
const registry = createHandlerRegistry({ [type]: { family: "generic", handler: async () => { throw new Error("scheduler must not execute"); } } });
const env = { ...process.env, FEATURE_SITEMAP_AUTO_REFRESH: "true", SITEMAP_AUTO_REFRESH_ALLOW_WRITE: "true", SITE_URL: "https://sitemap-test.example" };
const definition = (key = "daily-test") => buildPeriodicSweepSchedule({ scheduleKey: key, taskType: type, timezone: "UTC", cadence: { kind: "minute" } });
async function input(key = "daily-test") {
  const [clock] = await scheduler.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  const def = definition(key);
  return def.build(def.dueInstants(clock.now)[0]);
}
const claim = (taskTypes = [type], workerId = "light") => claimPendingItem(worker, { family: "generic", taskTypes, workerId, leaseMs: 30000 });
async function tickFallback() {
  const lease = (await claim())!;
  expect(lease).toBeTruthy();
  const outcome = await createSitemapDailyFallbackHandler(env)({ lease, mode: "apply", signal: new AbortController().signal, heartbeat: async () => true });
  await finalizeTaskItem(worker, lease, outcome);
}

async function publishedKoreanArticle(ordinal: number) {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const channel = await owner.channel.create({ data: { code: `sitemap-${suffix}`, name: "Sitemap fixture" } });
  const sourceApp = await owner.sourceApp.create({ data: { code: `sitemap-source-${suffix}`, name: "Sitemap source" } });
  const channelApp = await owner.channelApp.create({ data: {
    channelId: channel.id, sourceAppId: sourceApp.id, externalAppId: `sitemap-app-${suffix}`, projectType: 1,
  } });
  const account = await owner.channelAccount.create({ data: {
    channelId: channel.id, businessId: `sitemap-account-${suffix}`, accountName: "Sitemap account",
  } });
  const slug = `sitemap-ko-${ordinal}-${suffix}`;
  const novel = await owner.novel.create({ data: {
    businessId: `sitemap-book-${suffix}`, title: `Korean book ${ordinal}`, description: "Fixture",
    locale: "ko", slug, status: "published",
  } });
  const sourceItem = await owner.novelSourceItem.create({ data: {
    channelAppId: channelApp.id, novelId: novel.id, externalBookId: `source-${suffix}`,
    sourceLanguageCode: "ko", title: novel.title, description: "Fixture", status: "linked", rawPayload: {},
  } });
  const promoLink = await owner.promoLink.create({ data: {
    novelId: novel.id, novelSourceItemId: sourceItem.id, channelAppId: channelApp.id,
    channelAccountId: account.id, offerType: "upstream_existing",
    publicRedirectCode: `s${suffix}`, idempotencyKey: suffix.padEnd(64, "0"),
    webUrl: `https://promo.example/${suffix}`, status: "fetched",
  } });
  await owner.article.create({ data: {
    novelId: novel.id, promoLinkId: promoLink.id, locale: "ko", slug,
    publicPageShortId: suffix, title: novel.title, body: "Fixture", status: "published",
    publishedAt: new Date(),
  } });
  return `https://sitemap-test.example/ko/novel/${slug}-p${suffix}`;
}

describe.skipIf(!enabled).sequential("WO5 real roles, schedule isolation and worker load", () => {
  beforeAll(async () => {
    const [db] = await owner.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    if (!db.name.startsWith("cps_novel_wo5_")) throw new Error("unsafe test database");
    expect((await scheduler.$queryRaw<Array<{ role: string }>>`SELECT current_user AS role`)[0].role).toBe("scheduler_app");
    expect((await worker.$queryRaw<Array<{ role: string }>>`SELECT current_user AS role`)[0].role).toBe("worker_app");
  });
  beforeEach(async () => {
    await owner.$executeRawUnsafe('TRUNCATE generic_task, schedule_run CASCADE');
    await owner.siteSetting.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  });
  afterAll(async () => { await Promise.all([owner.$disconnect(), scheduler.$disconnect(), worker.$disconnect()]); });

  it("scheduler cannot read encrypted credentials", async () => {
    await expect(scheduler.$queryRaw`SELECT encrypted_secret FROM channel_account_credential LIMIT 1`).rejects.toThrow(/permission denied/);
  });
  it("deduplicates simultaneous scheduler ticks under the real scheduler role", async () => {
    const value = await input();
    const results = await Promise.all(Array.from({ length: 8 }, () => enqueueScheduledTask(scheduler, registry, value)));
    expect(results.filter(r => r.status === "enqueued")).toHaveLength(1);
    expect(results.filter(r => r.status === "duplicate")).toHaveLength(7);
    expect(await owner.genericTask.count()).toBe(1);
  });
  it.each(["pending", "processing"])("coalesces %s scans, persists reason and does not reenqueue a skipped bucket", async status => {
    await enqueueScheduledTask(scheduler, registry, await input("older"));
    await owner.genericTask.updateMany({ data: { status } });
    const value = await input("current");
    const result = await enqueueScheduledTask(scheduler, registry, value);
    expect(result).toMatchObject({ status: "skipped", skipReason: "previous_scan_in_flight" });
    expect(await owner.scheduleRun.findUnique({ where: { id: result.scheduleRunId } })).toMatchObject({ status: "skipped", skipReason: "previous_scan_in_flight" });
    await owner.genericTask.updateMany({ data: { status: "completed" } });
    expect((await enqueueScheduledTask(scheduler, registry, value)).status).toBe("duplicate");
    expect((await enqueueScheduledTask(scheduler, registry, await input("next"))).status).toBe("enqueued");
  });
  it("skips an expired minute instead of catching up", async () => {
    const value = await input(); value.scheduledFor = new Date(value.scheduledFor.getTime() - 60000);
    expect(await enqueueScheduledTask(scheduler, registry, value)).toMatchObject({ status: "skipped", skipReason: "misfire_skip" });
    expect(await owner.genericTask.count()).toBe(0);
  });
  it("admits a daily bucket nine minutes late, deduplicates and preserves in-flight coalescing", async () => {
    const value = await input();
    // Anchor to the real PostgreSQL clock; exact Tokyo times live in the unit suite.
    const bucket = new Date(value.scheduledFor.getTime() - 9 * 60000);
    const daily = buildPeriodicSweepSchedule({ scheduleKey: "daily-window", taskType: type, timezone: "UTC", cadence: { kind: "daily", hour: bucket.getUTCHours(), minute: bucket.getUTCMinutes() } });
    const first = await enqueueScheduledTask(scheduler, registry, daily.build(bucket));
    expect(first.status).toBe("enqueued");
    expect((await enqueueScheduledTask(scheduler, registry, daily.build(bucket))).status).toBe("duplicate");
    const concurrent = { ...daily.build(bucket), scheduleKey: "daily-other" };
    const skipped = await enqueueScheduledTask(scheduler, registry, concurrent);
    expect(skipped).toMatchObject({ status: "skipped", skipReason: "previous_scan_in_flight" });
    expect(await owner.scheduleRun.findUnique({ where: { id: skipped.scheduleRunId } })).toMatchObject({ status: "skipped", skipReason: "previous_scan_in_flight" });
    expect(await owner.genericTask.count()).toBe(1);
  });
  it("records an expired daily window as misfire_skip without creating tasks", async () => {
    const value = await input();
    const bucket = new Date(value.scheduledFor.getTime() - 20 * 60000);
    const daily = buildPeriodicSweepSchedule({ scheduleKey: "expired-daily", taskType: type, timezone: "UTC", cadence: { kind: "daily", hour: bucket.getUTCHours(), minute: bucket.getUTCMinutes() } });
    const result = await enqueueScheduledTask(scheduler, registry, daily.build(bucket));
    expect(result).toMatchObject({ status: "skipped", skipReason: "misfire_skip" });
    expect(await owner.scheduleRun.findUnique({ where: { id: result.scheduleRunId } })).toMatchObject({ status: "skipped", skipReason: "misfire_skip" });
    expect(await owner.genericTask.count()).toBe(0);
  });
  it("rejects a scan whose policy regresses to bounded catch-up", async () => {
    const value = await input(); value.misfirePolicy = "bounded_catch_up";
    await expect(enqueueScheduledTask(scheduler, registry, value)).rejects.toThrow("periodic_sweep_requires_skip");
  });
  it("scheduler creates only a control task; real worker enqueues the refresh", async () => {
    await enqueueScheduledTask(scheduler, registry, await input());
    expect((await owner.genericTask.findMany()).map(t => t.taskType)).toEqual([type]);
    await tickFallback();
    expect(await owner.genericTask.findFirst({ where: { taskType: "sitemap_refresh" } })).toMatchObject({ params: { reason: "daily_fallback" } });
  });
  it("fallback coalesces a processing refresh and sets its follow-up marker", async () => {
    await enqueueSitemapRefresh({ reason: "manual", triggeredBy: "fixture" }, worker, { env });
    expect(await claim(["sitemap_refresh"])).toBeTruthy();
    await enqueueScheduledTask(scheduler, registry, await input());
    await tickFallback();
    expect(await owner.genericTask.count({ where: { taskType: "sitemap_refresh" } })).toBe(1);
    expect(await owner.genericTask.findFirst({ where: { taskType: "sitemap_refresh" } })).toMatchObject({ params: { followUpRequested: true } });
  });
  it("identities fence heartbeats and finalization, and recovery respects each lane", async () => {
    await enqueueScheduledTask(scheduler, registry, await input());
    const lease = (await claim())!;
    expect(await heartbeatTaskItem(worker, { ...lease, workerId: "main" }, 30000)).toBe(false);
    expect(await heartbeatTaskItem(worker, lease, 30000)).toBe(true);
    await expect(finalizeTaskItem(worker, { ...lease, workerId: "main" }, { status: "success" })).rejects.toThrow();
    await owner.genericTaskItem.update({ where: { id: lease.itemId }, data: { lockedUntil: new Date(0) } });
    expect(await recoverExpiredItem(worker, { family: "generic", taskTypes: ["promo_link.claim.v1"], maxAttemptsByType: {}, workerId: "main" })).toBeNull();
    expect(await recoverExpiredItem(worker, { family: "generic", taskTypes: [type], maxAttemptsByType: { [type]: 3 }, workerId: "light-2" })).toBeTruthy();
    expect(await heartbeatTaskItem(worker, lease, 30000)).toBe(false);
    await expect(finalizeTaskItem(worker, lease, { status: "success" })).rejects.toThrow();
    const next = (await claim([type], "light-2"))!;
    expect(next.workerId).toBe("light-2");
    expect(next.leaseEpoch).toBeGreaterThan(lease.leaseEpoch);
  });
  it("light refresh completes in one 1000 ms polling interval behind 20000 claim items", async () => {
    await mkdir(".tmp", { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/wo5-load-"));
    await publishedKoreanArticle(1);
    const output = path.join(root, "worker.cjs");
    buildSync({ entryPoints: ["tests/integration/tasks/fixtures/light-lane-worker.ts"], outfile: output, bundle: true, platform: "node", format: "cjs", packages: "external", logLevel: "silent" });
    let requests = 0;
    const server = createServer((_req, res) => { requests++; setTimeout(() => { res.end('{}'); }, 200); });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address() as { port: number };
    const children: ChildProcess[] = [];
    try {
      const task = await owner.genericTask.create({ data: { taskType: "promo_link.claim.v1", requestToken: randomUUID(), operationScopeHash: "a".repeat(64), totalCount: 20000, createdAt: new Date(0) } });
      await owner.$executeRaw`INSERT INTO generic_task_item(id, task_id, target_type, target_id, payload, created_at, updated_at)
        SELECT gen_random_uuid(), ${task.id}::uuid, 'novel_source_item', n::text, '{}'::jsonb, '2020-01-01'::timestamptz, now() FROM generate_series(1,20000) n`;
      for (const lane of ["main", "light"]) {
        const child = fork(output, [], { stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...env,
          DATABASE_URL: process.env.WO5_WORKER_DATABASE_URL, WORKER_ID: lane,
          WORKER_TASK_ALLOWLIST: lane === "main" ? "promo_link.claim.v1" : "sitemap_refresh",
          SITEMAP_STATIC_DIR: path.join(root, "sitemaps"), WO5_MOCK_UPSTREAM: `http://127.0.0.1:${address.port}` } });
        children.push(child);
        child.stderr?.on("data", data => process.stderr.write(data));
        await once(child, "message");
      }
      children[0].send({ start: true });
      const deadline = Date.now() + 5000;
      while (!requests && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
      expect(requests).toBeGreaterThan(0);
      const queued = await enqueueSitemapRefresh({ reason: "load", triggeredBy: "test" }, worker, { env });
      if (queued.status !== "queued") throw new Error("refresh not queued");
      children[1].send({ start: true });
      let done;
      while (Date.now() < deadline) {
        done = await owner.genericTaskItem.findFirst({ where: { taskId: queued.taskId } });
        if (done?.status === "success") break;
        await new Promise(r => setTimeout(r, 10));
      }
      expect(done?.status).toBe("success");
      const refresh = (await owner.genericTask.findUnique({ where: { id: queued.taskId } }))!;
      const waitMs = refresh.startedAt!.getTime() - refresh.createdAt.getTime();
      const totalMs = done!.finishedAt!.getTime() - refresh.createdAt.getTime();
      const remaining = await owner.genericTaskItem.count({ where: { taskId: task.id, status: "pending" } });
      console.log(`WO5_PRESSURE wait_ms=${waitMs} execution_ms=${totalMs - waitMs} total_ms=${totalMs} poll_ms=1000 remaining=${remaining} upstream_calls=${requests}`);
      expect(waitMs).toBeLessThanOrEqual(1000); expect(totalMs).toBeLessThanOrEqual(1000); expect(remaining).toBeGreaterThan(19000);
      expect((await readdir(path.join(root, "sitemaps"))).length).toBeGreaterThan(0);
    } finally {
      await Promise.all(children.map(async child => { const ended = once(child, "exit"); child.kill("SIGTERM"); await ended; }));
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
