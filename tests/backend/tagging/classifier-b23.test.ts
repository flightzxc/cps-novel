import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import b23Config from "@/lib/tagging/artifacts/classifier-config-b23-v1.json";
import { classifyNovelText } from "@/lib/tagging/classifier";
import {
  createFrozenTagClassifierConfig,
  LEGACY_TAG_CLASSIFIER_CONFIG_V2,
  PRODUCTION_TAG_CLASSIFIER_CONFIG,
  resolveProductionTagClassifierConfig,
} from "@/lib/tagging/classifier-config";
import { CANONICAL_TAG_V1_SHA256, validateKeywordRuleArtifact } from "@/lib/tagging/keyword-artifact";

// B-23 classifier behaviour. The boilerplate sentences are publisher template
// text; the keywords (royal / soldier / modern / zeppelin) are synthetic. No
// real book's blurb is reproduced.

function tag(stableId: string, value: string) {
  return {
    canonicalTagId: `id-${stableId}`,
    stableId,
    textSelectionPriority: 0,
    keywords: [{ keywordId: `kw-${stableId}`, value, scriptBuckets: ["latin" as const], matchMode: "unicode_word" as const, riskFlags: [] }],
  };
}

const artifact = validateKeywordRuleArtifact({
  schemaVersion: 1,
  taxonomyVersion: "canonical-tag-v1",
  taxonomySha256: CANONICAL_TAG_V1_SHA256,
  keywordLexiconVersion: "fixture-lexicon-v1",
  tags: [tag("ct-v1-modern", "modern"), tag("ct-v1-royal", "royal"), tag("ct-v1-soldier", "soldier"), tag("ct-v1-zeppelin", "zeppelin")],
});

const BOILERPLATE = "This work has been selected by scholars as being culturally important and is part of the knowledge base of civilization as we know it.";
const ids = (result: ReturnType<typeof classifyNovelText>) => result.candidates.map((candidate) => candidate.canonicalTagId);
const scores = (result: ReturnType<typeof classifyNovelText>) => result.candidates.map((candidate) => [candidate.canonicalTagId, candidate.score]);

describe("B-23 classifier: boilerplate descriptions do not take part in keyword matching", () => {
  it("a boilerplate description triggers nothing; the same words in an ordinary description still do", () => {
    const boilerplate = { title: "A Plain Title", description: `${BOILERPLATE} The royal soldier of a modern age.` };
    expect(ids(classifyNovelText(boilerplate, artifact, LEGACY_TAG_CLASSIFIER_CONFIG_V2))).toEqual(["id-ct-v1-modern", "id-ct-v1-royal", "id-ct-v1-soldier"]);
    const skipped = classifyNovelText(boilerplate, artifact, PRODUCTION_TAG_CLASSIFIER_CONFIG);
    expect(skipped.candidates).toEqual([]);
    expect(skipped).toMatchObject({ rawEligibleCount: 0, selectedCount: 0, truncatedCount: 0, descriptionBoilerplate: { matched: true, patternId: "bp-001" } });

    const ordinary = classifyNovelText({ title: "A Plain Title", description: "The royal soldier of a modern age." }, artifact, PRODUCTION_TAG_CLASSIFIER_CONFIG);
    expect(ids(ordinary)).toEqual(["id-ct-v1-modern", "id-ct-v1-royal", "id-ct-v1-soldier"]);
    expect(ordinary.descriptionBoilerplate).toEqual({ matched: false, patternId: null });
  });

  it("the title is matched exactly as before, even when the description is boilerplate", () => {
    const input = { title: "The Royal Soldier", description: `${BOILERPLATE} The royal soldier.` };
    const before = classifyNovelText(input, artifact, LEGACY_TAG_CLASSIFIER_CONFIG_V2);
    const after = classifyNovelText(input, artifact, PRODUCTION_TAG_CLASSIFIER_CONFIG);
    expect(ids(after)).toEqual(ids(before));
    expect(ids(after)).toEqual(["id-ct-v1-royal", "id-ct-v1-soldier"]);
    // title (30) + description (30) used to score 60; the skipped description no longer adds its 30
    expect(scores(before)).toEqual([["id-ct-v1-royal", 60], ["id-ct-v1-soldier", 60]]);
    expect(scores(after)).toEqual([["id-ct-v1-royal", 30], ["id-ct-v1-soldier", 30]]);
    expect(after.candidates.every((candidate) => (candidate.evidence as { matchedFields: string[] }).matchedFields.join() === "title")).toBe(true);
  });

  it("keeps the evidence hash of the REAL description, not of the emptied matching input", () => {
    const description = `${BOILERPLATE} The royal soldier.`;
    const result = classifyNovelText({ title: "Royal", description }, artifact, PRODUCTION_TAG_CLASSIFIER_CONFIG);
    const evidence = result.candidates[0]!.evidence as { fieldSha256: { title: string; description: string } };
    expect(evidence.fieldSha256.description).toBe(createHash("sha256").update(description).digest("hex"));
  });

  it("skips the whole description, so a freed max-tags slot can admit a tag the description used to crowd out", () => {
    const input = { title: "Zeppelin", description: `${BOILERPLATE} A modern royal soldier.` };
    expect(ids(classifyNovelText(input, artifact, LEGACY_TAG_CLASSIFIER_CONFIG_V2))).toEqual(["id-ct-v1-modern", "id-ct-v1-royal", "id-ct-v1-soldier"]);
    const after = classifyNovelText(input, artifact, PRODUCTION_TAG_CLASSIFIER_CONFIG);
    expect(ids(after)).toEqual(["id-ct-v1-zeppelin"]);
    expect(after.truncatedCount).toBe(0);
  });

  it("books whose description is not boilerplate are classified exactly as under the previous config", () => {
    const words = ["royal", "soldier", "modern", "zeppelin", "castle", "garden", "excerpt", "reproduction", "published", "1923", "culturally", "important"];
    let seed = 7;
    const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
    for (let index = 0; index < 120; index += 1) {
      const pick = () => words[next() % words.length]!;
      const input = {
        title: index % 3 === 0 ? `${pick()} ${pick()}` : `Title ${index}`,
        description: Array.from({ length: 8 + (next() % 10) }, pick).join(" "),
      };
      const before = classifyNovelText(input, artifact, LEGACY_TAG_CLASSIFIER_CONFIG_V2);
      const after = classifyNovelText(input, artifact, PRODUCTION_TAG_CLASSIFIER_CONFIG);
      expect(after.descriptionBoilerplate).toEqual({ matched: false, patternId: null });
      expect(after.candidates).toEqual(before.candidates);
      expect([after.rawEligibleCount, after.selectedCount, after.truncatedCount]).toEqual([before.rawEligibleCount, before.selectedCount, before.truncatedCount]);
    }
  });

  it("the previous config's result shape is untouched (no boilerplate key at all)", () => {
    const result = classifyNovelText({ title: "Royal", description: "x" }, artifact, LEGACY_TAG_CLASSIFIER_CONFIG_V2);
    expect("descriptionBoilerplate" in result).toBe(false);
  });
});

describe("B-23 the rule can be switched off as a whole", () => {
  const off = resolveProductionTagClassifierConfig({
    ...b23Config,
    description_boilerplate: { ...b23Config.description_boilerplate, enabled: false },
  });

  it("resolves to the previous config itself: same version, same fingerprint, no boilerplate", () => {
    expect(off).toBe(LEGACY_TAG_CLASSIFIER_CONFIG_V2);
    expect(off.version).toBe("2026-08-17-owner-final-c1-final");
    expect(off.fingerprint).toBe("2236bd35997c9ea933140a6fb0bac2e76ac75ebf5fcd8bef25ca3fc63d09d2d1");
    expect("descriptionBoilerplate" in off).toBe(false);
  });

  it("classifies byte-for-byte like the previous config, boilerplate descriptions included; switched on it does not", () => {
    const corpus = [
      { title: "Plain", description: `${BOILERPLATE} The royal soldier of a modern age.` },
      { title: "Royal", description: "Excerpt from a modern soldier's diary." },
      { title: "Zeppelin", description: "This is a reproduction of a book published before 1923. A royal soldier." },
      { title: "Plain", description: "A royal soldier of a modern age." },
      { title: "", description: "" },
    ];
    for (const input of corpus) {
      expect(JSON.stringify(classifyNovelText(input, artifact, off)))
        .toBe(JSON.stringify(classifyNovelText(input, artifact, LEGACY_TAG_CLASSIFIER_CONFIG_V2)));
    }
    // The switched-on result carries one extra descriptor key, so compare what is actually written: the tag candidates.
    const written = (input: (typeof corpus)[number], config: typeof PRODUCTION_TAG_CLASSIFIER_CONFIG) => JSON.stringify(classifyNovelText(input, artifact, config).candidates);
    const differs = corpus.filter((input) => written(input, PRODUCTION_TAG_CLASSIFIER_CONFIG) !== written(input, LEGACY_TAG_CLASSIFIER_CONFIG_V2));
    expect(differs.map((input) => input.description.slice(0, 12))).toEqual(["This work ha", "Excerpt from", "This is a re"]);
  });

  it("a hand-built config without the list behaves like the previous config for the same weights", () => {
    const plain = createFrozenTagClassifierConfig({ version: "plain", titleWeight: 30, descriptionWeight: 30, threshold: 30, maxTextTags: 3 });
    const input = { title: "Plain", description: `${BOILERPLATE} The royal soldier.` };
    expect(classifyNovelText(input, artifact, plain).candidates)
      .toEqual(classifyNovelText(input, artifact, LEGACY_TAG_CLASSIFIER_CONFIG_V2).candidates);
  });
});
