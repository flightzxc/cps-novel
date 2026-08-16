import { describe, expect, it } from "vitest";

import { classifyNovelText, findProductionKeywordMatch } from "@/lib/tagging/classifier";
import {
  createFrozenTagClassifierConfig,
  loadTagClassifierConfig,
  PRODUCTION_TAG_CLASSIFIER_CONFIG,
} from "@/lib/tagging/classifier-config";
import {
  CANONICAL_TAG_V1_SHA256,
  validateKeywordRuleArtifact,
  type KeywordRuleArtifactInput,
} from "@/lib/tagging/keyword-artifact";

const config = createFrozenTagClassifierConfig({
  version: "fixture-v1",
  titleWeight: 30,
  descriptionWeight: 20,
  threshold: 20,
  maxTextTags: 2,
});

function artifact(tags: KeywordRuleArtifactInput["tags"]) {
  return validateKeywordRuleArtifact({
    schemaVersion: 1,
    taxonomyVersion: "canonical-tag-v1",
    taxonomySha256: CANONICAL_TAG_V1_SHA256,
    keywordLexiconVersion: "fixture-lexicon-v1",
    tags,
  });
}

function tag(stableId: string, priority: number, value: string, mode: "unicode_word" | "cjk_contiguous" | "auto" = "unicode_word") {
  return {
    canonicalTagId: `id-${stableId}`,
    stableId,
    textSelectionPriority: priority,
    keywords: [{
      keywordId: `kw-${stableId}`,
      value,
      scriptBuckets: [mode === "cjk_contiguous" ? "cjk" as const : "latin" as const],
      matchMode: mode,
      riskFlags: ["fixture"],
    }],
  };
}

describe("P2-06.5 production deterministic classifier", () => {
  it("uses Unicode-aware Latin whole-word matching with NFC and case folding", () => {
    const keyword = tag("cafe", 0, "café").keywords[0];
    expect(findProductionKeywordMatch("A CAFE\u0301 story", keyword)).toMatchObject({ start: 2, end: 6, matchMode: "unicode_word" });
    expect(findProductionKeywordMatch("caféteria", keyword)).toBeNull();
    expect(findProductionKeywordMatch("my_café", keyword)).toBeNull();
  });

  it("matches CJK contiguously, rejects one-code-point rules, and resolves auto from the keyword bucket", () => {
    const cjk = tag("rebirth", 0, "重生", "cjk_contiguous").keywords[0];
    expect(findProductionKeywordMatch("她重生归来", cjk)).toMatchObject({ start: 1, end: 3 });
    expect(findProductionKeywordMatch("她重 新 生", cjk)).toBeNull();
    expect(() => artifact([tag("short", 0, "生", "cjk_contiguous")])).toThrow(/shorter than two code points/);
    const auto = { ...cjk, matchMode: "auto" as const };
    expect(findProductionKeywordMatch("再次重生", auto)).not.toBeNull();
    expect(findProductionKeywordMatch("再次重生", { ...auto, scriptBuckets: ["latin", "cjk"] })).toBeNull();
  });

  it("scores each field once, then applies threshold, cap, priority, and stable-id ordering", () => {
    const rules = artifact([
      tag("ct-v1-zeta", 0, "wolf"),
      tag("ct-v1-alpha", 0, "alpha"),
      tag("ct-v1-priority", 1, "priority"),
    ]);
    const result = classifyNovelText({
      title: "Wolf wolf",
      description: "wolf alpha priority",
    }, rules, config);
    expect(result).toMatchObject({ rawEligibleCount: 3, selectedCount: 2, truncatedCount: 1 });
    expect(result.candidates.map(({ canonicalTagId, score }) => ({ canonicalTagId, score }))).toEqual([
      { canonicalTagId: "id-ct-v1-zeta", score: 50 },
      { canonicalTagId: "id-ct-v1-alpha", score: 20 },
    ]);
  });

  it("emits versioned evidence without source text, excerpts, language, metadata, or chapters", () => {
    const result = classifyNovelText({ title: "Wolf", description: null }, artifact([tag("wolf", 0, "wolf")]), config);
    const serialized = JSON.stringify(result.candidates[0].evidence);
    expect(serialized).toContain("fieldSha256");
    expect(serialized).toContain("keywordId");
    expect(serialized).not.toMatch(/Wolf|excerpt|sourceLanguage|rawPayload|chapter|author/);
    expect(classifyNovelText({ title: "none", description: "" }, artifact([tag("wolf", 0, "wolf")]), config).candidates).toEqual([]);
  });

  it("keeps production config pending and validates fixture fingerprints", () => {
    expect(() => loadTagClassifierConfig(PRODUCTION_TAG_CLASSIFIER_CONFIG)).toThrow(expect.objectContaining({ code: "CONFIG_NOT_READY" }));
    expect(loadTagClassifierConfig(config)).toEqual(config);
    expect(() => loadTagClassifierConfig({ ...config, fingerprint: "0".repeat(64) })).toThrow(/fingerprint mismatch/);
  });

  it("rejects duplicate keyword identities and fingerprint drift", () => {
    const duplicate = tag("one", 0, "one");
    expect(() => artifact([duplicate, { ...tag("two", 0, "two"), keywords: duplicate.keywords }])).toThrow(/Duplicate or empty keyword/);
    const valid = artifact([duplicate]);
    expect(() => validateKeywordRuleArtifact({ ...valid, keywordFingerprint: "f".repeat(64) })).toThrow(/fingerprint mismatch/);
  });
});

