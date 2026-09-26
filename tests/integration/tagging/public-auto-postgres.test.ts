import { verifyPublicAutoPlans } from "./public-auto-explain";
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as projection from "@/lib/site/public-taxonomy";
import * as legacy from "../../fixtures/public-taxonomy-before-wo7";
import { getPublicCategoryPage } from "@/lib/site/category-queries";
import { listPublicArticles, listPublicCategories, getPublicNovelDetail, loadPublicChrome } from "@/lib/site/queries";
import { createSitemapFamilyBuilder } from "@/lib/seo/sitemap";
import { initializeCreatedNovelTags, initializeCreatedNovelBatchTags, initializeMaterializedTaskTags } from "@/server/tagging/materialization";
import { createTaggingAutoClassifyTask } from "@/server/tagging/tasks";
import { replaceAutoTagSnapshot } from "@/server/tagging/service";
import { materializeNovelFromSourceItem } from "@/server/content-creation/service";
import { createFrozenTagClassifierConfig } from "@/lib/tagging/classifier-config";
import { CANONICAL_TAG_V1_SHA256, validateKeywordRuleArtifact } from "@/lib/tagging/keyword-artifact";
import { createTaggingWorkerHandlers } from "../../../worker/handlers/novel-tag-backfill";
import { createNovelMaterializeWorkerHandlers } from "../../../worker/handlers/novel-materialize";
import { processOneWorkerCycle } from "../../../worker/runtime";
import { buildWorkerAllowlist } from "@/lib/tasks";
import { invalidateSiteSettingCache } from "@/server/site-settings/service";
const shared = vi.hoisted(() => ({ web: null as PrismaClient | null }));
vi.mock("@/app/_lib/public-deps", () => ({ prisma: new Proxy({}, { get: (_, key) => Reflect.get(shared.web!, key) }) }));
import { loadPublicCategories, loadBrowseNovels, loadNovelDetail, loadChrome } from "@/app/_lib/public-load";

const enabled = process.env.P2_06_5_DATABASE_TEST === "1";
function client(role: string) {
  const datasourceUrl = process.env[`P2_06_5_${role}_DATABASE_URL`];
  if (enabled && !datasourceUrl) throw new Error(`missing explicit ${role} URL`);
  return new PrismaClient({ datasourceUrl });
}
const owner = client("OWNER"), web = client("WEB"), worker = client("WORKER");
const env: NodeJS.ProcessEnv = { NODE_ENV: "test", FEATURE_P2_06_5_TAGGING: "true", FEATURE_NOVEL_TAG_AUTO: "true", AUTO_WRITE_AUTHORIZED: "YES" };
const off = { ...env, FEATURE_NOVEL_TAG_AUTO: "false" };
const hash = "a".repeat(64);
const channel = randomUUID(), app = randomUUID(), sourceApp = randomUUID(), admin = randomUUID(), account = randomUUID();
const tags = Array.from({ length: 5 }, () => randomUUID());
const novel = randomUUID(), source = randomUUID(), article = randomUUID();
const rawScope = '["RAW_LANGUAGE_SCOPE_V1",["string","en"],["null"]]';
const config = createFrozenTagClassifierConfig({ version: "fixture-v1", titleWeight: 30, descriptionWeight: 20, threshold: 20, maxTextTags: 3 });
const artifact = () => validateKeywordRuleArtifact({ schemaVersion: 1, taxonomyVersion: "v1", taxonomySha256: CANONICAL_TAG_V1_SHA256, keywordLexiconVersion: "fixture-v1", tags: [{ canonicalTagId: tags[2], stableId: "ct-v1-c", textSelectionPriority: 0, keywords: [{ keywordId: "kw-tagged", value: "Tagged", scriptBuckets: ["latin"], matchMode: "unicode_word", riskFlags: [] }] }] });
const dependencies = () => ({ config, artifact: artifact(), enforceCanonicalV1: false });
const metadata = { method: "deterministic_text" as const, taxonomyVersion: "v1", taxonomySha256: hash, keywordLexiconVersion: "v1", keywordFingerprint: hash, classifierConfigVersion: "v1", classifierConfigFingerprint: hash, resultSummary: {} };
async function seedNovel() {
  const id = randomUUID();
  await owner.novel.create({ data: { id, businessId: id, title: "Tagged story", description: "", locale: "en", slug: id } });
  return id;
}
async function seedSource() {
  const id = randomUUID();
  await owner.novelSourceItem.create({ data: { id, channelAppId: app, externalBookId: id, sourceLocale: "en", sourceLanguageCode: "en", rawLanguageScope: rawScope, title: "Tagged story", description: "", status: "pending", rawPayload: {} } });
  return id;
}
async function snapshot(id: string, values: Array<[number, number]>) {
  return replaceAutoTagSnapshot({ db: worker, novelId: id, tags: values.map(([i, score]) => ({ canonicalTagId: tags[i], score, evidence: {} })), runMetadata: metadata, contentSha: hash, requestId: randomUUID(), env });
}
async function surfaces() {
  invalidateSiteSettingCache();
  const categories = await listPublicCategories(web, "en");
  return {
    categories, cards: await listPublicArticles(web, "en"), detail: await getPublicNovelDetail(web, article),
    category: await getPublicCategoryPage(web, "en", "text-z", 1),
    chrome: await loadPublicChrome(web, "en", "home", categories, ["en"]),
    sitemap: await createSitemapFamilyBuilder(web)({ type: "categorypage", locale: "en" }),
    loaders: { categories: await loadPublicCategories("en"), cards: await loadBrowseNovels("en"), detail: await loadNovelDetail(article), chrome: await loadChrome("en", "home", categories, ["en"]) },
  };
}

describe.skipIf(!enabled).sequential("WO7 public auto real roles", () => {
  beforeAll(async () => {
    const [db] = await owner.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    if (!db.name.startsWith("cps_novel_p2_06_5_wo7_")) throw new Error("isolated WO7 database required");
    shared.web = web;
    await owner.$executeRawUnsafe("TRUNCATE channel, source_app, admin_identity, novel, canonical_tag CASCADE");
    await owner.adminIdentity.create({ data: { id: admin, username: admin, passwordHash: "scrypt$v1$test-only", role: "super_admin" } });
    await owner.channel.create({ data: { id: channel, code: "wo7", name: "wo7" } });
    await owner.sourceApp.create({ data: { id: sourceApp, code: "wo7", name: "wo7" } });
    await owner.channelApp.create({ data: { id: app, channelId: channel, sourceAppId: sourceApp, externalAppId: "wo7", projectType: 2, status: "active" } });
    await owner.channelAccount.create({ data: { id: account, businessId: "wo7", channelId: channel, accountName: "wo7", status: "active" } });
    await owner.canonicalTag.createMany({ data: tags.map((id, i) => ({ id, stableId: `ct-v1-${"abcde"[i]}`, slug: ["mapped-a", "mapped-b", "text-z", "text-a", "inactive"][i], canonicalDefinition: "fixture", aliases: [], sortOrder: [20, 10, 30, 40, 50][i], taxonomyVersion: "v1" })) });
    await owner.canonicalTagTranslation.create({ data: { canonicalTagId: tags[0], locale: "zh", displayName: "映射" } });
    await owner.novel.create({ data: { id: novel, businessId: novel, locale: "en", title: "Tagged story", description: "", slug: novel, status: "published" } });
    await owner.novelSourceItem.create({ data: { id: source, channelAppId: app, novelId: novel, externalBookId: source, sourceLocale: "en", sourceLanguageCode: "en", rawLanguageScope: rawScope, title: "Tagged", description: "", status: "linked", rawPayload: {} } });
    const label = await owner.sourceLabel.create({ data: { channelAppId: app, labelKind: "series_type", externalLabelValue: "Mapped" } });
    await owner.novelSourceItemLabel.create({ data: { novelSourceItemId: source, sourceLabelId: label.id, active: true } });
    await owner.sourceLabelMapping.createMany({ data: [0, 1].map(i => ({ channelAppId: app, rawLanguageScope: rawScope, rawToken: "Mapped", canonicalTagId: tags[i], mappingVersion: "fixture", approvedBy: admin })) });
    const promo = await owner.promoLink.create({ data: { novelId: novel, novelSourceItemId: source, channelAppId: app, channelAccountId: account, offerType: "cps", publicRedirectCode: "wo7read", idempotencyKey: hash, origin: "claimed", status: "fetched", webUrl: "https://example.test/read", fetchedAt: new Date() } });
    await owner.article.create({ data: { id: article, novelId: novel, promoLinkId: promo.id, locale: "en", slug: "tagged", publicPageShortId: "wo7tagged", title: "Tagged", body: "Body", status: "published", publishedAt: new Date("2026-09-01") } });
    await snapshot(novel, [[0, 1], [2, 50], [3, 50], [4, 100]]);
    await owner.canonicalTag.update({ where: { id: tags[4] }, data: { status: "inactive" } });
  }, 30_000);
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  afterAll(async () => { await Promise.all([owner, web, worker].map(db => db.$disconnect())); });

  it("uses actual role identities and web_app reads all three tagging tables", async () => {
    expect(await web.$queryRaw`SELECT current_user AS role`).toEqual([{ role: "web_app" }]);
    expect(await worker.$queryRaw`SELECT current_user AS role`).toEqual([{ role: "worker_app" }]);
    await web.novelTagState.findMany({ take: 1 }); await web.novelCanonicalTag.findMany({ take: 1 }); await web.tagClassificationRun.findMany({ take: 1 });
  });
  it("guards active CanonicalTag sortOrder uniqueness", async () => {
    const rows = await web.canonicalTag.findMany({ where: { status: "active" }, select: { sortOrder: true } });
    expect(new Set(rows.map(row => row.sortOrder)).size).toBe(rows.length);
  });
  it("current auto union keeps mapped priority and orders tied text by stableId, excludes inactive", async () => {
    const result = await projection.loadPublicTaxonomyByNovelIds(web, [novel], "en", env);
    expect(result.get(novel)?.map(tag => tag.slug)).toEqual(["mapped-b", "mapped-a", "text-z", "text-a"]);
  });
  it("same fixture flag-off equals frozen implementation across every public consumer", async () => {
    vi.stubEnv("FEATURE_NOVEL_TAG_AUTO", "false"); vi.stubEnv("SITE_URL", "https://example.test");
    for (const mode of ["automatic", "manual"] as const) {
      await owner.novelTagState.update({ where: { novelId: novel }, data: { mode } });
      const actual = await surfaces();
      const spy = vi.spyOn(projection, "loadPublicTaxonomyByNovelIds").mockImplementation(legacy.loadPublicTaxonomyByNovelIds);
      const expected = await surfaces(); spy.mockRestore();
      expect(actual).toEqual(expected); expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
    }
    await owner.novelTagState.update({ where: { novelId: novel }, data: { mode: "automatic" } });
  });
  it("auto-only category appears in category, cards, detail, home/footer and sitemap; off is 404", async () => {
    vi.stubEnv("FEATURE_NOVEL_TAG_AUTO", "true"); vi.stubEnv("SITE_URL", "https://example.test");
    const result = await surfaces();
    expect(result.category?.novels).toHaveLength(1);
    expect(JSON.stringify(result.chrome)).toContain("/category/text-z");
    expect(JSON.stringify(result.sitemap)).toContain("/category/text-z");
    expect(JSON.stringify(result.cards)).toContain("text-z"); expect(JSON.stringify(result.detail)).toContain("text-z");
    expect(result.loaders.categories.map(tag => tag.slug)).toContain("text-z");
    vi.stubEnv("FEATURE_NOVEL_TAG_AUTO", "false");
    const disabled = await surfaces(); expect(disabled.category).toBeNull(); expect(JSON.stringify(disabled.sitemap)).not.toContain("/category/text-z");
  });
  it("manual snapshot including empty overrides all; historical and null run pointers exclude auto", async () => {
    const original = await owner.novelTagState.findUniqueOrThrow({ where: { novelId: novel } });
    await owner.novelTagState.update({ where: { novelId: novel }, data: { currentAutoRunId: null } });
    expect((await projection.loadPublicTaxonomyByNovelIds(web, [novel], "en", env)).get(novel)?.map(t => t.slug)).toEqual(["mapped-b", "mapped-a"]);
    const otherRun = await owner.tagClassificationRun.create({ data: { novelId: novel, ...metadata, contentSha256: hash, requestId: randomUUID(), resultSchemaVersion: 1 } });
    await owner.novelTagState.update({ where: { novelId: novel }, data: { currentAutoRunId: otherRun.id } });
    expect((await projection.loadPublicTaxonomyByNovelIds(web, [novel], "en", env)).get(novel)?.map(t => t.slug)).toEqual(["mapped-b", "mapped-a"]);
    await owner.novelTagState.update({ where: { novelId: novel }, data: { currentAutoRunId: original.currentAutoRunId, mode: "manual" } });
    expect((await projection.loadPublicTaxonomyByNovelIds(web, [novel], "en", env)).get(novel)).toBeUndefined();
    await owner.novelCanonicalTag.create({ data: { novelId: novel, canonicalTagId: tags[3], source: "manual", decidedBy: admin, evidence: {}, evidenceSchemaVersion: 1 } });
    expect((await projection.loadPublicTaxonomyByNovelIds(web, [novel], "en", env)).get(novel)?.map(t => t.slug)).toEqual(["text-a"]);
    await owner.novelCanonicalTag.deleteMany({ where: { novelId: novel, source: "manual" } });
    await owner.novelTagState.update({ where: { novelId: novel }, data: { mode: "automatic" } });
  });
  it("explicit segments exclude same-locale stock, filter initialized/manual, and replay concurrently", async () => {
    const stock = await seedNovel(), created = await Promise.all(Array.from({ length: 5 }, seedNovel));
    const batchId = randomUUID();
    const before = await owner.genericTask.count();
    await Promise.all([0, 1].map(() => initializeCreatedNovelBatchTags(created, batchId, { db: web, env, ...dependencies(), segmentSize: 2 })));
    expect(await owner.genericTask.count()).toBe(before + 3);
    const rows = await owner.genericTaskItem.findMany({ where: { targetId: { in: [...created, stock] } } });
    expect(rows.map(row => row.targetId).sort()).toEqual(created.sort());
    await owner.novelTagState.create({ data: { novelId: created[0], mode: "manual" } });
    await snapshot(created[1], []);
    const filtered = await createTaggingAutoClassifyTask({ db: web, env, dependencies: dependencies(), lifecycle: "initialize_missing", mode: "apply", scope: { kind: "novels", novelIds: created }, requestId: randomUUID() });
    expect(filtered.eligibleCount).toBe(3);
  });
  it("committed web creation gets a real text snapshot through worker_app", async () => {
    const sourceId = await seedSource();
    const result = await materializeNovelFromSourceItem(web, { novelSourceItemId: sourceId, mode: "apply", actor: { type: "admin", adminId: admin }, requestId: randomUUID() });
    expect(result.outcome).toBe("created"); if (result.outcome !== "created") throw new Error("creation failed");
    await initializeCreatedNovelTags(result.novelId, { db: web, env, ...dependencies() });
    const item = await owner.genericTaskItem.findFirstOrThrow({ where: { targetId: result.novelId } });
    const handlers = createTaggingWorkerHandlers(worker, { env, ...dependencies() });
    await processOneWorkerCycle({ prisma: worker, workerId: "wo7-auto", handlers, allowlist: buildWorkerAllowlist("tagging.auto_classify", handlers), signal: new AbortController().signal, claimTarget: { family: "generic", taskId: item.taskId, itemId: item.id } });
    expect(await web.novelTagState.findUnique({ where: { novelId: result.novelId } })).toMatchObject({ currentAutoRunId: expect.any(String) });
    expect((await projection.loadPublicTaxonomyByNovelIds(web, [result.novelId], "en", env)).get(result.novelId)?.map(t => t.slug)).toEqual(["text-z"]);
  });
  it("worker commit hook waits for whole child, ignores already-existing results, and isolates enqueue failure", async () => {
    const sources = await Promise.all([seedSource(), seedSource()]);
    const task = await owner.genericTask.create({ data: { taskType: "novel.materialize.v1", mode: "apply", status: "pending", operationScopeHash: randomUUID(), requestToken: randomUUID(), totalCount: 2, items: { create: sources.map(id => ({ targetType: "novel_source_item", targetId: id, payload: { novelSourceItemId: id, channelAppId: app, actorId: admin, requestId: randomUUID(), expiresAt: new Date(Date.now() + 60000).toISOString() } })) } } });
    const handlers = createNovelMaterializeWorkerHandlers(worker);
    const hook = vi.fn((taskId: string) => initializeMaterializedTaskTags(worker, taskId, { env, ...dependencies() }));
    const registry = { ...handlers, "novel.materialize.v1": { ...handlers["novel.materialize.v1"], afterItemCommit: hook } };
    const options = { prisma: worker, workerId: "wo7-materialize", handlers: registry, allowlist: buildWorkerAllowlist("novel.materialize.v1", registry), signal: new AbortController().signal };
    const before = await owner.genericTask.count();
    await processOneWorkerCycle(options); expect(await owner.genericTask.count()).toBe(before);
    await processOneWorkerCycle(options); expect(await owner.genericTask.count()).toBe(before + 1);
    expect(hook).toHaveBeenCalledTimes(2);
    expect(await owner.genericTaskItem.count({ where: { taskId: task.id, status: "success" } })).toBe(2);
    await initializeMaterializedTaskTags(worker, task.id, { env, ...dependencies() });
    expect(await owner.genericTask.count()).toBe(before + 1);
    const sourceId = await seedSource();
    const result = await materializeNovelFromSourceItem(web, { novelSourceItemId: sourceId, mode: "apply", actor: { type: "admin", adminId: admin }, requestId: randomUUID() });
    if (result.outcome !== "created") throw new Error("creation failed");
    const broken = new Proxy(web, { get(target, key) { if (key === "genericTask") throw new Error("queue unavailable"); return Reflect.get(target, key); } });
    await expect(initializeCreatedNovelTags(result.novelId, { db: broken, env, ...dependencies() })).resolves.toBeUndefined();
    expect(await owner.novel.findUnique({ where: { id: result.novelId } })).not.toBeNull();
  });

  it("records isolated 25-book classification throughput for the future approval checklist", async () => {
    const ids = await Promise.all(Array.from({ length: 25 }, seedNovel));
    const started = performance.now();
    const queued = await createTaggingAutoClassifyTask({ db: web, env, dependencies: dependencies(),
      lifecycle: "initialize_missing", mode: "apply", scope: { kind: "novels", novelIds: ids }, requestId: randomUUID() });
    if (!("taskId" in queued)) throw new Error("missing throughput task");
    const enqueueMs = performance.now() - started;
    const items = await owner.genericTaskItem.findMany({ where: { taskId: queued.taskId }, select: { id: true } });
    const handlers = createTaggingWorkerHandlers(worker, { env, ...dependencies() });
    const classifiedAt = performance.now();
    for (const item of items) {
      await processOneWorkerCycle({ prisma: worker, workerId: "wo7-throughput", handlers,
        allowlist: buildWorkerAllowlist("tagging.auto_classify", handlers), signal: new AbortController().signal,
        claimTarget: { family: "generic", taskId: queued.taskId, itemId: item.id },
      });
    }
    const classifyMs = performance.now() - classifiedAt;
    expect(await owner.genericTaskItem.count({ where: { taskId: queued.taskId, status: "success" } })).toBe(25);
    console.log(`WO7_THROUGHPUT novels=25 locale=en fixture_keywords=1 enqueue_ms=${enqueueMs.toFixed(2)} classify_ms=${classifyMs.toFixed(2)} books_per_second=${(25000 / classifyMs).toFixed(2)}`);
  });

  it("EXPLAIN bounds source probes at representative volume with and without small-table statistics", async () => {
    await verifyPublicAutoPlans(owner, web, { app, admin, mappedTag: tags[0], textTag: tags[2], templateNovel: novel, rawScope });
  }, 180_000);

});
