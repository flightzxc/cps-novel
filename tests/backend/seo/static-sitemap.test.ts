import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GET as getSitemapIndex } from "@/app/sitemap.xml/route";
import { GET as getSitemapChild } from "@/app/sitemap/[fileName]/route";
import { buildRobots } from "@/app/robots";
import {
  acquireSitemapGenerationLock,
  readSitemapRefreshState,
  refreshStaticSitemap,
  summarizeSitemapError,
} from "@/lib/seo/sitemap-refresh-state";
import { getSiteUrl, SiteUrlConfigurationError } from "@/lib/seo/site-url";
import { listPublishableLocales } from "@/lib/locale/locale-canonical";
import { readStaticSitemapFile } from "@/lib/seo/static-sitemap-cache";
import { generateStaticSitemaps } from "@/lib/seo/static-sitemap-generator";
import type { BuildSitemapFamily } from "@/lib/seo/sitemap";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sitemap-unit-"));
  temporaryRoots.push(root);
  return root;
}

function builder(loc = "https://fixture.example/novel/one"): BuildSitemapFamily {
  return async ({ type, locale }) => [{
    name: `site_${type}_${locale}.xml`,
    url: `https://fixture.example/sitemap/site_${type}_${locale}.xml`,
    lastmod: "2026-08-01T00:00:00.000Z",
    entries: [{ loc, lastmod: "2026-08-01T00:00:00.000Z" }],
  }];
}

afterEach(async () => {
  delete process.env.SITEMAP_STATIC_DIR;
  delete process.env.SITE_URL;
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("SITE_URL", () => {
  it("normalizes a configured origin", () => {
    expect(getSiteUrl({ SITE_URL: " https://novel.example/ " })).toBe("https://novel.example");
  });

  it("fails closed for missing or non-origin values", () => {
    expect(() => getSiteUrl({})).toThrow(SiteUrlConfigurationError);
    expect(() => getSiteUrl({ SITE_URL: "https://novel.example/path" })).toThrow(SiteUrlConfigurationError);
    expect(() => getSiteUrl({ SITE_URL: "ftp://novel.example" })).toThrow(SiteUrlConfigurationError);
  });

  it("builds robots directives from the configured origin", () => {
    process.env.SITE_URL = "https://novel.example/";
    expect(buildRobots()).toEqual({
      rules: [{
        userAgent: "*",
        allow: "/",
        disallow: [
          "/api/admin",
          "/channel-accounts",
          "/novels",
          "/tags",
          "/tasks",
          "/settings",
          "/dev-preview",
          "/go",
        ],
      }],
      sitemap: "https://novel.example/sitemap.xml",
    });
    delete process.env.SITE_URL;
    expect(() => buildRobots()).toThrow(SiteUrlConfigurationError);
  });
});

describe("static sitemap cache and routes", () => {
  it("rejects traversal and returns null for a missing file", async () => {
    process.env.SITEMAP_STATIC_DIR = await temporaryRoot();
    expect(await readStaticSitemapFile("../secret")).toBeNull();
    expect(await readStaticSitemapFile("/absolute.xml")).toBeNull();
    expect(await readStaticSitemapFile("missing.xml")).toBeNull();
  });

  it("returns 503 instead of dynamically generating a missing index", async () => {
    process.env.SITEMAP_STATIC_DIR = await temporaryRoot();
    const response = await getSitemapIndex();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("Static sitemap is unavailable");
  });

  it("serves an existing index directly from the current release", async () => {
    const root = await temporaryRoot();
    process.env.SITEMAP_STATIC_DIR = root;
    await fs.mkdir(path.join(root, "releases", "ready"), { recursive: true });
    await fs.writeFile(path.join(root, "releases", "ready", "sitemap.xml"), "<sitemapindex/>", "utf8");
    await fs.symlink("releases/ready", path.join(root, "current"));

    const response = await getSitemapIndex();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-sitemap-source")).toBe("static");
    expect(await response.text()).toBe("<sitemapindex/>");
  });

  it("returns 404 for an invalid child filename before touching disk", async () => {
    process.env.SITEMAP_STATIC_DIR = await temporaryRoot();
    const response = await getSitemapChild(new Request("https://fixture.example/sitemap/nope.xml"), {
      params: Promise.resolve({ fileName: "nope.xml" }),
    });
    expect(response.status).toBe(404);
  });
});

describe("static sitemap generation and refresh state", () => {
  it("fails closed through the refresh chain while D-7 keeps the publishable locale list empty", async () => {
    process.env.SITE_URL = "https://fixture.example";
    const root = await temporaryRoot();
    const buildFamily = vi.fn(builder());

    expect(listPublishableLocales()).toEqual([]);
    const result = await refreshStaticSitemap({
      buildFamily,
      rootDir: root,
      runId: "d7-open",
      initiatedBy: "test",
      reason: "empty production locale whitelist",
    });

    expect(result.status).toBe("failed");
    expect(result.state.task.errorSummary).toContain("No sitemap child files were generated");
    expect(buildFamily).not.toHaveBeenCalled();
    expect(result.state.current).toEqual({ kind: "missing" });
    await expect(fs.lstat(path.join(root, "sitemap-generation.lock")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("promotes a release atomically and replaces an existing symlink", async () => {
    process.env.SITE_URL = "https://fixture.example";
    const root = await temporaryRoot();
    await generateStaticSitemaps({
      buildFamily: builder(),
      rootDir: root,
      runId: "first",
      routeLocales: ["en"],
      types: ["mainpage"],
    });
    await generateStaticSitemaps({
      buildFamily: builder("https://fixture.example/novel/two"),
      rootDir: root,
      runId: "second",
      routeLocales: ["en"],
      types: ["mainpage"],
    });
    expect(await fs.readlink(path.join(root, "current"))).toBe("releases/second");
  });

  it("refuses to replace a real current directory", async () => {
    process.env.SITE_URL = "https://fixture.example";
    const root = await temporaryRoot();
    await fs.mkdir(path.join(root, "current"), { recursive: true });
    await expect(generateStaticSitemaps({
      buildFamily: builder(),
      rootDir: root,
      runId: "blocked",
      routeLocales: ["en"],
      types: ["mainpage"],
    })).rejects.toThrow("current is a real directory");
  });

  it("rejects placeholder URLs before promotion", async () => {
    process.env.SITE_URL = "https://fixture.example";
    const root = await temporaryRoot();
    await expect(generateStaticSitemaps({
      buildFamily: builder("https://undefined/novel"),
      rootDir: root,
      runId: "invalid",
      routeLocales: ["en"],
      types: ["mainpage"],
    })).rejects.toThrow("invalid placeholder URL");
    await expect(fs.lstat(path.join(root, "current"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("coalesces a competing lock and exposes running state", async () => {
    const root = await temporaryRoot();
    const first = await acquireSitemapGenerationLock({
      rootDir: root,
      runId: "one",
      initiatedBy: "test",
    });
    expect(first.acquired).toBe(true);
    const second = await acquireSitemapGenerationLock({
      rootDir: root,
      runId: "two",
      initiatedBy: "test",
    });
    expect(second.acquired).toBe(false);
    expect((await readSitemapRefreshState(root)).task).toMatchObject({ status: "running", runId: "one" });
  });

  it("records failure, releases its lock, and preserves the old current release", async () => {
    process.env.SITE_URL = "https://fixture.example";
    const root = await temporaryRoot();
    await generateStaticSitemaps({
      buildFamily: builder(),
      rootDir: root,
      runId: "known-good",
      routeLocales: ["en"],
      types: ["mainpage"],
    });
    const result = await refreshStaticSitemap({
      buildFamily: builder(),
      rootDir: root,
      runId: "failed-run",
      initiatedBy: "test",
      generate: async () => { throw new Error("TOKEN=secret-value generation failed"); },
    });
    expect(result.status).toBe("failed");
    expect(result.state.task.errorSummary).toContain("TOKEN=[redacted]");
    expect(await fs.readlink(path.join(root, "current"))).toBe("releases/known-good");
    await expect(fs.lstat(path.join(root, "sitemap-generation.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("redacts sensitive values and truncates persisted errors", () => {
    const summary = summarizeSitemapError(`AUTH_TOKEN=visible ${"x".repeat(900)}`);
    expect(summary).not.toContain("visible");
    expect(summary.length).toBeLessThanOrEqual(800);
  });
});
