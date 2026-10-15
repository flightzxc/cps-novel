import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { materializeNovelFromSourceItem } from "@/server/content-creation/service";
import { applyContentCreationBatch } from "@/server/content-creation/batch";
import { applyPublishTransition, publishArticlesBatch } from "@/server/publish-gate/service";
import { enqueuePublicationPreviews } from "@/server/publication/preview-enqueue";
import { parsePreviewChaptersResponse } from "@/lib/adapters";
import { buildWorkerAllowlist, createMoboreaderPreviewRefreshTask, createPromoLinkClaimTask } from "@/lib/tasks";
import { refreshSitemapAfterPreviewTask } from "@/lib/tasks/preview-refresh-finalize";
import { encryptCredentialSecretForWorker } from "../../../worker/credentials/crypto";
import { createMoboreaderWorkerHandlers } from "../../../worker/handlers/moboreader";
import { createPromoLinkClaimWorkerHandlers } from "../../../worker/handlers/promo-link-claim";
import { createNovelMaterializeWorkerHandlers } from "../../../worker/handlers/novel-materialize";
import { processOneWorkerCycle } from "../../../worker/runtime/worker";

vi.mock("@/server/publication/revalidate", () => ({ revalidatePublicArticlePaths: vi.fn(), revalidatePublicArticleSet: vi.fn(), revalidatePublicBlogPaths: vi.fn() }));
const enabled = process.env.PUBLICATION_PREVIEW_DATABASE_TEST === "1";
const owner = new PrismaClient({ datasourceUrl: process.env.PUBLICATION_PREVIEW_OWNER_DATABASE_URL });
const web = new PrismaClient({ datasourceUrl: process.env.PUBLICATION_PREVIEW_WEB_DATABASE_URL });
const worker = new PrismaClient({ datasourceUrl: process.env.PUBLICATION_PREVIEW_WORKER_DATABASE_URL });
const env = { NODE_ENV: "test", FEATURE_NOVEL_CATALOG_SYNC: "true", NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true", MOBOREADER_PREVIEW_SOURCE_APP_CODES: "moboreader", FEATURE_PROMO_LINK_CLAIM: "true", PROMO_LINK_CLAIM_ALLOW_WRITE: "true" } satisfies NodeJS.ProcessEnv;
const actor = { type: "system", source: "wo1-test" } as const;
const queue = (ids: string[], requestId = randomUUID()) => enqueuePublicationPreviews(web, { articleIds: ids, requestId, actorId: actor.source }, env);
let foundation: { app: string; account: string; secondAccount: string; channel: string };

async function account(channelId: string) {
  const a = await owner.channelAccount.create({ data: { channelId, businessId: randomUUID(), accountName: "local" } });
  const id = randomUUID();
  await owner.channelAccountCredential.create({ data: { id, channelAccountId: a.id,
    encryptedSecret: new Uint8Array(encryptCredentialSecretForWorker("local-only-token", a.id, id, 1)),
    keyVersion: 1, secretFingerprint: `hmac-sha256:v1:${"a".repeat(64)}`, fingerprintPrefix: "aaaaaaaaaaaa", status: "active" } });
  return a.id;
}
async function seed(ordinal = 0, accountId = foundation.account, published = false) {
  const suffix = randomUUID().replaceAll("-", "");
  const novel = await owner.novel.create({ data: { businessId: suffix, title: `Novel ${ordinal}`, description: "Fixture", locale: "en", slug: suffix, status: published ? "published" : "ready" } });
  const source = await owner.novelSourceItem.create({ data: { novelId: novel.id, channelAppId: foundation.app, externalBookId: suffix, externalAgencyId: "agency", sourceLanguageCode: "2", title: novel.title, description: "Fixture", status: "linked",
    rawPayload: { agencyId: "agency", seriesId: suffix, language: "2", projectType: 1, allEpis: 3, payEpisFrom: 2 } } });
  const promo = await owner.promoLink.create({ data: { novelId: novel.id, novelSourceItemId: source.id, channelAppId: foundation.app, channelAccountId: accountId, offerType: "read", publicRedirectCode: suffix, idempotencyKey: suffix.padEnd(64, "0"), webUrl: "https://local.example/read", status: "fetched" } });
  const article = await owner.article.create({ data: { novelId: novel.id, promoLinkId: promo.id, locale: "en", slug: suffix, publicPageShortId: suffix.slice(0, 12), title: novel.title, body: "Fixture body", status: published ? "published" : "draft", publishedAt: published ? new Date() : null } });
  return { novel, source, promo, article };
}
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 2));
function handlers() {
  return { ...createMoboreaderWorkerHandlers(worker, { env, adapter: {
    listBooks: async () => { throw new Error("unexpected catalog call"); },
    fetchBookMaterial: async () => { await pause(); return { dataId: null, seriesId: null, materialType: null, materialStatus: null, statusText: null, rawEvidence: { __boundary: "approved_raw_evidence" } }; },
    fetchPreviewChapters: async () => { await pause(); return { bookId: "local", currentLanguage: "2", chapterList: [{ i: 1, chapterID: "1", chapterName: "Chapter", chapterShowName: null, chapterContent: "Local body" }] }; },
  } }), ...createPromoLinkClaimWorkerHandlers(worker, { env, adapter: {
    claimPromo: async () => { throw new Error("unexpected upstream mutation"); },
    readPromoAfterClaim: async () => { await pause(); return { status: "found", promo: { upstreamCode: "local", webUrl: "https://local.example/read", appUrl: null } }; },
  } }) };
}
async function cycle() {
  const registry = handlers();
  return processOneWorkerCycle({ prisma: worker, workerId: "wo1-local", handlers: registry,
    allowlist: buildWorkerAllowlist("moboreader.preview_refresh.v1,promo_link.claim.v1", registry), signal: new AbortController().signal });
}

// B-42 / B-46：真解析器 + 真 worker（worker_app）跑试读任务；上游响应由用例给定。
const sitemapEnv = { ...env, FEATURE_SITEMAP_AUTO_REFRESH: "true" } satisfies NodeJS.ProcessEnv;
const previewRow = (i: number, chapterContent: unknown) => ({ i, chapterID: `b42-${i}`, chapterName: `Chapter ${i}`, chapterShowName: null, chapterContent });
async function previewCycles(chapterList: unknown, handlerEnv: NodeJS.ProcessEnv = env, maxCycles = 50) {
  const registry = createMoboreaderWorkerHandlers(worker, { env: handlerEnv, adapter: {
    listBooks: async () => { throw new Error("unexpected catalog call"); },
    fetchBookMaterial: async () => ({ dataId: null, seriesId: null, materialType: null, materialStatus: null, statusText: null, rawEvidence: { __boundary: "approved_raw_evidence" } }),
    fetchPreviewChapters: async () => parsePreviewChaptersResponse({ data: { bookId: "local", currentLanguage: "2", chapterList } }),
  } });
  let processed = 0;
  while (processed < maxCycles && await processOneWorkerCycle({ prisma: worker, workerId: "b42-local", handlers: registry,
    allowlist: buildWorkerAllowlist("moboreader.preview_refresh.v1", registry), signal: new AbortController().signal })) processed += 1;
  return processed;
}
async function previewTask(sourceItemIds: string[]) {
  // 同一本书再刷新一次：把上次刷新时间拨回去，越过新鲜度窗口（`fresh_preview`）。
  for (const id of sourceItemIds) {
    await owner.$executeRaw`UPDATE novel_preview_policy p SET last_refreshed_at = now() - interval '30 days'
      FROM novel_source_item s WHERE s.id = ${id}::uuid AND p.novel_id = s.novel_id`;
  }
  const requestToken = `b42:${randomUUID()}`;
  expect(await createMoboreaderPreviewRefreshTask(worker, { channelAccountId: foundation.account, channelAppId: foundation.app,
    novelSourceItemIds: sourceItemIds, requestToken, actorId: "b42-local", requestId: randomUUID() }, env)).toMatchObject({ status: "enqueued" });
  return owner.channelSyncTask.findUniqueOrThrow({ where: { requestToken } });
}
const chaptersOf = (novelId: string) => owner.novelChapter.findMany({ where: { novelId }, orderBy: { canonicalChapterNumber: "asc" },
  select: { canonicalChapterNumber: true, status: true, content: { select: { body: true, contentHash: true } } } });
const sitemapTasks = () => owner.genericTask.findMany({ where: { taskType: "sitemap_refresh" }, select: { id: true, status: true, params: true } });

describe.skipIf(!enabled).sequential("publication preview real roles", () => {
  beforeAll(async () => {
    const [db] = await owner.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    if (!db.name.startsWith("cps_novel_publication_preview_")) throw new Error("refuse non-disposable database");
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value!);
  });
  beforeEach(async () => {
    const tables = await owner.$queryRaw<Array<{ tablename: string }>>`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`;
    await owner.$executeRawUnsafe(`TRUNCATE ${tables.map(t => `"${t.tablename}"`).join(",")} RESTART IDENTITY CASCADE`);
    const channel = await owner.channel.create({ data: { code: "changdu", name: "local" } });
    const sourceApp = await owner.sourceApp.create({ data: { code: "moboreader", name: "local" } });
    const app = await owner.channelApp.create({ data: { channelId: channel.id, sourceAppId: sourceApp.id, externalAppId: "local", projectType: 1 } });
    await owner.channelCapability.createMany({ data: ["getbydataid", "getchapterinfo", "getlistpc"].map(capabilityKey => ({ channelAppId: app.id, capabilityKey, status: "enabled", sideEffecting: false, evidenceLevel: "READ_ONLY_PRODUCTION_READ_PROVEN" })) });
    foundation = { channel: channel.id, app: app.id, account: await account(channel.id), secondAccount: await account(channel.id) };
  });
  afterAll(async () => { vi.unstubAllEnvs(); await Promise.all([owner.$disconnect(), web.$disconnect(), worker.$disconnect()]); });

  it("single and batch materialization never enqueue previews", async () => {
    const source = async () => owner.novelSourceItem.create({ data: {
      channelAppId: foundation.app, externalBookId: randomUUID(), sourceLanguageCode: "2", sourceLocale: "en",
      title: `Materialize ${randomUUID()}`, description: "fixture", rawPayload: {}, status: "pending",
    } });
    const one = await source();
    expect(await materializeNovelFromSourceItem(web, { novelSourceItemId: one.id, actor, requestId: randomUUID(), mode: "apply" })).toMatchObject({ outcome: "created" });
    const batch = await Promise.all([source(), source()]);
    expect(await applyContentCreationBatch(web, { novelSourceItemIds: batch.map(s => s.id), actor, requestId: randomUUID() })).toMatchObject({ counts: { created: 2 } });
    const viaWorker = await source();
    await owner.genericTask.create({ data: {
      taskType: "novel.materialize.v1", operationScopeHash: "f".repeat(64), requestToken: randomUUID(), mode: "apply", status: "pending", totalCount: 1,
      items: { create: { targetType: "novel_source_item", targetId: viaWorker.id, payload: {
        novelSourceItemId: viaWorker.id, channelAppId: foundation.app, actorId: "local-admin", requestId: randomUUID(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      } } },
    } });
    const registry = createNovelMaterializeWorkerHandlers(worker);
    expect(await processOneWorkerCycle({ prisma: worker, workerId: "wo1-materialize", handlers: registry, allowlist: buildWorkerAllowlist("novel.materialize.v1", registry), signal: new AbortController().signal })).toBe(true);
    expect(await owner.genericTaskItem.findFirst()).toMatchObject({ status: "success" });
    expect(await owner.channelSyncTask.count()).toBe(0);
    expect(await owner.article.count()).toBe(0);
  });

  it("single old draft publishes, web queues without secret SELECT, real worker materializes", async () => {
    const row = await seed();
    expect(await web.channelSyncTask.count()).toBe(0);
    expect((await applyPublishTransition(web, { articleId: row.article.id, requestId: randomUUID(), actor })).outcome).toBe("published");
    expect(await web.channelSyncTask.count()).toBe(1);
    await expect(web.$queryRaw`SELECT encrypted_secret FROM channel_account_credential`).rejects.toThrow();
    expect(await cycle()).toBe(true);
    expect(await owner.channelSyncTaskItem.findFirst()).toMatchObject({ status: "success" });
    expect(await owner.novelChapter.count()).toBe(1);
    expect((await queue([row.article.id])).groups[0]?.result).toMatchObject({ status: "no_eligible_sources", skipReasonCounts: { fresh_preview: 1 } });
  });

  it("batch aggregates successful books by actual account, dedupes locales and excludes rejected rows", async () => {
    const rows = await Promise.all([seed(0), seed(1), seed(2, foundation.secondAccount), seed(3)]);
    await owner.article.update({ where: { id: rows[3]!.article.id }, data: { body: "" } });
    const locale = await owner.article.create({ data: { novelId: rows[0]!.novel.id, promoLinkId: rows[0]!.promo.id, locale: "ko", slug: randomUUID(), publicPageShortId: randomUUID().slice(0, 12), title: "locale", body: "body" } });
    const result = await publishArticlesBatch(web, { articleIds: [...rows.map(r => r.article.id), locale.id], requestId: randomUUID(), actor });
    expect(result.results.filter(r => r.result.outcome === "published")).toHaveLength(4);
    expect(await owner.channelSyncTask.findMany({ select: { channelAccountId: true, totalCount: true }, orderBy: { totalCount: "desc" } })).toEqual([
      { channelAccountId: foundation.account, totalCount: 2 }, { channelAccountId: foundation.secondAccount, totalCount: 1 },
    ]);
    expect(await owner.channelSyncTaskItem.count()).toBe(3);
  });

  it("same account with different applications creates separate grouped tasks", async () => {
    const first = await seed();
    const app = await owner.channelApp.findUniqueOrThrow({ where: { id: foundation.app } });
    const second = await owner.channelApp.create({ data: { channelId: app.channelId, sourceAppId: app.sourceAppId, externalAppId: "second", projectType: 1 } });
    foundation.app = second.id;
    const other = await seed(1);
    await publishArticlesBatch(web, { articleIds: [first.article.id, other.article.id], requestId: randomUUID(), actor });
    const tasks = await owner.channelSyncTask.findMany();
    expect(tasks).toHaveLength(2);
    expect(new Set(tasks.map(t => t.channelAppId))).toEqual(new Set([app.id, second.id]));
    expect(tasks.every(t => t.channelAccountId === foundation.account && t.totalCount === 1)).toBe(true);
  });

  it("an unexpected middle publish SQL failure still queues only the committed prefix", async () => {
    const rows = await Promise.all([seed(0), seed(1), seed(2)]);
    await owner.$executeRawUnsafe(`CREATE FUNCTION wo1_reject_publish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${rows[1]!.article.id}'::uuid THEN RAISE EXCEPTION 'local publish failure'; END IF; RETURN NEW; END $$`);
    await owner.$executeRawUnsafe(`CREATE TRIGGER wo1_reject_publish BEFORE UPDATE ON article FOR EACH ROW EXECUTE FUNCTION wo1_reject_publish()`);
    const requestId = randomUUID();
    try {
      const result = await publishArticlesBatch(web, { articleIds: rows.map(r => r.article.id), requestId, actor });
      expect(result.aborted?.articleId).toBe(rows[1]!.article.id);
      expect(result.results).toHaveLength(1);
      expect(await owner.channelSyncTaskItem.findMany({ select: { novelSourceItemId: true } })).toEqual([{ novelSourceItemId: rows[0]!.source.id }]);
      expect(await owner.article.count({ where: { status: "published" } })).toBe(1);
    } finally {
      await owner.$executeRawUnsafe(`DROP TRIGGER wo1_reject_publish ON article`);
      await owner.$executeRawUnsafe(`DROP FUNCTION wo1_reject_publish()`);
    }
    const retried = await publishArticlesBatch(web, { articleIds: rows.map(r => r.article.id), requestId, actor });
    expect(retried.aborted).toBeUndefined();
    expect(await owner.channelSyncTaskItem.count()).toBe(3);
  });

  it("concurrent overlapping requests and different source/account aliases reserve each novel once", async () => {
    const rows = await Promise.all([seed(0, foundation.account, true), seed(1, foundation.account, true), seed(2, foundation.account, true)]);
    // Force both transactions to overlap before either INSERT commits. A
    // missing advisory lock then deterministically allows duplicate book b.
    await owner.$executeRawUnsafe(`CREATE FUNCTION wo1_slow_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$`);
    await owner.$executeRawUnsafe(`CREATE TRIGGER wo1_slow_enqueue BEFORE INSERT ON channel_sync_task FOR EACH ROW EXECUTE FUNCTION wo1_slow_enqueue()`);
    try {
      await Promise.all([queue(rows.slice(0, 2).map(r => r.article.id)), queue(rows.slice(1).map(r => r.article.id))]);
    } finally {
      await owner.$executeRawUnsafe(`DROP TRIGGER wo1_slow_enqueue ON channel_sync_task`);
      await owner.$executeRawUnsafe(`DROP FUNCTION wo1_slow_enqueue()`);
    }
    expect(await owner.channelSyncTaskItem.count()).toBe(3);
    await queue(rows.map(r => r.article.id));
    expect(await owner.channelSyncTaskItem.count()).toBe(3);
    const alias = await owner.novelSourceItem.create({ data: { novelId: rows[0]!.novel.id, channelAppId: foundation.app, externalBookId: randomUUID(), sourceLanguageCode: "2", title: "alias", description: "Fixture", rawPayload: {}, status: "linked" } });
    expect(await createMoboreaderPreviewRefreshTask(web, { channelAccountId: foundation.secondAccount, channelAppId: foundation.app, novelSourceItemIds: [alias.id], requestToken: randomUUID(), requestId: randomUUID(), actorId: "test" }, env)).toMatchObject({ status: "no_eligible_sources", skipReasonCounts: { preview_in_flight: 1 } });
  });

  it("held books are parked with system marker and remain deduped; closed gates also park", async () => {
    const row = await seed(0, foundation.account, true);
    await owner.channelAccountHold.create({ data: { channelAccountId: foundation.account, scope: "preview", reasonCode: "credential_validation_failed" } });
    expect((await queue([row.article.id])).groups[0]?.result).toMatchObject({ status: "enqueued", taskStatus: "disabled" });
    expect(await owner.channelSyncTask.findFirst()).toMatchObject({ result: { taskControl: { kind: "system_hold", source: "system" } } });
    await queue([row.article.id]);
    expect(await owner.channelSyncTask.count()).toBe(1);
    const other = await seed(1, foundation.secondAccount, true);
    expect((await enqueuePublicationPreviews(web, { articleIds: [other.article.id], requestId: randomUUID(), actorId: "test" }, { ...env, NOVEL_CATALOG_SYNC_ALLOW_WRITE: "false" })).groups[0]?.result).toMatchObject({ taskStatus: "disabled" });
  });

  it("a real SQL enqueue failure leaves publication and audit committed", async () => {
    const row = await seed();
    await owner.$executeRawUnsafe(`CREATE FUNCTION wo1_reject_preview() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'local injected enqueue failure'; END $$`);
    await owner.$executeRawUnsafe(`CREATE TRIGGER wo1_reject_preview BEFORE INSERT ON channel_sync_task FOR EACH ROW EXECUTE FUNCTION wo1_reject_preview()`);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await applyPublishTransition(web, { articleId: row.article.id, requestId: randomUUID(), actor })).outcome).toBe("published");
      expect(await owner.article.findUnique({ where: { id: row.article.id } })).toMatchObject({ status: "published" });
      expect(await owner.operationAudit.count({ where: { entityId: row.article.id } })).toBe(1);
      expect(await owner.channelSyncTask.count()).toBe(0);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("failed after commit"), expect.objectContaining({ errorKind: "PrismaClientUnknownRequestError" }));
    } finally {
      await owner.$executeRawUnsafe(`DROP TRIGGER wo1_reject_preview ON channel_sync_task`);
      await owner.$executeRawUnsafe(`DROP FUNCTION wo1_reject_preview()`);
      error.mockRestore();
    }
  });

  it("republishing queues stale preview but does not change first-publish semantics", async () => {
    const row = await seed(0, foundation.account, true);
    await owner.article.update({ where: { id: row.article.id }, data: { status: "draft" } });
    expect(await applyPublishTransition(web, { articleId: row.article.id, requestId: randomUUID(), actor })).toMatchObject({ outcome: "published", firstPublish: false });
    expect(await owner.channelSyncTask.count()).toBe(1);
  });

  it("blog, hidden/deleted articles, whitespace promo and invalid source binding give diagnostic skips", async () => {
    const row = await seed(0, foundation.account, true);
    await owner.promoLink.update({ where: { id: row.promo.id }, data: { webUrl: "   " } });
    expect((await queue([row.article.id])).skipReasonCounts).toMatchObject({ promo_not_ready: 1 });
    await owner.promoLink.update({ where: { id: row.promo.id }, data: { webUrl: "https://local.example" } });
    await owner.novelSourceItem.update({ where: { id: row.source.id }, data: { novelId: null } });
    expect((await queue([row.article.id])).skipReasonCounts).toMatchObject({ source_binding_invalid: 1 });
    await owner.article.update({ where: { id: row.article.id }, data: { deletedAt: new Date() } });
    expect((await queue([row.article.id])).skipReasonCounts).toMatchObject({ article_not_public: 1 });
    const blog = await owner.article.create({ data: { articleType: "blog_article", locale: "en", title: "blog", body: "body", slug: randomUUID(), publicPageShortId: randomUUID().slice(0, 12), status: "published", publishedAt: new Date() } });
    expect((await queue([blog.id])).skipReasonCounts).toMatchObject({ article_not_public: 1 });
    const unroutable = await seed(2, foundation.account, true);
    await owner.article.update({ where: { id: unroutable.article.id }, data: { locale: "xx" } });
    expect((await queue([unroutable.article.id])).skipReasonCounts).toMatchObject({ article_not_public: 1 });
    const hidden = await seed(1, foundation.account, true);
    await owner.article.update({ where: { id: hidden.article.id }, data: { seoVisibility: "hidden" } });
    expect((await enqueuePublicationPreviews(web, { articleIds: [hidden.article.id], requestId: randomUUID(), actorId: "test" }, { ...env, FEATURE_ARTICLE_SEO_VISIBILITY: "true" })).skipReasonCounts).toMatchObject({ article_not_public: 1 });
    expect(await owner.channelSyncTask.count()).toBe(0);
  });

  it("B-42 第 2 章正文为空：其余章节照常物化，条目成功并留空章节号", async () => {
    const row = await seed(0, foundation.account, true);
    const task = await previewTask([row.source.id]);
    expect(await previewCycles([previewRow(1, "one"), previewRow(2, ""), previewRow(3, "three")])).toBe(1);
    const item = await owner.channelSyncTaskItem.findFirstOrThrow({ where: { taskId: task.id } });
    expect(item).toMatchObject({ status: "success", error: null, result: {
      upstreamCount: 3, emptyChapterNumbers: [2], materializedCount: 2, contentWrites: 2, staleCount: 0, restoredCount: 0, preservedCount: 0,
    } });
    expect((await chaptersOf(row.novel.id)).map((c) => [c.canonicalChapterNumber, c.status, c.content?.body])).toEqual([[1, "preview", "one"], [3, "preview", "three"]]);
    expect(await owner.novelPreviewPolicy.findUniqueOrThrow({ where: { novelId: row.novel.id } })).toMatchObject({ materializedChapterCount: 2 });
  });

  it("B-42 已上线的章节在上游变成空正文：原样保留（不覆盖、不置 stale），策略章节数算上它", async () => {
    const row = await seed(0, foundation.account, true);
    await previewTask([row.source.id]);
    expect(await previewCycles([previewRow(1, "one"), previewRow(2, "two"), previewRow(3, "three")])).toBe(1);
    const before = await chaptersOf(row.novel.id);
    const second = await previewTask([row.source.id]);
    expect(await previewCycles([previewRow(1, "one"), previewRow(2, "  "), previewRow(3, "three v2")])).toBe(1);
    expect(await owner.channelSyncTaskItem.findFirstOrThrow({ where: { taskId: second.id } })).toMatchObject({ status: "success", result: {
      emptyChapterNumbers: [2], materializedCount: 2, contentWrites: 1, staleCount: 0, preservedCount: 1,
    } });
    const after = await chaptersOf(row.novel.id);
    expect(after.map((c) => [c.canonicalChapterNumber, c.status, c.content?.body])).toEqual([[1, "preview", "one"], [2, "preview", "two"], [3, "preview", "three v2"]]);
    expect(after[1]!.content?.contentHash).toBe(before[1]!.content?.contentHash);
    expect(await owner.novelPreviewPolicy.findUniqueOrThrow({ where: { novelId: row.novel.id } })).toMatchObject({ materializedChapterCount: 3 });
  });

  it("B-42 保留只限空章节号：不在本次计划里、也不是空章号的旧章节照常置 stale", async () => {
    const row = await seed(0, foundation.account, true);
    await previewTask([row.source.id]);
    expect(await previewCycles([previewRow(1, "one"), previewRow(2, "two"), previewRow(3, "three")])).toBe(1);
    const before = await chaptersOf(row.novel.id);
    const second = await previewTask([row.source.id]);
    expect(await previewCycles([previewRow(2, ""), previewRow(3, "three"), previewRow(4, "four")])).toBe(1);
    expect(await owner.channelSyncTaskItem.findFirstOrThrow({ where: { taskId: second.id } })).toMatchObject({ status: "success", result: {
      emptyChapterNumbers: [2], materializedCount: 2, staleCount: 1, preservedCount: 1,
    } });
    const after = await chaptersOf(row.novel.id);
    expect(after.map((c) => [c.canonicalChapterNumber, c.status])).toEqual([[1, "stale"], [2, "preview"], [3, "preview"], [4, "preview"]]);
    expect(after[1]!.content?.contentHash).toBe(before[1]!.content?.contentHash);
    const readable = await owner.novelChapter.count({ where: { novelId: row.novel.id, status: "preview", deletedAt: null, content: { isNot: null } } });
    expect(readable).toBe(3);
    expect(await owner.novelPreviewPolicy.findUniqueOrThrow({ where: { novelId: row.novel.id } })).toMatchObject({ materializedChapterCount: readable });
  });

  it("B-42 全部章节为空 / chapterList 为 null：条目 skipped=无试读，不写章节，已有试读原样", async () => {
    const row = await seed(0, foundation.account, true);
    await previewTask([row.source.id]);
    expect(await previewCycles([previewRow(1, "one")])).toBe(1);
    const allEmpty = await previewTask([row.source.id]);
    expect(await previewCycles([previewRow(1, ""), previewRow(2, " \n ")])).toBe(1);
    expect(await owner.channelSyncTaskItem.findFirstOrThrow({ where: { taskId: allEmpty.id } })).toMatchObject({ status: "skipped", error: null,
      result: { reason: "upstream_preview_all_chapters_empty", upstreamCount: 2, emptyChapterNumbers: [1, 2] } });
    const nullList = await previewTask([row.source.id]);
    expect(await previewCycles(null)).toBe(1);
    expect(await owner.channelSyncTaskItem.findFirstOrThrow({ where: { taskId: nullList.id } })).toMatchObject({ status: "skipped", error: null,
      result: { reason: "upstream_preview_chapter_list_null", upstreamDiagnostic: { kind: "chapter_list_not_array", stage: "getchapterinfo", receivedType: "null" } } });
    expect(await owner.channelSyncTask.findUniqueOrThrow({ where: { id: nullList.id } })).toMatchObject({ status: "completed", failedCount: 0, skippedCount: 1 });
    expect((await chaptersOf(row.novel.id)).map((c) => [c.canonicalChapterNumber, c.status, c.content?.body])).toEqual([[1, "preview", "one"]]);
  });

  it("B-46 试读任务写入章节后经 worker_app 入队一次站点地图刷新；按任务粒度、水位线防重复", async () => {
    const rows = [await seed(0, foundation.account, true), await seed(1, foundation.account, true)];
    const task = await previewTask(rows.map((r) => r.source.id));
    expect(await previewCycles([previewRow(1, "one")], sitemapEnv, 1)).toBe(1);
    // 任务还有未完成条目：不触发。
    expect(await sitemapTasks()).toEqual([]);
    expect(await previewCycles([previewRow(1, "one")], sitemapEnv)).toBe(1);
    const [refresh] = await sitemapTasks();
    expect(refresh).toMatchObject({ status: "pending", params: { reason: "preview_chapters_written", triggeredBy: `moboreader.preview_refresh.v1#${task.id}` } });
    // 水位线合并写进任务结果，建任务时写下的键原样保留。
    expect((await owner.channelSyncTask.findUniqueOrThrow({ where: { id: task.id } })).result).toMatchObject({
      eligibleCount: 2, sitemapRefresh: { status: "queued", taskId: refresh!.id, coveredItemCount: 2, triggerCount: 1 },
    });
    // 重复回调（例如两个 worker 各提交最后一个条目）：水位线已覆盖，不再入队。
    await refreshSitemapAfterPreviewTask(worker, task.id, { env: sitemapEnv });
    expect(await sitemapTasks()).toHaveLength(1);
    expect((await owner.channelSyncTask.findUniqueOrThrow({ where: { id: task.id } })).result).toMatchObject({ sitemapRefresh: { triggerCount: 1 } });
  });

  it("B-46 已有待处理刷新时合并（不撞在途唯一约束）；没写章节或开关关闭时不入队", async () => {
    const [a, b, c, d] = [await seed(0, foundation.account, true), await seed(1, foundation.account, true), await seed(2, foundation.account, true), await seed(3, foundation.account, true)];
    await previewTask([a.source.id]);
    expect(await previewCycles([previewRow(1, "one")], sitemapEnv)).toBe(1);
    const second = await previewTask([b.source.id]);
    expect(await previewCycles([previewRow(1, "one")], sitemapEnv)).toBe(1);
    const tasks = await sitemapTasks();
    expect(tasks).toHaveLength(1);
    expect((await owner.channelSyncTask.findUniqueOrThrow({ where: { id: second.id } })).result).toMatchObject({ sitemapRefresh: { status: "coalesced", taskId: tasks[0]!.id } });
    await owner.genericTaskItem.deleteMany({ where: { task: { taskType: "sitemap_refresh" } } });
    await owner.genericTask.deleteMany({ where: { taskType: "sitemap_refresh" } });
    // 全部为空（skipped）：没有可读章节变动，不入队。
    const empty = await previewTask([c.source.id]);
    expect(await previewCycles([previewRow(1, "")], sitemapEnv)).toBe(1);
    expect(await sitemapTasks()).toEqual([]);
    expect((await owner.channelSyncTask.findUniqueOrThrow({ where: { id: empty.id } })).result).not.toHaveProperty("sitemapRefresh");
    // 正文与已有的相同（contentWrites=0）：不入队。
    await previewTask([a.source.id]);
    expect(await previewCycles([previewRow(1, "one")], sitemapEnv)).toBe(1);
    expect(await sitemapTasks()).toEqual([]);
    // 开关关闭：写了章节也不入队，也不记水位。
    const off = await previewTask([d.source.id]);
    expect(await previewCycles([previewRow(1, "one")], env)).toBe(1);
    expect(await sitemapTasks()).toEqual([]);
    expect((await owner.channelSyncTask.findUniqueOrThrow({ where: { id: off.id } })).result).not.toHaveProperty("sitemapRefresh");
  });

  it("B-46 只置 stale、没有新写的试读任务也入队刷新（章节页要移出站点地图）", async () => {
    const row = await seed(0, foundation.account, true);
    await previewTask([row.source.id]);
    expect(await previewCycles([previewRow(1, "one"), previewRow(2, "two"), previewRow(3, "three")], env)).toBe(1);
    expect(await sitemapTasks()).toEqual([]);
    const task = await previewTask([row.source.id]);
    expect(await previewCycles([previewRow(2, "two"), previewRow(3, "three")], sitemapEnv)).toBe(1);
    expect(await owner.channelSyncTaskItem.findFirstOrThrow({ where: { taskId: task.id } })).toMatchObject({ status: "success", result: {
      contentWrites: 0, restoredCount: 0, staleCount: 1,
    } });
    const tasks = await sitemapTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: "pending", params: { reason: "preview_chapters_written", triggeredBy: `moboreader.preview_refresh.v1#${task.id}` } });
    expect((await owner.channelSyncTask.findUniqueOrThrow({ where: { id: task.id } })).result).toMatchObject({
      sitemapRefresh: { status: "queued", taskId: tasks[0]!.id, coveredItemCount: 1, triggerCount: 1 },
    });
  });

  for (const size of [50, 500]) it(`mixed local adapter load N=${size} through real worker and legal <=200 publish batches`, async () => {
    const rows = [];
    for (let i = 0; i < size; i++) rows.push(await seed(i));
    const claims = [];
    for (let i = 0; i < 12; i++) {
      const row = await seed(size + i);
      await owner.article.delete({ where: { id: row.article.id } });
      await owner.promoLink.delete({ where: { id: row.promo.id } });
      claims.push(row.source.id);
    }
    expect(await createPromoLinkClaimTask(web, { channelAccountId: foundation.account, channelAppId: foundation.app, items: claims.map(novelSourceItemId => ({ novelSourceItemId, offerType: "read" })), requestToken: randomUUID(), requestId: randomUUID(), actorId: "test", mode: "apply" }, env)).toMatchObject({ status: "enqueued" });
    const baselineStart = performance.now();
    for (let i = 0; i < 5; i++) expect(await cycle()).toBe(true);
    const baselineMs = performance.now() - baselineStart;
    expect(await owner.genericTaskItem.count({ where: { status: "success" } })).toBe(5);
    const publishStart = performance.now();
    for (let i = 0; i < size; i += 200) {
      const result = await publishArticlesBatch(web, { articleIds: rows.slice(i, i + 200).map(r => r.article.id), requestId: randomUUID(), actor });
      expect(result.results.every(r => r.result.outcome === "published")).toBe(true);
    }
    const workerStart = performance.now();
    for (let i = 0; i < size; i++) expect(await cycle()).toBe(true);
    const previewsDone = performance.now();
    expect(await owner.channelSyncTaskItem.count({ where: { status: "success" } })).toBe(size);
    expect(await owner.genericTaskItem.count({ where: { status: "success" } })).toBe(5);
    expect(await cycle()).toBe(true);
    const claimResumed = performance.now();
    expect(await owner.genericTaskItem.count({ where: { status: "success" } })).toBe(6);
    const metrics = { size, adapterDelayPerCallMs: 2, baselineClaimsPerSecond: 5000 / baselineMs,
      publishMs: workerStart - publishStart, previewWorkerMs: previewsDone - workerStart,
      claimWaitingAfterEnqueueMs: claimResumed - workerStart, publishToAllPreviewCompleteMs: previewsDone - publishStart,
      claimThroughputDuringPreview: 0, claimThroughputDropPercent: 100,
      estimatedUpstream1500msTwoCallsSeconds: size * 2 * 1.5 };
    await mkdir(".tmp/wo1", { recursive: true });
    await writeFile(`.tmp/wo1/mixed-${size}.json`, JSON.stringify(metrics, null, 2));
    console.log("WO1_LOCAL_SIMULATION", JSON.stringify(metrics));
  }, 180_000);
});
