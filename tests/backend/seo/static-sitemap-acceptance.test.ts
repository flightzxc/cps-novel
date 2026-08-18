import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { JSDOM } from "jsdom";
import { afterAll, describe, expect, it } from "vitest";

import { generateStaticSitemaps } from "@/lib/seo/static-sitemap-generator";
import {
  getSitemapFileName,
  type BuildSitemapFamily,
  type SitemapEntry,
  type SitemapFile,
} from "@/lib/seo/sitemap";

const REPORT_PATH = process.env.SITEMAP_ACCEPTANCE_REPORT;
const FIXED_LASTMODS = [
  "2026-08-01T00:00:00.000Z",
  "2026-08-02T00:00:00.000Z",
  "2026-08-03T00:00:00.000Z",
  "2026-08-04T00:00:00.000Z",
] as const;

let temporaryRoot: string | undefined;

function entry(index: number): SitemapEntry {
  return {
    loc: `https://fixture.example/novel-${index + 1}`,
    lastmod: FIXED_LASTMODS[index]!,
    changefreq: "weekly",
    priority: 0.9,
  };
}

function file(name: string, entries: SitemapEntry[]): SitemapFile {
  return {
    name,
    url: `https://fixture.example/sitemap/${name}`,
    lastmod: entries.at(-1)!.lastmod,
    entries,
  };
}

const fixtureBuilder: BuildSitemapFamily = async ({ type, locale }) => {
  if (type === "mainpage") {
    return [file(getSitemapFileName(type, locale, 0), [entry(0)])];
  }
  return [
    file(getSitemapFileName(type, locale, 0), [entry(1), entry(2)]),
    file(getSitemapFileName(type, locale, 1), [entry(3)]),
  ];
};

function assertValidXml(xml: string): void {
  const dom = new JSDOM(xml, { contentType: "application/xml" });
  expect(dom.window.document.documentElement).toBeTruthy();
}

afterAll(async () => {
  if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true });
});

describe("static sitemap deterministic acceptance", () => {
  it("injects fixture routeLocales and verifies the promoted release directly from disk", async () => {
    process.env.SITE_URL = "https://fixture.example";
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cps-novel-sitemap-"));
    const result = await generateStaticSitemaps({
      buildFamily: fixtureBuilder,
      rootDir: temporaryRoot,
      runId: "fixture-release",
      releaseDate: new Date("2026-08-01T00:00:00.000Z"),
      releasePid: 10,
      routeLocales: ["en"],
      types: ["mainpage", "novelpage"],
      initiatedBy: "acceptance",
      reason: "fixture",
      version: "p2-10",
    });

    expect(result.fileCount).toBe(4);
    expect(result.urlCount).toBe(4);
    expect(result.manifest.sitemapFiles).toEqual([
      "sitemap/site_mainpage_en.xml",
      "sitemap/site_novelpage_en.xml",
      "sitemap/site_novelpage_en_1.xml",
    ]);

    const currentPath = path.join(temporaryRoot, "current");
    expect(await fs.readlink(currentPath)).toBe("releases/fixture-release");
    const releaseDir = path.join(temporaryRoot, "releases", "fixture-release");
    const indexXml = await fs.readFile(path.join(releaseDir, "sitemap.xml"), "utf-8");
    assertValidXml(indexXml);

    let locCount = 0;
    for (const relativePath of result.manifest.sitemapFiles) {
      const xml = await fs.readFile(path.join(releaseDir, relativePath), "utf-8");
      assertValidXml(xml);
      locCount += Array.from(xml.matchAll(/<loc>/g)).length;
      for (const lastmod of Array.from(xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g))) {
        expect(lastmod[1]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      }
    }
    expect(locCount).toBe(4);
    for (const fileName of [
      "site_mainpage_en.xml",
      "site_novelpage_en.xml",
      "site_novelpage_en_1.xml",
    ]) {
      expect(indexXml).toContain(`/sitemap/${fileName}`);
    }

    if (REPORT_PATH) {
      await fs.writeFile(REPORT_PATH, JSON.stringify({ ok: true }), "utf-8");
    }
  });
});
