import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildHreflangAlternates,
  canonicalUrl,
  generateBreadcrumbJsonLd,
  generateCreativeWorkJsonLd,
  generateItemListJsonLd,
  generateWebSiteJsonLd,
  shouldNoIndex,
} from "@/lib/seo/seo-utils";

const ORIGIN = "https://example.test";

describe("seo-utils", () => {
  const previousSiteUrl = process.env.SITE_URL;
  const previousPublic = process.env.NEXT_PUBLIC_SITE_URL;

  beforeEach(() => {
    process.env.SITE_URL = ORIGIN;
    delete process.env.NEXT_PUBLIC_SITE_URL;
  });

  afterEach(() => {
    if (previousSiteUrl === undefined) delete process.env.SITE_URL;
    else process.env.SITE_URL = previousSiteUrl;
    if (previousPublic === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = previousPublic;
  });

  it("builds WebSite JSON-LD from the configured origin", () => {
    expect(generateWebSiteJsonLd("cps-novel", "Overseas novels")).toEqual({
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "cps-novel",
      url: ORIGIN,
      description: "Overseas novels",
    });
  });

  it("builds Book JSON-LD without /drama/ paths", () => {
    const jsonLd = generateCreativeWorkJsonLd({
      name: "Lantern",
      description: "A story.",
      url: "/novel/lantern-pabc",
      genres: ["Romance"],
      chapterCount: 12,
      coverUrl: "/covers/lantern.jpg",
      publishTime: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(JSON.stringify(jsonLd)).not.toContain("/drama/");
    expect(JSON.stringify(jsonLd)).not.toContain("PulseDrama");
    expect(jsonLd).toMatchObject({
      "@type": "Book",
      name: "Lantern",
      url: `${ORIGIN}/novel/lantern-pabc`,
      genre: ["Romance"],
      numberOfChapters: 12,
    });
  });

  it("builds breadcrumb and item-list JSON-LD", () => {
    expect(
      generateBreadcrumbJsonLd([
        { name: "Home", href: "/" },
        { name: "Lantern", href: "/novel/lantern-pabc" },
      ]),
    ).toMatchObject({
      "@type": "BreadcrumbList",
      itemListElement: [
        { position: 1, name: "Home", item: `${ORIGIN}/` },
        { position: 2, name: "Lantern", item: `${ORIGIN}/novel/lantern-pabc` },
      ],
    });

    expect(
      generateItemListJsonLd("All works", [
        { name: "Lantern", url: "/novel/lantern-pabc", position: 1 },
      ]),
    ).toMatchObject({
      "@type": "ItemList",
      numberOfItems: 1,
      itemListElement: [{ position: 1, name: "Lantern", url: `${ORIGIN}/novel/lantern-pabc` }],
    });
  });

  it("builds same-path locale alternates, not cross-Novel siblings", () => {
    expect(canonicalUrl("/novel/lantern-pabc")).toBe(`${ORIGIN}/novel/lantern-pabc`);
    expect(buildHreflangAlternates("/novel/lantern-pabc")).toEqual({
      "x-default": `${ORIGIN}/novel/lantern-pabc`,
      en: `${ORIGIN}/novel/lantern-pabc`,
    });
  });

  it("marks page >= 2 as noindex", () => {
    expect(shouldNoIndex(1)).toBe(false);
    expect(shouldNoIndex(2)).toBe(true);
  });
});
