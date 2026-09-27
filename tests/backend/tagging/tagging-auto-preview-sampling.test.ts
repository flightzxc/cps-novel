import { describe, expect, it } from "vitest";

import {
  buildCsv,
  deriveLocaleSeed,
  mulberry32,
  parseArgs,
  pickBalancedSample,
  prefixCodePoints,
  seededShuffle,
  TaggingAutoPreviewError,
  type SampleRecord,
} from "../../../scripts/tagging-auto-preview";

/**
 * `scripts/tagging-auto-preview.ts` (the read-only front-end auto-tag
 * quality preview) is verified against a real Postgres role by
 * `scripts/run-tagging-auto-preview-postgres-verification.sh` (zero writes,
 * reproducibility, and the read-only transaction actually rejecting an
 * injected write). This file covers the script's pure, database-free
 * helpers directly -- deterministic sampling and CLI parsing -- fast enough
 * to run on every commit without Docker/Postgres.
 */

describe("mulberry32 / seededShuffle: deterministic PRNG", () => {
  it("same seed -> identical output stream", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("different seeds -> different output stream", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  it("every value is in [0, 1)", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 1000; i += 1) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("seededShuffle: same seed -> identical permutation, never mutates the input", () => {
    const input = Object.freeze(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const shuffled1 = seededShuffle(input, 123);
    const shuffled2 = seededShuffle(input, 123);
    expect(shuffled1).toEqual(shuffled2);
    expect(input).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
    expect([...shuffled1].sort()).toEqual([...input].sort());
  });

  it("seededShuffle: different seeds usually produce different orderings", () => {
    const input = Array.from({ length: 12 }, (_, i) => `id-${i}`);
    const shuffled1 = seededShuffle(input, 1);
    const shuffled2 = seededShuffle(input, 2);
    expect(shuffled1).not.toEqual(shuffled2);
  });

  it("deriveLocaleSeed: different locales derive different seeds from the same run seed", () => {
    const en = deriveLocaleSeed(20260928, "en");
    const ja = deriveLocaleSeed(20260928, "ja");
    expect(en).not.toBe(ja);
  });

  it("deriveLocaleSeed: same run seed + same locale is always the same derived seed", () => {
    expect(deriveLocaleSeed(20260928, "en")).toBe(deriveLocaleSeed(20260928, "en"));
  });
});

describe("pickBalancedSample: deterministic, balanced, never over-promises", () => {
  const mapped = Array.from({ length: 20 }, (_, i) => `mapped-${i}`).sort();
  const unmapped = Array.from({ length: 20 }, (_, i) => `unmapped-${i}`).sort();

  it("same seed -> identical sample (reproducibility)", () => {
    const first = pickBalancedSample(mapped, unmapped, 8, 999);
    const second = pickBalancedSample(mapped, unmapped, 8, 999);
    expect(first).toEqual(second);
  });

  it("splits as evenly as possible when both pools are large enough (ceil/floor of n)", () => {
    const result = pickBalancedSample(mapped, unmapped, 7, 5);
    expect(result.mappedSampledCount).toBe(4); // ceil(7/2)
    expect(result.unmappedSampledCount).toBe(3); // floor(7/2)
    expect(result.sampleIds.length).toBe(7);
    expect(new Set(result.sampleIds).size).toBe(7);
  });

  it("takes the whole mapped pool and tops up from unmapped when mapped pool is short", () => {
    const smallMapped = ["m-1", "m-2"];
    const result = pickBalancedSample(smallMapped, unmapped, 10, 1);
    expect(result.mappedSampledCount).toBe(2);
    expect(result.unmappedSampledCount).toBe(8);
    expect(result.sampleIds.length).toBe(10);
  });

  it("takes the whole unmapped pool and tops up from mapped when unmapped pool is short", () => {
    const smallUnmapped = ["u-1"];
    const result = pickBalancedSample(mapped, smallUnmapped, 10, 1);
    expect(result.unmappedSampledCount).toBe(1);
    expect(result.mappedSampledCount).toBe(9);
    expect(result.sampleIds.length).toBe(10);
  });

  it("never returns more than both pools combined can supply", () => {
    const result = pickBalancedSample(["m-1"], ["u-1", "u-2"], 100, 1);
    expect(result.sampleIds.length).toBe(3);
    expect(result.mappedSampledCount).toBe(1);
    expect(result.unmappedSampledCount).toBe(2);
  });

  it("both pools empty -> empty sample, no throw", () => {
    const result = pickBalancedSample([], [], 10, 1);
    expect(result.sampleIds).toEqual([]);
    expect(result.mappedPoolSize).toBe(0);
    expect(result.unmappedPoolSize).toBe(0);
  });

  it("n = 0 -> empty sample regardless of pool sizes", () => {
    const result = pickBalancedSample(mapped, unmapped, 0, 1);
    expect(result.sampleIds).toEqual([]);
  });
});

describe("prefixCodePoints: truncates by Unicode code point, not UTF-16 code unit", () => {
  it("truncates a plain ASCII string", () => {
    expect(prefixCodePoints("hello world", 5)).toBe("hello");
  });

  it("returns the whole string when it is shorter than the limit", () => {
    expect(prefixCodePoints("short", 300)).toBe("short");
  });

  it("counts an astral character (surrogate pair) as one code point, not two", () => {
    const astral = "\u{1F600}"; // one emoji, two UTF-16 code units
    const value = `${astral}${astral}${astral}`;
    expect(prefixCodePoints(value, 2)).toBe(`${astral}${astral}`);
    expect(prefixCodePoints(value, 2).length).toBe(4); // 2 code points = 4 UTF-16 code units
  });

  it("empty string in, empty string out", () => {
    expect(prefixCodePoints("", 10)).toBe("");
  });
});

describe("parseArgs: CLI argument parsing", () => {
  it("--seed is required", () => {
    expect(() => parseArgs([])).toThrow(TaggingAutoPreviewError);
  });

  it("parses a minimal valid invocation with defaults", () => {
    const options = parseArgs(["--seed", "42"]);
    expect(options).toEqual({ samplePerLocale: 100, seed: 42, locales: null, outDir: "/tmp/tagging-auto-preview" });
  });

  it("parses every explicit option", () => {
    const options = parseArgs([
      "--seed", "20260928",
      "--sample-per-locale", "50",
      "--locales", "en, ja ,ko",
      "--out-dir", "/tmp/custom-dir",
    ]);
    expect(options).toEqual({
      samplePerLocale: 50, seed: 20260928, locales: ["en", "ja", "ko"], outDir: "/tmp/custom-dir",
    });
  });

  it("rejects a non-integer --sample-per-locale", () => {
    expect(() => parseArgs(["--seed", "1", "--sample-per-locale", "abc"])).toThrow(TaggingAutoPreviewError);
  });

  it("rejects a zero or negative --sample-per-locale", () => {
    expect(() => parseArgs(["--seed", "1", "--sample-per-locale", "0"])).toThrow(TaggingAutoPreviewError);
  });

  it("rejects an empty --locales list", () => {
    expect(() => parseArgs(["--seed", "1", "--locales", " , , "])).toThrow(TaggingAutoPreviewError);
  });

  it("accepts a negative --seed (folded to an unsigned 32-bit PRNG seed)", () => {
    const options = parseArgs(["--seed", "-5"]);
    expect(options.seed).toBe((-5) >>> 0);
  });
});

describe("buildCsv: human-review CSV shaping", () => {
  function sample(overrides: Partial<SampleRecord>): SampleRecord {
    return {
      novelId: "id-1", locale: "en", title: "Title", descriptionPrefix300: "Description",
      mappedTags: [], candidates: [], finalAutoTagsAfterDedup: [],
      rawEligibleCount: 0, selectedCount: 0, truncatedCount: 0, skippedReason: null,
      ...overrides,
    };
  }

  it("emits a header row and one row per sample", () => {
    const csv = buildCsv([sample({}), sample({ novelId: "id-2" })]);
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("novel_id");
  });

  it("escapes commas, quotes, and newlines per RFC 4180", () => {
    const csv = buildCsv([sample({ title: 'A "quoted", multi\nline title' })]);
    expect(csv).toContain('"A ""quoted"", multi\nline title"');
  });

  it("records the skipped reason and leaves classification fields blank", () => {
    const csv = buildCsv([sample({
      title: null, descriptionPrefix300: null,
      rawEligibleCount: null, selectedCount: null, truncatedCount: null,
      skippedReason: "NOVEL_NOT_FOUND",
    })]);
    expect(csv).toContain("NOVEL_NOT_FOUND");
  });

  it("joins multiple mapped tags and candidates with semicolons", () => {
    const candidate = {
      canonicalTagId: "ct-1", stableId: "ct-v1-a", slug: "a", displayName: "A",
      score: 30, matchedFields: ["title"], matchedKeywords: [],
    };
    const csv = buildCsv([sample({
      mappedTags: [
        { slug: "adventure", label: "Adventure", nameEn: "Adventure", nameZh: "冒险" },
        { slug: "romance", label: "Romance", nameEn: "Romance", nameZh: "言情" },
      ],
      candidates: [candidate],
      finalAutoTagsAfterDedup: [candidate],
    })]);
    expect(csv).toContain("adventure;romance");
    expect(csv).toContain("a:30");
    expect(csv).toContain("Adventure;Romance");
    expect(csv).toContain("冒险;言情");
  });

  it("emits mapped_tag_names_en/mapped_tag_names_zh columns in the header, and a blank cell when a translation is missing", () => {
    const csv = buildCsv([sample({
      mappedTags: [{ slug: "no-zh-yet", label: "No ZH Yet", nameEn: "No ZH Yet", nameZh: null }],
    })]);
    const [header, row] = csv.trim().split("\n");
    expect(header).toContain("mapped_tag_names_en");
    expect(header).toContain("mapped_tag_names_zh");
    const cells = row.split(",");
    expect(cells[header.split(",").indexOf("mapped_tag_names_en")]).toBe("No ZH Yet");
    expect(cells[header.split(",").indexOf("mapped_tag_names_zh")]).toBe("");
  });
});
