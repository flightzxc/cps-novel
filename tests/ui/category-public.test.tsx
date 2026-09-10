import { describe, expect, it } from "vitest";

import { buildCategorySeoMeta } from "@/lib/seo/seo-templates/category";

describe("public category SEO · CPS v8.3.6 semantic port", () => {
  it("emits canonical/hreflang and CollectionPage + Breadcrumb JSON-LD", () => {
    process.env.SITE_URL = "https://novel.example";
    const seo = buildCategorySeoMeta({ name: "Fantasy", slug: "fantasy", description: "Fantasy novels", siteName: "Novel", defaultOgImage: "/og.jpg" }, 1, "en");
    expect(seo.canonical).toBe("https://novel.example/category/fantasy");
    expect(seo.alternates.languages.en).toBe(seo.canonical);
    const jsonLd = JSON.parse(seo.other["application/ld+json"]);
    expect(jsonLd.map((entry: { "@type": string }) => entry["@type"])).toEqual(["CollectionPage", "BreadcrumbList"]);
    delete process.env.SITE_URL;
  });

  it("canonicalizes and noindexes page 2 while keeping follow", () => {
    process.env.SITE_URL = "https://novel.example";
    const seo = buildCategorySeoMeta({ name: "Fantasy", slug: "fantasy", description: "Fantasy novels", siteName: "Novel", defaultOgImage: "/og.jpg" }, 2, "en");
    expect(seo.canonical).toBe("https://novel.example/category/fantasy?page=2");
    expect(seo.robots).toEqual({ index: false, follow: true });
    delete process.env.SITE_URL;
  });
});
