import { createHash } from "node:crypto";

import { rawJsonIdentity, rawLanguageIdentity } from "./raw.mjs";

const DEFAULT_DISCOVERY_CHECKPOINT_SIZE = 1_000;
const DEFAULT_REPRESENTATIVE_SAMPLE_LIMIT = 12;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function firstDefined(record, keys) {
  for (const key of keys) {
    if (Object.hasOwn(record, key) && record[key] !== undefined) return record[key];
  }
  return undefined;
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
}

function optionalString(value, label) {
  if (value === undefined || value === null) return null;
  return requireString(value, label);
}

function optionalInteger(value, label) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`);
  return value;
}

function rawTokenMetadata(rawToken) {
  return {
    exactRawToken: rawToken,
    rawTokenUtf8Base64: Buffer.from(rawToken, "utf8").toString("base64"),
    rawTokenSha256: sha256(rawToken),
    rawTokenCodepointLength: Array.from(rawToken).length,
  };
}

function sourceScope(record) {
  return requireString(
    firstDefined(record, ["sourceScope", "source_scope", "channelAppId", "channel_app_id"]),
    "sourceScope",
  );
}

function bookLanguageRecord(record) {
  const nested = firstDefined(record, ["rawLanguage", "raw_language"]);
  return nested && typeof nested === "object" && !Array.isArray(nested) ? { ...record, ...nested } : record;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("raw JSON value cannot be undefined");
  return encoded;
}

function languageJsonValue(record) {
  record = bookLanguageRecord(record);
  const value = firstDefined(record, [
    "languageJsonValue",
    "language_json_value",
    "sourceLanguageCodeRaw",
    "source_language_code_raw",
    "sourceLanguageCode",
    "source_language_code",
    "language",
  ]);
  if (value === undefined) throw new TypeError("language JSON value is required");
  return value;
}

function languageJsonType(record) {
  record = bookLanguageRecord(record);
  const supplied = firstDefined(record, ["languageJsonType", "language_json_type"]);
  if (supplied !== undefined) return requireString(supplied, "languageJsonType");
  const value = languageJsonValue(record);
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

function languageJsonValueJson(record) {
  record = bookLanguageRecord(record);
  const supplied = firstDefined(record, ["languageJsonValueJson", "language_json_value_json"]);
  return supplied === undefined ? stableJson(languageJsonValue(record)) : requireString(supplied, "languageJsonValueJson");
}

function languageNameFact(record) {
  record = bookLanguageRecord(record);
  const keys = [
    "sourceLanguageNameRaw",
    "source_language_name_raw",
    "sourceLanguageName",
    "source_language_name",
    "languageName",
  ];
  const presentKey = keys.find((key) => Object.hasOwn(record, key) && record[key] !== undefined);
  if (presentKey === undefined) return { present: false, value: null };
  return { present: true, value: optionalString(record[presentKey], "sourceLanguageNameRaw") };
}

function languageName(record) {
  return languageNameFact(record).value;
}

function languageNameState(record) {
  const fact = languageNameFact(record);
  if (!fact.present) return "missing";
  return fact.value === null ? "null" : "string";
}

function siteLocale() {
  return null;
}

function rawLanguageScope(record) {
  const supplied = firstDefined(record, ["rawLanguageScope", "raw_language_scope", "rawLanguageIdentity", "raw_language_identity"]);
  if (supplied !== undefined) return requireString(supplied, "rawLanguageScope");
  const name = languageNameFact(record);
  return name.present
    ? rawLanguageIdentity(languageJsonValue(record), name.value)
    : rawLanguageIdentity(languageJsonValue(record));
}

function localeKey(record) {
  return rawLanguageScope(record);
}

function externalBookIdValue(record) {
  const value = firstDefined(record, ["externalBookIdRaw", "external_book_id_raw", "externalBookId", "external_book_id", "id"]);
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new TypeError("externalBookIdRaw must be a string or finite number");
}

function externalBookId(record) {
  const value = externalBookIdValue(record);
  return typeof value === "string" ? value : rawJsonIdentity(value);
}

function sampleBookKey(record) {
  const supplied = firstDefined(record, ["sampleBookKey", "sample_book_key", "bookIdentity", "book_identity"]);
  if (supplied !== undefined) return requireString(supplied, "sampleBookKey");
  return sha256(stableJson([sourceScope(record), externalBookId(record), rawLanguageScope(record)]));
}

function pageIndex(record) {
  return optionalInteger(firstDefined(record, ["pageIndex", "page_index"]), "pageIndex");
}

function fetchedAt(record) {
  return optionalString(firstDefined(record, ["fetchedAt", "fetched_at", "sampledAt", "sampled_at"]), "fetchedAt");
}

function descriptionFact(record) {
  const keys = ["descriptionRaw", "description_raw", "description"];
  const presentFlag = firstDefined(record, ["descriptionPresent", "description_present"]);
  const presentKey = keys.find((key) => Object.hasOwn(record, key) && record[key] !== undefined);
  if (presentFlag === false || presentKey === undefined) {
    return { present: false, rawValue: null, jsonValueJson: null, textView: "" };
  }
  const rawValue = record[presentKey];
  const suppliedJson = firstDefined(record, ["descriptionJsonValueJson", "description_json_value_json"]);
  const jsonValueJson = suppliedJson === undefined
    ? stableJson(rawValue)
    : requireString(suppliedJson, "descriptionJsonValueJson");
  return {
    present: true,
    rawValue,
    jsonValueJson,
    textView: typeof rawValue === "string" ? rawValue : rawValue === null ? "" : jsonValueJson,
  };
}

function rawSeriesTypeList(record) {
  const value = firstDefined(record, [
    "seriesTypeListRaw",
    "series_type_list_raw",
    "seriesTypeList",
    "series_type_list",
  ]);
  if (value === null && firstDefined(record, ["seriesTypeListPresent", "series_type_list_present"]) === false) return value;
  if (!Array.isArray(value)) throw new TypeError("seriesTypeListRaw must be an array");
  return value;
}

function extractionCandidates(item) {
  if (typeof item === "string") {
    return [{ rawToken: item, extractionPath: "$", structureStatus: "VALID_STRING" }];
  }
  if (!item || typeof item !== "object" || Array.isArray(item)) return [];
  return ["value", "name", "label", "id"]
    .filter((key) => typeof item[key] === "string")
    .map((key) => ({ rawToken: item[key], extractionPath: `$.${key}`, structureStatus: "VALID_OBJECT_STRING" }));
}

function normalizeObservation(observation, bookByKey) {
  const record = requireRecord(observation, "observation");
  const bookKey = requireString(firstDefined(record, [
    "sampleBookKey",
    "sample_book_key",
    "bookIdentity",
    "book_identity",
  ]), "sampleBookKey");
  const book = bookByKey.get(bookKey);
  if (!book) throw new Error(`observation references unknown sample book: ${bookKey}`);
  const rawToken = requireString(firstDefined(record, ["exactRawToken", "exact_raw_token", "rawToken", "raw_token"]), "rawToken");
  const listIndex = optionalInteger(firstDefined(record, ["listIndex", "list_index"]), "listIndex");
  return {
    sampleBookKey: bookKey,
    sourceScope: sourceScope(book),
    languageJsonType: languageJsonType(book),
    languageJsonValueJson: languageJsonValueJson(book),
    languageNameRaw: languageName(book),
    languageNameState: languageNameState(book),
    rawLanguageScope: rawLanguageScope(book),
    siteLocale: siteLocale(book),
    localeKey: localeKey(book),
    listIndex,
    rawItemJson: firstDefined(record, ["rawItemJson", "raw_item_json"]) ?? null,
    extractionPath: requireString(firstDefined(record, ["extractionPath", "extraction_path"]) ?? "$", "extractionPath"),
    structureStatus: requireString(firstDefined(record, ["structureStatus", "structure_status"]) ?? "VALID_STRING", "structureStatus"),
    pageIndex: pageIndex(book),
    fetchedAt: fetchedAt(book),
    ...rawTokenMetadata(rawToken),
  };
}

function extractObservationsFromBooks(books) {
  const observations = [];
  const anomalies = [];
  for (const book of books) {
    const rawList = rawSeriesTypeList(book);
    if (!Array.isArray(rawList)) {
      anomalies.push({
        sampleBookKey: sampleBookKey(book),
        listIndex: null,
        rawItemJson: rawList,
        structureStatus: "INVALID_LIST_STRUCTURE",
      });
      continue;
    }
    for (let listIndex = 0; listIndex < rawList.length; listIndex += 1) {
      const rawItem = rawList[listIndex];
      const candidates = extractionCandidates(rawItem);
      if (candidates.length !== 1) {
        anomalies.push({
          sampleBookKey: sampleBookKey(book),
          listIndex,
          rawItemJson: rawItem,
          structureStatus: candidates.length === 0 ? "UNSUPPORTED_TYPE" : "AMBIGUOUS_OBJECT",
        });
        continue;
      }
      observations.push(normalizeObservation({
        sampleBookKey: sampleBookKey(book),
        listIndex,
        rawItemJson: rawItem,
        ...candidates[0],
      }, new Map([[sampleBookKey(book), book]])));
    }
  }
  return { observations, anomalies };
}

function tokenKeyParts(observation) {
  return [observation.sourceScope, observation.localeKey, observation.exactRawToken];
}

export function tokenKey(observation) {
  return sha256(JSON.stringify(tokenKeyParts(observation)));
}

function representativeSelection(observations, limit) {
  const byBook = new Map();
  for (const observation of observations) {
    if (!byBook.has(observation.sampleBookKey)) byBook.set(observation.sampleBookKey, observation);
  }
  return [...byBook.values()]
    .sort((left, right) => (
      (left.pageIndex ?? Number.MAX_SAFE_INTEGER) - (right.pageIndex ?? Number.MAX_SAFE_INTEGER)
      || compareText(left.sampleBookKey, right.sampleBookKey)
    ))
    .slice(0, limit);
}

export function buildTaxonomyInventory(observations, options = {}) {
  const representativeSampleLimit = options.representativeSampleLimit ?? DEFAULT_REPRESENTATIVE_SAMPLE_LIMIT;
  const grouped = new Map();
  for (const observation of observations) {
    const key = tokenKey(observation);
    const bucket = grouped.get(key) ?? [];
    bucket.push(observation);
    grouped.set(key, bucket);
  }

  return [...grouped.entries()].map(([key, bucket]) => {
    const first = bucket[0];
    const uniqueBooks = new Set(bucket.map(({ sampleBookKey: value }) => value));
    const carrierBookKeys = [...uniqueBooks].sort(compareText);
    const representatives = representativeSelection(bucket, representativeSampleLimit);
    const chronological = [...bucket].sort((left, right) => (
      compareText(left.fetchedAt ?? "\uffff", right.fetchedAt ?? "\uffff")
      || (left.pageIndex ?? Number.MAX_SAFE_INTEGER) - (right.pageIndex ?? Number.MAX_SAFE_INTEGER)
      || (left.listIndex ?? Number.MAX_SAFE_INTEGER) - (right.listIndex ?? Number.MAX_SAFE_INTEGER)
    ));
    const firstSeen = chronological[0] ?? null;
    const lastSeen = chronological.at(-1) ?? null;
    return {
      tokenKeySha256: key,
      sourceScope: first.sourceScope,
      languageJsonType: first.languageJsonType,
      languageJsonValueJson: first.languageJsonValueJson,
      languageNameRaw: first.languageNameRaw,
      languageNameState: first.languageNameState,
      rawLanguageScope: first.rawLanguageScope,
      siteLocale: first.siteLocale,
      localeKey: first.localeKey,
      exactRawToken: first.exactRawToken,
      rawTokenUtf8Base64: first.rawTokenUtf8Base64,
      rawTokenSha256: first.rawTokenSha256,
      rawTokenCodepointLength: first.rawTokenCodepointLength,
      bookFrequency: uniqueBooks.size,
      occurrenceCount: bucket.length,
      firstSeenAt: firstSeen?.fetchedAt ?? null,
      firstSeenPage: firstSeen?.pageIndex ?? null,
      lastSeenAt: lastSeen?.fetchedAt ?? null,
      lastSeenPage: lastSeen?.pageIndex ?? null,
      representativeSampleCount: representatives.length,
      representativeBookKeys: representatives.map(({ sampleBookKey: value }) => value),
      carrierBookKeys,
    };
  }).sort((left, right) => (
    compareText(left.sourceScope, right.sourceScope)
    || compareText(left.localeKey, right.localeKey)
    || compareText(left.exactRawToken, right.exactRawToken)
    || compareText(left.tokenKeySha256, right.tokenKeySha256)
  ));
}

function bookFacts(book) {
  const description = descriptionFact(book);
  return {
    externalBookId: externalBookId(book),
    externalBookIdRaw: externalBookIdValue(book),
    titleRaw: optionalString(firstDefined(book, ["titleRaw", "title_raw", "title"]), "titleRaw"),
    descriptionRaw: description.rawValue,
    descriptionPresent: description.present,
    descriptionJsonValueJson: description.jsonValueJson,
    descriptionTextView: description.textView,
    pageIndex: pageIndex(book),
    fetchedAt: fetchedAt(book),
  };
}

export function buildTokenEvidence(observations, books, options = {}) {
  const representativeSampleLimit = options.representativeSampleLimit ?? DEFAULT_REPRESENTATIVE_SAMPLE_LIMIT;
  const booksByKey = new Map(books.map((book) => [sampleBookKey(book), book]));
  const grouped = new Map();
  for (const observation of observations) {
    const key = tokenKey(observation);
    const bucket = grouped.get(key) ?? [];
    bucket.push(observation);
    grouped.set(key, bucket);
  }
  const evidence = [];
  for (const [key, bucket] of grouped) {
    const selected = representativeSelection(bucket, representativeSampleLimit);
    selected.forEach((observation, index) => {
      const book = booksByKey.get(observation.sampleBookKey);
      const allExactTokens = [...new Set(observations
        .filter((candidate) => candidate.sampleBookKey === observation.sampleBookKey)
        .map(({ exactRawToken }) => exactRawToken))].sort(compareText);
      evidence.push({
        tokenKeySha256: key,
        sampleBookKey: observation.sampleBookKey,
        evidenceRank: index + 1,
        selectionReason: index === 0 ? "first_observed_representative" : "additional_distinct_book",
        sourceScope: observation.sourceScope,
        languageJsonType: observation.languageJsonType,
        languageJsonValueJson: observation.languageJsonValueJson,
        languageNameRaw: observation.languageNameRaw,
        languageNameState: observation.languageNameState,
        rawLanguageScope: observation.rawLanguageScope,
        siteLocale: observation.siteLocale,
        localeKey: observation.localeKey,
        exactRawToken: observation.exactRawToken,
        rawTokenUtf8Base64: observation.rawTokenUtf8Base64,
        rawTokenSha256: observation.rawTokenSha256,
        allExactTokens,
        ...bookFacts(book),
      });
    });
  }
  return evidence.sort((left, right) => (
    compareText(left.tokenKeySha256, right.tokenKeySha256)
    || left.evidenceRank - right.evidenceRank
  ));
}

export function buildCooccurrence(observations) {
  const byScopeLocaleBook = new Map();
  const tokenFacts = new Map();
  for (const observation of observations) {
    const key = tokenKey(observation);
    tokenFacts.set(key, observation);
    const groupKey = JSON.stringify([observation.sourceScope, observation.localeKey, observation.sampleBookKey]);
    const group = byScopeLocaleBook.get(groupKey) ?? new Set();
    group.add(key);
    byScopeLocaleBook.set(groupKey, group);
  }

  const tokenBooks = new Map();
  const pairBooks = new Map();
  for (const [bookKey, keys] of byScopeLocaleBook) {
    const sortedKeys = [...keys].sort(compareText);
    for (const key of sortedKeys) {
      const books = tokenBooks.get(key) ?? new Set();
      books.add(bookKey);
      tokenBooks.set(key, books);
    }
    for (let left = 0; left < sortedKeys.length; left += 1) {
      for (let right = left + 1; right < sortedKeys.length; right += 1) {
        const pairKey = JSON.stringify([sortedKeys[left], sortedKeys[right]]);
        const books = pairBooks.get(pairKey) ?? new Set();
        books.add(bookKey);
        pairBooks.set(pairKey, books);
      }
    }
  }

  return [...pairBooks.entries()].map(([serializedPair, books]) => {
    const [tokenKeyA, tokenKeyB] = JSON.parse(serializedPair);
    const factA = tokenFacts.get(tokenKeyA);
    const factB = tokenFacts.get(tokenKeyB);
    const nA = tokenBooks.get(tokenKeyA).size;
    const nB = tokenBooks.get(tokenKeyB).size;
    const nAB = books.size;
    return {
      sourceScope: factA.sourceScope,
      localeKey: factA.localeKey,
      tokenKeyA,
      exactRawTokenA: factA.exactRawToken,
      rawTokenUtf8Base64A: factA.rawTokenUtf8Base64,
      rawTokenSha256A: factA.rawTokenSha256,
      tokenKeyB,
      exactRawTokenB: factB.exactRawToken,
      rawTokenUtf8Base64B: factB.rawTokenUtf8Base64,
      rawTokenSha256B: factB.rawTokenSha256,
      nA,
      nB,
      nAB,
      jaccard: nAB / (nA + nB - nAB),
      pBGivenA: nAB / nA,
      pAGivenB: nAB / nB,
    };
  }).sort((left, right) => (
    compareText(left.sourceScope, right.sourceScope)
    || compareText(left.localeKey, right.localeKey)
    || compareText(left.tokenKeyA, right.tokenKeyA)
    || compareText(left.tokenKeyB, right.tokenKeyB)
  ));
}

export function buildStructureAnomalySummary(anomalies, books = []) {
  const booksByKey = new Map(books.map((book) => [sampleBookKey(book), book]));
  const grouped = new Map();
  for (const rawAnomaly of anomalies) {
    const anomaly = requireRecord(rawAnomaly, "anomaly");
    const bookKey = firstDefined(anomaly, ["sampleBookKey", "sample_book_key", "bookIdentity", "book_identity"]);
    const book = typeof bookKey === "string" ? booksByKey.get(bookKey) : null;
    const anomalySourceScope = firstDefined(anomaly, ["sourceScope", "source_scope"])
      ?? (book ? sourceScope(book) : "UNKNOWN_SOURCE_SCOPE");
    const anomalyLanguageScope = firstDefined(anomaly, ["rawLanguageScope", "raw_language_scope"])
      ?? (book ? rawLanguageScope(book) : "UNKNOWN_RAW_LANGUAGE_SCOPE");
    const reason = firstDefined(anomaly, ["reason", "anomalyReason", "anomaly_reason"])
      ?? firstDefined(anomaly, ["structureStatus", "structure_status"])
      ?? "UNKNOWN_STRUCTURE_ANOMALY";
    const structureStatus = firstDefined(anomaly, ["structureStatus", "structure_status"])
      ?? "UNKNOWN_STRUCTURE_STATUS";
    for (const [value, label] of [
      [anomalySourceScope, "anomaly sourceScope"],
      [anomalyLanguageScope, "anomaly rawLanguageScope"],
      [reason, "anomaly reason"],
      [structureStatus, "anomaly structureStatus"],
    ]) requireString(value, label);
    const key = JSON.stringify([anomalySourceScope, anomalyLanguageScope, reason, structureStatus]);
    const bucket = grouped.get(key) ?? {
      sourceScope: anomalySourceScope,
      rawLanguageScope: anomalyLanguageScope,
      reason,
      structureStatus,
      anomalyCount: 0,
      bookKeys: new Set(),
    };
    bucket.anomalyCount += 1;
    if (typeof bookKey === "string") bucket.bookKeys.add(bookKey);
    grouped.set(key, bucket);
  }
  return [...grouped.values()].map(({ bookKeys, ...row }) => ({
    ...row,
    distinctBookCount: bookKeys.size,
  })).sort((left, right) => (
    compareText(left.sourceScope, right.sourceScope)
    || compareText(left.rawLanguageScope, right.rawLanguageScope)
    || compareText(left.reason, right.reason)
    || compareText(left.structureStatus, right.structureStatus)
  ));
}

function acquisitionIndex(record) {
  return optionalInteger(firstDefined(record, ["acquisitionIndex", "acquisition_index"]), "acquisitionIndex");
}

function selectedSampleIndex(record) {
  return optionalInteger(firstDefined(record, ["selectedSampleIndex", "selected_sample_index", "selectionIndex"]), "selectedSampleIndex");
}

function discoveryOrder(record, stage) {
  if (stage === "final_sample") {
    const selected = selectedSampleIndex(record);
    if (selected !== null) return selected;
  }
  return acquisitionIndex(record) ?? pageIndex(record) ?? Number.MAX_SAFE_INTEGER;
}

function orderedUniqueBooks(books, stage = "candidate_acquisition") {
  const unique = new Map();
  books.forEach((book, inputIndex) => {
    const key = sampleBookKey(book);
    if (!unique.has(key)) unique.set(key, { book, inputIndex });
  });
  return [...unique.values()].sort((left, right) => (
    discoveryOrder(left.book, stage) - discoveryOrder(right.book, stage)
    || (optionalInteger(firstDefined(left.book, ["rowIndex", "row_index"]), "rowIndex") ?? Number.MAX_SAFE_INTEGER)
      - (optionalInteger(firstDefined(right.book, ["rowIndex", "row_index"]), "rowIndex") ?? Number.MAX_SAFE_INTEGER)
    || left.inputIndex - right.inputIndex
  )).map(({ book }) => book);
}

function curveForBooks(books, observationsByBook, {
  stage,
  checkpointSize,
  rawLanguageScope: scopeLanguage = null,
}) {
  const orderedBooks = orderedUniqueBooks(books, stage)
    .filter((book) => scopeLanguage === null || rawLanguageScope(book) === scopeLanguage);
  const curves = [];
  const cumulative = new Set();
  for (let end = checkpointSize; end < orderedBooks.length + checkpointSize; end += checkpointSize) {
    const checkpointSampleCount = Math.min(end, orderedBooks.length);
    if (checkpointSampleCount === 0) break;
    const start = Math.max(0, end - checkpointSize);
    const block = orderedBooks.slice(start, checkpointSampleCount);
    const before = cumulative.size;
    for (const book of block) {
      for (const observation of observationsByBook.get(sampleBookKey(book)) ?? []) cumulative.add(tokenKey(observation));
    }
    curves.push({
      discoveryStage: stage,
      checkpointScope: scopeLanguage === null ? "global" : "raw_language_scope",
      rawLanguageScope: scopeLanguage,
      checkpointSampleCount,
      blockSampleCount: block.length,
      newDistinctMappingKeys: cumulative.size - before,
      cumulativeDistinctMappingKeys: cumulative.size,
      blockNoveltyRate: block.length === 0 ? 0 : (cumulative.size - before) / block.length,
    });
    if (checkpointSampleCount === orderedBooks.length) break;
  }
  return curves;
}

export function buildDiscoveryCurves(books, observations, options = {}) {
  const globalCheckpointSize = options.discoveryCheckpointSize ?? DEFAULT_DISCOVERY_CHECKPOINT_SIZE;
  const languageCheckpointSize = options.languageDiscoveryCheckpointSize ?? 500;
  const candidateBooks = orderedUniqueBooks(books, "candidate_acquisition");
  const finalBooks = candidateBooks.filter((book) => selectedSampleIndex(book) !== null);
  const selectionProvided = options.finalSelectionProvided === true
    || candidateBooks.some((book) => firstDefined(book, ["selectedSampleIndex", "selected_sample_index", "selectionIndex"]) !== undefined);
  const effectiveFinalBooks = selectionProvided ? finalBooks : candidateBooks;
  const checkpointSizes = [globalCheckpointSize, languageCheckpointSize];
  for (const checkpointSize of checkpointSizes) {
    if (!Number.isSafeInteger(checkpointSize) || checkpointSize < 1) throw new TypeError("discovery checkpoint sizes must be positive");
  }
  const observationsByBook = new Map();
  for (const observation of observations) {
    const bucket = observationsByBook.get(observation.sampleBookKey) ?? [];
    bucket.push(observation);
    observationsByBook.set(observation.sampleBookKey, bucket);
  }
  const languageScopes = [...new Set(effectiveFinalBooks.map(rawLanguageScope))].sort(compareText);
  return [
    ...curveForBooks(candidateBooks, observationsByBook, {
      stage: "candidate_acquisition",
      checkpointSize: globalCheckpointSize,
    }),
    ...curveForBooks(effectiveFinalBooks, observationsByBook, {
      stage: "final_sample",
      checkpointSize: globalCheckpointSize,
    }),
    ...languageScopes.flatMap((scopeLanguage) => curveForBooks(effectiveFinalBooks, observationsByBook, {
      stage: "final_sample",
      checkpointSize: languageCheckpointSize,
      rawLanguageScope: scopeLanguage,
    })),
  ];
}

export function assessDiscoveryStatus(curves, actualUniqueBooks, options = {}) {
  const targetUniqueBooks = options.targetUniqueBooks ?? 10_000;
  if (options.languageQuotaSatisfiedOrExhausted !== true
    || options.rawRoundTripQaPassed !== true
    || options.requestBudgetQaPassed !== true) return "TAXONOMY_DISCOVERY_NOT_SATURATED";
  if (actualUniqueBooks < targetUniqueBooks) return "TAXONOMY_DISCOVERY_NOT_SATURATED";
  const globalFinal = curves.filter(({ discoveryStage, checkpointScope }) => (
    discoveryStage === "final_sample" && checkpointScope === "global"
  ));
  if (globalFinal.length < 3) return "TAXONOMY_DISCOVERY_NOT_SATURATED";
  const lastThree = globalFinal.slice(-3);
  const globalSaturated = lastThree.every((curve, index) => {
    const priorDistinct = globalFinal[globalFinal.length - 4 + index]?.cumulativeDistinctMappingKeys ?? 0;
    return curve.blockSampleCount === 1_000
      && curve.newDistinctMappingKeys <= Math.max(3, priorDistinct * 0.01);
  });
  if (!globalSaturated) return "TAXONOMY_DISCOVERY_NOT_SATURATED";
  const byLanguage = new Map();
  for (const curve of curves.filter(({ discoveryStage, checkpointScope }) => (
    discoveryStage === "final_sample" && checkpointScope === "raw_language_scope"
  ))) {
    const bucket = byLanguage.get(curve.rawLanguageScope) ?? [];
    bucket.push(curve);
    byLanguage.set(curve.rawLanguageScope, bucket);
  }
  for (const languageCurves of byLanguage.values()) {
    const last = languageCurves.at(-1);
    if (last.checkpointSampleCount < 1_000) continue;
    const prior = languageCurves.at(-2)?.cumulativeDistinctMappingKeys ?? 0;
    if (last.blockSampleCount !== 500
      || last.newDistinctMappingKeys > Math.max(2, prior * 0.02)) {
      return "TAXONOMY_DISCOVERY_NOT_SATURATED";
    }
  }
  return "TAXONOMY_DISCOVERY_SATURATED";
}

function localeDistribution(books) {
  const groups = new Map();
  for (const book of orderedUniqueBooks(books)) {
    const key = localeKey(book);
    const group = groups.get(key) ?? {
      languageJsonType: languageJsonType(book),
      languageJsonValueJson: languageJsonValueJson(book),
      languageNameRaw: languageName(book),
      languageNameState: languageNameState(book),
      rawLanguageScope: rawLanguageScope(book),
      siteLocale: siteLocale(book),
      localeKey: key,
      sampleCount: 0,
    };
    group.sampleCount += 1;
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((left, right) => right.sampleCount - left.sampleCount || compareText(left.localeKey, right.localeKey));
}

export function analyzeB1RawRecords(input, options = {}) {
  const books = input.books.map((book) => requireRecord(book, "book"));
  const uniqueBooks = orderedUniqueBooks(books);
  const booksByKey = new Map(uniqueBooks.map((book) => [sampleBookKey(book), book]));
  const extracted = input.observations !== undefined
    ? { observations: input.observations.map((observation) => normalizeObservation(observation, booksByKey)), anomalies: input.anomalies ?? [] }
    : (() => {
      const fromBooks = extractObservationsFromBooks(uniqueBooks);
      return { ...fromBooks, anomalies: input.anomalies ?? fromBooks.anomalies };
    })();
  const selectionProvided = options.finalSelectionProvided === true
    || uniqueBooks.some((book) => firstDefined(book, ["selectedSampleIndex", "selected_sample_index", "selectionIndex"]) !== undefined);
  const finalBooks = uniqueBooks.filter((book) => selectedSampleIndex(book) !== null);
  const effectiveFinalBooks = selectionProvided ? finalBooks : uniqueBooks;
  const finalBookKeys = new Set(effectiveFinalBooks.map(sampleBookKey));
  const finalObservations = extracted.observations.filter(({ sampleBookKey: key }) => finalBookKeys.has(key));
  const inventory = buildTaxonomyInventory(finalObservations, options);
  const evidence = buildTokenEvidence(finalObservations, effectiveFinalBooks, options);
  const cooccurrence = buildCooccurrence(finalObservations);
  const discoveryCurves = buildDiscoveryCurves(uniqueBooks, extracted.observations, options);
  const finalTokenKeys = new Set(finalObservations.map(tokenKey));
  const candidateTokenKeys = new Set(extracted.observations.map(tokenKey));
  const discoveryStatus = assessDiscoveryStatus(discoveryCurves, effectiveFinalBooks.length, options);
  const structureAnomalySummary = buildStructureAnomalySummary(extracted.anomalies, uniqueBooks);
  return {
    books: uniqueBooks,
    observations: extracted.observations,
    anomalies: extracted.anomalies,
    structureAnomalySummary,
    inventory,
    evidence,
    cooccurrence,
    discoveryCurves,
    localeDistribution: localeDistribution(effectiveFinalBooks),
    summary: {
      actualUniqueBooks: effectiveFinalBooks.length,
      candidateUniqueBooks: uniqueBooks.length,
      totalSourceTokens: inventory.length,
      empiricalTokenCoverage: candidateTokenKeys.size === 0 ? null : finalTokenKeys.size / candidateTokenKeys.size,
      taxonomyCoverageRate: null,
      taxonomyCoverageStatus: "NOT_ESTIMABLE_NO_DENOMINATOR",
      discoveryStatus,
      languageQuotaSatisfiedOrExhausted: options.languageQuotaSatisfiedOrExhausted === true,
      rawRoundTripQaPassed: options.rawRoundTripQaPassed === true,
      requestBudgetQaPassed: options.requestBudgetQaPassed === true,
      laneBSampleStatus: effectiveFinalBooks.length === 0
        ? "BLOCKED"
        : effectiveFinalBooks.length >= (options.targetUniqueBooks ?? 10_000) ? "COMPLETE" : "PARTIAL",
      laneBMappingStatus: "WAITING_FOR_CANONICAL_TAG_V1",
      ownerReviewItems: 0,
    },
  };
}

export const B1_INTERNAL_IDENTITIES = Object.freeze({
  sampleBookKey,
  rawLanguageScope,
});

export const B1_ANALYSIS_DEFAULTS = Object.freeze({
  discoveryCheckpointSize: DEFAULT_DISCOVERY_CHECKPOINT_SIZE,
  representativeSampleLimit: DEFAULT_REPRESENTATIVE_SAMPLE_LIMIT,
});
