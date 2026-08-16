import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

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
import {
  applyKeywordEligibilityAuthority,
  CURRENT_KEYWORD_ELIGIBILITY_SHA256,
  CURRENT_KEYWORD_ELIGIBILITY_VERSION,
  KEYWORD_ELIGIBILITY_SHA256_BY_VERSION,
  loadKeywordEligibilityAuthority,
} from "@/lib/tagging/keyword-eligibility";
import { loadLexiconOverride } from "../../../scripts/p2-06-5-lane-c/lexicon-eligibility.mjs";
import { loadKeywordRuleArtifactFromDb } from "@/server/tagging/auto-classification";

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

  it("loads the single frozen production config and validates fixture fingerprints", () => {
    expect(loadTagClassifierConfig(PRODUCTION_TAG_CLASSIFIER_CONFIG)).toMatchObject({
      status: "FROZEN",
      version: "2026-08-17-owner-final-c1-final",
      titleWeight: 30,
      descriptionWeight: 30,
      threshold: 30,
      maxTextTags: 3,
    });
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

describe("P2-06.5 Lane C Final production authority parity", () => {
  const root = resolve(import.meta.dirname, "../../..");
  const v1Path = resolve(root, "docs/p2/p2-06-5-lane-c/lexicon-overrides/2026-08-16/keyword-eligibility-v1.json");
  const v2Path = resolve(root, "docs/p2/p2-06-5-lane-c/lexicon-overrides/2026-08-17/keyword-eligibility-v2.json");
  const configPath = resolve(root, "docs/p2/p2-06-5-lane-c/final/2026-08-17/classifier-config-final.json");

  it("keeps v1 loadable while pointing production at hash-verified v2", async () => {
    const historical = loadKeywordEligibilityAuthority("keyword-eligibility-v1");
    const current = loadKeywordEligibilityAuthority();
    expect(historical.sha256).toBe(KEYWORD_ELIGIBILITY_SHA256_BY_VERSION["keyword-eligibility-v1"]);
    expect(current).toMatchObject({
      version: CURRENT_KEYWORD_ELIGIBILITY_VERSION,
      sha256: CURRENT_KEYWORD_ELIGIBILITY_SHA256,
    });
    for (const [path, expected] of [[v1Path, historical.sha256], [v2Path, current.sha256]] as const) {
      const bytes = await readFile(path);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected);
    }
    const configBytes = await readFile(configPath);
    expect(createHash("sha256").update(configBytes).digest("hex")).toBe("f552ca804efc43a17b26434d8ae3288fd186aec80b1501310bf762fedc4ad2f4");
  });

  it("matches the Lane C Final overlay registry rule-for-rule", async () => {
    const production = loadKeywordEligibilityAuthority();
    const laneC = await loadLexiconOverride(v2Path, CURRENT_KEYWORD_ELIGIBILITY_SHA256);
    expect(production.rules.map((rule) => ({
      canonicalTagId: rule.canonicalTagId,
      normalizedSeed: rule.normalizedSeed,
      enabled: rule.enabled,
      allowedFields: rule.allowedFields,
      blockedDescriptionNamedScopes: rule.blockedDescriptionNamedScopes,
    }))).toEqual(laneC.overlay.rules.map((rule) => ({
      canonicalTagId: rule.canonicalTagId,
      normalizedSeed: rule.normalizedSeed,
      enabled: rule.enabled,
      allowedFields: rule.allowedFields,
      blockedDescriptionNamedScopes: rule.blockedDescriptionNamedScopes,
    })));
  });

  it("enforces Final he/be, generic-description, chef, and bare-luna behavior", () => {
    const raw = [
      tag("ct-v1-happy-ending", 0, "he"),
      tag("ct-v1-tragic-ending", 0, "be"),
      tag("ct-v1-horror", 0, "horror"),
      tag("ct-v1-family", 0, "family"),
      tag("ct-v1-doctor", 0, "doctor"),
      tag("ct-v1-chef", 0, "chef"),
      tag("ct-v1-werewolf-luna", 0, "luna"),
    ];
    const applied = applyKeywordEligibilityAuthority(raw);
    expect(applied.find((item) => item.stableId === "ct-v1-happy-ending")?.keywords).toEqual([]);
    expect(applied.find((item) => item.stableId === "ct-v1-tragic-ending")?.keywords).toEqual([]);
    const rules = artifact(applied);
    const matches = (stableId: string, field: "title" | "description") => classifyNovelText({
      title: field === "title" ? raw.find((item) => item.stableId === stableId)!.keywords[0].value : "",
      description: field === "description" ? raw.find((item) => item.stableId === stableId)!.keywords[0].value : "",
    }, rules, PRODUCTION_TAG_CLASSIFIER_CONFIG).candidates.some((candidate) => candidate.canonicalTagId === `id-${stableId}`);
    for (const stableId of ["ct-v1-horror", "ct-v1-family", "ct-v1-doctor"]) {
      expect(matches(stableId, "description")).toBe(false);
      expect(matches(stableId, "title")).toBe(true);
    }
    expect(matches("ct-v1-chef", "description")).toBe(true);
    expect(matches("ct-v1-werewolf-luna", "description")).toBe(false);
    expect(matches("ct-v1-werewolf-luna", "title")).toBe(true);
  });

  it("applies v2 inside the production DB keyword loader", async () => {
    const byTag = new Map<string, ReturnType<typeof tag>>();
    for (const rule of loadKeywordEligibilityAuthority().rules) {
      const current = byTag.get(rule.canonicalTagId) ?? {
        canonicalTagId: rule.canonicalTagId,
        stableId: rule.canonicalTagId,
        textSelectionPriority: 0,
        keywords: [],
      };
      const isCjk = /\p{Script=Han}|\p{Script=Hangul}/u.test(rule.normalizedSeed);
      current.keywords.push({
        keywordId: `kw-${rule.canonicalTagId}-${current.keywords.length}`,
        value: rule.normalizedSeed,
        scriptBuckets: [isCjk ? "cjk" : "latin"],
        matchMode: isCjk ? "cjk_contiguous" : "unicode_word",
        riskFlags: [],
      });
      byTag.set(rule.canonicalTagId, current);
    }
    const authorityRows = [...byTag.values()].map((item, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      stableId: item.stableId,
      taxonomyVersion: "canonical-tag-v1",
      keywords: item.keywords.map((keyword) => ({ ...keyword, lexiconVersion: "c1-final" })),
    }));
    const fillerCount = 123 - authorityRows.length;
    const rows = authorityRows.concat(Array.from({ length: fillerCount }, (_, index) => ({
      id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      stableId: `ct-v1-fixture-${index}`,
      taxonomyVersion: "canonical-tag-v1",
      keywords: [],
    })));
    const db = { canonicalTag: { findMany: vi.fn().mockResolvedValue(rows) } };
    const loaded = await loadKeywordRuleArtifactFromDb(db as never);
    expect(loaded).toMatchObject({
      keywordEligibilityVersion: "keyword-eligibility-v2",
      keywordEligibilitySha256: CURRENT_KEYWORD_ELIGIBILITY_SHA256,
    });
    expect(loaded.tags.find((item) => item.stableId === "ct-v1-happy-ending")?.keywords).toEqual([]);
    expect(loaded.tags.find((item) => item.stableId === "ct-v1-horror")?.keywords[0].allowedFields).toEqual(["title"]);
    expect(loaded.tags.find((item) => item.stableId === "ct-v1-chef")?.keywords[0].allowedFields).toBeUndefined();
    expect(loaded.tags.find((item) => item.stableId === "ct-v1-werewolf-luna")?.keywords[0].allowedFields).toEqual(["title"]);
  });

  it("applies the Final maxTextTags cap of three", () => {
    const rules = artifact([tag("a", 0, "alpha"), tag("b", 0, "bravo"), tag("c", 0, "charlie"), tag("d", 0, "delta")]);
    expect(classifyNovelText({ title: "alpha bravo charlie delta" }, rules, PRODUCTION_TAG_CLASSIFIER_CONFIG)).toMatchObject({
      rawEligibleCount: 4,
      selectedCount: 3,
      truncatedCount: 1,
    });
  });
});
