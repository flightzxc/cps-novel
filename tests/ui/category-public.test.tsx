import { describe, expect, it } from "vitest";

import { buildCategorySeoMeta } from "@/lib/seo/seo-templates/category";

// 2026-09-30：`CategorySeoData.hreflangLocales` 改为必填（分类页 hreflang 只列真有公开
// 内容的语种，见 `@/lib/site/category-locales`）。本文件的用例不是测 hreflang 的，
// 各处只补一个"只有当前语种"的最简值让类型通过；hreflang 行为的断言在
// `tests/ui/seo/category-hreflang.test.ts`。
describe("public category SEO · CPS v8.3.6 semantic port", () => {
  it("emits canonical/hreflang and CollectionPage + Breadcrumb JSON-LD", () => {
    process.env.SITE_URL = "https://novel.example";
    const seo = buildCategorySeoMeta({ name: "Fantasy", slug: "fantasy", description: "Fantasy novels", siteName: "Novel", defaultOgImage: "/og.jpg", hreflangLocales: ["en"] }, 1, "en");
    expect(seo.canonical).toBe("https://novel.example/category/fantasy");
    expect(seo.alternates.languages.en).toBe(seo.canonical);
    const jsonLd = JSON.parse(seo.other["application/ld+json"]);
    expect(jsonLd.map((entry: { "@type": string }) => entry["@type"])).toEqual(["CollectionPage", "BreadcrumbList"]);
    delete process.env.SITE_URL;
  });

  // PN-01（2026-10-07，Owner 确认"分页页允许收录，对齐 CPS"）：第 2 页起不再 noindex。
  // CPS v8.7.2 `category.ts:93` 的 `robots` 来自恒返回 undefined 的 `paginatedRobots`。
  // 旧断言 `{ index: false, follow: true }` 是误接 `shouldNoIndex`（CPS 废弃函数）的结果。
  it("canonicalizes page 2 to itself and keeps it indexable (no robots override)", () => {
    process.env.SITE_URL = "https://novel.example";
    const seo = buildCategorySeoMeta({ name: "Fantasy", slug: "fantasy", description: "Fantasy novels", siteName: "Novel", defaultOgImage: "/og.jpg", hreflangLocales: ["en"] }, 2, "en");
    expect(seo.canonical).toBe("https://novel.example/category/fantasy?page=2");
    expect(seo.robots).toBeUndefined();
    delete process.env.SITE_URL;
  });

  it("omits description when the category has no locale-specific copy — never `${name} novels.`", () => {
    process.env.SITE_URL = "https://novel.example";
    const seo = buildCategorySeoMeta({ name: "Fantasy", slug: "fantasy", siteName: "Novel", defaultOgImage: "/og.jpg", hreflangLocales: ["ko"] }, 1, "ko");
    expect(seo.description).toBe("");
    expect(JSON.stringify(seo)).not.toMatch(/novels\./);
    const jsonLd = JSON.parse(seo.other["application/ld+json"]);
    expect(jsonLd[0].description).toBeUndefined();
    delete process.env.SITE_URL;
  });
});
