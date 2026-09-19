import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { SITE_LOCALES, TAG_LOCALE_LABELS, TAG_TRANSLATION_LOCALES } from "@/lib/locale/locale-canonical";
import { buildCategorySeoMeta } from "@/lib/seo/seo-templates/category";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("public CanonicalTag i18n path guards", () => {
  it("TAG_TRANSLATION_LOCALES is additive and labels cover every admin locale", () => {
    expect(TAG_TRANSLATION_LOCALES).toEqual([
      "en", "zh", "zh-CN", "zh-TW", "ja", "ko", "es", "fr", "de", "pt",
      "it", "ru", "ar", "th", "vi", "id", "ms", "tr", "pl", "nl",
      "pt-BR", "zh-Hant", "cs",
    ]);
    for (const locale of TAG_TRANSLATION_LOCALES) {
      expect(TAG_LOCALE_LABELS[locale], locale).toBeTruthy();
    }
    expect(SITE_LOCALES).toContain("pt-BR");
    expect(SITE_LOCALES).toContain("zh-Hant");
    expect(SITE_LOCALES).toContain("cs");
  });
  it("public-taxonomy and category-queries use requested → en → zh → slug and do not require tagging/service.ts", () => {
    const publicTaxonomy = readFileSync(join(REPO_ROOT, "src/lib/site/public-taxonomy.ts"), "utf8");
    const categoryQueries = readFileSync(join(REPO_ROOT, "src/lib/site/category-queries.ts"), "utf8");
    const taggingService = readFileSync(join(REPO_ROOT, "src/server/tagging/service.ts"), "utf8");

    expect(publicTaxonomy).toContain("resolveCanonicalTagLabel");
    expect(publicTaxonomy).toContain("en.canonical_tag_id = ct.id AND en.locale = 'en'");
    expect(publicTaxonomy).toContain("zh.canonical_tag_id = ct.id AND zh.locale = 'zh'");
    expect(publicTaxonomy).not.toMatch(/ct\.canonical_definition/);
    expect(categoryQueries).toContain("resolveCanonicalTagLabel");
    expect(categoryQueries).toContain('locale: { in: [locale, "en", "zh"] }');
    expect(categoryQueries).toMatch(/description:\s*null/);

    expect(taggingService).toContain("COALESCE(requested.display_name, zh.display_name, ct.slug)");
    expect(taggingService).not.toContain("en.locale = 'en'");
  });

  it("category SEO omits description instead of synthesizing English novels. copy", () => {
    process.env.SITE_URL = "https://novel.example";
    const seo = buildCategorySeoMeta({ name: "판타지", slug: "fantasy", siteName: "Novel", defaultOgImage: "/og.jpg" }, 1, "ko");
    expect(seo.description).toBe("");
    expect(seo.openGraph.description).toBeUndefined();
    expect(JSON.stringify(seo)).not.toMatch(/novels\./);
    expect(JSON.stringify(seo)).not.toContain("판타지 novels");
    const jsonLd = JSON.parse(seo.other!["application/ld+json"]);
    expect(jsonLd[0].name).toBe("판타지");
    expect(jsonLd[0].description).toBeUndefined();
    delete process.env.SITE_URL;
  });
});
