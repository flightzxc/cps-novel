/**
 * B-38（2026-10-07 切换验收；v0.5.13 改为数据库分页后的口径）：站点地图列了 `/category/adventure`，访问却是 404。
 *
 * 历史根因：站点地图按该语种**全部**公开书目判定"这个分类下有没有书"，而分类页只在 `listPublicArticles` 的最新 240 本里
 * 内存过滤、结果为 0 就 `notFound()`。v0.5.13 起窗口没有了——分类页、站点地图、页脚、hreflang、站内分类链接共用
 * `src/lib/site/public-list.ts` 里同一段列表可见性 / 分类归属 SQL。但站点地图候选与页面列表仍有**一处有意的口径差**：
 * 候选保留 `seo_only`（可收录），列表不收（不进列表）。所以"只有 seo_only 书的分类"依然是"站点地图候选里有、页面 404"的
 * 候选情形，站点地图必须不列它——这条用例用 seo_only 的书重现历史上"列了、404"的那类分歧。
 *
 * 这里用真实 PostgreSQL 16.14、真实表约束、真实角色（站点地图走 worker_app，页面走 web_app）：
 *   1. 分类的书全部不进列表（序号 1..60 是 seo_only，开关打开）→ 站点地图不列，页面确实是 404；
 *   2. 分类有书进列表 → 照常列出（`?page=N` 只到页面的总页数 = ceil(进列表的本数 / 20)，**没有任何截断**）；
 *      保留分类的 lastmod 仍按全量候选（含不进列表的书）算；
 *   3. 其它网址（首页、小说页、章节页、博客页、小语种的分类页）与独立 SQL 预期逐条一致；
 *   4. 对照断言：站点地图列出的每个分类网址 `getPublicCategoryPage` 都不为 null，且页面是 200 的分类都在站点地图里（双向）；
 *   5. SEO 可见性开关：关闭时不区分 seo_only，所有书进列表，adventure 重新出现；打开时 cap-299/300 变成 seo_only → staff-pick 消失；
 *   6. 性能：每个语种只读一次每语种每分类本数矩阵，与分类个数无关；其它家族不碰矩阵。
 *
 * B-38 第二部分（同一批夹具，站内分类链接）：详情页标签 / 推荐卡片的 `href` 只给页面返回 200 的分类。
 *   7. 详情页数据层（真实 `public-load`，走 web_app 角色）给出的"可链接分类集合"（页脚用的 `listPublicCategories`）
 *      与 `listPublicCategoryPageCounts` 的键集合**完全一致**，集合里每个分类 `getPublicCategoryPage` 都不为 null，
 *      集合之外的分类页面都是 null；不进列表的书（cap-30，seo_only）的详情视图里，列表里没有书的 adventure 没有 href，其余照常有；
 *   8. 推荐卡片（候选池只含进列表的书）：每张卡片的每个标签页面都是 200，所以都带 href；
 *   9. `seo_only`：书只是 seo_only（详情页可达、列表不收），它独占的分类页面 404，详情视图里该标签没有 href；
 *  10. 语种错配（详情页）：判定集合按书自己的语种取。同一个分类在 en 里有进列表的书、在 es 里没有（反向亦然）：
 *      es 详情页上前者无 href、后者有 href（带 /es 前缀）；
 *  11. 语种错配（推荐卡片）：es 的推荐卡片按 es 的矩阵判定，标签 href 带 /es 前缀、页面都是 200。
 *
 * 开关与角色约定同 `sitemap-refresh-postgres.test.ts`（同一个运行器喂同一组环境变量）。
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { createSitemapFamilyBuilder, type SitemapEntry, type SitemapType } from "@/lib/seo/sitemap";
import { getPublicCategoryPage, listPublicCategoryPageCounts } from "@/lib/site/category-queries";
import { clearPublicCategoryCountsCacheForTest } from "@/lib/site/public-list";
import { BROWSE_PAGE_SIZE, listPublicCategories } from "@/lib/site/queries";
import { clearRelatedNovelsPoolCacheForTest } from "@/lib/site/related-novels";
import { reconcileAllEffectiveTags } from "@/server/tagging/effective-tag-projection";

import {
  applyBulkNoise,
  createChannelFixture,
  oracleCategoryNewestArticleUpdate,
  oracleListedArticles,
  oracleVisibleArticles,
  oracleVisibleBlogArticles,
  seedBulkBlogArticles,
  seedBulkPreviewChapters,
  seedBulkPublicArticles,
  seedExistingCategoryRanges,
  seedManualCategoryRanges,
  type ChannelFixture,
  type ManualCategoryRange,
} from "./fixtures/bulk-public-articles";

// 详情页数据层（`@/app/_lib/public-load`）走 `@/app/_lib/public-deps` 的 `prisma`；这里把它指到 web_app 角色的连接
// （与 `tests/integration/tagging/public-auto-postgres.test.ts` 同款做法），测的就是生产里详情页用的那套 loader。
const shared = vi.hoisted(() => ({ web: null as PrismaClient | null }));
vi.mock("@/app/_lib/public-deps", () => ({ prisma: new Proxy({}, { get: (_target, key) => Reflect.get(shared.web!, key) }) }));
import { loadNovelDetail, loadPublicCategories, loadRelatedAndNewReleases } from "@/app/_lib/public-load";

import { classifyPublicListQuery } from "../../fixtures/in-memory-public-db";

const enabled = process.env.SITEMAP_REFRESH_DATABASE_TEST === "1";
const owner = new PrismaClient({ datasourceUrl: process.env.SITEMAP_REFRESH_OWNER_DATABASE_URL });
const web = new PrismaClient({ datasourceUrl: process.env.SITEMAP_REFRESH_WEB_DATABASE_URL });
const worker = new PrismaClient({ datasourceUrl: process.env.SITEMAP_REFRESH_WORKER_DATABASE_URL });

const SITE = "https://sitemap-category-cap.example";
const EN_COUNT = 300;
const KO_COUNT = 30;
const BLOG_COUNT = 30;
const CHAPTERS_PER_NOVEL = 2;
const baseUpdatedAt = new Date("2026-01-01T00:00:00.000Z");
const chapterBaseUpdatedAt = new Date("2026-03-01T00:00:00.000Z");
/** 分类自身 updatedAt 回拨到比所有文章都早，lastmod 才由归属文章决定。 */
const tagUpdatedAt = new Date("2025-01-01T00:00:00.000Z");
/** 一本不进列表的 romance 书，updatedAt 被刻意改得比一切都晚：保留分类的 lastmod 仍按全量候选（含不进列表的书）算。 */
const ROMANCE_UNLISTED_ORDINAL = 30;
const ROMANCE_UNLISTED_UPDATED_AT = new Date("2026-06-01T00:00:00.000Z");
/** 序号 1..UNLISTED_UP_TO 的书是 seo_only（站点地图候选收、页面列表不收）。 */
const UNLISTED_UP_TO = 60;
const SEO_FLAG = "FEATURE_ARTICLE_SEO_VISIBILITY";
const envWith = (seoVisibility: boolean): NodeJS.ProcessEnv => ({ ...process.env, FEATURE_ARTICLE_BLOG: "true", [SEO_FLAG]: String(seoVisibility) });

/**
 * en 共 300 本，序号 1..60 是 seo_only（开关打开时不进页面列表），61..300 进列表。
 * 所有"不进列表"的序号取 ≤ 50，所有"进列表"的序号取 ≥ 70。
 */
const EN_CATEGORIES: readonly ManualCategoryRange[] = [
  // 书全部不进列表：站点地图候选里有，页面 404（本单要钉住的现象）。
  { slug: "adventure", displayName: "Adventure", ordinals: [[7, 50]] },
  // 进列表 45 本（3 页）+ 不进列表 31 本：页数只按进列表的算。
  { slug: "fantasy", displayName: "Fantasy", ordinals: [[70, 114], [10, 40]] },
  // 进列表 1 本 + 不进列表 1 本（后者 updatedAt 被刻意改晚）。
  { slug: "romance", displayName: "Romance", ordinals: [[ROMANCE_UNLISTED_ORDINAL, ROMANCE_UNLISTED_ORDINAL], [200, 200]] },
  { slug: "mystery", displayName: "Mystery", ordinals: [[250, 252]] },
  // 最新的两本；seo_only 用例里把它们改成 seo_only。
  { slug: "staff-pick", displayName: "Staff pick", ordinals: [[299, 300]] },
];
/** ko 共 30 本，全部进列表。 */
const KO_CATEGORIES: readonly ManualCategoryRange[] = [
  { slug: "xuanhuan", displayName: "Xuanhuan", ordinals: [[1, 25]] },
  { slug: "yanqing", displayName: "Yanqing", ordinals: [[26, 30]] },
];

async function resetDatabase() {
  const [{ name, version }] = await owner.$queryRaw<Array<{ name: string; version: string }>>`
    SELECT current_database() AS name, current_setting('server_version') AS version
  `;
  if (!name.startsWith("cps_novel_sitemap_refresh_") || !version.startsWith("16.14")) {
    throw new Error(`Refusing sitemap category-cap test setup against ${name} (${version})`);
  }
  const tables = await owner.$queryRawUnsafe<Array<{ tablename: string }>>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `);
  await owner.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map(({ tablename }) => `"${tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await owner.siteSetting.create({ data: { id: 1 } });
}

async function seedFixture() {
  const channel: ChannelFixture = await createChannelFixture(owner);
  await seedBulkPublicArticles(owner, { prefix: "cap", locale: "en", count: EN_COUNT, channel, baseUpdatedAt });
  await applyBulkNoise(owner, { prefix: "cap", count: EN_COUNT });
  await seedBulkPreviewChapters(owner, {
    prefix: "cap", count: EN_COUNT, chaptersPerNovel: CHAPTERS_PER_NOVEL, baseUpdatedAt: chapterBaseUpdatedAt,
  });
  await seedManualCategoryRanges(owner, { prefix: "cap", count: EN_COUNT, categories: EN_CATEGORIES, tagUpdatedAt });
  await owner.$executeRaw`
    UPDATE article SET updated_at = ${ROMANCE_UNLISTED_UPDATED_AT}::timestamptz
    WHERE id = md5(${`cap-a-${ROMANCE_UNLISTED_ORDINAL}`})::uuid`;
  // 序号 1..60：seo_only——站点地图候选保留（可收录），页面列表不收（开关打开时）。
  await owner.$executeRaw`
    UPDATE article SET seo_visibility = 'seo_only'
    WHERE slug LIKE 'cap-%' AND split_part(slug, '-', 2)::int <= ${UNLISTED_UP_TO}`;

  await seedBulkPublicArticles(owner, { prefix: "ko", locale: "ko", count: KO_COUNT, channel, baseUpdatedAt });
  await seedManualCategoryRanges(owner, { prefix: "ko", count: KO_COUNT, categories: KO_CATEGORIES, tagUpdatedAt });

  await seedBulkBlogArticles(owner, { prefix: "capblog", locale: "en", count: BLOG_COUNT, baseUpdatedAt });
  // 夹具由 owner 直接写真源表（绕过写入点）：显式对账一次归属表，前台与站点地图才读得到这些分类。
  await reconcileAllEffectiveTags(worker);
}

async function build(type: SitemapType, locale: SiteLocale, env: NodeJS.ProcessEnv = envWith(true), db: PrismaClient = worker) {
  const files = await createSitemapFamilyBuilder(db, env)({ type, locale });
  return files.flatMap((file) => file.entries);
}

type CategoryUrl = { slug: string; page: number; entry: SitemapEntry };

/** 从 mainpage 条目里取出分类网址（站点地图里 `/category/{slug}` 与 `?page=N`）。 */
function categoryUrls(entries: readonly SitemapEntry[]): CategoryUrl[] {
  const result: CategoryUrl[] = [];
  for (const entry of entries) {
    const match = /\/category\/([^?/]+)(?:\?page=(\d+))?$/.exec(entry.loc);
    if (match) result.push({ slug: match[1]!, page: match[2] ? Number(match[2]) : 1, entry });
  }
  return result;
}

function listedSlugs(urls: readonly CategoryUrl[]): string[] {
  return [...new Set(urls.map((url) => url.slug))];
}

function ordinalOf(prefix: string, slug: string) {
  return Number(slug.slice(prefix.length + 1));
}

function inRanges(ordinal: number, category: ManualCategoryRange) {
  return category.ordinals.some(([from, to]) => ordinal >= from && ordinal <= to);
}

/** 独立预期：每个分类在"页面列表"里有几本（列表 = 独立 SQL 算出的进列表的公开书，见 `oracleListedArticles`，没有上限）。 */
async function expectedListedCounts(locale: string, prefix: string, categories: readonly ManualCategoryRange[], seoVisibility = true) {
  const listed = await oracleListedArticles(owner, locale, { seoVisibility });
  const counts = new Map<string, number>();
  for (const category of categories) {
    const n = listed.filter((row) => inRanges(ordinalOf(prefix, row.slug), category)).length;
    if (n > 0) counts.set(category.slug, n);
  }
  return counts;
}

describe.skipIf(!enabled).sequential("B-38 站点地图分类网址只列页面返回 200 的（disposable PostgreSQL 16.14）", () => {
  const previousFlag = process.env[SEO_FLAG];
  beforeAll(() => {
    process.env.SITE_URL = SITE;
    process.env[SEO_FLAG] = "true";
    shared.web = web;
  });
  beforeEach(async () => {
    process.env[SEO_FLAG] = "true";
    clearPublicCategoryCountsCacheForTest();
    clearRelatedNovelsPoolCacheForTest();
    await resetDatabase();
    await seedFixture();
  }, 120_000);
  afterAll(async () => {
    await Promise.all([owner.$disconnect(), web.$disconnect(), worker.$disconnect()]);
    delete process.env.SITE_URL;
    if (previousFlag === undefined) delete process.env[SEO_FLAG]; else process.env[SEO_FLAG] = previousFlag;
  });

  it("1) 分类的书全部不进列表（seo_only）→ 站点地图不列这个分类，而页面确实是 404", async () => {
    // 夹具自检：adventure 在库里有书（不是"空分类"），公开书目 > 页面列表，但一本都不在页面列表里。
    const [{ visible }] = await owner.$queryRaw<Array<{ visible: bigint }>>`
      SELECT count(*) AS visible FROM article
      WHERE locale = 'en' AND article_type = 'novel_article' AND status = 'published' AND deleted_at IS NULL`;
    expect(Number(visible)).toBe(EN_COUNT - 2); // 噪声：序号 1 是草稿、序号 2 已软删；其余是 published
    const [{ members }] = await owner.$queryRaw<Array<{ members: bigint }>>`
      SELECT count(*) AS members FROM novel_canonical_tag nct JOIN canonical_tag ct ON ct.id = nct.canonical_tag_id
      WHERE ct.slug = 'adventure'`;
    expect(Number(members)).toBe(44);
    const listed = await oracleListedArticles(owner, "en", { seoVisibility: true });
    expect(listed.length).toBeLessThan(Number(visible));
    expect(await getPublicCategoryPage(web, "en", "adventure", 1)).toBeNull();
    expect(await getPublicCategoryPage(web, "en", "fantasy", 1)).not.toBeNull();

    const urls = categoryUrls(await build("mainpage", "en"));
    expect(listedSlugs(urls)).not.toContain("adventure");
    expect(urls.some((url) => url.entry.loc.includes("adventure"))).toBe(false);
  }, 120_000);

  it("2) 分类有书进列表 → 照常列出；?page=N 到页面的总页数（无截断）；保留分类的 lastmod 仍按全量候选（含不进列表的书）算", async () => {
    const urls = categoryUrls(await build("mainpage", "en"));
    // 顺序 = 分类排序权重（sortOrder）：fantasy(2) romance(3) mystery(4) staff-pick(5)；adventure(1) 被剔除。
    expect(listedSlugs(urls)).toEqual(["fantasy", "romance", "mystery", "staff-pick"]);

    // fantasy：进列表 45 本 = 3 页。
    expect(urls.filter((url) => url.slug === "fantasy").map((url) => url.entry.loc)).toEqual([
      `${SITE}/category/fantasy`, `${SITE}/category/fantasy?page=2`, `${SITE}/category/fantasy?page=3`,
    ]);
    expect(urls.filter((url) => url.slug === "romance").map((url) => url.entry.loc)).toEqual([`${SITE}/category/romance`]);

    // 与独立预期逐条一致：每个分类的页数 = ceil(页面列表里的本数 / 20)，priority / changefreq 沿用旧形状。
    const expectedCounts = await expectedListedCounts("en", "cap", EN_CATEGORIES);
    expect([...expectedCounts.keys()]).toEqual(["fantasy", "romance", "mystery", "staff-pick"]);
    const newest = await oracleCategoryNewestArticleUpdate(owner, "en");
    for (const [slug, count] of expectedCounts) {
      const pages = Math.max(1, Math.ceil(count / BROWSE_PAGE_SIZE));
      const own = urls.filter((url) => url.slug === slug);
      expect(own.map((url) => url.page), slug).toEqual(Array.from({ length: pages }, (_, index) => index + 1));
      for (const url of own) {
        expect(url.entry.changefreq).toBe("weekly");
        expect(url.entry.priority).toBe(url.page === 1 ? 0.7 : 0.5);
        expect(url.entry.lastmod, slug).toBe(newest.get(slug)!.toISOString());
      }
    }
    // romance 的 lastmod 来自那本不进列表的书：lastmod 取法（全量候选的最大 updatedAt）没有被改成只看进列表的。
    expect(newest.get("romance")!.toISOString()).toBe(ROMANCE_UNLISTED_UPDATED_AT.toISOString());
    expect(urls.find((url) => url.slug === "romance")!.entry.lastmod).toBe(ROMANCE_UNLISTED_UPDATED_AT.toISOString());
  }, 120_000);

  it("3) 其它网址与改前一致：首页、小说页、章节页、博客页、小语种的分类页", async () => {
    // 首页：mainpage 第一条，lastmod = max(站点设置 updatedAt, 全部候选文章 updatedAt)。
    const mainEn = await build("mainpage", "en");
    const visible = await oracleVisibleArticles(owner, "en");
    const setting = await owner.siteSetting.findUniqueOrThrow({ where: { id: 1 } });
    const latest = visible.reduce((max, row) => Math.max(max, row.updated_at.valueOf()), setting.updatedAt.valueOf());
    expect(mainEn[0]).toEqual({
      loc: SITE, lastmod: new Date(latest).toISOString(), changefreq: "daily", priority: 1,
    });

    // 小说页 + 章节页：每篇文章后面紧跟它的可读章节，条目与顺序与独立 SQL 预期逐条一致（seo_only 仍收）。
    const expectedNovel: SitemapEntry[] = [];
    for (const row of visible) {
      const ordinal = ordinalOf("cap", row.slug);
      const loc = `${SITE}/novel/${row.slug}-p${row.short_id}`;
      expectedNovel.push({
        loc, lastmod: row.updated_at.toISOString(), changefreq: "weekly", priority: 0.9,
        imageUrl: `/covers/${ordinal}.webp`, imageTitle: `Scale article ${ordinal}`,
      });
      for (let chapter = 1; chapter <= CHAPTERS_PER_NOVEL; chapter += 1) {
        expectedNovel.push({
          loc: `${loc}/chapter/${chapter}`,
          lastmod: new Date(chapterBaseUpdatedAt.valueOf() + ordinal * 1000).toISOString(),
          changefreq: "monthly", priority: 0.6,
        });
      }
    }
    expect(visible.length).toBeGreaterThan(UNLISTED_UP_TO);
    expect(visible.some((row) => ordinalOf("cap", row.slug) <= UNLISTED_UP_TO)).toBe(true); // seo_only 的书仍在小说页里
    expect(await build("novelpage", "en")).toEqual(expectedNovel);

    // 博客页。
    const blogRows = await oracleVisibleBlogArticles(owner, "en");
    expect(blogRows.length).toBeGreaterThan(0);
    expect((await build("blogpage", "en")).map((entry) => [entry.loc, entry.lastmod])).toEqual(
      blogRows.map((row) => [`${SITE}/blog/${row.slug}`, row.updated_at.toISOString()]),
    );

    // ko 只有 30 本、全部进列表：每个分类都照列、页数按全量算（xuanhuan 25 本 = 2 页，yanqing 5 本 = 1 页）。
    const mainKo = await build("mainpage", "ko");
    const koVisible = await oracleVisibleArticles(owner, "ko");
    const koNewest = await oracleCategoryNewestArticleUpdate(owner, "ko");
    expect(koVisible).toHaveLength(KO_COUNT);
    expect(mainKo.map((entry) => entry.loc)).toEqual([
      `${SITE}/ko`,
      `${SITE}/ko/category/xuanhuan`, `${SITE}/ko/category/xuanhuan?page=2`,
      `${SITE}/ko/category/yanqing`,
    ]);
    expect(mainKo[1]!.lastmod).toBe(koNewest.get("xuanhuan")!.toISOString());
    expect(mainKo[3]!.lastmod).toBe(koNewest.get("yanqing")!.toISOString());
  }, 120_000);

  it("4) 对照断言：站点地图列出的每个分类网址 getPublicCategoryPage 都不为 null；页面是 200 的分类也都在站点地图里", async () => {
    const allSlugs = (await owner.canonicalTag.findMany({ select: { slug: true } })).map((tag) => tag.slug);
    expect(allSlugs.length).toBe(EN_CATEGORIES.length + KO_CATEGORIES.length);

    for (const locale of ["en", "ko"] as const) {
      const urls = categoryUrls(await build("mainpage", locale));
      expect(urls.length).toBeGreaterThan(0);
      // 单向：列出的每一个网址（含 ?page=N）页面都是 200。
      for (const url of urls) {
        expect(await getPublicCategoryPage(web, locale, url.slug, url.page), `${locale} ${url.entry.loc}`).not.toBeNull();
      }
      // 边界：列到的最后一页之后的那一页，页面是 404（站点地图不会多列）。
      for (const slug of listedSlugs(urls)) {
        const last = Math.max(...urls.filter((url) => url.slug === slug).map((url) => url.page));
        expect(await getPublicCategoryPage(web, locale, slug, last + 1), `${locale} ${slug} page ${last + 1}`).toBeNull();
      }
      // 反向：库里每个分类，页面第 1 页是 200 当且仅当站点地图列了它。
      const listed = new Set(listedSlugs(urls));
      for (const slug of allSlugs) {
        const pageOk = (await getPublicCategoryPage(web, locale, slug, 1)) !== null;
        expect(listed.has(slug), `${locale} ${slug}: page 200=${pageOk}`).toBe(pageOk);
      }
    }
  }, 180_000);

  it("5) SEO 可见性开关：关闭时不区分 seo_only（所有书进列表，adventure 出现）；打开时 cap-299/300 变成 seo_only → staff-pick 消失，页面也 404；小说页照旧收", async () => {
    // 关闭：process.env 与传给站点地图的 env 一致（页面读 process.env）。
    process.env[SEO_FLAG] = "false";
    clearPublicCategoryCountsCacheForTest();
    const offUrls = categoryUrls(await build("mainpage", "en", envWith(false)));
    expect(listedSlugs(offUrls)).toEqual(["adventure", "fantasy", "romance", "mystery", "staff-pick"]);
    const offCounts = await expectedListedCounts("en", "cap", EN_CATEGORIES, false);
    expect(offCounts.get("adventure")).toBe(44);
    for (const url of offUrls) expect(await getPublicCategoryPage(web, "en", url.slug, url.page), url.entry.loc).not.toBeNull();
    for (const [slug, count] of offCounts) {
      expect(offUrls.filter((url) => url.slug === slug)).toHaveLength(Math.max(1, Math.ceil(count / BROWSE_PAGE_SIZE)));
    }

    // 打开 + cap-299/300 也是 seo_only。
    process.env[SEO_FLAG] = "true";
    clearPublicCategoryCountsCacheForTest();
    await owner.$executeRaw`UPDATE article SET seo_visibility = 'seo_only' WHERE slug IN ('cap-299', 'cap-300')`;
    const env = envWith(true);
    expect(await getPublicCategoryPage(web, "en", "staff-pick", 1)).toBeNull();
    const urls = categoryUrls(await build("mainpage", "en", env));
    expect(listedSlugs(urls)).toEqual(["fantasy", "romance", "mystery"]);
    for (const url of urls) {
      expect(await getPublicCategoryPage(web, "en", url.slug, url.page), url.entry.loc).not.toBeNull();
    }
    // 其它网址不受影响：seo_only 的两本仍在小说页站点地图里（可收录、只是不进列表）。
    const novelLocs = (await build("novelpage", "en", env)).map((entry) => entry.loc);
    expect(novelLocs.some((loc) => loc.includes("/novel/cap-299-p"))).toBe(true);
    expect(novelLocs.some((loc) => loc.includes("/novel/cap-300-p"))).toBe(true);
  }, 120_000);

  it("6) 性能：每个语种只读一次每语种每分类本数矩阵，与分类个数无关；其它家族不碰矩阵", async () => {
    let matrixQueries = 0;
    const counted = new Proxy(worker, {
      get(target, key) {
        if (key === "$queryRaw") {
          return (...args: unknown[]) => {
            if (classifyPublicListQuery(args[0] as { text: string }) === "matrix") matrixQueries += 1;
            return (target.$queryRaw as (...a: unknown[]) => unknown)(...args);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as PrismaClient;

    // en 有 5 个分类、ko 有 2 个分类：各自仍然只读一次矩阵。
    expect(categoryUrls(await build("mainpage", "en", envWith(true), counted)).length).toBeGreaterThan(0);
    expect(matrixQueries).toBe(1);
    expect(categoryUrls(await build("mainpage", "ko", envWith(true), counted)).length).toBeGreaterThan(0);
    expect(matrixQueries).toBe(2);
    // 非 mainpage 家族不触碰矩阵。
    await build("novelpage", "en", envWith(true), counted);
    await build("blogpage", "en", envWith(true), counted);
    expect(matrixQueries).toBe(2);
  }, 120_000);

  /** 页面（web_app 角色）的分类视图：库里每个分类 → 第 1 页是否 200。 */
  async function pageStatusBySlug(locale: SiteLocale) {
    const slugs = (await owner.canonicalTag.findMany({ select: { slug: true } })).map((tag) => tag.slug);
    const status = new Map<string, boolean>();
    for (const slug of slugs) status.set(slug, (await getPublicCategoryPage(web, locale, slug, 1)) !== null);
    return status;
  }

  async function articleOf(slug: string) {
    return owner.article.findFirstOrThrow({ where: { slug }, select: { id: true, novelId: true } });
  }

  /** 断言：有 href 的标签 ⟺ 页面 200（slug 在 `counts` 里）；有 href 的 href 就是 `/category/{slug}`。 */
  async function expectLinksMatchPages(
    tags: ReadonlyArray<{ slug: string; href?: string }>,
    counts: ReadonlyMap<string, number>,
    status: ReadonlyMap<string, boolean>,
    where: string,
    prefix = "",
  ) {
    for (const tag of tags) {
      expect(tag.href !== undefined, `${where}: ${tag.slug}（页面 200=${status.get(tag.slug)}）`).toBe(counts.has(tag.slug));
      expect(status.get(tag.slug), `${where}: ${tag.slug}`).toBe(counts.has(tag.slug));
      if (tag.href !== undefined) expect(tag.href).toBe(`${prefix}/category/${tag.slug}`);
    }
  }

  it("7) 详情页的可链接分类集合 === listPublicCategoryPageCounts 的键；集合里每个分类页面都 200、集合之外都 404；不进列表的书只有 200 的分类带 href", async () => {
    for (const locale of ["en", "ko"] as const) {
      const counts = await listPublicCategoryPageCounts(web, locale);
      // 详情页用的集合：页脚那份（loadPublicCategories = listPublicCategories，同一请求内已取过）。
      const footer = (await loadPublicCategories(locale)).map((tag) => tag.slug);
      expect([...new Set(footer)].sort(), `${locale} 页脚集合`).toEqual([...counts.keys()].sort());
      expect((await listPublicCategories(web, locale)).map((tag) => tag.slug).sort()).toEqual([...counts.keys()].sort());
      const status = await pageStatusBySlug(locale);
      for (const [slug, ok] of status) expect(counts.has(slug), `${locale} ${slug}`).toBe(ok);
      for (const slug of counts.keys()) expect(await getPublicCategoryPage(web, locale, slug, 1), `${locale} ${slug}`).not.toBeNull();
    }
    // 非空洞：en 里 adventure 被排除（库里有它的 44 本书，但页面 404）。
    const enCounts = await listPublicCategoryPageCounts(web, "en");
    expect([...enCounts.keys()].sort()).toEqual(["fantasy", "mystery", "romance", "staff-pick"]);

    // cap-30（序号 30，seo_only，不进列表）同时挂 adventure（页面 404）、fantasy、romance（页面 200）。
    const status = await pageStatusBySlug("en");
    const outside = await articleOf("cap-30");
    const detail = (await loadNovelDetail(outside.id))!;
    expect(detail.tags.map((tag) => tag.slug)).toEqual(["adventure", "fantasy", "romance"]);
    expect(detail.tags.map((tag) => tag.href)).toEqual([undefined, "/category/fantasy", "/category/romance"]);
    await expectLinksMatchPages(detail.tags, enCounts, status, "cap-30");

    // cap-250（进列表）的 mystery 照常是链接。
    const inside = (await loadNovelDetail((await articleOf("cap-250")).id))!;
    expect(inside.tags.map((tag) => [tag.slug, tag.href])).toEqual([["mystery", "/category/mystery"]]);
  }, 180_000);

  it("8) 推荐卡片同理：候选池只含进列表的书，所以每张卡片的每个标签页面都是 200、都带 href", async () => {
    const counts = await listPublicCategoryPageCounts(web, "en");
    const status = await pageStatusBySlug("en");
    const current = await articleOf("cap-45");

    // 随机采样固定取候选池最前面的（`sampleEntries` 的 Math.random() = 0，只在这一次调用期间生效）。
    clearRelatedNovelsPoolCacheForTest();
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    let recommendations;
    try {
      recommendations = await loadRelatedAndNewReleases("en", current.id, current.novelId!);
    } finally {
      random.mockRestore();
      clearRelatedNovelsPoolCacheForTest();
    }

    const { related, newReleases } = recommendations;
    const tags = [...related, ...newReleases].flatMap((card) => card.tags);
    expect(related.length).toBeGreaterThan(0);
    expect(newReleases.length).toBeGreaterThan(0);
    expect(tags.length).toBeGreaterThan(0);
    expect(tags.every((tag) => tag.href !== undefined)).toBe(true);
    await expectLinksMatchPages(tags, counts, status, "推荐卡片");
  }, 180_000);

  it("9) seo_only：书在列表之外（详情页仍可达）→ 它独占的分类页面 404，详情视图里该标签没有 href；集合等价仍成立", async () => {
    await owner.$executeRaw`UPDATE article SET seo_visibility = 'seo_only' WHERE slug IN ('cap-299', 'cap-300')`;
    clearPublicCategoryCountsCacheForTest();
    const counts = await listPublicCategoryPageCounts(web, "en");
    expect([...counts.keys()].sort()).toEqual(["fantasy", "mystery", "romance"]);
    expect((await loadPublicCategories("en")).map((tag) => tag.slug).sort()).toEqual([...counts.keys()].sort());

    // seo_only 书的详情页仍可达（可收录、只是不进列表）；它独占的 staff-pick 页面 404 → 不能是链接。
    expect(await getPublicCategoryPage(web, "en", "staff-pick", 1)).toBeNull();
    const detail = (await loadNovelDetail((await articleOf("cap-299")).id))!;
    expect(detail.tags.map((tag) => [tag.slug, tag.href])).toEqual([["staff-pick", undefined]]);

    // 同一个语种里进列表的普通书不受影响：cap-250 的 mystery 仍是链接。
    const normal = (await loadNovelDetail((await articleOf("cap-250")).id))!;
    expect(normal.tags.map((tag) => tag.href)).toEqual(["/category/mystery"]);
  }, 180_000);

  /**
   * 语种错配夹具：在默认夹具之上再加 es 300 本（序号 1..60 同样是 seo_only，不进列表）。分类是全局的、归属是按书的：
   *   - adventure：en 里没有进列表的书（en 的书序号 7..50，页面 404）；es 里有（250..252 与最新的 290..300）→ es 页面 200；另挂 es 序号 30。
   *   - mystery：en 里有进列表的书（250..252，页面 200）；es 的书只有序号 30、31（不进列表）→ es 页面 404。
   * 判定集合若误用别的语种（例如固定取 en），es 详情页上 adventure 会被去掉链接、mystery 会留下 `/es/category/mystery` 死链。
   */
  async function seedSpanishMismatch() {
    const channel = await createChannelFixture(owner);
    await seedBulkPublicArticles(owner, { prefix: "es", locale: "es", count: 300, channel, baseUpdatedAt });
    await seedExistingCategoryRanges(owner, { prefix: "es", count: 300, categories: [
      { slug: "adventure", ordinals: [[30, 30], [250, 252], [290, 300]] },
      { slug: "mystery", ordinals: [[30, 31]] },
    ] });
    await owner.$executeRaw`
      UPDATE article SET seo_visibility = 'seo_only'
      WHERE slug LIKE 'es-%' AND split_part(slug, '-', 2)::int <= ${UNLISTED_UP_TO}`;
    await reconcileAllEffectiveTags(worker);
    clearPublicCategoryCountsCacheForTest();
  }

  it("10) 语种错配（详情页）：判定集合按书自己的语种取——en 里有书而 es 里没有的分类无 href，只在 es 里有书的分类有 href", async () => {
    await seedSpanishMismatch();
    const enCounts = await listPublicCategoryPageCounts(web, "en");
    const esCounts = await listPublicCategoryPageCounts(web, "es");
    // 夹具自检：同一个分类在两个语种里页面状态相反。
    expect(enCounts.has("mystery")).toBe(true);
    expect(enCounts.has("adventure")).toBe(false);
    expect([...esCounts.keys()]).toEqual(["adventure"]);
    expect(await getPublicCategoryPage(web, "es", "adventure", 1)).not.toBeNull();
    expect(await getPublicCategoryPage(web, "es", "mystery", 1)).toBeNull();
    expect(await getPublicCategoryPage(web, "en", "mystery", 1)).not.toBeNull();
    expect(await getPublicCategoryPage(web, "en", "adventure", 1)).toBeNull();
    // es 的页脚集合 === es 页面返回 200 的集合（不是 en 的）。
    expect((await loadPublicCategories("es")).map((tag) => tag.slug)).toEqual([...esCounts.keys()]);

    // es 序号 30（不进列表）同时挂 adventure（es 页面 200）与 mystery（es 页面 404）。
    const detail = (await loadNovelDetail((await articleOf("es-30")).id))!;
    expect(detail.locale.code).toBe("es");
    expect(detail.tags.map((tag) => tag.slug)).toEqual(["adventure", "mystery"]);
    expect(detail.tags.map((tag) => tag.href)).toEqual(["/es/category/adventure", undefined]);
    await expectLinksMatchPages(detail.tags, esCounts, await pageStatusBySlug("es"), "es-30", "/es");

    // es 序号 250（进列表）：adventure 在 es 里有书 → 仍是链接，尽管 en 里没有它。
    const inside = (await loadNovelDetail((await articleOf("es-250")).id))!;
    expect(inside.tags.map((tag) => [tag.slug, tag.href])).toEqual([["adventure", "/es/category/adventure"]]);

    // en 一侧不受影响：cap-250 的 mystery 照常是链接。
    const enDetail = (await loadNovelDetail((await articleOf("cap-250")).id))!;
    expect(enDetail.tags.map((tag) => tag.href)).toEqual(["/category/mystery"]);
  }, 180_000);

  it("11) 语种错配（推荐卡片）：es 的推荐卡片按 es 的矩阵判定（相关推荐、新书推荐两处都走），标签 href 带 /es 前缀、页面都是 200", async () => {
    await seedSpanishMismatch();
    const esCounts = await listPublicCategoryPageCounts(web, "es");
    const status = await pageStatusBySlug("es");
    const current = await articleOf("es-31");

    // Math.random() = 0（只在这一次调用期间生效）：当前书 = es 序号 31（不进列表，只有 mystery）。
    //   候选池（es 进列表的书）里没有别的 mystery，相关推荐用最新的几本补齐（序号 300..295，标签 adventure）；
    //   新书推荐 = 其后最新的几本（序号 294..289，其中 290..294 带 adventure）。
    clearRelatedNovelsPoolCacheForTest();
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    let recommendations;
    try {
      recommendations = await loadRelatedAndNewReleases("es", current.id, current.novelId!);
    } finally {
      random.mockRestore();
      clearRelatedNovelsPoolCacheForTest();
    }

    const { related, newReleases } = recommendations;
    const tagsOf = (cards: typeof related) => cards.flatMap((card) => card.tags);
    // 两个推荐区各自都带 adventure（es 页面 200）：若判定误用 en 的矩阵（en 里 adventure 没有书），两处都会被去掉链接。
    for (const [name, cards] of [["相关推荐", related], ["新书推荐", newReleases]] as const) {
      const adventure = tagsOf(cards).filter((tag) => tag.slug === "adventure");
      expect(adventure.length, name).toBeGreaterThan(0);
      expect(adventure.map((tag) => tag.href), name).toEqual(adventure.map(() => "/es/category/adventure"));
    }
    await expectLinksMatchPages([...tagsOf(related), ...tagsOf(newReleases)], esCounts, status, "es 推荐卡片", "/es");
  }, 180_000);
});
