import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  createFrozenTagClassifierConfig,
  LEGACY_TAG_CLASSIFIER_CONFIG_V2,
  PRODUCTION_TAG_CLASSIFIER_CONFIG,
} from "@/lib/tagging/classifier-config";
import { CANONICAL_TAG_V1_SHA256, validateKeywordRuleArtifact } from "@/lib/tagging/keyword-artifact";
import { summarizeRuleImpact } from "@/server/tagging/rule-impact";

// B-23 read-only impact report: per locale, how many books the rule change
// touches, how many tags it removes (or admits), which patterns hit. The
// descriptions are publisher template sentences plus synthetic keywords.

function tag(stableId: string, value: string) {
  return {
    canonicalTagId: `id-${stableId}`,
    stableId,
    textSelectionPriority: 0,
    keywords: [{ keywordId: `kw-${stableId}`, value, scriptBuckets: ["latin" as const], matchMode: "unicode_word" as const, riskFlags: [] }],
  };
}
const artifact = validateKeywordRuleArtifact({
  schemaVersion: 1, taxonomyVersion: "canonical-tag-v1", taxonomySha256: CANONICAL_TAG_V1_SHA256, keywordLexiconVersion: "fixture-lexicon-v1",
  tags: [tag("ct-v1-modern", "modern"), tag("ct-v1-royal", "royal"), tag("ct-v1-soldier", "soldier"), tag("ct-v1-zeppelin", "zeppelin")],
});

const BP1 = "This work has been selected by scholars as being culturally important and is part of the knowledge base of civilization as we know it.";
const BP8 = "Excerpt from a long forgotten volume.";

type Row = { id: string; title: string; description: string; locale: string; tagState: { mode: string; currentAutoRunId: string | null } | null; sourceItems: never[] };
let counter = 0;
const row = (locale: string, title: string, description: string, mode: "automatic" | "manual" | null = null): Row => {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`, title, description, locale,
    tagState: mode ? { mode, currentAutoRunId: null } : null, sourceItems: [],
  };
};

function fakeDb(rows: readonly Row[]) {
  const findMany = vi.fn(({ where, take }: { where: { id?: { gt?: string } }; take: number }) => {
    const cursor = where.id?.gt;
    const start = cursor === undefined ? 0 : rows.findIndex((r) => r.id === cursor) + 1;
    return Promise.resolve(rows.slice(start, start + take));
  });
  // Only `novel.findMany` exists: any other call (a write, another table) throws.
  return { db: { novel: { findMany } } as unknown as PrismaClient, findMany };
}

describe("B-23 rule impact report", () => {
  const rows: Row[] = [
    // en: loses its only tag (description-only hits)
    row("en", "Plain", `${BP1} A royal soldier.`),
    // en: boilerplate but the title carries the tags -> same set, lower score only
    row("en", "Royal Soldier", `${BP1} A royal soldier.`),
    // en: freed slot admits the title-only tag; three description tags removed
    row("en", "Zeppelin", `${BP1} A modern royal soldier.`),
    // en: matched, nothing to match anyway
    row("en", "Plain", BP8),
    // en: ordinary description, untouched
    row("en", "Plain", "A royal soldier."),
    // en: manual mode, boilerplate -> never counted as changed
    row("en", "Plain", `${BP1} A royal soldier.`, "manual"),
    // fr: one more of each kind
    row("fr", "Plain", `${BP1} A modern age.`),
    row("fr", "Plain", "A royal age."),
  ];

  it("reports per-locale and total counts, removed/admitted tags and per-pattern hits", async () => {
    const { db } = fakeDb(rows);
    const report = await summarizeRuleImpact(db, {
      scope: { all: true }, artifact, baseline: LEGACY_TAG_CLASSIFIER_CONFIG_V2, candidate: PRODUCTION_TAG_CLASSIFIER_CONFIG, pageSize: 3,
    });
    const en = report.perLocale.find((entry) => entry.locale === "en")!;
    expect(en).toEqual({
      locale: "en",
      novelsScanned: 6, novelsManualSkipped: 1, novelsEligible: 5, novelsBoilerplateMatched: 4,
      novelsChanged: 2,          // #1 (loses royal+soldier) and #3 (loses 3, admits zeppelin)
      novelsScoreOnlyChanged: 1, // #2
      novelsLosingAllAutoTags: 1, // #1
      tagsRemoved: 5, tagsAdded: 1,
      patternHits: { "bp-001": 3, "bp-008": 1 },
    });
    const fr = report.perLocale.find((entry) => entry.locale === "fr")!;
    expect(fr).toMatchObject({
      novelsScanned: 2, novelsEligible: 2, novelsBoilerplateMatched: 1, novelsChanged: 1, novelsLosingAllAutoTags: 1,
      tagsRemoved: 1, tagsAdded: 0, patternHits: { "bp-001": 1 },
    });
    expect(report.perLocale.map((entry) => entry.locale)).toEqual(["en", "fr"]);
    expect(report.totals).toEqual({
      novelsScanned: 8, novelsManualSkipped: 1, novelsEligible: 7, novelsBoilerplateMatched: 5, novelsChanged: 3,
      novelsScoreOnlyChanged: 1, novelsLosingAllAutoTags: 2, tagsRemoved: 6, tagsAdded: 1, patternHits: { "bp-001": 4, "bp-008": 1 },
    });
    expect(report.baseline).toEqual({ classifierConfigVersion: LEGACY_TAG_CLASSIFIER_CONFIG_V2.version, classifierConfigFingerprint: LEGACY_TAG_CLASSIFIER_CONFIG_V2.fingerprint });
    expect(report.candidate).toEqual({
      classifierConfigVersion: PRODUCTION_TAG_CLASSIFIER_CONFIG.version,
      classifierConfigFingerprint: PRODUCTION_TAG_CLASSIFIER_CONFIG.fingerprint,
      descriptionBoilerplate: { version: "description-boilerplate-v1", sha256: PRODUCTION_TAG_CLASSIFIER_CONFIG.descriptionBoilerplate!.sha256, patternCount: 15 },
    });
    expect(report.authority).toMatchObject({ taxonomySha256: artifact.taxonomySha256, keywordFingerprint: artifact.keywordFingerprint });
    expect(report.assumptions.length).toBeGreaterThan(0);
  });

  it("is independent of the read page size, and a locale scope sees only that locale", async () => {
    const full = await summarizeRuleImpact(fakeDb(rows).db, { scope: { all: true }, artifact, baseline: LEGACY_TAG_CLASSIFIER_CONFIG_V2, candidate: PRODUCTION_TAG_CLASSIFIER_CONFIG });
    for (const pageSize of [1, 2, 5]) {
      const paged = await summarizeRuleImpact(fakeDb(rows).db, { scope: { all: true }, artifact, baseline: LEGACY_TAG_CLASSIFIER_CONFIG_V2, candidate: PRODUCTION_TAG_CLASSIFIER_CONFIG, pageSize });
      expect(paged).toEqual(full);
    }
    const { db, findMany } = fakeDb(rows.filter((r) => r.locale === "fr"));
    const onlyFr = await summarizeRuleImpact(db, { scope: { locale: "fr" }, artifact, baseline: LEGACY_TAG_CLASSIFIER_CONFIG_V2, candidate: PRODUCTION_TAG_CLASSIFIER_CONFIG });
    expect(onlyFr.perLocale.map((entry) => entry.locale)).toEqual(["fr"]);
    expect(findMany.mock.calls[0]![0].where).toMatchObject({ locale: "fr" });
  });

  it("a candidate without the boilerplate list changes nothing", async () => {
    const plain = createFrozenTagClassifierConfig({ version: "plain", titleWeight: 30, descriptionWeight: 30, threshold: 30, maxTextTags: 3 });
    const report = await summarizeRuleImpact(fakeDb(rows).db, { scope: { all: true }, artifact, baseline: LEGACY_TAG_CLASSIFIER_CONFIG_V2, candidate: plain });
    expect(report.candidate.descriptionBoilerplate).toBeNull();
    expect(report.totals).toMatchObject({ novelsScanned: 8, novelsEligible: 7, novelsBoilerplateMatched: 0, novelsChanged: 0, tagsRemoved: 0, tagsAdded: 0, patternHits: {} });
  });

  it("only classifies the books the rule can touch: the unmatched books' output is the same under both configs", async () => {
    // The report skips classifying books whose description does not match, which is only sound
    // because both configs classify them identically (also pinned in classifier-b23.test.ts).
    const { classifyNovelText } = await import("@/lib/tagging/classifier");
    for (const r of rows.filter((entry) => entry.description === "A royal soldier." || entry.description === "A royal age.")) {
      expect(classifyNovelText(r, artifact, PRODUCTION_TAG_CLASSIFIER_CONFIG).candidates)
        .toEqual(classifyNovelText(r, artifact, LEGACY_TAG_CLASSIFIER_CONFIG_V2).candidates);
    }
  });
});
