import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  C1_V3_CONFIGURATION,
  findKeywordMatch,
  scoreCalibration,
  validateTaxonomy,
  verifyArtifactBundle,
  writeArtifactBundle,
  buildArtifactBundle,
} from "../../../scripts/p2-06-5-lane-c/calibration.mjs";
import {
  POST_FIX_RISK_CELLS,
  POST_FIX_POPULATION_SAMPLE_TARGET,
  POST_FIX_RISK_SAMPLE_TARGET,
} from "../../../scripts/p2-06-5-lane-c/description-only-blind-review.mjs";
import {
  OVERLAY_SHA256_BY_VERSION,
  loadLexiconOverride,
  normalizeSeed,
} from "../../../scripts/p2-06-5-lane-c/lexicon-eligibility.mjs";
import { buildLexicon, verifyOwnerFinalC1 } from "../../../scripts/p2-06-5-lane-c/owner-final-c1.mjs";

const root = resolve(import.meta.dirname, "../../..");
const canonicalPath = resolve(root, "docs/p2/p2-06-5-lane-a/canonical-tag-v1-final/2026-08-16/canonical-tag-v1.0.0-final.json");
// v1 is superseded but still pinned: the v3 run must stay reproducible.
const overlayPath = resolve(root, "docs/p2/p2-06-5-lane-c/lexicon-overrides/2026-08-16/keyword-eligibility-v1.json");
const finalOverlayPath = resolve(root, "docs/p2/p2-06-5-lane-c/lexicon-overrides/2026-08-17/keyword-eligibility-v2.json");
const EXPECTED_OVERLAY_SHA256 = OVERLAY_SHA256_BY_VERSION["keyword-eligibility-v1"];
const FINAL_OVERLAY_SHA256 = OVERLAY_SHA256_BY_VERSION["keyword-eligibility-v2"];

function sample(overrides: Record<string, unknown> = {}) {
  return {
    sampleRowId: "sample-1",
    novelIdentity: "novel-1",
    sourceLanguageCode: '["number",3]',
    sourceLanguageName: "英语",
    sourceSnapshotId: "snapshot-1",
    scriptBucket: "latin",
    title: "Title",
    description: "Description",
    seriesTypeList: [],
    sourceSnapshotComplete: true,
    manualSnapshotComplete: false,
    manualCanonicalTagIds: [],
    sourceObservedAt: "2026-08-16T00:00:00.000Z",
    ...overrides,
  };
}

async function lexicon(path = overlayPath) {
  const canonical = JSON.parse(await readFile(canonicalPath, "utf8"));
  const { overlay } = await loadLexiconOverride(path);
  return buildLexicon(canonical, overlay);
}

const finalLexicon = () => lexicon(finalOverlayPath);

function tagKeywords(built: ReturnType<typeof buildLexicon>, tagId: string) {
  return built.taxonomy.canonicalTags.find((tag) => tag.canonicalTagId === tagId)!;
}

describe("keyword-eligibility-v2 overlay (Owner Final)", () => {
  it("loads with a matching sidecar hash and supersedes v1", async () => {
    const loaded = await loadLexiconOverride(finalOverlayPath);
    expect(loaded.sha256).toBe(FINAL_OVERLAY_SHA256);
    expect(loaded.overlay.version).toBe("keyword-eligibility-v2");
    expect(loaded.overlay.rules).toHaveLength(11);
  });

  it("carries no grade-B rule at all", async () => {
    const loaded = await loadLexiconOverride(finalOverlayPath);
    expect(loaded.overlay.rules.filter((rule) => rule.grade === "B")).toHaveLength(0);
    expect(loaded.overlay.rules.filter((rule) => rule.reason === "LOW_EVIDENCE_LOCALE_RULE")).toHaveLength(0);
    expect(loaded.overlay.rules.some((rule) => rule.blockedDescriptionNamedScopes.length > 0)).toBe(false);
  });

  it("restores chef description evidence in every locale, including de", async () => {
    const built = await finalLexicon();
    const chef = tagKeywords(built, "ct-v1-chef").keywords.find((row) => normalizeSeed(row.value) === "chef")!;
    expect(chef.allowedFields ?? null).toBeNull();
    expect(chef.blockedDescriptionNamedScopes ?? []).toEqual([]);
    for (const [name, code] of [["英语", 3], ["德语", 16], ["法语", 6], ["西语", 4], ["葡语", 5]] as const) {
      const row = sample({ sourceLanguageName: name, scriptBucket: "latin", sourceLanguageCode: `["number",${code}]` });
      expect(findKeywordMatch("une carrière de chef", chef, row, "description")).not.toBeNull();
    }
  });

  it("stops bare luna from triggering on description in any locale but keeps title", async () => {
    const built = await finalLexicon();
    const luna = tagKeywords(built, "ct-v1-werewolf-luna").keywords.find((row) => normalizeSeed(row.value) === "luna")!;
    expect(luna.allowedFields).toEqual(["title"]);
    for (const [name, code] of [["西语", 4], ["法语", 6], ["葡语", 5], ["英语", 3], ["意大利语", 8]] as const) {
      const row = sample({ sourceLanguageName: name, scriptBucket: "latin", sourceLanguageCode: `["number",${code}]` });
      expect(findKeywordMatch("Luna the pack leader", luna, row, "description")).toBeNull();
    }
    const fr = sample({ sourceLanguageName: "法语", scriptBucket: "latin", sourceLanguageCode: '["number",6]' });
    expect(findKeywordMatch("La Luna du Roi Lycan", luna, fr, "title")).not.toBeNull();
  });

  it("keeps the grade-A restrictions and adds no rule for the observation items", async () => {
    const built = await finalLexicon();
    for (const tagId of ["ct-v1-family", "ct-v1-doctor", "ct-v1-horror"]) {
      const seed = { "ct-v1-family": "family", "ct-v1-doctor": "doctor", "ct-v1-horror": "horror" }[tagId]!;
      const row = tagKeywords(built, tagId).keywords.find((item) => normalizeSeed(item.value) === seed)!;
      expect(row.allowedFields).toEqual(["title"]);
    }
    const happy = tagKeywords(built, "ct-v1-happy-ending");
    expect(happy.keywords.map((row) => normalizeSeed(row.value))).toEqual(["圆满结局"]);
    for (const tagId of ["ct-v1-princess", "ct-v1-crown-prince", "ct-v1-student"]) {
      for (const row of tagKeywords(built, tagId).keywords) {
        expect(row.allowedFields ?? null).toBeNull();
        expect(row.blockedDescriptionNamedScopes ?? []).toEqual([]);
      }
    }
  });
});

describe("keyword-eligibility-v1 overlay", () => {
  it("loads with a matching sidecar hash", async () => {
    const loaded = await loadLexiconOverride(overlayPath);
    expect(loaded.sha256).toBe(EXPECTED_OVERLAY_SHA256);
    expect(loaded.overlay.version).toBe("keyword-eligibility-v1");
    expect(loaded.overlay.rules).toHaveLength(12);
  });

  it("disables he/be and keeps ending CJK seeds", async () => {
    const built = await lexicon();
    const happy = tagKeywords(built, "ct-v1-happy-ending");
    const tragic = tagKeywords(built, "ct-v1-tragic-ending");
    expect(happy.keywords.map((row) => normalizeSeed(row.value))).toEqual(["圆满结局"]);
    expect(tragic.keywords.map((row) => normalizeSeed(row.value))).toEqual(["悲剧结局"]);
    expect(built.audit.disabled.filter((row) => row.reason === "GENERIC_KEYWORD_HOMONYM_FULL_DISABLE")).toHaveLength(2);
    expect(built.audit.disabled.filter((row) => row.reason === "KEYWORD_COVERAGE_INSUFFICIENT_OTHER_SCRIPT")).toHaveLength(6);
  });

  it("restricts family/doctor/horror to title and chef/luna by named scope", async () => {
    const built = await lexicon();
    const family = tagKeywords(built, "ct-v1-family").keywords.find((row) => normalizeSeed(row.value) === "family")!;
    const doctor = tagKeywords(built, "ct-v1-doctor").keywords.find((row) => normalizeSeed(row.value) === "doctor")!;
    const horror = tagKeywords(built, "ct-v1-horror").keywords.find((row) => normalizeSeed(row.value) === "horror")!;
    const chef = tagKeywords(built, "ct-v1-chef").keywords.find((row) => normalizeSeed(row.value) === "chef")!;
    const luna = tagKeywords(built, "ct-v1-werewolf-luna").keywords.find((row) => normalizeSeed(row.value) === "luna")!;
    expect(family.allowedFields).toEqual(["title"]);
    expect(doctor.allowedFields).toEqual(["title"]);
    expect(horror.allowedFields).toEqual(["title"]);
    expect(chef.blockedDescriptionNamedScopes).toEqual(["德语", "法语", "西语", "葡语"]);
    expect(luna.blockedDescriptionNamedScopes).toEqual(["西语", "意大利语"]);
    expect(built.audit.restricted_seed_count).toBe(10);
  });

  it("is byte-identical across two lexicon builds", async () => {
    const first = await lexicon();
    const second = await lexicon();
    expect(JSON.stringify(first.taxonomy)).toBe(JSON.stringify(second.taxonomy));
    expect(JSON.stringify(first.audit)).toBe(JSON.stringify(second.audit));
  });
});

describe("field and locale eligibility matcher", () => {
  it("stops he/be from triggering ending tags on description", async () => {
    const built = await lexicon();
    const taxonomy = validateTaxonomy(built.taxonomy);
    const result = scoreCalibration({
      samples: [sample({
        sampleRowId: "he-be",
        title: "A jungle sequel",
        description: "Back in the jungle where he was raised, it will be different.",
      })],
      taxonomy,
      configurations: [C1_V3_CONFIGURATION],
      maxTextTags: [3],
    });
    expect(result.evidence.filter((row) => row.canonicalTagId === "ct-v1-happy-ending" || row.canonicalTagId === "ct-v1-tragic-ending")).toHaveLength(0);
  });

  it("keeps 圆满结局 / 悲剧结局 matching on CJK text", async () => {
    const built = await lexicon();
    const taxonomy = validateTaxonomy(built.taxonomy);
    const result = scoreCalibration({
      samples: [sample({
        sampleRowId: "ending-cjk",
        sourceLanguageCode: '["number",20]',
        sourceLanguageName: "[null]",
        scriptBucket: "cjk",
        title: "重生复仇",
        description: "女主获得圆满结局，反派走向悲剧结局。",
      })],
      taxonomy,
      configurations: [C1_V3_CONFIGURATION],
      maxTextTags: [3],
    });
    expect(result.evidence.some((row) => row.canonicalTagId === "ct-v1-happy-ending" && row.descriptionMatched)).toBe(true);
    expect(result.evidence.some((row) => row.canonicalTagId === "ct-v1-tragic-ending" && row.descriptionMatched)).toBe(true);
  });

  it("disables family/doctor/horror on description but keeps title", async () => {
    const built = await lexicon();
    const taxonomy = validateTaxonomy(built.taxonomy);
    const family = tagKeywords(built, "ct-v1-family").keywords.find((row) => normalizeSeed(row.value) === "family")!;
    const en = sample({ sourceLanguageName: "英语", scriptBucket: "latin" });
    expect(findKeywordMatch("The family house", family, en, "title")).not.toBeNull();
    expect(findKeywordMatch("The family house", family, en, "description")).toBeNull();

    const result = scoreCalibration({
      samples: [sample({
        title: "Family Doctor Horror",
        description: "The family doctor said the real horror began at dawn.",
      })],
      taxonomy,
      configurations: [C1_V3_CONFIGURATION],
      maxTextTags: [3],
    });
    for (const tagId of ["ct-v1-family", "ct-v1-doctor", "ct-v1-horror"]) {
      const row = result.evidence.find((item) => item.canonicalTagId === tagId)!;
      expect(row.titleMatched).toBe(true);
      expect(row.descriptionMatched).toBe(false);
    }
  });

  it("does not share chef semantics between en and de on description", async () => {
    const built = await lexicon();
    const chef = tagKeywords(built, "ct-v1-chef").keywords.find((row) => normalizeSeed(row.value) === "chef")!;
    const en = sample({ sourceLanguageName: "英语", scriptBucket: "latin" });
    const de = sample({ sourceLanguageName: "德语", scriptBucket: "latin", sourceLanguageCode: '["number",16]' });
    expect(findKeywordMatch("She became a chef", chef, en, "description")).not.toBeNull();
    expect(findKeywordMatch("ihr Chef ist streng", chef, de, "description")).toBeNull();
    expect(findKeywordMatch("Chef Romance", chef, de, "title")).not.toBeNull();
  });

  it("blocks luna on Spanish description and keeps French", async () => {
    const built = await lexicon();
    const luna = tagKeywords(built, "ct-v1-werewolf-luna").keywords.find((row) => normalizeSeed(row.value) === "luna")!;
    const es = sample({ sourceLanguageName: "西语", scriptBucket: "latin", sourceLanguageCode: '["number",4]' });
    const fr = sample({ sourceLanguageName: "法语", scriptBucket: "latin", sourceLanguageCode: '["number",6]' });
    expect(findKeywordMatch("cada luna llena", luna, es, "description")).toBeNull();
    expect(findKeywordMatch("Luna the pack leader", luna, fr, "description")).not.toBeNull();
  });

  it("keeps high-precision control keywords active", async () => {
    const built = await lexicon();
    const taxonomy = validateTaxonomy(built.taxonomy);
    const result = scoreCalibration({
      samples: [sample({
        title: "Time Travel Rebirth",
        description: "A werewolf Alpha romance of revenge against the mafia billionaire heir CEO.",
      })],
      taxonomy,
      configurations: [C1_V3_CONFIGURATION],
      maxTextTags: [3],
    });
    const matched = new Set(result.evidence.filter((row) => row.eligible).map((row) => row.canonicalTagId));
    expect(matched.has("ct-v1-time-travel") || matched.has("ct-v1-rebirth")).toBe(true);
    expect(["ct-v1-werewolf-alpha", "ct-v1-romance", "ct-v1-revenge", "ct-v1-mafia", "ct-v1-wealthy-ceo"].some((id) => matched.has(id))).toBe(true);
  });

  it("writes a hash-verified artifact bundle", async () => {
    const built = await lexicon();
    const scored = scoreCalibration({
      samples: [sample({ title: "Alpha", description: "The Alpha returns." })],
      taxonomy: built.taxonomy,
      configurations: [C1_V3_CONFIGURATION],
      maxTextTags: [3],
      lexiconOverride: { version: "keyword-eligibility-v1", sha256: EXPECTED_OVERLAY_SHA256 },
    });
    const directory = await mkdtemp(join(tmpdir(), "lane-c-v3-"));
    await writeArtifactBundle(directory, buildArtifactBundle(scored));
    const verification = await verifyArtifactBundle(directory);
    expect(verification.ok).toBe(true);
    const manifest = JSON.parse(await readFile(join(directory, "lane-c-run-manifest.json"), "utf8"));
    expect(manifest.lexiconOverride.sha256).toBe(EXPECTED_OVERLAY_SHA256);
  });
});

describe("C1 v3 tracked bundle", () => {
  it("verifies hashes and overlay lineage", async () => {
    const tracked = resolve(root, "docs/p2/p2-06-5-lane-c/runs/2026-08-16-owner-final-c1-v3");
    const verification = await verifyOwnerFinalC1(tracked);
    expect(verification).toMatchObject({ ok: true, failures: [] });
    expect(verification.manifest.lineage).toMatchObject({
      canonical_sha256: "8bc8cdae8be2176bde170173e98bad2b9fa0e1770818174a57320816eefdccad",
      c1_input_sha256: "046fe9234b317eba145c3fbb35edd2e72af49e41309dcd5d5f45f7bc43d1776d",
      lexicon_override_sha256: EXPECTED_OVERLAY_SHA256,
    });
    const localeCsv = await readFile(join(tracked, "locale-before-after.csv"), "utf8");
    expect(localeCsv).toContain("语种19,837,816,21");
    expect(localeCsv).toContain("语种20,719,702,17");
    expect(localeCsv).toContain("英语,1876,911,965");
  });
});

describe("post-fix sampling quotas", () => {
  it("keeps 150+50 and scaled risk cells that sum to 50", () => {
    expect(POST_FIX_POPULATION_SAMPLE_TARGET).toBe(150);
    expect(POST_FIX_RISK_SAMPLE_TARGET).toBe(50);
    expect(POST_FIX_RISK_CELLS.reduce((sum, cell) => sum + cell.quota, 0)).toBe(50);
  });
});

describe("module hygiene", () => {
  it("stays offline: no Prisma, no fetch, no adapters", async () => {
    const files = [
      "scripts/p2-06-5-lane-c/lexicon-eligibility.mjs",
      "scripts/p2-06-5-lane-c/c1-v3-compare.mjs",
      "scripts/p2-06-5-lane-c/owner-final-c1.mjs",
      "scripts/p2-06-5-lane-c/calibration.mjs",
      "scripts/p2-06-5-text-calibration.mjs",
    ];
    for (const relative of files) {
      const source = await readFile(resolve(root, relative), "utf8");
      expect(source).not.toMatch(/from\s+["']@prisma\/client["']/u);
      expect(source).not.toMatch(/\bfetch\s*\(/u);
      expect(source).not.toContain("createMoboreaderReadAdapter");
      expect(source).not.toMatch(/from\s+["']node:readline["']/u);
    }
  });
});
