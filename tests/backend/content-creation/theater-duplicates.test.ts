/**
 * v0.6.0 E：同名去重——口令码模式剧场（PlotNovel）的书，其它剧场（MoboReader）里已有同语种、同规范化书名的书，
 * 就不生成（Owner 10-14 拍板第 3 项）。只影响生成候选，不改已存在的数据。
 */
import { describe, expect, it } from "vitest";

import { articleGenerateBlockedReasonLabel } from "@/domain/article-generation";
import { normalizeNovelTitle } from "@/lib/novel/novel-identity";
import { resolveArticleGenerateAdmissions } from "@/server/content-creation/eligibility";
import { findDuplicatesInLinkTheaters } from "@/server/content-creation/theater-duplicates";

const CODE_APP = "app-plotnovel";
const CODE_CONFIG = { promoMode: "code", agencyIds: ["1351"], codeModeLocales: ["en"] };

type OtherNovel = { locale: string; title: string; titleNormalized: string | null };

function fakeDb(others: OtherNovel[], seen: { where?: unknown; calls: number } = { calls: 0 }) {
  return {
    seen,
    db: {
      channelApp: { findMany: async () => [{ id: "app-moboreader", config: {} }, { id: CODE_APP, config: CODE_CONFIG }] },
      novel: {
        findMany: async (args: { where: unknown }) => {
          seen.calls += 1;
          seen.where = args.where;
          // 假库不重做数据库的筛选，把全部"其它剧场的书"原样给出：判定必须由被测代码自己比对，而不是依赖数据库预筛。
          return others;
        },
      },
    } as never,
  };
}

describe("findDuplicatesInLinkTheaters", () => {
  it("同语种 + 同规范化书名 → 重复；大小写、标点、全角差异按 normalizeNovelTitle 抹平", async () => {
    const { db } = fakeDb([{ locale: "en", title: "Fifty Million, For Ten Years!", titleNormalized: normalizeNovelTitle("Fifty Million, For Ten Years!") }]);
    const duplicates = await findDuplicatesInLinkTheaters(db, [
      { id: "same", locale: "en", title: "fifty million for ten years" },
      { id: "other", locale: "en", title: "A Different Book" },
    ]);
    expect([...duplicates]).toEqual(["same"]);
  });

  it("语种不同不算重复", async () => {
    const { db } = fakeDb([{ locale: "fr", title: "Same Title", titleNormalized: "same title" }]);
    expect((await findDuplicatesInLinkTheaters(db, [{ id: "a", locale: "en", title: "Same Title" }])).size).toBe(0);
  });

  it("对侧 title_normalized 列为 NULL（回填之前的老书）：现算书名比对，同样判重复", async () => {
    const { db } = fakeDb([{ locale: "en", title: "Same  Title!!", titleNormalized: null }]);
    expect([...(await findDuplicatesInLinkTheaters(db, [{ id: "a", locale: "en", title: "same title" }]))]).toEqual(["a"]);
  });

  it("预筛条件：不含自己、对侧必须在非口令码剧场下有未删除的书目；NULL 列的退路按书名忽略大小写相等", async () => {
    const { db, seen } = fakeDb([]);
    await findDuplicatesInLinkTheaters(db, [{ id: "a", locale: "en", title: "Same Title" }]);
    expect(seen.where).toMatchObject({
      deletedAt: null,
      id: { notIn: ["a"] },
      sourceItems: { some: { deletedAt: null, channelAppId: { notIn: [CODE_APP] } } },
      OR: [
        { locale: "en", titleNormalized: { in: ["same title"] } },
        { locale: "en", titleNormalized: null, title: { in: ["Same Title"], mode: "insensitive" } },
      ],
    });
  });

  it("空书名 / 规范化后为空的书不参与（不会和任何东西撞）；没有候选时不发查询", async () => {
    const { db, seen } = fakeDb([{ locale: "en", title: "", titleNormalized: "" }]);
    expect((await findDuplicatesInLinkTheaters(db, [{ id: "a", locale: "en", title: "  ?!  " }])).size).toBe(0);
    expect(seen.calls).toBe(0);
    expect((await findDuplicatesInLinkTheaters(db, [])).size).toBe(0);
  });

  it("后台文案按拍板措辞", () => {
    expect(articleGenerateBlockedReasonLabel("duplicate_title_in_link_theater")).toBe("MoboReader 已有同名书");
  });
});

describe("resolveArticleGenerateAdmissions：同名去重接入准入判定", () => {
  type Row = Parameters<typeof resolveArticleGenerateAdmissions>[2][number];
  const row = (id: string, title: string, articles: Row["articles"] = []): Row => ({
    id, title, locale: "en", businessId: `biz-${id}`, updatedAt: new Date("2026-10-14T00:00:00Z"), deletedAt: null, articles,
  });

  function promoDb(input: { codeNovelIds: string[]; linkNovelIds: string[]; duplicateOtherTitles: OtherNovel[] }) {
    const promoRow = (novelId: string, config: unknown) => ({
      id: `promo-${novelId}`, novelId, status: "fetched", webUrl: config === CODE_CONFIG ? null : "https://x.test",
      appUrl: null, upstreamCode: "960031", fetchedAt: new Date(), publicRedirectCode: `r-${novelId}`,
      channelApp: { config }, novel: { locale: "en" },
    });
    const { db, seen } = fakeDb(input.duplicateOtherTitles);
    return {
      seen,
      db: {
        ...(db as object),
        promoLink: {
          findMany: async () => [
            ...input.codeNovelIds.map((id) => promoRow(id, CODE_CONFIG)),
            ...input.linkNovelIds.map((id) => promoRow(id, { promoMode: "link" })),
          ],
          count: async () => 0,
          groupBy: async () => [],
        },
      } as never,
    };
  }

  it("口令码模式的书有同名 MoboReader 书 → 不可生成，原因是 duplicate_title_in_link_theater（promoReady 仍为 ready）", async () => {
    const { db } = promoDb({
      codeNovelIds: ["dup", "unique"], linkNovelIds: [],
      duplicateOtherTitles: [{ locale: "en", title: "Fifty Million", titleNormalized: "fifty million" }],
    });
    const admissions = await resolveArticleGenerateAdmissions(db, ["dup", "unique"], [row("dup", "Fifty Million"), row("unique", "Only On PlotNovel")]);
    expect(admissions.get("dup")).toMatchObject({ canGenerate: false, promoOutcome: "ready", blockedReason: "duplicate_title_in_link_theater" });
    expect(admissions.get("unique")).toMatchObject({ canGenerate: true, promoOutcome: "ready" });
  });

  it("link 模式的书（MoboReader 自己）永远不被去重，也不多发任何查询", async () => {
    const { db, seen } = promoDb({
      codeNovelIds: [], linkNovelIds: ["mobo"],
      duplicateOtherTitles: [{ locale: "en", title: "Fifty Million", titleNormalized: "fifty million" }],
    });
    const admissions = await resolveArticleGenerateAdmissions(db, ["mobo"], [row("mobo", "Fifty Million")]);
    expect(admissions.get("mobo")).toMatchObject({ canGenerate: true });
    expect(seen.calls).toBe(0);
  });

  it("已有文章的书原因优先（already_exists），不被去重覆盖", async () => {
    const { db } = promoDb({
      codeNovelIds: ["dup"], linkNovelIds: [],
      duplicateOtherTitles: [{ locale: "en", title: "Fifty Million", titleNormalized: "fifty million" }],
    });
    const admissions = await resolveArticleGenerateAdmissions(db, ["dup"], [row("dup", "Fifty Million", [{ id: "a1", locale: "en", deletedAt: null }])]);
    expect(admissions.get("dup")).toMatchObject({ canGenerate: false, blockedReason: "already_exists" });
  });

  it("口令码模式的书、但需要查重的库句柄不可用 → 抛错（宁可失败也不静默跳过去重）", async () => {
    const { db } = promoDb({ codeNovelIds: ["dup"], linkNovelIds: [], duplicateOtherTitles: [] });
    const withoutNovel = { promoLink: (db as unknown as { promoLink: unknown }).promoLink } as never;
    await expect(resolveArticleGenerateAdmissions(withoutNovel, ["dup"], [row("dup", "X")])).rejects.toThrow("duplicate_check_db_unavailable");
  });
});
