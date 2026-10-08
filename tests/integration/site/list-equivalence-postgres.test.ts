/**
 * B-38 第二段·真实库用例 2/7：数据库分页的列表 === 改造前逻辑去掉上限。
 *
 * 参照算法（权威，不共用被测代码）：
 *   - 全部作品页：Prisma `findMany`，`where` 用 `buildPublicListArticleWhere`，**不设 take**，
 *     再 `filterPromoReady`（程序里的 `isPromoReady`），排序为发布时间降序、编号升序；
 *   - 分类页：在上面的列表基础上，用**冻结的改造前现场计算**（`tests/fixtures/public-taxonomy-before-b38.ts`）
 *     给每本书算出它的分类，留下含该分类的那些。
 * 被测：`getPublicBrowsePage` / `getPublicCategoryPage` 一页一页拼起来，要与参照逐 id 相等，
 * `totalCount` 与 `totalPages` 也要相等。
 *
 * 夹具把所有"不进列表"的原因混在一起（见 `site-fixtures.ts`）：
 *   - 文章：草稿、下架、撤回、已删除；SEO 可见性 hidden / seo_only（开关开、关各跑一遍）；
 *   - 小说：未发布（draft / ready / unpublished / takedown）、已删除；
 *   - 推广链接：pending / failed / registered_disabled、空串、纯空白、各种 Unicode 空白、NULL、只有 App 链接；
 *   - 发布时间大量并列（只有 30 个整分钟）；三个语种；
 *   - 分类：人工 / 映射 / 自动三套来源交叉，停用分类，自动标签开关开、关各一遍。
 * 全部由 `seed` 决定，失败可复现；夹具由 owner 直接写真源表，之后对账一次归属表。
 *
 * 运行：`bash scripts/run-public-list-postgres-verification.sh`（一次性 postgres:16.14，真实角色）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getPublicBrowsePage, listHomeNovels, HOME_GRID_LIMIT } from "@/lib/site/queries";
import { getPublicCategoryPage } from "@/lib/site/category-queries";
import { clearPublicCategoryCountsCacheForTest } from "@/lib/site/public-list";
import { reconcileAllEffectiveTags } from "@/server/tagging/effective-tag-projection";
import * as legacy from "../../fixtures/public-taxonomy-before-b38";
import {
  assertIsolatedDatabase,
  connectRoles,
  disconnectRoles,
  enabled,
  resetDatabase,
  seedFoundation,
  TAG_SPECS,
  type Foundation,
} from "../tagging/effective-tag-fixtures";
import {
  envFor,
  expectedTotalPages,
  PAGE_SIZE,
  referenceList,
  seedListScenario,
  FIXTURE_SITES,
  type ListScenario,
  type ReferenceCard,
} from "./site-fixtures";

const roles = connectRoles();
const { owner, web } = roles;

let foundation: Foundation;
let scenario: ListScenario;
const activeSlugs = TAG_SPECS.filter((spec) => spec.status === "active").map((spec) => spec.slug);

type Combo = Readonly<{ name: string; autoTags: boolean; seoVisibility: boolean }>;
const COMBOS: readonly Combo[] = [
  { name: "自动标签关 · SEO 可见性关", autoTags: false, seoVisibility: false },
  { name: "自动标签开 · SEO 可见性开", autoTags: true, seoVisibility: true },
  { name: "自动标签关 · SEO 可见性开", autoTags: false, seoVisibility: true },
  { name: "自动标签开 · SEO 可见性关", autoTags: true, seoVisibility: false },
];

/** 一个语种的分类参照：参照列表里，冻结的现场计算给出的分类含该 slug 的那些。 */
async function referenceCategory(locale: string, slug: string, list: readonly ReferenceCard[], env: NodeJS.ProcessEnv) {
  const tags = await legacy.loadPublicTaxonomyByNovelIds(web, list.map((card) => card.novelId), locale, env);
  return list.filter((card) => (tags.get(card.novelId) ?? []).some((tag) => tag.slug === slug));
}

async function collectPages(
  fetchPage: (page: number) => Promise<{ novels: Array<{ id: string }>; totalPages: number; totalCount: number } | null>,
) {
  const first = await fetchPage(1);
  if (!first) return null;
  const ids = [...first.novels.map((novel) => novel.id)];
  for (let page = 2; page <= first.totalPages; page += 1) {
    const next = await fetchPage(page);
    expect(next, `page ${page}`).not.toBeNull();
    expect(next!.totalCount).toBe(first.totalCount);
    expect(next!.totalPages).toBe(first.totalPages);
    ids.push(...next!.novels.map((novel) => novel.id));
  }
  return { ids, totalCount: first.totalCount, totalPages: first.totalPages, firstPageSize: first.novels.length };
}

describe.skipIf(!enabled).sequential("B-38 公开列表等价：数据库分页 === 改造前逻辑去掉上限（真实角色、真实迁移、真实 grants）", () => {
  beforeAll(async () => {
    await assertIsolatedDatabase(owner);
    await resetDatabase(owner);
    foundation = await seedFoundation(owner);
    scenario = await seedListScenario(owner, foundation, { novels: 700, seed: 20_261_010 });
    // 夹具由 owner 直接写真源表（绕过写入点），所以这里要显式对账一次，把归属表带到"应有"状态
    await reconcileAllEffectiveTags(web);
  }, 240_000);
  beforeEach(() => { clearPublicCategoryCountsCacheForTest(); });
  afterAll(async () => { await disconnectRoles(roles); });

  it("用的是真实角色身份", async () => {
    expect(await web.$queryRaw`SELECT current_user AS role`).toEqual([{ role: "web_app" }]);
  });

  it("夹具不是空壳：所有'不进列表'的原因都出现过，列表可见的书足够多页", async () => {
    const stats = scenario.stats;
    for (const key of [
      "article:published", "article:draft", "article:unpublished", "article:takedown", "article:published:deleted",
      "seo:public", "seo:seo_only", "seo:hidden",
      "novel:published", "novel:unpublished", "novel:draft", "novel:takedown",
      "promo:fetched:text", "promo:fetched:blank", "promo:fetched:null", "promo:pending:null", "promo:failed:text",
    ]) expect(stats[key] ?? 0, key).toBeGreaterThan(0);
    const reference = await referenceList(web, "en", envFor({ seoVisibility: true }));
    expect(reference.length).toBeGreaterThan(PAGE_SIZE * 5);
    const withoutVisibilityFlag = await referenceList(web, "en", envFor({ seoVisibility: false }));
    expect(withoutVisibilityFlag.length).toBeGreaterThan(reference.length); // 开关开后 hidden / seo_only 被排除
    for (const locale of FIXTURE_SITES) expect((await referenceList(web, locale, envFor({}))).length).toBeGreaterThan(PAGE_SIZE);
  });

  for (const combo of COMBOS) {
    describe(combo.name, () => {
      const env = envFor(combo);

      it.each(FIXTURE_SITES)("全部作品页 %s：逐页拼起来与参照逐 id 相等，totalCount / totalPages 相等", async (locale) => {
        const reference = await referenceList(web, locale, env);
        const collected = await collectPages(async (page) => getPublicBrowsePage(web, locale, page, env));
        expect(collected!.ids).toEqual(reference.map((card) => card.businessId));
        expect(collected!.totalCount).toBe(reference.length);
        expect(collected!.totalPages).toBe(expectedTotalPages(reference.length));
        // 每一页满 20 本（最后一页除外）。
        const beyond = await getPublicBrowsePage(web, locale, collected!.totalPages + 1, env);
        expect(beyond.novels).toEqual([]);
        expect(beyond.totalCount).toBe(reference.length);
      }, 120_000);

      it.each(FIXTURE_SITES)("分类页 %s：每个启用分类逐页拼起来与参照（冻结的现场计算）逐 id 相等；没有书的分类是 null", async (locale) => {
        const list = await referenceList(web, locale, env);
        let nonEmpty = 0;
        for (const slug of activeSlugs) {
          const expected = await referenceCategory(locale, slug, list, env);
          const collected = await collectPages(async (page) => getPublicCategoryPage(web, locale, slug, page, env));
          if (expected.length === 0) {
            expect(collected, `${locale}/${slug} 没有书 → 404`).toBeNull();
            continue;
          }
          nonEmpty += 1;
          expect(collected, `${locale}/${slug}`).not.toBeNull();
          expect(collected!.ids, `${locale}/${slug}`).toEqual(expected.map((card) => card.businessId));
          expect(collected!.totalCount).toBe(expected.length);
          expect(collected!.totalPages).toBe(expectedTotalPages(expected.length));
          // 最后一页之后 404。
          expect(await getPublicCategoryPage(web, locale, slug, collected!.totalPages + 1, env)).toBeNull();
        }
        expect(nonEmpty, `${locale} 至少有几个分类有书`).toBeGreaterThanOrEqual(4);
      }, 240_000);

      it("首页作品格：直接 LIMIT，就是列表前 HOME_GRID_LIMIT 本", async () => {
        const reference = await referenceList(web, "en", env);
        const home = await listHomeNovels(web, "en", env);
        expect(home.map((card) => card.id)).toEqual(reference.slice(0, HOME_GRID_LIMIT).map((card) => card.businessId));
        expect(home).toHaveLength(HOME_GRID_LIMIT);
      });
    });
  }

  it("规则逐条：排序（发布时间降序、同时间编号升序）、并列确实大量存在", async () => {
    const env = envFor({ seoVisibility: true });
    const rows = await web.article.findMany({
      where: { locale: "en", status: "published", deletedAt: null, seoVisibility: "public" },
      select: { id: true, publishedAt: true, novel: { select: { businessId: true } } },
    });
    const times = new Map<number, number>();
    for (const row of rows) times.set(row.publishedAt!.valueOf(), (times.get(row.publishedAt!.valueOf()) ?? 0) + 1);
    expect(Math.max(...times.values())).toBeGreaterThan(5); // 并列确实存在
    const collected = await collectPages(async (page) => getPublicBrowsePage(web, "en", page, env));
    const byBusinessId = new Map(rows.map((row) => [row.novel!.businessId, row]));
    const sequence = collected!.ids.map((id) => byBusinessId.get(id)!);
    for (let index = 1; index < sequence.length; index += 1) {
      const previous = sequence[index - 1]!;
      const current = sequence[index]!;
      const delta = previous.publishedAt!.valueOf() - current.publishedAt!.valueOf();
      expect(delta, `${index}`).toBeGreaterThanOrEqual(0);
      if (delta === 0) expect(previous.id < current.id, `并列时编号升序 @${index}`).toBe(true);
    }
  });

  it("没有任何书的语种：第 1 页是空列表、总数 0、总页数 1（页面据此 200，第 2 页 404）；分类页是 null", async () => {
    const env = envFor({ seoVisibility: true });
    const page1 = await getPublicBrowsePage(web, "pl", 1, env);
    expect(page1).toMatchObject({ novels: [], page: 1, totalPages: 1, totalCount: 0 });
    const page2 = await getPublicBrowsePage(web, "pl", 2, env);
    expect(page2).toMatchObject({ novels: [], page: 2, totalPages: 1, totalCount: 0 });
    expect(await getPublicCategoryPage(web, "pl", activeSlugs[0]!, 1, env)).toBeNull();
  });

  it("分类停用后立即 404（实时判定，不经任何缓存）", async () => {
    const env = envFor({ autoTags: true, seoVisibility: true });
    const slug = "alpha";
    expect(await getPublicCategoryPage(web, "en", slug, 1, env)).not.toBeNull();
    await owner.canonicalTag.update({ where: { id: foundation.tags.alpha! }, data: { status: "inactive" } });
    try {
      expect(await getPublicCategoryPage(web, "en", slug, 1, env)).toBeNull();
    } finally {
      await owner.canonicalTag.update({ where: { id: foundation.tags.alpha! }, data: { status: "active" } });
    }
    expect(await getPublicCategoryPage(web, "en", slug, 1, env)).not.toBeNull();
  });

  it("非法页码按第 1 页；极大页码不报错、返回空页（OFFSET 装不下也不 500）", async () => {
    const env = envFor({ seoVisibility: true });
    const first = await getPublicBrowsePage(web, "en", 1, env);
    expect((await getPublicBrowsePage(web, "en", 0, env)).novels.map((n) => n.id)).toEqual(first.novels.map((n) => n.id));
    expect((await getPublicBrowsePage(web, "en", Number.NaN, env)).page).toBe(1);
    const huge = await getPublicBrowsePage(web, "en", Number.MAX_SAFE_INTEGER, env);
    expect(huge.novels).toEqual([]);
    expect(huge.totalCount).toBe(first.totalCount);
    const beyondBigint = await getPublicBrowsePage(web, "en", 1e21, env);
    expect(beyondBigint.novels).toEqual([]);
    expect(beyondBigint.totalCount).toBe(first.totalCount);
    expect(await getPublicCategoryPage(web, "en", "alpha", 1e21, env)).toBeNull();
  });
});
