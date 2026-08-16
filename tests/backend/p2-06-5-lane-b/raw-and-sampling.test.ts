import { describe, expect, it } from "vitest";

import {
  EXPLORATION_PAGES_PER_WAVE,
  HIGH_VALUE_NEIGHBOR_PAGES_PER_WAVE,
  HISTORICAL_CATALOG_ROWS,
  HTTP_ATTEMPT_CAP,
  INITIAL_PAGE_COUNT,
  LANE_B_ENDPOINT,
  MIN_REQUEST_START_INTERVAL_MS,
  PAGE_SIZE,
  PAGES_PER_WAVE,
  PLANNED_UNIQUE_PAGES,
  REQUEST_BODY_BASE,
  RETRY_BUDGET,
  SOURCE_LANGUAGE_UPPER_BOUND,
  TARGET_BOOKS,
  WAVE_COUNT,
  buildLaneBRequestBody,
} from "../../../scripts/p2-06-5-lane-b/constants.mjs";
import {
  exactBookIdentity,
  extractExactRawToken,
  extractSeriesTypeTokens,
  rawJsonIdentity,
  rawLanguageIdentity,
} from "../../../scripts/p2-06-5-lane-b/raw.mjs";
import {
  assessDiscoverySaturation,
  buildPageValueScores,
  buildDiscoveryCurve,
  calculatePageValue,
  calculatePageValueFromCounts,
  deriveLanguageQuotas,
  selectAdaptiveWavePages,
  selectInitialEquidistantPages,
  selectQuotaBooks,
} from "../../../scripts/p2-06-5-lane-b/sampling.mjs";

describe("P2-06.5 Lane B fixed read budget", () => {
  it("locks the one endpoint, five-field request, and 240+10 attempt envelope", () => {
    expect(LANE_B_ENDPOINT).toBe("https://kocserver-cn.cdreader.com/api/v1/res/getlistpc");
    expect(PAGE_SIZE).toBe(100);
    expect(TARGET_BOOKS).toBe(10_000);
    expect(HISTORICAL_CATALOG_ROWS).toBe(95_479);
    expect(SOURCE_LANGUAGE_UPPER_BOUND).toBe(18);
    expect(INITIAL_PAGE_COUNT).toBe(20);
    expect(WAVE_COUNT).toBe(22);
    expect(PAGES_PER_WAVE).toBe(10);
    expect(EXPLORATION_PAGES_PER_WAVE).toBe(6);
    expect(HIGH_VALUE_NEIGHBOR_PAGES_PER_WAVE).toBe(4);
    expect(PLANNED_UNIQUE_PAGES).toBe(240);
    expect(RETRY_BUDGET).toBe(10);
    expect(HTTP_ATTEMPT_CAP).toBe(250);
    expect(MIN_REQUEST_START_INTERVAL_MS).toBe(1_000);
    expect(INITIAL_PAGE_COUNT + WAVE_COUNT * PAGES_PER_WAVE).toBe(PLANNED_UNIQUE_PAGES);
    expect(PLANNED_UNIQUE_PAGES + RETRY_BUDGET).toBe(HTTP_ATTEMPT_CAP);
    expect(REQUEST_BODY_BASE).toEqual({ name: "", orderType: 1, pageSize: 100, projectType: 1 });
    expect(Object.isFrozen(REQUEST_BODY_BASE)).toBe(true);
    expect(buildLaneBRequestBody(23)).toEqual({
      name: "",
      orderType: 1,
      pageIndex: 23,
      pageSize: 100,
      projectType: 1,
    });
    expect(Object.keys(buildLaneBRequestBody(1))).toHaveLength(5);
    expect(() => buildLaneBRequestBody(0)).toThrow(/positive safe integer/);
  });
});

describe("P2-06.5 Lane B exact raw facts", () => {
  it("preserves empty, whitespace, Unicode form, quotes, and newlines byte-for-byte", () => {
    const nfc = "é";
    const nfd = "e\u0301";
    const raw = ["", "   ", " Mother", nfc, nfd, "\"quoted\"\nnext", "母亲", "😀"];
    const extracted = extractSeriesTypeTokens(raw);

    expect(extracted.complete).toBe(true);
    expect(extracted.rawSeriesTypeList).toBe(raw);
    expect(extracted.tokens.map(({ exactRawToken }: { exactRawToken: string }) => exactRawToken)).toEqual(raw);
    expect(extracted.tokens.map(({ rawItemJson }: { rawItemJson: string }) => rawItemJson)).toEqual(raw);
    expect(Buffer.from(extracted.tokens[4].exactRawToken, "utf8")).toEqual(Buffer.from(nfd, "utf8"));
    expect(extracted.tokens[3].exactRawToken).not.toBe(extracted.tokens[4].exactRawToken);
  });

  it("accepts an object only when value/name/label/id has exactly one own string candidate", () => {
    expect(extractExactRawToken({ value: "", name: 7 })).toMatchObject({
      ok: true,
      token: "",
      extractionPath: "$.value",
      candidateFields: ["value"],
    });
    expect(extractExactRawToken({ label: " romance ", other: "ignored" })).toMatchObject({
      ok: true,
      token: " romance ",
      extractionPath: "$.label",
    });
    expect(extractExactRawToken({ value: "A", name: "A" })).toEqual({
      ok: false,
      reason: "AMBIGUOUS_STRING_CANDIDATES",
      candidateFields: ["value", "name"],
    });
    expect(extractExactRawToken({ value: 1, id: false })).toEqual({
      ok: false,
      reason: "NO_STRING_CANDIDATE",
      candidateFields: [],
    });

    const inherited = Object.create({ value: "must-not-be-read" });
    expect(extractExactRawToken(inherited)).toEqual({
      ok: false,
      reason: "NO_STRING_CANDIDATE",
      candidateFields: [],
    });

    const rawList = [{ id: "raw-id" }, { value: "A", label: "B" }, null, 9];
    const extracted = extractSeriesTypeTokens(rawList);
    expect(extracted.tokens).toEqual([
      expect.objectContaining({ listIndex: 0, exactRawToken: "raw-id", rawItemJson: rawList[0] }),
    ]);
    expect(extracted.anomalies).toEqual([
      expect.objectContaining({ listIndex: 1, structureStatus: "AMBIGUOUS_OBJECT" }),
      expect.objectContaining({ listIndex: 2, structureStatus: "UNSUPPORTED_TYPE" }),
      expect.objectContaining({ listIndex: 3, structureStatus: "UNSUPPORTED_TYPE" }),
    ]);
  });

  it("keeps raw language JSON type + value identity and book keys collision-free", () => {
    expect(rawLanguageIdentity(2)).not.toBe(rawLanguageIdentity("2"));
    expect(rawLanguageIdentity(false)).not.toBe(rawLanguageIdentity("false"));
    expect(rawLanguageIdentity(null)).not.toBe(rawLanguageIdentity("null"));
    expect(rawLanguageIdentity(2)).not.toBe(rawLanguageIdentity(2, null));
    expect(rawLanguageIdentity(2, null)).not.toBe(rawLanguageIdentity(2, ""));
    expect(rawLanguageIdentity(2, "English")).not.toBe(rawLanguageIdentity(2, " English"));
    expect(() => rawLanguageIdentity(2, 9 as unknown as string)).toThrow(/languageName/);
    expect(rawJsonIdentity({ b: 2, a: "1" })).toBe(rawJsonIdentity({ a: "1", b: 2 }));
    expect(rawJsonIdentity(-0)).not.toBe(rawJsonIdentity(0));
    expect(() => rawJsonIdentity(undefined)).toThrow(/JSON values only/);
    expect(() => rawJsonIdentity(Number.MAX_SAFE_INTEGER + 1)).toThrow(/safe integer/u);

    expect(exactBookIdentity("changdu/app", "book/2", 2)).not.toBe(
      exactBookIdentity("changdu/app", "book/2", "2"),
    );
    expect(exactBookIdentity("a", "b\nc", "d")).not.toBe(exactBookIdentity("a\nb", "c", "d"));
  });
});

describe("P2-06.5 Lane B deterministic page plan", () => {
  it("selects twenty equidistant unique 1-based pages including both endpoints", () => {
    const pages = selectInitialEquidistantPages(955);
    expect(pages).toHaveLength(20);
    expect(new Set(pages).size).toBe(20);
    expect(pages[0]).toBe(1);
    expect(pages.at(-1)).toBe(955);
    expect(pages).toEqual(selectInitialEquidistantPages(955));
    const gaps = pages.slice(1).map((page, index) => page - pages[index]);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
    expect(selectInitialEquidistantPages(7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("selects six iterative largest-gap midpoints and four high-value neighbours per wave", () => {
    const sampledPages = [1, 11, 21, 31, 41, 51, 61, 71, 81, 91, 101, 111, 120];
    const first = selectAdaptiveWavePages({
      totalPages: 120,
      sampledPages,
      pageScores: new Map([[81, 100], [101, 90], [61, 80]]),
    });
    const second = selectAdaptiveWavePages({
      totalPages: 120,
      sampledPages: [...sampledPages].reverse(),
      pageScores: [[61, 80], [101, 90], [81, 100]],
    });

    expect(first.pages).toEqual(second.pages);
    expect(first.pages).toHaveLength(10);
    expect(new Set(first.pages).size).toBe(10);
    expect(first.explorationPages).toEqual([6, 16, 26, 36, 46, 56]);
    expect(first.neighborPages).toEqual([80, 82, 100, 102]);
    expect(first.pages.every((page: number) => !sampledPages.includes(page))).toBe(true);
    expect(first.pagePlan.filter(({ selectionReason }: { selectionReason: string }) => selectionReason === "LARGEST_GAP_MIDPOINT")).toHaveLength(6);
    expect(first.pagePlan.filter(({ selectionReason }: { selectionReason: string }) => selectionReason === "HIGH_VALUE_NEIGHBOR")).toHaveLength(4);
    expect(first.pagePlan.filter(({ selectionReason }: { selectionReason: string }) => selectionReason === "HIGH_VALUE_NEIGHBOR")
      .every((item) => "neighborDistance" in item && item.neighborDistance === 1)).toBe(true);
    expect(first.catalogueExhausted).toBe(false);
  });

  it("uses only direct high-value neighbours and fills any remaining slots with exploration", () => {
    const plan = selectAdaptiveWavePages({
      totalPages: 30,
      sampledPages: [1, 2, 3, 14, 15, 16, 28, 29, 30],
      pageScores: { 2: 100, 15: 90, 29: 80 },
    });
    const neighbors = plan.pagePlan.filter(({ selectionReason }: { selectionReason: string }) => (
      selectionReason === "HIGH_VALUE_NEIGHBOR"
    ));
    expect(neighbors.every((item) => "neighborDistance" in item && item.neighborDistance === 1)).toBe(true);
    expect(plan.pagePlan.filter(({ selectionReason }: { selectionReason: string }) => (
      selectionReason === "EXPLORATION_FALLBACK"
    ))).toHaveLength(4 - neighbors.length);
  });

  it("computes page values using the fixed 45/35/20 normalized formula", () => {
    expect(calculatePageValue({
      newTokensPerBook: 1,
      underQuotaLanguageYield: 0.5,
      underFiveTokenYield: 0.25,
    })).toBe(0.675);
    expect(calculatePageValueFromCounts({
      uniqueBookCount: 100,
      newDistinctTokenCount: 120,
      underQuotaLanguageBookCount: 50,
      underFiveTokenBookCount: 25,
    })).toEqual({
      newTokensPerBook: 1,
      underQuotaLanguageYield: 0.5,
      underFiveTokenYield: 0.25,
      score: 0.675,
    });
    expect(buildPageValueScores([
      { pageIndex: 2, newTokensPerBook: 0, underQuotaLanguageYield: 1, underFiveTokenYield: 0 },
      { pageIndex: 1, uniqueBookCount: 100, newDistinctTokenCount: 100, underQuotaLanguageBookCount: 0, underFiveTokenBookCount: 0 },
    ])).toEqual([
      expect.objectContaining({ pageIndex: 1, score: 0.45 }),
      expect.objectContaining({ pageIndex: 2, score: 0.35 }),
    ]);
    expect(() => calculatePageValue({
      newTokensPerBook: 1.1,
      underQuotaLanguageYield: 0,
      underFiveTokenYield: 0,
    })).toThrow(/0 to 1/);
  });
});

describe("P2-06.5 Lane B deterministic 10k quota sample", () => {
  it("meets feasible raw-language quotas, prioritises coverage, and returns exactly 10k unique books", () => {
    const languages = [rawLanguageIdentity("en"), rawLanguageIdentity("zh"), rawLanguageIdentity(7)];
    const books = Array.from({ length: 10_050 }, (_, index) => {
      const rawLanguage = index < 4_000 ? "en" : index < 8_000 ? "zh" : 7;
      return {
        bookIdentity: `book-${String(index).padStart(5, "0")}`,
        rawLanguage,
        acquisitionIndex: index + 1,
        selectionPriority: index % 17,
        exactRawTokens: [index % 100 === 0 ? `rare-${index}` : "common"],
      };
    });
    const options = {
      languageQuotas: [
        { rawLanguageIdentity: languages[0], quota: 1_500 },
        { rawLanguageIdentity: languages[1], quota: 1_200 },
        { rawLanguageIdentity: languages[2], quota: 500 },
      ],
    };
    const selected = selectQuotaBooks({ books, ...options });
    const reversed = selectQuotaBooks({ books: [...books].reverse(), ...options });

    expect(selected.targetBooks).toBe(10_000);
    expect(selected.selectedCount).toBe(10_000);
    expect(selected.complete).toBe(true);
    expect(selected.quotaSatisfied).toBe(true);
    expect(new Set(selected.selectedBookIdentities).size).toBe(10_000);
    expect(selected.selectedBookIdentities).toEqual(reversed.selectedBookIdentities);
    expect(selected.quotaResults).toEqual([
      expect.objectContaining({ rawLanguageIdentity: languages[2], quota: 500, selectedForQuota: 500, deficit: 0 }),
      expect.objectContaining({ rawLanguageIdentity: languages[0], quota: 1_500, selectedForQuota: 1_500, deficit: 0 }),
      expect.objectContaining({ rawLanguageIdentity: languages[1], quota: 1_200, selectedForQuota: 1_200, deficit: 0 }),
    ].sort((left, right) => String(left.rawLanguageIdentity).localeCompare(String(right.rawLanguageIdentity))));
    expect(selected.selectionAudit[0]).toMatchObject({ selectionIndex: 1, selectionReason: "TOKEN_DEFICIT_COVERAGE" });
  });

  it("reports quota deficits instead of inventing books, while still filling globally", () => {
    const tinyLanguage = rawLanguageIdentity("tiny");
    const books = [
      ...Array.from({ length: 2 }, (_, index) => ({ bookIdentity: `tiny-${index}`, rawLanguage: "tiny" })),
      ...Array.from({ length: 10 }, (_, index) => ({ bookIdentity: `other-${index}`, rawLanguage: "other" })),
    ];
    const result = selectQuotaBooks({
      books,
      targetBooks: 10,
      languageQuotas: [{ rawLanguageIdentity: tinyLanguage, quota: 5 }],
    });
    expect(result.selectedCount).toBe(10);
    expect(result.complete).toBe(true);
    expect(result.quotaSatisfied).toBe(false);
    expect(result.quotaResults).toEqual([
      expect.objectContaining({ quota: 5, selectedForQuota: 2, deficit: 3 }),
    ]);
  });

  it("reserves quota capacity when one language has more unique tokens than the 10k target", () => {
    const books = [
      ...Array.from({ length: 12_000 }, (_, index) => ({
        bookIdentity: `a-${String(index).padStart(5, "0")}`,
        rawLanguage: "A",
        exactRawTokens: [`a-unique-${index}`],
      })),
      ...Array.from({ length: 1_000 }, (_, index) => ({
        bookIdentity: `b-${String(index).padStart(4, "0")}`,
        rawLanguage: "B",
        exactRawTokens: ["b-shared"],
      })),
    ];

    const selected = selectQuotaBooks({ books });
    const languageB = selected.quotaResults.find(({ rawLanguageIdentity: value }: { rawLanguageIdentity: string }) => (
      value === rawLanguageIdentity("B")
    ));
    expect(selected.selectedCount).toBe(10_000);
    expect(selected.quotaSatisfied).toBe(true);
    expect(languageB).toMatchObject({ available: 1_000, quota: 503, selectedForQuota: 503, deficit: 0 });
  });

  it("derives size/richness quotas and keeps every discovered token represented", () => {
    const books = [
      ...Array.from({ length: 299 }, (_, index) => ({
        bookIdentity: `small-${index}`,
        rawLanguage: "small",
        exactRawTokens: [index === 0 ? "small-rare" : "small-common"],
      })),
      ...Array.from({ length: 600 }, (_, index) => ({
        bookIdentity: `medium-${index}`,
        rawLanguage: "medium",
        exactRawTokens: [`medium-${index % 40}`],
      })),
      ...Array.from({ length: 1_600 }, (_, index) => ({
        bookIdentity: `large-${index}`,
        rawLanguage: "large",
        exactRawTokens: [`large-${index % 120}`],
      })),
    ];
    const plan = deriveLanguageQuotas(books, { targetBooks: 3_000 });
    const quotaByRawScope = new Map(plan.quotas.map((item: { rawLanguageIdentity: string; quota: number }) => [item.rawLanguageIdentity, item.quota]));
    expect(quotaByRawScope.get(rawLanguageIdentity("small"))).toBe(299);
    expect(quotaByRawScope.get(rawLanguageIdentity("medium"))).toBeGreaterThanOrEqual(500);
    expect(quotaByRawScope.get(rawLanguageIdentity("medium"))).toBeLessThanOrEqual(800);
    expect(quotaByRawScope.get(rawLanguageIdentity("large"))).toBeGreaterThanOrEqual(1_000);
    expect(quotaByRawScope.get(rawLanguageIdentity("large"))).toBeLessThanOrEqual(1_500);
    expect(plan.derivedQuotaTotal).toBeLessThanOrEqual(2_499);

    const selected = selectQuotaBooks({ books, targetBooks: 2_000 });
    expect(selected.selectedCount).toBe(2_000);
    expect(selected.derivedQuotaPlan).not.toBeNull();
    expect(selected.tokenCoverage.coveredTokenCount).toBe(selected.tokenCoverage.discoveredTokenCount);
    expect(selected.selectedBookIdentities).toContain("small-0");
  });

  it("compresses excessive language quotas with a 300 base before richness allocation", () => {
    const books = Array.from({ length: 19_200 }, (_, index) => {
      const languageIndex = Math.floor(index / 1_600);
      const language = `lang-${languageIndex}`;
      return {
        bookIdentity: `book-${index}`,
        rawLanguage: language,
        exactRawTokens: [`${language}-token-${index % (100 + languageIndex)}`],
      };
    });
    const plan = deriveLanguageQuotas(books);
    expect(plan.compressedToTarget).toBe(true);
    expect(plan.derivedQuotaTotal).toBe(10_000);
    expect(plan.quotas.every(({ quota }: { quota: number }) => quota >= 300)).toBe(true);
    const richest = plan.quotas.find(({ rawLanguageIdentity: value }: { rawLanguageIdentity: string }) => (
      value === rawLanguageIdentity("lang-11")
    ));
    const leastRich = plan.quotas.find(({ rawLanguageIdentity: value }: { rawLanguageIdentity: string }) => (
      value === rawLanguageIdentity("lang-0")
    ));
    expect(richest!.quota).toBeGreaterThanOrEqual(leastRich!.quota);
  });
});

describe("P2-06.5 Lane B discovery curves and conservative saturation", () => {
  const observations = Array.from({ length: 10_000 }, (_, index) => ({
    bookIdentity: `book-${String(index).padStart(5, "0")}`,
    rawLanguage: "en",
    acquisitionIndex: index + 1,
    selectedSampleIndex: index + 1,
    tokenIdentities: [index < 7_000 ? `seed-${index}` : `stable-tail-${Math.floor((index - 7_000) / 1_000)}`],
  }));

  it("emits candidate/global and final/global curves per 1k plus final/raw-language per 500", () => {
    const candidate = buildDiscoveryCurve(observations, { stage: "candidate_acquisition" });
    const finalGlobal = buildDiscoveryCurve(observations, { stage: "final_sample" });
    const languageIdentity = rawLanguageIdentity("en");
    const finalLanguage = buildDiscoveryCurve(observations, {
      stage: "final_sample",
      rawLanguageIdentity: languageIdentity,
    });

    expect(candidate).toHaveLength(10);
    expect(candidate[0]).toMatchObject({ stage: "candidate_acquisition", checkpointScope: "global", sampleSize: 1_000 });
    expect(candidate.at(-1)).toMatchObject({ sampleSize: 10_000, cumulativeDistinctTokens: 7_003 });
    expect(finalGlobal).toHaveLength(10);
    expect(finalGlobal.every(({ checkpointEvery }: { checkpointEvery: number }) => checkpointEvery === 1_000)).toBe(true);
    expect(finalLanguage).toHaveLength(20);
    expect(finalLanguage[0]).toMatchObject({
      stage: "final_sample",
      checkpointScope: "raw_language",
      rawLanguageIdentity: languageIdentity,
      checkpointEvery: 500,
      sampleSize: 500,
    });
  });

  it("requires 10k, three stable full global blocks, stable represented-language tails, and every QA gate", () => {
    const globalCurve = buildDiscoveryCurve(observations, { stage: "final_sample" });
    const languageCurve = buildDiscoveryCurve(observations, {
      stage: "final_sample",
      rawLanguageIdentity: rawLanguageIdentity("en"),
    });
    const result = assessDiscoverySaturation({
      globalCurve,
      languageCurves: [languageCurve],
      actualSampleCount: 10_000,
      quotaSatisfied: true,
      rawRoundTripVerified: true,
      actualUniquePages: 240,
      actualHttpAttempts: 250,
      retryAttempts: 10,
    });

    expect(result.status).toBe("TAXONOMY_DISCOVERY_SATURATED");
    expect(result.saturated).toBe(true);
    expect(result.globalTailAssessments).toHaveLength(3);
    expect(result.globalTailAssessments.every(({ stable }: { stable: boolean }) => stable)).toBe(true);
    expect(result.languageAssessments).toEqual([
      expect.objectContaining({ sampleCount: 10_000, applicable: true, stable: true }),
    ]);
    expect(result.qaFlags).toEqual({
      quotaSatisfied: true,
      rawRoundTripVerified: true,
      requestBudgetRespected: true,
    });

    const short = assessDiscoverySaturation({
      globalCurve: globalCurve.slice(0, 9),
      actualSampleCount: 9_000,
      quotaSatisfied: true,
      rawRoundTripVerified: true,
      requestBudgetRespected: true,
    });
    expect(short.status).toBe("TAXONOMY_DISCOVERY_NOT_SATURATED");
    expect(short.checks.targetBooksMet).toBe(false);

    const overBudget = assessDiscoverySaturation({
      globalCurve,
      languageCurves: [languageCurve],
      actualSampleCount: 10_000,
      quotaSatisfied: true,
      rawRoundTripVerified: true,
      actualUniquePages: 241,
      actualHttpAttempts: 251,
      retryAttempts: 10,
    });
    expect(overBudget.status).toBe("TAXONOMY_DISCOVERY_NOT_SATURATED");
    expect(overBudget.checks.requestBudgetRespected).toBe(false);
  });
});
