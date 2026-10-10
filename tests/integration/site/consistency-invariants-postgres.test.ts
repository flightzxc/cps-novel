/**
 * B-38 第二段·真实库用例 3/7：一致性不变量——"同一把尺子"在每个语种都成立。
 *
 * 站点地图、站内链接、404 判定、作品数、分页、页脚、首页题材导航、hreflang 用的是 `src/lib/site/public-list.ts`
 * 里同一段列表可见性 / 分类归属 SQL（实时的分页 / 计数，和最多晚 60 秒的矩阵缓存）。历史上 B-38 的现象就是这些
 * 判断各算各的、互相漂移（站点地图列了、页面 404）。这里在真实库上、三个有书的语种 + 一个空语种、四种开关组合下，
 * 逐条核对：
 *
 *   A. 站点地图（worker_app 角色）的分类网址集合（含 `?page=N`）=== 分类页（web_app）真实返回非 null 的 (slug, page) 集合；
 *      站点地图列出的最后一页的下一页，页面必须是 null；
 *   B. `listPublicCategories`（页脚 / 首页题材导航 / 详情页可链接分类集合）的 slug 集合 === 第 1 页非 null 的分类集合；
 *   C. 某分类的 hreflang 语种集合（`listCategoryPublicLocales`）=== 该分类第 1 页非 null 的语种集合（15 个登记语种逐个对）；
 *   D. `totalCount` === 所有页卡片数之和，且 `totalPages` === ceil(totalCount / 20)；
 *   E. 站点地图用的页数映射（`listPublicCategoryPageCounts`）=== 页面自己的总页数。
 *
 * 运行：`bash scripts/run-public-list-postgres-verification.sh`（一次性 postgres:16.14，真实角色）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SITE_LOCALES, type SiteLocale } from "@/lib/locale/locale-canonical";
import { createSitemapFamilyBuilder, type SitemapEntry } from "@/lib/seo/sitemap";
import { listCategoryPublicLocales } from "@/lib/site/category-locales";
import { getPublicCategoryPage, listPublicCategoryPageCounts } from "@/lib/site/category-queries";
import { clearPublicCategoryCountsCacheForTest } from "@/lib/site/public-list";
import { listPublicCategories } from "@/lib/site/queries";
import { reconcileAllEffectiveTags } from "@/server/tagging/effective-tag-projection";
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
import { envFor, expectedTotalPages, seedListScenario, FIXTURE_SITES } from "./site-fixtures";

const roles = connectRoles();
const { owner, web, worker } = roles;

const SITE = "https://consistency.example";
const SITES_UNDER_TEST: readonly SiteLocale[] = [...FIXTURE_SITES, "ru"]; // ru：没有任何书的空语种
/** 库里全部分类（含停用的 zeta）：停用分类的页面必须是 null。 */
const ALL_SLUGS = TAG_SPECS.map((spec) => spec.slug);

let foundation: Foundation;

type CategoryUrl = { slug: string; page: number };

function categoryUrls(entries: readonly SitemapEntry[], locale: SiteLocale): CategoryUrl[] {
  const prefix = locale === "en" ? "" : `/${locale}`;
  const pattern = new RegExp(`^${SITE.replaceAll(".", "\\.")}${prefix}/category/([^?/]+)(?:\\?page=(\\d+))?$`);
  const urls: CategoryUrl[] = [];
  for (const entry of entries) {
    const match = pattern.exec(entry.loc);
    if (match) urls.push({ slug: match[1]!, page: match[2] ? Number(match[2]) : 1 });
  }
  return urls;
}

/** 页面（web_app）的事实：对每个分类从第 1 页翻到 null 为止。 */
async function pageFacts(locale: SiteLocale, env: NodeJS.ProcessEnv) {
  const pages = new Set<string>();
  const totals = new Map<string, { totalPages: number; totalCount: number; cards: number }>();
  for (const slug of ALL_SLUGS) {
    let page = 1;
    let cards = 0;
    // 上限 = 第 1 页报告的总页数 + 1（第 N+1 页必须是 null）。不设上限的话，"超出页码不再 404"这类回归会让
    // 循环永远翻下去：用例超时后循环仍在后台查库，运行器挂住而不是变红（主会话复核变异实测）。
    let lastAllowedPage = Number.POSITIVE_INFINITY;
    for (;;) {
      if (page > lastAllowedPage) {
        throw new Error(`${locale}/${slug}: page ${page} is beyond totalPages ${lastAllowedPage - 1} + 1 and still returned a page`);
      }
      const result = await getPublicCategoryPage(web, locale, slug, page, env);
      if (!result) break;
      pages.add(`${slug}|${page}`);
      cards += result.novels.length;
      if (page === 1) {
        totals.set(slug, { totalPages: result.totalPages, totalCount: result.totalCount, cards: 0 });
        lastAllowedPage = result.totalPages + 1;
      }
      page += 1;
    }
    if (totals.has(slug)) totals.get(slug)!.cards = cards;
  }
  return { pages, totals };
}

describe.skipIf(!enabled).sequential("B-38 一致性不变量（站点地图 / 页脚 / hreflang / 分页 / 作品数同源）", () => {
  beforeAll(async () => {
    process.env.SITE_URL = SITE;
    await assertIsolatedDatabase(owner);
    await resetDatabase(owner);
    await owner.siteSetting.create({ data: { id: 1 } });
    foundation = await seedFoundation(owner);
    await seedListScenario(owner, foundation, { novels: 600, seed: 20_261_011 });
    await reconcileAllEffectiveTags(web);
  }, 240_000);
  beforeEach(() => { clearPublicCategoryCountsCacheForTest(); });
  afterAll(async () => {
    delete process.env.SITE_URL;
    await disconnectRoles(roles);
  });

  const combos = [
    { name: "自动标签开 · SEO 可见性开", autoTags: true, seoVisibility: true },
    { name: "自动标签关 · SEO 可见性关", autoTags: false, seoVisibility: false },
    { name: "自动标签开 · SEO 可见性关", autoTags: true, seoVisibility: false },
    { name: "自动标签关 · SEO 可见性开", autoTags: false, seoVisibility: true },
  ];

  it("用的是真实角色身份（页面 web_app、站点地图 worker_app）", async () => {
    expect(await web.$queryRaw`SELECT current_user AS role`).toEqual([{ role: "web_app" }]);
    expect(await worker.$queryRaw`SELECT current_user AS role`).toEqual([{ role: "worker_app" }]);
  });

  for (const combo of combos) {
    describe(combo.name, () => {
      const env = envFor(combo);

      it.each(SITES_UNDER_TEST)("A·站点地图分类网址集合（含 ?page=N）=== 分类页真实返回非 null 的 (slug, page) 集合 · %s", async (locale) => {
        const files = await createSitemapFamilyBuilder(worker, env)({ type: "mainpage", locale });
        const urls = categoryUrls(files.flatMap((file) => file.entries), locale);
        const facts = await pageFacts(locale, env);
        const fromSitemap = new Set(urls.map((url) => `${url.slug}|${url.page}`));
        expect([...fromSitemap].sort()).toEqual([...facts.pages].sort());
        // 列出的最后一页之后的那一页，页面必须是 null（站点地图不会多列）。
        for (const slug of new Set(urls.map((url) => url.slug))) {
          const last = Math.max(...urls.filter((url) => url.slug === slug).map((url) => url.page));
          expect(await getPublicCategoryPage(web, locale, slug, last + 1, env), `${locale}/${slug} 第 ${last + 1} 页`).toBeNull();
        }
        if (locale === "ru") {
          expect(files).toEqual([]); // 空语种没有 mainpage 分片
          expect(urls).toEqual([]);
        } else {
          expect(urls.length, `${locale} 非空`).toBeGreaterThan(4);
        }
      }, 240_000);

      it.each(SITES_UNDER_TEST)("B·listPublicCategories 的 slug 集合 === 第 1 页非 null 的分类集合 · %s", async (locale) => {
        const footer = (await listPublicCategories(web, locale, env)).map((tag) => tag.slug);
        const facts = await pageFacts(locale, env);
        const firstPages = [...facts.pages].filter((key) => key.endsWith("|1")).map((key) => key.split("|")[0]!);
        expect([...footer].sort()).toEqual(firstPages.sort());
        // 排序 = 分类自己的排序（sort_order，再 slug）。
        const order = new Map(TAG_SPECS.map((spec) => [spec.slug, spec.sort] as const));
        for (let index = 1; index < footer.length; index += 1) {
          const [a, b] = [footer[index - 1]!, footer[index]!];
          expect(order.get(a)! < order.get(b)! || (order.get(a) === order.get(b) && a.localeCompare(b, "en") < 0)).toBe(true);
        }
        // 停用分类（zeta）永远不在。
        expect(footer).not.toContain("zeta");
      }, 120_000);

      it.each(SITES_UNDER_TEST)("D·totalCount === 所有页卡片数之和，totalPages === ceil(totalCount / 20) · %s", async (locale) => {
        const facts = await pageFacts(locale, env);
        for (const [slug, total] of facts.totals) {
          expect(total.cards, `${locale}/${slug} 卡片数之和`).toBe(total.totalCount);
          expect(total.totalPages, `${locale}/${slug} 总页数`).toBe(expectedTotalPages(total.totalCount));
        }
      }, 120_000);

      it.each(SITES_UNDER_TEST)("E·站点地图用的页数映射（listPublicCategoryPageCounts，worker_app）=== 页面自己的总页数 · %s", async (locale) => {
        const counts = await listPublicCategoryPageCounts(worker, locale, env);
        const facts = await pageFacts(locale, env);
        expect([...counts.keys()].sort()).toEqual([...facts.totals.keys()].sort());
        for (const [slug, total] of facts.totals) expect(counts.get(slug), `${locale}/${slug}`).toBe(total.totalPages);
      }, 120_000);

      it("C·某分类的 hreflang 语种集合 === 该分类第 1 页非 null 的语种集合（15 个登记语种逐个对）", async () => {
        const firstPageSites = new Map<string, Set<string>>(ALL_SLUGS.map((slug) => [slug, new Set<string>()]));
        for (const locale of SITE_LOCALES) {
          for (const slug of ALL_SLUGS) {
            if (await getPublicCategoryPage(web, locale, slug, 1, env)) firstPageSites.get(slug)!.add(locale);
          }
        }
        let withSomeLocale = 0;
        for (const slug of ALL_SLUGS) {
          const expected = firstPageSites.get(slug)!;
          const listed = await listCategoryPublicLocales(web, slug, SITE_LOCALES, env);
          expect([...listed].sort(), slug).toEqual([...expected].sort());
          // 返回顺序 = 候选语种的顺序。
          expect(listed, slug).toEqual(SITE_LOCALES.filter((locale) => expected.has(locale)));
          if (expected.size > 0) withSomeLocale += 1;
        }
        expect(withSomeLocale).toBeGreaterThanOrEqual(4);
        expect(firstPageSites.get("zeta")!.size).toBe(0);
        // 候选缩窄时只在候选里挑（分类页 hreflang 传的是"活跃语种去掉当前语种"）。
        const slug = [...firstPageSites].find(([, set]) => set.size >= 2)![0];
        const narrowed = await listCategoryPublicLocales(web, slug, ["es", "ko"], env);
        expect(narrowed).toEqual((["es", "ko"] as const).filter((locale) => firstPageSites.get(slug)!.has(locale)));
        // slug 规范化与页面入口一致：大小写 / 首尾空白。
        expect(await listCategoryPublicLocales(web, `  ${slug.toUpperCase()} `, SITE_LOCALES, env))
          .toEqual(SITE_LOCALES.filter((locale) => firstPageSites.get(slug)!.has(locale)));
        expect(await listCategoryPublicLocales(web, "", SITE_LOCALES, env)).toEqual([]);
        expect(await listCategoryPublicLocales(web, slug, [], env)).toEqual([]);
      }, 240_000);
    });
  }

  it("v0.5.15·运营取消某个有书分类的「首页显示」后：分类页仍 200、站点地图页数映射仍含它、listPublicCategories 仍含它（homepageVisible=false）", async () => {
    const env = envFor({ autoTags: true, seoVisibility: true });
    clearPublicCategoryCountsCacheForTest();
    const before = await listPublicCategories(web, "en", env);
    expect(before.length).toBeGreaterThan(2);
    expect(before.every((tag) => tag.homepageVisible)).toBe(true); // 迁移默认值
    const target = before[0]!;
    const pageBefore = await getPublicCategoryPage(web, "en", target.slug, 1, env);
    const countsBefore = await listPublicCategoryPageCounts(worker, "en", env);
    expect(pageBefore).not.toBeNull();
    expect(countsBefore.has(target.slug)).toBe(true);

    // 运营在后台取消勾选（保存路径只改这一列、不动 updated_at；这里用 owner 直接模拟结果）。
    await owner.$executeRaw`UPDATE canonical_tag SET is_homepage_visible = false WHERE slug = ${target.slug}`;
    try {
      clearPublicCategoryCountsCacheForTest();
      const after = await listPublicCategories(web, "en", env);
      // 页脚 / 可链接集合用的那一份：集合与顺序完全相同，只有该分类的 homepageVisible 变成 false。
      expect(after.map((tag) => tag.slug)).toEqual(before.map((tag) => tag.slug));
      expect(after.find((tag) => tag.slug === target.slug)?.homepageVisible).toBe(false);
      expect(after.filter((tag) => tag.slug !== target.slug).every((tag) => tag.homepageVisible)).toBe(true);
      // 分类页仍 200（总页数、总本数与取消前相同），站点地图页数映射仍含它。
      const pageAfter = await getPublicCategoryPage(web, "en", target.slug, 1, env);
      expect(pageAfter).not.toBeNull();
      expect(pageAfter?.totalPages).toBe(pageBefore!.totalPages);
      expect(pageAfter?.totalCount).toBe(pageBefore!.totalCount);
      const countsAfter = await listPublicCategoryPageCounts(worker, "en", env);
      expect([...countsAfter.keys()].sort()).toEqual([...countsBefore.keys()].sort());
      expect(countsAfter.get(target.slug)).toBe(countsBefore.get(target.slug));
    } finally {
      await owner.$executeRaw`UPDATE canonical_tag SET is_homepage_visible = true WHERE slug = ${target.slug}`;
    }
  }, 120_000);

  it("矩阵缓存是 60 秒窗口：缓存期内矩阵不变，而分页 / 计数 / 404 判定是实时的", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-09T00:00:00Z"));
      const env = envFor({ autoTags: true, seoVisibility: true });
      // 选一个当前有书的分类，把它的所有文章下架 → 页面立即 404，而页脚还认为它存在（≤ 60 秒）。
      const before = await listPublicCategories(web, "en", env);
      const slug = before[0]!.slug;
      const page = await getPublicCategoryPage(web, "en", slug, 1, env);
      expect(page).not.toBeNull();
      const ids = await owner.$queryRaw<Array<{ id: string }>>`
        SELECT a.id FROM article a
        WHERE a.locale = 'en' AND a.status = 'published' AND a.deleted_at IS NULL AND EXISTS (
          SELECT 1 FROM novel_effective_tag m JOIN canonical_tag ct ON ct.id = m.canonical_tag_id
          WHERE ct.slug = ${slug} AND m.novel_id = a.novel_id)`;
      await owner.article.updateMany({ where: { id: { in: ids.map((row) => row.id) } }, data: { status: "unpublished" } });
      try {
        expect(await getPublicCategoryPage(web, "en", slug, 1, env)).toBeNull(); // 实时
        vi.setSystemTime(new Date("2026-10-09T00:00:30Z"));
        expect((await listPublicCategories(web, "en", env)).map((tag) => tag.slug)).toContain(slug); // 缓存期内仍在
        vi.setSystemTime(new Date("2026-10-09T00:01:01Z"));
        expect((await listPublicCategories(web, "en", env)).map((tag) => tag.slug)).not.toContain(slug); // 过期后刷新
      } finally {
        await owner.article.updateMany({ where: { id: { in: ids.map((row) => row.id) } }, data: { status: "published" } });
      }
    } finally {
      vi.useRealTimers();
    }
  }, 120_000);
});
