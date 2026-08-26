import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * P0-S7a item 4: confirm sitemap generation shards correctly across
 * multiple locales, including a hyphenated one (`pt-BR`), and that a
 * locale's candidate query never bleeds into another locale's shard.
 *
 * `listPublishableLocales()` is mocked to a fixed three-locale set for this
 * file only — the real whitelist is empty today (D-7 open, see
 * `locale-canonical.ts`), which is already covered by
 * `static-sitemap.test.ts`'s "fails closed ... while D-7 keeps the
 * publishable locale list empty". This file verifies the sharding
 * *mechanism* is locale-parameterized and correct once locales are on the
 * whitelist, independent of when D-7 actually clears.
 */
vi.mock("@/lib/locale/locale-canonical", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/locale/locale-canonical")>();
  return {
    ...actual,
    listPublishableLocales: () => ["en", "fr", "pt-BR"],
  };
});

const { createSitemapFamilyBuilder, getSitemapFileName, parseSitemapFileName } = await import(
  "@/lib/seo/sitemap"
);
const { generateStaticSitemaps } = await import("@/lib/seo/static-sitemap-generator");
const { invalidateSiteSettingCache } = await import("@/server/site-settings/service");

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sitemap-multi-locale-"));
  temporaryRoots.push(root);
  return root;
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "article-1",
    locale: "en",
    slug: "visible-title",
    publicPageShortId: "abc123",
    title: "Visible title",
    status: "published",
    deletedAt: null,
    updatedAt: new Date("2026-08-05T12:30:00.000Z"),
    novel: { status: "published", deletedAt: null, coverUrl: "/covers/visible.webp" },
    promoLink: { status: "fetched", webUrl: "https://promo.example/book", appUrl: null, deletedAt: null },
    ...overrides,
  };
}

afterEach(async () => {
  delete process.env.SITE_URL;
  invalidateSiteSettingCache();
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("parseSitemapFileName · hyphenated locale codes", () => {
  it("round-trips a hyphenated locale (pt-BR) once it is on the whitelist", () => {
    const name = getSitemapFileName("novelpage", "pt-BR", 0);
    expect(name).toBe("site_novelpage_pt-BR.xml");
    expect(parseSitemapFileName(name)).toEqual({ type: "novelpage", locale: "pt-BR", index: 0 });
  });

  it("still rejects a locale that is registered but not on the whitelist", () => {
    // "ja" is registered in SITE_LOCALES (15-locale P0-S7a registry) but not
    // in this file's mocked 3-locale whitelist.
    expect(parseSitemapFileName("site_novelpage_ja.xml")).toBeNull();
  });
});

describe("createSitemapFamilyBuilder · per-locale isolation", () => {
  it("queries each locale independently — no cross-locale candidate bleed, no shared cache", async () => {
    process.env.SITE_URL = "https://novel.example";
    const findMany = vi.fn().mockImplementation(async ({ where }: { where: { AND: Array<Record<string, unknown>> } }) => {
      const locale = where.AND.find((clause) => "locale" in clause)?.locale;
      if (locale === "en") return [candidate({ id: "en-1", locale: "en", slug: "en-slug" })];
      if (locale === "fr") return [candidate({ id: "fr-1", locale: "fr", slug: "fr-slug", publicPageShortId: "fr1" })];
      return [];
    });
    const fixtureDb = {
      article: { findMany },
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
    const builder = createSitemapFamilyBuilder(fixtureDb as never);

    const en = await builder({ type: "novelpage", locale: "en" });
    const fr = await builder({ type: "novelpage", locale: "fr" });
    const ptBr = await builder({ type: "novelpage", locale: "pt-BR" });

    expect(en[0]!.entries).toHaveLength(1);
    expect(en[0]!.entries[0]!.loc).toContain("/novel/en-slug-pabc123");
    expect(fr[0]!.entries).toHaveLength(1);
    expect(fr[0]!.entries[0]!.loc).toContain("/novel/fr-slug-pfr1");
    expect(ptBr).toEqual([]); // empty candidate set produces zero shard files, not an empty-locale error

    // One DB call per distinct locale — the per-route cache keys on locale,
    // and repeating the same locale (mainpage + novelpage) must not re-query.
    expect(findMany).toHaveBeenCalledTimes(3);
    await builder({ type: "mainpage", locale: "en" });
    expect(findMany).toHaveBeenCalledTimes(3);

    expect(en[0]!.name).toBe("site_novelpage_en.xml");
    expect(fr[0]!.name).toBe("site_novelpage_fr.xml");
  });
});

describe("generateStaticSitemaps · multi-locale release", () => {
  it("produces one shard set per routeLocale and indexes every one of them", async () => {
    process.env.SITE_URL = "https://fixture.example";
    const root = await temporaryRoot();
    const buildFamily = vi.fn(async ({ type, locale }: { type: string; locale: string }) => [{
      name: getSitemapFileName(type as "mainpage" | "novelpage", locale as never, 0),
      url: `https://fixture.example/sitemap/site_${type}_${locale}.xml`,
      lastmod: "2026-08-01T00:00:00.000Z",
      entries: [{ loc: `https://fixture.example/novel/${locale}-fixture`, lastmod: "2026-08-01T00:00:00.000Z" }],
    }]);

    const result = await generateStaticSitemaps({
      buildFamily,
      rootDir: root,
      runId: "multi-locale-release",
      routeLocales: ["en", "fr", "pt-BR"],
      types: ["mainpage", "novelpage"],
    });

    expect(result.manifest.sitemapFiles.sort()).toEqual([
      "sitemap/site_mainpage_en.xml",
      "sitemap/site_mainpage_fr.xml",
      "sitemap/site_mainpage_pt-BR.xml",
      "sitemap/site_novelpage_en.xml",
      "sitemap/site_novelpage_fr.xml",
      "sitemap/site_novelpage_pt-BR.xml",
    ]);
    expect(result.fileCount).toBe(7); // 6 shards + the index itself
    expect(result.urlCount).toBe(6);

    const releaseDir = path.join(root, "releases", "multi-locale-release");
    const indexXml = await fs.readFile(path.join(releaseDir, "sitemap.xml"), "utf-8");
    for (const fileName of result.manifest.sitemapFiles) {
      expect(indexXml).toContain(fileName.replace("sitemap/", "/sitemap/"));
    }

    const frXml = await fs.readFile(path.join(releaseDir, "sitemap", "site_novelpage_fr.xml"), "utf-8");
    expect(frXml).toContain("https://fixture.example/novel/fr-fixture");
    expect(frXml).not.toContain("pt-BR-fixture");
    expect(frXml).not.toContain("en-fixture");
  });

  it("still fails closed when routeLocales resolves to an empty list", async () => {
    process.env.SITE_URL = "https://fixture.example";
    const root = await temporaryRoot();
    await expect(generateStaticSitemaps({
      buildFamily: vi.fn(),
      rootDir: root,
      runId: "empty-locales",
      routeLocales: [],
      types: ["mainpage"],
    })).rejects.toThrow("No sitemap child files were generated");
  });
});
