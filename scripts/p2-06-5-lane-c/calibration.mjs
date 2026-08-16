import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

/**
 * Lane C is intentionally an offline calibration tool.  This module must not
 * import Prisma, adapters, worker code, or fetch.  Its only inputs are the
 * versioned JSON/JSONL files supplied to the command line wrapper.
 */

export const CALIBRATION_STATUS = "CALIBRATION_REVIEW_PENDING";
export const RECOMMENDATION_STATUS = "CALIBRATION_RECOMMENDATION_ONLY";

export const INITIAL_LANE_C_STATUS = Object.freeze({
  LANE_C_C1_STATUS: "BLOCKED_ON_VERSIONED_SAMPLE_AND_TAXONOMY_ASSETS",
  LANE_C_C2_STATUS: "BLOCKED_ON_APPROVED_OFFLINE_PREVIEW_CORPUS",
  TEXT_CALIBRATION_STATUS: "NOT_RUN",
  CHAPTER_EVIDENCE_STATUS: "NOT_RUN",
  OWNER_DECISION_ITEMS: "final_taxonomy_keyword_snapshot; approved_source_mapping; C1_review_adjudications; C2_chapter_decision",
});

export const C1_CONFIGURATIONS = Object.freeze([
  { id: "A", titleWeight: 30, descriptionWeight: 20, chapterWeight: 0, threshold: 30, priority: 1 },
  { id: "B", titleWeight: 30, descriptionWeight: 25, chapterWeight: 0, threshold: 30, priority: 0 },
  { id: "C", titleWeight: 30, descriptionWeight: 30, chapterWeight: 0, threshold: 30, priority: 2 },
]);

export const C1_MAX_TEXT_TAGS = Object.freeze([2, 3, 5]);
export const C1_V3_CONFIGURATION = Object.freeze({
  id: "C", titleWeight: 30, descriptionWeight: 30, chapterWeight: 0, threshold: 30, priority: 2,
});
export const C1_V3_MAX_TEXT_TAGS = Object.freeze([3]);
const ALLOWED_FIELDS = new Set(["title", "description", "chapter"]);
export const C2_CONFIGURATIONS = Object.freeze([
  { id: "B_BASELINE", titleWeight: 30, descriptionWeight: 25, chapterWeight: 0, threshold: 30, priority: 0 },
  { id: "B_CHAPTER_10", titleWeight: 30, descriptionWeight: 25, chapterWeight: 10, threshold: 30, priority: 0 },
  { id: "B_CHAPTER_15", titleWeight: 30, descriptionWeight: 25, chapterWeight: 15, threshold: 30, priority: 0 },
]);

const SCRIPT_BUCKETS = new Set(["latin", "cjk", "other", "unknown"]);
const MATCH_MODES = new Set(["unicode_word", "cjk_contiguous", "auto"]);
const REVIEW_VERDICTS = new Set(["CORRECT", "FALSE_POSITIVE", "AMBIGUOUS", "NOT_ADJUDICABLE"]);
const FINAL_VERDICTS = new Set([
  "FINAL_CORRECT",
  "FINAL_FALSE_POSITIVE",
  "FINAL_AMBIGUOUS",
  "TAXONOMY_DECISION_REQUIRED",
  "SOURCE_MAPPING_REVIEW_REQUIRED",
  "DATA_INVALID",
]);
const LOW_CONFIDENCE_FLAGS = new Set([
  "GENERIC_TERM",
  "POLYSEMY_OR_PROPER_NAME",
  "CJK_SUBSTRING",
  "BACKGROUND_ONLY",
  "NEGATED_QUOTED_HYPOTHETICAL",
  "FACET_OR_HIERARCHY_AMBIGUITY",
  "CONTRADICTORY_TEXT_EVIDENCE",
  "UNSUPPORTED_LOCALE_OR_BOUNDARY",
  "CHAPTER_LOCAL_SCENE",
  "INPUT_INCOMPLETE",
]);

function fail(message) {
  throw new TypeError(`P2-06.5 Lane C input invalid: ${message}`);
}

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
  return value;
}

function string(value, name, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) fail(`${name} must be a ${allowEmpty ? "string" : "non-empty string"}`);
  return value;
}

function optionalString(value, name) {
  if (value === undefined || value === null) return null;
  return string(value, name, { allowEmpty: true });
}

function boolean(value, name) {
  if (typeof value !== "boolean") fail(`${name} must be boolean`);
  return value;
}

function integer(value, name, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) fail(`${name} must be a safe integer >= ${min}`);
  return value;
}

function array(value, name) {
  if (!Array.isArray(value)) fail(`${name} must be an array`);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Deterministic object serialization for version fingerprints and sampling. */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function fingerprint(value) {
  return sha256(stableStringify(value));
}

export function codePointLength(value) {
  return Array.from(value).length;
}

function truncateCodePoints(value, count) {
  const points = Array.from(value);
  return points.length <= count ? value : `${points.slice(0, count).join("")}…`;
}

function percentile(values, q) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index];
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function sortByHash(rows, key) {
  return [...rows].sort((left, right) => {
    const leftHash = sha256(key(left));
    const rightHash = sha256(key(right));
    return leftHash.localeCompare(rightHash) || key(left).localeCompare(key(right));
  });
}

function mapValues(map) {
  return [...map.values()];
}

function uniqueStrings(values, name, { allowEmpty = false } = {}) {
  const result = array(values, name).map((value, index) => string(value, `${name}[${index}]`, { allowEmpty }));
  if (new Set(result).size !== result.length) fail(`${name} must not contain duplicates`);
  return result;
}

export function validateTaxonomy(rawTaxonomy) {
  const taxonomy = object(rawTaxonomy, "taxonomy-keywords");
  const taxonomyVersion = string(taxonomy.taxonomyVersion, "taxonomyVersion");
  const keywordLexiconVersion = string(taxonomy.keywordLexiconVersion, "keywordLexiconVersion");
  const rawTags = array(taxonomy.canonicalTags, "canonicalTags");
  const tagIds = new Set();
  const slugs = new Set();
  const keywordIds = new Set();
  const canonicalTags = rawTags.map((rawTag, tagIndex) => {
    const tag = object(rawTag, `canonicalTags[${tagIndex}]`);
    const canonicalTagId = string(tag.canonicalTagId, `canonicalTags[${tagIndex}].canonicalTagId`);
    const slug = string(tag.slug, `canonicalTags[${tagIndex}].slug`);
    if (tagIds.has(canonicalTagId)) fail(`duplicate canonicalTagId ${canonicalTagId}`);
    if (slugs.has(slug)) fail(`duplicate canonical tag slug ${slug}`);
    tagIds.add(canonicalTagId);
    slugs.add(slug);
    const textSelectionPriority = integer(tag.textSelectionPriority, `canonicalTags[${tagIndex}].textSelectionPriority`);
    const definition = string(tag.definition, `canonicalTags[${tagIndex}].definition`);
    const keywordCoverageStatus = tag.keywordCoverageStatus ?? "RELIABLE";
    if (keywordCoverageStatus !== "RELIABLE" && keywordCoverageStatus !== "KEYWORD_COVERAGE_INSUFFICIENT") {
      fail(`canonicalTags[${tagIndex}].keywordCoverageStatus is not registered`);
    }
    const keywords = array(tag.keywords, `canonicalTags[${tagIndex}].keywords`).map((rawKeyword, keywordIndex) => {
      const keyword = object(rawKeyword, `canonicalTags[${tagIndex}].keywords[${keywordIndex}]`);
      const keywordId = string(keyword.keywordId, `canonicalTags[${tagIndex}].keywords[${keywordIndex}].keywordId`);
      if (keywordIds.has(keywordId)) fail(`duplicate keywordId ${keywordId}`);
      keywordIds.add(keywordId);
      const value = string(keyword.value, `canonicalTags[${tagIndex}].keywords[${keywordIndex}].value`);
      const scriptBuckets = uniqueStrings(keyword.scriptBuckets, `canonicalTags[${tagIndex}].keywords[${keywordIndex}].scriptBuckets`);
      for (const scriptBucket of scriptBuckets) {
        if (!SCRIPT_BUCKETS.has(scriptBucket)) fail(`keyword ${keywordId} has unsupported script bucket ${scriptBucket}`);
      }
      const matchMode = keyword.matchMode ?? "auto";
      if (!MATCH_MODES.has(matchMode)) fail(`keyword ${keywordId} has unsupported matchMode`);
      const sourceLanguageCodes = keyword.sourceLanguageCodes === undefined
        ? []
        : uniqueStrings(keyword.sourceLanguageCodes, `keyword ${keywordId}.sourceLanguageCodes`);
      const riskFlags = keyword.riskFlags === undefined
        ? []
        : uniqueStrings(keyword.riskFlags, `keyword ${keywordId}.riskFlags`);
      const allowedFields = keyword.allowedFields === undefined
        ? null
        : uniqueStrings(keyword.allowedFields, `keyword ${keywordId}.allowedFields`);
      if (allowedFields) {
        for (const field of allowedFields) {
          if (!ALLOWED_FIELDS.has(field)) fail(`keyword ${keywordId} has unsupported allowedFields value ${field}`);
        }
      }
      const blockedDescriptionNamedScopes = keyword.blockedDescriptionNamedScopes === undefined
        ? []
        : uniqueStrings(keyword.blockedDescriptionNamedScopes, `keyword ${keywordId}.blockedDescriptionNamedScopes`);
      return {
        keywordId, value, scriptBuckets, matchMode, sourceLanguageCodes, riskFlags,
        allowedFields, blockedDescriptionNamedScopes,
      };
    });
    if (keywordCoverageStatus === "RELIABLE" && keywords.length === 0) {
      fail(`reliable tag ${canonicalTagId} must carry at least one keyword`);
    }
    if (keywordCoverageStatus === "KEYWORD_COVERAGE_INSUFFICIENT" && keywords.length !== 0) {
      fail(`coverage-insufficient tag ${canonicalTagId} must not carry active keywords`);
    }
    return { canonicalTagId, slug, definition, textSelectionPriority, keywordCoverageStatus, keywords };
  });
  return { taxonomyVersion, keywordLexiconVersion, canonicalTags, fingerprint: fingerprint(taxonomy) };
}

export function validateSamples(rawSamples) {
  const seenRows = new Set();
  const samples = rawSamples.map((rawSample, index) => {
    const sample = object(rawSample, `samples[${index}]`);
    const sampleRowId = string(sample.sampleRowId, `samples[${index}].sampleRowId`);
    if (seenRows.has(sampleRowId)) fail(`duplicate sampleRowId ${sampleRowId}`);
    seenRows.add(sampleRowId);
    const novelIdentity = string(sample.novelIdentity, `samples[${index}].novelIdentity`);
    const sourceLanguageCode = string(sample.sourceLanguageCode, `samples[${index}].sourceLanguageCode`);
    const sourceLanguageName = string(sample.sourceLanguageName, `samples[${index}].sourceLanguageName`, { allowEmpty: true });
    const channelAppId = sample.channelAppId === undefined ? null : string(sample.channelAppId, `samples[${index}].channelAppId`);
    const rawLanguageScope = sample.rawLanguageScope === undefined ? null : string(sample.rawLanguageScope, `samples[${index}].rawLanguageScope`);
    if ((channelAppId === null) !== (rawLanguageScope === null)) fail(`samples[${index}] must provide channelAppId and rawLanguageScope together`);
    const resolvedLocale = sample.resolvedLocale === undefined || sample.resolvedLocale === null ? null : string(sample.resolvedLocale, `samples[${index}].resolvedLocale`);
    const localeStatisticsStatus = sample.localeStatisticsStatus === undefined ? null : string(sample.localeStatisticsStatus, `samples[${index}].localeStatisticsStatus`);
    const sourceSnapshotId = string(sample.sourceSnapshotId, `samples[${index}].sourceSnapshotId`);
    const scriptBucket = string(sample.scriptBucket, `samples[${index}].scriptBucket`);
    if (!SCRIPT_BUCKETS.has(scriptBucket)) fail(`samples[${index}].scriptBucket is not registered`);
    const title = string(sample.title, `samples[${index}].title`, { allowEmpty: true });
    const description = string(sample.description, `samples[${index}].description`, { allowEmpty: true });
    const seriesTypeList = uniqueStrings(sample.seriesTypeList, `samples[${index}].seriesTypeList`, { allowEmpty: true });
    const sourceSnapshotComplete = boolean(sample.sourceSnapshotComplete, `samples[${index}].sourceSnapshotComplete`);
    const manualSnapshotComplete = boolean(sample.manualSnapshotComplete ?? false, `samples[${index}].manualSnapshotComplete`);
    const manualCanonicalTagIds = sample.manualCanonicalTagIds === undefined
      ? []
      : uniqueStrings(sample.manualCanonicalTagIds, `samples[${index}].manualCanonicalTagIds`);
    if (!manualSnapshotComplete && manualCanonicalTagIds.length > 0) {
      fail(`samples[${index}].manualCanonicalTagIds requires manualSnapshotComplete=true`);
    }
    const sourceObservedAt = optionalString(sample.sourceObservedAt, `samples[${index}].sourceObservedAt`);
    return {
      sampleRowId,
      novelIdentity,
      sourceLanguageCode,
      sourceLanguageName,
      channelAppId,
      rawLanguageScope,
      resolvedLocale,
      localeStatisticsStatus,
      sourceSnapshotId,
      scriptBucket,
      title,
      description,
      seriesTypeList,
      sourceSnapshotComplete,
      manualSnapshotComplete,
      manualCanonicalTagIds,
      sourceObservedAt,
      titleHash: sha256(title),
      descriptionHash: sha256(description),
    };
  });
  return { samples, fingerprint: fingerprint(rawSamples) };
}

export function validateSourceMapping(rawMapping, taxonomy) {
  if (rawMapping === null || rawMapping === undefined) return null;
  const mapping = object(rawMapping, "source-mapping");
  const mappingVersion = string(mapping.mappingVersion, "source-mapping.mappingVersion");
  if (mapping.approvalStatus !== "APPROVED" && mapping.approvalStatus !== "APPROVED_OFFLINE_CANDIDATE_ONLY") fail("source-mapping.approvalStatus is not approved for offline calibration");
  const tagIds = new Set(taxonomy.canonicalTags.map(({ canonicalTagId }) => canonicalTagId));
  const exact = new Map();
  const exactScoped = new Map();
  for (const [index, rawEntry] of array(mapping.mappings, "source-mapping.mappings").entries()) {
    const entry = object(rawEntry, `source-mapping.mappings[${index}]`);
    if (entry.sourceLabelKind !== "series_type") fail("source mapping accepts only approved series_type entries");
    const externalLabelValue = string(entry.externalLabelValue, `source-mapping.mappings[${index}].externalLabelValue`, { allowEmpty: true });
    const channelAppId = entry.channelAppId === undefined ? null : string(entry.channelAppId, `source-mapping.mappings[${index}].channelAppId`);
    const rawLanguageScope = entry.rawLanguageScope === undefined ? null : string(entry.rawLanguageScope, `source-mapping.mappings[${index}].rawLanguageScope`);
    if ((channelAppId === null) !== (rawLanguageScope === null)) fail(`source-mapping.mappings[${index}] must provide channelAppId and rawLanguageScope together`);
    const canonicalTagIds = uniqueStrings(entry.canonicalTagIds, `source-mapping.mappings[${index}].canonicalTagIds`);
    for (const tagId of canonicalTagIds) if (!tagIds.has(tagId)) fail(`source mapping references unknown canonical tag ${tagId}`);
    if (channelAppId === null) {
      if (exact.has(externalLabelValue)) fail(`duplicate exact source mapping token ${JSON.stringify(externalLabelValue)}`);
      exact.set(externalLabelValue, canonicalTagIds);
    } else {
      const scopedKey = stableStringify([channelAppId, rawLanguageScope, externalLabelValue]);
      if (exactScoped.has(scopedKey)) fail(`duplicate exact scoped source mapping identity ${scopedKey}`);
      exactScoped.set(scopedKey, canonicalTagIds);
    }
  }
  const mutuallyExclusivePairs = array(mapping.mutuallyExclusivePairs ?? [], "source-mapping.mutuallyExclusivePairs").map((pair, index) => {
    const values = uniqueStrings(pair, `source-mapping.mutuallyExclusivePairs[${index}]`);
    if (values.length !== 2) fail("each mutuallyExclusivePairs item must contain exactly two canonical tag ids");
    for (const tagId of values) if (!tagIds.has(tagId)) fail(`mutually exclusive pair references unknown tag ${tagId}`);
    return [...values].sort();
  });
  return { mappingVersion, approvalStatus: mapping.approvalStatus, exact, exactScoped, mutuallyExclusivePairs, fingerprint: fingerprint(mapping) };
}

export function validatePreviewCorpus(rawRows, samples) {
  const sampleIds = new Set(samples.map(({ sampleRowId }) => sampleRowId));
  const bySampleId = new Map();
  for (const [index, rawEntry] of rawRows.entries()) {
    const entry = object(rawEntry, `preview-corpus[${index}]`);
    const sampleRowId = string(entry.sampleRowId, `preview-corpus[${index}].sampleRowId`);
    if (!sampleIds.has(sampleRowId)) fail(`preview corpus references unknown sample ${sampleRowId}`);
    if (bySampleId.has(sampleRowId)) fail(`preview corpus repeats sample ${sampleRowId}`);
    const chapters = array(entry.chapters, `preview-corpus[${index}].chapters`).map((rawChapter, chapterIndex) => {
      const chapter = object(rawChapter, `preview-corpus[${index}].chapters[${chapterIndex}]`);
      const chapterNumber = integer(chapter.chapterNumber, `preview-corpus[${index}].chapters[${chapterIndex}].chapterNumber`, { min: 1 });
      if (chapterNumber > 3) fail("preview corpus may contain only chapters 1-3");
      const body = string(chapter.body, `preview-corpus[${index}].chapters[${chapterIndex}].body`);
      const contentHash = string(chapter.contentHash, `preview-corpus[${index}].chapters[${chapterIndex}].contentHash`);
      const charCount = integer(chapter.charCount, `preview-corpus[${index}].chapters[${chapterIndex}].charCount`);
      if (sha256(body) !== contentHash) fail(`preview corpus chapter hash mismatch for ${sampleRowId}/${chapterNumber}`);
      if (codePointLength(body) !== charCount) fail(`preview corpus charCount mismatch for ${sampleRowId}/${chapterNumber}`);
      return { chapterNumber, body, contentHash, charCount };
    }).sort((left, right) => left.chapterNumber - right.chapterNumber);
    if (new Set(chapters.map(({ chapterNumber }) => chapterNumber)).size !== chapters.length) {
      fail(`preview corpus has duplicate chapter numbers for ${sampleRowId}`);
    }
    const requestCount = integer(entry.requestCount, `preview-corpus[${index}].requestCount`, { min: 0 });
    const fetchDurationMs = integer(entry.fetchDurationMs, `preview-corpus[${index}].fetchDurationMs`, { min: 0 });
    const responseBytes = integer(entry.responseBytes, `preview-corpus[${index}].responseBytes`, { min: 0 });
    bySampleId.set(sampleRowId, { sampleRowId, chapters, requestCount, fetchDurationMs, responseBytes });
  }
  return { bySampleId, fingerprint: fingerprint(rawRows) };
}

function normalizedFieldName(field) {
  if (field === "previewChapters" || (typeof field === "string" && field.startsWith("chapter:"))) return "chapter";
  return field ?? null;
}

function keywordApplies(keyword, sample, field) {
  if (!keyword.scriptBuckets.includes(sample.scriptBucket)) return false;
  if (keyword.sourceLanguageCodes.length > 0 && !keyword.sourceLanguageCodes.includes(sample.sourceLanguageCode)) return false;
  const normalizedField = normalizedFieldName(field);
  if (normalizedField && Array.isArray(keyword.allowedFields) && !keyword.allowedFields.includes(normalizedField)) return false;
  const blocked = keyword.blockedDescriptionNamedScopes ?? [];
  if (normalizedField === "description" && blocked.length > 0 && blocked.includes(sample.sourceLanguageName)) return false;
  return true;
}

function resolvedMode(keyword, sample) {
  if (keyword.matchMode !== "auto") return keyword.matchMode;
  if (sample.scriptBucket === "latin") return "unicode_word";
  if (sample.scriptBucket === "cjk") return "cjk_contiguous";
  return null;
}

function escapedRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function codePointOffset(value, codeUnitOffset) {
  return Array.from(value.slice(0, codeUnitOffset)).length;
}

function excerpt(value, startCodeUnit, endCodeUnit) {
  const points = Array.from(value);
  const start = codePointOffset(value, startCodeUnit);
  const end = codePointOffset(value, endCodeUnit);
  return {
    start,
    end,
    excerpt: points.slice(Math.max(0, start - 60), Math.min(points.length, end + 60)).join(""),
  };
}

/** Return a single deterministic match for one keyword and field. */
export function findKeywordMatch(value, keyword, sample, field) {
  if (!keywordApplies(keyword, sample, field)) return null;
  const mode = resolvedMode(keyword, sample);
  if (!mode || sample.scriptBucket === "other" || sample.scriptBucket === "unknown") return null;
  const text = value.normalize("NFC");
  const term = keyword.value.normalize("NFC");
  if (term.length === 0) return null;
  let startCodeUnit = -1;
  let endCodeUnit = -1;
  if (mode === "unicode_word") {
    if (sample.scriptBucket !== "latin") return null;
    const match = new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_])${escapedRegex(term)}(?![\\p{L}\\p{N}\\p{M}_])`, "iu").exec(text);
    if (!match || match.index === undefined) return null;
    startCodeUnit = match.index;
    endCodeUnit = match.index + match[0].length;
  } else if (mode === "cjk_contiguous") {
    if (sample.scriptBucket !== "cjk") return null;
    startCodeUnit = text.indexOf(term);
    if (startCodeUnit < 0) return null;
    endCodeUnit = startCodeUnit + term.length;
  } else {
    return null;
  }
  return {
    keywordId: keyword.keywordId,
    keyword: keyword.value,
    matchMode: mode,
    ...excerpt(text, startCodeUnit, endCodeUnit),
    inputFieldSha256: sha256(value),
    riskFlags: keyword.riskFlags,
  };
}

function matchTagField(tag, value, sample, field) {
  if (tag.keywordCoverageStatus !== "RELIABLE") {
    return { matched: false, coverageStatus: "KEYWORD_COVERAGE_INSUFFICIENT", field, matches: [] };
  }
  if (sample.scriptBucket !== "latin" && sample.scriptBucket !== "cjk") {
    return { matched: false, coverageStatus: "KEYWORD_COVERAGE_INSUFFICIENT", field, matches: [] };
  }
  const matches = tag.keywords.map((keyword) => findKeywordMatch(value, keyword, sample, field)).filter(Boolean);
  const applicable = tag.keywords.some((keyword) => keywordApplies(keyword, sample, field) && resolvedMode(keyword, sample));
  return {
    matched: matches.length > 0,
    coverageStatus: applicable ? "RELIABLE" : "KEYWORD_COVERAGE_INSUFFICIENT",
    field,
    matches,
  };
}

function tagCoverageStatus(tag, sample) {
  if (tag.keywordCoverageStatus !== "RELIABLE" || (sample.scriptBucket !== "latin" && sample.scriptBucket !== "cjk")) {
    return "KEYWORD_COVERAGE_INSUFFICIENT";
  }
  return tag.keywords.some((keyword) => keywordApplies(keyword, sample) && resolvedMode(keyword, sample))
    ? "RELIABLE"
    : "KEYWORD_COVERAGE_INSUFFICIENT";
}

function matchTagChapters(tag, preview, sample) {
  if (!preview) return { matched: false, coverageStatus: tagCoverageStatus(tag, sample), field: "previewChapters", matches: [] };
  const matches = [];
  for (const chapter of preview.chapters) {
    const fieldResult = matchTagField(tag, chapter.body, sample, `chapter:${chapter.chapterNumber}`);
    for (const match of fieldResult.matches) {
      matches.push({ ...match, chapterNumber: chapter.chapterNumber, chapterContentHash: chapter.contentHash });
    }
  }
  return {
    matched: matches.length > 0,
    coverageStatus: tagCoverageStatus(tag, sample),
    field: "previewChapters",
    matches,
  };
}

function sourceEvidence(sample, mapping) {
  if (!mapping) return { status: "MAPPING_UNAVAILABLE", canonicalTagIds: [], exactTokens: [] };
  if (!sample.sourceSnapshotComplete) return { status: "SOURCE_SNAPSHOT_UNUSABLE", canonicalTagIds: [], exactTokens: [] };
  const scoped = sample.channelAppId !== null && sample.rawLanguageScope !== null;
  const tokenLookup = (token) => scoped
    ? mapping.exactScoped?.get(stableStringify([sample.channelAppId, sample.rawLanguageScope, token]))
    : mapping.exact.get(token);
  const exactTokens = sample.seriesTypeList.filter((token) => tokenLookup(token) !== undefined);
  return {
    status: "SOURCE_SNAPSHOT_COMPLETE",
    canonicalTagIds: [...new Set(exactTokens.flatMap((token) => tokenLookup(token)))].sort(),
    exactTokens,
  };
}

function hasMutualExclusivity(sourceTagIds, textTagIds, mapping) {
  if (!mapping) return false;
  const combined = new Set([...sourceTagIds, ...textTagIds]);
  return mapping.mutuallyExclusivePairs.some(([left, right]) => combined.has(left) && combined.has(right)
    && ((sourceTagIds.includes(left) && textTagIds.includes(right)) || (sourceTagIds.includes(right) && textTagIds.includes(left))));
}

function evidenceClass(titleMatched, descriptionMatched, chapterMatched) {
  if (chapterMatched && !titleMatched && !descriptionMatched) return "CHAPTER_ONLY";
  if (chapterMatched && titleMatched && descriptionMatched) return "TITLE_DESCRIPTION_CHAPTER";
  if (chapterMatched && titleMatched) return "TITLE_CHAPTER";
  if (chapterMatched && descriptionMatched) return "DESCRIPTION_CHAPTER";
  if (titleMatched && descriptionMatched) return "TITLE_DESCRIPTION";
  if (titleMatched) return "TITLE_ONLY";
  if (descriptionMatched) return "DESCRIPTION_ONLY";
  return "ZERO_HIT";
}

function makeBaseMatchMatrix(samples, taxonomy, previewBySampleId) {
  const matrix = new Map();
  for (const sample of samples) {
    const perTag = new Map();
    let reliableCoverage = false;
    for (const tag of taxonomy.canonicalTags) {
      const fields = {
        title: matchTagField(tag, sample.title, sample, "title"),
        description: matchTagField(tag, sample.description, sample, "description"),
        chapter: matchTagChapters(tag, previewBySampleId?.get(sample.sampleRowId), sample),
      };
      if ([fields.title, fields.description, fields.chapter].some(({ coverageStatus }) => coverageStatus === "RELIABLE")) reliableCoverage = true;
      if (fields.title.matched || fields.description.matched || fields.chapter.matched) perTag.set(tag.canonicalTagId, fields);
    }
    matrix.set(sample.sampleRowId, { perTag, reliableCoverage });
  }
  return matrix;
}

function perLanguageKey(sample) {
  return stableStringify([sample.scriptBucket, sample.sourceLanguageCode, sample.sourceLanguageName, sample.rawLanguageScope]);
}

function aggregateGroups(bookDiagnostics) {
  const group = (rows) => {
    const assessed = rows.filter((row) => !row.manualSnapshotComplete);
    const hitRows = assessed.filter((row) => row.selectedTextTagCount > 0);
    const rawCounts = assessed.map((row) => row.rawEligibleTextTagCount);
    const selectedCounts = assessed.map((row) => row.selectedTextTagCount);
    return {
      sampleCount: rows.length,
      textDecisionSampleCount: assessed.length,
      manualExcludedCount: rows.length - assessed.length,
      textHitRate: ratio(hitRows.length, assessed.length),
      titleOnlyRate: ratio(assessed.filter((row) => row.hasTitleOnly).length, assessed.length),
      descriptionOnlyRate: ratio(assessed.filter((row) => row.hasDescriptionOnly).length, assessed.length),
      bothRate: ratio(assessed.filter((row) => row.hasTitleDescription).length, assessed.length),
      zeroHitRate: ratio(assessed.filter((row) => row.selectedTextTagCount === 0).length, assessed.length),
      avgTextTags: ratio(selectedCounts.reduce((sum, value) => sum + value, 0), assessed.length),
      rawTextTagCount: { p50: percentile(rawCounts, 0.5), p90: percentile(rawCounts, 0.9), p99: percentile(rawCounts, 0.99) },
      selectedTextTagCount: { p50: percentile(selectedCounts, 0.5), p90: percentile(selectedCounts, 0.9), p99: percentile(selectedCounts, 0.99) },
      capTruncatedBooks: assessed.filter((row) => row.truncatedTextTagCount > 0).length,
      capTruncatedTags: assessed.reduce((sum, row) => sum + row.truncatedTextTagCount, 0),
      keywordCoverageInsufficientCount: assessed.filter((row) => row.keywordCoverageInsufficient).length,
    };
  };
  const byLanguage = new Map();
  for (const row of bookDiagnostics) {
    const key = perLanguageKey(row);
    const rows = byLanguage.get(key) ?? [];
    rows.push(row);
    byLanguage.set(key, rows);
  }
  return {
    overall: group(bookDiagnostics),
    byLanguage: mapValues(new Map([...byLanguage.entries()].map(([key, rows]) => {
      const [scriptBucket, sourceLanguageCode, sourceLanguageName, rawLanguageScope] = JSON.parse(key);
      return [key, { scriptBucket, sourceLanguageCode, sourceLanguageName, rawLanguageScope, localeStatisticsStatus: rows[0]?.localeStatisticsStatus ?? null, ...group(rows) }];
    }))).sort((left, right) => (
      left.scriptBucket.localeCompare(right.scriptBucket)
      || left.sourceLanguageCode.localeCompare(right.sourceLanguageCode)
      || left.sourceLanguageName.localeCompare(right.sourceLanguageName)
    )),
  };
}

/**
 * Score every novel/tag pair.  The returned structure contains no source
 * system access and applies no persistence; callers decide where to write it.
 */
export function scoreCalibration({
  samples: rawSamples,
  taxonomy: rawTaxonomy,
  sourceMapping: rawMapping = null,
  previewCorpus: rawPreviewCorpus = null,
  configurations = C1_CONFIGURATIONS,
  maxTextTags = C1_MAX_TEXT_TAGS,
  runId = "UNSPECIFIED",
  generatedAt = "UNSPECIFIED",
  mode = "C1",
  lexiconOverride = null,
}) {
  const taxonomy = rawTaxonomy?.fingerprint && rawTaxonomy?.canonicalTags ? rawTaxonomy : validateTaxonomy(rawTaxonomy);
  const sampleBundle = Array.isArray(rawSamples) ? validateSamples(rawSamples) : rawSamples;
  const samples = sampleBundle.samples;
  const sourceMapping = rawMapping?.exact instanceof Map ? rawMapping : validateSourceMapping(rawMapping, taxonomy);
  const preview = rawPreviewCorpus?.bySampleId instanceof Map
    ? rawPreviewCorpus
    : rawPreviewCorpus === null ? null : validatePreviewCorpus(rawPreviewCorpus, samples);
  const tagById = new Map(taxonomy.canonicalTags.map((tag) => [tag.canonicalTagId, tag]));
  for (const sample of samples) {
    for (const tagId of sample.manualCanonicalTagIds) if (!tagById.has(tagId)) fail(`manual snapshot references unknown tag ${tagId}`);
  }
  const matrix = makeBaseMatchMatrix(samples, taxonomy, preview?.bySampleId);
  const evidence = [];
  const bookDiagnostics = [];
  const sourceDiagnostics = [];
  const summaries = [];

  for (const config of configurations) {
    for (const cap of maxTextTags) {
      integer(cap, "maxTextTags", { min: 1 });
      const currentBookDiagnostics = [];
      for (const sample of samples) {
        const sampleMatches = matrix.get(sample.sampleRowId);
        const matchByTag = sampleMatches.perTag;
        const source = sourceEvidence(sample, sourceMapping);
        const entries = [...matchByTag.entries()].map(([canonicalTagId, fields]) => {
          const tag = tagById.get(canonicalTagId);
          const titleScore = fields.title.matched ? config.titleWeight : 0;
          const descriptionScore = fields.description.matched ? config.descriptionWeight : 0;
          const chapterScore = fields.chapter.matched ? config.chapterWeight : 0;
          const totalScore = titleScore + descriptionScore + chapterScore;
          return {
            tag,
            fields,
            titleScore,
            descriptionScore,
            chapterScore,
            totalScore,
            eligible: totalScore >= config.threshold,
            evidenceClass: evidenceClass(fields.title.matched, fields.description.matched, fields.chapter.matched),
          };
        });
        const rawEligible = entries.filter((entry) => entry.eligible);
        const decisionEligible = sample.manualSnapshotComplete ? [] : rawEligible;
        const ordered = [...decisionEligible].sort((left, right) => (
          right.totalScore - left.totalScore
          || left.tag.textSelectionPriority - right.tag.textSelectionPriority
          || left.tag.canonicalTagId.localeCompare(right.tag.canonicalTagId)
        ));
        const selectedIds = new Set(ordered.slice(0, cap).map(({ tag }) => tag.canonicalTagId));
        const rank = new Map(ordered.map((entry, index) => [entry.tag.canonicalTagId, index + 1]));
        const selected = ordered.slice(0, cap);
        const selectedTagIds = selected.map(({ tag }) => tag.canonicalTagId);
        const truncated = ordered.slice(cap);
        const candidateClasses = selected.map((entry) => entry.evidenceClass);
        const keywordCoverageInsufficient = !sampleMatches.reliableCoverage;
        const finalTagIds = sample.manualSnapshotComplete
          ? [...sample.manualCanonicalTagIds].sort()
          : source.status === "MAPPING_UNAVAILABLE"
            ? null
            : [...new Set([...source.canonicalTagIds, ...selectedTagIds])].sort();
        const conflict = !sample.manualSnapshotComplete && hasMutualExclusivity(source.canonicalTagIds, selectedTagIds, sourceMapping);
        const sourceTextRelation = sample.manualSnapshotComplete
          ? "MANUAL_FULL_SNAPSHOT"
          : source.status !== "SOURCE_SNAPSHOT_COMPLETE"
            ? source.status
            : conflict
              ? "SOURCE_TEXT_CONFLICT_REVIEW"
              : source.canonicalTagIds.length === 0 && selectedTagIds.length === 0
                ? "NO_SOURCE_NO_TEXT"
                : source.canonicalTagIds.length === 0
                  ? "TEXT_ONLY"
                  : selectedTagIds.length === 0
                    ? "SOURCE_ONLY"
                    : "SOURCE_AND_TEXT";
        const diagnostic = {
          configId: config.id,
          maxTextTags: cap,
          sampleRowId: sample.sampleRowId,
          novelIdentity: sample.novelIdentity,
          sourceLanguageCode: sample.sourceLanguageCode,
          sourceLanguageName: sample.sourceLanguageName,
          channelAppId: sample.channelAppId,
          rawLanguageScope: sample.rawLanguageScope,
          resolvedLocale: sample.resolvedLocale,
          localeStatisticsStatus: sample.localeStatisticsStatus,
          sourceSnapshotId: sample.sourceSnapshotId,
          scriptBucket: sample.scriptBucket,
          manualSnapshotComplete: sample.manualSnapshotComplete,
          manualCanonicalTagIds: sample.manualCanonicalTagIds,
          rawEligibleTextTagCount: rawEligible.length,
          textCandidateCount: ordered.length,
          selectedTextTagCount: selected.length,
          selectedTextTagIds: selectedTagIds,
          truncatedTextTagCount: truncated.length,
          truncatedTextTagIds: truncated.map(({ tag }) => tag.canonicalTagId),
          sourceMappedTagCount: source.canonicalTagIds.length,
          sourceMappedTagIds: source.canonicalTagIds,
          sourceEvidenceStatus: source.status,
          finalTagCount: finalTagIds === null ? null : finalTagIds.length,
          finalTagIds,
          sourceTextRelation,
          hasTitleOnly: candidateClasses.includes("TITLE_ONLY"),
          hasDescriptionOnly: candidateClasses.includes("DESCRIPTION_ONLY"),
          hasTitleDescription: candidateClasses.includes("TITLE_DESCRIPTION") || candidateClasses.includes("TITLE_DESCRIPTION_CHAPTER"),
          keywordCoverageInsufficient,
          zeroHitContext: {
            title: truncateCodePoints(sample.title.normalize("NFC"), 180),
            description: truncateCodePoints(sample.description.normalize("NFC"), 180),
            titleHash: sample.titleHash,
            descriptionHash: sample.descriptionHash,
          },
        };
        currentBookDiagnostics.push(diagnostic);
        bookDiagnostics.push(diagnostic);
        sourceDiagnostics.push({
          configId: config.id,
          maxTextTags: cap,
          sampleRowId: sample.sampleRowId,
          novelIdentity: sample.novelIdentity,
          channelAppId: sample.channelAppId,
          rawLanguageScope: sample.rawLanguageScope,
          sourceSnapshotId: sample.sourceSnapshotId,
          manualSnapshotComplete: sample.manualSnapshotComplete,
          sourceSnapshotComplete: sample.sourceSnapshotComplete,
          sourceEvidenceStatus: source.status,
          sourceExactSeriesTypeTokens: source.exactTokens,
          sourceMappedTagIds: source.canonicalTagIds,
          textSelectedTagIds: selectedTagIds,
          finalTagIds,
          sourceTextRelation,
        });
        for (const entry of entries) {
          const { tag, fields } = entry;
          const isSelected = selectedIds.has(tag.canonicalTagId);
          evidence.push({
            recordType: "TEXT_TAG_PAIR",
            configId: config.id,
            titleWeight: config.titleWeight,
            descriptionWeight: config.descriptionWeight,
            chapterWeight: config.chapterWeight,
            threshold: config.threshold,
            maxTextTags: cap,
            sampleRowId: sample.sampleRowId,
            novelIdentity: sample.novelIdentity,
            sourceLanguageCode: sample.sourceLanguageCode,
            sourceLanguageName: sample.sourceLanguageName,
            channelAppId: sample.channelAppId,
            rawLanguageScope: sample.rawLanguageScope,
            sourceSnapshotId: sample.sourceSnapshotId,
            scriptBucket: sample.scriptBucket,
            canonicalTagId: tag.canonicalTagId,
            canonicalTagSlug: tag.slug,
            canonicalTagDefinition: tag.definition,
            textSelectionPriority: tag.textSelectionPriority,
            keywordCoverageStatus: [fields.title, fields.description, fields.chapter].some(({ coverageStatus }) => coverageStatus === "RELIABLE")
              ? "RELIABLE"
              : "KEYWORD_COVERAGE_INSUFFICIENT",
            titleMatched: fields.title.matched,
            titleMatches: fields.title.matches,
            descriptionMatched: fields.description.matched,
            descriptionMatches: fields.description.matches,
            chapterMatched: fields.chapter.matched,
            chapterMatches: fields.chapter.matches,
            titleScore: entry.titleScore,
            descriptionScore: entry.descriptionScore,
            chapterScore: entry.chapterScore,
            totalScore: entry.totalScore,
            eligible: entry.eligible,
            textDecisionEligible: entry.eligible && !sample.manualSnapshotComplete,
            rankBeforeCap: rank.get(tag.canonicalTagId) ?? null,
            selectedAfterCap: isSelected,
            capDropReason: entry.eligible && !sample.manualSnapshotComplete && !isSelected ? "MAX_TEXT_TAGS" : null,
            evidenceClass: entry.evidenceClass,
            manualSnapshotComplete: sample.manualSnapshotComplete,
            inputContentHashes: { title: sample.titleHash, description: sample.descriptionHash },
          });
        }
      }
      const aggregate = aggregateGroups(currentBookDiagnostics);
      summaries.push({
        configId: config.id,
        maxTextTags: cap,
        titleWeight: config.titleWeight,
        descriptionWeight: config.descriptionWeight,
        chapterWeight: config.chapterWeight,
        threshold: config.threshold,
        ...aggregate,
      });
    }
  }
  const sourceBlindSimulation = summaries.map((summary) => ({
    configId: summary.configId,
    maxTextTags: summary.maxTextTags,
    sourceBlindTextHitRate: summary.overall.textHitRate,
    sourceBlindZeroHitRate: summary.overall.zeroHitRate,
    sourceBlindAvgTextTags: summary.overall.avgTextTags,
    byLanguage: summary.byLanguage.map((row) => ({
      scriptBucket: row.scriptBucket,
      sourceLanguageCode: row.sourceLanguageCode,
      sourceBlindTextHitRate: row.textHitRate,
      sourceBlindZeroHitRate: row.zeroHitRate,
      sourceBlindAvgTextTags: row.avgTextTags,
    })),
  }));
  return {
    status: CALIBRATION_STATUS,
    recommendationStatus: RECOMMENDATION_STATUS,
    mode,
    runId,
    generatedAt,
    taxonomy: { taxonomyVersion: taxonomy.taxonomyVersion, keywordLexiconVersion: taxonomy.keywordLexiconVersion, fingerprint: taxonomy.fingerprint },
    samples: { count: samples.length, fingerprint: sampleBundle.fingerprint },
    sourceMapping: sourceMapping ? { mappingVersion: sourceMapping.mappingVersion, fingerprint: sourceMapping.fingerprint } : null,
    previewCorpus: preview ? { sampleCount: preview.bySampleId.size, fingerprint: preview.fingerprint } : null,
    configurations: configurations.map((config) => ({ ...config })),
    evidence,
    bookDiagnostics,
    sourceDiagnostics,
    summaries,
    sourceBlindSimulation,
    lexiconOverride,
  };
}

function lowConfidenceReasons(evidenceRow, diagnostic) {
  const flags = new Set([
    ...evidenceRow.titleMatches.flatMap(({ riskFlags }) => riskFlags),
    ...evidenceRow.descriptionMatches.flatMap(({ riskFlags }) => riskFlags),
    ...evidenceRow.chapterMatches.flatMap(({ riskFlags }) => riskFlags),
  ]);
  if (diagnostic.truncatedTextTagCount > 0) {
    const lastSelected = diagnostic.selectedTextTagIds.at(-1);
    if (lastSelected === evidenceRow.canonicalTagId) flags.add("CAP_OR_TIE_SENSITIVE");
  }
  if (evidenceRow.scriptBucket === "other" || evidenceRow.scriptBucket === "unknown") flags.add("UNSUPPORTED_LOCALE_OR_BOUNDARY");
  if (!evidenceRow.titleMatched && !evidenceRow.descriptionMatched && !evidenceRow.chapterMatched) flags.add("INPUT_INCOMPLETE");
  return [...flags].filter((flag) => LOW_CONFIDENCE_FLAGS.has(flag) || flag === "CAP_OR_TIE_SENSITIVE").sort();
}

function caseId(prefix, values) {
  return `${prefix}_${sha256(values.join("\n")).slice(0, 24)}`;
}

function auditEvidence(row) {
  return {
    title: row.titleMatches.map(({ keywordId, keyword, matchMode, start, end, excerpt, inputFieldSha256 }) => ({ keywordId, keyword, matchMode, start, end, excerpt, inputFieldSha256 })),
    description: row.descriptionMatches.map(({ keywordId, keyword, matchMode, start, end, excerpt, inputFieldSha256 }) => ({ keywordId, keyword, matchMode, start, end, excerpt, inputFieldSha256 })),
    previewChapters: row.chapterMatches.map(({ keywordId, keyword, matchMode, start, end, excerpt, inputFieldSha256, chapterNumber, chapterContentHash }) => ({ keywordId, keyword, matchMode, start, end, excerpt, inputFieldSha256, chapterNumber, chapterContentHash })),
  };
}

function distinctBy(rows, key) {
  const seen = new Set();
  return rows.filter((row) => {
    const value = key(row);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

/** Build a source-blind Terra queue plus a post-blind source conflict queue. */
export function buildAuditQueue(scored, { targetPerStratum = 50 } = {}) {
  integer(targetPerStratum, "targetPerStratum", { min: 1 });
  const diagnostics = new Map(scored.bookDiagnostics.map((row) => [`${row.configId}|${row.maxTextTags}|${row.sampleRowId}`, row]));
  const primaryCases = [];
  const postBlindCases = [];
  const shortfalls = [];
  for (const summary of scored.summaries) {
    const key = `${summary.configId}|${summary.maxTextTags}`;
    const records = scored.evidence.filter((row) => (
      `${row.configId}|${row.maxTextTags}` === key && row.selectedAfterCap && !row.manualSnapshotComplete
    ));
    const byClass = new Map();
    for (const row of records) {
      const group = `${row.evidenceClass}|${row.scriptBucket}`;
      const rows = byClass.get(group) ?? [];
      rows.push(row);
      byClass.set(group, rows);
    }
    for (const stratum of ["TITLE_ONLY", "DESCRIPTION_ONLY", "TITLE_DESCRIPTION"]) {
      for (const languageKey of [...new Set(records.map((row) => `${row.scriptBucket}|${row.sourceLanguageCode}`))].sort()) {
        const [scriptBucket, sourceLanguageCode] = languageKey.split("|");
        const population = (byClass.get(`${stratum}|${scriptBucket}`) ?? []).filter((row) => row.sourceLanguageCode === sourceLanguageCode);
        const selected = sortByHash(population, (row) => `${key}|${stratum}|${languageKey}|${row.sampleRowId}|${row.canonicalTagId}`).slice(0, targetPerStratum);
        if (population.length < targetPerStratum) shortfalls.push({ configId: summary.configId, maxTextTags: summary.maxTextTags, stratum, scriptBucket, sourceLanguageCode, requested: targetPerStratum, available: population.length, shortfall: targetPerStratum - population.length });
        for (const row of selected) {
          const diagnostic = diagnostics.get(`${key}|${row.sampleRowId}`);
          primaryCases.push({
            auditCaseId: caseId("terra", [key, stratum, languageKey, row.sampleRowId, row.canonicalTagId]),
            recordType: "TEXT_TAG_PAIR",
            stratum,
            requiredReviewer: "terra",
            blind: true,
            configId: row.configId,
            maxTextTags: row.maxTextTags,
            sampleRowId: row.sampleRowId,
            novelIdentity: row.novelIdentity,
            scriptBucket: row.scriptBucket,
            sourceLanguageCode: row.sourceLanguageCode,
            canonicalTagId: row.canonicalTagId,
            canonicalTagSlug: row.canonicalTagSlug,
            canonicalTagDefinition: row.canonicalTagDefinition,
            totalScore: row.totalScore,
            evidenceClass: row.evidenceClass,
            matcherEvidence: auditEvidence(row),
            automaticLowConfidenceReasons: lowConfidenceReasons(row, diagnostic),
            sourceEvidenceHidden: true,
          });
        }
      }
    }
    const bookRows = scored.bookDiagnostics.filter((row) => `${row.configId}|${row.maxTextTags}` === key && !row.manualSnapshotComplete);
    const bookStrata = [
      ["ZERO_HIT", bookRows.filter((row) => row.selectedTextTagCount === 0)],
      ["HIGH_TAG_COUNT", bookRows.filter((row) => row.rawEligibleTextTagCount >= 4)],
    ];
    const bookScriptBuckets = [...new Set(bookRows.map((row) => row.scriptBucket))].sort();
    for (const [stratum, population] of bookStrata) {
      for (const scriptBucket of bookScriptBuckets) {
        const bucketPopulation = distinctBy(population.filter((row) => row.scriptBucket === scriptBucket), (row) => row.sampleRowId);
        const selected = sortByHash(bucketPopulation, (row) => `${key}|${stratum}|${scriptBucket}|${row.sampleRowId}`).slice(0, targetPerStratum);
        if (bucketPopulation.length < targetPerStratum) shortfalls.push({ configId: summary.configId, maxTextTags: summary.maxTextTags, stratum, scriptBucket, requested: targetPerStratum, available: bucketPopulation.length, shortfall: targetPerStratum - bucketPopulation.length });
        for (const row of selected) {
          primaryCases.push({
            auditCaseId: caseId("terra", [key, stratum, scriptBucket, row.sampleRowId]),
            recordType: "BOOK_REVIEW",
            stratum,
            requiredReviewer: "terra",
            blind: true,
            configId: row.configId,
            maxTextTags: row.maxTextTags,
            sampleRowId: row.sampleRowId,
            novelIdentity: row.novelIdentity,
            scriptBucket: row.scriptBucket,
            sourceLanguageCode: row.sourceLanguageCode,
            zeroHitContext: row.zeroHitContext,
            textCandidateCount: row.textCandidateCount,
            selectedTextTagCount: row.selectedTextTagCount,
            sourceEvidenceHidden: true,
          });
        }
      }
    }
    const conflicts = scored.sourceDiagnostics.filter((row) => `${row.configId}|${row.maxTextTags}` === key && row.sourceTextRelation === "SOURCE_TEXT_CONFLICT_REVIEW");
    const selectedConflicts = sortByHash(conflicts, (row) => `${key}|CONFLICT|${row.sampleRowId}`).slice(0, targetPerStratum);
    if (conflicts.length < targetPerStratum) shortfalls.push({ configId: summary.configId, maxTextTags: summary.maxTextTags, stratum: "SOURCE_TEXT_CONFLICT_REVIEW", scriptBucket: "post_blind", requested: targetPerStratum, available: conflicts.length, shortfall: targetPerStratum - conflicts.length });
    for (const row of selectedConflicts) {
      postBlindCases.push({
        auditCaseId: caseId("source", [key, row.sampleRowId]),
        recordType: "POST_BLIND_SOURCE_TEXT_CONFLICT",
        configId: row.configId,
        maxTextTags: row.maxTextTags,
        sampleRowId: row.sampleRowId,
        novelIdentity: row.novelIdentity,
        sourceMappedTagIds: row.sourceMappedTagIds,
        textSelectedTagIds: row.textSelectedTagIds,
        sourceTextRelation: row.sourceTextRelation,
        action: "SOURCE_TEXT_CONFLICT_REVIEW",
      });
    }
  }
  return {
    primaryCases: primaryCases.sort((left, right) => left.auditCaseId.localeCompare(right.auditCaseId)),
    postBlindCases: postBlindCases.sort((left, right) => left.auditCaseId.localeCompare(right.auditCaseId)),
    shortfalls: shortfalls.sort((left, right) => `${left.configId}|${left.maxTextTags}|${left.stratum}`.localeCompare(`${right.configId}|${right.maxTextTags}|${right.stratum}`)),
  };
}

function normalQuantile95() {
  return 1.959963984540054;
}

export function wilsonInterval(successes, total) {
  if (total === 0) return null;
  const z = normalQuantile95();
  const p = successes / total;
  const denominator = 1 + (z ** 2 / total);
  const centre = (p + z ** 2 / (2 * total)) / denominator;
  const spread = (z / denominator) * Math.sqrt((p * (1 - p) / total) + (z ** 2 / (4 * total ** 2)));
  return { lower: Math.max(0, centre - spread), upper: Math.min(1, centre + spread) };
}

function seededRandom(seedText) {
  let state = Number.parseInt(sha256(seedText).slice(0, 8), 16) >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function quantile(values, q) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];
}

function bootstrapWeightedFp(resolvedCases, populationByStratum, seedText, iterations = 2_000) {
  if (resolvedCases.length === 0) return null;
  const clusters = new Map();
  for (const row of resolvedCases) {
    const records = clusters.get(row.novelIdentity) ?? [];
    records.push(row);
    clusters.set(row.novelIdentity, records);
  }
  const clusterRows = mapValues(clusters);
  const random = seededRandom(seedText);
  const values = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const counts = new Map();
    for (let draw = 0; draw < clusterRows.length; draw += 1) {
      for (const row of clusterRows[Math.floor(random() * clusterRows.length)]) {
        const aggregate = counts.get(row.stratumKey) ?? { correct: 0, falsePositive: 0 };
        if (row.finalVerdict === "FINAL_FALSE_POSITIVE") aggregate.falsePositive += 1;
        else aggregate.correct += 1;
        counts.set(row.stratumKey, aggregate);
      }
    }
    let numerator = 0;
    let denominator = 0;
    for (const [stratumKey, population] of populationByStratum) {
      const aggregate = counts.get(stratumKey);
      if (!aggregate || aggregate.correct + aggregate.falsePositive === 0) continue;
      numerator += population * (aggregate.falsePositive / (aggregate.correct + aggregate.falsePositive));
      denominator += population;
    }
    if (denominator > 0) values.push(numerator / denominator);
  }
  return values.length === 0 ? null : {
    method: "novel_clustered_deterministic_bootstrap",
    iterations,
    lower: quantile(values, 0.025),
    upper: quantile(values, 0.975),
  };
}

function validateReviews(rawReviews, knownCaseIds) {
  const seen = new Set();
  return rawReviews.map((rawReview, index) => {
    const review = object(rawReview, `reviews[${index}]`);
    const auditCaseId = string(review.auditCaseId, `reviews[${index}].auditCaseId`);
    if (!knownCaseIds.has(auditCaseId)) fail(`review references unknown audit case ${auditCaseId}`);
    const reviewerRole = string(review.reviewerRole, `reviews[${index}].reviewerRole`);
    if (!["terra", "sol", "owner"].includes(reviewerRole)) fail(`reviewerRole ${reviewerRole} is not registered`);
    const reviewerId = string(review.reviewerId, `reviews[${index}].reviewerId`);
    const unique = `${auditCaseId}|${reviewerRole}`;
    if (seen.has(unique)) fail(`duplicate ${reviewerRole} review for ${auditCaseId}`);
    seen.add(unique);
    const reviewConfidence = review.reviewConfidence === undefined ? null : string(review.reviewConfidence, `reviews[${index}].reviewConfidence`);
    if (reviewConfidence !== null && !["HIGH", "LOW"].includes(reviewConfidence)) fail("reviewConfidence must be HIGH or LOW");
    const verdict = review.verdict === undefined ? null : string(review.verdict, `reviews[${index}].verdict`);
    const finalVerdict = review.finalVerdict === undefined ? null : string(review.finalVerdict, `reviews[${index}].finalVerdict`);
    if (reviewerRole === "terra") {
      if (!REVIEW_VERDICTS.has(verdict) || finalVerdict !== null) fail("Terra review requires one non-final verdict");
      if (reviewConfidence === null) fail("Terra review requires reviewConfidence");
    } else {
      if (!FINAL_VERDICTS.has(finalVerdict) || verdict !== null) fail(`${reviewerRole} review requires one finalVerdict`);
      if (reviewerRole === "owner" && ![
        "FINAL_AMBIGUOUS",
        "TAXONOMY_DECISION_REQUIRED",
        "SOURCE_MAPPING_REVIEW_REQUIRED",
        "DATA_INVALID",
      ].includes(finalVerdict)) {
        fail("Owner review is limited to unresolved taxonomy, source-mapping, data, or ambiguity decisions");
      }
    }
    return { auditCaseId, reviewerRole, reviewerId, reviewConfidence, verdict, finalVerdict, reasonCodes: review.reasonCodes ?? [], note: review.note ?? null };
  });
}

function caseGroupKey(row) {
  return `${row.configId}|${row.maxTextTags}|${row.scriptBucket}|${row.sourceLanguageCode}|${row.evidenceClass}`;
}

function solReviewLayerKey(row) {
  return `${row.configId}|${row.maxTextTags}|${row.scriptBucket}|${row.evidenceClass}`;
}

/** Merge blinded reviews; source evidence is deliberately absent from this path. */
export function mergeReviewDecisions(scored, auditQueue, rawReviews) {
  const pairCases = auditQueue.primaryCases.filter(({ recordType }) => recordType === "TEXT_TAG_PAIR");
  const reviews = validateReviews(rawReviews, new Set(auditQueue.primaryCases.map(({ auditCaseId }) => auditCaseId)));
  const reviewByCase = new Map();
  for (const review of reviews) {
    const byRole = reviewByCase.get(review.auditCaseId) ?? new Map();
    byRole.set(review.reviewerRole, review);
    reviewByCase.set(review.auditCaseId, byRole);
  }
  const highCorrectByGroup = new Map();
  for (const item of pairCases) {
    const terra = reviewByCase.get(item.auditCaseId)?.get("terra");
    if (terra?.verdict === "CORRECT" && terra.reviewConfidence === "HIGH" && item.automaticLowConfidenceReasons.length === 0) {
      const group = solReviewLayerKey(item);
      const rows = highCorrectByGroup.get(group) ?? [];
      rows.push(item);
      highCorrectByGroup.set(group, rows);
    }
  }
  const solSpotChecks = new Set();
  for (const [group, cases] of highCorrectByGroup) {
    const target = Math.min(cases.length, Math.min(30, Math.max(10, Math.ceil(cases.length * 0.1))));
    for (const item of sortByHash(cases, (row) => `${group}|${row.auditCaseId}`).slice(0, target)) solSpotChecks.add(item.auditCaseId);
  }
  const decisions = [];
  const solQueue = [];
  const ownerQueue = [];
  for (const item of pairCases) {
    const byRole = reviewByCase.get(item.auditCaseId) ?? new Map();
    const terra = byRole.get("terra") ?? null;
    const sol = byRole.get("sol") ?? null;
    const owner = byRole.get("owner") ?? null;
    const terraRequiresSol = terra && (
      terra.verdict === "FALSE_POSITIVE"
      || terra.verdict === "AMBIGUOUS"
      || terra.verdict === "NOT_ADJUDICABLE"
      || terra.reviewConfidence === "LOW"
      || item.automaticLowConfidenceReasons.length > 0
    );
    const requiresSol = Boolean(terraRequiresSol || solSpotChecks.has(item.auditCaseId));
    let finalVerdict = null;
    let resolutionSource = null;
    if (owner) {
      finalVerdict = owner.finalVerdict;
      resolutionSource = "OWNER";
    } else if (requiresSol && sol) {
      finalVerdict = sol.finalVerdict;
      resolutionSource = "SOL";
    } else if (!requiresSol && terra?.verdict === "CORRECT" && terra.reviewConfidence === "HIGH") {
      finalVerdict = "FINAL_CORRECT";
      resolutionSource = "TERRA";
    }
    const decision = {
      ...item,
      terraReview: terra,
      solReview: sol,
      ownerReview: owner,
      requiresSol,
      solSpotCheck: solSpotChecks.has(item.auditCaseId),
      finalVerdict,
      resolutionSource,
      stratumKey: caseGroupKey(item),
      solReviewLayerKey: solReviewLayerKey(item),
    };
    decisions.push(decision);
    if (requiresSol && !sol && !owner) solQueue.push(decision);
    if (["FINAL_AMBIGUOUS", "TAXONOMY_DECISION_REQUIRED", "SOURCE_MAPPING_REVIEW_REQUIRED", "DATA_INVALID"].includes(finalVerdict)) ownerQueue.push(decision);
  }
  const populationByConfig = new Map();
  for (const row of scored.evidence.filter((row) => row.selectedAfterCap && !row.manualSnapshotComplete)) {
    const key = `${row.configId}|${row.maxTextTags}`;
    const byStratum = populationByConfig.get(key) ?? new Map();
    const stratum = `${row.configId}|${row.maxTextTags}|${row.scriptBucket}|${row.sourceLanguageCode}|${row.evidenceClass}`;
    byStratum.set(stratum, (byStratum.get(stratum) ?? 0) + 1);
    populationByConfig.set(key, byStratum);
  }
  const metrics = [];
  for (const summary of scored.summaries) {
    const key = `${summary.configId}|${summary.maxTextTags}`;
    const decisionsForConfig = decisions.filter((row) => `${row.configId}|${row.maxTextTags}` === key);
    const populationByStratum = populationByConfig.get(key) ?? new Map();
    const strata = mapValues(new Map([...populationByStratum.entries()].map(([stratumKey, population]) => {
      const rows = decisionsForConfig.filter((row) => row.stratumKey === stratumKey);
      const resolved = rows.filter((row) => row.finalVerdict === "FINAL_CORRECT" || row.finalVerdict === "FINAL_FALSE_POSITIVE");
      const falsePositive = resolved.filter((row) => row.finalVerdict === "FINAL_FALSE_POSITIVE").length;
      const ambiguous = rows.filter((row) => row.finalVerdict === "FINAL_AMBIGUOUS").length;
      return [stratumKey, {
        stratumKey,
        population,
        audited: rows.length,
        resolved: resolved.length,
        falsePositive,
        ambiguous,
        resolutionRate: ratio(resolved.length, rows.length),
        fpRate: ratio(falsePositive, resolved.length),
        wilson95: wilsonInterval(falsePositive, resolved.length),
      }];
    }))).sort((left, right) => left.stratumKey.localeCompare(right.stratumKey));
    const weightedRows = strata.filter((row) => row.fpRate !== null);
    const weightedPopulation = weightedRows.reduce((sum, row) => sum + row.population, 0);
    const estimatedTextFpRate = weightedPopulation === 0 ? null : weightedRows.reduce((sum, row) => sum + row.population * row.fpRate, 0) / weightedPopulation;
    const resolved = decisionsForConfig.filter((row) => row.finalVerdict === "FINAL_CORRECT" || row.finalVerdict === "FINAL_FALSE_POSITIVE");
    const fp = resolved.filter((row) => row.finalVerdict === "FINAL_FALSE_POSITIVE").length;
    const ambiguous = decisionsForConfig.filter((row) => row.finalVerdict === "FINAL_AMBIGUOUS").length;
    const validAdjudications = resolved.length + ambiguous;
    const bootstrap95 = bootstrapWeightedFp(resolved, populationByStratum, key);
    const bookCases = new Map();
    for (const row of decisionsForConfig) {
      const records = bookCases.get(row.novelIdentity) ?? [];
      records.push(row);
      bookCases.set(row.novelIdentity, records);
    }
    const bookCaseRows = mapValues(bookCases);
    const resolvedBooks = bookCaseRows.filter((rows) => rows.some((row) => row.finalVerdict === "FINAL_CORRECT" || row.finalVerdict === "FINAL_FALSE_POSITIVE"));
    const bookAnyFpRate = ratio(resolvedBooks.filter((rows) => rows.some((row) => row.finalVerdict === "FINAL_FALSE_POSITIVE")).length, resolvedBooks.length);
    const completionRate = ratio(resolved.length, decisionsForConfig.length);
    const effectiveLayersPass = strata.length > 0 && strata.every((row) => (
      row.resolved >= 30 && row.fpRate !== null && row.fpRate <= 0.05 && row.wilson95?.upper <= 0.10
    ));
    const guardrailEligible = Boolean(
      estimatedTextFpRate !== null && estimatedTextFpRate <= 0.05
      && bootstrap95?.upper !== null && bootstrap95?.upper <= 0.10
      && completionRate !== null && completionRate >= 0.90
      && effectiveLayersPass
    );
    metrics.push({
      configId: summary.configId,
      maxTextTags: summary.maxTextTags,
      estimatedTextFpRate,
      estimatedTextFpRateScope: "CALIBRATION_PROVISIONAL_SAMPLE_FP",
      bookAnyFpRate,
      resolutionRate: completionRate,
      unresolvedRate: ratio(decisionsForConfig.length - resolved.length, decisionsForConfig.length),
      optimisticFpRate: ratio(fp, validAdjudications),
      conservativeFpRate: ratio(fp + ambiguous, validAdjudications),
      unresolvedCaseCount: decisionsForConfig.length - validAdjudications,
      bootstrap95,
      strata,
      guardrailEligible,
    });
  }
  const flipGroups = new Map();
  for (const decision of decisions) {
    if (!decision.solReview || !decision.terraReview) continue;
    const terraExpected = decision.terraReview.verdict === "CORRECT" ? "FINAL_CORRECT" : decision.terraReview.verdict === "FALSE_POSITIVE" ? "FINAL_FALSE_POSITIVE" : null;
    if (!terraExpected) continue;
    const group = decision.solReviewLayerKey;
    const aggregate = flipGroups.get(group) ?? { stratumKey: group, reviewed: 0, flipped: 0 };
    aggregate.reviewed += 1;
    if (decision.solReview.finalVerdict !== terraExpected) aggregate.flipped += 1;
    flipGroups.set(group, aggregate);
  }
  const solTakeoverGroups = mapValues(flipGroups).map((row) => ({ ...row, flipRate: ratio(row.flipped, row.reviewed), solTakesOver: row.flipped >= 2 || row.flipped / row.reviewed > 0.10 })).sort((left, right) => left.stratumKey.localeCompare(right.stratumKey));
  const takeoverKeys = new Set(solTakeoverGroups.filter(({ solTakesOver }) => solTakesOver).map(({ stratumKey }) => stratumKey));
  const solTakeoverQueue = decisions.filter((decision) => takeoverKeys.has(decision.solReviewLayerKey) && !decision.solReview && !decision.ownerReview)
    .map((decision) => ({ ...decision, requiresSol: true, reason: "SOL_STRATUM_TAKEOVER" }));
  const recommended = metrics.filter(({ guardrailEligible }) => guardrailEligible).sort((left, right) => {
    const leftSummary = scored.summaries.find((summary) => summary.configId === left.configId && summary.maxTextTags === left.maxTextTags);
    const rightSummary = scored.summaries.find((summary) => summary.configId === right.configId && summary.maxTextTags === right.maxTextTags);
    const leftPriority = scored.configurations.find(({ id }) => id === left.configId)?.priority ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = scored.configurations.find(({ id }) => id === right.configId)?.priority ?? Number.MAX_SAFE_INTEGER;
    return (rightSummary.overall.textHitRate ?? -1) - (leftSummary.overall.textHitRate ?? -1)
      || (left.conservativeFpRate ?? 2) - (right.conservativeFpRate ?? 2)
      || left.maxTextTags - right.maxTextTags
      || leftPriority - rightPriority
      || leftSummary.configId.localeCompare(rightSummary.configId);
  })[0] ?? null;
  const topFalsePositiveKeywords = [];
  const keywordCounts = new Map();
  for (const decision of decisions.filter(({ finalVerdict }) => finalVerdict === "FINAL_FALSE_POSITIVE")) {
    const keywords = new Map();
    for (const match of [
      ...decision.matcherEvidence.title,
      ...decision.matcherEvidence.description,
      ...decision.matcherEvidence.previewChapters,
    ]) keywords.set(match.keywordId, match.keyword);
    for (const [keywordId, keyword] of keywords) {
      const current = keywordCounts.get(keywordId) ?? { keywordId, keyword, associatedFalsePositiveCount: 0, auditedFalsePositiveCaseIds: [] };
      current.associatedFalsePositiveCount += 1;
      current.auditedFalsePositiveCaseIds.push(decision.auditCaseId);
      keywordCounts.set(keywordId, current);
    }
  }
  for (const item of mapValues(keywordCounts).sort((left, right) => right.associatedFalsePositiveCount - left.associatedFalsePositiveCount || left.keywordId.localeCompare(right.keywordId)).slice(0, 20)) {
    topFalsePositiveKeywords.push({ ...item, classification: "FP_ASSOCIATED_KEYWORD" });
  }
  return {
    decisions,
    solQueue: distinctBy([...solQueue, ...solTakeoverQueue], (row) => row.auditCaseId)
      .sort((left, right) => left.auditCaseId.localeCompare(right.auditCaseId)),
    ownerQueue,
    metrics,
    solTakeoverGroups,
    recommended,
    topFalsePositiveKeywords,
  };
}

function sourceFrequency(rows) {
  const counts = new Map();
  for (const row of rows) {
    for (const tagId of row.sourceMappedTagIds) counts.set(tagId, (counts.get(tagId) ?? 0) + 1);
  }
  return counts;
}

function bucketsWithMinimum(rows, target = 10) {
  const counts = new Map();
  for (const row of rows) counts.set(row.scriptBucket, (counts.get(row.scriptBucket) ?? 0) + 1);
  return new Map([...counts.entries()].filter(([, count]) => count >= target));
}

function proportionalScriptTargets(rows, target) {
  const byBucket = new Map();
  for (const row of rows) byBucket.set(row.scriptBucket, (byBucket.get(row.scriptBucket) ?? 0) + 1);
  const buckets = [...byBucket.entries()].sort(([left], [right]) => left.localeCompare(right));
  const actualTarget = Math.min(target, rows.length);
  const required = new Map(buckets.map(([bucket]) => [bucket, 0]));
  let minimumBudget = actualTarget;
  for (const [bucket, count] of buckets) {
    if (count < 10 || minimumBudget === 0) continue;
    const allocation = Math.min(10, minimumBudget, count);
    required.set(bucket, allocation);
    minimumBudget -= allocation;
  }
  let remaining = Math.max(0, actualTarget - [...required.values()].reduce((sum, count) => sum + count, 0));
  const weightedTotal = buckets.reduce((sum, [, count]) => sum + count, 0);
  const fractions = buckets.map(([bucket, count]) => ({ bucket, fraction: weightedTotal === 0 ? 0 : (remaining * count) / weightedTotal }));
  for (const { bucket, fraction } of fractions) {
    const capacity = byBucket.get(bucket) - required.get(bucket);
    const addition = Math.min(capacity, Math.floor(fraction));
    required.set(bucket, required.get(bucket) + addition);
    remaining -= addition;
  }
  for (const { bucket } of fractions.sort((left, right) => right.fraction - left.fraction || left.bucket.localeCompare(right.bucket))) {
    if (remaining === 0) break;
    if (required.get(bucket) < byBucket.get(bucket)) {
      required.set(bucket, required.get(bucket) + 1);
      remaining -= 1;
    }
  }
  return required;
}

/** Deterministically select the 150-book C2 cohort from baseline C1 diagnostics. */
export function buildC2Cohort(scored, { target = 150, eligibleSampleIds = null } = {}) {
  integer(target, "C2 target", { min: 1 });
  const baseline = scored.bookDiagnostics.filter((row) => row.configId === "B_BASELINE" && row.maxTextTags === 3 && !row.manualSnapshotComplete);
  const eligible = eligibleSampleIds ? baseline.filter((row) => eligibleSampleIds.has(row.sampleRowId)) : baseline;
  const sourceCounts = sourceFrequency(eligible);
  const longTailLimit = Math.max(1, Math.ceil(eligible.length * 0.05));
  const used = new Set();
  const quotas = [
    ["RAW_MULTI_TAG", 25, (row) => row.rawEligibleTextTagCount >= 4],
    ["BASELINE_ZERO_HIT", 50, (row) => row.selectedTextTagCount === 0],
    ["LONG_TAIL_SOURCE", 25, (row) => row.sourceMappedTagIds.some((tagId) => (sourceCounts.get(tagId) ?? 0) <= longTailLimit)],
    ["ORDINARY_TEXT_HIT", 50, (row) => row.selectedTextTagCount > 0],
  ];
  const selected = [];
  const shortfalls = [];
  for (const [category, requested, predicate] of quotas) {
    const requestedWithinTarget = Math.min(requested, Math.max(0, target - selected.length));
    const pool = eligible.filter((row) => !used.has(row.sampleRowId) && predicate(row));
    const picks = sortByHash(pool, (row) => `C2|${category}|${row.sampleRowId}`).slice(0, requestedWithinTarget);
    for (const row of picks) {
      used.add(row.sampleRowId);
      selected.push({ ...row, c2SelectionCategory: category });
    }
    if (picks.length < requestedWithinTarget) shortfalls.push({ category, requested: requestedWithinTarget, available: pool.length, shortfall: requestedWithinTarget - picks.length });
  }
  const fill = sortByHash(eligible.filter((row) => !used.has(row.sampleRowId)), (row) => `C2|FILL|${row.sampleRowId}`);
  for (const row of fill) {
    if (selected.length >= target) break;
    used.add(row.sampleRowId);
    selected.push({ ...row, c2SelectionCategory: "FILL" });
  }
  const requestedByBucket = proportionalScriptTargets(eligible, target);
  const countsByBucket = () => new Map([...requestedByBucket.keys()].map((bucket) => [
    bucket,
    selected.filter((row) => row.scriptBucket === bucket).length,
  ]));
  let bucketCounts = countsByBucket();
  for (const [bucket, required] of requestedByBucket) {
    while ((bucketCounts.get(bucket) ?? 0) < required) {
      const replacement = sortByHash(eligible.filter((row) => !used.has(row.sampleRowId) && row.scriptBucket === bucket), (row) => `C2|BUCKET|${bucket}|${row.sampleRowId}`)[0];
      const displaced = sortByHash(selected.filter((row) => {
        const sourceRequired = requestedByBucket.get(row.scriptBucket) ?? 0;
        return (bucketCounts.get(row.scriptBucket) ?? 0) > sourceRequired;
      }), (row) => `${row.c2SelectionCategory === "FILL" ? "0" : "1"}|C2|DISPLACE|${row.sampleRowId}`)[0];
      if (!replacement || !displaced) break;
      const index = selected.findIndex(({ sampleRowId }) => sampleRowId === displaced.sampleRowId);
      selected[index] = { ...replacement, c2SelectionCategory: "SCRIPT_BUCKET_BALANCE" };
      used.delete(displaced.sampleRowId);
      used.add(replacement.sampleRowId);
      bucketCounts = countsByBucket();
    }
  }
  const selectedByBucket = countsByBucket();
  const availableBuckets = bucketsWithMinimum(eligible, 10);
  const bucketShortfallRows = [...availableBuckets.entries()].map(([scriptBucket, available]) => ({
    scriptBucket,
    available,
    selected: selectedByBucket.get(scriptBucket) ?? 0,
    requestedMinimum: 10,
    shortfall: Math.max(0, 10 - (selectedByBucket.get(scriptBucket) ?? 0)),
  }));
  const actualByCategory = new Map();
  for (const row of selected) {
    if (!row.c2SelectionCategory || row.c2SelectionCategory === "FILL" || row.c2SelectionCategory === "SCRIPT_BUCKET_BALANCE") continue;
    actualByCategory.set(row.c2SelectionCategory, (actualByCategory.get(row.c2SelectionCategory) ?? 0) + 1);
  }
  for (const [category, requested] of quotas.map(([category, requested]) => [category, Math.min(requested, target)])) {
    const actual = actualByCategory.get(category) ?? 0;
    if (actual < requested) {
      shortfalls.push({
        category,
        requested,
        available: eligible.filter((row) => quotas.find(([candidate]) => candidate === category)?.[2](row)).length,
        actual,
        shortfall: requested - actual,
        reason: "SCRIPT_BUCKET_BALANCE_OR_OVERLAPPING_QUOTA",
      });
    }
  }
  return {
    target,
    actual: selected.length,
    longTailSourceFrequencyLimit: longTailLimit,
    selected: selected.sort((left, right) => left.sampleRowId.localeCompare(right.sampleRowId)),
    categoryShortfalls: shortfalls,
    categoryActual: mapValues(actualByCategory).length === 0 ? [] : [...actualByCategory.entries()].map(([category, actual]) => ({ category, actual })).sort((left, right) => left.category.localeCompare(right.category)),
    scriptBucketShortfalls: bucketShortfallRows,
    eligibleCount: eligible.length,
    unavailablePreviewCount: eligibleSampleIds ? baseline.length - eligible.length : 0,
  };
}

/** Queue every changed chapter result and 50 deterministic unchanged controls. */
export function buildC2AuditQueue(scored, cohort) {
  const selectedIds = new Set(cohort.selected.map(({ sampleRowId }) => sampleRowId));
  const evidence = scored.evidence.filter((row) => selectedIds.has(row.sampleRowId) && row.maxTextTags === 3 && !row.manualSnapshotComplete);
  const baseline = evidence.filter(({ configId }) => configId === "B_BASELINE");
  const baselineSets = new Map();
  for (const row of baseline.filter(({ selectedAfterCap }) => selectedAfterCap)) {
    const values = baselineSets.get(row.sampleRowId) ?? new Set();
    values.add(row.canonicalTagId);
    baselineSets.set(row.sampleRowId, values);
  }
  const cases = [];
  for (const configId of ["B_CHAPTER_10", "B_CHAPTER_15"]) {
    const candidateRows = evidence.filter((row) => row.configId === configId);
    const candidateByKey = new Map(candidateRows.map((row) => [`${row.sampleRowId}|${row.canonicalTagId}`, row]));
    const baselineByKey = new Map(baseline.map((row) => [`${row.sampleRowId}|${row.canonicalTagId}`, row]));
    const bySample = new Map();
    for (const row of candidateRows.filter(({ selectedAfterCap }) => selectedAfterCap)) {
      const values = bySample.get(row.sampleRowId) ?? new Set();
      values.add(row.canonicalTagId);
      bySample.set(row.sampleRowId, values);
    }
    const changedKeys = new Set();
    for (const sampleRowId of selectedIds) {
      const before = baselineSets.get(sampleRowId) ?? new Set();
      const after = bySample.get(sampleRowId) ?? new Set();
      for (const tagId of new Set([...before, ...after])) if (before.has(tagId) !== after.has(tagId)) changedKeys.add(`${sampleRowId}|${tagId}`);
    }
    for (const key of [...changedKeys].sort()) {
      const row = candidateByKey.get(key) ?? baselineByKey.get(key);
      if (!row) continue;
      const baselineSelected = Boolean(baselineByKey.get(key)?.selectedAfterCap);
      const chapterSelected = Boolean(candidateByKey.get(key)?.selectedAfterCap);
      cases.push({
        auditCaseId: caseId("chapter", [configId, row.sampleRowId, row.canonicalTagId]),
        recordType: "CHAPTER_DELTA_PAIR",
        stratum: "CHAPTER_DELTA",
        requiredReviewer: "terra",
        blind: true,
        configId,
        maxTextTags: 3,
        sampleRowId: row.sampleRowId,
        novelIdentity: row.novelIdentity,
        scriptBucket: row.scriptBucket,
        sourceLanguageCode: row.sourceLanguageCode,
        canonicalTagId: row.canonicalTagId,
        canonicalTagSlug: row.canonicalTagSlug,
        canonicalTagDefinition: row.canonicalTagDefinition,
        matcherEvidence: auditEvidence(row),
        chapterDeltaDirection: chapterSelected ? "ADDED" : "REMOVED",
        baselineSelected,
        chapterSelected,
        automaticLowConfidenceReasons: ["CHAPTER_LOCAL_SCENE", ...row.chapterMatches.flatMap(({ riskFlags }) => riskFlags)].filter((value, index, values) => values.indexOf(value) === index).sort(),
        sourceEvidenceHidden: true,
      });
    }
    const unchanged = candidateRows.filter((row) => row.selectedAfterCap && !changedKeys.has(`${row.sampleRowId}|${row.canonicalTagId}`));
    for (const row of sortByHash(unchanged, (item) => `C2_CONTROL|${configId}|${item.sampleRowId}|${item.canonicalTagId}`).slice(0, 50)) {
      cases.push({
        auditCaseId: caseId("chapter-control", [configId, row.sampleRowId, row.canonicalTagId]),
        recordType: "CHAPTER_UNCHANGED_CONTROL",
        stratum: "CHAPTER_UNCHANGED_CONTROL",
        requiredReviewer: "terra",
        blind: true,
        configId,
        maxTextTags: 3,
        sampleRowId: row.sampleRowId,
        novelIdentity: row.novelIdentity,
        scriptBucket: row.scriptBucket,
        sourceLanguageCode: row.sourceLanguageCode,
        canonicalTagId: row.canonicalTagId,
        canonicalTagSlug: row.canonicalTagSlug,
        canonicalTagDefinition: row.canonicalTagDefinition,
        matcherEvidence: auditEvidence(row),
        automaticLowConfidenceReasons: ["CHAPTER_LOCAL_SCENE"],
        sourceEvidenceHidden: true,
      });
    }
  }
  return cases.sort((left, right) => left.auditCaseId.localeCompare(right.auditCaseId));
}

/**
 * C2 remains Owner-gated. This aggregates already blind-reviewed chapter
 * delta cases; it never upgrades the chapter recommendation automatically.
 */
export function summarizeC2Reviews(chapterAuditQueue, rawReviews) {
  const knownCaseIds = new Set(chapterAuditQueue.map(({ auditCaseId }) => auditCaseId));
  const reviews = validateReviews(rawReviews, knownCaseIds);
  const byCase = new Map();
  for (const review of reviews) {
    const roles = byCase.get(review.auditCaseId) ?? new Map();
    roles.set(review.reviewerRole, review);
    byCase.set(review.auditCaseId, roles);
  }
  const decisions = chapterAuditQueue.map((item) => {
    const roles = byCase.get(item.auditCaseId) ?? new Map();
    const terra = roles.get("terra") ?? null;
    const sol = roles.get("sol") ?? null;
    const owner = roles.get("owner") ?? null;
    const requiresSol = Boolean(terra && (terra.verdict !== "CORRECT" || terra.reviewConfidence === "LOW" || item.automaticLowConfidenceReasons.length > 0));
    const finalVerdict = owner?.finalVerdict ?? (requiresSol ? sol?.finalVerdict ?? null : terra?.verdict === "CORRECT" && terra.reviewConfidence === "HIGH" ? "FINAL_CORRECT" : null);
    return { ...item, terraReview: terra, solReview: sol, ownerReview: owner, requiresSol, finalVerdict };
  });
  const byConfig = new Map();
  for (const decision of decisions) {
    const aggregate = byConfig.get(decision.configId) ?? {
      configId: decision.configId,
      changedCases: 0,
      unchangedControls: 0,
      addedCases: 0,
      removedCases: 0,
      addedFinalCorrect: 0,
      addedFinalFalsePositive: 0,
      removedFinalCorrect: 0,
      removedFinalFalsePositive: 0,
      finalCorrect: 0,
      finalFalsePositive: 0,
      unresolved: 0,
    };
    if (decision.recordType === "CHAPTER_DELTA_PAIR") aggregate.changedCases += 1;
    else aggregate.unchangedControls += 1;
    if (decision.recordType === "CHAPTER_DELTA_PAIR" && decision.chapterDeltaDirection === "ADDED") aggregate.addedCases += 1;
    if (decision.recordType === "CHAPTER_DELTA_PAIR" && decision.chapterDeltaDirection === "REMOVED") aggregate.removedCases += 1;
    if (decision.finalVerdict === "FINAL_CORRECT") {
      aggregate.finalCorrect += 1;
      if (decision.chapterDeltaDirection === "ADDED") aggregate.addedFinalCorrect += 1;
      if (decision.chapterDeltaDirection === "REMOVED") aggregate.removedFinalCorrect += 1;
    } else if (decision.finalVerdict === "FINAL_FALSE_POSITIVE") {
      aggregate.finalFalsePositive += 1;
      if (decision.chapterDeltaDirection === "ADDED") aggregate.addedFinalFalsePositive += 1;
      if (decision.chapterDeltaDirection === "REMOVED") aggregate.removedFinalFalsePositive += 1;
    } else aggregate.unresolved += 1;
    byConfig.set(decision.configId, aggregate);
  }
  return {
    decisions,
    summaries: mapValues(byConfig).map((row) => ({
      ...row,
      chapterDeltaFpRate: ratio(row.finalFalsePositive, row.finalCorrect + row.finalFalsePositive),
      recommendation: "DEFER_OWNER_DECISION_REQUIRED",
    })).sort((left, right) => left.configId.localeCompare(right.configId)),
    ownerDecisionRequired: true,
    topChapterFalsePositiveTags: (() => {
      const counts = new Map();
      for (const row of decisions) {
        if (row.recordType !== "CHAPTER_DELTA_PAIR" || row.finalVerdict !== "FINAL_FALSE_POSITIVE") continue;
        counts.set(row.canonicalTagId, (counts.get(row.canonicalTagId) ?? 0) + 1);
      }
      return [...counts.entries()]
        .map(([canonicalTagId, count]) => ({ canonicalTagId, count }))
        .sort((left, right) => right.count - left.count || left.canonicalTagId.localeCompare(right.canonicalTagId))
        .slice(0, 20);
    })(),
  };
}

function c2DeltaSummary(scored, cohort, preview) {
  const ids = new Set(cohort.selected.map(({ sampleRowId }) => sampleRowId));
  const diagnostic = new Map(scored.bookDiagnostics.filter((row) => ids.has(row.sampleRowId) && row.maxTextTags === 3).map((row) => [`${row.configId}|${row.sampleRowId}`, row]));
  const baseline = new Map([...ids].map((id) => [id, diagnostic.get(`B_BASELINE|${id}`)]));
  return ["B_CHAPTER_10", "B_CHAPTER_15"].map((configId) => {
    let zeroHitBefore = 0;
    let zeroHitAfter = 0;
    let tagsBefore = 0;
    let tagsAfter = 0;
    const languageRows = new Map();
    for (const id of ids) {
      const before = baseline.get(id);
      const after = diagnostic.get(`${configId}|${id}`);
      if (!before || !after) continue;
      if (before.selectedTextTagCount === 0) zeroHitBefore += 1;
      if (after.selectedTextTagCount === 0) zeroHitAfter += 1;
      tagsBefore += before.selectedTextTagCount;
      tagsAfter += after.selectedTextTagCount;
      const key = `${before.sourceLanguageCode}|${before.scriptBucket}`;
      const aggregate = languageRows.get(key) ?? {
        sourceLanguageCode: before.sourceLanguageCode,
        scriptBucket: before.scriptBucket,
        sampleCount: 0,
        zeroHitBefore: 0,
        zeroHitAfter: 0,
        tagsBefore: 0,
        tagsAfter: 0,
      };
      aggregate.sampleCount += 1;
      aggregate.zeroHitBefore += before.selectedTextTagCount === 0 ? 1 : 0;
      aggregate.zeroHitAfter += after.selectedTextTagCount === 0 ? 1 : 0;
      aggregate.tagsBefore += before.selectedTextTagCount;
      aggregate.tagsAfter += after.selectedTextTagCount;
      languageRows.set(key, aggregate);
    }
    const corpusRows = [...ids].map((id) => preview.bySampleId.get(id)).filter(Boolean);
    const requestCounts = corpusRows.map(({ requestCount }) => requestCount);
    const durations = corpusRows.map(({ fetchDurationMs }) => fetchDurationMs);
    const responseBytes = corpusRows.map(({ responseBytes }) => responseBytes);
    return {
      configId,
      comparedTo: "B_BASELINE",
      sampleCount: ids.size,
      zeroHitBefore,
      zeroHitAfter,
      zeroHitReduction: zeroHitBefore - zeroHitAfter,
      avgTagDelta: ids.size === 0 ? null : (tagsAfter - tagsBefore) / ids.size,
      byLanguage: mapValues(languageRows).map((row) => ({
        ...row,
        zeroHitReduction: row.zeroHitBefore - row.zeroHitAfter,
        avgTagDelta: row.sampleCount === 0 ? null : (row.tagsAfter - row.tagsBefore) / row.sampleCount,
      })).sort((left, right) => left.scriptBucket.localeCompare(right.scriptBucket) || left.sourceLanguageCode.localeCompare(right.sourceLanguageCode)),
      cost: {
        avgRequestsPerBook: ratio(requestCounts.reduce((sum, value) => sum + value, 0), requestCounts.length),
        requestP90: percentile(requestCounts, 0.9),
        fetchDurationMsP50: percentile(durations, 0.5),
        fetchDurationMsP90: percentile(durations, 0.9),
        avgResponseBytes: ratio(responseBytes.reduce((sum, value) => sum + value, 0), responseBytes.length),
      },
    };
  });
}

export function buildC2Run({ samples, taxonomy, sourceMapping = null, previewCorpus, runId, generatedAt }) {
  const checkedSamples = Array.isArray(samples) ? validateSamples(samples) : samples;
  const checkedTaxonomy = taxonomy?.fingerprint && taxonomy?.canonicalTags ? taxonomy : validateTaxonomy(taxonomy);
  const checkedMapping = sourceMapping?.exact instanceof Map ? sourceMapping : validateSourceMapping(sourceMapping, checkedTaxonomy);
  const checkedPreview = previewCorpus?.bySampleId instanceof Map ? previewCorpus : validatePreviewCorpus(previewCorpus, checkedSamples.samples);
  const baseline = scoreCalibration({
    samples: checkedSamples,
    taxonomy: checkedTaxonomy,
    sourceMapping: checkedMapping,
    configurations: [C2_CONFIGURATIONS[0]],
    maxTextTags: [3],
    runId,
    generatedAt,
    mode: "C2_SELECTION",
  });
  const cohort = buildC2Cohort(baseline, { eligibleSampleIds: new Set(checkedPreview.bySampleId.keys()) });
  const selectedIds = new Set(cohort.selected.map(({ sampleRowId }) => sampleRowId));
  const selectedRows = checkedSamples.samples.filter((sample) => selectedIds.has(sample.sampleRowId));
  const selectedSamples = { ...checkedSamples, samples: selectedRows, fingerprint: fingerprint(selectedRows) };
  const run = scoreCalibration({
    samples: selectedSamples,
    taxonomy: checkedTaxonomy,
    sourceMapping: checkedMapping,
    previewCorpus: checkedPreview,
    configurations: C2_CONFIGURATIONS,
    maxTextTags: [3],
    runId,
    generatedAt,
    mode: "C2",
  });
  const chapterAuditQueue = buildC2AuditQueue(run, cohort);
  return { ...run, cohort, chapterAuditQueue, chapterDelta: c2DeltaSummary(run, cohort, checkedPreview) };
}

export function rowsToJsonl(rows) {
  return rows.map((row) => JSON.stringify({
    ...row,
    calibrationStatus: CALIBRATION_STATUS,
    recommendationStatus: RECOMMENDATION_STATUS,
  })).join("\n") + (rows.length > 0 ? "\n" : "");
}

function markdownRate(value) {
  return value === null || value === undefined ? "N/A" : `${(value * 100).toFixed(2)}%`;
}

function reportStatusBlock(scored, review = null) {
  const recommended = review?.recommended ?? null;
  const summary = recommended && scored.summaries.find((row) => row.configId === recommended.configId && row.maxTextTags === recommended.maxTextTags);
  return [
    "```text",
    `LANE_C_C1_STATUS=${scored.mode === "C2" ? "CALIBRATION_REVIEW_PENDING_C2_COMPLETE" : "CALIBRATION_REVIEW_PENDING"}`,
    `C1_SAMPLE_COUNT=${scored.samples.count}`,
    `LANE_C_C2_STATUS=${scored.mode === "C2" ? "CALIBRATION_PROVISIONAL_OWNER_DECISION_REQUIRED" : INITIAL_LANE_C_STATUS.LANE_C_C2_STATUS}`,
    `TEXT_CALIBRATION_STATUS=${CALIBRATION_STATUS}`,
    `TEXT_PARAMETER_STATUS=${RECOMMENDATION_STATUS}`,
    `CHAPTER_EVIDENCE_STATUS=${scored.mode === "C2" ? "CALIBRATION_PROVISIONAL_OWNER_DECISION_REQUIRED" : "DEFER"}`,
    `RECOMMENDED_TITLE_WEIGHT=${summary?.titleWeight ?? "OWNER_REVIEW_REQUIRED"}`,
    `RECOMMENDED_DESCRIPTION_WEIGHT=${summary?.descriptionWeight ?? "OWNER_REVIEW_REQUIRED"}`,
    `RECOMMENDED_CHAPTER_WEIGHT=${summary?.chapterWeight ?? 0}`,
    `RECOMMENDED_THRESHOLD=${summary?.threshold ?? "OWNER_REVIEW_REQUIRED"}`,
    `RECOMMENDED_MAX_TEXT_TAGS=${recommended?.maxTextTags ?? "OWNER_REVIEW_REQUIRED"}`,
    `CHAPTER_EVIDENCE_RECOMMENDATION=${scored.mode === "C2" ? "DEFER" : "NOT_RUN"}`,
    `OWNER_DECISION_ITEMS=${INITIAL_LANE_C_STATUS.OWNER_DECISION_ITEMS}`,
    "AUTO_WRITE_AUTHORIZED=NO",
    "```",
  ].join("\n");
}

export function renderCalibrationReport(scored, review = null, c2Review = null) {
  const rows = scored.summaries.map((summary) => {
    const metric = review?.metrics.find((item) => item.configId === summary.configId && item.maxTextTags === summary.maxTextTags);
    return `| ${summary.configId} | ${summary.titleWeight} | ${summary.descriptionWeight} | ${summary.chapterWeight} | ${summary.threshold} | ${summary.maxTextTags} | ${markdownRate(summary.overall.textHitRate)} | ${markdownRate(metric?.estimatedTextFpRate)} | ${summary.overall.avgTextTags?.toFixed(2) ?? "N/A"} | ${summary.overall.selectedTextTagCount.p50 ?? "N/A"}/${summary.overall.selectedTextTagCount.p90 ?? "N/A"}/${summary.overall.selectedTextTagCount.p99 ?? "N/A"} |`;
  });
  const languageRows = scored.summaries.flatMap((summary) => summary.byLanguage.map((row) => (
    `| ${summary.configId}/${summary.maxTextTags} | ${row.scriptBucket} | ${row.sourceLanguageCode} | ${row.sampleCount} | ${markdownRate(row.textHitRate)} | ${markdownRate(row.titleOnlyRate)} | ${markdownRate(row.descriptionOnlyRate)} | ${markdownRate(row.bothRate)} | ${markdownRate(row.zeroHitRate)} | ${row.avgTextTags?.toFixed(2) ?? "N/A"} | ${row.selectedTextTagCount.p50 ?? "N/A"}/${row.selectedTextTagCount.p90 ?? "N/A"}/${row.selectedTextTagCount.p99 ?? "N/A"} |`
  )));
  const reviewSection = review ? [
    "## Provisional false-positive review",
    "",
    "| Candidate | Estimated pair FP | Book any-FP | Optimistic/conservative | Unresolved | Bootstrap 95% upper | Resolution rate | Guardrail eligible |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...review.metrics.map((metric) => `| ${metric.configId}/${metric.maxTextTags} | ${markdownRate(metric.estimatedTextFpRate)} | ${markdownRate(metric.bookAnyFpRate)} | ${markdownRate(metric.optimisticFpRate)}/${markdownRate(metric.conservativeFpRate)} | ${markdownRate(metric.unresolvedRate)} | ${markdownRate(metric.bootstrap95?.upper)} | ${markdownRate(metric.resolutionRate)} | ${metric.guardrailEligible ? "yes" : "no"} |`),
    "",
    "The false-positive estimate is a weighted, provisional estimate for this deterministic calibration sample. It is not a production-population rate.",
    "",
  ] : [
    "## Provisional false-positive review",
    "",
    "No adjudications have been merged. All precision gates remain unassessed.",
    "",
  ];
  const c2Section = scored.mode === "C2" ? [
    "## C2 chapter increment",
    "",
    "| Candidate | Zero-hit reduction | Avg tag delta | Requests/book | Fetch p90 |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...scored.chapterDelta.map((row) => `| ${row.configId} | ${row.zeroHitReduction} | ${row.avgTagDelta?.toFixed(3) ?? "N/A"} | ${row.cost.avgRequestsPerBook?.toFixed(2) ?? "N/A"} | ${row.cost.fetchDurationMsP90 ?? "N/A"}ms |`),
    "",
    ...(c2Review ? [
      "| Candidate | Added correct/FP | Removed correct/FP | Unresolved | Owner decision |",
      "| --- | ---: | ---: | ---: | --- |",
      ...c2Review.summaries.map((row) => `| ${row.configId} | ${row.addedFinalCorrect}/${row.addedFinalFalsePositive} | ${row.removedFinalCorrect}/${row.removedFinalFalsePositive} | ${row.unresolved} | ${row.recommendation} |`),
      "",
      "Top chapter-delta false-positive tags are recorded in `c2-review-summary.json`; no individual keyword is deemed causal without a separate leave-one-keyword-out run.",
      "",
    ] : []),
    "| Candidate | Script | Language | Samples | Zero-hit reduction | Avg tag delta |",
    "| --- | --- | --- | ---: | ---: | ---: |",
    ...scored.chapterDelta.flatMap((candidate) => candidate.byLanguage.map((row) => `| ${candidate.configId} | ${row.scriptBucket} | ${row.sourceLanguageCode} | ${row.sampleCount} | ${row.zeroHitReduction} | ${row.avgTagDelta?.toFixed(3) ?? "N/A"} |`)),
    "",
    "`CHAPTER_EVIDENCE_RECOMMENDATION=DEFER`: only Owner may decide INCLUDE_V1 or REJECT after reviewing all chapter-delta adjudications and cost evidence.",
    "",
  ] : [];
  const operationalSection = [
    "## Cap, zero-hit, and review queues",
    "",
    "| Candidate | Text-cap truncated books | Truncated tags | Zero-hit rate | Source/text conflicts |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...scored.summaries.map((summary) => {
      const conflicts = scored.sourceDiagnostics.filter((row) => row.configId === summary.configId && row.maxTextTags === summary.maxTextTags && row.sourceTextRelation === "SOURCE_TEXT_CONFLICT_REVIEW").length;
      return `| ${summary.configId}/${summary.maxTextTags} | ${summary.overall.capTruncatedBooks} | ${summary.overall.capTruncatedTags} | ${markdownRate(summary.overall.zeroHitRate)} | ${conflicts} |`;
    }),
    "",
    "Zero-hit excerpts and exact input hashes are in `text-book-diagnostics.jsonl`; `zero-hit-source-types.json` lists the top mapped source types where text coverage is absent. They identify keyword coverage gaps without automatically expanding the lexicon. Candidate evidence, cap drops, Terra blind cases, post-blind conflicts, and every per-stratum shortfall are separate artifacts.",
    "",
  ];
  const falsePositiveKeywords = review ? [
    "## Top false-positive keywords",
    "",
    "| Keyword | Associated reviewed false positives | Classification |",
    "| --- | ---: | --- |",
    ...(review.topFalsePositiveKeywords.length === 0
      ? ["| No final false positives adjudicated | 0 | NOT_AVAILABLE |"]
      : review.topFalsePositiveKeywords.map((row) => `| ${row.keyword} (${row.keywordId}) | ${row.associatedFalsePositiveCount} | ${row.classification} |`)),
    "",
    "A keyword is only `FP_ASSOCIATED_KEYWORD` here: a field bucket can match several keywords, so causal attribution requires a separate leave-one-keyword-out rerun.",
    "",
  ] : [];
  return [
    "# P2-06.5 Gate A · Lane C Text Calibration Report",
    "",
    `Status: \`${CALIBRATION_STATUS}\` · recommendation state: \`${RECOMMENDATION_STATUS}\``,
    "",
    "## Reproducibility",
    "",
    `- Run: \`${scored.runId}\` at \`${scored.generatedAt}\``,
    `- Taxonomy: \`${scored.taxonomy.taxonomyVersion}\` / \`${scored.taxonomy.fingerprint}\``,
    `- Keywords: \`${scored.taxonomy.keywordLexiconVersion}\``,
    `- Sample manifest fingerprint: \`${scored.samples.fingerprint}\` (${scored.samples.count} rows)`,
    `- Source mapping: ${scored.sourceMapping ? `\`${scored.sourceMapping.mappingVersion}\` / \`${scored.sourceMapping.fingerprint}\`` : "not supplied; final source ∪ text counts are unavailable"}`,
    "",
    "## Parameter comparison",
    "",
    "| Config | Title | Description | Chapter | Threshold | Max text tags | Hit rate | Estimated FP | Avg tags | p50/p90/p99 tags |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...rows,
    "",
    "## Language and script strata",
    "",
    "The project locale registry is not used here. Results are stratified by the supplied upstream language code and explicit script bucket.",
    "",
    "| Candidate | Script | Source language | Samples | Hit | Title-only | Description-only | Both | Zero-hit | Avg tags | p50/p90/p99 |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...languageRows,
    "",
    ...reviewSection,
    ...falsePositiveKeywords,
    ...operationalSection,
    ...c2Section,
    "## Source and blind simulation",
    "",
    "Source mapping is excluded from text scoring and blind review. It is used only after adjudication to report source-only, text-only, source+text, and declared-mutual-exclusivity conflict diagnostics. The `source-blind-simulation.json` artifact reports the identical text-only run for future channels without taxonomy evidence.",
    "",
    "## Fixed status block",
    "",
    reportStatusBlock(scored, review),
    "",
  ].join("\n");
}

function contentBundle(scored, auditQueue = null, review = null, c2Review = null) {
  const zeroHitSourceTypes = new Map();
  for (const row of scored.bookDiagnostics.filter((row) => row.selectedTextTagCount === 0 && row.sourceEvidenceStatus === "SOURCE_SNAPSHOT_COMPLETE")) {
    const labels = row.sourceMappedTagIds.length === 0 ? ["UNMAPPED_OR_UNCLASSIFIED"] : row.sourceMappedTagIds;
    for (const label of labels) {
      const key = `${row.configId}|${row.maxTextTags}|${row.scriptBucket}|${row.sourceLanguageCode}|${label}`;
      const aggregate = zeroHitSourceTypes.get(key) ?? {
        configId: row.configId,
        maxTextTags: row.maxTextTags,
        scriptBucket: row.scriptBucket,
        sourceLanguageCode: row.sourceLanguageCode,
        sourceMappedCanonicalTagId: label,
        zeroHitNovelCount: 0,
        sampleRowIds: [],
      };
      aggregate.zeroHitNovelCount += 1;
      aggregate.sampleRowIds.push(row.sampleRowId);
      zeroHitSourceTypes.set(key, aggregate);
    }
  }
  const topZeroHitSourceTypes = mapValues(zeroHitSourceTypes)
    .map((row) => ({ ...row, sampleRowIds: row.sampleRowIds.sort().slice(0, 20) }))
    .sort((left, right) => right.zeroHitNovelCount - left.zeroHitNovelCount || left.sourceMappedCanonicalTagId.localeCompare(right.sourceMappedCanonicalTagId))
    .slice(0, 20);
  const contents = new Map([
    ["text-evidence.jsonl", rowsToJsonl(scored.evidence)],
    ["text-book-diagnostics.jsonl", rowsToJsonl(scored.bookDiagnostics)],
    ["cap-diagnostics.jsonl", rowsToJsonl(scored.bookDiagnostics.map((row) => ({
      recordType: "TEXT_CAP_DIAGNOSTIC",
      configId: row.configId,
      maxTextTags: row.maxTextTags,
      sampleRowId: row.sampleRowId,
      novelIdentity: row.novelIdentity,
      sourceLanguageCode: row.sourceLanguageCode,
      sourceLanguageName: row.sourceLanguageName,
      scriptBucket: row.scriptBucket,
      rawEligibleTextTagCount: row.rawEligibleTextTagCount,
      selectedTextTagCount: row.selectedTextTagCount,
      selectedTextTagIds: row.selectedTextTagIds,
      truncatedTextTagCount: row.truncatedTextTagCount,
      truncatedTextTagIds: row.truncatedTextTagIds,
      truncationReason: row.truncatedTextTagCount > 0 ? "MAX_TEXT_TAGS" : null,
    })))],
    ["source-text-diagnostics.jsonl", rowsToJsonl(scored.sourceDiagnostics)],
    ["zero-hit-source-types.json", `${JSON.stringify({
      status: CALIBRATION_STATUS,
      recommendationStatus: RECOMMENDATION_STATUS,
      note: "Source labels appear only after text calibration; they diagnose zero-hit keyword coverage and never change a text adjudication.",
      rows: topZeroHitSourceTypes,
    }, null, 2)}\n`],
    ["source-blind-simulation.json", `${JSON.stringify({
      status: CALIBRATION_STATUS,
      recommendationStatus: RECOMMENDATION_STATUS,
      simulations: scored.sourceBlindSimulation,
    }, null, 2)}\n`],
    ["calibration-summary.json", `${JSON.stringify({
      status: scored.status,
      recommendationStatus: scored.recommendationStatus,
      mode: scored.mode,
      runId: scored.runId,
      generatedAt: scored.generatedAt,
      taxonomy: scored.taxonomy,
      samples: scored.samples,
      sourceMapping: scored.sourceMapping,
      previewCorpus: scored.previewCorpus,
      configurations: scored.configurations,
      summaries: scored.summaries,
      cohort: scored.cohort ?? null,
      chapterDelta: scored.chapterDelta ?? null,
    }, null, 2)}\n`],
    ["LANE_C_REPORT.md", renderCalibrationReport(scored, review, c2Review)],
  ]);
  if (auditQueue) {
    contents.set("blind-audit-queue.jsonl", rowsToJsonl(auditQueue.primaryCases));
    contents.set("post-blind-source-conflict-queue.jsonl", rowsToJsonl(auditQueue.postBlindCases));
    contents.set("audit-queue-shortfalls.json", `${JSON.stringify({
      status: CALIBRATION_STATUS,
      recommendationStatus: RECOMMENDATION_STATUS,
      shortfalls: auditQueue.shortfalls,
    }, null, 2)}\n`);
  }
  if (scored.chapterAuditQueue) {
    contents.set("c2-cohort.jsonl", rowsToJsonl(scored.cohort.selected));
    contents.set("c2-cohort-summary.json", `${JSON.stringify({
      status: CALIBRATION_STATUS,
      recommendationStatus: RECOMMENDATION_STATUS,
      ...scored.cohort,
      selected: undefined,
    }, null, 2)}\n`);
    contents.set("c2-blind-audit-queue.jsonl", rowsToJsonl(scored.chapterAuditQueue));
    if (c2Review) {
      contents.set("c2-review-decisions.jsonl", rowsToJsonl(c2Review.decisions));
      contents.set("c2-review-summary.json", `${JSON.stringify({
        status: CALIBRATION_STATUS,
        recommendationStatus: RECOMMENDATION_STATUS,
        ...c2Review,
      }, null, 2)}\n`);
    }
  }
  return contents;
}

function artifactDescriptors(contents) {
  return [...contents.entries()].map(([path, content]) => {
    const bytes = Buffer.from(content, "utf8");
    const rowCount = path.endsWith(".jsonl") ? (content === "" ? 0 : content.trimEnd().split("\n").length) : null;
    return { path, bytes: bytes.length, sha256: sha256(bytes), rowCount };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

export function buildArtifactBundle(scored, { auditQueue = null, review = null, c2Review = null } = {}) {
  const contents = contentBundle(scored, auditQueue, review, c2Review);
  const manifest = {
    schemaVersion: 1,
    lane: "P2-06.5/C",
    status: CALIBRATION_STATUS,
    recommendationStatus: RECOMMENDATION_STATUS,
    mode: scored.mode,
    runId: scored.runId,
    generatedAt: scored.generatedAt,
    taxonomy: scored.taxonomy,
    samples: scored.samples,
    sourceMapping: scored.sourceMapping,
    previewCorpus: scored.previewCorpus,
    lexiconOverride: scored.lexiconOverride ?? null,
    artifacts: artifactDescriptors(contents),
  };
  contents.set("lane-c-run-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, contents };
}

export async function writeArtifactBundle(outputDirectory, bundle) {
  await mkdir(outputDirectory, { recursive: true });
  for (const [artifactPath, content] of bundle.contents) {
    const path = join(outputDirectory, artifactPath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  }
  return outputDirectory;
}

export async function verifyArtifactBundle(outputDirectory) {
  const manifestPath = join(outputDirectory, "lane-c-run-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const failures = [];
  for (const artifact of manifest.artifacts) {
    const bytes = await readFile(join(outputDirectory, artifact.path));
    const actual = sha256(bytes);
    if (actual !== artifact.sha256) failures.push({ path: artifact.path, expected: artifact.sha256, actual });
  }
  return { ok: failures.length === 0, failures, manifestPath: relative(process.cwd(), manifestPath) };
}

export async function readJsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function readJsonlFile(path) {
  const content = await readFile(path, "utf8");
  return content.split(/\r?\n/).filter((line) => line.trim() !== "").map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      fail(`${path} line ${index + 1} is not JSON`);
    }
  });
}

export async function assertDirectoryEmpty(path) {
  try {
    const entries = await readdir(path);
    if (entries.length > 0) fail(`output directory must be empty: ${path}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
