import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { materializeNovelFromSourceItem } from "@/server/content-creation/service";
import { applyContentCreationBatch } from "@/server/content-creation/batch";
import { applyPublishTransition, publishArticlesBatch } from "@/server/publish-gate/service";
import { enqueuePublicationPreviews } from "@/server/publication/preview-enqueue";
import { buildWorkerAllowlist, createMoboreaderPreviewRefreshTask, createPromoLinkClaimTask } from "@/lib/tasks";
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
