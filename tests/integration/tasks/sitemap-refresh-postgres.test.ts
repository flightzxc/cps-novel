import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, readdir, readlink, writeFile } from "node:fs/promises";
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
import { createSitemapFamilyBuilder } from "@/lib/seo/sitemap";
import { generateStaticSitemaps } from "@/lib/seo/static-sitemap-generator";
import { refreshStaticSitemap } from "@/lib/seo/sitemap-refresh-state";
import { createSitemapRefreshHandler } from "../../../worker/handlers/sitemap-refresh";

import { PostgreSQLAdminIdentityStore, PostgreSQLSessionStore } from "@/lib/auth/postgres";
import { hashAdminSessionToken } from "@/lib/auth/session";
import { requireAdminRouteAccess } from "@/server/auth/guards";
import { P2_04_ADMIN_REGISTRY } from "@/app/api/admin/_lib/registry";
import { getAdminSitemapState, requestAdminSitemapRefresh, SITEMAP_ADMIN_AUDIT_ACTION } from "@/server/sitemap-admin/service";
import { parseSitemapArgs, runSitemapCli } from "../../../scripts/generate-static-sitemaps";

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
  return (await publishedKoreanBook(ordinal)).url;
}

async function publishedKoreanBook(ordinal: number) {
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
  return { url: `https://sitemap-test.example/ko/novel/${slug}-p${suffix}`, novelId: novel.id };
}

/** 运营 V2：给一本书加一章。`content: false` = 没有正文行（锁定/撤回章节的真实形态）。 */
async function addChapter(
  novelId: string,
  number: number,
  options: { status?: string; deleted?: boolean; content?: boolean } = {},
) {
  await owner.novelChapter.create({ data: {
    novelId, canonicalChapterNumber: number, title: `Chapter ${number}`, status: options.status ?? "preview",
    deletedAt: options.deleted ? new Date() : null,
    ...(options.content === false ? {} : { content: { create: {
      body: `Body of chapter ${number}`, charCount: 24, contentHash: String(number).padStart(64, "0"), materializedAt: new Date(),
    } } }),
  } });
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

async function admin(role = "super_admin") {
  const token = randomUUID();
  const now = new Date();
  const identity = await owner.adminIdentity.create({ data: { username: `sitemap-${token}`, passwordHash: "scrypt$v1$test-only", sessionVersion: 1, role } });
  await owner.adminSession.create({ data: {
    tokenHash: hashAdminSessionToken(token), identityId: identity.id, sessionVersion: 1,
    issuedAt: now, lastSeenAt: now, absoluteExpiresAt: new Date(now.valueOf() + 3600000),
  } });
  const deps = { db: web, identities: new PostgreSQLAdminIdentityStore(web), sessions: new PostgreSQLSessionStore(web),
    env: { ...enabledEnv, ADMIN_TWO_FACTOR_ENFORCEMENT: "disabled" }, now };
  async function authorize(requestId = randomUUID(), origin = "https://admin.example") {
    const auth = await requireAdminRouteAccess({ pathname: "/api/admin/sitemap", method: "POST", sessionToken: token,
      requestId, origin, canonicalOrigin: "https://admin.example",
    }, { ...deps, registry: P2_04_ADMIN_REGISTRY });
    return { authorization: auth.serviceAuthorization!, requestId, reason: "manual test" };
  }
  return { deps, authorize, identity };
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
  it("authorizes real web_app sessions, coalesces concurrent clicks and audits in one transaction", async () => {
    const session = await admin();
    const requests = await Promise.all(Array.from({ length: 8 }, () => session.authorize()));
    const results = await Promise.all(requests.map((input) => requestAdminSitemapRefresh(input, session.deps)));
    expect(results.filter((result) => result.status === "queued")).toHaveLength(1);
    expect(new Set(results.map((result) => result.status !== "disabled" && result.taskId)).size).toBe(1);
    expect(await scopedTasks()).toHaveLength(1);
    expect(await owner.operationAudit.count({ where: { action: SITEMAP_ADMIN_AUDIT_ACTION } })).toBe(8);
    await requestAdminSitemapRefresh(requests[0], session.deps);
    expect(await owner.operationAudit.count({ where: { action: SITEMAP_ADMIN_AUDIT_ACTION } })).toBe(8);
  });

  it("serializes concurrent retries of the same request into one task and one audit", async () => {
    const session = await admin();
    const request = await session.authorize();
    const results = await Promise.all(Array.from({ length: 8 }, () => requestAdminSitemapRefresh(request, session.deps)));
    expect(results.filter((result) => result.status === "queued")).toHaveLength(1);
    expect(await scopedTasks()).toHaveLength(1);
    expect(await owner.operationAudit.count({ where: { action: SITEMAP_ADMIN_AUDIT_ACTION } })).toBe(1);
  });

  it("rejects unauthorized roles, foreign origins, revoked privileges, and disabled gates without task writes", async () => {
    const denied = await admin("viewer");
    await expect(denied.authorize()).rejects.toMatchObject({ code: "admin_capability_denied" });
    const allowed = await admin();
    await expect(allowed.authorize(randomUUID(), "https://foreign.example")).rejects.toMatchObject({ code: "admin_origin_denied" });
    const input = await allowed.authorize();
    expect(await requestAdminSitemapRefresh(input, { ...allowed.deps, env: { ...allowed.deps.env, SITEMAP_AUTO_REFRESH_ALLOW_WRITE: "false" } })).toEqual({ status: "disabled" });
    await owner.adminIdentity.update({ where: { id: allowed.identity.id }, data: { role: "viewer" } });
    await expect(requestAdminSitemapRefresh(input, allowed.deps)).rejects.toMatchObject({ code: "admin_capability_denied" });
    expect(await scopedTasks()).toHaveLength(0);
    expect(await owner.operationAudit.count()).toBe(0);
  });

  it("rolls back enqueue when its audit cannot be inserted", async () => {
    const session = await admin();
    const input = await session.authorize();
    // Fault injection stays inside the same real DB transaction; no grant changes.
    const db = { $transaction: (fn: (tx: unknown) => Promise<unknown>) => web.$transaction(async (tx) => {
      const proxy = new Proxy(tx, { get(target, key) { return key === "operationAudit" ? {
        findFirst: target.operationAudit.findFirst.bind(target.operationAudit), create: async () => { throw new Error("audit fault"); },
      } : Reflect.get(target, key); } });
      return fn(proxy);
    }) } as unknown as PrismaClient;
    await expect(requestAdminSitemapRefresh(input, { ...session.deps, db })).rejects.toThrow("audit fault");
    expect(await scopedTasks()).toHaveLength(0);
    expect(await owner.genericTaskItem.count()).toBe(0);
  });

  it("CLI dry-run computes locale counts with zero database and file writes", async () => {
    await publishedKoreanArticle(1);
    const root = await rootDir();
    await writeFile(path.join(root, "canary"), "unchanged");
    const previousRoot = process.env.SITEMAP_STATIC_DIR;
    process.env.SITEMAP_STATIC_DIR = root;
    const before = await owner.$queryRaw<Array<{ snapshot: unknown }>>`SELECT jsonb_agg(to_jsonb(t)) AS snapshot FROM (SELECT * FROM article) t`;
    try {
      const result = await runSitemapCli(web, parseSitemapArgs(["--dry-run"]));
      expect(result).toMatchObject({ status: "dry_run", counts: { ko: expect.any(Number) } });
      expect("counts" in result && result.counts.ko).toBeGreaterThan(0);
      expect(await scopedTasks()).toHaveLength(0);
      expect(await owner.operationAudit.count()).toBe(0);
      expect(await readdir(root)).toEqual(["canary"]);
      expect(await readFile(path.join(root, "canary"), "utf8")).toBe("unchanged");
      expect(await owner.$queryRaw`SELECT jsonb_agg(to_jsonb(t)) AS snapshot FROM (SELECT * FROM article) t`).toEqual(before);
    } finally {
      if (previousRoot === undefined) delete process.env.SITEMAP_STATIC_DIR; else process.env.SITEMAP_STATIC_DIR = previousRoot;
    }
  });

  it("CLI apply enqueues as web_app; worker publishes atomically and status reports pending/processing/failure", async () => {
    const root = await rootDir();
    const expectedUrl = await publishedKoreanArticle(1);
    const preview = await runSitemapCli(web, parseSitemapArgs(["--dry-run"]));
    const args = parseSitemapArgs(["--apply", "--reason", "CLI fixture"]);
    await expect(runSitemapCli(owner, args, enabledEnv)).rejects.toThrow("web_app");
    expect((await runSitemapCli(web, args, enabledEnv)).status).toBe("queued");
    expect((await getAdminSitemapState(web, root, enabledEnv)).task?.status).toBe("pending");
    const lease = await claim();
    expect((await getAdminSitemapState(web, root, enabledEnv)).task?.status).toBe("processing");
    const outcome = await createSitemapRefreshHandler(worker, { rootDir: root, env: enabledEnv })(context(lease));
    await finalizeTaskItem(worker, lease, outcome);
    expect(await xml(root)).toContain(expectedUrl);
    const current = await readlink(path.join(root, "current"));
    expect((await getAdminSitemapState(web, root, enabledEnv)).published?.urlCount).toBe("urlCount" in preview ? preview.urlCount : -1);
    const next = await runSitemapCli(web, { ...args, requestId: randomUUID() }, enabledEnv);
    expect(next.status).toBe("queued");
    const nextLease = await claim();
    const failure = await createSitemapRefreshHandler(worker, { rootDir: root, env: enabledEnv, buildFamily: async () => { throw new Error("fixture build failure"); } })(context(nextLease));
    await finalizeTaskItem(worker, nextLease, failure);
    expect((await getAdminSitemapState(web, root, enabledEnv)).task?.status).toBe("failed");
    expect(await readlink(path.join(root, "current"))).toBe(current);
    expect(await xml(root)).toContain(expectedUrl);
  });


  // 运营 V2（Owner 2026-09-30）：章节页写进 novelpage 分片。真实角色（worker_app）读 novel_chapter /
  // novel_chapter_content，真实约束（status CHECK、活跃章节号部分唯一索引）。
  it("worker_app lists the free preview chapters right after their book, and never a locked/stale/withdrawn/deleted/content-less chapter or an unpublished book's chapters", async () => {
    const root = await rootDir();
    const book = await publishedKoreanBook(1);
    await addChapter(book.novelId, 1);
    await addChapter(book.novelId, 2);
    await addChapter(book.novelId, 3, { status: "locked", content: false });
    await addChapter(book.novelId, 4, { status: "stale" });
    await addChapter(book.novelId, 5, { status: "withdrawn", content: false });
    await addChapter(book.novelId, 6, { deleted: true });
    await addChapter(book.novelId, 7, { content: false });
    const unpublished = await publishedKoreanBook(2);
    await owner.novel.update({ where: { id: unpublished.novelId }, data: { status: "unpublished" } });
    await addChapter(unpublished.novelId, 1);

    expect((await handler(root)(context(standaloneLease()))).status).toBe("success");

    const locs = [...(await xml(root)).matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1]);
    expect(locs).toEqual([book.url, `${book.url}/chapter/1`, `${book.url}/chapter/2`]);
  });

  it("worker_app: a locale with no public content gets no shard at all (mainpage included) and the populated one does; site_setting's new Yandex columns are readable by the worker role", async () => {
    const root = await rootDir();
    await publishedKoreanBook(1);
    // Real worker_app read of the whole site_setting row (getSiteSetting) happens inside the mainpage builder.
    const result = await generateStaticSitemaps({
      buildFamily: createSitemapFamilyBuilder(worker, enabledEnv),
      rootDir: root,
      runId: "empty-locale-real-role",
      routeLocales: ["ko", "en"],
    });
    expect([...result.manifest.sitemapFiles].sort()).toEqual([
      "sitemap/site_mainpage_ko.xml",
      "sitemap/site_novelpage_ko.xml",
    ]);
    const index = await readFile(path.join(root, "current", "sitemap.xml"), "utf8");
    expect(index).not.toContain("_en.xml");
    expect(index).not.toContain("categorypage");
  });

});
