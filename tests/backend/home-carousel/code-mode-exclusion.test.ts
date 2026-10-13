/**
 * v0.6.0：首页轮播显式排除口令码模式剧场（PlotNovel）的书——Owner 10-14 拍板第 4 项。
 * 计算（自动候选）、手动位、前台读取（快照与回退）三处都要挡住；没有口令码剧场时三处与改动前逐字相同。
 */
import { describe, expect, it } from "vitest";

import { getHomeCarouselItems } from "@/lib/site/home-carousel-service";
import { computeHomeCarouselInTx, upsertHomeCarouselManualSlot } from "@/server/home-carousel";
import { excludeCodeModePromoWhere, loadCodeModeChannelAppIds } from "@/server/publication/code-mode-theaters";

import { FakeHomeCarouselDb, NOW as FIXTURE_NOW, authFixture, authorizeAction, dependencies, type FakeArticle } from "./support";

const NOW = new Date("2026-09-05T19:00:00.000Z");
const DAY = 86_400_000;
const CODE_APP = "app-plotnovel";
const LINK_APP = "app-moboreader";
const CODE_CONFIG = { promoMode: "code", agencyIds: ["1351"], codeModeLocales: ["en"] };

function article(id: string, promoChannelAppId: string | undefined, ageDays: number): FakeArticle {
  return {
    id, novelId: `novel-${id}`, locale: "en", status: "published", deletedAt: null,
    publishedAt: new Date(NOW.getTime() - ageDays * DAY), updatedAt: new Date(NOW.getTime() - ageDays * DAY),
    novel: { title: `Novel ${id}`, status: "published", deletedAt: null, coverUrl: "https://cdn.example.com/cover.jpg" },
    ...(promoChannelAppId ? { promoChannelAppId } : {}),
  };
}

describe("loadCodeModeChannelAppIds / excludeCodeModePromoWhere", () => {
  it("只挑 promoMode 恰为 code 的剧场（含停用的）；旧记录 config = {} 与 link 都不算", async () => {
    const db = {
      channelApp: {
        findMany: async () => [
          { id: "a", config: {} },
          { id: "b", config: { promoMode: "link" } },
          { id: "c", config: CODE_CONFIG },
          { id: "d", config: { promoMode: "Code" } },
          { id: "e", config: null },
        ],
      },
    };
    expect(await loadCodeModeChannelAppIds(db as never)).toEqual(["c"]);
  });

  it("没有口令码剧场时是空条件（查询逐字不变）；有时是剧场编号 notIn，而不是 JSON 路径过滤", () => {
    expect(excludeCodeModePromoWhere([])).toEqual({});
    expect(excludeCodeModePromoWhere(["c"])).toEqual({ promoLink: { is: { channelAppId: { notIn: ["c"] } } } });
  });
});

describe("自动候选计算（computeHomeCarouselInTx）", () => {
  it("口令码模式剧场的书不进候选，也不进快照；其它书不受影响", async () => {
    const db = new FakeHomeCarouselDb();
    db.channelApps = [{ id: LINK_APP, config: { promoMode: "link" } }, { id: CODE_APP, config: CODE_CONFIG }];
    db.seedArticle(article("plot-1", CODE_APP, 1));
    db.seedArticle(article("plot-2", CODE_APP, 2));
    db.seedArticle(article("mobo-1", LINK_APP, 3));
    db.seedArticle(article("legacy", undefined, 4));
    await computeHomeCarouselInTx(db.asTransactionClient(), { locale: "en", source: "manual", now: NOW });
    expect(db.serving.map((row) => row.novelId).sort()).toEqual(["novel-legacy", "novel-mobo-1"]);
    expect(db.candidates.map((row) => row.novelId).sort()).toEqual(["novel-legacy", "novel-mobo-1"]);
  });

  it("没有口令码剧场：所有书照常进候选（与改动前一致）", async () => {
    const db = new FakeHomeCarouselDb();
    db.channelApps = [{ id: LINK_APP, config: {} }];
    db.seedArticle(article("mobo-1", LINK_APP, 1));
    db.seedArticle(article("mobo-2", LINK_APP, 2));
    await computeHomeCarouselInTx(db.asTransactionClient(), { locale: "en", source: "manual", now: NOW });
    expect(db.serving).toHaveLength(2);
  });
});

describe("手动位（upsertHomeCarouselManualSlot）", () => {
  it("口令码模式剧场的书不能放进手动位：明确的错误码；link 模式的书照常", async () => {
    const { stores } = authFixture();
    const db = new FakeHomeCarouselDb();
    db.channelApps = [{ id: CODE_APP, config: CODE_CONFIG }, { id: LINK_APP, config: {} }];
    db.seedArticle(article("plot-1", CODE_APP, 1));
    db.seedArticle(article("mobo-1", LINK_APP, 1));

    const rejected = await authorizeAction(stores, "admin.home_carousel.manual_upsert");
    await expect(
      upsertHomeCarouselManualSlot({ authorization: rejected.authorization, requestId: rejected.requestId, locale: "en", position: 1, articleId: "plot-1", enabled: true }, dependencies(db, stores)),
    ).rejects.toThrow("carousel_code_mode_excluded");
    expect(db.manualSlots.size).toBe(0);

    const accepted = await authorizeAction(stores, "admin.home_carousel.manual_upsert");
    await expect(
      upsertHomeCarouselManualSlot({ authorization: accepted.authorization, requestId: accepted.requestId, locale: "en", position: 1, articleId: "mobo-1", enabled: true }, dependencies(db, stores)),
    ).resolves.toMatchObject({ position: 1, novelId: "novel-mobo-1" });
    expect(FIXTURE_NOW).toBeInstanceOf(Date);
  });
});

describe("前台读取（getHomeCarouselItems）：快照与回退两条路径都带排除条件，行级再挡一次", () => {
  function rowFor(input: { id: string; configOfTheater: unknown }) {
    return {
      id: input.id, title: `Title ${input.id}`, summary: "s", body: "b", seoMetadata: {}, slug: `slug-${input.id}`, locale: "en",
      publicPageShortId: `short-${input.id}`, publishedAt: new Date("2026-01-01T00:00:00.000Z"),
      novel: { id: `novel-${input.id}`, businessId: `biz-${input.id}`, title: `Novel ${input.id}`, description: "d", coverUrl: "https://cdn.example.com/c.jpg", locale: "en", totalChapterCount: 10 },
      promoLink: {
        status: "fetched", webUrl: null, appUrl: null, upstreamCode: "960031", publicRedirectCode: "abc123def0",
        channelApp: { config: input.configOfTheater }, novel: { locale: "en" },
      },
    };
  }

  type Row = ReturnType<typeof rowFor>;
  function dbFor(options: { channelApps: Array<{ id: string; config: unknown }>; serving: Row[]; fallback: Row[] }) {
    const seen: { servingWhere: unknown; fallbackWhere: unknown } = { servingWhere: null, fallbackWhere: null };
    const db = {
      channelApp: { findMany: async () => options.channelApps },
      homeCarouselServing: {
        findMany: async (args: { where: { article: unknown } }) => {
          seen.servingWhere = args.where.article;
          return options.serving.map((article) => ({ article }));
        },
      },
      article: { findMany: async (args: { where: unknown }) => { seen.fallbackWhere = args.where; return options.fallback; } },
      novelChapter: { findMany: async () => [] },
    };
    return { db: db as never, seen };
  }

  it("有口令码剧场：快照查询与回退查询都带 notIn 条件", async () => {
    const { db, seen } = dbFor({ channelApps: [{ id: CODE_APP, config: CODE_CONFIG }], serving: [], fallback: [] });
    await getHomeCarouselItems("en", db);
    expect(JSON.stringify(seen.servingWhere)).toContain('"channelAppId":{"notIn":["app-plotnovel"]}');
    expect(JSON.stringify(seen.fallbackWhere)).toContain('"channelAppId":{"notIn":["app-plotnovel"]}');
  });

  it("没有口令码剧场：两条查询都不带这个条件（逐字不变）", async () => {
    const { db, seen } = dbFor({ channelApps: [{ id: LINK_APP, config: {} }], serving: [], fallback: [] });
    await getHomeCarouselItems("en", db);
    expect(JSON.stringify(seen.servingWhere)).not.toContain("notIn");
    expect(JSON.stringify(seen.fallbackWhere)).not.toContain("notIn");
  });

  it("行级第二道：即使查询放过了一行口令码模式的书（快照里的残留），也不会出现在轮播里", async () => {
    const plot = rowFor({ id: "plot", configOfTheater: CODE_CONFIG });
    const mobo = rowFor({ id: "mobo", configOfTheater: { promoMode: "link" } });
    (mobo.promoLink as { webUrl: string | null }).webUrl = "https://example.com/go";
    const { db } = dbFor({ channelApps: [], serving: [plot, mobo], fallback: [] });
    const items = await getHomeCarouselItems("en", db);
    expect(items.map((item) => item.novel.id)).toEqual(["biz-mobo"]);
  });
});
