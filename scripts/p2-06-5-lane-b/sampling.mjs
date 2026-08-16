import {
  EXPLORATION_PAGES_PER_WAVE,
  HIGH_VALUE_NEIGHBOR_PAGES_PER_WAVE,
  HTTP_ATTEMPT_CAP,
  INITIAL_PAGE_COUNT,
  PAGES_PER_WAVE,
  PLANNED_UNIQUE_PAGES,
  RETRY_BUDGET,
  TARGET_BOOKS,
} from "./constants.mjs";
import { rawJsonIdentity, rawLanguageIdentity as encodeRawLanguageIdentity } from "./raw.mjs";

const GLOBAL_DISCOVERY_BLOCK = 1_000;
const LANGUAGE_DISCOVERY_BLOCK = 500;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function pageSet(pages, totalPages, label = "sampledPages") {
  if (!pages || typeof pages[Symbol.iterator] !== "function") {
    throw new TypeError(`${label} must be iterable`);
  }
  const result = new Set();
  for (const page of pages) {
    positiveInteger(page, `${label} page`);
    if (page > totalPages) throw new RangeError(`${label} page exceeds totalPages`);
    result.add(page);
  }
  return result;
}

/**
 * Select 1-based pages at equal intervals, always including both catalogue
 * endpoints when at least two pages are requested.
 */
export function selectInitialEquidistantPages(totalPages, count = INITIAL_PAGE_COUNT) {
  positiveInteger(totalPages, "totalPages");
  positiveInteger(count, "count");
  const desired = Math.min(totalPages, count);
  if (desired === 1) return [1];

  const pages = [];
  for (let index = 0; index < desired; index += 1) {
    const offset = Math.round((index * (totalPages - 1)) / (desired - 1));
    pages.push(offset + 1);
  }
  return pages;
}

function gapCandidates(totalPages, excluded) {
  const anchors = [0, ...[...excluded].sort((left, right) => left - right), totalPages + 1];
  const candidates = [];
  for (let index = 0; index < anchors.length - 1; index += 1) {
    const left = anchors[index];
    const right = anchors[index + 1];
    const unsampledCount = right - left - 1;
    if (unsampledCount < 1) continue;
    candidates.push({
      left,
      right,
      unsampledCount,
      pageIndex: left + Math.ceil(unsampledCount / 2),
    });
  }
  return candidates.sort((left, right) => (
    right.unsampledCount - left.unsampledCount
    || left.left - right.left
    || left.right - right.right
  ));
}

function chooseGapMidpoints(totalPages, excluded, count) {
  const chosen = [];
  const facts = [];
  while (chosen.length < count) {
    const gaps = gapCandidates(totalPages, excluded);
    if (gaps.length === 0) break;
    const gap = gaps[0];
    excluded.add(gap.pageIndex);
    chosen.push(gap.pageIndex);
    facts.push(gap);
  }
  return { pages: chosen, facts };
}

function normalizePageScores(input, sampledPages) {
  const scores = new Map([...sampledPages].map((pageIndex) => [pageIndex, 0]));
  if (input === undefined || input === null) return scores;

  const add = (rawPage, rawScore) => {
    const pageIndex = Number(rawPage);
    positiveInteger(pageIndex, "page score index");
    if (!sampledPages.has(pageIndex)) throw new RangeError("page scores may reference sampled pages only");
    if (typeof rawScore !== "number" || !Number.isFinite(rawScore)) {
      throw new TypeError("page score must be a finite number");
    }
    scores.set(pageIndex, rawScore);
  };

  if (input instanceof Map) {
    for (const [pageIndex, score] of input) add(pageIndex, score);
    return scores;
  }
  if (Array.isArray(input)) {
    input.forEach((item) => {
      if (Array.isArray(item) && item.length === 2) {
        add(item[0], item[1]);
        return;
      }
      if (!item || typeof item !== "object") throw new TypeError("pageScores array entries must be records or pairs");
      add(item.pageIndex ?? item.page, item.score ?? item.value ?? item.priority);
    });
    return scores;
  }
  if (typeof input === "object") {
    for (const [pageIndex, score] of Object.entries(input)) add(pageIndex, score);
    return scores;
  }
  throw new TypeError("pageScores must be a Map, object, or array");
}

function unitInterval(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${label} must be a finite number from 0 to 1`);
  }
  return value;
}

/**
 * Fixed high-value-page formula. Inputs have explicit 0..1 definitions:
 * - newTokensPerBook = distinct tokens first seen on page / unique books on page,
 *   capped at 1;
 * - underQuotaLanguageYield = unique books from languages still below quota /
 *   unique books on page;
 * - underFiveTokenYield = unique books carrying any token with global frequency
 *   below five / unique books on page.
 */
export function calculatePageValue({
  newTokensPerBook,
  underQuotaLanguageYield,
  underFiveTokenYield,
} = {}) {
  const newTokenScore = unitInterval(newTokensPerBook, "newTokensPerBook");
  const underQuotaScore = unitInterval(underQuotaLanguageYield, "underQuotaLanguageYield");
  const underFiveScore = unitInterval(underFiveTokenYield, "underFiveTokenYield");
  return Number((
    (0.45 * newTokenScore)
    + (0.35 * underQuotaScore)
    + (0.20 * underFiveScore)
  ).toFixed(12));
}

/** Compute the three normalized page metrics and their fixed weighted score. */
export function calculatePageValueFromCounts({
  uniqueBookCount,
  newDistinctTokenCount,
  underQuotaLanguageBookCount,
  underFiveTokenBookCount,
} = {}) {
  positiveInteger(uniqueBookCount, "uniqueBookCount");
  nonNegativeInteger(newDistinctTokenCount, "newDistinctTokenCount");
  nonNegativeInteger(underQuotaLanguageBookCount, "underQuotaLanguageBookCount");
  nonNegativeInteger(underFiveTokenBookCount, "underFiveTokenBookCount");
  if (underQuotaLanguageBookCount > uniqueBookCount || underFiveTokenBookCount > uniqueBookCount) {
    throw new RangeError("page yield book counts may not exceed uniqueBookCount");
  }
  const metrics = {
    newTokensPerBook: Math.min(1, newDistinctTokenCount / uniqueBookCount),
    underQuotaLanguageYield: underQuotaLanguageBookCount / uniqueBookCount,
    underFiveTokenYield: underFiveTokenBookCount / uniqueBookCount,
  };
  return { ...metrics, score: calculatePageValue(metrics) };
}

export function buildPageValueScores(pageMetrics) {
  if (!Array.isArray(pageMetrics)) throw new TypeError("pageMetrics must be an array");
  const seen = new Set();
  return pageMetrics.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError("pageMetrics entries must be records");
    }
    positiveInteger(item.pageIndex, "pageMetrics pageIndex");
    if (seen.has(item.pageIndex)) throw new Error("duplicate pageMetrics pageIndex");
    seen.add(item.pageIndex);
    const metrics = Object.hasOwn(item, "uniqueBookCount")
      ? calculatePageValueFromCounts(item)
      : {
        newTokensPerBook: item.newTokensPerBook,
        underQuotaLanguageYield: item.underQuotaLanguageYield,
        underFiveTokenYield: item.underFiveTokenYield,
        score: calculatePageValue(item),
      };
    return { pageIndex: item.pageIndex, ...metrics };
  }).sort((left, right) => left.pageIndex - right.pageIndex);
}

function chooseHighValueNeighbors(totalPages, sampledPages, excluded, scores, count) {
  const rankedSources = [...sampledPages].sort((left, right) => (
    scores.get(right) - scores.get(left)
    || left - right
  ));
  const candidates = [];
  for (const sourcePage of rankedSources) {
    for (const pageIndex of [sourcePage - 1, sourcePage + 1]) {
      if (pageIndex < 1 || pageIndex > totalPages || excluded.has(pageIndex)) continue;
      candidates.push({ pageIndex, sourcePage, sourceScore: scores.get(sourcePage), distance: 1 });
    }
  }
  candidates.sort((left, right) => (
    right.sourceScore - left.sourceScore
    || left.sourcePage - right.sourcePage
    || left.pageIndex - right.pageIndex
  ));

  const pages = [];
  const facts = [];
  for (const candidate of candidates) {
    if (pages.length >= count) break;
    if (excluded.has(candidate.pageIndex)) continue;
    excluded.add(candidate.pageIndex);
    pages.push(candidate.pageIndex);
    facts.push(candidate);
  }

  return { pages, facts };
}

/**
 * Plan one deterministic adaptive wave: six largest-gap midpoints followed by
 * four unsampled pages closest to the highest-value sampled pages.
 * @param {{totalPages:number, sampledPages:Iterable<number>, pageScores?:unknown, pageValues?:unknown, pageMetrics?:Array<Record<string, unknown>>, explorationCount?:number, neighborCount?:number}} [options]
 */
export function selectAdaptiveWavePages({
  totalPages,
  sampledPages,
  pageScores,
  pageValues,
  pageMetrics,
  explorationCount = EXPLORATION_PAGES_PER_WAVE,
  neighborCount = HIGH_VALUE_NEIGHBOR_PAGES_PER_WAVE,
} = {}) {
  positiveInteger(totalPages, "totalPages");
  nonNegativeInteger(explorationCount, "explorationCount");
  nonNegativeInteger(neighborCount, "neighborCount");
  if (explorationCount + neighborCount > PAGES_PER_WAVE) {
    throw new RangeError(`one wave may contain at most ${PAGES_PER_WAVE} pages`);
  }

  const sampled = pageSet(sampledPages ?? [], totalPages);
  const excluded = new Set(sampled);
  const exploration = chooseGapMidpoints(totalPages, excluded, explorationCount);
  const computedScores = pageMetrics === undefined
    ? undefined
    : buildPageValueScores(pageMetrics).map(({ pageIndex, score }) => ({ pageIndex, score }));
  const scores = normalizePageScores(computedScores ?? pageScores ?? pageValues, sampled);
  const neighbors = chooseHighValueNeighbors(totalPages, sampled, excluded, scores, neighborCount);

  // If the catalogue is almost exhausted, a missing neighbour slot is filled
  // by the current largest remaining gap and reported as exploration fallback.
  const fallbackCount = explorationCount + neighborCount - exploration.pages.length - neighbors.pages.length;
  const fallback = chooseGapMidpoints(totalPages, excluded, Math.max(0, fallbackCount));
  const pages = [...exploration.pages, ...neighbors.pages, ...fallback.pages];
  const pagePlan = [
    ...exploration.facts.map((fact) => ({
      pageIndex: fact.pageIndex,
      selectionReason: "LARGEST_GAP_MIDPOINT",
      gapLeftExclusive: fact.left,
      gapRightExclusive: fact.right,
      priorGapPageCount: fact.unsampledCount,
    })),
    ...neighbors.facts.map((fact) => ({
      pageIndex: fact.pageIndex,
      selectionReason: "HIGH_VALUE_NEIGHBOR",
      anchorPageIndex: fact.sourcePage,
      anchorScore: fact.sourceScore,
      neighborDistance: fact.distance,
    })),
    ...fallback.facts.map((fact) => ({
      pageIndex: fact.pageIndex,
      selectionReason: "EXPLORATION_FALLBACK",
      gapLeftExclusive: fact.left,
      gapRightExclusive: fact.right,
      priorGapPageCount: fact.unsampledCount,
    })),
  ];

  return {
    pages,
    explorationPages: [...exploration.pages, ...fallback.pages],
    gapMidpointPages: [...exploration.pages, ...fallback.pages],
    neighborPages: neighbors.pages,
    highValueNeighborPages: neighbors.pages,
    pagePlan,
    requestedPageCount: explorationCount + neighborCount,
    catalogueExhausted: pages.length < explorationCount + neighborCount,
  };
}

function firstOwn(record, keys) {
  for (const key of keys) {
    if (Object.hasOwn(record, key) && record[key] !== undefined) return record[key];
  }
  return undefined;
}

function hasAnyOwn(record, keys) {
  return keys.some((key) => Object.hasOwn(record, key));
}

function bookIdentity(book) {
  const value = firstOwn(book, ["bookIdentity", "sampleBookKey", "identity"]);
  if (typeof value !== "string") throw new TypeError("each book requires a string bookIdentity");
  return value;
}

function bookLanguageIdentity(book) {
  const supplied = firstOwn(book, [
    "rawLanguageScope",
    "raw_language_scope",
    "rawLanguageIdentity",
    "languageIdentity",
  ]);
  if (supplied !== undefined) {
    if (typeof supplied !== "string") throw new TypeError("rawLanguageIdentity must be a string");
    return supplied;
  }
  const raw = firstOwn(book, ["rawLanguage", "sourceLanguageCodeRaw", "language"]);
  if (raw === undefined) throw new TypeError("each book requires rawLanguageIdentity or a raw language value");
  const languageNameKeys = ["rawLanguageName", "sourceLanguageNameRaw", "languageName"];
  return hasAnyOwn(book, languageNameKeys)
    ? encodeRawLanguageIdentity(raw, firstOwn(book, languageNameKeys) ?? null)
    : encodeRawLanguageIdentity(raw);
}

function bookTokens(book, languageIdentity) {
  const identities = firstOwn(book, ["tokenIdentities"]);
  if (identities !== undefined) {
    if (!Array.isArray(identities) || identities.some((value) => typeof value !== "string")) {
      throw new TypeError("tokenIdentities must be an array of strings");
    }
    return [...new Set(identities)];
  }
  const exact = firstOwn(book, ["exactRawTokens", "tokens"]);
  if (exact === undefined) return [];
  if (!Array.isArray(exact) || exact.some((value) => typeof value !== "string")) {
    throw new TypeError("exactRawTokens must be an array of exact strings");
  }
  const sourceScope = firstOwn(book, ["sourceScope", "source_scope"]) ?? null;
  return [...new Set(exact.map((token) => JSON.stringify([
    rawJsonIdentity(sourceScope),
    languageIdentity,
    rawJsonIdentity(token),
  ])))];
}

function normalizeQuotas(rawQuotas) {
  if (rawQuotas === undefined || rawQuotas === null) return [];
  const entries = Array.isArray(rawQuotas)
    ? rawQuotas.map((quota) => {
      if (!quota || typeof quota !== "object" || Array.isArray(quota)) {
        throw new TypeError("languageQuotas entries must be records");
      }
      return [
        quota.rawLanguageIdentity ?? quota.languageIdentity,
        quota.quota ?? quota.target ?? quota.minimum,
      ];
    })
    : Object.entries(rawQuotas);

  const seen = new Set();
  return entries.map(([languageIdentity, quota]) => {
    if (typeof languageIdentity !== "string") throw new TypeError("quota rawLanguageIdentity must be a string");
    nonNegativeInteger(quota, "language quota");
    if (seen.has(languageIdentity)) throw new Error("duplicate language quota");
    seen.add(languageIdentity);
    return { rawLanguageIdentity: languageIdentity, quota };
  }).sort((left, right) => compareText(left.rawLanguageIdentity, right.rawLanguageIdentity));
}

function languageBuckets(entries) {
  const buckets = new Map();
  for (const entry of entries) {
    const bucket = buckets.get(entry.rawLanguageIdentity) ?? [];
    bucket.push(entry);
    buckets.set(entry.rawLanguageIdentity, bucket);
  }
  return buckets;
}

function languageTokenRichness(entries) {
  const tokens = new Set();
  for (const entry of entries) for (const token of entry.tokenIdentities) tokens.add(token);
  return tokens.size;
}

function desiredLanguageQuota(candidateCount, tokenRichness) {
  if (candidateCount < 500) return candidateCount;
  if (candidateCount < 1_500) {
    // The 500..800 band grows with observed language taxonomy richness.
    return Math.min(candidateCount, 500 + Math.min(300, tokenRichness * 3));
  }
  // Large languages start at 1,000 and may grow to 1,500 when rich.
  return Math.min(candidateCount, 1_000 + Math.min(500, tokenRichness * 5));
}

/**
 * Derive deterministic language quotas from the candidate pool. When desired
 * quotas exceed the final target, first reserve up to 300 per language, then
 * distribute remaining slots one-by-one using observed token richness and
 * remaining capacity. This never invents a language or exceeds availability.
 * @param {Array<Record<string, unknown>>} books
 * @param {{targetBooks?:number}} [options]
 */
export function deriveLanguageQuotas(books, { targetBooks = TARGET_BOOKS } = {}) {
  positiveInteger(targetBooks, "targetBooks");
  const entries = normalizeQuotaBooks(books);
  const buckets = languageBuckets(entries);
  const plans = [...buckets.entries()].map(([rawLanguageIdentity, bucket]) => {
    const tokenRichness = languageTokenRichness(bucket);
    return {
      rawLanguageIdentity,
      candidateCount: bucket.length,
      tokenRichness,
      desiredQuota: desiredLanguageQuota(bucket.length, tokenRichness),
      quota: 0,
    };
  }).sort((left, right) => compareText(left.rawLanguageIdentity, right.rawLanguageIdentity));
  const desiredTotal = plans.reduce((sum, plan) => sum + plan.desiredQuota, 0);
  const usableTarget = Math.min(targetBooks, entries.length);

  if (desiredTotal <= usableTarget) {
    for (const plan of plans) plan.quota = plan.desiredQuota;
  } else {
    let allocated = 0;
    for (const plan of plans) {
      plan.quota = Math.min(300, plan.desiredQuota);
      allocated += plan.quota;
    }
    if (allocated > usableTarget) {
      // More than 33 languages can exceed 10k even at the 300 base. Allocate
      // one deterministic round at a time so no lexical ordering wins a block.
      plans.forEach((plan) => { plan.quota = 0; });
      allocated = 0;
      while (allocated < usableTarget) {
        let advanced = false;
        for (const plan of plans) {
          if (allocated >= usableTarget) break;
          const cap = Math.min(300, plan.desiredQuota);
          if (plan.quota >= cap) continue;
          plan.quota += 1;
          allocated += 1;
          advanced = true;
        }
        if (!advanced) break;
      }
    }

    while (allocated < usableTarget) {
      const candidates = plans.filter((plan) => plan.quota < plan.desiredQuota);
      if (candidates.length === 0) break;
      candidates.sort((left, right) => {
        const leftRichness = left.tokenRichness / Math.max(1, left.quota);
        const rightRichness = right.tokenRichness / Math.max(1, right.quota);
        return rightRichness - leftRichness
          || (right.desiredQuota - right.quota) - (left.desiredQuota - left.quota)
          || compareText(left.rawLanguageIdentity, right.rawLanguageIdentity);
      });
      candidates[0].quota += 1;
      allocated += 1;
    }
  }

  const quotas = plans.map((plan) => ({
    rawLanguageIdentity: plan.rawLanguageIdentity,
    quota: plan.quota,
    candidateCount: plan.candidateCount,
    tokenRichness: plan.tokenRichness,
    desiredQuota: plan.desiredQuota,
  })).sort((left, right) => compareText(left.rawLanguageIdentity, right.rawLanguageIdentity));
  return {
    targetBooks,
    availableUniqueBooks: entries.length,
    desiredQuotaTotal: desiredTotal,
    derivedQuotaTotal: quotas.reduce((sum, plan) => sum + plan.quota, 0),
    compressedToTarget: desiredTotal > usableTarget,
    quotas,
  };
}

export const calculateLanguageQuotaPlan = deriveLanguageQuotas;

function normalizeQuotaBooks(books) {
  if (!Array.isArray(books)) throw new TypeError("books must be an array");
  const byIdentity = new Map();
  books.forEach((book, inputIndex) => {
    if (!book || typeof book !== "object" || Array.isArray(book)) throw new TypeError("each book must be a record");
    const identity = bookIdentity(book);
    const languageIdentity = bookLanguageIdentity(book);
    const priority = firstOwn(book, ["selectionPriority", "priority"]) ?? 0;
    if (typeof priority !== "number" || !Number.isFinite(priority)) {
      throw new TypeError("book selectionPriority must be finite");
    }
    const acquisitionIndex = firstOwn(book, ["acquisitionIndex", "candidateAcquisitionIndex"]);
    if (acquisitionIndex !== undefined) positiveInteger(acquisitionIndex, "acquisitionIndex");
    const tokens = bookTokens(book, languageIdentity);
    const existing = byIdentity.get(identity);
    if (existing) {
      if (existing.rawLanguageIdentity !== languageIdentity) {
        throw new Error("duplicate book identity has conflicting raw language identity");
      }
      return;
    }
    byIdentity.set(identity, {
      book,
      bookIdentity: identity,
      rawLanguageIdentity: languageIdentity,
      selectionPriority: priority,
      acquisitionIndex: acquisitionIndex ?? Number.MAX_SAFE_INTEGER,
      tokenIdentities: tokens,
      inputIndex,
    });
  });

  const tokenFrequency = new Map();
  for (const entry of byIdentity.values()) {
    for (const token of entry.tokenIdentities) tokenFrequency.set(token, (tokenFrequency.get(token) ?? 0) + 1);
  }
  for (const entry of byIdentity.values()) {
    entry.tokenRarityScore = entry.tokenIdentities.reduce(
      (total, token) => total + (1 / tokenFrequency.get(token)),
      0,
    );
  }
  return [...byIdentity.values()];
}

function compareQuotaBooks(left, right) {
  return right.selectionPriority - left.selectionPriority
    || right.tokenRarityScore - left.tokenRarityScore
    || right.tokenIdentities.length - left.tokenIdentities.length
    || left.acquisitionIndex - right.acquisitionIndex
    || compareText(left.bookIdentity, right.bookIdentity);
}

function chooseBestTokenDeficitCarrier(entries, selectedIdentities, tokenCounts, eligible) {
  let best = null;
  let bestGain = -1;
  let bestUncovered = -1;
  for (const entry of entries) {
    if (selectedIdentities.has(entry.bookIdentity) || (eligible && !eligible(entry))) continue;
    let deficitGain = 0;
    let uncovered = 0;
    for (const token of entry.tokenIdentities) {
      const count = tokenCounts.get(token) ?? 0;
      if (count < 5) deficitGain += 5 - count;
      if (count === 0) uncovered += 1;
    }
    if (
      uncovered > bestUncovered
      || (uncovered === bestUncovered && deficitGain > bestGain)
      || (uncovered === bestUncovered && deficitGain === bestGain && best !== null && compareQuotaBooks(entry, best) < 0)
    ) {
      best = entry;
      bestGain = deficitGain;
      bestUncovered = uncovered;
    }
  }
  return bestGain > 0 ? best : null;
}

function tokenCarrierPlan(entries) {
  const carriers = new Map();
  for (const entry of entries) {
    for (const token of entry.tokenIdentities) {
      const bucket = carriers.get(token) ?? [];
      bucket.push(entry);
      carriers.set(token, bucket);
    }
  }
  for (const bucket of carriers.values()) bucket.sort(compareQuotaBooks);
  return [...carriers.entries()].sort((left, right) => (
    left[1].length - right[1].length
    || compareText(left[0], right[0])
  ));
}

/**
 * Select exactly 10,000 unique books when available.  Language quotas are
 * filled first; any shortage is recorded and the remaining capacity is filled
 * by the same deterministic coverage-oriented ranking across all languages.
 * @param {{books:Array<Record<string, unknown>>, languageQuotas?:unknown, quotas?:unknown, targetBooks?:number, target?:number}} [options]
 */
export function selectQuotaBooks({
  books,
  languageQuotas,
  quotas,
  targetBooks = TARGET_BOOKS,
  target,
} = {}) {
  const finalTarget = target ?? targetBooks;
  positiveInteger(finalTarget, "targetBooks");
  const entries = normalizeQuotaBooks(books);
  const explicitQuotas = languageQuotas ?? quotas;
  const derivedQuotaPlan = explicitQuotas === undefined
    ? deriveLanguageQuotas(books, { targetBooks: finalTarget })
    : null;
  const normalizedQuotas = normalizeQuotas(explicitQuotas ?? derivedQuotaPlan.quotas);
  const quotaTotal = normalizedQuotas.reduce((sum, item) => sum + item.quota, 0);
  if (quotaTotal > finalTarget) throw new RangeError("language quotas exceed targetBooks");

  const byLanguage = languageBuckets(entries);
  for (const bucket of byLanguage.values()) bucket.sort(compareQuotaBooks);

  const selected = [];
  const selectedIdentities = new Set();
  const tokenCounts = new Map();
  const selectedLanguageCounts = new Map();
  const auditByIdentity = new Map();
  const quotaResults = [];
  const effectiveQuotaByLanguage = new Map(normalizedQuotas.map(({ rawLanguageIdentity, quota }) => [
    rawLanguageIdentity,
    Math.min(quota, (byLanguage.get(rawLanguageIdentity) ?? []).length),
  ]));
  let reservedQuotaSlots = [...effectiveQuotaByLanguage.values()].reduce((sum, quota) => sum + quota, 0);
  const add = (entry, reason) => {
    if (selectedIdentities.has(entry.bookIdentity) || selected.length >= finalTarget) return false;
    const previousLanguageCount = selectedLanguageCounts.get(entry.rawLanguageIdentity) ?? 0;
    selectedIdentities.add(entry.bookIdentity);
    selected.push(entry);
    selectedLanguageCounts.set(entry.rawLanguageIdentity, previousLanguageCount + 1);
    if (previousLanguageCount < (effectiveQuotaByLanguage.get(entry.rawLanguageIdentity) ?? 0)) {
      reservedQuotaSlots -= 1;
    }
    for (const token of entry.tokenIdentities) tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
    auditByIdentity.set(entry.bookIdentity, {
      bookIdentity: entry.bookIdentity,
      rawLanguageIdentity: entry.rawLanguageIdentity,
      selectionIndex: selected.length,
      selectedSampleIndex: selected.length,
      selectionReason: reason,
      selectionPriority: entry.selectionPriority,
      tokenRarityScore: entry.tokenRarityScore,
    });
    return true;
  };

  // First guarantee at least one carrier for every discovered token whenever
  // the target can represent all tokens. Continue greedily toward five real
  // carrier books per token, but never consume a slot that is still required
  // for a feasible language quota. Quota-language carriers compete on the
  // same token-deficit score rather than being selected by lexical order.
  const rankedEntries = [...entries].sort(compareQuotaBooks);
  const carrierPlan = tokenCarrierPlan(rankedEntries);
  const eligibleForCoverage = (entry) => (
    (selectedLanguageCounts.get(entry.rawLanguageIdentity) ?? 0)
      < (effectiveQuotaByLanguage.get(entry.rawLanguageIdentity) ?? 0)
    || finalTarget - selected.length > reservedQuotaSlots
  );
  // Work in five coverage rounds. This preserves the strict "one carrier for
  // every token before a second carrier" priority while avoiding an O(books²)
  // full-pool rescan for each selected book.
  for (let desiredCarrierCount = 1; desiredCarrierCount <= 5 && selected.length < finalTarget; desiredCarrierCount += 1) {
    for (const [token, carriers] of carrierPlan) {
      if (selected.length >= finalTarget) break;
      if ((tokenCounts.get(token) ?? 0) >= desiredCarrierCount) continue;
      const eligibleCarriers = carriers.filter((entry) => (
        !selectedIdentities.has(entry.bookIdentity) && eligibleForCoverage(entry)
      ));
      const carrier = chooseBestTokenDeficitCarrier(
        eligibleCarriers,
        selectedIdentities,
        tokenCounts,
      );
      if (carrier) add(carrier, "TOKEN_DEFICIT_COVERAGE");
    }
  }

  for (const quota of normalizedQuotas) {
    const available = byLanguage.get(quota.rawLanguageIdentity) ?? [];
    let currentLanguageCount = selectedLanguageCounts.get(quota.rawLanguageIdentity) ?? 0;
    while (currentLanguageCount < quota.quota && selected.length < finalTarget) {
      const entry = chooseBestTokenDeficitCarrier(
        available,
        selectedIdentities,
        tokenCounts,
        ({ rawLanguageIdentity }) => rawLanguageIdentity === quota.rawLanguageIdentity,
      ) ?? available.find(({ bookIdentity: value }) => !selectedIdentities.has(value));
      if (!entry) break;
      if (add(entry, "RAW_LANGUAGE_QUOTA")) currentLanguageCount += 1;
    }
    quotaResults.push({
      rawLanguageIdentity: quota.rawLanguageIdentity,
      quota: quota.quota,
      selectedForQuota: currentLanguageCount,
      available: available.length,
      deficit: Math.max(0, quota.quota - currentLanguageCount),
    });
  }

  for (const entry of rankedEntries) {
    if (selected.length >= finalTarget) break;
    add(entry, "GLOBAL_COVERAGE_FILL");
  }

  const counts = new Map();
  for (const entry of selected) {
    counts.set(entry.rawLanguageIdentity, (counts.get(entry.rawLanguageIdentity) ?? 0) + 1);
  }
  const countsByRawLanguage = [...counts.entries()]
    .map(([rawLanguageIdentity, sampleCount]) => ({ rawLanguageIdentity, sampleCount }))
    .sort((left, right) => compareText(left.rawLanguageIdentity, right.rawLanguageIdentity));
  const quotaSatisfied = quotaResults.every(({ deficit }) => deficit === 0);

  return {
    targetBooks: finalTarget,
    availableUniqueBooks: entries.length,
    selectedBooks: selected.map(({ book }) => book),
    selected: selected.map(({ book }) => book),
    selectedBookIdentities: selected.map(({ bookIdentity: value }) => value),
    selectionAudit: selected.map(({ bookIdentity: value }) => auditByIdentity.get(value)),
    selectedCount: selected.length,
    complete: selected.length === finalTarget,
    quotaSatisfied,
    derivedQuotaPlan,
    quotaResults,
    countsByRawLanguage,
    tokenCoverage: {
      discoveredTokenCount: new Set(entries.flatMap(({ tokenIdentities }) => tokenIdentities)).size,
      coveredTokenCount: [...tokenCounts.values()].filter((count) => count >= 1).length,
      tokensWithFiveSamples: [...tokenCounts.values()].filter((count) => count >= 5).length,
    },
  };
}

function observationLanguageIdentity(observation) {
  const supplied = firstOwn(observation, [
    "rawLanguageScope",
    "raw_language_scope",
    "rawLanguageIdentity",
    "languageIdentity",
  ]);
  if (supplied !== undefined) {
    if (typeof supplied !== "string") throw new TypeError("observation rawLanguageIdentity must be a string");
    return supplied;
  }
  const raw = firstOwn(observation, ["rawLanguage", "sourceLanguageCodeRaw", "language"]);
  if (raw === undefined) return null;
  const languageNameKeys = ["rawLanguageName", "sourceLanguageNameRaw", "languageName"];
  return hasAnyOwn(observation, languageNameKeys)
    ? encodeRawLanguageIdentity(raw, firstOwn(observation, languageNameKeys) ?? null)
    : encodeRawLanguageIdentity(raw);
}

function observationTokens(observation, languageIdentity) {
  const identities = firstOwn(observation, ["tokenIdentities"]);
  if (identities !== undefined) {
    if (!Array.isArray(identities) || identities.some((value) => typeof value !== "string")) {
      throw new TypeError("observation tokenIdentities must be an array of strings");
    }
    return [...new Set(identities)];
  }
  const exact = firstOwn(observation, ["exactRawTokens", "tokens"]);
  if (exact === undefined) return [];
  if (!Array.isArray(exact) || exact.some((value) => typeof value !== "string")) {
    throw new TypeError("observation exactRawTokens must be an array of strings");
  }
  const sourceScope = firstOwn(observation, ["sourceScope", "source_scope"]) ?? null;
  return [...new Set(exact.map((token) => JSON.stringify([
    rawJsonIdentity(sourceScope),
    languageIdentity,
    rawJsonIdentity(token),
  ])))];
}

function observationOrder(observation, stage, inputIndex) {
  const keys = stage === "candidate_acquisition"
    ? ["acquisitionIndex", "candidateAcquisitionIndex"]
    : ["selectedSampleIndex", "selectionIndex", "finalSampleIndex"];
  const supplied = firstOwn(observation, keys);
  if (supplied === undefined) return inputIndex + 1;
  return positiveInteger(supplied, `${stage} order index`);
}

/**
 * Build an exact-token discovery curve. Candidate acquisition and final global
 * curves use 1,000-book blocks; final per-language curves default to 500.
 */
export function buildDiscoveryCurve(observations, options = {}) {
  if (!Array.isArray(observations)) throw new TypeError("observations must be an array");
  const stage = options.stage ?? "final_sample";
  if (!new Set(["candidate_acquisition", "final_sample"]).has(stage)) {
    throw new TypeError("stage must be candidate_acquisition or final_sample");
  }
  const scopeLanguageIdentity = options.rawLanguageIdentity
    ?? options.scopeLanguageIdentity
    ?? null;
  if (scopeLanguageIdentity !== null && typeof scopeLanguageIdentity !== "string") {
    throw new TypeError("scope rawLanguageIdentity must be a string or null");
  }
  const checkpointEvery = options.checkpointEvery
    ?? options.checkpointSize
    ?? (scopeLanguageIdentity === null ? GLOBAL_DISCOVERY_BLOCK : LANGUAGE_DISCOVERY_BLOCK);
  positiveInteger(checkpointEvery, "checkpointEvery");

  const byIdentity = new Map();
  observations.forEach((observation, inputIndex) => {
    if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
      throw new TypeError("each observation must be a record");
    }
    const recordStage = firstOwn(observation, ["stage", "samplingStage"]);
    if (recordStage !== undefined && recordStage !== stage) return;
    const languageIdentity = observationLanguageIdentity(observation);
    if (scopeLanguageIdentity !== null && languageIdentity !== scopeLanguageIdentity) return;
    const suppliedIdentity = firstOwn(observation, ["bookIdentity", "sampleBookKey", "identity"]);
    const identity = suppliedIdentity === undefined ? `INPUT_INDEX:${inputIndex}` : suppliedIdentity;
    if (typeof identity !== "string") throw new TypeError("observation book identity must be a string");
    if (byIdentity.has(identity)) return;
    byIdentity.set(identity, {
      bookIdentity: identity,
      rawLanguageIdentity: languageIdentity,
      order: observationOrder(observation, stage, inputIndex),
      inputIndex,
      tokenIdentities: observationTokens(observation, languageIdentity),
    });
  });

  const ordered = [...byIdentity.values()].sort((left, right) => (
    left.order - right.order
    || compareText(left.bookIdentity, right.bookIdentity)
    || left.inputIndex - right.inputIndex
  ));
  const curve = [];
  const cumulative = new Set();
  let priorDistinct = 0;
  for (let start = 0; start < ordered.length; start += checkpointEvery) {
    const block = ordered.slice(start, start + checkpointEvery);
    for (const observation of block) {
      for (const token of observation.tokenIdentities) cumulative.add(token);
    }
    const sampleSize = start + block.length;
    const newDistinctTokens = cumulative.size - priorDistinct;
    curve.push({
      stage,
      checkpointScope: scopeLanguageIdentity === null ? "global" : "raw_language",
      rawLanguageIdentity: scopeLanguageIdentity,
      checkpointEvery,
      sampleSize,
      checkpointSampleCount: sampleSize,
      blockSampleCount: block.length,
      priorCumulativeDistinctTokens: priorDistinct,
      newDistinctTokens,
      newDistinctMappingKeys: newDistinctTokens,
      cumulativeDistinctTokens: cumulative.size,
      cumulativeDistinctMappingKeys: cumulative.size,
      blockNoveltyRate: block.length === 0 ? 0 : newDistinctTokens / block.length,
      completeBlock: block.length === checkpointEvery,
    });
    priorDistinct = cumulative.size;
  }
  return curve;
}

function normalizeLanguageCurves(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    if (typeof input !== "object") throw new TypeError("languageCurves must be an array or object");
    return Object.entries(input).map(([rawLanguageIdentity, curve]) => ({ rawLanguageIdentity, curve }));
  }
  if (input.length === 0) return [];
  if (Array.isArray(input[0])) {
    return input.map((curve) => ({ rawLanguageIdentity: curve[0]?.rawLanguageIdentity ?? null, curve }));
  }
  if (Object.hasOwn(input[0], "curve")) return input;
  const grouped = new Map();
  for (const row of input) {
    const key = row.rawLanguageIdentity;
    const curve = grouped.get(key) ?? [];
    curve.push(row);
    grouped.set(key, curve);
  }
  return [...grouped.entries()].map(([rawLanguageIdentity, curve]) => ({ rawLanguageIdentity, curve }));
}

function rowPriorDistinct(row, previousRow) {
  if (typeof row.priorCumulativeDistinctTokens === "number") return row.priorCumulativeDistinctTokens;
  if (typeof previousRow?.cumulativeDistinctTokens === "number") return previousRow.cumulativeDistinctTokens;
  if (typeof previousRow?.cumulativeDistinctMappingKeys === "number") return previousRow.cumulativeDistinctMappingKeys;
  return 0;
}

function rowNewDistinct(row) {
  const value = row.newDistinctTokens ?? row.newDistinctMappingKeys;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("curve new distinct count must be non-negative");
  return value;
}

function completeRows(curve, blockSize) {
  if (!Array.isArray(curve)) throw new TypeError("discovery curve must be an array");
  return curve.map((row, index) => ({ row, index })).filter(({ row }) => (
    row.blockSampleCount === blockSize
    || (row.completeBlock === true && row.checkpointEvery === blockSize)
  ));
}

function booleanFlag(source, keys) {
  for (const key of keys) {
    if (Object.hasOwn(source, key)) return source[key] === true;
  }
  return false;
}

/** Build the three explicit safety QA flags used by saturation assessment. */
export function buildSamplingQaFlags(input = {}) {
  const quotaSatisfied = booleanFlag(input, ["quotaSatisfied", "quotasMet", "quotaMet"]);
  const rawRoundTripVerified = booleanFlag(input, [
    "rawRoundTripVerified",
    "rawRoundTripPassed",
    "roundTripVerified",
  ]);

  let requestBudgetRespected = booleanFlag(input, ["requestBudgetRespected", "budgetRespected"]);
  const hasCounts = ["actualUniquePages", "actualHttpAttempts", "retryAttempts"]
    .some((key) => Object.hasOwn(input, key));
  if (hasCounts) {
    const actualUniquePages = input.actualUniquePages ?? 0;
    const actualHttpAttempts = input.actualHttpAttempts ?? actualUniquePages;
    const retryAttempts = input.retryAttempts ?? Math.max(0, actualHttpAttempts - actualUniquePages);
    nonNegativeInteger(actualUniquePages, "actualUniquePages");
    nonNegativeInteger(actualHttpAttempts, "actualHttpAttempts");
    nonNegativeInteger(retryAttempts, "retryAttempts");
    requestBudgetRespected = actualUniquePages <= PLANNED_UNIQUE_PAGES
      && actualHttpAttempts <= HTTP_ATTEMPT_CAP
      && retryAttempts <= RETRY_BUDGET;
  }
  return Object.freeze({ quotaSatisfied, rawRoundTripVerified, requestBudgetRespected });
}

/**
 * Saturation is deliberately conjunctive: 10k final books, a stable global
 * tail, every sufficiently represented language's stable tail, and all three
 * sampling QA gates must pass. Missing QA evidence is a failure, not a guess.
 */
export function assessDiscoverySaturation(curveOrInput, maybeOptions = {}) {
  const structured = !Array.isArray(curveOrInput)
    && curveOrInput !== null
    && typeof curveOrInput === "object";
  const globalCurve = structured
    ? (curveOrInput.globalCurve ?? curveOrInput.curve ?? [])
    : curveOrInput;
  const options = structured ? { ...curveOrInput, ...maybeOptions } : maybeOptions;
  if (!Array.isArray(globalCurve)) throw new TypeError("globalCurve must be an array");
  const targetBooks = options.targetBooks ?? TARGET_BOOKS;
  positiveInteger(targetBooks, "targetBooks");
  const actualSampleCount = options.actualSampleCount
    ?? options.actualUniqueBooks
    ?? globalCurve.at(-1)?.sampleSize
    ?? globalCurve.at(-1)?.checkpointSampleCount
    ?? 0;
  nonNegativeInteger(actualSampleCount, "actualSampleCount");

  const completeGlobal = completeRows(globalCurve, GLOBAL_DISCOVERY_BLOCK);
  const globalTail = completeGlobal.slice(-3);
  const globalAssessments = globalTail.map(({ row, index }) => {
    const priorDistinct = rowPriorDistinct(row, globalCurve[index - 1]);
    const newDistinct = rowNewDistinct(row);
    const threshold = Math.max(3, priorDistinct * 0.01);
    return {
      sampleSize: row.sampleSize ?? row.checkpointSampleCount,
      priorDistinct,
      newDistinct,
      threshold,
      stable: newDistinct <= threshold,
    };
  });
  const globalTailStable = globalAssessments.length === 3
    && globalAssessments.every(({ stable }) => stable);

  const languageAssessments = normalizeLanguageCurves(options.languageCurves).map((entry) => {
    const languageCurve = entry.curve;
    const languageSampleCount = languageCurve.at(-1)?.sampleSize
      ?? languageCurve.at(-1)?.checkpointSampleCount
      ?? 0;
    if (languageSampleCount < 1_000) {
      return {
        rawLanguageIdentity: entry.rawLanguageIdentity,
        sampleCount: languageSampleCount,
        applicable: false,
        stable: true,
        reason: "LANGUAGE_SAMPLE_BELOW_1000",
      };
    }
    const complete = completeRows(languageCurve, LANGUAGE_DISCOVERY_BLOCK);
    const latest = complete.at(-1);
    if (!latest) {
      return {
        rawLanguageIdentity: entry.rawLanguageIdentity,
        sampleCount: languageSampleCount,
        applicable: true,
        stable: false,
        reason: "NO_COMPLETE_500_BOOK_BLOCK",
      };
    }
    const priorDistinct = rowPriorDistinct(latest.row, languageCurve[latest.index - 1]);
    const newDistinct = rowNewDistinct(latest.row);
    const threshold = Math.max(2, priorDistinct * 0.02);
    return {
      rawLanguageIdentity: entry.rawLanguageIdentity,
      sampleCount: languageSampleCount,
      applicable: true,
      priorDistinct,
      newDistinct,
      threshold,
      stable: newDistinct <= threshold,
      reason: newDistinct <= threshold ? "LANGUAGE_TAIL_STABLE" : "LANGUAGE_TAIL_STILL_GROWING",
    };
  });
  const languageTailsStable = languageAssessments.every(({ stable }) => stable);
  const qa = buildSamplingQaFlags(options.qaFlags ?? options.qa ?? options);
  const checks = {
    targetBooksMet: actualSampleCount >= targetBooks,
    globalTailStable,
    languageTailsStable,
    quotaSatisfied: qa.quotaSatisfied,
    rawRoundTripVerified: qa.rawRoundTripVerified,
    requestBudgetRespected: qa.requestBudgetRespected,
  };
  const reasons = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  const saturated = reasons.length === 0;
  return {
    saturated,
    status: saturated
      ? "TAXONOMY_DISCOVERY_SATURATED"
      : "TAXONOMY_DISCOVERY_NOT_SATURATED",
    actualSampleCount,
    targetBooks,
    checks,
    qaFlags: qa,
    globalTailAssessments: globalAssessments,
    languageAssessments,
    reasons,
  };
}

export const SAMPLING_DEFAULTS = Object.freeze({
  globalDiscoveryBlock: GLOBAL_DISCOVERY_BLOCK,
  languageDiscoveryBlock: LANGUAGE_DISCOVERY_BLOCK,
  targetBooks: TARGET_BOOKS,
  initialPageCount: INITIAL_PAGE_COUNT,
  explorationPagesPerWave: EXPLORATION_PAGES_PER_WAVE,
  highValueNeighborPagesPerWave: HIGH_VALUE_NEIGHBOR_PAGES_PER_WAVE,
});
