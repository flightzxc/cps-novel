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
 * 也没有出现在索引里。（`mainpage` 每个已登记语种恒有一个分片，里面只有首页——首页
 * 在每个语种都返回 200，不是空分片，不在此列。）
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

describe("static sitemap index never lists an empty locale's novelpage/categorypage shard", () => {
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
          updatedAt: new Date("2026-08-04T00:00:00.000Z"),
        }),
      },
    };

    const result = await generateStaticSitemaps({
      buildFamily: createSitemapFamilyBuilder(fixtureDb as never, { ...process.env, FEATURE_ARTICLE_BLOG: "false" }),
      rootDir: root,
      runId: "empty-locale-not-indexed",
      types: ["mainpage", "novelpage", "categorypage"],
    });

    const listed = result.manifest.sitemapFiles;
    expect(listed).toContain("sitemap/site_novelpage_ko.xml");
    expect(listed.filter((name) => name.includes("site_novelpage_"))).toEqual(["sitemap/site_novelpage_ko.xml"]);
    // No category has any public membership in this fixture -> no categorypage shard anywhere.
    expect(listed.filter((name) => name.includes("site_categorypage_"))).toEqual([]);

    const releaseDir = path.join(root, "releases", "empty-locale-not-indexed");
    const indexXml = await fs.readFile(path.join(releaseDir, "sitemap.xml"), "utf-8");
    expect(indexXml).toContain("/sitemap/site_novelpage_ko.xml");
    expect(indexXml).not.toContain("site_novelpage_en.xml");
    await expect(fs.stat(path.join(releaseDir, "sitemap", "site_novelpage_en.xml"))).rejects.toMatchObject({ code: "ENOENT" });

    // Home exists (HTTP 200) in every registered locale, so mainpage shards are the one family listed for all of them.
    expect(listed.filter((name) => name.includes("site_mainpage_"))).toHaveLength(15);
  });
});

/**
 * 同一轮核查里顺带发现的第二个问题：categorypage 分片的 URL 漏了语种前缀。
 * 生产实测（只读）`site_categorypage_ko.xml` 里是
 * `https://…/category/female-audience`（无 `/ko`），该地址 404
 * （en 没有这个分类），真正的页面是 `/ko/category/female-audience`（200）。
 * 修复后分片内 URL 与该分片所属语种一致。
 */
describe("categorypage shard URLs carry the shard's own locale prefix", () => {
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
      $queryRaw: vi.fn().mockResolvedValue([tagRow]),
    };
  }

  it("ko shard lists /ko/category/{slug}; en shard stays bare; page 2+ keeps the prefix too", async () => {
    process.env.SITE_URL = "https://novel.example";
    const ko = await createSitemapFamilyBuilder(fixtureDb("ko") as never)({ type: "categorypage", locale: "ko" });
    expect(ko[0]!.entries.map((entry) => entry.loc)).toEqual(["https://novel.example/ko/category/fantasy"]);

    const en = await createSitemapFamilyBuilder(fixtureDb("en") as never)({ type: "categorypage", locale: "en" });
    expect(en[0]!.entries.map((entry) => entry.loc)).toEqual(["https://novel.example/category/fantasy"]);

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
    const paged = await createSitemapFamilyBuilder(many as never)({ type: "categorypage", locale: "ko" });
    expect(paged[0]!.entries.map((entry) => entry.loc)).toEqual([
      "https://novel.example/ko/category/fantasy",
      "https://novel.example/ko/category/fantasy?page=2",
    ]);
  });
});
