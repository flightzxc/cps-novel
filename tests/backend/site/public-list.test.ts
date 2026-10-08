import { readFileSync } from "node:fs";
import path from "node:path";

import { Prisma, type PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SITE_LOCALES } from "@/lib/locale/locale-canonical";
import {
  categoryCountsForLocale,
  categoryMembershipSql,
  clearPublicCategoryCountsCacheForTest,
  evaluatePublicListScale,
  getPublicCategoryCounts,
  hydratePublicListCards,
  listPublicNovelHead,
  listPublicNovelPage,
  localesWithCategory,
  PUBLIC_CATEGORY_COUNTS_TTL_SECONDS,
  PUBLIC_LIST_SCALE_THRESHOLDS,
  publicListFromWhereSql,
  publicListWhereSql,
  queryPublicCategoryCounts,
  queryPublicListCount,
  queryPublicListIds,
  type PublicCategoryCounts,
} from "@/lib/site/public-list";
import { JS_TRIM_WHITESPACE_CHARACTERS } from "@/server/publication/visibility";

import { classifyPublicListQuery } from "../../fixtures/in-memory-public-db";

/**
 * B-38 第二段：`src/lib/site/public-list.ts` 的单元层契约（不连数据库）。
 * 这里钉住 SQL 的**形状**（哪些条件、什么顺序、哪些值走绑定参数）、分页的页码数学、复核丢行的告警、矩阵缓存的 TTL、
 * 规模触发器的阈值与边界。**筛选语义本身**（SQL 真的选出了该选的行）由真实库用例证明：
 * `tests/integration/site/list-equivalence-postgres.test.ts` 等。
 */

const FLAG_SEO = "FEATURE_ARTICLE_SEO_VISIBILITY";
const envOn = { NODE_ENV: "test", [FLAG_SEO]: "true", FEATURE_NOVEL_TAG_AUTO: "true" } as NodeJS.ProcessEnv;
const envOff = { NODE_ENV: "test", [FLAG_SEO]: "false", FEATURE_NOVEL_TAG_AUTO: "false" } as NodeJS.ProcessEnv;

const squash = (sql: string) => sql.replace(/\s+/g, " ").trim();
const textOf = (fragment: Prisma.Sql) => squash(fragment.text);

beforeEach(() => clearPublicCategoryCountsCacheForTest());
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  clearPublicCategoryCountsCacheForTest();
});

describe("列表可见性 SQL 片段（publicListFromWhereSql）", () => {
  const fragment = publicListFromWhereSql(Prisma.sql`a.locale = ${"en"}`, envOff);

  it("FROM article a JOIN novel n JOIN promo_link p，条件逐条齐全（与 buildPublicListArticleWhere + isPromoReady 同口径）", () => {
    const text = textOf(fragment);
    expect(text).toContain("FROM article a");
    expect(text).toContain("JOIN novel n ON n.id = a.novel_id");
    expect(text).toContain("JOIN promo_link p ON p.id = a.promo_link_id");
    for (const condition of [
      "a.locale = $1",
      "a.article_type = 'novel_article'",
      "a.status = 'published'",
      "a.deleted_at IS NULL",
      "n.status = 'published'",
      "n.deleted_at IS NULL",
      "p.status = 'fetched'",
      "coalesce(btrim(p.web_url, $2), '') <> ''",
      "coalesce(btrim(p.app_url, $3), '') <> ''",
    ]) expect(text, condition).toContain(condition);
  });

  it("🔴 promo_link 只按 id 连接——不能'补全'成 p.novel_id = a.novel_id（组合外键已保证；多写会让规划器把行数估成 1）", () => {
    expect(textOf(fragment)).not.toMatch(/p\.novel_id/);
    expect(textOf(publicListFromWhereSql(Prisma.sql`a.locale = ${"en"}`, envOn))).not.toMatch(/p\.novel_id/);
    const source = readFileSync(path.resolve(process.cwd(), "src/lib/site/public-list.ts"), "utf8");
    // 源码里 promo_link 的连接行恰好只有一条，且只写 id。
    expect(source.match(/JOIN promo_link p ON [^\n]*/g)).toEqual(["JOIN promo_link p ON p.id = a.promo_link_id"]);
  });

  it("空白字符集作为绑定参数传入（web / app 各一份），SQL 文本里没有原始空白字符", () => {
    expect(fragment.values).toEqual(["en", JS_TRIM_WHITESPACE_CHARACTERS, JS_TRIM_WHITESPACE_CHARACTERS]);
    const exotic = [...JS_TRIM_WHITESPACE_CHARACTERS].filter((char) => !" \n\t".includes(char));
    expect(exotic.filter((char) => fragment.text.includes(char))).toEqual([]);
  });

  it("SEO 可见性开关：打开时追加 a.seo_visibility = 'public'（排除 hidden 与 seo_only），关闭时不区分", () => {
    const on = textOf(publicListFromWhereSql(Prisma.sql`a.locale = ${"en"}`, envOn));
    const off = textOf(publicListFromWhereSql(Prisma.sql`a.locale = ${"en"}`, envOff));
    expect(on).toContain("a.seo_visibility = 'public'");
    expect(off).not.toContain("seo_visibility");
    // 其余条件两种开关下逐字相同。
    expect(on.replace(" AND a.seo_visibility = 'public'", "")).toBe(off);
  });

  it("publicListWhereSql 与 publicListFromWhereSql 的条件部分是同一段（矩阵在 FROM 与 WHERE 之间连别的表，复用它）", () => {
    const where = textOf(publicListWhereSql(Prisma.sql`a.locale = ${"en"}`, envOn));
    expect(textOf(publicListFromWhereSql(Prisma.sql`a.locale = ${"en"}`, envOn))).toContain(`WHERE ${where}`);
  });

  it("分类归属片段：读归属表，自动来源的行只在开关打开时算（开关是绑定值，不写进表）", () => {
    const on = categoryMembershipSql("11111111-1111-4111-8111-111111111111", envOn);
    const off = categoryMembershipSql("11111111-1111-4111-8111-111111111111", envOff);
    expect(squash(on.text)).toBe(
      "EXISTS ( SELECT 1 FROM novel_effective_tag m WHERE m.canonical_tag_id = $1::uuid AND m.novel_id = a.novel_id AND (m.provenance <> 'auto' OR $2) )",
    );
    expect(on.values).toEqual(["11111111-1111-4111-8111-111111111111", true]);
    expect(off.values).toEqual(["11111111-1111-4111-8111-111111111111", false]);
  });
});

describe("分页查询的 SQL（编号 + 总数）", () => {
  function capture() {
    const calls: Array<{ text: string; values: readonly unknown[] }> = [];
    const db = { $queryRaw: vi.fn(async (query: Prisma.Sql) => { calls.push({ text: query.text, values: query.values }); return [{ total: 0 }]; }) };
    return { db: db as unknown as PrismaClient, calls };
  }

  it("排序恰好是发布时间新→旧、同时间编号升序；不写 NULLS LAST（与改造前 Prisma 的 desc 同语义）；LIMIT / OFFSET 走绑定参数", async () => {
    const { db, calls } = capture();
    await queryPublicListIds(db, { locale: "en", limit: 20, offset: 40, env: envOff });
    const text = squash(calls[0]!.text);
    expect(text).toContain("SELECT a.id AS id FROM article a");
    expect(text).toContain("ORDER BY a.published_at DESC, a.id ASC LIMIT $4::int OFFSET $5::bigint");
    expect(text).not.toMatch(/NULLS (FIRST|LAST)/i);
    expect(calls[0]!.values.slice(-2)).toEqual([20, 40]);
    const source = readFileSync(path.resolve(process.cwd(), "src/lib/site/public-list.ts"), "utf8");
    expect(source.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/NULLS LAST/i);
  });

  it("总数查询与编号查询用同一段范围（语种 + 可选分类），count(*)::int", async () => {
    const { db, calls } = capture();
    const tagId = "22222222-2222-4222-8222-222222222222";
    await queryPublicListIds(db, { locale: "ko", tagId, limit: 20, offset: 0, env: envOn });
    await queryPublicListCount(db, { locale: "ko", tagId, env: envOn });
    const [ids, count] = calls.map((call) => squash(call.text));
    expect(count).toContain("SELECT count(*)::int AS total FROM article a");
    // 范围部分（FROM … 到分类归属为止）逐字相同。
    const scope = (text: string) => text.slice(text.indexOf("FROM article a"), text.indexOf("EXISTS (") + "EXISTS (".length);
    expect(scope(count)).toBe(scope(ids));
    expect(calls[0]!.values.slice(0, 5)).toEqual(calls[1]!.values.slice(0, 5));
  });

  it("不带分类时没有归属条件（全部作品页）", async () => {
    const { db, calls } = capture();
    await queryPublicListCount(db, { locale: "en", env: envOff });
    expect(calls[0]!.text).not.toContain("novel_effective_tag");
  });
});

describe("listPublicNovelPage · 页码数学与复核", () => {
  const card = (id: string, promoLink: { status: string; webUrl: string | null; appUrl: string | null } = { status: "fetched", webUrl: "https://x.example/r", appUrl: null }) => ({
    id: `article-${id}`, title: `Book ${id}`, slug: `book-${id}`, locale: "en", publicPageShortId: `s${id}`,
    publishedAt: new Date("2026-01-01T00:00:00Z"), summary: null,
    novel: { id: `novel-${id}`, businessId: `biz-${id}`, title: `Book ${id}`, description: "d", coverUrl: null, locale: "en", totalChapterCount: 1 },
    promoLink,
  });

  function dbWith(options: { total: number; ids?: string[]; rows?: ReturnType<typeof card>[] }) {
    const queries: string[] = [];
    const findMany = vi.fn().mockResolvedValue(options.rows ?? []);
    const db = {
      article: { findMany },
      $queryRaw: vi.fn(async (query: Prisma.Sql) => {
        const kind = classifyPublicListQuery(query);
        queries.push(kind);
        if (kind === "page-ids") return (options.ids ?? []).map((id) => ({ id }));
        if (kind === "page-count") return [{ total: options.total }];
        return [];
      }),
    } as unknown as PrismaClient;
    return { db, queries, findMany };
  }

  it("totalPages = ceil(总数 / 页大小)；没有书时恒为 1；page 非法（0、负、小数、NaN）按第 1 页", async () => {
    for (const [total, pages] of [[0, 1], [1, 1], [20, 1], [21, 2], [40, 2], [41, 3], [13_008, 651]] as const) {
      const { db } = dbWith({ total });
      expect((await listPublicNovelPage(db, { locale: "en", page: 1, pageSize: 20, env: envOff })).totalPages, `total=${total}`).toBe(pages);
    }
    for (const page of [0, -3, 1.5, Number.NaN]) {
      const { db } = dbWith({ total: 100, ids: [], rows: [] });
      expect((await listPublicNovelPage(db, { locale: "en", page, pageSize: 20, env: envOff })).page, String(page)).toBe(1);
    }
  });

  it("OFFSET = (page - 1) * 页大小；编号查询与总数查询各发一次，并行", async () => {
    const { db, queries } = dbWith({ total: 100 });
    const spy = vi.mocked(db.$queryRaw);
    await listPublicNovelPage(db, { locale: "en", page: 3, pageSize: 20, env: envOff });
    expect(queries.sort()).toEqual(["page-count", "page-ids"]);
    const idsCall = spy.mock.calls.find((call) => classifyPublicListQuery(call[0] as never) === "page-ids")!;
    expect((idsCall[0] as Prisma.Sql).values.slice(-2)).toEqual([20, 40]);
  });

  it("页码大到 OFFSET 不再是安全整数：不发编号查询（数据库的 bigint 装不下会报错），总数照查，返回空页", async () => {
    const { db, queries } = dbWith({ total: 100 });
    const result = await listPublicNovelPage(db, { locale: "en", page: 1e21, pageSize: 20, env: envOff });
    expect(queries).toEqual(["page-count"]);
    expect(result).toMatchObject({ novels: [], page: 1e21, totalPages: 5, totalCount: 100 });
  });

  it("超出范围的页码：空 novels、真实 totalPages，不补全卡片", async () => {
    const { db, findMany } = dbWith({ total: 45, ids: [] });
    const result = await listPublicNovelPage(db, { locale: "en", page: 9, pageSize: 20, env: envOff });
    expect(result).toMatchObject({ novels: [], page: 9, totalPages: 3, totalCount: 45 });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("补全按编号顺序排好，补全时已不存在的编号静默跳过（竞争，不是不变量违例）", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { db } = dbWith({ total: 3, ids: ["article-b", "article-gone", "article-a"], rows: [card("a"), card("b")] });
    const result = await listPublicNovelPage(db, { locale: "en", page: 1, pageSize: 20, env: envOff });
    expect(result.novels.map((novel) => novel.id)).toEqual(["biz-b", "biz-a"]);
    expect(error).not.toHaveBeenCalled();
  });

  it("🔴 复核丢行 = 数据库说可用而程序说不可用：丢弃该卡片，并记一条结构化不变量违例日志", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const blank = card("blank", { status: "fetched", webUrl: "   ", appUrl: "　" });
    const { db } = dbWith({ total: 2, ids: ["article-ok", "article-blank"], rows: [card("ok"), blank] });
    const result = await listPublicNovelPage(db, { locale: "en", page: 1, pageSize: 20, env: envOff });
    expect(result.novels.map((novel) => novel.id)).toEqual(["biz-ok"]);
    expect(result.totalCount).toBe(2); // 总数不变——正常情况下不会出现这种差值
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(error.mock.calls[0]![0] as string)).toEqual({
      schemaVersion: 1,
      event: "public_list_invariant_violation",
      level: "error",
      reason: "promo_not_ready_after_sql_filter",
      articleId: "article-blank",
      locale: "en",
    });
  });

  it("没有违例时不写任何错误日志；空编号直接返回空数组且不碰数据库", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { db, findMany } = dbWith({ total: 1, ids: ["article-ok"], rows: [card("ok")] });
    expect((await listPublicNovelPage(db, { locale: "en", page: 1, pageSize: 20, env: envOff })).novels).toHaveLength(1);
    expect(error).not.toHaveBeenCalled();
    findMany.mockClear();
    expect(await hydratePublicListCards(db, [], "en")).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("首页作品格 listPublicNovelHead：只发编号查询（LIMIT，OFFSET 0）+ 卡片标签读表，不数总数", async () => {
    const { db, queries } = dbWith({ total: 99, ids: ["article-ok"], rows: [card("ok")] });
    const cards = await listPublicNovelHead(db, { locale: "en", limit: 20, env: envOff });
    expect(cards).toHaveLength(1);
    expect(queries).toEqual(["page-ids", "taxonomy"]);
    expect(queries).not.toContain("page-count");
    const values = vi.mocked(db.$queryRaw).mock.calls[0]![0] as Prisma.Sql;
    expect(values.values.slice(-2)).toEqual([20, 0]);
  });
});

describe("每语种每分类本数矩阵", () => {
  function matrixDb(rows: Array<{ locale: string; canonical_tag_id: string; slug: string; n: number }>, totals: Array<{ locale: string; n: number }> = []) {
    const calls: Array<{ kind: string; text: string; values: readonly unknown[] }> = [];
    const db = {
      $queryRaw: vi.fn(async (query: Prisma.Sql) => {
        const kind = classifyPublicListQuery(query);
        calls.push({ kind, text: query.text, values: query.values });
        return kind === "matrix" ? rows : kind === "totals" ? totals : [];
      }),
    } as unknown as PrismaClient;
    return { db, calls };
  }

  it("一次查询覆盖全部登记语种（SITE_LOCALES）；只收启用的分类；按 (语种, 分类) 分组计数；归属读表且自动来源按开关", async () => {
    const { db, calls } = matrixDb([]);
    await queryPublicCategoryCounts(db, envOn);
    const matrix = calls.find((call) => call.kind === "matrix")!;
    const text = squash(matrix.text);
    expect(text).toContain("JOIN novel_effective_tag m ON m.novel_id = a.novel_id AND (m.provenance <> 'auto' OR $1)");
    expect(text).toContain("JOIN canonical_tag ct ON ct.id = m.canonical_tag_id AND ct.status = 'active'");
    expect(text).toContain("GROUP BY a.locale, m.canonical_tag_id, ct.slug");
    expect(text).toContain("a.locale IN (");
    expect(matrix.values.filter((value) => (SITE_LOCALES as readonly string[]).includes(value as string))).toEqual([...SITE_LOCALES]);
    expect(calls.filter((call) => call.kind === "matrix")).toHaveLength(1); // 一次查询
    expect(calls.filter((call) => call.kind === "totals")).toHaveLength(1);
    // 列表可见性与分页查询是同一段（不含 SEO 开关差异时逐字相同）。
    expect(text).toContain("n.status = 'published'");
    expect(text).toContain("a.seo_visibility = 'public'");
  });

  it("只限 SITE_LOCALES：传入未登记语种被丢弃；传空 = 不发任何查询", async () => {
    const { db, calls } = matrixDb([]);
    await queryPublicCategoryCounts(db, envOff, { locales: ["en", "xx-unregistered"] });
    const matrix = calls.find((call) => call.kind === "matrix")!;
    expect(matrix.values.filter((value) => typeof value === "string" && (value === "xx-unregistered" || value === "en"))).toEqual(["en"]);
    calls.length = 0;
    expect(await queryPublicCategoryCounts(db, envOff, { locales: ["xx-unregistered"] })).toEqual({ rows: [], visibleTotalByLocale: new Map() });
    expect(calls).toEqual([]);
  });

  it("行 → { locale, canonicalTagId, slug, count }；本数 0 的格子不出现；总数按语种", async () => {
    const { db } = matrixDb(
      [
        { locale: "en", canonical_tag_id: "t1", slug: "romance", n: 4101 },
        { locale: "ko", canonical_tag_id: "t1", slug: "romance", n: BigInt(3) as unknown as number },
        { locale: "en", canonical_tag_id: "t2", slug: "empty", n: 0 },
      ],
      [{ locale: "en", n: 13_008 }, { locale: "ko", n: 766 }],
    );
    const counts = await queryPublicCategoryCounts(db, envOff);
    expect(counts.rows).toEqual([
      { locale: "en", canonicalTagId: "t1", slug: "romance", count: 4101 },
      { locale: "ko", canonicalTagId: "t1", slug: "romance", count: 3 },
    ]);
    expect(Object.fromEntries(counts.visibleTotalByLocale)).toEqual({ en: 13_008, ko: 766 });
    expect([...categoryCountsForLocale(counts, "en")]).toEqual([["t1", { slug: "romance", count: 4101 }]]);
    expect([...categoryCountsForLocale(counts, "es")]).toEqual([]);
    expect([...localesWithCategory(counts, "romance")].sort()).toEqual(["en", "ko"]);
    expect([...localesWithCategory(counts, "nope")]).toEqual([]);
  });
});

describe("矩阵的 60 秒进程内缓存（web 侧；worker 调用不带缓存的原函数）", () => {
  const matrixRow = { locale: "en", canonical_tag_id: "t1", slug: "romance", n: 5 };
  function countingDb() {
    let matrixCalls = 0;
    const db = {
      $queryRaw: vi.fn(async (query: Prisma.Sql) => {
        const kind = classifyPublicListQuery(query);
        if (kind === "matrix") { matrixCalls += 1; return [matrixRow]; }
        return kind === "totals" ? [{ locale: "en", n: 5 }] : [];
      }),
    } as unknown as PrismaClient;
    return { db, matrixCalls: () => matrixCalls };
  }

  it("TTL 是代码常量 60 秒（不读环境变量，同 related-novels 主控 2026-09-29 的裁定）", () => {
    expect(PUBLIC_CATEGORY_COUNTS_TTL_SECONDS).toBe(60);
    const source = readFileSync(path.resolve(process.cwd(), "src/lib/site/public-list.ts"), "utf8");
    expect(source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")).not.toMatch(/process\.env\.[A-Z_]*(TTL|CACHE|SECONDS)/);
  });

  it("缓存期内多次读取只算一次；并发读取共用同一次计算；过 60 秒重算", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T00:00:00Z"));
    const { db, matrixCalls } = countingDb();
    const [a, b] = await Promise.all([getPublicCategoryCounts(db, envOff), getPublicCategoryCounts(db, envOff)]);
    expect(a).toBe(b);
    expect(matrixCalls()).toBe(1);
    vi.setSystemTime(new Date("2026-10-09T00:00:59Z"));
    await getPublicCategoryCounts(db, envOff);
    expect(matrixCalls()).toBe(1);
    vi.setSystemTime(new Date("2026-10-09T00:01:01Z"));
    await getPublicCategoryCounts(db, envOff);
    expect(matrixCalls()).toBe(2);
  });

  it("缓存键含两个开关的取值：开关不同的调用互不串；不缓存失败", async () => {
    const { db, matrixCalls } = countingDb();
    await getPublicCategoryCounts(db, envOff);
    await getPublicCategoryCounts(db, envOn);
    expect(matrixCalls()).toBe(2);
    await getPublicCategoryCounts(db, envOn);
    expect(matrixCalls()).toBe(2);

    clearPublicCategoryCountsCacheForTest();
    let attempts = 0;
    const flaky = { $queryRaw: vi.fn(async (query: Prisma.Sql) => {
      if (classifyPublicListQuery(query) === "matrix" && (attempts += 1) === 1) throw new Error("boom");
      return classifyPublicListQuery(query) === "matrix" ? [matrixRow] : [];
    }) } as unknown as PrismaClient;
    await expect(getPublicCategoryCounts(flaky, envOff)).rejects.toThrow("boom");
    await expect(getPublicCategoryCounts(flaky, envOff)).resolves.toMatchObject({ rows: [expect.objectContaining({ slug: "romance" })] });
  });
});

describe("规模触发器（方案 4.7）", () => {
  const counts = (rows: Array<[string, string, number]>, totals: Array<[string, number]> = []): PublicCategoryCounts => ({
    rows: rows.map(([locale, slug, count]) => ({ locale, canonicalTagId: `id-${slug}`, slug, count })),
    visibleTotalByLocale: new Map(totals),
  });

  it("阈值常量：单语种单分类 40,000 / 单语种总数 60,000（改它们必须同时改方案与发版检查清单）", () => {
    expect(PUBLIC_LIST_SCALE_THRESHOLDS).toEqual({ perCategoryPerLocale: 40_000, perLocaleTotal: 60_000 });
    expect(Object.isFrozen(PUBLIC_LIST_SCALE_THRESHOLDS)).toBe(true);
  });

  it("严格大于才算超过：恰好 40,000 / 60,000 不算，多 1 本算", () => {
    expect(evaluatePublicListScale(counts([["en", "big", 40_000]], [["en", 60_000]])).exceeded).toBe(false);
    expect(evaluatePublicListScale(counts([["en", "big", 40_001]], [["en", 60_000]]))).toMatchObject({
      exceeded: true, categories: [{ locale: "en", slug: "big", count: 40_001 }], locales: [],
    });
    expect(evaluatePublicListScale(counts([["en", "big", 40_000]], [["en", 60_001]]))).toMatchObject({
      exceeded: true, categories: [], locales: [{ locale: "en", total: 60_001 }],
    });
  });

  it("两个条件各自独立；报告里有最大值；多个语种 / 分类全部列出", () => {
    const report = evaluatePublicListScale(counts(
      [["en", "a", 45_000], ["ru", "b", 41_000], ["es", "c", 10]],
      [["en", 70_000], ["ru", 50_000], ["es", 10]],
    ));
    expect(report.exceeded).toBe(true);
    expect(report.categories.map((item) => item.slug)).toEqual(["a", "b"]);
    expect(report.locales).toEqual([{ locale: "en", total: 70_000 }]);
    expect(report.maxCategoryCount).toBe(45_000);
    expect(report.maxLocaleTotal).toBe(70_000);
    expect(evaluatePublicListScale(counts([]))).toMatchObject({ exceeded: false, maxCategoryCount: 0, maxLocaleTotal: 0 });
  });

  it("矩阵计算时超过就记一条结构化 warn（public_list_scale_threshold_exceeded），没超过不记", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const make = (n: number, total: number) => ({
      $queryRaw: vi.fn(async (query: Prisma.Sql) => {
        const kind = classifyPublicListQuery(query);
        return kind === "matrix" ? [{ locale: "en", canonical_tag_id: "t1", slug: "big", n }] : [{ locale: "en", n: total }];
      }),
    }) as unknown as PrismaClient;
    await queryPublicCategoryCounts(make(40_000, 60_000), envOff);
    expect(warn).not.toHaveBeenCalled();
    await queryPublicCategoryCounts(make(40_001, 60_001), envOff);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warn.mock.calls[0]![0] as string)).toMatchObject({
      schemaVersion: 1,
      event: "public_list_scale_threshold_exceeded",
      level: "warn",
      thresholds: { perCategoryPerLocale: 40_000, perLocaleTotal: 60_000 },
      categories: [{ locale: "en", slug: "big", count: 40_001 }],
      locales: [{ locale: "en", total: 60_001 }],
    });
  });
});
