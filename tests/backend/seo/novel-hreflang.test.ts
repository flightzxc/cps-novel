import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `novel-hreflang.ts`'s per-(novelId, locale) filtered hreflang layer — the
 * "本单最关键项" (P0-S7a's most critical deliverable) regression net.
 *
 * `listPublishableLocales()` is mocked to a fixed two-locale set for this
 * file only, so the visibility-filtering behaviour can be exercised without
 * waiting on the real D-7 whitelist (which is empty today — see
 * `locale-canonical.ts`). The real, unmocked empty-whitelist fail-closed
 * path is covered separately in
 * `novel-hreflang-empty-whitelist.test.ts`, matching the split already
 * established by `sitemap-data.test.ts` (explicit locale) vs.
 * `static-sitemap.test.ts` ("fails closed ... while D-7 keeps the
 * publishable locale list empty").
 */
vi.mock("@/lib/locale/locale-canonical", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/locale/locale-canonical")>();
  return {
    ...actual,
    listPublishableLocales: () => ["en", "fr"],
  };
});

const {
  loadNovelHreflangSiblings,
  buildNovelHreflangAlternates,
  buildNovelHreflangAlternatesByPublishedArticles,
} = await import("@/lib/seo/novel-hreflang");

function row(overrides: Record<string, unknown> = {}) {
  return {
    locale: "fr",
    slug: "la-fille-du-gardien-du-phare",
    publicPageShortId: "def456",
    status: "published",
    deletedAt: null,
    novel: { status: "published", deletedAt: null },
    promoLink: { status: "fetched", webUrl: "https://upstream.example/fr", appUrl: null, deletedAt: null },
    ...overrides,
  };
}

function db(rows: ReturnType<typeof row>[]) {
  return { article: { findMany: vi.fn().mockResolvedValue(rows) } };
}

beforeEach(() => {
  process.env.SITE_URL = "https://novel.example";
});

afterEach(() => {
  delete process.env.SITE_URL;
});

describe("loadNovelHreflangSiblings", () => {
  it("queries by novelId, restricted to the publishable locale set", async () => {
    const fixtureDb = db([row()]);
    await loadNovelHreflangSiblings(fixtureDb as never, "novel-1");

    const query = fixtureDb.article.findMany.mock.calls[0]![0];
    expect(JSON.stringify(query.where)).toContain('"novelId":"novel-1"');
    expect(JSON.stringify(query.where)).toContain('"locale":{"in":["en","fr"]}');
  });

  it("returns only rows that pass the authoritative visibility predicate, never status alone", async () => {
    const fixtureDb = db([
      row(),
      row({ locale: "en", slug: "en-slug", publicPageShortId: "en1", status: "draft" }),
      row({ locale: "en", slug: "en-slug", publicPageShortId: "en2", novel: { status: "takedown", deletedAt: null } }),
      row({ locale: "en", slug: "en-slug", publicPageShortId: "en3", deletedAt: new Date() }),
      row({ locale: "en", slug: "en-slug", publicPageShortId: "en4", novel: { status: "published", deletedAt: new Date() } }),
      row({
        locale: "en",
        slug: "en-slug",
        publicPageShortId: "en5",
        promoLink: { status: "fetched", webUrl: "   ", appUrl: " ", deletedAt: null },
      }),
      row({
        locale: "en",
        slug: "en-slug",
        publicPageShortId: "en6",
        promoLink: { status: "fetched", webUrl: "https://upstream.example", appUrl: null, deletedAt: new Date() },
      }),
    ]);

    const siblings = await loadNovelHreflangSiblings(fixtureDb as never, "novel-1");
    expect(siblings).toEqual([
      { locale: "fr", slug: "la-fille-du-gardien-du-phare", publicPageShortId: "def456" },
    ]);
  });
});

describe("buildNovelHreflangAlternates", () => {
  it("builds one absolute URL per sibling via the caller-supplied path builder", () => {
    const alternates = buildNovelHreflangAlternates({
      siblings: [{ locale: "fr", slug: "la-fille-du-gardien-du-phare", publicPageShortId: "def456" }],
      currentLocale: "en",
      canonical: "https://novel.example/novel/lantern-keepers-daughter-pabc123",
      buildSiblingPath: (sibling) => `/${sibling.locale}/novel/${sibling.slug}-p${sibling.publicPageShortId}`,
    });

    expect(alternates).toEqual({
      en: "https://novel.example/novel/lantern-keepers-daughter-pabc123",
      fr: "https://novel.example/fr/novel/la-fille-du-gardien-du-phare-pdef456",
      "x-default": "https://novel.example/novel/lantern-keepers-daughter-pabc123",
    });
  });

  it("always self-references the current locale even with zero siblings — never omitted for being unwhitelisted", () => {
    const alternates = buildNovelHreflangAlternates({
      siblings: [],
      currentLocale: "en",
      canonical: "https://novel.example/novel/lantern-keepers-daughter-pabc123",
      buildSiblingPath: () => { throw new Error("must not be called with zero siblings"); },
    });

    expect(alternates).toEqual({
      en: "https://novel.example/novel/lantern-keepers-daughter-pabc123",
      "x-default": "https://novel.example/novel/lantern-keepers-daughter-pabc123",
    });
  });

  it("x-default falls back to the current canonical when the default locale (en) has no sibling of its own", () => {
    const alternates = buildNovelHreflangAlternates({
      siblings: [{ locale: "fr", slug: "livre", publicPageShortId: "x1" }],
      currentLocale: "fr",
      canonical: "https://novel.example/fr/novel/livre-px1",
      buildSiblingPath: (sibling) => `/${sibling.locale}/novel/${sibling.slug}-p${sibling.publicPageShortId}`,
    });

    // currentLocale=fr overwrites the sibling-derived fr entry with the
    // exact canonical being rendered (self-reference wins over recomputing
    // its own URL from sibling data), and x-default has no `en` key to
    // prefer, so it falls back to that same canonical.
    expect(alternates).toEqual({
      fr: "https://novel.example/fr/novel/livre-px1",
      "x-default": "https://novel.example/fr/novel/livre-px1",
    });
  });
});

describe("buildNovelHreflangAlternatesByPublishedArticles", () => {
  it("combines the DB read and the pure builder", async () => {
    const fixtureDb = db([row()]);
    const alternates = await buildNovelHreflangAlternatesByPublishedArticles(fixtureDb as never, {
      novelId: "novel-1",
      currentLocale: "en",
      canonical: "https://novel.example/novel/lantern-keepers-daughter-pabc123",
      buildSiblingPath: (sibling) => `/${sibling.locale}/novel/${sibling.slug}-p${sibling.publicPageShortId}`,
    });

    expect(alternates).toEqual({
      en: "https://novel.example/novel/lantern-keepers-daughter-pabc123",
      fr: "https://novel.example/fr/novel/la-fille-du-gardien-du-phare-pdef456",
      "x-default": "https://novel.example/novel/lantern-keepers-daughter-pabc123",
    });
  });
});
