/** Disposable PG16 only; actual roles, services and worker fencing. No upstream HTTP. */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveArticleGenerateAdmissions } from "@/server/content-creation/eligibility";
import { resolveReadyPromoLinksForNovels } from "@/server/content-creation/promo";
import { enqueueArticleGenerateBatch } from "@/lib/tasks/article-generate";
import { publishArticlesBatch } from "@/server/publish-gate/service";
import { getIndexNowDeliveryControlState } from "@/lib/indexnow/delivery-control";
import { getAdminSitemapState } from "@/server/sitemap-admin/service";
import { buildWorkerAllowlist } from "@/lib/tasks";
import { processOneWorkerCycle } from "../../../worker/runtime/worker";
import { createArticleGenerateWorkerHandlers } from "../../../worker/handlers/article-generate";
import { chunksFor, generationRequest, parseArgs, runCommand, sha256, readOnly, type Api, type Manifest } from "../../../scripts/ops/plotnovel-bulk-generate-publish";
import { owner, web, worker, scheduler, analyst, enabled, ids, seedTheaters, seedPublished, truncateDatabase, assertDisposableDatabase } from "./support";
const ACTOR = "71f0e655-0640-4f07-bcbb-041f027fa7cb";
const api: Api = { admissions: resolveArticleGenerateAdmissions, promos: resolveReadyPromoLinksForNovels, generate: enqueueArticleGenerateBatch, publish: publishArticlesBatch, control: getIndexNowDeliveryControlState, sitemap: getAdminSitemapState };
let dir: string, file: string, digest: string, manifest: Manifest;
const emit = () => {};
const args = (cmd: string, extra: string[] = []) => parseArgs([cmd, "--actor-id", ACTOR, ...(cmd === "plan" ? ["--output", file] : ["--manifest", file, "--manifest-sha256", digest, "--wave", "1"]), ...(["generate", "publish"].includes(cmd) ? ["--confirm", `PLOTNOVEL_BULK_${cmd.toUpperCase()}`] : []), ...extra]);
async function plan() { await runCommand(args("plan"), web, api, emit); const bytes = readFileSync(file); digest = sha256(bytes); manifest = JSON.parse(bytes.toString()); }
async function book(title: string, appId: string = ids.plotApp, locale = "en") { return seedPublished({ appId, externalBookId: randomUUID(), title, locale, agencyId: appId === ids.plotApp ? "1351" : "3366", withoutArticle: true, novelStatus: "draft", promo: appId === ids.plotApp ? { upstreamCode: "fixture-only" } : { webUrl: "https://example.test/read" } }); }
async function drain() {
  const handlers = createArticleGenerateWorkerHandlers(worker), allowlist = buildWorkerAllowlist("article.generate.v1", handlers);
  for (let i = 0; i < 1000; i++) if (!await processOneWorkerCycle({ prisma: worker, workerId: "plot-bulk-test", handlers, allowlist, signal: new AbortController().signal })) return;
  throw new Error("worker_not_idle");
}
async function writes() { return { tasks: await owner.genericTask.count(), articles: await owner.article.count(), audits: await owner.operationAudit.count() }; }
describe.skipIf(!enabled).sequential("PlotNovel bulk ops: real web_app plan -> generate -> publish -> status", () => {
  beforeAll(assertDisposableDatabase);
  beforeEach(async () => {
    if (dir) rmSync(dir, { recursive: true, force: true }); dir = mkdtempSync(path.join(os.tmpdir(), "plot-bulk-db-")); file = path.join(dir, "manifest.json");
    process.env.SITEMAP_STATIC_DIR = path.join(dir, "sitemaps");
    Object.assign(process.env, { FEATURE_INDEXNOW_OUTBOX: "true", INDEXNOW_OUTBOX_ALLOW_WRITE: "true", FEATURE_SITEMAP_AUTO_REFRESH: "true", SITEMAP_AUTO_REFRESH_ALLOW_WRITE: "true", SITE_URL: "https://plot-bulk.example", MOBOREADER_PREVIEW_SOURCE_APP_CODES: "moboreader,plotnovel" });
    await truncateDatabase(); await seedTheaters();
    await owner.channelCapability.create({ data: { channelAppId: ids.plotApp, capabilityKey: "claimPromo", status: "registered_disabled", sideEffecting: true, evidenceLevel: "REGISTERED_ONLY" } });
    await owner.adminIdentity.create({ data: { id: ACTOR, username: "admin", passwordHash: "scrypt$v1$fixture-not-authenticatable", role: "super_admin", status: "active" } });
    await owner.articleTemplate.create({ data: { templateKey: "bulk-fixture-en", templateName: "Bulk fixture", locale: "en", version: 1, status: "active", applicableArticleType: "novel_article", bodyTemplate: '<h1>{novel_title}</h1><p>{novel_description}</p><a href="{promo_redirect_url}">Read</a>', seoTemplate: { title: "{novel_title}", metaDescription: "{novel_description}" } } });
  });
  afterAll(async () => { if (dir) rmSync(dir, { recursive: true, force: true }); await Promise.all([owner, web, worker, scheduler, analyst].map(x => x.$disconnect())); });
  it("readonly plan excludes MoboReader and same-title PlotNovel; real worker generates and web publishes only its drafts; replay does not duplicate anything", async () => {
    const one = await book("Eligible One"), two = await book("Eligible Two"); await book("Duplicate Title"); const mobo = await book("Duplicate Title", ids.moboApp); await book("Not English", ids.plotApp, "fr");
    const before = await writes(); await plan(); expect(await writes()).toEqual(before); expect(manifest.eligibleCount).toBe(2); expect(manifest.blockedReasons.duplicate_title_in_link_theater).toBe(1);
    const idsInPlan = manifest.waves.flatMap(w => w.chunks.flatMap(c => c.novelIds)); expect(idsInPlan.sort()).toEqual([one.novel.id, two.novel.id].sort()); expect(idsInPlan).not.toContain(mobo.novel.id); expect(statSync(file).mode & 0o777).toBe(0o600);
    await runCommand(args("generate"), web, api, emit); await drain(); const afterGenerate = await writes(); expect(afterGenerate.articles).toBe(2);
    await runCommand(args("generate"), web, api, emit); expect(await writes()).toEqual(afterGenerate);
    await runCommand(args("publish"), web, api, emit); const afterPublish = await writes(); expect(await owner.article.count({ where: { status: "published" } })).toBe(2); expect(await owner.indexNowOutbox.count()).toBe(2);
    await runCommand(args("publish"), web, api, emit); expect(await writes()).toEqual(afterPublish);
    const status = await runCommand(args("status"), web, api, emit); expect(status).toMatchObject({ drafts: 0, published: 2, generation: { expected: 2, success: 2, failed: 0 }, indexnow: { accepted: 0, pending: 2 }, readyForNextWave: false }); expect(await writes()).toEqual(afterPublish);
  }, 60000);
  it("readonly transactions actually reject writes; worker_app and a different admin are refused before writes", async () => {
    await book("A"); await plan(); const before = await writes();
    await expect(readOnly(web, tx => tx.novel.updateMany({ data: { status: "draft" } }))).rejects.toThrow();
    await expect(runCommand(args("status"), worker, api, emit)).rejects.toThrow("web_app_readonly_required");
    await owner.adminIdentity.update({ where: { id: ACTOR }, data: { role: "operator" } });
    await expect(runCommand(args("generate"), web, api, emit)).rejects.toThrow("owner_admin_refused"); expect(await writes()).toEqual(before);
  });
  it("bad digest/confirmation and a checksum-valid manifest with a MoboReader ID all cause zero business writes", async () => {
    await book("A"); const mobo = await book("Mobo", ids.moboApp); await plan(); const before = await writes();
    await expect(runCommand({ ...args("generate"), digest: "0".repeat(64) }, web, api, emit)).rejects.toThrow("manifest_sha256_mismatch");
    await expect(runCommand({ ...args("generate"), confirm: "YES" }, web, api, emit)).rejects.toThrow("confirmation_refused");
    manifest.waves = chunksFor([mobo.novel.id]); const bytes = JSON.stringify(manifest); writeFileSync(file, bytes); digest = sha256(bytes);
    await expect(runCommand(args("generate"), web, api, emit)).rejects.toThrow("manifest_foreign_or_missing_novel"); expect(await writes()).toEqual(before);
  });
  it("a precommitted first block is recovered under the same request ID without duplicate tasks/items", async () => {
    for (let i = 0; i < 201; i++) await book(`Resume ${i}`); await plan();
    await enqueueArticleGenerateBatch(web, { actorId: ACTOR, novelIds: manifest.waves[0].chunks[0].novelIds, requestId: generationRequest(1, 1) });
    await runCommand(args("generate"), web, api, emit); expect(await owner.genericTask.count({ where: { taskType: "article.generate.v1" } })).toBe(2); expect(await owner.genericTaskItem.count()).toBe(201);
    await runCommand(args("generate"), web, api, emit); expect(await owner.genericTaskItem.count()).toBe(201);
  }, 60000);
  it("an external draft is never adopted even if its novel is in the manifest", async () => {
    const a = await book("A"); await plan();
    await owner.article.create({ data: { novelId: a.novel.id, promoLinkId: a.promo.id, locale: "en", slug: "foreign", publicPageShortId: "foreign1", title: "Foreign", body: "Foreign body", status: "draft" } });
    const before = await writes(); await expect(runCommand(args("publish"), web, api, emit)).rejects.toThrow("foreign_or_changed_article"); expect(await writes()).toEqual(before);
  });
  it("partial publication with a real first commit and a second rejection is journaled and cannot automatically retry", async () => {
    await book("One"); await book("Two"); await plan(); await runCommand(args("generate"), web, api, emit); await drain();
    const partial: Api = { ...api, publish: async (db, input) => {
      await owner.novel.update({ where: { id: (await owner.article.findUniqueOrThrow({ where: { id: input.articleIds[1] } })).novelId! }, data: { status: "takedown" } });
      return publishArticlesBatch(db, input);
    } };
    await expect(runCommand(args("publish"), web, partial, emit)).rejects.toThrow("publish_stopped");
    expect(await owner.article.count({ where: { status: "published" } })).toBe(1);
    const lines = readFileSync(file + ".execution.jsonl", "utf8").trim().split("\n").map(x => JSON.parse(x));
    expect(lines).toEqual(expect.arrayContaining([expect.objectContaining({ event: "publish", published: 1, rejected: 1 }), expect.objectContaining({ event: "stop", code: "publish_stopped" })]));
    const before = await writes(); await expect(runCommand(args("publish"), web, api, emit)).rejects.toThrow("prior_stop_or_journal_mismatch"); expect(await writes()).toEqual(before);
  }, 60000);
  it("admission drift, reopened claim and concurrent operator lock are fail closed", async () => {
    const a = await book("A"); await plan(); await owner.promoLink.update({ where: { id: a.promo.id }, data: { status: "failed" } }); const before = await writes();
    await expect(runCommand(args("generate"), web, api, emit)).rejects.toThrow("resolved_promo_scope_changed"); expect(await writes()).toEqual(before);
    await owner.promoLink.update({ where: { id: a.promo.id }, data: { status: "fetched" } });
    mkdirSync(file + ".lock"); await expect(runCommand(args("generate"), web, api, emit)).rejects.toThrow(); expect(existsSync(file + ".lock")).toBe(true); rmSync(file + ".lock", { recursive: true });
    await owner.channelCapability.update({ where: { channelAppId_capabilityKey: { channelAppId: ids.plotApp, capabilityKey: "claimPromo" } }, data: { status: "enabled" } });
    await expect(runCommand(args("status"), web, api, emit)).rejects.toThrow("claim_must_remain_disabled"); expect(await writes()).toEqual(before);
  });
  it("status distinguishes normal pending delivery from a missing outbox without writing", async () => {
    await book("Status coverage"); await plan(); await runCommand(args("generate"), web, api, emit); await drain(); await runCommand(args("publish"), web, api, emit);
    const pending = await runCommand(args("status"), web, api, emit);
    expect(pending).toMatchObject({ indexnow: { accepted: 0, pending: 1, missing: 0 }, stopReasons: [] });
    await owner.indexNowOutbox.deleteMany(); const before = await writes();
    expect(await runCommand(args("status"), web, api, emit)).toMatchObject({ indexnow: { accepted: 0, pending: 0, missing: 1 }, stopReasons: ["indexnow_outbox_missing"] });
    expect(await writes()).toEqual(before);
  }, 60000);
  it("previously valid preview is pinned in plan and counted separately without requiring a new task", async () => {
    const a = await book("Already previewed");
    await owner.novelPreviewPolicy.create({ data: { novelId: a.novel.id, materializedChapterCount: 1, maxMaterializedChapters: 3, displayAuthorized: true } });
    await owner.novelChapter.create({ data: { novelId: a.novel.id, canonicalChapterNumber: 1, status: "preview", content: { create: { body: "Fixture chapter content", charCount: 23, contentHash: sha256("Fixture chapter content"), materializedAt: new Date() } } } });
    await plan(); expect(manifest.existingPreviewNovelIds).toEqual([a.novel.id]);
    await runCommand(args("generate"), web, api, emit); await drain(); await runCommand(args("publish"), web, api, emit);
    expect(await runCommand(args("status"), web, api, emit)).toMatchObject({ preview: { expected: 1, alreadyValid: 1, completed: 1, pending: 0, missing: 0 } });
  }, 60000);

});
