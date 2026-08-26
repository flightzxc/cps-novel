import { describe, expect, it } from "vitest";

import { computeManifestSha256, verifyManifestSha256, type IndexNowBackfillManifest } from "@/lib/indexnow/backfill-manifest";

import { buildBackfillManifest, parseArticleIdsArg } from "../../../scripts/indexnow-backfill-manifest";

const CANDIDATES = [
  { articleId: "article-1", novelId: "novel-1", locale: "en", canonicalUrl: "https://x.example/novel/a-p1" },
  { articleId: "article-2", novelId: "novel-2", locale: "en", canonicalUrl: "https://x.example/novel/b-p2" },
];

describe("buildBackfillManifest", () => {
  it("produces a self-consistent, verifiable manifest", () => {
    const manifest = buildBackfillManifest(CANDIDATES, {
      releaseCommit: "abc1234",
      expectedCount: CANDIDATES.length,
      note: "test",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(manifest.count).toBe(2);
    expect(manifest.expected_count).toBe(2);
    expect(manifest.entries.map((e) => e.article_id)).toEqual(["article-1", "article-2"]);
    expect(manifest.entries[0]!.novel_id).toBe("novel-1");
    expect(verifyManifestSha256(manifest)).toBe(true);
  });
});

describe("manifest SHA-256 integrity — the backfill's gate 1", () => {
  it("verifies a well-formed manifest", () => {
    const manifest = buildBackfillManifest(CANDIDATES, { releaseCommit: "c", expectedCount: 2, note: "" });
    expect(verifyManifestSha256(manifest)).toBe(true);
  });

  it("detects any tamper with the entries after the hash was computed", () => {
    const manifest = buildBackfillManifest(CANDIDATES, { releaseCommit: "c", expectedCount: 2, note: "" });
    const tampered: IndexNowBackfillManifest = {
      ...manifest,
      entries: [...manifest.entries, { ...manifest.entries[0]!, article_id: "injected" }],
    };
    expect(verifyManifestSha256(tampered)).toBe(false);
  });

  it("detects a tampered expected_count without touching entries", () => {
    const manifest = buildBackfillManifest(CANDIDATES, { releaseCommit: "c", expectedCount: 2, note: "" });
    const tampered: IndexNowBackfillManifest = { ...manifest, expected_count: 999 };
    expect(verifyManifestSha256(tampered)).toBe(false);
  });

  it("computeManifestSha256 excludes the content_sha256 field itself from the hashed payload", () => {
    const manifest = buildBackfillManifest(CANDIDATES, { releaseCommit: "c", expectedCount: 2, note: "" });
    const differentHashSameContent: IndexNowBackfillManifest = { ...manifest, content_sha256: "0".repeat(64) };
    // Recomputing from a manifest whose only difference is content_sha256
    // itself yields the *original* correct hash, not a hash-of-a-hash.
    expect(computeManifestSha256(differentHashSameContent)).toBe(manifest.content_sha256);
  });
});

describe("parseArticleIdsArg", () => {
  it("returns null for empty/undefined input (no explicit filter)", () => {
    expect(parseArticleIdsArg(undefined)).toBeNull();
    expect(parseArticleIdsArg("")).toBeNull();
    expect(parseArticleIdsArg("   ")).toBeNull();
  });

  it("splits, trims, and drops empty entries", () => {
    expect(parseArticleIdsArg("a, b ,,c")).toEqual(["a", "b", "c"]);
  });

  it("throws if every entry was blank", () => {
    expect(() => parseArticleIdsArg(",, ,")).toThrow();
  });
});
