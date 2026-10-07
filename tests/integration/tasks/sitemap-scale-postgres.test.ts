/**
 * 站点地图规模缺陷（2026-10-06 预生产事故）的真实库验收。
 *
 * 事故：单语种公开文章过万后，`sitemap_refresh` 每次都报 PostgreSQL 54001 `stack depth limit exceeded`。
 * 根因：站点地图对每个语种只做一次 `article.findMany`，且 select 了 `promoLink`——
 * `Article.[promoLinkId, novelId] → PromoLink.[id, novelId]` 是组合外键，Prisma 加载这类关系时生成
 * `(id, novel_id) IN ((…),(…),…)`，元组数一多就把 Postgres 的解析栈撑爆。
 *
 * 这里用真实 PostgreSQL 16.14、真实表约束、真实 worker_app 角色，造出事故同款的规模：
 *   - 场景 A（复现 + 修复）：
 *       · de 14,000 篇——事故同款量级（预生产 en 约 1.3 万篇）：改前以 PostgreSQL 54001 失败；
 *       · en 3 万篇以上公开文章（带组合外键推广链接、每本 3 个可读章节、手工分类归属）：改前先被 Prisma 客户端的
 *         32,767 绑定变量上限拦下（`too many bind variables`，同一根因的另一道墙）；
 *       · 另有 ko / fr 两个语种和一个 en 博客家族；改后全部成功。
 *   - 场景 B（条目正确）：条目与顺序与一套**独立的 SQL 预期**逐条一致，分片条目数 = SITEMAP_SHARD_SIZE，lastmod 正确。
 *   - 场景 C（小规模不变）：小数据集下，任意分块大小（含 1、恰好等于总数、比总数大）生成的 XML 与「一次全取」逐字节一致。
 *   - 场景 E（耗时与内存）：A 的生成过程打印耗时和 Node 进程 RSS / heapUsed 峰值（采样法见 `startMemorySampler`）。
 *
 * 开关与角色约定同 `sitemap-refresh-postgres.test.ts`（同一个运行器喂同一组环境变量）。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createSitemapFamilyBuilder,
  renderSitemapIndexXml,
  renderUrlSetXml,
  SITEMAP_ARTICLE_LOAD_CHUNK_SIZE,
  SITEMAP_SHARD_SIZE,
  type SitemapEntry,
  type SitemapFile,
  type SitemapType,
} from "@/lib/seo/sitemap";
import { generateStaticSitemaps } from "@/lib/seo/static-sitemap-generator";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { PUBLIC_LIST_CAP } from "@/lib/site/queries";
import {
  applyBulkNoise,
  createChannelFixture,
  oracleListedArticles,
  oracleVisibleArticles,
  oracleVisibleBlogArticles,
  seedBulkBlogArticles,
  seedBulkManualCategories,
  seedBulkPreviewChapters,
  seedBulkPublicArticles,
  type ChannelFixture,
  type VisibleArticleRow,
} from "./fixtures/bulk-public-articles";

const enabled = process.env.SITEMAP_REFRESH_DATABASE_TEST === "1";
const owner = new PrismaClient({ datasourceUrl: process.env.SITEMAP_REFRESH_OWNER_DATABASE_URL });
const worker = new PrismaClient({ datasourceUrl: process.env.SITEMAP_REFRESH_WORKER_DATABASE_URL });

const SITE = "https://sitemap-scale.example";
/** 与生产事故语种一致：en 是默认语种（URL 无语种前缀）。 */
const BIG_LOCALE = "en";
/** 造 30,400 篇；噪声（每 700 篇里 7 篇）排除约 300 篇后，公开可见仍在 3 万篇以上（用例里断言 ≥ 30,000）。 */
const BIG_COUNT = 30_400;
const CHAPTERS_PER_NOVEL = 3;
const BLOG_COUNT = 2_600;
/** 事故同款量级：元组数落在 54001 区间（约 6.8k ～ 16k），比 Prisma 的 32,767 绑定变量墙更早撞上 Postgres 的栈深度。 */
const INCIDENT_LOCALE = "de";
const INCIDENT_COUNT = 14_000;
const baseUpdatedAt = new Date("2026-01-01T00:00:00.000Z");
const chapterBaseUpdatedAt = new Date("2026-03-01T00:00:00.000Z");
const blogEnv: NodeJS.ProcessEnv = { ...process.env, FEATURE_ARTICLE_BLOG: "true" };
const roots: string[] = [];

async function resetDatabase() {
  const [{ name, version }] = await owner.$queryRaw<Array<{ name: string; version: string }>>`
    SELECT current_database() AS name, current_setting('server_version') AS version
  `;
  if (!name.startsWith("cps_novel_sitemap_refresh_") || !version.startsWith("16.14")) {
    throw new Error(`Refusing sitemap scale test setup against ${name} (${version})`);
  }
  const tables = await owner.$queryRawUnsafe<Array<{ tablename: string }>>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `);
  await owner.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map(({ tablename }) => `"${tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await owner.siteSetting.create({ data: { id: 1 } });
}

/**
 * 内存峰值采样法：每 20ms 读一次本进程的 `process.memoryUsage()`（rss = 常驻内存，含 Prisma 查询引擎；
 * heapUsed = V8 堆已用），记下各自最大值。采样只发生在事件循环空闲时（等数据库返回时居多），
 * 所以是「采样下界」而不是精确峰值；同步构造大数组的瞬间可能漏掉。用于量级对比，不用于精确断言。
 * vitest 以 forks 池跑用例，被测代码和采样器在同一个子进程里。
 */
function startMemorySampler() {
  const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);
  const start = process.memoryUsage();
  let peakRss = start.rss;
  let peakHeap = start.heapUsed;
  const sample = () => {
    const usage = process.memoryUsage();
    peakRss = Math.max(peakRss, usage.rss);
    peakHeap = Math.max(peakHeap, usage.heapUsed);
  };
  const timer = setInterval(sample, 20);
  return {
    stop() {
      clearInterval(timer);
      sample();
      return {
        startRssMb: mb(start.rss), peakRssMb: mb(peakRss), deltaRssMb: mb(peakRss - start.rss),
        startHeapMb: mb(start.heapUsed), peakHeapMb: mb(peakHeap), deltaHeapMb: mb(peakHeap - start.heapUsed),
      };
    },
  };
}

function articleUrl(locale: string, slug: string, shortId: string) {
  return `${SITE}${locale === "en" ? "" : `/${locale}`}/novel/${slug}-p${shortId}`;
}

/** 从 slug `<prefix>-<序号>` 反推序号（夹具把序号写进了 slug）。 */
function ordinalOf(prefix: string, slug: string) {
  return Number(slug.slice(prefix.length + 1));
}

/** 独立于被测代码推出的 novelpage 条目序列：每篇文章后面紧跟它的可读章节。 */
function expectedNovelEntries(
  rows: readonly VisibleArticleRow[], input: { prefix: string; locale: string; chaptersPerNovel: number },
): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  for (const row of rows) {
    const ordinal = ordinalOf(input.prefix, row.slug);
    const loc = articleUrl(input.locale, row.slug, row.short_id);
    entries.push({
      loc, lastmod: row.updated_at.toISOString(), changefreq: "weekly", priority: 0.9,
      imageUrl: `/covers/${ordinal}.webp`, imageTitle: `Scale article ${ordinal}`,
    });
    for (let chapter = 1; chapter <= input.chaptersPerNovel; chapter += 1) {
      entries.push({
        loc: `${loc}/chapter/${chapter}`,
        lastmod: new Date(chapterBaseUpdatedAt.valueOf() + ordinal * 1000).toISOString(),
        changefreq: "monthly", priority: 0.6,
      });
    }
  }
  return entries;
}

function firstMismatch(actual: readonly SitemapEntry[], expected: readonly SitemapEntry[]): string | null {
  if (actual.length !== expected.length) return `length actual=${actual.length} expected=${expected.length}`;
  for (let index = 0; index < expected.length; index += 1) {
    const a = actual[index]!;
    const e = expected[index]!;
    if (a.loc !== e.loc || a.lastmod !== e.lastmod || a.changefreq !== e.changefreq
      || a.priority !== e.priority || a.imageUrl !== e.imageUrl || a.imageTitle !== e.imageTitle) {
      return `index ${index} actual=${JSON.stringify(a)} expected=${JSON.stringify(e)}`;
    }
  }
  return null;
}

function shardCheck(files: readonly SitemapFile[], type: SitemapType, locale: string, total: number) {
  expect(files.map((file) => file.name)).toEqual(
    Array.from({ length: Math.ceil(total / SITEMAP_SHARD_SIZE) }, (_, index) =>
      index === 0 ? `site_${type}_${locale}.xml` : `site_${type}_${locale}_${index}.xml`),
  );
  files.forEach((file, index) => {
    const isLast = index === files.length - 1;
    expect(file.entries.length).toBe(isLast ? total - SITEMAP_SHARD_SIZE * index : SITEMAP_SHARD_SIZE);
    const latest = file.entries.reduce((max, entry) => Math.max(max, new Date(entry.lastmod).valueOf()), 0);
    expect(file.lastmod).toBe(new Date(latest).toISOString());
  });
}

describe.skipIf(!enabled).sequential("sitemap scale on disposable PostgreSQL 16.14 · 单语种 3 万篇", () => {
  let channel: ChannelFixture;
  let categories: Array<{ slug: string; id: string }>;
  const BIG_PREFIX = "big";
  const bigOracle: { rows: VisibleArticleRow[] } = { rows: [] };

  beforeAll(async () => {
    process.env.SITE_URL = SITE;
    await resetDatabase();
    channel = await createChannelFixture(owner);
    const t0 = Date.now();
    // 主语种：3 万篇，每本 3 个可读章节、手工分类归属（走 novel_tag_state / novel_canonical_tag 的真实约束）。
    await seedBulkPublicArticles(owner, {
      prefix: BIG_PREFIX, locale: BIG_LOCALE, count: BIG_COUNT, channel, baseUpdatedAt,
    });
    await applyBulkNoise(owner, { prefix: BIG_PREFIX, count: BIG_COUNT });
    await seedBulkPreviewChapters(owner, {
      prefix: BIG_PREFIX, count: BIG_COUNT, chaptersPerNovel: CHAPTERS_PER_NOVEL, baseUpdatedAt: chapterBaseUpdatedAt,
    });
    categories = await seedBulkManualCategories(owner, {
      prefix: BIG_PREFIX, count: BIG_COUNT,
      categories: [
        { slug: "fantasy", displayName: "Fantasy" }, { slug: "romance", displayName: "Romance" },
        { slug: "mystery", displayName: "Mystery" },
      ],
    });
    // 另加适量其它语种：它们的数据绝不能混进 en 的分片，反过来也一样。
    await seedBulkPublicArticles(owner, { prefix: "ko", locale: "ko", count: 1_200, channel, baseUpdatedAt });
    await applyBulkNoise(owner, { prefix: "ko", count: 1_200 });
    await seedBulkPreviewChapters(owner, {
      prefix: "ko", count: 1_200, chaptersPerNovel: CHAPTERS_PER_NOVEL, baseUpdatedAt: chapterBaseUpdatedAt,
    });
    await seedBulkPublicArticles(owner, {
      prefix: INCIDENT_LOCALE, locale: INCIDENT_LOCALE, count: INCIDENT_COUNT, channel, baseUpdatedAt,
    });
    await applyBulkNoise(owner, { prefix: INCIDENT_LOCALE, count: INCIDENT_COUNT });
    await seedBulkPublicArticles(owner, { prefix: "fr", locale: "fr", count: 300, channel, baseUpdatedAt });
    await seedBulkPreviewChapters(owner, {
      prefix: "fr", count: 300, chaptersPerNovel: CHAPTERS_PER_NOVEL, baseUpdatedAt: chapterBaseUpdatedAt,
    });
    await seedBulkBlogArticles(owner, { prefix: "blog", locale: BIG_LOCALE, count: BLOG_COUNT, baseUpdatedAt });
    bigOracle.rows = await oracleVisibleArticles(owner, BIG_LOCALE);
    console.log(`[sitemap-scale] seeded in ${Date.now() - t0} ms: en articles=${BIG_COUNT} visible=${bigOracle.rows.length}`);
  }, 600_000);

  afterAll(async () => {
    await Promise.all([owner.$disconnect(), worker.$disconnect()]);
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    delete process.env.SITE_URL;
  });

  it("夹具规模：en 公开文章 ≥ 30,000，且有噪声被排除（含只能靠应用层复核排除的纯空白推广地址）", async () => {
    expect(bigOracle.rows.length).toBeGreaterThanOrEqual(30_000);
    expect(bigOracle.rows.length).toBeLessThan(BIG_COUNT);
    const [{ published }] = await owner.$queryRaw<Array<{ published: bigint }>>`
      SELECT count(*) AS published FROM article WHERE locale = ${BIG_LOCALE} AND status = 'published' AND article_type = 'novel_article'`;
    expect(Number(published)).toBeGreaterThanOrEqual(30_000);
    // 组合外键真的在用：每篇文章的 (promo_link_id, novel_id) 都落在 promo_link 的 (id, novel_id) 上。
    const [{ joined }] = await owner.$queryRaw<Array<{ joined: bigint }>>`
      SELECT count(*) AS joined FROM article a JOIN promo_link p ON p.id = a.promo_link_id AND p.novel_id = a.novel_id
      WHERE a.locale = ${BIG_LOCALE}`;
    expect(Number(joined)).toBe(BIG_COUNT);
  });

  // 排在所有生成用例之前：进程里还没有别的生成留下的内存，RSS/heapUsed 峰值最接近一次真实刷新任务的增量。
  it("场景 A/E · 整条链路：generateStaticSitemaps（与 sitemap_refresh 任务同款）写盘成功，每个语种的 XML 条目数等于该语种公开文章数（含章节）", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cps-novel-sitemap-scale-"));
    roots.push(root);
    const sampler = startMemorySampler();
    const t0 = Date.now();
    const result = await generateStaticSitemaps({
      buildFamily: createSitemapFamilyBuilder(worker, blogEnv),
      rootDir: root,
      runId: "scale-full-pipeline",
      routeLocales: ["en", "ko", "fr"],
    });
    const elapsedMs = Date.now() - t0;
    console.log(`[sitemap-scale] full pipeline (en+ko+fr, mainpage+novelpage+blogpage) files=${result.manifest.sitemapFiles.length} `
      + `elapsedMs=${elapsedMs} memory=${JSON.stringify(sampler.stop())}`);

    const urlCount = async (name: string) =>
      [...(await readFile(path.join(root, "current", "sitemap", name), "utf8")).matchAll(/<url>/g)].length;
    const enRows = bigOracle.rows.length;
    const expectedEnNovelEntries = enRows * (1 + CHAPTERS_PER_NOVEL);
    let enNovel = 0;
    for (let shard = 0; shard < Math.ceil(expectedEnNovelEntries / SITEMAP_SHARD_SIZE); shard += 1) {
      enNovel += await urlCount(shard === 0 ? "site_novelpage_en.xml" : `site_novelpage_en_${shard}.xml`);
    }
    expect(enNovel).toBe(expectedEnNovelEntries);
    const files = [...result.manifest.sitemapFiles];
    expect(files).toContain("sitemap/site_novelpage_en.xml");
    expect(files).toContain("sitemap/site_novelpage_en_3.xml");
    expect(files).not.toContain(`sitemap/site_novelpage_en_${Math.ceil(expectedEnNovelEntries / SITEMAP_SHARD_SIZE)}.xml`);
    expect(files).toContain("sitemap/site_mainpage_ko.xml");
    expect(files).toContain("sitemap/site_novelpage_fr.xml");
    expect(await readFile(path.join(root, "current", "sitemap.xml"), "utf8")).toContain("site_novelpage_en_3.xml");
  }, 600_000);

  it("场景 A/B/E · novelpage：3 万篇一次生成成功，条目与顺序与独立 SQL 预期逐条一致，分片条目数 = SITEMAP_SHARD_SIZE，lastmod 正确", async () => {
    const sampler = startMemorySampler();
    const t0 = Date.now();
    const files = await createSitemapFamilyBuilder(worker, process.env)({ type: "novelpage", locale: BIG_LOCALE as SiteLocale });
    const elapsedMs = Date.now() - t0;
    const memory = sampler.stop();
    console.log(`[sitemap-scale] novelpage ${BIG_LOCALE} articles=${bigOracle.rows.length} chunk=${SITEMAP_ARTICLE_LOAD_CHUNK_SIZE} `
      + `entries=${files.reduce((sum, file) => sum + file.entries.length, 0)} shards=${files.length} elapsedMs=${elapsedMs} `
      + `memory=${JSON.stringify(memory)}`);

    const expected = expectedNovelEntries(bigOracle.rows, {
      prefix: BIG_PREFIX, locale: BIG_LOCALE, chaptersPerNovel: CHAPTERS_PER_NOVEL,
    });
    expect(expected.length).toBe(bigOracle.rows.length * (1 + CHAPTERS_PER_NOVEL));
    shardCheck(files, "novelpage", BIG_LOCALE, expected.length);
    expect(firstMismatch(files.flatMap((file) => file.entries), expected)).toBeNull();
    // 站点地图条目数 = 应公开的文章数（扣掉章节条目）。
    const articleEntries = files.flatMap((file) => file.entries).filter((entry) => !entry.loc.includes("/chapter/"));
    expect(articleEntries.length).toBe(bigOracle.rows.length);
  }, 600_000);

  it("场景 A/B · 事故同款量级（de 14,000 篇）：改前 54001 stack depth limit exceeded，改后条目与独立预期逐条一致", async () => {
    const rows = await oracleVisibleArticles(owner, INCIDENT_LOCALE);
    expect(rows.length).toBeGreaterThan(6_835); // 事故现场失败的那条元组 IN 就是 6,835 组（$13670 个参数）
    expect(rows.length).toBeLessThan(16_384); // 元组数 × 2 < 32,767：不会先被 Prisma 客户端绑定变量上限拦下
    const t0 = Date.now();
    const files = await createSitemapFamilyBuilder(worker, process.env)({ type: "novelpage", locale: INCIDENT_LOCALE as SiteLocale });
    console.log(`[sitemap-scale] novelpage ${INCIDENT_LOCALE} articles=${rows.length} elapsedMs=${Date.now() - t0}`);
    const expected = expectedNovelEntries(rows, { prefix: INCIDENT_LOCALE, locale: INCIDENT_LOCALE, chaptersPerNovel: 0 });
    shardCheck(files, "novelpage", INCIDENT_LOCALE, expected.length);
    expect(firstMismatch(files.flatMap((file) => file.entries), expected)).toBeNull();
  }, 600_000);

  it("场景 A/B · mainpage：3 万个小说 id 走分类归属查询也不会撞绑定变量上限（自动标签关/开两条 SQL 各一遍），首页 + 分类页条目与独立预期一致", async () => {
    // B-38：分类网址只列分类页会返回 200 的——页面只看最新 PUBLIC_LIST_CAP 本，所以每个分类的页数按"页面列表里的本数"算，
    // 不再按全量（改前每个分类可达数百页的 `?page=N`，页面一律 404）。页面列表的独立预期见 `oracleListedArticles`。
    const listedByCategory = new Map<string, number>();
    for (const row of await oracleListedArticles(owner, BIG_LOCALE, PUBLIC_LIST_CAP)) {
      const slug = categories[ordinalOf(BIG_PREFIX, row.slug) % categories.length]!.slug;
      listedByCategory.set(slug, (listedByCategory.get(slug) ?? 0) + 1);
    }
    const expectedLocs = [SITE];
    for (const category of categories) {
      const listedCount = listedByCategory.get(category.slug) ?? 0;
      if (listedCount === 0) continue;
      const pages = Math.max(1, Math.ceil(listedCount / 20));
      for (let page = 1; page <= pages; page += 1) {
        expectedLocs.push(page === 1 ? `${SITE}/category/${category.slug}` : `${SITE}/category/${category.slug}?page=${page}`);
      }
    }
    const setting = await owner.siteSetting.findUniqueOrThrow({ where: { id: 1 } });
    const latestArticle = bigOracle.rows.reduce((max, row) => Math.max(max, row.updated_at.valueOf()), 0);

    // 分类归属的原生 SQL 里小说 id 重复出现：自动标签关 = 2 次，开 = 3 次（`FEATURE_NOVEL_TAG_AUTO`，读 process.env）。
    for (const autoTagging of ["false", "true"]) {
      process.env.FEATURE_NOVEL_TAG_AUTO = autoTagging;
      try {
        const sampler = startMemorySampler();
        const t0 = Date.now();
        const files = await createSitemapFamilyBuilder(worker, process.env)({ type: "mainpage", locale: BIG_LOCALE as SiteLocale });
        console.log(`[sitemap-scale] mainpage ${BIG_LOCALE} autoTagging=${autoTagging} elapsedMs=${Date.now() - t0} `
          + `memory=${JSON.stringify(sampler.stop())}`);
        shardCheck(files, "mainpage", BIG_LOCALE, expectedLocs.length);
        expect(files.flatMap((file) => file.entries).map((entry) => entry.loc)).toEqual(expectedLocs);
        // 首页 lastmod = max(站点设置 updatedAt, 全部候选文章 updatedAt)。
        expect(files[0]!.entries[0]!.lastmod)
          .toBe(new Date(Math.max(setting.updatedAt.valueOf(), latestArticle)).toISOString());
      } finally {
        delete process.env.FEATURE_NOVEL_TAG_AUTO;
      }
    }
  }, 600_000);

  it("场景 A/B · blogpage：2,600 篇博客分块读取，条目与顺序与独立预期一致；开关关闭时不出文件", async () => {
    const rows = await oracleVisibleBlogArticles(owner, BIG_LOCALE);
    expect(rows.length).toBeGreaterThan(SITEMAP_ARTICLE_LOAD_CHUNK_SIZE * 4);
    const files = await createSitemapFamilyBuilder(worker, blogEnv)({ type: "blogpage", locale: BIG_LOCALE as SiteLocale });
    shardCheck(files, "blogpage", BIG_LOCALE, rows.length);
    expect(files.flatMap((file) => file.entries).map((entry) => [entry.loc, entry.lastmod])).toEqual(
      rows.map((row) => [`${SITE}/blog/${row.slug}`, row.updated_at.toISOString()]),
    );
    expect(await createSitemapFamilyBuilder(worker, { ...process.env, FEATURE_ARTICLE_BLOG: "false" })({
      type: "blogpage", locale: BIG_LOCALE as SiteLocale,
    })).toEqual([]);
  }, 600_000);

  it("场景 B · 其它语种：ko / fr 各自的条目数与独立预期一致，不混入 en 的数据", async () => {
    for (const [locale, prefix] of [["ko", "ko"], ["fr", "fr"]] as const) {
      const rows = await oracleVisibleArticles(owner, locale);
      const files = await createSitemapFamilyBuilder(worker, process.env)({ type: "novelpage", locale });
      const expected = expectedNovelEntries(rows, { prefix, locale, chaptersPerNovel: CHAPTERS_PER_NOVEL });
      shardCheck(files, "novelpage", locale, expected.length);
      expect(firstMismatch(files.flatMap((file) => file.entries), expected)).toBeNull();
      expect(files.flatMap((file) => file.entries).every((entry) => entry.loc.startsWith(`${SITE}/${locale}/`))).toBe(true);
    }
  }, 600_000);
});

describe.skipIf(!enabled).sequential("sitemap 小规模输出与分块大小无关（逐字节）", () => {
  const SMALL_PREFIX = "small";
  const SMALL_COUNT = 37;
  const SMALL_BLOG = 23;
  let channel: ChannelFixture;

  beforeAll(() => { process.env.SITE_URL = SITE; });
  beforeEach(async () => {
    await resetDatabase();
    channel = await createChannelFixture(owner);
    await seedBulkPublicArticles(owner, { prefix: SMALL_PREFIX, locale: "en", count: SMALL_COUNT, channel, baseUpdatedAt });
    // 小规模也带噪声：序号 1..37 里 g % 700 就是 g 本身，噪声只会落在 g = 1..6（6 种，各 1 篇）。
    await applyBulkNoise(owner, { prefix: SMALL_PREFIX, count: SMALL_COUNT });
    await seedBulkPreviewChapters(owner, {
      prefix: SMALL_PREFIX, count: SMALL_COUNT, chaptersPerNovel: 2, baseUpdatedAt: chapterBaseUpdatedAt,
    });
    await seedBulkManualCategories(owner, {
      prefix: SMALL_PREFIX, count: SMALL_COUNT,
      categories: [{ slug: "fantasy", displayName: "Fantasy" }, { slug: "romance", displayName: "Romance" }],
    });
    await seedBulkPublicArticles(owner, { prefix: "smallko", locale: "ko", count: 9, channel, baseUpdatedAt });
    await seedBulkBlogArticles(owner, { prefix: "smallblog", locale: "en", count: SMALL_BLOG, baseUpdatedAt });
  }, 120_000);
  afterAll(async () => {
    await Promise.all([owner.$disconnect(), worker.$disconnect()]);
    delete process.env.SITE_URL;
  });

  async function renderEverything(articleLoadChunkSize: number | undefined) {
    const build = createSitemapFamilyBuilder(worker, blogEnv, articleLoadChunkSize === undefined ? undefined : { articleLoadChunkSize });
    const out: Record<string, string> = {};
    const all: SitemapFile[] = [];
    for (const locale of ["en", "ko", "fr"] as const) {
      for (const type of ["mainpage", "novelpage", "blogpage"] as const) {
        for (const file of await build({ type, locale })) {
          out[file.name] = renderUrlSetXml(file.entries);
          all.push(file);
        }
      }
    }
    out["sitemap.xml"] = renderSitemapIndexXml(all);
    return out;
  }

  it("场景 C：分块大小 1 / 2 / 3 / 7 / 恰好等于总数 / 比总数大 1 / 远大于总数，生成的全部 XML（含总索引）与默认分块逐字节一致，且非空", async () => {
    const baseline = await renderEverything(undefined);
    expect(Object.keys(baseline).sort()).toEqual([
      "site_blogpage_en.xml", "site_mainpage_en.xml", "site_mainpage_ko.xml",
      "site_novelpage_en.xml", "site_novelpage_ko.xml", "sitemap.xml",
    ]);
    // 非空且含章节、分类、博客：避免「两边都空所以相等」的假绿。
    expect(baseline["site_novelpage_en.xml"]!.match(/<url>/g)!.length).toBeGreaterThan(SMALL_COUNT);
    expect(baseline["site_novelpage_en.xml"]).toContain("/chapter/2");
    expect(baseline["site_mainpage_en.xml"]).toContain("/category/fantasy");
    expect(baseline["site_blogpage_en.xml"]!.match(/<url>/g)!.length).toBe(SMALL_BLOG - Math.floor(SMALL_BLOG / 50));

    // 预期可见数（独立 SQL）：37 篇扣掉 g=1..6 的 6 篇噪声 = 31 篇；分块翻页翻的是库里的 37 行（含不可见行）。
    expect(await oracleVisibleArticles(owner, "en")).toHaveLength(SMALL_COUNT - 6);

    for (const size of [1, 2, 3, 7, 37, 38, 1_000_000]) {
      const variant = await renderEverything(size);
      expect(Object.keys(variant).sort()).toEqual(Object.keys(baseline).sort());
      for (const name of Object.keys(baseline)) {
        expect(variant[name], `chunk=${size} file=${name}`).toBe(baseline[name]);
      }
    }
  }, 300_000);
});
