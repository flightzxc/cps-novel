import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  buildArtifactBundle,
  buildAuditQueue,
  buildC2Run,
  buildC2Cohort,
  C1_CONFIGURATIONS,
  C2_CONFIGURATIONS,
  findKeywordMatch,
  mergeReviewDecisions,
  scoreCalibration,
  summarizeC2Reviews,
  validatePreviewCorpus,
  validateSamples,
  validateTaxonomy,
  verifyArtifactBundle,
  wilsonInterval,
  writeArtifactBundle,
} from "../../../scripts/p2-06-5-lane-c/calibration.mjs";

function taxonomy() {
  return {
    taxonomyVersion: "candidate-v1",
    keywordLexiconVersion: "keywords-v1",
    canonicalTags: [
      {
        canonicalTagId: "wolf",
        slug: "wolf",
        definition: "Stories centered on werewolves or wolf shifters.",
        textSelectionPriority: 2,
        keywordCoverageStatus: "RELIABLE",
        keywords: [{ keywordId: "wolf-en", value: "werewolf", scriptBuckets: ["latin"], matchMode: "unicode_word", sourceLanguageCodes: ["en"], riskFlags: ["POLYSEMY_OR_PROPER_NAME"] }],
      },
      {
        canonicalTagId: "romance",
        slug: "romance",
        definition: "Stories where romantic relationship is a central theme.",
        textSelectionPriority: 1,
        keywordCoverageStatus: "RELIABLE",
        keywords: [{ keywordId: "romance-en", value: "romance", scriptBuckets: ["latin"], matchMode: "unicode_word", sourceLanguageCodes: ["en"], riskFlags: [] }],
      },
      {
        canonicalTagId: "revenge",
        slug: "revenge",
        definition: "Stories centered on revenge.",
        textSelectionPriority: 4,
        keywordCoverageStatus: "RELIABLE",
        keywords: [{ keywordId: "revenge-en", value: "revenge", scriptBuckets: ["latin"], matchMode: "auto", sourceLanguageCodes: ["en"], riskFlags: [] }],
      },
      {
        canonicalTagId: "ceo",
        slug: "ceo",
        definition: "Stories centered on a chief executive as a core trope.",
        textSelectionPriority: 3,
        keywordCoverageStatus: "RELIABLE",
        keywords: [{ keywordId: "ceo-zh", value: "总裁", scriptBuckets: ["cjk"], matchMode: "cjk_contiguous", sourceLanguageCodes: ["zh"], riskFlags: ["CJK_SUBSTRING"] }],
      },
      {
        canonicalTagId: "unsupported",
        slug: "unsupported",
        definition: "Tag without an approved keyword asset.",
        textSelectionPriority: 99,
        keywordCoverageStatus: "KEYWORD_COVERAGE_INSUFFICIENT",
        keywords: [],
      },
    ],
  };
}

function sample(overrides: Record<string, unknown> = {}) {
  return {
    sampleRowId: "sample-1",
    novelIdentity: "novel-1",
    sourceLanguageCode: "en",
    sourceLanguageName: "English",
    sourceSnapshotId: "snapshot-1",
    scriptBucket: "latin",
    title: "A Werewolf Romance",
    description: "A werewolf chooses romance, then seeks revenge. werewolf werewolf.",
    seriesTypeList: ["Werewolf"],
    sourceSnapshotComplete: true,
    manualSnapshotComplete: false,
    manualCanonicalTagIds: [],
    sourceObservedAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

function mapping() {
  return {
    mappingVersion: "approved-v1",
    approvalStatus: "APPROVED",
    mappings: [{ sourceLabelKind: "series_type", externalLabelValue: "Werewolf", canonicalTagIds: ["wolf"] }],
    mutuallyExclusivePairs: [["wolf", "ceo"]],
  };
}

function score(overrides: Record<string, unknown> = {}) {
  return scoreCalibration({
    samples: [sample()],
    taxonomy: taxonomy(),
    sourceMapping: mapping() as never,
    configurations: C1_CONFIGURATIONS,
    maxTextTags: [2, 3, 5],
    runId: "run-1",
    generatedAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  });
}

describe("P2-06.5 Lane C offline matcher and C1 scoring", () => {
  it("records every matching keyword but contributes each field bucket only once", () => {
    const result = score({ configurations: [C1_CONFIGURATIONS[1]], maxTextTags: [3] });
    const wolf = result.evidence.find((row) => row.canonicalTagId === "wolf")!;
    expect(wolf).toMatchObject({ titleMatched: true, descriptionMatched: true, titleScore: 30, descriptionScore: 25, totalScore: 55 });
    expect(wolf.descriptionMatches).toHaveLength(1);
    expect(wolf.selectedAfterCap).toBe(true);
  });

  it("uses Unicode word boundaries for Latin and does not match an embedded word", () => {
    const checked = validateSamples([sample({ title: "werewolfish", description: "", seriesTypeList: [] })]).samples[0];
    const tag = validateTaxonomy(taxonomy()).canonicalTags.find(({ canonicalTagId }: { canonicalTagId: string }) => canonicalTagId === "wolf")!;
    expect(findKeywordMatch(checked.title, tag.keywords[0], checked)).toBeNull();
    expect(findKeywordMatch("A Werewolf's Oath", tag.keywords[0], checked)).toMatchObject({ start: 2, end: 10, excerpt: "A Werewolf's Oath" });
  });

  it("uses contiguous CJK matching and emits UTF code-point spans", () => {
    const checked = validateSamples([sample({ sampleRowId: "zh", novelIdentity: "zh", sourceLanguageCode: "zh", sourceLanguageName: "中文", scriptBucket: "cjk", title: "霸道总裁", description: "", seriesTypeList: [] })]).samples[0];
    const tag = validateTaxonomy(taxonomy()).canonicalTags.find(({ canonicalTagId }: { canonicalTagId: string }) => canonicalTagId === "ceo")!;
    expect(findKeywordMatch(checked.title, tag.keywords[0], checked)).toMatchObject({ start: 2, end: 4, excerpt: "霸道总裁" });
  });

  it("fails closed for a tag without reliable keywords and unknown scripts", () => {
    const result = score({
      samples: [sample({ scriptBucket: "other", sourceLanguageCode: "ar", sourceLanguageName: "Arabic", title: "werewolf", description: "romance", seriesTypeList: [] })],
      configurations: [C1_CONFIGURATIONS[1]],
      maxTextTags: [3],
    });
    expect(result.evidence).toHaveLength(0);
    expect(result.summaries[0].overall.keywordCoverageInsufficientCount).toBe(1);
    expect(result.summaries[0].overall.textHitRate).toBe(0);
  });

  it("preserves A/B/C description thresholds and selects by score, priority, then id", () => {
    const result = score({
      samples: [sample({ title: "", description: "romance revenge", seriesTypeList: [] })],
      maxTextTags: [2],
    });
    const a = result.evidence.filter((row) => row.configId === "A" && row.maxTextTags === 2);
    const b = result.evidence.filter((row) => row.configId === "B" && row.maxTextTags === 2);
    const c = result.evidence.filter((row) => row.configId === "C" && row.maxTextTags === 2);
    expect(a.filter(({ selectedAfterCap }) => selectedAfterCap)).toHaveLength(0);
    expect(b.filter(({ selectedAfterCap }) => selectedAfterCap)).toHaveLength(0);
    expect(c.filter(({ selectedAfterCap }) => selectedAfterCap).map(({ canonicalTagId }) => canonicalTagId)).toEqual(["romance", "revenge"]);
  });

  it("does not apply a text cap to source evidence and records text cap drops", () => {
    const result = score({
      samples: [sample({ seriesTypeList: ["SourceOnly"] })],
      sourceMapping: {
        mappingVersion: "source-only-v1",
        approvalStatus: "APPROVED",
        mappings: [{ sourceLabelKind: "series_type", externalLabelValue: "SourceOnly", canonicalTagIds: ["ceo"] }],
        mutuallyExclusivePairs: [],
      },
      configurations: [C1_CONFIGURATIONS[2]],
      maxTextTags: [2],
    });
    const diagnostic = result.bookDiagnostics[0];
    expect(diagnostic).toMatchObject({ sourceMappedTagIds: ["ceo"], selectedTextTagCount: 2, truncatedTextTagCount: 1, finalTagCount: 3 });
    expect(result.evidence.filter(({ capDropReason }) => capDropReason === "MAX_TEXT_TAGS").map(({ canonicalTagId }) => canonicalTagId)).toEqual(["revenge"]);
  });

  it("uses channel + raw-language scope + exact token and never cross-maps identical tokens", () => {
    const scoped = score({
      samples: [sample({ channelAppId: "changdu-app", rawLanguageScope: "scope-en", seriesTypeList: ["Shared"] })],
      sourceMapping: {
        mappingVersion: "scoped-v1",
        approvalStatus: "APPROVED_OFFLINE_CANDIDATE_ONLY",
        mappings: [
          { channelAppId: "changdu-app", rawLanguageScope: "scope-en", sourceLabelKind: "series_type", externalLabelValue: "Shared", canonicalTagIds: ["wolf"] },
          { channelAppId: "changdu-app", rawLanguageScope: "scope-zh", sourceLabelKind: "series_type", externalLabelValue: "Shared", canonicalTagIds: ["ceo"] },
        ],
        mutuallyExclusivePairs: [],
      } as never,
      configurations: [C1_CONFIGURATIONS[0]],
      maxTextTags: [2],
    });
    expect(scoped.bookDiagnostics[0].sourceMappedTagIds).toEqual(["wolf"]);
  });

  it("excludes a complete manual snapshot from all text selection while preserving its final snapshot", () => {
    const result = score({
      samples: [sample({ manualSnapshotComplete: true, manualCanonicalTagIds: ["ceo"] })],
      configurations: [C1_CONFIGURATIONS[1]],
      maxTextTags: [3],
    });
    expect(result.bookDiagnostics[0]).toMatchObject({ selectedTextTagCount: 0, finalTagIds: ["ceo"], sourceTextRelation: "MANUAL_FULL_SNAPSHOT" });
    expect(result.evidence.every(({ textDecisionEligible }) => !textDecisionEligible)).toBe(true);
  });

  it("allows an empty complete manual snapshot to explicitly clear all labels", () => {
    const result = score({
      samples: [sample({ manualSnapshotComplete: true, manualCanonicalTagIds: [] })],
      configurations: [C1_CONFIGURATIONS[1]],
      maxTextTags: [3],
    });
    expect(result.bookDiagnostics[0]).toMatchObject({ selectedTextTagCount: 0, finalTagIds: [], sourceTextRelation: "MANUAL_FULL_SNAPSHOT" });
  });

  it("requires one upstream snapshot identifier and rejects partial manual labels", () => {
    expect(() => validateSamples([{ ...sample(), sourceSnapshotId: undefined }])).toThrow(/sourceSnapshotId/);
    expect(() => validateSamples([{ ...sample(), manualCanonicalTagIds: ["wolf"] }])).toThrow(/manualCanonicalTagIds requires/);
    const uncheckedMapping = { ...mapping(), approvalStatus: "PENDING" };
    expect(() => score({ sourceMapping: uncheckedMapping })).toThrow(/approvalStatus/);
  });
});

describe("P2-06.5 Lane C review and artifacts", () => {
  it("creates source-blind Terra cases, source conflict queue, and explicit strata shortfalls", () => {
    const result = score({ configurations: [C1_CONFIGURATIONS[1]], maxTextTags: [3] });
    const queue = buildAuditQueue(result, { targetPerStratum: 50 });
    const pair = queue.primaryCases.find(({ recordType }) => recordType === "TEXT_TAG_PAIR")!;
    expect(pair).toMatchObject({ blind: true, sourceEvidenceHidden: true });
    expect(pair).not.toHaveProperty("sourceMappedTagIds");
    expect(JSON.stringify(pair)).not.toContain("seriesTypeList");
    expect(queue.shortfalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ stratum: "TITLE_ONLY", shortfall: expect.any(Number) }),
      expect.objectContaining({ stratum: "HIGH_TAG_COUNT", shortfall: expect.any(Number) }),
      expect.objectContaining({ stratum: "SOURCE_TEXT_CONFLICT_REVIEW", shortfall: expect.any(Number) }),
    ]));
    expect(queue.shortfalls[0]).toHaveProperty("scriptBucket");
  });

  it("requires Sol for risky Terra cases and produces provisional weighted FP metrics", () => {
    const result = score({ configurations: [C1_CONFIGURATIONS[1]], maxTextTags: [3] });
    const queue = buildAuditQueue(result, { targetPerStratum: 1 });
    const reviews = queue.primaryCases.filter(({ recordType }) => recordType === "TEXT_TAG_PAIR").map((item, index) => ({
      auditCaseId: item.auditCaseId,
      reviewerRole: "terra",
      reviewerId: "terra-1",
      verdict: index === 0 ? "FALSE_POSITIVE" : "CORRECT",
      reviewConfidence: index === 0 ? "LOW" : "HIGH",
      reasonCodes: [],
    }));
    const risky = queue.primaryCases.find(({ recordType }) => recordType === "TEXT_TAG_PAIR")!;
    reviews.push({ auditCaseId: risky.auditCaseId, reviewerRole: "sol", reviewerId: "sol-1", finalVerdict: "FINAL_FALSE_POSITIVE", reasonCodes: [] } as never);
    const merged = mergeReviewDecisions(result, queue, reviews);
    expect(merged.solQueue.some(({ auditCaseId }: { auditCaseId: string }) => auditCaseId === risky.auditCaseId)).toBe(false);
    expect(merged.metrics[0]).toMatchObject({ estimatedTextFpRateScope: "CALIBRATION_PROVISIONAL_SAMPLE_FP", guardrailEligible: false });
    expect(wilsonInterval(0, 10)?.upper).toBeGreaterThan(0);
  });

  it("writes hash-verified immutable artifacts and retains no database or network imports", async () => {
    const result = score({ configurations: [C1_CONFIGURATIONS[1]], maxTextTags: [3] });
    const queue = buildAuditQueue(result, { targetPerStratum: 1 });
    const directory = await mkdtemp(join(tmpdir(), "lane-c-artifacts-"));
    const bundle = buildArtifactBundle(result, { auditQueue: queue as never });
    await writeArtifactBundle(directory, bundle);
    expect(await verifyArtifactBundle(directory)).toMatchObject({ ok: true, failures: [] });
    const manifest = JSON.parse(await readFile(join(directory, "lane-c-run-manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ lane: "P2-06.5/C", status: "CALIBRATION_REVIEW_PENDING" });
    expect(manifest.artifacts.map(({ path }: { path: string }) => path)).toContain("cap-diagnostics.jsonl");
    const evidence = JSON.parse((await readFile(join(directory, "text-evidence.jsonl"), "utf8")).split("\n")[0]);
    expect(evidence).toMatchObject({ calibrationStatus: "CALIBRATION_REVIEW_PENDING", recommendationStatus: "CALIBRATION_RECOMMENDATION_ONLY" });
    const source = await readFile(resolve(import.meta.dirname, "../../../scripts/p2-06-5-lane-c/calibration.mjs"), "utf8");
    expect(source).not.toMatch(/from\s+["']@prisma\/client["']/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toContain("createMoboreaderReadAdapter");
  });
});

describe("P2-06.5 Lane C C2 offline experiment", () => {
  function preview(body: string) {
    return [{
      sampleRowId: "sample-1",
      requestCount: 1,
      fetchDurationMs: 100,
      responseBytes: 1000,
      chapters: [{ chapterNumber: 1, body, contentHash: createHash("sha256").update(body).digest("hex"), charCount: Array.from(body).length }],
    }];
  }

  it("validates offline chapter hashes and runs only B baseline/chapter 10/chapter 15", () => {
    const checkedSamples = validateSamples([sample({ title: "", description: "", seriesTypeList: [] })]);
    const checkedPreview = validatePreviewCorpus(preview("werewolf romance"), checkedSamples.samples);
    const run = buildC2Run({ samples: checkedSamples, taxonomy: validateTaxonomy(taxonomy()), sourceMapping: null, previewCorpus: checkedPreview, runId: "c2", generatedAt: "now" });
    expect(run.configurations.map(({ id }) => id)).toEqual(C2_CONFIGURATIONS.map(({ id }) => id));
    expect(run.evidence.filter(({ configId, canonicalTagId }) => configId === "B_BASELINE" && canonicalTagId === "wolf")[0]).toMatchObject({ chapterScore: 0, selectedAfterCap: false });
    expect(run.evidence.filter(({ configId, canonicalTagId }) => configId === "B_CHAPTER_15" && canonicalTagId === "wolf")[0]).toMatchObject({ chapterScore: 15, selectedAfterCap: false });
    expect(run.chapterDelta[0]).toMatchObject({ comparedTo: "B_BASELINE", zeroHitReduction: 0 });
  });

  it("rejects a C2 chapter whose declared hash or code-point count differs", () => {
    const checkedSamples = validateSamples([sample()]);
    expect(() => validatePreviewCorpus([{ sampleRowId: "sample-1", requestCount: 1, fetchDurationMs: 1, responseBytes: 1, chapters: [{ chapterNumber: 1, body: "abc", contentHash: "bad", charCount: 3 }] }], checkedSamples.samples)).toThrow(/hash mismatch/);
  });

  it("keeps its deterministic C2 cohort within available preview rows and reports shortfalls", () => {
    const baseline = scoreCalibration({
      samples: [sample({ title: "", description: "", seriesTypeList: [] })],
      taxonomy: taxonomy(),
      configurations: [{ ...C2_CONFIGURATIONS[0] }],
      maxTextTags: [3],
    });
    const cohort = buildC2Cohort(baseline, { target: 150, eligibleSampleIds: new Set(["sample-1"]) as never });
    expect(cohort).toMatchObject({ actual: 1, unavailablePreviewCount: 0 });
    expect(cohort.categoryShortfalls.length).toBeGreaterThan(0);
  });

  it("keeps chapter delta review Owner-gated while counting correct and false-positive deltas", () => {
    const checkedSamples = validateSamples([sample({ title: "", description: "werewolf", seriesTypeList: [] })]);
    const checkedPreview = validatePreviewCorpus(preview("werewolf"), checkedSamples.samples);
    const run = buildC2Run({ samples: checkedSamples, taxonomy: validateTaxonomy(taxonomy()), sourceMapping: null, previewCorpus: checkedPreview, runId: "c2", generatedAt: "now" });
    const pair = run.chapterAuditQueue.find(({ recordType }) => recordType === "CHAPTER_DELTA_PAIR")!;
    const result = summarizeC2Reviews(run.chapterAuditQueue, [
      { auditCaseId: pair.auditCaseId, reviewerRole: "terra", reviewerId: "terra", verdict: "CORRECT", reviewConfidence: "HIGH", reasonCodes: [] },
      { auditCaseId: pair.auditCaseId, reviewerRole: "sol", reviewerId: "sol", finalVerdict: "FINAL_CORRECT", reasonCodes: [] },
    ]);
    expect(result).toMatchObject({ ownerDecisionRequired: true });
    expect(result.summaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ configId: pair.configId, finalCorrect: 1, addedFinalCorrect: 1, recommendation: "DEFER_OWNER_DECISION_REQUIRED" }),
    ]));
  });

  it("queues both C2 additions and cap-replaced removals for blind review", () => {
    const checkedSamples = validateSamples([sample({ title: "werewolf", description: "romance revenge", seriesTypeList: [] })]);
    const checkedPreview = validatePreviewCorpus(preview("werewolf romance revenge"), checkedSamples.samples);
    const run = buildC2Run({ samples: checkedSamples, taxonomy: validateTaxonomy(taxonomy()), sourceMapping: null, previewCorpus: checkedPreview, runId: "c2", generatedAt: "now" });
    const directions = run.chapterAuditQueue.filter(({ recordType }) => recordType === "CHAPTER_DELTA_PAIR").map(({ chapterDeltaDirection }) => chapterDeltaDirection);
    expect(directions).toContain("ADDED");
    expect(directions.every((value) => value === "ADDED" || value === "REMOVED")).toBe(true);
  });

  it("reserves a minimum of ten rows for every sufficiently represented script bucket", () => {
    const samples = Array.from({ length: 30 }, (_, index) => sample({
      sampleRowId: `row-${index}`,
      novelIdentity: `novel-${index}`,
      scriptBucket: index < 15 ? "latin" : "cjk",
      sourceLanguageCode: index < 15 ? "en" : "zh",
      sourceLanguageName: index < 15 ? "English" : "中文",
      title: index < 15 ? "" : "",
      description: "",
      seriesTypeList: [],
    }));
    const baseline = scoreCalibration({
      samples,
      taxonomy: taxonomy(),
      configurations: [{ ...C2_CONFIGURATIONS[0] }],
      maxTextTags: [3],
    });
    const cohort = buildC2Cohort(baseline, { target: 20, eligibleSampleIds: new Set(samples.map(({ sampleRowId }) => sampleRowId)) as never });
    expect(cohort.actual).toBe(20);
    expect(cohort.scriptBucketShortfalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ scriptBucket: "latin", selected: 10, shortfall: 0 }),
      expect.objectContaining({ scriptBucket: "cjk", selected: 10, shortfall: 0 }),
    ]));
  });
});

describe("P2-06.5 Lane C CLI", () => {
  it("accepts only local files and writes to the specified empty directory", async () => {
    const input = await mkdtemp(join(tmpdir(), "lane-c-cli-input-"));
    const output = join(input, "output");
    await writeFile(join(input, "samples.jsonl"), `${JSON.stringify(sample())}\n`, "utf8");
    await writeFile(join(input, "taxonomy.json"), JSON.stringify(taxonomy()), "utf8");
    const root = resolve(import.meta.dirname, "../../..");
    const child = spawnSync(process.execPath, [
      "scripts/p2-06-5-text-calibration.mjs", "score",
      "--samples", join(input, "samples.jsonl"),
      "--taxonomy", join(input, "taxonomy.json"),
      "--output-dir", output,
      "--run-id", "cli-test",
    ], { cwd: root, encoding: "utf8" });
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("CALIBRATION_REVIEW_PENDING");
    expect(await readFile(join(output, "LANE_C_REPORT.md"), "utf8")).toContain("LANE_C_C1_STATUS=CALIBRATION_REVIEW_PENDING");
  });
});
