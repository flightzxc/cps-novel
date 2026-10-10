import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  INDEXNOW_BACKFILL_SUPPORTED_SCHEMA_VERSIONS,
  computeCutoverStats,
  computeManifestSha256,
  verifyManifestSha256,
  type IndexNowBackfillManifest,
} from "@/lib/indexnow/backfill-manifest";
import { enqueueIndexNowFirstPublish } from "@/lib/indexnow/outbox";

import {
  MANIFEST_USAGE,
  buildBackfillManifest,
  parseArticleIdsArg,
  parseManifestArgs,
  selectBackfillCandidates,
  writeManifestFile,
} from "../../../scripts/indexnow-backfill-manifest";
import { FakeIndexNowDb, installTestSiteUrl } from "./fake-db";
import { ENABLED_ALL_ENV, LOCALE_OK } from "./helpers";

installTestSiteUrl();

const U1 = "0b1c2d3e-0000-4000-8000-000000000001";
const U2 = "0b1c2d3e-0000-4000-8000-000000000002";

const CANDIDATES = [
  { articleId: "article-1", novelId: "novel-1", locale: "en", canonicalUrl: "https://x.example/novel/a-p1", publishedAt: new Date("2026-10-01T00:00:00.000Z") },
  { articleId: "article-2", novelId: "novel-2", locale: "es", canonicalUrl: "https://x.example/es/novel/b-p2", publishedAt: null },
];

describe("buildBackfillManifest (schema v2)", () => {
  it("produces a self-consistent, verifiable v2 manifest with cutover_at and per-entry published_at", () => {
    const manifest = buildBackfillManifest(CANDIDATES, {
      releaseCommit: "abc1234",
      expectedCount: CANDIDATES.length,
      note: "test",
      now: new Date("2026-01-01T00:00:00.000Z"),
      cutoverAt: new Date("2026-10-07T10:39:15Z"),
    });
    expect(manifest.schema_version).toBe(2);
    expect(manifest.cutover_at).toBe("2026-10-07T10:39:15.000Z");
    expect(manifest.count).toBe(2);
    expect(manifest.entries.map((entry) => entry.published_at)).toEqual(["2026-10-01T00:00:00.000Z", null]);
    expect(manifest.entries[0]!.novel_id).toBe("novel-1");
    expect(verifyManifestSha256(manifest)).toBe(true);
  });

  it("without a cutover the field is null; the hash still covers it", () => {
    const manifest = buildBackfillManifest(CANDIDATES, { releaseCommit: "c", expectedCount: 2, note: "" });
    expect(manifest.cutover_at).toBeNull();
    const tampered: IndexNowBackfillManifest = { ...manifest, cutover_at: "2026-10-07T10:39:15.000Z" };
    expect(verifyManifestSha256(tampered)).toBe(false);
  });

  it("a v1 manifest (no cutover_at / published_at) still verifies, and v1 and v2 are both supported", () => {
    const v1Base = {
      schema_version: 1 as const,
      generated_at: "2026-01-01T00:00:00.000Z",
      release_commit: "c",
      expected_count: 1,
      count: 1,
      note: "old",
      entries: [
        {
          article_id: "a",
          novel_id: "n",
          locale: "en",
          canonical_url: "https://x.example/novel/a-p1",
          created_at: "2026-01-01T00:00:00.000Z",
          release_window: "2026-01-01",
          eligibility_result: "eligible" as const,
        },
      ],
    };
    const v1: IndexNowBackfillManifest = { ...v1Base, content_sha256: computeManifestSha256(v1Base) };
    expect(verifyManifestSha256(v1)).toBe(true);
    expect(INDEXNOW_BACKFILL_SUPPORTED_SCHEMA_VERSIONS).toEqual([1, 2]);
  });
});

describe("manifest SHA-256 integrity — the backfill's gate 1", () => {
  it("detects any tamper with the entries after the hash was computed", () => {
    const manifest = buildBackfillManifest(CANDIDATES, { releaseCommit: "c", expectedCount: 2, note: "" });
    const tampered: IndexNowBackfillManifest = { ...manifest, entries: [...manifest.entries, { ...manifest.entries[0]!, article_id: "injected" }] };
    expect(verifyManifestSha256(tampered)).toBe(false);
  });

  it("detects a tampered expected_count without touching entries", () => {
    const manifest = buildBackfillManifest(CANDIDATES, { releaseCommit: "c", expectedCount: 2, note: "" });
    expect(verifyManifestSha256({ ...manifest, expected_count: 999 })).toBe(false);
  });

  it("computeManifestSha256 excludes the content_sha256 field itself from the hashed payload", () => {
    const manifest = buildBackfillManifest(CANDIDATES, { releaseCommit: "c", expectedCount: 2, note: "" });
    expect(computeManifestSha256({ ...manifest, content_sha256: "0".repeat(64) })).toBe(manifest.content_sha256);
  });
});

describe("[16] parseArticleIdsArg — CPS 7e57779 strict validation, UUID edition", () => {
  const parse = (...rest: string[]) => parseArticleIdsArg(["--article-ids", ...rest]);

  it("absent → undefined; a good list is returned lowercased, in order", () => {
    expect(parseArticleIdsArg([])).toBeUndefined();
    expect(parse(`${U1.toUpperCase()},${U2}`)).toEqual([U1, U2]);
    expect(parse(` ${U1} , ${U2} `)).toEqual([U1, U2]);
  });

  it.each([
    ["a duplicate", [`${U1},${U2},${U1}`], /duplicate/],
    ["a duplicate that differs only by case", [`${U1},${U1.toUpperCase()}`], /duplicate/],
    ["an empty item in the middle", [`${U1},,${U2}`], /empty item/],
    ["a trailing comma", [`${U1},`], /empty item/],
    ["an empty value", [""], /empty item/],
    ["a non-UUID item", [`${U1},12345`], /invalid UUID: 12345/],
    ["an integer id (CPS-style)", ["42"], /invalid UUID/],
    ["a missing value", [], /requires a value/],
    ["a value that is another flag", ["--output"], /requires a value/],
  ])("rejects %s", (_label, rest, pattern) => {
    expect(() => parse(...rest)).toThrow(pattern);
  });

  it("rejects the flag appearing twice", () => {
    expect(() => parseArticleIdsArg(["--article-ids", U1, "--article-ids", U2])).toThrow("at most once");
  });
});

describe("[15] parseManifestArgs — expected count is mandatory", () => {
  it("--expected-count is required except for --count-only/--help; the error says the script never hard-codes a count", () => {
    expect(() => parseManifestArgs(["--output", "x.json"])).toThrow(/--expected-count <non-negative integer> is required; the script never hard-codes/);
    for (const bad of ["-1", "1.5", "abc", "1e3", "0x10", " 5", ""]) {
      expect(() => parseManifestArgs(["--expected-count", bad, "--output", "x.json"])).toThrow(/--expected-count/);
    }
    expect(() => parseManifestArgs(["--expected-count"])).toThrow(/--expected-count/);
    expect(parseManifestArgs(["--expected-count", "0", "--output", "x.json"]).expectedCount).toBe(0);
    expect(parseManifestArgs(["--expected-count", "30801", "--out", "y.json"])).toMatchObject({ expectedCount: 30801, output: "y.json" });
  });

  it("--count-only needs no expected count and no output; --help short-circuits", () => {
    expect(parseManifestArgs(["--count-only"])).toMatchObject({ countOnly: true, expectedCount: undefined });
    expect(parseManifestArgs(["--help"])).toMatchObject({ help: true });
    expect(MANIFEST_USAGE).toContain("--count-only");
    expect(MANIFEST_USAGE).toContain("--expected-count");
  });

  it("--cutover-at must be a valid ISO instant", () => {
    expect(parseManifestArgs(["--count-only", "--cutover-at", "2026-10-07T10:39:15Z"]).cutoverAt!.toISOString()).toBe("2026-10-07T10:39:15.000Z");
    expect(() => parseManifestArgs(["--count-only", "--cutover-at", "yesterday"])).toThrow(/--cutover-at/);
  });
});

describe("[15] writeManifestFile — file first, count check second, never over an existing file", () => {
  it("a count mismatch still writes the file, then fails with the CPS message", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "indexnow-manifest-"));
    try {
      const output = path.join(dir, "m.json");
      const manifest = buildBackfillManifest(CANDIDATES, { releaseCommit: "c", expectedCount: 5, note: "" });
      let announced = false;
      await expect(writeManifestFile(manifest, output, 5, () => (announced = true))).rejects.toThrow(
        "candidate count mismatch: actual=2 expected=5; apply must wait for Owner confirmation",
      );
      expect(announced).toBe(true); // the summary line is printed between the write and the failure
      const written = JSON.parse(await fs.readFile(output, "utf8"));
      expect(written.count).toBe(2);
      expect(verifyManifestSha256(written)).toBe(true);
      // second write to the same path is refused (flag "wx")
      await expect(writeManifestFile(manifest, output, 2)).rejects.toMatchObject({ code: "EEXIST" });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("a matching count writes and resolves", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "indexnow-manifest-"));
    try {
      const manifest = buildBackfillManifest(CANDIDATES, { releaseCommit: "c", expectedCount: 2, note: "" });
      await expect(writeManifestFile(manifest, path.join(dir, "ok.json"), 2)).resolves.toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("selectBackfillCandidates", () => {
  function seed(fake: FakeIndexNowDb, id: string, overrides: Partial<Parameters<FakeIndexNowDb["seedArticle"]>[0]> = {}) {
    fake.seedArticle({ id, novelId: `n-${id}`, slug: `s-${id.slice(-4)}`, publicPageShortId: `p${id.slice(-4)}`, publishedAt: new Date("2026-10-01T00:00:00.000Z"), ...overrides });
  }

  it("[14] without --article-ids walks the whole table by cursor; stats and per-locale counts add up", async () => {
    const fake = new FakeIndexNowDb();
    for (let index = 0; index < 120; index++) seed(fake, `0b1c2d3e-0000-4000-8000-${String(index).padStart(12, "0")}`, { locale: index % 3 === 0 ? "es" : "en" });
    const selection = await selectBackfillCandidates(fake.asPrismaClient(), { pageSize: 25, eligibilityOptions: LOCALE_OK });
    expect(selection.candidates).toHaveLength(120);
    expect(selection.stats).toEqual({ scanned: 120, alreadyHasDelivery: 0, ineligible: 0, eligible: 120 });
    expect(selection.cutoverStats.byLocale.es!.urls).toBe(40);
    expect(selection.cutoverStats.byLocale.en!.urls).toBe(80);
  });

  it("[16] --article-ids: nonexistent, outside the candidates and ineligible ids each reject the WHOLE selection, in CPS format", async () => {
    const fake = new FakeIndexNowDb();
    const ok = U1;
    const hasRecord = U2;
    const draft = "0b1c2d3e-0000-4000-8000-000000000004";
    const blog = "0b1c2d3e-0000-4000-8000-000000000005";
    const ineligible = "0b1c2d3e-0000-4000-8000-000000000006";
    const missing = "0b1c2d3e-0000-4000-8000-0000000000ff";
    seed(fake, ok);
    seed(fake, hasRecord);
    seed(fake, draft, { status: "draft" });
    fake.seedArticle({ id: blog, articleType: "blog_article", slug: "blog", publicPageShortId: "pb" });
    seed(fake, ineligible, { novelStatus: "draft" });
    await enqueueIndexNowFirstPublish(fake.asPrismaClient(), { articleId: hasRecord, source: "publish" }, ENABLED_ALL_ENV, LOCALE_OK);

    const options = { eligibilityOptions: LOCALE_OK };
    await expect(selectBackfillCandidates(fake.asPrismaClient(), { articleIds: [ok, missing], ...options })).rejects.toThrow(
      `--article-ids rejected: nonexistent=[${missing}]`,
    );
    await expect(selectBackfillCandidates(fake.asPrismaClient(), { articleIds: [ok, hasRecord, draft, blog], ...options })).rejects.toThrow(
      `--article-ids rejected: outside_candidates=[${hasRecord},${draft},${blog}]`,
    );
    await expect(selectBackfillCandidates(fake.asPrismaClient(), { articleIds: [ok, ineligible], ...options })).rejects.toThrow(
      `--article-ids rejected: ineligible=[${ineligible}]`,
    );
    await expect(selectBackfillCandidates(fake.asPrismaClient(), { articleIds: [missing, hasRecord, ineligible], ...options })).rejects.toThrow(
      `--article-ids rejected: nonexistent=[${missing}]; outside_candidates=[${hasRecord}]; ineligible=[${ineligible}]`,
    );

    const good = await selectBackfillCandidates(fake.asPrismaClient(), { articleIds: [ok], ...options });
    expect(good.candidates.map((candidate) => candidate.articleId)).toEqual([ok]);
    expect(good.articleIds).toEqual([ok]);
  });
});

describe("[26] cutover_at, published_at and the before/after split", () => {
  it("splits candidates around the cutover (inclusive boundary counts as after), overall and per locale", () => {
    const cutover = new Date("2026-10-07T10:39:15Z");
    const stats = computeCutoverStats(
      [
        { locale: "en", publishedAt: new Date("2026-10-07T10:39:14Z") },
        { locale: "en", publishedAt: new Date("2026-10-07T10:39:15Z") },
        { locale: "es", publishedAt: new Date("2026-10-08T00:00:00Z") },
        { locale: "es", publishedAt: null },
      ],
      cutover,
    );
    expect(stats).toMatchObject({
      cutoverAt: "2026-10-07T10:39:15.000Z",
      urls: 4,
      publishedBeforeCutover: 1,
      publishedAfterCutover: 2,
      publishedAtMissing: 1,
    });
    expect(stats.byLocale.en).toEqual({ urls: 2, publishedBeforeCutover: 1, publishedAfterCutover: 1, publishedAtMissing: 0 });
    expect(stats.byLocale.es).toEqual({ urls: 2, publishedBeforeCutover: 0, publishedAfterCutover: 1, publishedAtMissing: 1 });
  });

  it("selectBackfillCandidates feeds real published_at values into the stats and the manifest", async () => {
    const fake = new FakeIndexNowDb();
    fake.seedArticle({ id: U1, slug: "a", publicPageShortId: "pa", publishedAt: new Date("2026-10-01T00:00:00Z") });
    fake.seedArticle({ id: U2, slug: "b", publicPageShortId: "pb", publishedAt: new Date("2026-10-09T00:00:00Z"), locale: "es" });
    const cutoverAt = new Date("2026-10-07T10:39:15Z");
    const selection = await selectBackfillCandidates(fake.asPrismaClient(), { cutoverAt, eligibilityOptions: LOCALE_OK });
    expect(selection.cutoverStats).toMatchObject({ publishedBeforeCutover: 1, publishedAfterCutover: 1 });
    const manifest = buildBackfillManifest(selection.candidates, { releaseCommit: "c", expectedCount: 2, note: "n", cutoverAt });
    expect(manifest.cutover_at).toBe(cutoverAt.toISOString());
    expect(manifest.entries.map((entry) => entry.published_at)).toEqual(["2026-10-01T00:00:00.000Z", "2026-10-09T00:00:00.000Z"]);
  });
});
