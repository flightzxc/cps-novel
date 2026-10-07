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
        hreflangAlternates: {
          "x-default": `${ORIGIN}/novel/lantern-keepers-daughter-pabc123`,
          en: `${ORIGIN}/novel/lantern-keepers-daughter-pabc123`,
        },
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

  // TKD 对齐 CPS（Owner 2026-09-30，复核 A1）：模板 SEO 标题改成自然语言后，`title` 不再等于书名。
  // <title>/og/twitter 用 `title`；Book JSON-LD 的 name、面包屑第 2 级、og:image alt 只用干净书名 `name`
  // （CPS 剧集详情页同样把两者分开）。
  describe("novel: `name` keeps JSON-LD on the clean book title when `title` is a natural-language SEO title", () => {
    const seoTitle = "Lost Kingdom Novel - Read Free Chapters Online";
    const build = (extra: { name?: string } = {}) =>
      generateSeoMeta({
        entity: "novel",
        data: {
          title: seoTitle,
          ...extra,
          description: "A kingdom lost beyond the sea.",
          canonicalPath: "/novel/lost-kingdom-pabc123",
          coverUrl: "/covers/lost.jpg",
          siteName: "PulseNovel",
          hreflangAlternates: { "x-default": `${ORIGIN}/novel/lost-kingdom-pabc123` },
        },
      });
    const ld = (seo: ReturnType<typeof build>) =>
      JSON.parse(seo.other!["application/ld+json"]) as Array<Record<string, unknown> & { itemListElement?: Array<{ position: number; name: string }> }>;

    it("with name: title/og/twitter carry the SEO title; Book.name, breadcrumb level 2 and og image alt are the clean title", () => {
      const seo = build({ name: "Lost Kingdom" });
      expect(seo.title).toBe(seoTitle);
      expect(seo.openGraph.title).toBe(seoTitle);
      expect(seo.twitter.title).toBe(seoTitle);
      const [book, breadcrumb] = ld(seo);
      expect(book).toMatchObject({ "@type": "Book", name: "Lost Kingdom" });
      expect(breadcrumb!.itemListElement!.find((item) => item.position === 2)!.name).toBe("Lost Kingdom");
      expect(seo.openGraph.images[0]!.alt).toBe("Lost Kingdom");
      expect(JSON.stringify(ld(seo))).not.toContain("Read Free Chapters Online");
    });

    it("without name: falls back to title (previous behavior, byte-identical for existing callers)", () => {
      const seo = build();
      const [book, breadcrumb] = ld(seo);
      expect(book).toMatchObject({ name: seoTitle });
      expect(breadcrumb!.itemListElement!.find((item) => item.position === 2)!.name).toBe(seoTitle);
    });
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

  /**
   * D5：章节页此前借用 `entity: "novel"` 的两级 BreadcrumbList（首页/当前页），
   * 缺了小说页这一级。`entity: "chapter"`（`buildChapterSeoMeta`）补上第三级
   * ——首页(1) → 小说页(2) → 章节页(3)，小说页自己保持两级（上面
   * "builds novel metadata" 那条用例已经覆盖，不受影响）。
   *
   * 新增用例（交接文档"测试与门禁"一节要求）。变异③：把这里的第 2 级删掉
   * 必须让这条用例变红，证明它真的在守三级结构，不是摆设。
   */
  it("builds chapter metadata with a 3-level BreadcrumbList (home → novel → chapter)", () => {
    const seo = generateSeoMeta({
      entity: "chapter",
      data: {
        title: "The Harbour · The Lantern Keeper's Daughter",
        description: "The tide came in early that year.",
        canonicalPath: "/novel/lantern-keepers-daughter-pabc123/chapter/1",
        novelTitle: "The Lantern Keeper's Daughter",
        novelCanonicalPath: "/novel/lantern-keepers-daughter-pabc123",
        coverUrl: "/covers/lantern.jpg",
        siteName: "cps-novel",
        hreflangAlternates: {
          "x-default": `${ORIGIN}/novel/lantern-keepers-daughter-pabc123/chapter/1`,
          en: `${ORIGIN}/novel/lantern-keepers-daughter-pabc123/chapter/1`,
        },
      },
    });

    const jsonLd = JSON.parse(seo.other!["application/ld+json"]) as unknown[];
    const breadcrumb = jsonLd.find(
      (node): node is { itemListElement: unknown[] } =>
        typeof node === "object" && node !== null && (node as { "@type"?: string })["@type"] === "BreadcrumbList",
    );
    expect(breadcrumb).toBeTruthy();
    expect(breadcrumb!.itemListElement).toEqual([
      { "@type": "ListItem", position: 1, name: "Home", item: `${ORIGIN}/` },
      {
        "@type": "ListItem",
        position: 2,
        name: "The Lantern Keeper's Daughter",
        item: `${ORIGIN}/novel/lantern-keepers-daughter-pabc123`,
      },
      {
        "@type": "ListItem",
        position: 3,
        name: "The Harbour · The Lantern Keeper's Daughter",
        item: `${ORIGIN}/novel/lantern-keepers-daughter-pabc123/chapter/1`,
      },
    ]);
    // 所有 item 都是通过 getSiteUrl/toAbsoluteUrl 生成的绝对地址。
    for (const entry of breadcrumb!.itemListElement as { item: string }[]) {
      expect(entry.item.startsWith(ORIGIN)).toBe(true);
    }
  });

  // PN-01（2026-10-07，Owner 确认"分页页允许收录，对齐 CPS"）：第 2 页起不再 noindex。
  // 旧断言 `{ index: false, follow: true }` 是误接 `shouldNoIndex`（CPS 废弃函数）的结果。
  it("keeps collection page 2 indexable (no robots override) with a self canonical", () => {
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
    expect(seo.robots).toBeUndefined();
    expect(seo.canonical).toBe(`${ORIGIN}/browse?page=2`);
  });
});
