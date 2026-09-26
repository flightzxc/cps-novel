import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  claimPendingItem,
  enqueueSitemapRefresh,
  finalizeTaskItem,
  recoverExpiredItem,
  SITEMAP_REFRESH_OPERATION_SCOPE_HASH,
  SITEMAP_REFRESH_TASK_TYPE,
  type TaskLease,
} from "@/lib/tasks";
import { generateStaticSitemaps } from "@/lib/seo/static-sitemap-generator";
import { refreshStaticSitemap } from "@/lib/seo/sitemap-refresh-state";
import { createSitemapRefreshHandler } from "../../../worker/handlers/sitemap-refresh";

const enabled = process.env.SITEMAP_REFRESH_DATABASE_TEST === "1";
const owner = new PrismaClient({ datasourceUrl: process.env.SITEMAP_REFRESH_OWNER_DATABASE_URL });
const web = new PrismaClient({ datasourceUrl: process.env.SITEMAP_REFRESH_WEB_DATABASE_URL });
const worker = new PrismaClient({ datasourceUrl: process.env.SITEMAP_REFRESH_WORKER_DATABASE_URL });
const enabledEnv = {
  ...process.env,
  FEATURE_SITEMAP_AUTO_REFRESH: "true",
  SITEMAP_AUTO_REFRESH_ALLOW_WRITE: "true",
};
const trigger = { reason: "article_first_publish", triggeredBy: "publish-gate" };
const roots: string[] = [];

async function resetDatabase() {
  const [{ name, version }] = await owner.$queryRaw<Array<{ name: string; version: string }>>`
    SELECT current_database() AS name, current_setting('server_version') AS version
  `;
  if (!name.startsWith("cps_novel_sitemap_refresh_") || !version.startsWith("16.14")) {
    throw new Error(`Refusing sitemap test setup against ${name} (${version})`);
  }
  const tables = await owner.$queryRawUnsafe<Array<{ tablename: string }>>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `);
  await owner.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map(({ tablename }) => `"${tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await owner.siteSetting.create({ data: { id: 1 } });
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

async function rootDir() {
  const root = await mkdtemp(path.join(tmpdir(), "cps-novel-sitemap-pg-"));
  roots.push(root);
  return root;
}

function handler(root: string) {
  return createSitemapRefreshHandler(worker, {
    rootDir: root,
    env: enabledEnv,
    refresh: (options) => refreshStaticSitemap({
      ...options,
      generate: (generation) => generateStaticSitemaps({
        ...generation, types: ["novelpage"], routeLocales: ["ko"],
      }),
    }),
  });
}

function context(lease: TaskLease) {
  return {
    lease,
    mode: lease.mode,
    signal: new AbortController().signal,
    heartbeat: async () => true,
  };
}

function standaloneLease(): TaskLease {
  return {
    family: "generic", taskType: SITEMAP_REFRESH_TASK_TYPE, mode: "apply",
    taskId: randomUUID(), itemId: randomUUID(), workerId: "sitemap-test",
    executionToken: randomUUID(), leaseEpoch: 1n, attemptCount: 1,
    lockedUntil: new Date(Date.now() + 60_000), payload: trigger,
  };
}

async function claim(): Promise<TaskLease> {
  const lease = await claimPendingItem(worker, {
    family: "generic", taskTypes: [SITEMAP_REFRESH_TASK_TYPE], workerId: "sitemap-test", leaseMs: 120_000,
  });
  expect(lease).not.toBeNull();
  return lease!;
}

async function xml(root: string) {
  return readFile(path.join(root, "current", "sitemap", "site_novelpage_ko.xml"), "utf8");
}

async function scopedTasks() {
  return owner.genericTask.findMany({
    where: { taskType: SITEMAP_REFRESH_TASK_TYPE, operationScopeHash: SITEMAP_REFRESH_OPERATION_SCOPE_HASH },
    orderBy: { createdAt: "asc" },
  });
}

describe.skipIf(!enabled).sequential("sitemap refresh on disposable PostgreSQL 16.14", () => {
  beforeAll(() => { process.env.SITE_URL = "https://sitemap-test.example"; });
  beforeEach(resetDatabase);
  afterAll(async () => {
    await Promise.all([owner.$disconnect(), web.$disconnect(), worker.$disconnect()]);
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    delete process.env.SITE_URL;
  });

  it("re-queries candidates on two runs of one handler and promotes the second article into XML", async () => {
    const root = await rootDir();
    const run = handler(root);
    const firstUrl = await publishedKoreanArticle(1);
    expect((await run(context(standaloneLease()))).status).toBe("success");
    expect(await xml(root)).toContain(firstUrl);
    const secondUrl = await publishedKoreanArticle(2);
    expect((await run(context(standaloneLease()))).status).toBe("success");
    const secondXml = await xml(root);
    expect(secondXml).toContain(firstUrl);
    expect(secondXml).toContain(secondUrl);
  });

  it("covers processing-time publications with exactly one queued follow-up", async () => {
    const root = await rootDir();
    const run = handler(root);
    const firstUrl = await publishedKoreanArticle(1);
    expect((await enqueueSitemapRefresh(trigger, web, { env: enabledEnv })).status).toBe("queued");
    const firstLease = await claim();
    const firstOutcome = await run(context(firstLease));
    expect(firstOutcome.status).toBe("success");
    expect(await xml(root)).toContain(firstUrl);

    const secondUrl = await publishedKoreanArticle(2);
    for (let index = 0; index < 5; index += 1) {
      expect((await enqueueSitemapRefresh(trigger, web, { env: enabledEnv })).status).toBe("coalesced");
    }
    expect((await scopedTasks()).filter(({ status }) => status === "pending")).toHaveLength(0);
    await finalizeTaskItem(worker, firstLease, firstOutcome);
    const afterFirst = await scopedTasks();
    expect(afterFirst).toHaveLength(2);
    expect(afterFirst.filter(({ status }) => status === "pending")).toHaveLength(1);
    expect(afterFirst[0]!.params).toMatchObject({ followUpRequested: true });

    const secondLease = await claim();
    const secondOutcome = await run(context(secondLease));
    expect(secondOutcome.status).toBe("success");
    await finalizeTaskItem(worker, secondLease, secondOutcome);
    expect(await xml(root)).toContain(secondUrl);
    expect(await scopedTasks()).toHaveLength(2);
    expect((await scopedTasks()).filter(({ status }) => status === "pending")).toHaveLength(0);
  });

  it("runs no follow-up when processing received no new trigger", async () => {
    expect((await enqueueSitemapRefresh(trigger, web, { env: enabledEnv })).status).toBe("queued");
    const lease = await claim();
    await finalizeTaskItem(worker, lease, { status: "success" });
    expect(await scopedTasks()).toHaveLength(1);
  });

  it("keeps the follow-up marker across an ordinary retry", async () => {
    expect((await enqueueSitemapRefresh(trigger, web, { env: enabledEnv })).status).toBe("queued");
    const firstLease = await claim();
    expect((await enqueueSitemapRefresh(trigger, web, { env: enabledEnv })).status).toBe("coalesced");
    await finalizeTaskItem(worker, firstLease, { status: "retry", error: { code: "temporary", message: "retry" } });
    expect(await scopedTasks()).toHaveLength(1);
    const secondLease = await claim();
    await finalizeTaskItem(worker, secondLease, { status: "success" });
    expect((await scopedTasks()).filter(({ status }) => status === "pending")).toHaveLength(1);
  });

  it("preserves the follow-up when an expired processing lease ends terminally", async () => {
    expect((await enqueueSitemapRefresh(trigger, web, { env: enabledEnv })).status).toBe("queued");
    const lease = await claim();
    expect((await enqueueSitemapRefresh(trigger, web, { env: enabledEnv })).status).toBe("coalesced");
    await owner.genericTaskItem.update({ where: { id: lease.itemId }, data: { lockedUntil: new Date(0) } });
    const recovered = await recoverExpiredItem(worker, {
      family: "generic", taskTypes: [SITEMAP_REFRESH_TASK_TYPE],
      maxAttemptsByType: { [SITEMAP_REFRESH_TASK_TYPE]: 1 }, workerId: "sitemap-recovery-test",
    });
    expect(recovered?.action).toBe("failed");
    expect((await scopedTasks()).filter(({ status }) => status === "pending")).toHaveLength(1);
    expect(await scopedTasks()).toHaveLength(2);
  });
});
