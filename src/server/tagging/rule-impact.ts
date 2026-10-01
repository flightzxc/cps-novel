import type { Prisma, PrismaClient } from "@prisma/client";

import { classifyNovelText } from "@/lib/tagging/classifier";
import type { FrozenTagClassifierConfig } from "@/lib/tagging/classifier-config";
import { detectDescriptionBoilerplate } from "@/lib/tagging/description-boilerplate";
import type { KeywordRuleArtifact } from "@/lib/tagging/keyword-artifact";
import {
  iterateNovelClassificationSnapshotPages,
  type NovelClassificationScope,
} from "./auto-classification";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Read-only impact report for a classifier rule change (B-23).
 *
 * "What would a `reclassify_existing` run change, per locale, if the candidate
 * classifier config replaced the baseline one?" -- answered without creating a
 * task or writing a row. The comparison is baseline-config classification vs
 * candidate-config classification of the SAME current title/description and the
 * SAME keyword authority, so it isolates the rule change itself. For a book
 * whose stored auto tags were produced by the baseline config from unchanged
 * text, that is exactly the difference the reclassification would write.
 *
 * Only books the candidate rule can touch are classified: a description that
 * does not match the boilerplate list reaches the classifier unchanged, so both
 * configs produce identical output for it (a test pins this). That keeps a full
 * 80,000-book scan to a paged read plus substring checks instead of 160,000
 * classifier runs.
 */

export interface RuleImpactCounts {
  /** Every non-deleted novel in scope. */
  novelsScanned: number;
  /** Manual-mode novels: never reclassified, never changed. */
  novelsManualSkipped: number;
  /** Automatic-mode novels: what reclassify_existing would visit. */
  novelsEligible: number;
  /** Eligible novels whose description matched the candidate boilerplate list. */
  novelsBoilerplateMatched: number;
  /** Matched novels whose selected tag SET differs between baseline and candidate. */
  novelsChanged: number;
  /** Matched novels whose tag set is unchanged but whose stored score/evidence would change. */
  novelsScoreOnlyChanged: number;
  /** Matched novels that had at least one baseline auto tag and have none under the candidate. */
  novelsLosingAllAutoTags: number;
  /** Tags the baseline selects that the candidate does not. */
  tagsRemoved: number;
  /** Tags the candidate selects that the baseline did not (a freed max-tags slot can admit a lower-ranked tag). */
  tagsAdded: number;
  /** Matched novels per boilerplate pattern id (a book counts under the first pattern, in list order, it matches). */
  patternHits: Record<string, number>;
}

export interface LocaleRuleImpact extends RuleImpactCounts {
  locale: string;
}

export interface RuleImpactReport {
  baseline: { classifierConfigVersion: string; classifierConfigFingerprint: string };
  candidate: {
    classifierConfigVersion: string;
    classifierConfigFingerprint: string;
    descriptionBoilerplate: { version: string; sha256: string; patternCount: number } | null;
  };
  authority: { taxonomyVersion: string; taxonomySha256: string; keywordLexiconVersion: string; keywordFingerprint: string };
  totals: RuleImpactCounts;
  perLocale: LocaleRuleImpact[];
  assumptions: string[];
}

function emptyCounts(): RuleImpactCounts {
  return {
    novelsScanned: 0, novelsManualSkipped: 0, novelsEligible: 0, novelsBoilerplateMatched: 0, novelsChanged: 0,
    novelsScoreOnlyChanged: 0, novelsLosingAllAutoTags: 0, tagsRemoved: 0, tagsAdded: 0, patternHits: {},
  };
}

function sortedHits(hits: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(hits).sort(([left], [right]) => left.localeCompare(right, "en")));
}

function addInto(target: RuleImpactCounts, source: RuleImpactCounts): void {
  target.novelsScanned += source.novelsScanned;
  target.novelsManualSkipped += source.novelsManualSkipped;
  target.novelsEligible += source.novelsEligible;
  target.novelsBoilerplateMatched += source.novelsBoilerplateMatched;
  target.novelsChanged += source.novelsChanged;
  target.novelsScoreOnlyChanged += source.novelsScoreOnlyChanged;
  target.novelsLosingAllAutoTags += source.novelsLosingAllAutoTags;
  target.tagsRemoved += source.tagsRemoved;
  target.tagsAdded += source.tagsAdded;
  for (const [id, count] of Object.entries(source.patternHits)) target.patternHits[id] = (target.patternHits[id] ?? 0) + count;
}

export interface SummarizeRuleImpactInput {
  scope: NovelClassificationScope;
  artifact: KeywordRuleArtifact;
  baseline: FrozenTagClassifierConfig;
  candidate: FrozenTagClassifierConfig;
  pageSize?: number;
}

export async function summarizeRuleImpact(db: Db, input: SummarizeRuleImpactInput): Promise<RuleImpactReport> {
  const { artifact, baseline, candidate } = input;
  const byLocale = new Map<string, RuleImpactCounts>();
  const rule = candidate.descriptionBoilerplate ?? null;

  for await (const page of iterateNovelClassificationSnapshotPages(db, input.scope, { pageSize: input.pageSize })) {
    for (const snapshot of page) {
      const counts = byLocale.get(snapshot.locale) ?? emptyCounts();
      byLocale.set(snapshot.locale, counts);
      counts.novelsScanned += 1;
      if (snapshot.mode !== "automatic") {
        counts.novelsManualSkipped += 1;
        continue;
      }
      counts.novelsEligible += 1;
      const match = rule ? detectDescriptionBoilerplate(snapshot.description, rule) : null;
      if (!match) continue;
      counts.novelsBoilerplateMatched += 1;
      counts.patternHits[match.patternId] = (counts.patternHits[match.patternId] ?? 0) + 1;

      const before = classifyNovelText(snapshot, artifact, baseline);
      const after = classifyNovelText(snapshot, artifact, candidate);
      const beforeScores = new Map(before.candidates.map((tag) => [tag.canonicalTagId, tag.score]));
      const afterScores = new Map(after.candidates.map((tag) => [tag.canonicalTagId, tag.score]));
      const removed = [...beforeScores.keys()].filter((id) => !afterScores.has(id)).length;
      const added = [...afterScores.keys()].filter((id) => !beforeScores.has(id)).length;
      counts.tagsRemoved += removed;
      counts.tagsAdded += added;
      if (removed > 0 || added > 0) counts.novelsChanged += 1;
      else if ([...beforeScores].some(([id, score]) => afterScores.get(id) !== score)) counts.novelsScoreOnlyChanged += 1;
      if (beforeScores.size > 0 && afterScores.size === 0) counts.novelsLosingAllAutoTags += 1;
    }
  }

  const totals = emptyCounts();
  const perLocale: LocaleRuleImpact[] = [...byLocale.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([locale, counts]) => {
      addInto(totals, counts);
      return { locale, ...counts, patternHits: sortedHits(counts.patternHits) };
    });
  totals.patternHits = sortedHits(totals.patternHits);

  return {
    baseline: { classifierConfigVersion: baseline.version, classifierConfigFingerprint: baseline.fingerprint },
    candidate: {
      classifierConfigVersion: candidate.version,
      classifierConfigFingerprint: candidate.fingerprint,
      descriptionBoilerplate: rule ? { version: rule.version, sha256: rule.sha256, patternCount: rule.patterns.length } : null,
    },
    authority: {
      taxonomyVersion: artifact.taxonomyVersion,
      taxonomySha256: artifact.taxonomySha256,
      keywordLexiconVersion: artifact.keywordLexiconVersion,
      keywordFingerprint: artifact.keywordFingerprint,
    },
    totals,
    perLocale,
    assumptions: [
      "Baseline = what the baseline config classifies from each book's CURRENT title and description with the CURRENT keyword authority; it equals the stored auto tags only for books classified by that config on unchanged text.",
      "Books whose description does not match the boilerplate list are not classified: both configs give them identical output.",
      "Manual-mode books are never reclassified and are never counted as changed.",
      "Upstream-mapped tags and manual tags are outside the classifier and are not in these numbers.",
    ],
  };
}
