import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GET as getSitemapChild } from "@/app/sitemap/[fileName]/route";
import {
  createSitemapFamilyBuilder,
  getSitemapFileName,
  parseLegacyCategoryPageFileName,
  parseSitemapFileName,
  SITEMAP_SHARD_SIZE,
  SITEMAP_TYPES,
} from "@/lib/seo/sitemap";
import { buildChapterPath } from "@/lib/seo/chapter-path";
import { generateStaticSitemaps } from "@/lib/seo/static-sitemap-generator";
import {
  listPreviewChapterRefs,
  PREVIEW_CHAPTER_TAKE,
  PUBLIC_PREVIEW_CHAPTER_WHERE,
} from "@/lib/site/queries";
import { SITE_LOCALES } from "@/lib/locale/locale-canonical";
import { invalidateSiteSettingCache } from "@/server/site-settings/service";

import { classifyPublicListQuery } from "../../fixtures/in-memory-public-db";

/**
 * 运营第二轮 · 站点地图（Owner 2026-09-30，运营《小说站调整V2.docx》）：
 *
 * 1. 空语种不出站点地图——没有公开小说的语种，总索引不列它的 mainpage / novelpage 分片，直接访问
 *    返回 404；有书的语种照常。（PN-09，Owner 2026-10-08：此前"空"还要求没有公开博客文章，
 *    导致只有博客的语种仍把一个 noindex 的首页写进站点地图，现收回到只看书；blogpage 不变。）
 * 2. 分类页并入 mainpage——不再有 categorypage 分片；旧 `site_categorypage_<语种>[_N].xml`
 *    308 到 `site_mainpage_<语种>.xml`（语种没有内容时 404）。
 * 3. 免费可读的章节页写进 novelpage 分片，紧跟在所属小说后面。
 *
 * 用一个会真正按 `where` 片段过滤章节的内存 db，而不是"忽略 where 直接返回所有行"的桩——
 * 否则"不含锁定/撤回/未发布章节"只是断言了桩自己的返回值。
 */

const SITE = "https://novel.example";
const temporaryRoots: string[] = [];

afterEach(async () => {
  delete process.env.SITE_URL;
  delete process.env.SITEMAP_STATIC_DIR;
  invalidateSiteSettingCache();
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sitemap-ops-round2-"));
  temporaryRoots.push(root);
  return root;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type ArticleRow = ReturnType<typeof article>;
type ChapterRow = ReturnType<typeof chapter>;

function article(input: {
  id: string;
  locale: string;
  slug: string;
  shortId: string;
  novelId: string;
  novelStatus?: string;
  updatedAt?: string;
}) {
  return {
    id: input.id,
    locale: input.locale,
    slug: input.slug,
    publicPageShortId: input.shortId,
    title: input.slug,
    status: "published",
    seoVisibility: "public",
    deletedAt: null as Date | null,
    updatedAt: new Date(input.updatedAt ?? "2026-08-05T12:30:00.000Z"),
    novel: {
      id: input.novelId,
      status: input.novelStatus ?? "published",
      deletedAt: null as Date | null,
      coverUrl: `/covers/${input.novelId}.webp`,
    },
    promoLink: { status: "fetched", webUrl: `https://promo.example/${input.shortId}`, appUrl: null, deletedAt: null as Date | null },
  };
}

function blogRow(input: { id: string; locale: string; slug: string }) {
  return {
    id: input.id,
    locale: input.locale,
    slug: input.slug,
    title: input.slug,
    status: "published",
    articleType: "blog_article",
    seoVisibility: "public",
    deletedAt: null as Date | null,
    updatedAt: new Date("2026-08-06T00:00:00.000Z"),
  };
}

function chapter(input: {
  novelId: string;
  number: number;
  status?: string;
  deletedAt?: Date | null;
  content?: { charCount: number } | null;
  updatedAt?: string;
}) {
  return {
    novelId: input.novelId,
    canonicalChapterNumber: input.number,
    status: input.status ?? "preview",
    deletedAt: input.deletedAt ?? null,
    content: input.content === undefined ? { charCount: 1200 } : input.content,
    updatedAt: new Date(input.updatedAt ?? "2026-08-07T00:00:00.000Z"),
  };
}

const TAG_ROW = (novelId: string) => ({
  novel_id: novelId,
  id: "22222222-2222-4222-8222-222222222222",
  slug: "fantasy",
  requested_display_name: "Fantasy",
  en_display_name: "Fantasy",
  zh_display_name: "奇幻",
  sort_order: 7,
  updated_at: new Date("2026-09-02T00:00:00Z"),
});

/**
 * 内存 db。`novelChapter.findMany` 真正按传入的 `where` 过滤：只认 `PUBLIC_PREVIEW_CHAPTER_WHERE`
 * 里出现的键（deletedAt / status / content）加 `novelId`，遇到不认识的键直接抛错——
 * 谁给片段加了新条件而这里没跟上，会当场红，而不是被悄悄忽略。
 */
function makeDb(input: {
  articles?: ArticleRow[];
  blogs?: ReturnType<typeof blogRow>[];
  chapters?: ChapterRow[];
  tagsByNovel?: Record<string, ReturnType<typeof TAG_ROW>[]>;
}) {
  const articles = input.articles ?? [];
  const blogs = input.blogs ?? [];
  const chapters = input.chapters ?? [];

  const articleFindMany = vi.fn(async ({ where }: { where: { AND: Array<Record<string, unknown>> } }) => {
    const locale = where.AND.find((clause) => "locale" in clause)?.locale;
    if (JSON.stringify(where).includes('"articleType"')) {
      return blogs.filter((row) => row.locale === locale);
    }
    return articles.filter((row) => row.locale === locale);
  });

  const chapterFindMany = vi.fn(async (args: {
    where: Record<string, unknown>;
    orderBy?: unknown;
    take?: number;
  }) => {
    const allowed = new Set(["deletedAt", "status", "content", "novelId"]);
    for (const key of Object.keys(args.where)) {
      if (!allowed.has(key)) throw new Error(`fake novelChapter.findMany does not understand where.${key}`);
    }
    const { novelId } = args.where as { novelId?: string | { in: string[] } };
    const matches = chapters.filter((row) => {
      if (args.where.deletedAt === null && row.deletedAt !== null) return false;
      if (typeof args.where.status === "string" && row.status !== args.where.status) return false;
      const content = args.where.content as { isNot?: null } | undefined;
      if (content && "isNot" in content && content.isNot === null && row.content === null) return false;
      if (typeof novelId === "string" && row.novelId !== novelId) return false;
      if (novelId && typeof novelId === "object" && !novelId.in.includes(row.novelId)) return false;
      return true;
    });
    matches.sort((a, b) => a.novelId.localeCompare(b.novelId) || a.canonicalChapterNumber - b.canonicalChapterNumber);
    const limited = typeof args.take === "number" ? matches.slice(0, args.take) : matches;
    return limited.map((row) => ({
      novelId: row.novelId,
      canonicalChapterNumber: row.canonicalChapterNumber,
      title: `Chapter ${row.canonicalChapterNumber}`,
      updatedAt: row.updatedAt,
      content: row.content ? { charCount: row.content.charCount } : null,
    }));
  });

  return {
    article: { findMany: articleFindMany },
    novelChapter: { findMany: chapterFindMany },
    $queryRaw: vi.fn(async (query: unknown) => {
      const values = ((query as { values?: unknown[] }).values ?? []).flat(Infinity);
      const kind = classifyPublicListQuery(query as { text: string });
      if (kind === "matrix") {
        // 每语种每分类本数矩阵：该语种里挂着标签的（列表可见）书数，按标签分组。
        const locale = values.find((value) => typeof value === "string" && (SITE_LOCALES as readonly string[]).includes(value)) as string;
        const tally = new Map<string, { id: string; slug: string; n: number }>();
        for (const row of articles) {
          if (row.locale !== locale) continue;
          for (const tag of input.tagsByNovel?.[row.novel.id] ?? []) {
            const entry = tally.get(tag.slug) ?? { id: tag.id, slug: tag.slug, n: 0 };
            entry.n += 1;
            tally.set(tag.slug, entry);
          }
        }
        return [...tally.values()].map((entry) => ({ locale, canonical_tag_id: entry.id, slug: entry.slug, n: entry.n }));
      }
      if (kind !== "taxonomy") return [];
      // 卡片 / 候选的标签（读归属表）：把 novel_id IN (...) 里出现的 id 对应的标签行返回。
      return Object.entries(input.tagsByNovel ?? {})
        .filter(([novelId]) => values.includes(novelId))
        .flatMap(([, rows]) => rows);
    }),
    siteSetting: {
      findUnique: vi.fn().mockResolvedValue({
        siteName: "Fixture",
        siteDescription: "",
        homeMetaTitle: "",
        homeMetaDescription: "",
        defaultOgImage: "",
        googleSearchConsoleVerification: "",
        footerCopyrightText: "",
        footerDisclaimerText: "",
        friendLinks: [],
        indexNowHost: "",
        indexNowKey: "",
        indexNowKeyLocation: "",
        ga4MeasurementId: null,
        yandexVerification: "",
        yandexMetricaId: null,
        siteSearchEnabled: false,
        updatedAt: new Date("2026-08-04T00:00:00.000Z"),
      }),
    },
  };
}

const ENV_BLOG_OFF = { FEATURE_ARTICLE_BLOG: "false" } as unknown as NodeJS.ProcessEnv;
const ENV_BLOG_ON = { FEATURE_ARTICLE_BLOG: "true" } as unknown as NodeJS.ProcessEnv;

async function generateInto(root: string, fixtureDb: ReturnType<typeof makeDb>, env: NodeJS.ProcessEnv) {
  process.env.SITE_URL = SITE;
  process.env.SITEMAP_STATIC_DIR = root;
  const result = await generateStaticSitemaps({
    buildFamily: createSitemapFamilyBuilder(fixtureDb as never, env),
    rootDir: root,
    runId: "release-a",
  });
  return {
    listed: result.manifest.sitemapFiles,
    indexXml: await fs.readFile(path.join(root, "current", "sitemap.xml"), "utf-8"),
  };
}

async function get(fileName: string) {
  return getSitemapChild(new Request(`${SITE}/sitemap/${fileName}`), { params: Promise.resolve({ fileName }) });
}

// ---------------------------------------------------------------------------
// 1. 空语种不出站点地图
// ---------------------------------------------------------------------------

describe("empty locales are not in the sitemap (运营 V2)", () => {
  const koBook = article({ id: "a-ko", locale: "ko", slug: "deungdae", shortId: "kor12345", novelId: "n-ko" });

  it("index lists no shard at all for a locale with no public novel and no public blog post — mainpage included, en too", async () => {
    const root = await temporaryRoot();
    const { listed, indexXml } = await generateInto(root, makeDb({ articles: [koBook] }), ENV_BLOG_OFF);

    expect(listed.sort()).toEqual(["sitemap/site_mainpage_ko.xml", "sitemap/site_novelpage_ko.xml"]);
    // Every other registered locale (en included) contributes nothing to the index.
    for (const locale of ["en", "ja", "fr", "pt-BR", "ar"]) {
      expect(indexXml).not.toContain(`_${locale}.xml`);
    }
    await expect(fs.stat(path.join(root, "current", "sitemap", "site_mainpage_en.xml"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("direct access to an empty locale's shard URL is a 404 (not an empty file, not a 503); the populated locale still serves 200", async () => {
    const root = await temporaryRoot();
    await generateInto(root, makeDb({ articles: [koBook] }), ENV_BLOG_OFF);

    for (const name of ["site_mainpage_en.xml", "site_novelpage_en.xml", "site_blogpage_en.xml", "site_mainpage_ja.xml"]) {
      const response = await get(name);
      expect(response.status, name).toBe(404);
      expect(await response.text()).not.toContain("<urlset");
    }
    // A shard index past the last real shard of a populated locale is equally non-existent.
    expect((await get("site_novelpage_ko_3.xml")).status).toBe(404);

    const ko = await get("site_mainpage_ko.xml");
    expect(ko.status).toBe(200);
    expect(await ko.text()).toContain(`${SITE}/ko`);
    expect((await get("site_novelpage_ko.xml")).status).toBe(200);
  });

  it("still answers 503 (not 404) while no release exists at all — the service is unavailable, not the locale empty", async () => {
    process.env.SITE_URL = SITE;
    process.env.SITEMAP_STATIC_DIR = await temporaryRoot();
    expect((await get("site_mainpage_ko.xml")).status).toBe(503);
    expect((await get("site_categorypage_ko.xml")).status).toBe(503);
    // A name that is not a sitemap file at all is a 404 regardless.
    expect((await get("nope.xml")).status).toBe(404);
  });

  it("the default locale en follows the same rule: with content it is listed and served; without, it is neither", async () => {
    const enBook = article({ id: "a-en", locale: "en", slug: "lighthouse", shortId: "eng12345", novelId: "n-en" });
    const root = await temporaryRoot();
    const { listed } = await generateInto(root, makeDb({ articles: [enBook, koBook] }), ENV_BLOG_OFF);
    expect(listed).toEqual(expect.arrayContaining([
      "sitemap/site_mainpage_en.xml",
      "sitemap/site_novelpage_en.xml",
      "sitemap/site_mainpage_ko.xml",
    ]));
    const enHome = await get("site_mainpage_en.xml");
    expect(enHome.status).toBe(200);
    expect(await enHome.text()).toContain(`<loc>${SITE}</loc>`);
  });

  it("PN-09: a locale whose only content is a public blog post gets its blogpage but NO mainpage (its home is noindex, so it must not be in the sitemap); blog off -> nothing at all", async () => {
    // 运营 V2（2026-09-30）曾规定"只有博客的语种 mainpage + blogpage 都列"。PN-09（Owner 2026-10-08：
    // 没有书时连入口也隐藏）把"有内容"收回到"有书"：只有博客的语种首页 noindex，不能留在站点地图里。
    // 博客文章页本身有内容、不受空语种影响，blogpage 照旧。
    const jaPost = blogRow({ id: "b-ja", locale: "ja", slug: "kansou" });

    const rootOn = await temporaryRoot();
    const on = await generateInto(rootOn, makeDb({ blogs: [jaPost] }), ENV_BLOG_ON);
    expect(on.listed.sort()).toEqual(["sitemap/site_blogpage_ja.xml"]);
    expect((await get("site_blogpage_ja.xml")).status).toBe(200);
    expect((await get("site_mainpage_ja.xml")).status).toBe(404);
    expect(on.indexXml).not.toContain("site_mainpage_ja.xml");

    // Blog off: the post does not count as content — the locale has nothing, and the whole release has
    // no public URL at all, so generation refuses to publish an empty sitemap (existing fail-closed guard).
    const rootOff = await temporaryRoot();
    await expect(generateInto(rootOff, makeDb({ blogs: [jaPost] }), ENV_BLOG_OFF)).rejects.toThrow(
      /No sitemap child files were generated/,
    );
  });

  it("PN-09: a locale with a book AND a blog post keeps its mainpage (the book is what makes it non-empty)", async () => {
    const jaPost = blogRow({ id: "b-ja", locale: "ja", slug: "kansou" });
    const root = await temporaryRoot();
    const { listed } = await generateInto(root, makeDb({ articles: [koBook], blogs: [jaPost] }), ENV_BLOG_ON);
    // ko has a book -> mainpage + novelpage; ja only a post -> blogpage only.
    expect(listed.sort()).toEqual([
      "sitemap/site_blogpage_ja.xml",
      "sitemap/site_mainpage_ko.xml",
      "sitemap/site_novelpage_ko.xml",
    ]);
  });

  it("uses the same visibility judgement as the shards: a locale whose only book is draft/unpublished/takedown/hidden-promo counts as empty", async () => {
    const hiddenBooks = [
      { ...article({ id: "a1", locale: "fr", slug: "brouillon", shortId: "fr000001", novelId: "n1" }), status: "draft" },
      { ...article({ id: "a2", locale: "fr", slug: "retire", shortId: "fr000002", novelId: "n2", novelStatus: "takedown" }) },
      { ...article({ id: "a3", locale: "fr", slug: "sans-promo", shortId: "fr000003", novelId: "n3" }), promoLink: { status: "fetched", webUrl: "   ", appUrl: null, deletedAt: null } },
    ];
    const root = await temporaryRoot();
    const { listed } = await generateInto(root, makeDb({ articles: [koBook, ...hiddenBooks] }), ENV_BLOG_OFF);
    expect(listed.some((name) => name.includes("_fr"))).toBe(false);
    expect((await get("site_mainpage_fr.xml")).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 2. categorypage 并入 mainpage
// ---------------------------------------------------------------------------

describe("categorypage is folded into mainpage (运营 V2, CPS v8.5.1 has three families)", () => {
  const koBook = article({ id: "a-ko", locale: "ko", slug: "deungdae", shortId: "kor12345", novelId: "n-ko" });

  it("SITEMAP_TYPES has no categorypage, and a categorypage file name is no longer a shard name", () => {
    expect(SITEMAP_TYPES).toEqual(["mainpage", "novelpage", "blogpage"]);
    expect(parseSitemapFileName("site_categorypage_ko.xml")).toBeNull();
    expect(parseSitemapFileName("site_categorypage_ko_2.xml")).toBeNull();
  });

  it("the index never lists a categorypage shard, and the mainpage shard lists the home page first, then the locale's category pages", async () => {
    const root = await temporaryRoot();
    const { listed, indexXml } = await generateInto(
      root,
      makeDb({ articles: [koBook], tagsByNovel: { "n-ko": [TAG_ROW("n-ko")] } }),
      ENV_BLOG_OFF,
    );
    expect(indexXml).not.toContain("categorypage");
    expect(listed.some((name) => name.includes("categorypage"))).toBe(false);

    const xml = await (await get("site_mainpage_ko.xml")).text();
    const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1]);
    expect(locs).toEqual([`${SITE}/ko`, `${SITE}/ko/category/fantasy`]);
  });

  it("legacy categorypage URLs (also the _N paged ones) 308 to the same locale's mainpage, using the configured site URL", async () => {
    const root = await temporaryRoot();
    await generateInto(root, makeDb({ articles: [koBook] }), ENV_BLOG_OFF);

    for (const legacy of ["site_categorypage_ko.xml", "site_categorypage_ko_1.xml", "site_categorypage_ko_12.xml"]) {
      const response = await getSitemapChild(new Request(`https://attacker.example/sitemap/${legacy}`), {
        params: Promise.resolve({ fileName: legacy }),
      });
      expect(response.status, legacy).toBe(308);
      // Configured SITE_URL, never the request's Host (same discipline as CPS's legacy redirect routes).
      expect(response.headers.get("location"), legacy).toBe(`${SITE}/sitemap/site_mainpage_ko.xml`);
    }
  });

  it("a legacy categorypage URL for a locale with no content is a 404, and an unregistered locale is a 404 too", async () => {
    const root = await temporaryRoot();
    await generateInto(root, makeDb({ articles: [koBook] }), ENV_BLOG_OFF);

    expect((await get("site_categorypage_en.xml")).status).toBe(404);
    expect((await get("site_categorypage_ja_2.xml")).status).toBe(404);
    expect((await get("site_categorypage_xx.xml")).status).toBe(404);
  });

  it("parseLegacyCategoryPageFileName only accepts registered locales and reads the optional shard index", () => {
    expect(parseLegacyCategoryPageFileName("site_categorypage_ko.xml")).toEqual({ locale: "ko", index: 0 });
    expect(parseLegacyCategoryPageFileName("site_categorypage_pt-BR_3.xml")).toEqual({ locale: "pt-BR", index: 3 });
    expect(parseLegacyCategoryPageFileName("site_categorypage_xx.xml")).toBeNull();
    expect(parseLegacyCategoryPageFileName("site_mainpage_ko.xml")).toBeNull();
    expect(getSitemapFileName("mainpage", "ko", 0)).toBe("site_mainpage_ko.xml");
  });
});

// ---------------------------------------------------------------------------
// 3. 章节页写进 novelpage 分片
// ---------------------------------------------------------------------------

describe("free preview chapters are listed in the novelpage shard (运营 V2)", () => {
  const book = article({ id: "a-ko", locale: "ko", slug: "deungdae", shortId: "kor12345", novelId: "n-ko" });
  const bookUrl = `${SITE}/ko/novel/deungdae-pkor12345`;

  it("lists the free chapters right after their novel, with locale-prefixed URLs built by buildChapterPath", async () => {
    process.env.SITE_URL = SITE;
    const fixtureDb = makeDb({
      articles: [book],
      chapters: [
        chapter({ novelId: "n-ko", number: 2, updatedAt: "2026-08-09T00:00:00.000Z" }),
        chapter({ novelId: "n-ko", number: 1, updatedAt: "2026-08-08T00:00:00.000Z" }),
        chapter({ novelId: "n-ko", number: 3, updatedAt: "2026-08-07T00:00:00.000Z" }),
      ],
    });
    const files = await createSitemapFamilyBuilder(fixtureDb as never, ENV_BLOG_OFF)({ type: "novelpage", locale: "ko" });

    expect(files).toHaveLength(1);
    expect(files[0]!.entries.map((entry) => entry.loc)).toEqual([
      bookUrl,
      `${bookUrl}/chapter/1`,
      `${bookUrl}/chapter/2`,
      `${bookUrl}/chapter/3`,
    ]);
    // Same string the shared builder produces — never hand-assembled.
    expect(files[0]!.entries[1]!.loc).toBe(
      `${SITE}${buildChapterPath({ locale: "ko", slug: "deungdae", shortId: "kor12345", chapterNumber: 1 })}`,
    );
    // lastmod of a chapter entry is the chapter row's own updatedAt (`novel_chapter.updated_at`).
    expect(files[0]!.entries.slice(1).map((entry) => entry.lastmod)).toEqual([
      "2026-08-08T00:00:00.000Z",
      "2026-08-09T00:00:00.000Z",
      "2026-08-07T00:00:00.000Z",
    ]);
    // The novel entry keeps its own shape (image, weekly, 0.9); chapters carry no image.
    expect(files[0]!.entries[0]).toMatchObject({ changefreq: "weekly", priority: 0.9, imageUrl: "/covers/n-ko.webp" });
    expect(files[0]!.entries[1]).not.toHaveProperty("imageUrl");
    // The shard's own lastmod covers the newest chapter too.
    expect(files[0]!.lastmod).toBe("2026-08-09T00:00:00.000Z");
  });

  it("the default locale keeps the bare path for chapters (no /en prefix)", async () => {
    process.env.SITE_URL = SITE;
    const enBook = article({ id: "a-en", locale: "en", slug: "lighthouse", shortId: "eng12345", novelId: "n-en" });
    const fixtureDb = makeDb({ articles: [enBook], chapters: [chapter({ novelId: "n-en", number: 1 })] });
    const files = await createSitemapFamilyBuilder(fixtureDb as never, ENV_BLOG_OFF)({ type: "novelpage", locale: "en" });
    expect(files[0]!.entries.map((entry) => entry.loc)).toEqual([
      `${SITE}/novel/lighthouse-peng12345`,
      `${SITE}/novel/lighthouse-peng12345/chapter/1`,
    ]);
  });

  it("excludes stale / withdrawn / placeholder chapters, soft-deleted chapters, chapters with no content row, and empty-content chapters", async () => {
    process.env.SITE_URL = SITE;
    const fixtureDb = makeDb({
      articles: [book],
      chapters: [
        chapter({ novelId: "n-ko", number: 1 }),
        chapter({ novelId: "n-ko", number: 2, status: "stale" }),
        chapter({ novelId: "n-ko", number: 3, status: "withdrawn", content: null }),
        chapter({ novelId: "n-ko", number: 4, status: "locked" }),
        chapter({ novelId: "n-ko", number: 5, deletedAt: new Date("2026-08-01T00:00:00.000Z") }),
        chapter({ novelId: "n-ko", number: 6, content: null }),
        chapter({ novelId: "n-ko", number: 7, content: { charCount: 0 } }),
        chapter({ novelId: "n-ko", number: 8 }),
      ],
    });
    const files = await createSitemapFamilyBuilder(fixtureDb as never, ENV_BLOG_OFF)({ type: "novelpage", locale: "ko" });
    expect(files[0]!.entries.map((entry) => entry.loc)).toEqual([
      bookUrl,
      `${bookUrl}/chapter/1`,
      `${bookUrl}/chapter/8`,
    ]);
    // The DB query itself carries the shared "chapter page can return 200" fragment.
    const where = fixtureDb.novelChapter.findMany.mock.calls[0]![0].where;
    expect(where).toMatchObject(PUBLIC_PREVIEW_CHAPTER_WHERE);
    expect(where).toMatchObject({ deletedAt: null, status: "preview", content: { isNot: null } });
  });

  it("does not list the chapters of a novel that is not public (unpublished / takedown / draft / promo not ready) — and never even queries them", async () => {
    process.env.SITE_URL = SITE;
    const hidden = [
      article({ id: "u1", locale: "ko", slug: "unpublished-book", shortId: "kor00001", novelId: "n-unpub", novelStatus: "unpublished" }),
      article({ id: "u2", locale: "ko", slug: "takedown-book", shortId: "kor00002", novelId: "n-take", novelStatus: "takedown" }),
      { ...article({ id: "u3", locale: "ko", slug: "draft-book", shortId: "kor00003", novelId: "n-draft" }), status: "draft" },
      { ...article({ id: "u4", locale: "ko", slug: "no-promo-book", shortId: "kor00004", novelId: "n-nopromo" }), promoLink: { status: "fetched", webUrl: " ", appUrl: null, deletedAt: null } },
    ];
    const fixtureDb = makeDb({
      articles: [book, ...hidden],
      chapters: ["n-ko", "n-unpub", "n-take", "n-draft", "n-nopromo"].flatMap((novelId) => [
        chapter({ novelId, number: 1 }),
        chapter({ novelId, number: 2 }),
      ]),
    });
    const files = await createSitemapFamilyBuilder(fixtureDb as never, ENV_BLOG_OFF)({ type: "novelpage", locale: "ko" });
    const urls = files[0]!.entries.map((entry) => entry.loc);
    expect(urls).toEqual([bookUrl, `${bookUrl}/chapter/1`, `${bookUrl}/chapter/2`]);
    for (const slug of ["unpublished-book", "takedown-book", "draft-book", "no-promo-book"]) {
      expect(urls.some((url) => url.includes(slug))).toBe(false);
    }
    // Only the visible novel's id was ever used to load chapters.
    const requestedIds = fixtureDb.novelChapter.findMany.mock.calls.flatMap(
      ([args]) => (args.where as { novelId: { in: string[] } }).novelId.in,
    );
    expect(requestedIds).toEqual(["n-ko"]);
  });

  it("only the same window the chapter page serves: the first PREVIEW_CHAPTER_TAKE rows by chapter number (later numbers would 404 on the page)", async () => {
    process.env.SITE_URL = SITE;
    const fixtureDb = makeDb({
      articles: [book],
      chapters: Array.from({ length: PREVIEW_CHAPTER_TAKE + 6 }, (_, index) =>
        chapter({ novelId: "n-ko", number: index + 1 })),
    });
    const files = await createSitemapFamilyBuilder(fixtureDb as never, ENV_BLOG_OFF)({ type: "novelpage", locale: "ko" });
    const chapterLocs = files[0]!.entries.map((entry) => entry.loc).filter((loc) => loc.includes("/chapter/"));
    expect(chapterLocs).toHaveLength(PREVIEW_CHAPTER_TAKE);
    expect(chapterLocs.at(-1)).toBe(`${bookUrl}/chapter/${PREVIEW_CHAPTER_TAKE}`);
  });

  it("agrees with the page itself: the sitemap's chapter numbers are exactly the chapter numbers listPreviewChapterRefs (the page's own list) serves", async () => {
    process.env.SITE_URL = SITE;
    const rows = [
      chapter({ novelId: "n-ko", number: 1 }),
      chapter({ novelId: "n-ko", number: 2, status: "stale" }),
      chapter({ novelId: "n-ko", number: 3 }),
      chapter({ novelId: "n-ko", number: 4, content: null }),
      chapter({ novelId: "n-ko", number: 5, deletedAt: new Date() }),
      chapter({ novelId: "n-ko", number: 6 }),
    ];
    const fixtureDb = makeDb({ articles: [book], chapters: rows });
    const pageNumbers = (await listPreviewChapterRefs(fixtureDb as never, "n-ko")).map((row) => row.canonicalChapterNumber);
    const files = await createSitemapFamilyBuilder(fixtureDb as never, ENV_BLOG_OFF)({ type: "novelpage", locale: "ko" });
    const sitemapNumbers = files[0]!.entries
      .map((entry) => /\/chapter\/(\d+)$/.exec(entry.loc)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number);
    expect(pageNumbers).toEqual([1, 3, 6]);
    expect(sitemapNumbers).toEqual(pageNumbers);
  });

  it("a novel with no free chapter yields just its own entry", async () => {
    process.env.SITE_URL = SITE;
    const fixtureDb = makeDb({ articles: [book], chapters: [] });
    const files = await createSitemapFamilyBuilder(fixtureDb as never, ENV_BLOG_OFF)({ type: "novelpage", locale: "ko" });
    expect(files[0]!.entries.map((entry) => entry.loc)).toEqual([bookUrl]);
  });

  it("keeps the fixed 10,000-entry shard boundary with chapters counted as entries, and loads chapters in bounded batches", async () => {
    process.env.SITE_URL = SITE;
    const novelCount = SITEMAP_SHARD_SIZE / 2 + 1; // 5,001 novels x (1 novel + 1 chapter) = 10,002 entries
    const articles = Array.from({ length: novelCount }, (_, index) => article({
      id: `a-${String(index).padStart(5, "0")}`,
      locale: "ko",
      slug: `book-${index}`,
      shortId: `k${String(index).padStart(6, "0")}`,
      novelId: `n-${String(index).padStart(5, "0")}`,
    }));
    const chapters = articles.map((row) => chapter({ novelId: row.novel.id, number: 1 }));
    const fixtureDb = makeDb({ articles, chapters });

    const files = await createSitemapFamilyBuilder(fixtureDb as never, ENV_BLOG_OFF)({ type: "novelpage", locale: "ko" });
    expect(files.map((file) => file.name)).toEqual(["site_novelpage_ko.xml", "site_novelpage_ko_1.xml"]);
    expect(files.map((file) => file.entries.length)).toEqual([SITEMAP_SHARD_SIZE, 2]);
    // Each chapter directly follows its own novel, also across the shard boundary here.
    expect(files[0]!.entries[0]!.loc).toContain("/novel/book-0-");
    expect(files[0]!.entries[1]!.loc).toContain("/novel/book-0-");
    expect(files[0]!.entries[1]!.loc).toContain("/chapter/1");
    expect(files[1]!.entries[0]!.loc).toContain(`/novel/book-${novelCount - 1}-`);
    expect(files[1]!.entries[1]!.loc).toContain(`/novel/book-${novelCount - 1}-`);

    const batches = fixtureDb.novelChapter.findMany.mock.calls.map(
      ([args]) => (args.where as { novelId: { in: string[] } }).novelId.in.length,
    );
    expect(batches.length).toBeGreaterThan(1);
    expect(Math.max(...batches)).toBeLessThanOrEqual(500);
    expect(batches.reduce((sum, size) => sum + size, 0)).toBe(novelCount);
  });

  it("chapter URLs end up in the generated novelpage XML that the route serves", async () => {
    const root = await temporaryRoot();
    await generateInto(
      root,
      makeDb({ articles: [book], chapters: [chapter({ novelId: "n-ko", number: 1 })] }),
      ENV_BLOG_OFF,
    );
    const xml = await (await get("site_novelpage_ko.xml")).text();
    expect(xml).toContain(`<loc>${bookUrl}</loc>`);
    expect(xml).toContain(`<loc>${bookUrl}/chapter/1</loc>`);
    expect(xml.indexOf(`${bookUrl}/chapter/1`)).toBeGreaterThan(xml.indexOf(`<loc>${bookUrl}</loc>`));
  });
});
