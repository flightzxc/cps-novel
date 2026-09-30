import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createSitemapFamilyBuilder } from "@/lib/seo/sitemap";
import { generateStaticSitemaps } from "@/lib/seo/static-sitemap-generator";
import { invalidateSiteSettingCache } from "@/server/site-settings/service";

/**
 * 2026-09-30 sitemap 核查（开发单第 9 条）：生产上
 * `/sitemap/site_novelpage_en.xml` 返回 503。核查问题是"总索引有没有把空语种的
 * 分片列出来"。结论：**没有**——索引只由各家族 builder 实际返回的文件生成
 * （`generateStaticSitemaps` 逐个 `indexFiles.push`），而 novelpage / categorypage /
 * blogpage 三个 builder 在候选集为空时返回 `[]`（不是"一个空文件"），所以空语种
 * 的分片从来不进索引，也不会落盘。503 的来源是 `/sitemap/[fileName]` 路由对
 * "格式合法、但当前发布目录里没有这个文件"一律回 503（与短剧站同一份路由）——
 * 这是路由对未列出文件的应答方式，不是索引列了空分片。
 *
 * 这条用例用**真实的** `createSitemapFamilyBuilder` 跑完整的 `generateStaticSitemaps`，
 * 只给 ko 一条文章，把上面这个结论钉成可回归的事实：en 的 novelpage 分片没有生成、
 * 也没有出现在索引里。
 *
 * 🔴 运营 V2（Owner 2026-09-30）修订：上面括注里"mainpage 每个已登记语种恒有一个分片、
 * 首页在每个语种都返回 200 所以不算空分片"这一条**不再成立**——没有任何公开小说、也没有
 * 任何公开博客文章的语种，mainpage 也不出（总索引一个分片都不列，直接访问返回 404）。
 * 所以下面 mainpage 的断言由"15 个语种全列"改为"只列有内容的 ko"；categorypage 同时并入
 * mainpage，不再有这个类型。完整的新规则用例见 `sitemap-ops-round2.test.ts`。
 */

const temporaryRoots: string[] = [];

afterEach(async () => {
  delete process.env.SITE_URL;
  invalidateSiteSettingCache();
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "article-ko-1",
    locale: "ko",
    slug: "deungdae",
    publicPageShortId: "kor12345",
    title: "등대",
    status: "published",
    seoVisibility: "public",
    deletedAt: null,
    updatedAt: new Date("2026-08-05T12:30:00.000Z"),
    novel: { id: "novel-1", status: "published", deletedAt: null, coverUrl: "/covers/ko.webp" },
    promoLink: { status: "fetched", webUrl: "https://promo.example/ko", appUrl: null, deletedAt: null },
    ...overrides,
  };
}

describe("static sitemap index never lists an empty locale's novelpage/mainpage shard", () => {
  it("with only ko populated: site_novelpage_ko.xml is indexed and written; site_novelpage_en.xml (and every other empty locale) is neither", async () => {
    process.env.SITE_URL = "https://novel.example";
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sitemap-empty-locale-"));
    temporaryRoots.push(root);

    const findMany = vi.fn(async ({ where }: { where: { AND: Array<Record<string, unknown>> } }) => {
      const locale = where.AND.find((clause) => "locale" in clause)?.locale;
      return locale === "ko" ? [candidate()] : [];
    });
    const fixtureDb = {
      article: { findMany },
      novelChapter: { findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: vi.fn().mockResolvedValue([]),
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
          updatedAt: new Date("2026-08-04T00:00:00.000Z"),
        }),
      },
    };

    const result = await generateStaticSitemaps({
      buildFamily: createSitemapFamilyBuilder(fixtureDb as never, { ...process.env, FEATURE_ARTICLE_BLOG: "false" }),
      rootDir: root,
      runId: "empty-locale-not-indexed",
    });

    const listed = result.manifest.sitemapFiles;
    expect(listed).toContain("sitemap/site_novelpage_ko.xml");
    expect(listed.filter((name) => name.includes("site_novelpage_"))).toEqual(["sitemap/site_novelpage_ko.xml"]);
    // categorypage no longer exists as a shard type (folded into mainpage).
    expect(listed.filter((name) => name.includes("site_categorypage_"))).toEqual([]);

    const releaseDir = path.join(root, "releases", "empty-locale-not-indexed");
    const indexXml = await fs.readFile(path.join(releaseDir, "sitemap.xml"), "utf-8");
    expect(indexXml).toContain("/sitemap/site_novelpage_ko.xml");
    expect(indexXml).not.toContain("site_novelpage_en.xml");
    await expect(fs.stat(path.join(releaseDir, "sitemap", "site_novelpage_en.xml"))).rejects.toMatchObject({ code: "ENOENT" });

    // 运营 V2: mainpage follows the same rule as every other family — only the populated locale (ko) is listed.
    expect(listed.filter((name) => name.includes("site_mainpage_"))).toEqual(["sitemap/site_mainpage_ko.xml"]);
    expect(indexXml).not.toContain("site_mainpage_en.xml");
    await expect(fs.stat(path.join(releaseDir, "sitemap", "site_mainpage_en.xml"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

/**
 * 同一轮核查里顺带发现的第二个问题：分类页的 URL 漏了语种前缀。
 * 生产实测（只读）`site_categorypage_ko.xml` 里是
 * `https://…/category/female-audience`（无 `/ko`），该地址 404
 * （en 没有这个分类），真正的页面是 `/ko/category/female-audience`（200）。
 * 修复后分类页 URL 与所属语种一致。运营 V2 起分类页并入 mainpage 分片，这条用例改读
 * mainpage 里的分类条目（首页之后），前缀规则不变。
 */
describe("category page URLs (now inside the mainpage shard) carry the shard's own locale prefix", () => {
  const tagRow = {
    novel_id: "11111111-1111-4111-8111-111111111111",
    id: "22222222-2222-4222-8222-222222222222",
    slug: "fantasy",
    requested_display_name: "Fantasy",
    en_display_name: "Fantasy",
    zh_display_name: "奇幻",
    sort_order: 7,
    updated_at: new Date("2026-09-02T00:00:00Z"),
  };

  function fixtureDb(locale: string) {
    return {
      article: {
        findMany: vi.fn().mockResolvedValue([
          candidate({
            locale,
            novel: { id: tagRow.novel_id, status: "published", deletedAt: null, coverUrl: "/covers/x.webp" },
          }),
        ]),
      },
      novelChapter: { findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: vi.fn().mockResolvedValue([tagRow]),
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
          updatedAt: new Date("2026-08-04T00:00:00.000Z"),
        }),
      },
    };
  }

  it("ko mainpage lists /ko/category/{slug}; en stays bare; page 2+ keeps the prefix too", async () => {
    process.env.SITE_URL = "https://novel.example";
    const ko = await createSitemapFamilyBuilder(fixtureDb("ko") as never)({ type: "mainpage", locale: "ko" });
    expect(ko[0]!.entries.map((entry) => entry.loc)).toEqual([
      "https://novel.example/ko",
      "https://novel.example/ko/category/fantasy",
    ]);

    const en = await createSitemapFamilyBuilder(fixtureDb("en") as never)({ type: "mainpage", locale: "en" });
    expect(en[0]!.entries.map((entry) => entry.loc)).toEqual([
      "https://novel.example",
      "https://novel.example/category/fantasy",
    ]);

    // 21 books in the category -> 2 pages (BROWSE_PAGE_SIZE = 20).
    const many = fixtureDb("ko");
    many.article.findMany.mockResolvedValue(
      Array.from({ length: 21 }, (_, index) => candidate({
        id: `article-${index}`,
        locale: "ko",
        novel: { id: tagRow.novel_id, status: "published", deletedAt: null, coverUrl: "/covers/x.webp" },
      })),
    );
    many.$queryRaw.mockResolvedValue(
      Array.from({ length: 21 }, () => tagRow),
    );
    const paged = await createSitemapFamilyBuilder(many as never)({ type: "mainpage", locale: "ko" });
    expect(paged[0]!.entries.map((entry) => entry.loc)).toEqual([
      "https://novel.example/ko",
      "https://novel.example/ko/category/fantasy",
      "https://novel.example/ko/category/fantasy?page=2",
    ]);
  });
});
