import { describe, expect, it } from "vitest";

import { getPublicCategoryPage, listPublicCategoryPageCounts } from "@/lib/site/category-queries";
import { toLinkableCategorySlugs } from "@/lib/site/category-links";
import { listPublicCategories } from "@/lib/site/queries";

import { bookRow, books, makeFakeDb, type Category, type Row } from "../../fixtures/in-memory-public-db";

/**
 * B-38 第二部分：详情页的"可链接分类集合"取页脚用的 `listPublicCategories`（请求内已取过一份，复用它新增 0 次查询），
 * 而不是另写一份"分类下有没有书"的查询。这条复用成立的前提是：它与分类页 / 站点地图共用的唯一谓词
 * （`category-queries.ts` 的 `cardsInCategory`，经 `getPublicCategoryPage` 与 `listPublicCategoryPageCounts`）
 * 给出**完全相同**的 slug 集合。这里在默认 `npm test` 里用遵守 `take` / 排序的内存 db 钉死这一等价关系；
 * 真实库（真实角色、真实约束、`seo_only`、空白推广地址噪声）的同款用例在
 * `tests/integration/tasks/sitemap-category-cap-postgres.test.ts`。
 *
 * 每个场景都断言四件事：
 *   1. `listPublicCategories` 的 slug 集合 === `listPublicCategoryPageCounts` 的键集合；
 *   2. 该集合里的每个分类，`getPublicCategoryPage` 都不为 null；
 *   3. 库里存在、但不在该集合里的分类，`getPublicCategoryPage` 都是 null（等价是双向的，不是"只多不少"）；
 *   4. 集合不是空洞地等于"全部分类"——每个场景都有至少一个被排除的分类（除了刻意验证"全在窗口里"的那个）。
 */

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
  const { db } = makeFakeDb(rows, categories);
  const { footer, counts, linkable } = await slugSets(db, locale);
  expect([...footer].sort(), `${scenario}: 页脚集合 === 页面返回 200 的分类集合`).toEqual([...counts].sort());
  expect([...linkable].sort(), `${scenario}: 可链接集合 === 页面返回 200 的分类集合`).toEqual([...counts].sort());
  for (const category of categories.filter((candidate) => candidate.locale === undefined || candidate.locale === locale)) {
    const pageOk = (await getPublicCategoryPage(db, locale, category.slug, 1)) !== null;
    expect(linkable.has(category.slug), `${scenario}: ${category.slug} 页面 200=${pageOk}`).toBe(pageOk);
  }
  return { footer, counts };
}

describe("详情页的可链接分类集合 === 分类页返回 200 的分类集合（等价是双向的）", () => {
  const en = books(300);
  const enCategories: Category[] = [
    { slug: "adventure", sortOrder: 1, ordinals: [[5, 50]] }, // 书全在最新 240 本（61..300）之外 → 页面 404
    { slug: "fantasy", sortOrder: 2, ordinals: [[70, 114], [10, 40]] }, // 一半在窗口内 → 页面 200（3 页）
    { slug: "romance", sortOrder: 3, ordinals: [[30, 30], [200, 200]] }, // 一外一内 → 页面 200
    { slug: "mystery", sortOrder: 4, ordinals: [[250, 252]] }, // 全在窗口内 → 页面 200
  ];

  it("en 300 本：窗口之外的分类不在集合里，窗口之内的都在；集合与 listPublicCategoryPageCounts 的键完全一致", async () => {
    const { footer } = await expectEquivalent("en 300 本", en, enCategories, "en");
    expect([...footer].sort()).toEqual(["fantasy", "mystery", "romance"]);
    expect(footer.has("adventure")).toBe(false);
  });

  it("语种书目不足 240：每个分类都在窗口里，集合 = 全部分类", async () => {
    const ko = books(30, "ko");
    const { footer } = await expectEquivalent("ko 30 本", ko, [
      { slug: "xuanhuan", sortOrder: 1, ordinals: [[1, 25]], locale: "ko" },
      { slug: "yanqing", sortOrder: 2, ordinals: [[26, 30]], locale: "ko" },
    ], "ko");
    expect([...footer].sort()).toEqual(["xuanhuan", "yanqing"]);
  });

  it("推广地址纯空白的书不进列表（filterPromoReady 在截断之后执行）：只挂在它身上的分类两边都不出现", async () => {
    // 序号 299 的推广地址只有空白：`listPublicArticles` 与 `listPublicCategories` 都在取到前 240 行后才去掉它，
    // 它独占的 staff-pick 因此在两边都消失；序号 300 正常，seen-it 在两边都在。
    const rows = books(300);
    rows[298] = { ...bookRow(299), promoLink: { ...bookRow(299).promoLink, webUrl: "   " } };
    const { footer } = await expectEquivalent("空白推广地址", rows, [
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

  it("分类很多（12 个，每个只挂窗口之内的一本）：集合与页数映射的键一致", async () => {
    const many: Category[] = Array.from({ length: 12 }, (_, index) => ({
      slug: `cat-${index + 1}`, sortOrder: index + 1, ordinals: [[250 + index, 250 + index]] as const,
    }));
    const { footer } = await expectEquivalent("12 个分类", en, [...many, { slug: "old-only", sortOrder: 99, ordinals: [[1, 5]] }], "en");
    expect(footer.size).toBe(12);
    expect(footer.has("old-only")).toBe(false);
  });
});
