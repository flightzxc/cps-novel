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
 * B-38 第二部分（同一批夹具，站内分类链接）：详情页标签 / 推荐卡片的 `href` 只给页面返回 200 的分类。
 *   7. 详情页数据层（真实 `public-load`，走 web_app 角色）给出的"可链接分类集合"（页脚用的 `listPublicCategories`）
 *      与 `listPublicCategoryPageCounts` 的键集合**完全一致**，集合里每个分类 `getPublicCategoryPage` 都不为 null，
 *      集合之外的分类页面都是 null；窗口之外的书（cap-30）的详情视图里，窗口里没有书的 adventure 没有 href，其余照常有；
 *   8. 推荐卡片（候选池 500 本 > 窗口 240 本）同理：每张卡片的每个标签，有 href ⟺ 页面 200；
 *   9. `seo_only`：书只是 seo_only（详情页可达、列表不收），它独占的分类页面 404，详情视图里该标签没有 href；开关打开下集合等价仍成立。
 *
 * 开关与角色约定同 `sitemap-refresh-postgres.test.ts`（同一个运行器喂同一组环境变量）。
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { createSitemapFamilyBuilder, type SitemapEntry, type SitemapType } from "@/lib/seo/sitemap";
import { getPublicCategoryPage, listPublicCategoryPageCounts } from "@/lib/site/category-queries";
import { BROWSE_PAGE_SIZE, listPublicArticles, listPublicCategories, PUBLIC_LIST_CAP } from "@/lib/site/queries";
import { clearRelatedNovelsPoolCacheForTest } from "@/lib/site/related-novels";

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

// 详情页数据层（`@/app/_lib/public-load`）走 `@/app/_lib/public-deps` 的 `prisma`；这里把它指到 web_app 角色的连接
// （与 `tests/integration/tagging/public-auto-postgres.test.ts` 同款做法），测的就是生产里详情页用的那套 loader。
const shared = vi.hoisted(() => ({ web: null as PrismaClient | null }));
vi.mock("@/app/_lib/public-deps", () => ({ prisma: new Proxy({}, { get: (_target, key) => Reflect.get(shared.web!, key) }) }));
import { loadNovelDetail, loadPublicCategories, loadRelatedAndNewReleases } from "@/app/_lib/public-load";

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
  beforeAll(() => { process.env.SITE_URL = SITE; shared.web = web; });
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
  ) {
    for (const tag of tags) {
      expect(tag.href !== undefined, `${where}: ${tag.slug}（页面 200=${status.get(tag.slug)}）`).toBe(counts.has(tag.slug));
      expect(status.get(tag.slug), `${where}: ${tag.slug}`).toBe(counts.has(tag.slug));
      if (tag.href !== undefined) expect(tag.href).toBe(`/category/${tag.slug}`);
    }
  }

  it("7) 详情页的可链接分类集合 === listPublicCategoryPageCounts 的键；集合里每个分类页面都 200、集合之外都 404；窗口之外的书只有 200 的分类带 href", async () => {
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

    // cap-30（序号 30，在窗口 61..300 之外）同时挂 adventure（页面 404）、fantasy、romance（页面 200）。
    const status = await pageStatusBySlug("en");
    const outside = await articleOf("cap-30");
    const detail = (await loadNovelDetail(outside.id))!;
    expect(detail.tags.map((tag) => tag.slug)).toEqual(["adventure", "fantasy", "romance"]);
    expect(detail.tags.map((tag) => tag.href)).toEqual([undefined, "/category/fantasy", "/category/romance"]);
    await expectLinksMatchPages(detail.tags, enCounts, status, "cap-30");

    // cap-250（窗口之内）的 mystery 照常是链接。
    const inside = (await loadNovelDetail((await articleOf("cap-250")).id))!;
    expect(inside.tags.map((tag) => [tag.slug, tag.href])).toEqual([["mystery", "/category/mystery"]]);
  }, 180_000);

  it("8) 推荐卡片同理：候选池（500 本）里窗口之外的卡片，每个标签有 href ⟺ 页面 200", async () => {
    const counts = await listPublicCategoryPageCounts(web, "en");
    const status = await pageStatusBySlug("en");
    const current = await articleOf("cap-45");

    // 随机采样固定取候选池最前面的（`sampleEntries` 的 Math.random() = 0，只在这一次调用期间生效）：
    // cap-45 只有 adventure，"相关推荐"取共享 adventure 的最新几本（序号 50..44，adventure 页面 404），
    // "新书推荐"取最新几本（序号 300..295，其中 299、300 有页面 200 的 staff-pick）。
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
    expect(tags.some((tag) => tag.href === undefined)).toBe(true);
    expect(tags.some((tag) => tag.href !== undefined)).toBe(true);
    await expectLinksMatchPages(tags, counts, status, "推荐卡片");
  }, 180_000);

  it("9) seo_only：书在窗口之内但只是 seo_only → 它独占的分类页面 404，详情视图里该标签没有 href；开关打开时集合等价仍成立", async () => {
    const flag = "FEATURE_ARTICLE_SEO_VISIBILITY";
    const previous = process.env[flag];
    process.env[flag] = "true";
    try {
      await owner.$executeRaw`UPDATE article SET seo_visibility = 'seo_only' WHERE slug IN ('cap-299', 'cap-300')`;
      const counts = await listPublicCategoryPageCounts(web, "en");
      expect([...counts.keys()].sort()).toEqual(["fantasy", "mystery", "romance"]);
      expect((await loadPublicCategories("en")).map((tag) => tag.slug).sort()).toEqual([...counts.keys()].sort());

      // seo_only 书的详情页仍可达（可收录、只是不进列表）；它独占的 staff-pick 页面 404 → 不能是链接。
      expect(await getPublicCategoryPage(web, "en", "staff-pick", 1)).toBeNull();
      const detail = (await loadNovelDetail((await articleOf("cap-299")).id))!;
      expect(detail.tags.map((tag) => [tag.slug, tag.href])).toEqual([["staff-pick", undefined]]);

      // 同一个窗口里的普通书不受影响：cap-250 的 mystery 仍是链接。
      const normal = (await loadNovelDetail((await articleOf("cap-250")).id))!;
      expect(normal.tags.map((tag) => tag.href)).toEqual(["/category/mystery"]);
    } finally {
      if (previous === undefined) delete process.env[flag]; else process.env[flag] = previous;
    }
  }, 180_000);
});
