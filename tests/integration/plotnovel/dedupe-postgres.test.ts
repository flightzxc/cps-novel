/**
 * v0.6.0 E：同名去重——真实库、真实角色。
 * 口令码模式剧场（PlotNovel）的书，其它剧场（MoboReader）里已有同语种、同规范化书名的书，就不生成。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { normalizeNovelTitle } from "@/lib/novel/novel-identity";
import { listNovelsForArticleGenerate, resolveArticleGenerateAdmissions } from "@/server/content-creation/eligibility";

import {
  MOBO_AGENCY,
  PLOT_AGENCY,
  analyst,
  assertDisposableDatabase,
  enabled,
  ids,
  owner,
  scheduler,
  seedPublished,
  seedTheaters,
  truncateDatabase,
  web,
  worker,
} from "./support";

async function plotBook(externalBookId: string, title: string, locale = "en") {
  return seedPublished({
    appId: ids.plotApp, externalBookId, title, locale, agencyId: PLOT_AGENCY, promo: { upstreamCode: "960031" }, withoutArticle: true,
  });
}

async function moboBook(externalBookId: string, title: string, options: { locale?: string; titleNormalized?: string | null } = {}) {
  const book = await seedPublished({
    appId: ids.moboApp, externalBookId, title, locale: options.locale ?? "en", agencyId: MOBO_AGENCY,
    promo: { upstreamCode: "M", webUrl: "https://example.test/read" }, withoutArticle: true,
  });
  await owner.novel.update({
    where: { id: book.novel.id },
    data: { titleNormalized: options.titleNormalized === undefined ? normalizeNovelTitle(title) : options.titleNormalized },
  });
  return book;
}

async function admissionsFor(novelIds: string[]) {
  const rows = await owner.novel.findMany({
    where: { id: { in: novelIds } },
    select: { id: true, title: true, locale: true, businessId: true, updatedAt: true, deletedAt: true, articles: { select: { id: true, locale: true, deletedAt: true } } },
  });
  return resolveArticleGenerateAdmissions(worker, novelIds, rows);
}

describe.skipIf(!enabled).sequential("v0.6.0 E：同名去重（真实库）", () => {
  beforeAll(assertDisposableDatabase);
  beforeEach(async () => { await truncateDatabase(); await seedTheaters(); });
  afterAll(async () => {
    await Promise.all([owner.$disconnect(), web.$disconnect(), worker.$disconnect(), scheduler.$disconnect(), analyst.$disconnect()]);
  });

  it("同语种 + 同规范化书名（大小写 / 标点不同也算）→ PlotNovel 那本不可生成；MoboReader 那本照常可生成", async () => {
    const plot = await plotBook("p1", "Fifty Million For Ten Years");
    const mobo = await moboBook("m1", "fifty million, for ten years!");
    const admissions = await admissionsFor([plot.novel.id, mobo.novel.id]);
    expect(admissions.get(plot.novel.id)).toMatchObject({ canGenerate: false, promoOutcome: "ready", blockedReason: "duplicate_title_in_link_theater" });
    expect(admissions.get(mobo.novel.id)).toMatchObject({ canGenerate: true });
  });

  it("语种不同 / 对侧书已删除 / 对侧书目已软删除 / PlotNovel 之间同名 → 都不算重复", async () => {
    const plotFr = await plotBook("p-fr", "Same Title", "fr");
    await owner.channelApp.update({ where: { id: ids.plotApp }, data: { config: { promoMode: "code", agencyIds: [PLOT_AGENCY], codeModeLocales: ["en", "fr"] } } });
    await moboBook("m-en", "Same Title", { locale: "en" }); // 语种不同
    const plotDeleted = await plotBook("p-del", "Deleted Twin");
    const moboDeleted = await moboBook("m-del", "Deleted Twin");
    await owner.novel.update({ where: { id: moboDeleted.novel.id }, data: { deletedAt: new Date() } });
    const plotStale = await plotBook("p-stale", "Stale Twin");
    const moboStale = await moboBook("m-stale", "Stale Twin");
    await owner.novelSourceItem.update({ where: { id: moboStale.source.id }, data: { deletedAt: new Date() } });
    const plotA = await plotBook("p-a", "Plot Pair");
    const plotB = await plotBook("p-b", "plot pair");

    const admissions = await admissionsFor([plotFr.novel.id, plotDeleted.novel.id, plotStale.novel.id, plotA.novel.id, plotB.novel.id]);
    for (const id of [plotFr.novel.id, plotDeleted.novel.id, plotStale.novel.id, plotA.novel.id, plotB.novel.id]) {
      expect(admissions.get(id), id).toMatchObject({ canGenerate: true });
    }
  });

  it("对侧 title_normalized 为 NULL（回填之前的老书）：书名忽略大小写相等时仍判重复；只差标点的会漏（已知限制，手册要求先回填）", async () => {
    const plotCase = await plotBook("p-case", "Dear Doctor");
    await moboBook("m-case", "DEAR DOCTOR", { titleNormalized: null });
    const plotPunct = await plotBook("p-punct", "Dear Husband");
    await moboBook("m-punct", "Dear Husband!!", { titleNormalized: null });
    const admissions = await admissionsFor([plotCase.novel.id, plotPunct.novel.id]);
    expect(admissions.get(plotCase.novel.id)).toMatchObject({ canGenerate: false, blockedReason: "duplicate_title_in_link_theater" });
    expect(admissions.get(plotPunct.novel.id)).toMatchObject({ canGenerate: true }); // 已知限制：回填后才会命中
  });

  it("只影响生成候选，不改已存在的数据：书、文章、推广链接都原样", async () => {
    const plot = await plotBook("p1", "Fifty Million For Ten Years");
    await moboBook("m1", "Fifty Million For Ten Years");
    const before = JSON.stringify([
      await owner.novel.findMany({ orderBy: { id: "asc" } }),
      await owner.promoLink.findMany({ orderBy: { id: "asc" } }),
      await owner.article.count(),
    ]);
    await admissionsFor([plot.novel.id]);
    await listNovelsForArticleGenerate(web, { eligibleOnly: true, showIneligible: true });
    expect(JSON.stringify([
      await owner.novel.findMany({ orderBy: { id: "asc" } }),
      await owner.promoLink.findMany({ orderBy: { id: "asc" } }),
      await owner.article.count(),
    ])).toBe(before);
  });

  it("后台批量生成列表（web_app）：重复的那本带着原因标签出现，且不可生成", async () => {
    const plot = await plotBook("p1", "Fifty Million For Ten Years");
    const unique = await plotBook("p2", "Only On PlotNovel");
    await moboBook("m1", "Fifty Million For Ten Years");
    const listing = await listNovelsForArticleGenerate(web, { eligibleOnly: true, showIneligible: true });
    expect(listing.rows.find((row) => row.novelId === plot.novel.id)).toMatchObject({
      canGenerateArticle: false, promoReady: true, generateBlockedReason: "duplicate_title_in_link_theater",
    });
    expect(listing.rows.find((row) => row.novelId === unique.novel.id)).toMatchObject({ canGenerateArticle: true });
  });
});
