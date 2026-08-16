import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FORBIDDEN_REVIEWER_FIELDS,
  KNOWN_DEFECTIVE_KEYWORDS,
  RISK_CELLS,
  SAMPLING_SEED,
  allocateStrata,
  buildReviewPackages,
  selectSample,
} from "../../../scripts/p2-06-5-lane-c/description-only-blind-review.mjs";

const C1_INPUT_SHA256 = "046fe9234b317eba145c3fbb35edd2e72af49e41309dcd5d5f45f7bc43d1776d";

function tag(stableId: string, slug: string) {
  return {
    stable_id: stableId,
    slug,
    display_name_zh: `名-${slug}`,
    canonical_definition: `用于检索以“${slug}”为核心题材的小说。`,
    facet: "topic",
  };
}

/**
 * Builds a synthetic description-only novel in the shape
 * `loadDescriptionOnlyPopulation` produces.
 */
function novel(index: number, overrides: Record<string, unknown> = {}) {
  const scope = (overrides.rawLanguageScope as string) ?? "scope-a";
  const keyword = (overrides.keyword as string) ?? "werewolf";
  const description = `A quiet opening. The ${keyword} arrives late. A closing line.`;
  const start = description.indexOf(keyword);
  const stableId = (overrides.canonicalTagId as string) ?? "ct-v1-wolf";
  return {
    sampleRowId: `c1-${String(index).padStart(5, "0")}`,
    sample: {
      title: `Title ${index}`,
      description,
      novelIdentity: `identity-${index}`,
      channelAppId: "changdu-app",
      rawLanguageScope: scope,
      sourceLanguageCode: '["number",3]',
      sourceLanguageName: "英语",
      scriptBucket: "latin",
      sourceSnapshotId: `snapshot-${index}`,
      seriesTypeList: ["女频", "Mafia"],
      manualCanonicalTagIds: [],
    },
    diagnostics: {
      rawEligibleTextTagCount: (overrides.rawEligibleTextTagCount as number) ?? 1,
      selectedTextTagCount: (overrides.selectedTextTagCount as number) ?? 1,
      truncatedTextTagCount: 0,
      sourceMappedTagIds: ["ct-v1-female-audience"],
      sourceTextRelation: (overrides.sourceTextRelation as string) ?? "SOURCE_AND_TEXT",
    },
    description,
    descriptionLength: Array.from(description).length,
    proposals: [
      {
        edge: {
          canonicalTagId: stableId,
          titleMatched: false,
          descriptionMatched: true,
          selectedAfterCap: true,
          evidenceClass: "DESCRIPTION_ONLY",
          totalScore: 30,
          descriptionScore: 30,
          keywordCoverageStatus: "RELIABLE",
          scriptBucket: "latin",
        },
        tag: tag(stableId, stableId.replace("ct-v1-", "")),
        matches: [
          {
            keywordId: `kw-${keyword}`,
            keyword,
            matchMode: "unicode_word",
            start,
            end: start + keyword.length,
            text: keyword,
            excerpt: description,
            inputFieldSha256: "0".repeat(64),
          },
        ],
      },
    ],
    hasTitleSupportedTextEdge: false,
    rawLanguageScope: scope,
    riskFlags: (overrides.riskFlags as string[]) ?? [],
  };
}

function population(count: number, perScope = 40) {
  return Array.from({ length: count }, (_, index) =>
    novel(index, {
      rawLanguageScope: `scope-${Math.floor(index / perScope)}`,
      riskFlags: index % 7 === 0 ? [RISK_CELLS[index % RISK_CELLS.length].flag] : [],
    }));
}

const canonicalIds = new Set(["ct-v1-wolf", "ct-v1-other"]);

describe("allocateStrata", () => {
  it("allocates proportionally and hits the target exactly", () => {
    const populationByStratum = new Map([["a", 913], ["b", 624], ["c", 546], ["d", 12], ["e", 6]]);
    const allocation = allocateStrata(populationByStratum, 320);
    expect([...allocation.values()].reduce((sum, value) => sum + value, 0)).toBe(320);
    expect(allocation.get("a")).toBeGreaterThan(allocation.get("b") as number);
  });

  it("guarantees a floor for strata large enough to carry one and never oversamples a stratum", () => {
    const populationByStratum = new Map([["big", 3000], ["small", 6], ["tiny", 2]]);
    const allocation = allocateStrata(populationByStratum, 320);
    expect(allocation.get("small")).toBeGreaterThanOrEqual(2);
    expect(allocation.get("tiny")).toBeLessThanOrEqual(2);
    for (const [key, value] of allocation) expect(value).toBeLessThanOrEqual(populationByStratum.get(key) as number);
  });
});

describe("selectSample", () => {
  it("is deterministic: identical input yields an identical selection", () => {
    const novels = population(600, 60);
    const first = selectSample(novels, { c1InputSha256: C1_INPUT_SHA256, populationTarget: 80, riskTarget: 20 });
    const second = selectSample(novels, { c1InputSha256: C1_INPUT_SHA256, populationTarget: 80, riskTarget: 20 });
    expect(first.selected.map((entry) => entry.novel.sampleRowId)).toEqual(second.selected.map((entry) => entry.novel.sampleRowId));
  });

  it("changes selection when the seed context changes", () => {
    const novels = population(600, 60);
    const base = selectSample(novels, { c1InputSha256: C1_INPUT_SHA256, populationTarget: 80, riskTarget: 20 });
    const other = selectSample(novels, { c1InputSha256: "f".repeat(64), populationTarget: 80, riskTarget: 20 });
    expect(base.selected.map((entry) => entry.novel.sampleRowId)).not.toEqual(other.selected.map((entry) => entry.novel.sampleRowId));
  });

  it("keeps the two layers disjoint and reaches the combined target", () => {
    const novels = population(600, 60);
    const { selected } = selectSample(novels, { c1InputSha256: C1_INPUT_SHA256, populationTarget: 80, riskTarget: 20 });
    const ids = selected.map((entry) => entry.novel.sampleRowId);
    expect(new Set(ids).size).toBe(100);
    expect(selected.filter((entry) => entry.stratum === "POPULATION")).toHaveLength(80);
    expect(selected.filter((entry) => entry.stratum === "RISK")).toHaveLength(20);
  });

  it("falls back to a full census when the pool cannot fill the package", () => {
    const novels = population(30, 10);
    const { selected, census, shortfalls } = selectSample(novels, { c1InputSha256: C1_INPUT_SHA256, populationTarget: 80, riskTarget: 20 });
    expect(census).toBe(true);
    expect(selected).toHaveLength(30);
    expect(shortfalls[0]).toMatchObject({ requested: 100, available: 30, shortfall: 70 });
  });

  it("never gives the known he/be seed defect a risk cell", () => {
    expect(RISK_CELLS.map((cell) => cell.flag)).not.toContain("GENERIC_KEYWORD_HE_BE");
    expect([...KNOWN_DEFECTIVE_KEYWORDS]).toEqual(["he", "be"]);
  });
});

describe("buildReviewPackages", () => {
  const novels = population(600, 60);
  const built = buildReviewPackages(novels, { c1InputSha256: C1_INPUT_SHA256, canonicalIds, populationTarget: 80, riskTarget: 20 });

  it("emits reviewer rows limited to the blind allow-list", () => {
    for (const row of built.reviewerRows) {
      expect(Object.keys(row).sort()).toEqual(["description", "novel_review_id", "proposed_tags", "raw_language_scope", "title"]);
      for (const proposed of row.proposed_tags) {
        expect(Object.keys(proposed).sort()).toEqual(["canonical_definition", "canonical_stable_id", "display_name_zh", "matched_text_span", "slug"]);
      }
    }
  });

  it("keeps every form of source evidence out of the reviewer package", () => {
    const serialized = JSON.stringify(built.reviewerRows);
    for (const field of FORBIDDEN_REVIEWER_FIELDS) expect(serialized).not.toContain(`"${field}"`);
    expect(serialized).not.toContain("女频");
    expect(serialized).not.toContain("ct-v1-female-audience");
    expect(serialized).not.toContain("identity-");
    expect(serialized).not.toContain("snapshot-");
  });

  it("keeps the source evidence in the hidden reference instead", () => {
    for (const row of built.hiddenRows) {
      expect(row.raw_series_types).toEqual(["女频", "Mafia"]);
      expect(row.source_mapped_tag_ids).toEqual(["ct-v1-female-audience"]);
      expect(row.sample_row_id).toMatch(/^c1-\d{5}$/u);
    }
  });

  it("aligns the two packages one to one by review id", () => {
    expect(built.reviewerRows).toHaveLength(built.hiddenRows.length);
    expect(built.reviewerRows.map((row) => row.novel_review_id)).toEqual(built.hiddenRows.map((row) => row.novel_review_id));
    expect(new Set(built.reviewerRows.map((row) => row.novel_review_id)).size).toBe(built.reviewerRows.length);
  });

  it("emits matched spans that re-derive exactly from the description", () => {
    for (const row of built.reviewerRows) {
      const points = Array.from(row.description);
      for (const proposed of row.proposed_tags) {
        for (const span of proposed.matched_text_span) {
          expect(points.slice(span.start, span.end).join("")).toBe(span.text);
        }
      }
    }
  });

  it("records only description-only edges", () => {
    for (const row of built.hiddenRows) {
      for (const edge of row.description_only_edges) {
        expect(edge.title_matched).toBe(false);
        expect(edge.description_matched).toBe(true);
        expect(edge.selected_after_cap).toBe(true);
      }
    }
  });

  it("passes every QA gate", () => {
    expect(built.qaChecks.every((check) => check.ok)).toBe(true);
    expect(built.qaChecks.map((check) => check.check)).toContain("reviewer_package_has_no_source_evidence");
  });

  it("rejects a proposed tag that is not in the canonical dictionary", () => {
    const stray = population(600, 60).map((row, index) => (index === 0
      ? { ...row, proposals: [{ ...row.proposals[0], tag: tag("ct-v1-ghost", "ghost") }] }
      : row));
    expect(() => buildReviewPackages(stray, { c1InputSha256: C1_INPUT_SHA256, canonicalIds, populationTarget: 599, riskTarget: 1 }))
      .toThrow(/all_tags_in_canonical_final/u);
  });
});

describe("module hygiene", () => {
  it("stays offline: no Prisma, no fetch, no adapters", async () => {
    const source = await readFile(resolve(import.meta.dirname, "../../../scripts/p2-06-5-lane-c/description-only-blind-review.mjs"), "utf8");
    expect(source).not.toMatch(/from\s+["']@prisma\/client["']/u);
    expect(source).not.toMatch(/\bfetch\s*\(/u);
    expect(source).not.toContain("createMoboreaderReadAdapter");
  });

  it("does not use node:readline, which would shred rows containing U+2028", async () => {
    const source = await readFile(resolve(import.meta.dirname, "../../../scripts/p2-06-5-lane-c/description-only-blind-review.mjs"), "utf8");
    expect(source).not.toMatch(/from\s+["']node:readline["']/u);
    expect(source).not.toMatch(/\bcreateInterface\s*\(/u);
  });

  it("declares the sampling seed", () => {
    expect(SAMPLING_SEED).toBe("20260816");
  });
});
