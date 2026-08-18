import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateSeoMeta, normalizeMetadataTitle } from "@/lib/seo/seo-meta-generator";

const ORIGIN = "https://example.test";

describe("generateSeoMeta", () => {
  const previousSiteUrl = process.env.SITE_URL;

  beforeEach(() => {
    process.env.SITE_URL = ORIGIN;
  });

  afterEach(() => {
    if (previousSiteUrl === undefined) delete process.env.SITE_URL;
    else process.env.SITE_URL = previousSiteUrl;
  });

  it("strips a trailing site-name suffix from titles", () => {
    expect(normalizeMetadataTitle("Lantern | cps-novel", "cps-novel")).toBe("Lantern");
  });

  it("builds novel metadata without PulseDrama, /drama/, or cross-Novel hreflang siblings", () => {
    const seo = generateSeoMeta({
      entity: "novel",
      data: {
        title: "The Lantern Keeper's Daughter",
        description: "A coastal town keeps one lantern burning.",
        canonicalPath: "/novel/lantern-keepers-daughter-pabc123",
        coverUrl: "/covers/lantern.jpg",
        genres: ["Romance"],
        chapterCount: 12,
        publishTime: new Date("2026-01-01T00:00:00.000Z"),
        siteName: "cps-novel",
      },
    });

    expect(seo).toMatchSnapshot();
    expect(JSON.stringify(seo)).not.toContain("PulseDrama");
    expect(JSON.stringify(seo)).not.toContain("/drama/");
    expect(JSON.stringify(seo)).not.toContain("TVSeries");
    expect(JSON.stringify(seo)).not.toContain("VideoObject");
    expect(seo.alternates.languages).toEqual({
      "x-default": `${ORIGIN}/novel/lantern-keepers-daughter-pabc123`,
      en: `${ORIGIN}/novel/lantern-keepers-daughter-pabc123`,
    });
    expect(seo.canonical).toBe(`${ORIGIN}/novel/lantern-keepers-daughter-pabc123`);
    expect(JSON.parse(seo.other!["application/ld+json"])).toEqual(
      expect.arrayContaining([expect.objectContaining({ "@type": "Book" })]),
    );
  });

  it("builds home metadata", () => {
    const seo = generateSeoMeta({
      entity: "home",
      data: {
        siteName: "cps-novel",
        description: "Read overseas novels.",
        defaultOgImage: "/og.png",
      },
    });
    expect(seo.canonical).toBe(`${ORIGIN}/`);
    expect(seo.openGraph.type).toBe("website");
  });

  it("noindexes collection page 2", () => {
    const seo = generateSeoMeta({
      entity: "collection",
      pageNumber: 2,
      data: {
        title: "All works",
        description: "Published novels.",
        canonicalPath: "/browse",
        items: [{ name: "Lantern", url: "/novel/lantern-pabc" }],
        siteName: "cps-novel",
        defaultOgImage: "/og.png",
      },
    });
    expect(seo.robots).toEqual({ index: false, follow: true });
    expect(seo.canonical).toBe(`${ORIGIN}/browse?page=2`);
  });
});
