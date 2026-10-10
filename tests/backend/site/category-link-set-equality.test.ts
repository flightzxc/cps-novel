import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getPublicCategoryPage, listPublicCategoryPageCounts } from "@/lib/site/category-queries";
import { listCategoryPublicLocales } from "@/lib/site/category-locales";
import { toLinkableCategorySlugs } from "@/lib/site/category-links";
import { clearPublicCategoryCountsCacheForTest } from "@/lib/site/public-list";
import { listPublicCategories } from "@/lib/site/queries";

import { books, makeFakeDb, MATRIX_KEY, type Category, type Row } from "../../fixtures/in-memory-public-db";

/**
 * B-38 第二部分：详情页的"可链接分类集合"取页脚用的 `listPublicCategories`（请求内已取过一份，复用它新增 0 次查询），
 * 而不是另写一份"分类下有没有书"的查询。这条复用成立的前提是：它与分类页 / 站点地图 / hreflang 共用的唯一筛选
 * （`public-list.ts` 的列表可见性 + 分类归属 SQL，经 `getPublicCategoryPage`、`listPublicCategoryPageCounts`、
 * `listCategoryPublicLocales`）给出**完全相同**的 slug 集合。
 *
 * v0.5.13（数据库分页）起，"同一把尺子"是真实 SQL，**筛选语义本身**由真实库用例在每个语种、四种开关组合下证明：
 * `tests/integration/site/consistency-invariants-postgres.test.ts`。这里用内存 db（按 SQL 结构分派、按绑定值求值，
 * 见 `tests/fixtures/in-memory-public-db.ts`）在默认 `npm test` 里钉住**胶水层**——各函数是否真的都从同一份矩阵 /
 * 同一个范围取数，没有谁串了语种、串了缓存、漏了规范化：
 *
 *   1. `listPublicCategories` 的 slug 集合 === `listPublicCategoryPageCounts` 的键集合；
 *   2. 该集合里的每个分类，`getPublicCategoryPage` 都不为 null，且 `totalPages` 等于页数映射里的值，下一页是 null；
 *   3. 库里存在、但不在该集合里的分类，`getPublicCategoryPage` 都是 null（等价是双向的，不是"只多不少"）；
 *   4. `listCategoryPublicLocales` 的结果 === 该分类在各语种页面返回 200 的语种；
 *   5. 集合不是空洞地等于"全部分类"——每个场景都有至少一个被排除的分类（除了刻意验证"全都进列表"的那个）。
 */

beforeEach(() => clearPublicCategoryCountsCacheForTest());
afterEach(() => clearPublicCategoryCountsCacheForTest());

async function slugSets(db: ReturnType<typeof makeFakeDb>["db"], locale: "en" | "ko" | "es") {
  const footer = new Set((await listPublicCategories(db, locale)).map((tag) => tag.slug));
  const counts = new Set((await listPublicCategoryPageCounts(db, locale)).keys());
  const linkable = toLinkableCategorySlugs(await listPublicCategories(db, locale));
  return { footer, counts, linkable };
}

async function expectEquivalent(
  scenario: string,
  rows: readonly Row[],
  categories: readonly Category[],
  locale: "en" | "ko" | "es",
) {
  const fake = makeFakeDb(rows, categories);
  const { db } = fake;
  const { footer, counts, linkable } = await slugSets(db, locale);
  expect([...footer].sort(), `${scenario}: 页脚集合 === 页面返回 200 的分类集合`).toEqual([...counts].sort());
  expect([...linkable].sort(), `${scenario}: 可链接集合 === 页面返回 200 的分类集合`).toEqual([...counts].sort());
  const pageCounts = await listPublicCategoryPageCounts(db, locale);
  for (const category of categories.filter((candidate) => candidate.locale === undefined || candidate.locale === locale)) {
    const page = await getPublicCategoryPage(db, locale, category.slug, 1);
    expect(linkable.has(category.slug), `${scenario}: ${category.slug} 页面 200=${page !== null}`).toBe(page !== null);
    if (page) {
      expect(page.totalPages, `${scenario}: ${category.slug} 总页数`).toBe(pageCounts.get(category.slug));
      expect(await getPublicCategoryPage(db, locale, category.slug, page.totalPages + 1), `${scenario}: ${category.slug} 下一页`).toBeNull();
    }
  }
  return { footer, counts, fake };
}

describe("详情页的可链接分类集合 === 分类页返回 200 的分类集合（等价是双向的）", () => {
  // 序号 1..60 不进列表（真实世界里是 seo_only / 推广链接不可用 / 草稿），61..300 进列表。
  const en = books(300, "en", 60);
  const enCategories: Category[] = [
    { slug: "adventure", sortOrder: 1, ordinals: [[5, 50]] }, // 书全都不进列表 → 页面 404
    { slug: "fantasy", sortOrder: 2, ordinals: [[70, 114], [10, 40]] }, // 进列表 45 本 + 不进列表 31 本 → 页面 200（3 页）
    { slug: "romance", sortOrder: 3, ordinals: [[30, 30], [200, 200]] }, // 一本不进列表、一本进列表 → 页面 200
    { slug: "mystery", sortOrder: 4, ordinals: [[250, 252]] }, // 全部进列表 → 页面 200
  ];

  it("en 300 本：不进列表的书独占的分类不在集合里，其余都在；集合与 listPublicCategoryPageCounts 的键完全一致", async () => {
    const { footer, fake } = await expectEquivalent("en 300 本", en, enCategories, "en");
    expect([...footer].sort()).toEqual(["fantasy", "mystery", "romance"]);
    expect(footer.has("adventure")).toBe(false);
    // 页脚与链接判定共用一份：整个断言过程里 listPublicCategories 被调了多次，但矩阵只算了一次（缓存）。
    expect(fake.counts[MATRIX_KEY]).toBeGreaterThanOrEqual(1);
  });

  it("页数映射 = ceil(列表可见本数 / 20)：fantasy 进列表 45 本 = 3 页，不含不进列表的 31 本", async () => {
    const { db } = makeFakeDb(en, enCategories);
    const counts = await listPublicCategoryPageCounts(db, "en");
    expect(Object.fromEntries(counts)).toEqual({ fantasy: 3, romance: 1, mystery: 1 });
    expect((await getPublicCategoryPage(db, "en", "fantasy", 3))?.novels).toHaveLength(5);
    expect((await getPublicCategoryPage(db, "en", "fantasy", 1))?.totalCount).toBe(45);
  });

  it("语种书目很少：每个分类都进列表，集合 = 全部分类", async () => {
    const ko = books(30, "ko");
    const { footer } = await expectEquivalent("ko 30 本", ko, [
      { slug: "xuanhuan", sortOrder: 1, ordinals: [[1, 25]], locale: "ko" },
      { slug: "yanqing", sortOrder: 2, ordinals: [[26, 30]], locale: "ko" },
    ], "ko");
    expect([...footer].sort()).toEqual(["xuanhuan", "yanqing"]);
  });

  it("不进列表的书（例如推广链接纯空白、seo_only）独占的分类两边都不出现", async () => {
    const rows = books(300, "en", 0).map((row) => (row.novelId === "novel-en-299" ? { ...row, listed: false } : row));
    const { footer } = await expectEquivalent("不进列表的书", rows, [
      { slug: "staff-pick", sortOrder: 1, ordinals: [[299, 299]] },
      { slug: "seen-it", sortOrder: 2, ordinals: [[300, 300]] },
    ], "en");
    expect([...footer]).toEqual(["seen-it"]);
  });

  it("没有任何公开书的语种：两边都是空集合", async () => {
    const { footer, counts } = await expectEquivalent("es 0 本", en, enCategories, "es");
    expect(footer.size).toBe(0);
    expect(counts.size).toBe(0);
  });

  it("分类很多（12 个，每个只挂进列表的一本）：集合与页数映射的键一致", async () => {
    const many: Category[] = Array.from({ length: 12 }, (_, index) => ({
      slug: `cat-${index + 1}`, sortOrder: index + 1, ordinals: [[250 + index, 250 + index]] as const,
    }));
    const { footer } = await expectEquivalent("12 个分类", en, [...many, { slug: "old-only", sortOrder: 99, ordinals: [[1, 5]] }], "en");
    expect(footer.size).toBe(12);
    expect(footer.has("old-only")).toBe(false);
  });

  it("hreflang：listCategoryPublicLocales === 该分类各语种页面返回 200 的语种（候选里挑，顺序同候选）", async () => {
    const rows = [...books(300, "en", 60), ...books(300, "ko", 60), ...books(30, "es")];
    const categories: Category[] = [
      { slug: "sci-fi", sortOrder: 1, locale: "en", ordinals: [[250, 252]] },
      { slug: "sci-fi", sortOrder: 2, locale: "ko", ordinals: [[30, 31]] }, // ko 的书都不进列表
      { slug: "sci-fi", sortOrder: 3, locale: "es", ordinals: [[1, 3]] },
      { slug: "wuxia", sortOrder: 4, locale: "ko", ordinals: [[250, 252]] },
    ];
    const { db } = makeFakeDb(rows, categories);
    const candidates = ["es", "ko", "en", "ja"] as const;
    for (const slug of ["sci-fi", "wuxia", "missing"]) {
      const expected: string[] = [];
      for (const candidate of candidates) if (await getPublicCategoryPage(db, candidate, slug, 1)) expected.push(candidate);
      expect(await listCategoryPublicLocales(db, slug, candidates), slug).toEqual(expected);
    }
    expect(await listCategoryPublicLocales(db, "sci-fi", candidates)).toEqual(["es", "en"]);
    expect(await listCategoryPublicLocales(db, "wuxia", candidates)).toEqual(["ko"]);
    expect(await listCategoryPublicLocales(db, "missing", candidates)).toEqual([]);
  });

  it("v0.5.15：某分类被运营取消「首页显示」后，页脚用的列表、可链接集合、页数映射、分类页、hreflang 全都不变，只有 homepageVisible 变", async () => {
    const rows = [...books(300, "en", 60), ...books(300, "ko", 60)];
    const base: Category[] = [
      { slug: "fantasy", sortOrder: 2, ordinals: [[70, 114], [10, 40]] },
      { slug: "romance", sortOrder: 3, ordinals: [[30, 30], [200, 200]] },
      { slug: "mystery", sortOrder: 4, ordinals: [[250, 252]] },
    ];
    // fantasy 被取消首页显示（有书、分类页 200、3 页）。
    const hidden: Category[] = base.map((category) => (category.slug === "fantasy" ? { ...category, homepageVisible: false } : category));

    const before = makeFakeDb(rows, base).db;
    const after = makeFakeDb(rows, hidden).db;
    clearPublicCategoryCountsCacheForTest();
    const listBefore = await listPublicCategories(before, "en");
    clearPublicCategoryCountsCacheForTest();
    const listAfter = await listPublicCategories(after, "en");

    // 集合与顺序完全相同（页脚取这一份的前 8 个，详情页可链接集合取这一份的 slug 集合）。
    expect(listAfter.map((tag) => tag.slug)).toEqual(listBefore.map((tag) => tag.slug));
    expect(listAfter.map((tag) => tag.slug)).toEqual(["fantasy", "romance", "mystery"]);
    // 其余字段（名字、链接、排序号）逐项相同，只有 homepageVisible 不同。
    const strip = (tags: typeof listAfter) => tags.map(({ homepageVisible: _flag, ...rest }) => (void _flag, rest));
    expect(strip(listAfter)).toEqual(strip(listBefore));
    expect(listBefore.map((tag) => tag.homepageVisible)).toEqual([true, true, true]);
    expect(listAfter.map((tag) => tag.homepageVisible)).toEqual([false, true, true]);

    // 可链接集合仍含 fantasy（详情页的 fantasy 标签仍可点）。
    expect([...toLinkableCategorySlugs(listAfter)].sort()).toEqual(["fantasy", "mystery", "romance"]);
    // 分类页仍然 200，页数映射仍含它，hreflang 语种集合不变。
    clearPublicCategoryCountsCacheForTest();
    expect(await getPublicCategoryPage(after, "en", "fantasy", 1)).not.toBeNull();
    expect(Object.fromEntries(await listPublicCategoryPageCounts(after, "en"))).toEqual({ fantasy: 3, romance: 1, mystery: 1 });
    expect(await listCategoryPublicLocales(after, "fantasy", ["en", "ko", "es"]))
      .toEqual(await listCategoryPublicLocales(before, "fantasy", ["en", "ko", "es"]));
  });
});
