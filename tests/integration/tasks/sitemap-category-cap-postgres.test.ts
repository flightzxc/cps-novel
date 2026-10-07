/**
 * B-38（2026-10-07 切换验收）：站点地图列了 `/category/adventure`，访问却是 404。
 *
 * 根因：站点地图按该语种**全部**公开书目判定"这个分类下有没有书"，而分类页（`getPublicCategoryPage`）只在
 * `listPublicArticles` 的最新 `PUBLIC_LIST_CAP`（240）本里过滤、结果为 0 就 `notFound()`。en 有一万多本时，冷门分类
 * 在最新 240 本里一本都没有——站点地图列了，页面是 404。`?page=N` 同源：站点地图按全量算页数，页面按截断后的总页数判 404。
 * 另一处同类分歧：站点地图候选保留 `seo_only`（可收录），页面列表不收，只有 `seo_only` 书的分类同样是"列了、404"。
 *
 * 修法：站点地图改用页面自己的谓词（`listPublicCategoryPageCounts`：每个语种一次 `listPublicArticles`，
 * 内存里按页面的 `cardsInCategory` / `paginateCards` 求出"有书的分类 → 总页数"）。
 *
 * 这里用真实 PostgreSQL 16.14、真实表约束、真实角色（站点地图走 worker_app，页面走 web_app）：
 *   1. 分类的书全在最新 240 本之外 → 站点地图不列，页面确实是 404；
 *   2. 分类的书在最新 240 本之内 → 照常列出（`?page=N` 只到页面的总页数；保留分类的 lastmod 仍按全量算）；
 *   3. 其它网址（首页、小说页、章节页、博客页、小语种的分类页）与独立 SQL 预期逐条一致，即与改前一致；
 *   4. 对照断言：站点地图列出的每个分类网址 `getPublicCategoryPage` 都不为 null，且页面是 200 的分类都在站点地图里（双向）；
 *   5. `seo_only`：书在最新 240 本之内、但只是 seo_only（站点地图收、列表不收）→ 不列这个分类；
 *   6. 性能：每个语种只调用一次页面的列表查询（`take = PUBLIC_LIST_CAP`），与分类个数无关。
 *
 * 开关与角色约定同 `sitemap-refresh-postgres.test.ts`（同一个运行器喂同一组环境变量）。
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { createSitemapFamilyBuilder, type SitemapEntry, type SitemapType } from "@/lib/seo/sitemap";
import { getPublicCategoryPage } from "@/lib/site/category-queries";
import { BROWSE_PAGE_SIZE, listPublicArticles, PUBLIC_LIST_CAP } from "@/lib/site/queries";

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
  seedManualCategoryRanges,
  type ChannelFixture,
  type ManualCategoryRange,
} from "./fixtures/bulk-public-articles";

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
/** 一本落在最新 240 之外的 romance 书，updatedAt 被刻意改得比一切都晚：保留分类的 lastmod 仍按全量算。 */
const ROMANCE_OUT_OF_CAP_ORDINAL = 30;
const ROMANCE_OUT_OF_CAP_UPDATED_AT = new Date("2026-06-01T00:00:00.000Z");
const blogEnv: NodeJS.ProcessEnv = { ...process.env, FEATURE_ARTICLE_BLOG: "true" };

/**
 * en 共 300 本，序号 g 的发布时间 = 基准 + g 秒，所以最新 240 本 = 序号 61..300（seo_only 用例里窗口会移到 59..298）。
 * 所有"窗口之外"的序号取 ≤ 50，所有"窗口之内"的序号取 ≥ 70：两种窗口下归属都一致。
 */
const EN_CATEGORIES: readonly ManualCategoryRange[] = [
  // 书全在窗口之外：站点地图旧行为会列，页面 404（本单要修的现象）。
  { slug: "adventure", displayName: "Adventure", ordinals: [[7, 50]] },
  // 窗口之内 45 本（3 页）+ 窗口之外 31 本：旧行为按 76 本算 4 页，页面只有 3 页。
  { slug: "fantasy", displayName: "Fantasy", ordinals: [[70, 114], [10, 40]] },
  // 窗口之内 1 本 + 窗口之外 1 本（后者 updatedAt 被刻意改晚）。
  { slug: "romance", displayName: "Romance", ordinals: [[ROMANCE_OUT_OF_CAP_ORDINAL, ROMANCE_OUT_OF_CAP_ORDINAL], [200, 200]] },
  { slug: "mystery", displayName: "Mystery", ordinals: [[250, 252]] },
  // 最新的两本；seo_only 用例里把它们改成 seo_only。
  { slug: "staff-pick", displayName: "Staff pick", ordinals: [[299, 300]] },
];
/** ko 共 30 本，远小于 240：所有分类都在窗口之内，行为与改前逐字相同。 */
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
    UPDATE article SET updated_at = ${ROMANCE_OUT_OF_CAP_UPDATED_AT}::timestamptz
    WHERE id = md5(${`cap-a-${ROMANCE_OUT_OF_CAP_ORDINAL}`})::uuid`;

  await seedBulkPublicArticles(owner, { prefix: "ko", locale: "ko", count: KO_COUNT, channel, baseUpdatedAt });
  await seedManualCategoryRanges(owner, { prefix: "ko", count: KO_COUNT, categories: KO_CATEGORIES, tagUpdatedAt });

  await seedBulkBlogArticles(owner, { prefix: "capblog", locale: "en", count: BLOG_COUNT, baseUpdatedAt });
}

async function build(type: SitemapType, locale: SiteLocale, env: NodeJS.ProcessEnv = blogEnv, db: PrismaClient = worker) {
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

/** 独立预期：每个分类在"页面列表"里有几本（列表 = 最新 240 本公开书，见 `oracleListedArticles`）。 */
async function expectedListedCounts(locale: string, prefix: string, categories: readonly ManualCategoryRange[]) {
  const listed = await oracleListedArticles(owner, locale, PUBLIC_LIST_CAP);
  const counts = new Map<string, number>();
  for (const category of categories) {
    const n = listed.filter((row) => inRanges(ordinalOf(prefix, row.slug), category)).length;
    if (n > 0) counts.set(category.slug, n);
  }
  return counts;
}

describe.skipIf(!enabled).sequential("B-38 站点地图分类网址只列页面返回 200 的（disposable PostgreSQL 16.14）", () => {
  beforeAll(() => { process.env.SITE_URL = SITE; });
  beforeEach(async () => {
    await resetDatabase();
    await seedFixture();
  }, 120_000);
  afterAll(async () => {
    await Promise.all([owner.$disconnect(), web.$disconnect(), worker.$disconnect()]);
    delete process.env.SITE_URL;
  });

  it("1) 分类的书全在最新 240 本之外 → 站点地图不列这个分类，而页面确实是 404", async () => {
    // 夹具自检：公开书目 > 240，adventure 在库里有书（不是"空分类"），但一本都不在页面列表里。
    const [{ visible }] = await owner.$queryRaw<Array<{ visible: bigint }>>`
      SELECT count(*) AS visible FROM article WHERE locale = 'en' AND status = 'published' AND deleted_at IS NULL`;
    expect(Number(visible)).toBeGreaterThan(PUBLIC_LIST_CAP);
    const [{ members }] = await owner.$queryRaw<Array<{ members: bigint }>>`
      SELECT count(*) AS members FROM novel_canonical_tag nct JOIN canonical_tag ct ON ct.id = nct.canonical_tag_id
      WHERE ct.slug = 'adventure'`;
    expect(Number(members)).toBe(44);
    const listed = await listPublicArticles(web, "en");
    expect(listed.length).toBeLessThanOrEqual(PUBLIC_LIST_CAP);
    expect(listed.some((card) => card.tags.some((tag) => tag.slug === "adventure"))).toBe(false);
    expect(await getPublicCategoryPage(web, "en", "adventure", 1)).toBeNull();

    const urls = categoryUrls(await build("mainpage", "en"));
    expect(listedSlugs(urls)).not.toContain("adventure");
    expect(urls.some((url) => url.entry.loc.includes("adventure"))).toBe(false);
  }, 120_000);

  it("2) 分类的书在最新 240 本之内 → 照常列出；?page=N 只到页面的总页数；保留分类的 lastmod 仍按全量算", async () => {
    const urls = categoryUrls(await build("mainpage", "en"));
    // 顺序 = 分类排序权重（sortOrder）：fantasy(2) romance(3) mystery(4) staff-pick(5)；adventure(1) 被剔除。
    expect(listedSlugs(urls)).toEqual(["fantasy", "romance", "mystery", "staff-pick"]);

    // fantasy：窗口之内 45 本 = 3 页（旧行为按全量 76 本列 4 页）。
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
    // romance 的 lastmod 来自那本"窗口之外"的书：lastmod 取法（全量归属候选的最大 updatedAt）没有被改成只看窗口之内。
    expect(newest.get("romance")!.toISOString()).toBe(ROMANCE_OUT_OF_CAP_UPDATED_AT.toISOString());
    expect(urls.find((url) => url.slug === "romance")!.entry.lastmod).toBe(ROMANCE_OUT_OF_CAP_UPDATED_AT.toISOString());
  }, 120_000);

  it("3) 其它网址与改前一致：首页、小说页、章节页、博客页、书目不足 240 的语种的分类页", async () => {
    // 首页：mainpage 第一条，lastmod = max(站点设置 updatedAt, 全部候选文章 updatedAt)。
    const mainEn = await build("mainpage", "en");
    const visible = await oracleVisibleArticles(owner, "en");
    const setting = await owner.siteSetting.findUniqueOrThrow({ where: { id: 1 } });
    const latest = visible.reduce((max, row) => Math.max(max, row.updated_at.valueOf()), setting.updatedAt.valueOf());
    expect(mainEn[0]).toEqual({
      loc: SITE, lastmod: new Date(latest).toISOString(), changefreq: "daily", priority: 1,
    });

    // 小说页 + 章节页：每篇文章后面紧跟它的可读章节，条目与顺序与独立 SQL 预期逐条一致。
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
    expect(visible.length).toBeGreaterThan(PUBLIC_LIST_CAP);
    expect(await build("novelpage", "en")).toEqual(expectedNovel);

    // 博客页。
    const blogRows = await oracleVisibleBlogArticles(owner, "en");
    expect(blogRows.length).toBeGreaterThan(0);
    expect((await build("blogpage", "en")).map((entry) => [entry.loc, entry.lastmod])).toEqual(
      blogRows.map((row) => [`${SITE}/blog/${row.slug}`, row.updated_at.toISOString()]),
    );

    // ko 只有 30 本（≤ 240）：窗口 = 全部，每个分类都照旧列、页数按全量算（xuanhuan 25 本 = 2 页，yanqing 5 本 = 1 页）。
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

  it("5) seo_only：书在最新 240 本之内、但只是 seo_only（站点地图收、列表不收）→ 不列这个分类，页面也确实 404；小说页照旧收", async () => {
    const flag = "FEATURE_ARTICLE_SEO_VISIBILITY";
    const previous = process.env[flag];
    process.env[flag] = "true";
    try {
      await owner.$executeRaw`UPDATE article SET seo_visibility = 'seo_only' WHERE slug IN ('cap-299', 'cap-300')`;
      const env: NodeJS.ProcessEnv = { ...process.env, FEATURE_ARTICLE_BLOG: "true", [flag]: "true" };

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
    } finally {
      if (previous === undefined) delete process.env[flag]; else process.env[flag] = previous;
    }
  }, 120_000);

  it("6) 性能：每个语种只调用一次页面的列表查询（take = PUBLIC_LIST_CAP），与分类个数无关", async () => {
    let listQueries = 0;
    const counted = new Proxy(worker, {
      get(target, key) {
        if (key === "article") {
          return {
            findMany: (args: { take?: number }) => {
              if (args.take === PUBLIC_LIST_CAP) listQueries += 1;
              return target.article.findMany(args as never);
            },
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as PrismaClient;

    // en 有 5 个分类、ko 有 2 个分类：各自仍然只发一次列表查询。
    expect(categoryUrls(await build("mainpage", "en", blogEnv, counted)).length).toBeGreaterThan(0);
    expect(listQueries).toBe(1);
    expect(categoryUrls(await build("mainpage", "ko", blogEnv, counted)).length).toBeGreaterThan(0);
    expect(listQueries).toBe(2);
    // 非 mainpage 家族不触碰页面的列表查询。
    await build("novelpage", "en", blogEnv, counted);
    await build("blogpage", "en", blogEnv, counted);
    expect(listQueries).toBe(2);
  }, 120_000);
});
