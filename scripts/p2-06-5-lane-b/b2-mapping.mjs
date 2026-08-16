/**
 * P2-06.5 Lane B / B2 — offline candidate evidence compiler.
 *
 * No network, database, LLM, fuzzy match, taxonomy write, or runtime lookup is
 * present here.  The only output is an auditable offline review artifact.
 */
import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;
const UNMAPPED_REASONS = new Set([
  "CANONICAL_GAP", "SEMANTIC_UNCERTAIN", "LOW_VALUE_SOURCE_TAG", "INSUFFICIENT_SAMPLE",
]);
const SCORE_NAMES = Object.freeze([
  "literal_meaning", "sample_semantic_evidence", "cooccurrence_evidence",
  "canonical_definition_fit", "filter_semantic_fit",
]);
const EVIDENCE_FLAG_NAMES = Object.freeze([
  "only_lexical", "only_translation", "polysemous", "sample_conflict",
]);
const QUARTER_VALUES = new Set([0, 0.25, 0.5, 0.75, 1]);
const SEMANTIC_CLUSTER_RECOMMENDATIONS = new Set(["SAME_CANONICAL_TAG", "DISTINCT_CANONICAL_TAGS", "UNDECIDED"]);
const SEMANTIC_CLUSTER_REVIEW_STATUSES = new Set([
  "HIGH_CONFIDENCE_MAPPING",
  "REVIEW_RECOMMENDED",
  "HUMAN_REVIEW_REQUIRED",
]);
export const SCORE_WEIGHTS = Object.freeze({
  literal_meaning: 0.15,
  sample_semantic_evidence: 0.30,
  cooccurrence_evidence: 0.10,
  canonical_definition_fit: 0.30,
  filter_semantic_fit: 0.15,
});
export const REVIEW_STATUS = Object.freeze({
  HIGH: "HIGH_CONFIDENCE_MAPPING",
  RECOMMENDED: "REVIEW_RECOMMENDED",
  HUMAN: "HUMAN_REVIEW_REQUIRED",
  GAP: "CANONICAL_GAP",
});

function fail(message) { throw new Error(`P2-06.5 Lane B mapping input invalid: ${message}`); }
function object(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${path} must be an object`);
  return value;
}
function rejectUnknownKeys(value, allowedKeys, path) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key} is an unknown field`);
  }
}
function text(value, path, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) fail(`${path} must be an exact non-empty string`);
  return value;
}
function decisionText(value, path) {
  const result = text(value, path);
  if (result.trim().length === 0) fail(`${path} must be a non-blank decision string`);
  return result;
}
function evidenceFlags(value, path) {
  const evidence = object(value, path);
  rejectUnknownKeys(evidence, EVIDENCE_FLAG_NAMES, path);
  const flags = {};
  for (const name of EVIDENCE_FLAG_NAMES) {
    if (Object.hasOwn(evidence, name) && typeof evidence[name] !== "boolean") {
      fail(`${path}.${name} must be boolean`);
    }
    flags[name] = evidence[name] === true;
  }
  return flags;
}
function hash(value, path) {
  const result = text(value, path);
  if (!SHA256.test(result)) fail(`${path} must be lowercase SHA-256 hex`);
  return result;
}
function sha256Bytes(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail("source evidence must contain only JSON values");
  return encoded;
}
export function sha256CanonicalPayload(value) { return createHash("sha256").update(stableJson(value), "utf8").digest("hex"); }
export function evaluationSampleCount(frequency) {
  if (!Number.isSafeInteger(frequency) || frequency < 1) fail("frequency must be a positive integer");
  return Math.min(frequency, Math.min(12, Math.max(5, Math.ceil(Math.sqrt(frequency)))));
}

function parseCanonicalTagV1(manifest, canonicalSha256) {
  const source = object(manifest, "canonical artifact");
  const canonicalVersion = text(source.canonical_version, "canonical_version");
  if (!Array.isArray(source.tags) || source.tags.length === 0) fail("tags must be a non-empty array");
  const ids = new Set(); const slugs = new Set();
  const tags = source.tags.map((raw, index) => {
    const tag = object(raw, `tags[${index}]`);
    const canonicalTagId = text(tag.canonical_tag_id, `tags[${index}].canonical_tag_id`);
    const slug = text(tag.slug, `tags[${index}].slug`);
    const displayName = text(tag.display_name ?? tag.display, `tags[${index}].display_name`);
    const localeScope = tag.locale_scope;
    if (localeScope !== "*" && (!Array.isArray(localeScope) || localeScope.length === 0)) fail(`tags[${index}].locale_scope must be "*" or a non-empty exact array`);
    const checkedScope = localeScope === "*" ? "*" : localeScope.map((locale, localeIndex) => text(locale, `tags[${index}].locale_scope[${localeIndex}]`));
    if (checkedScope !== "*" && new Set(checkedScope).size !== checkedScope.length) fail(`tags[${index}].locale_scope has duplicate values`);
    const definition = text(tag.definition, `tags[${index}].definition`);
    for (const key of ["include", "exclude"]) {
      if (!Array.isArray(tag[key]) || tag[key].length === 0) fail(`tags[${index}].${key} must be a non-empty array`);
      tag[key].forEach((item, itemIndex) => text(item, `tags[${index}].${key}[${itemIndex}]`));
    }
    if (!new Set(["draft", "public", "deprecated"]).has(tag.status)) fail(`tags[${index}].status must be draft, public, or deprecated`);
    if (ids.has(canonicalTagId) || slugs.has(slug)) fail(`CanonicalTag id and slug must each be stable and unique (${JSON.stringify(canonicalTagId)})`);
    ids.add(canonicalTagId); slugs.add(slug);
    return Object.freeze({ canonical_tag_id: canonicalTagId, slug, display_name: displayName, locale_scope: checkedScope, definition, include: [...tag.include], exclude: [...tag.exclude], status: tag.status });
  });
  return Object.freeze({ canonical_version: canonicalVersion, canonical_sha256: canonicalSha256, tags });
}

/** Validate CanonicalTag v1 parsed from actual artifact bytes, never a claimed hash. */
export function validateCanonicalTagV1Bytes({ artifactBytes, expectedSha256, actualSha256 } = {}) {
  if (!(typeof artifactBytes === "string" || artifactBytes instanceof Uint8Array)) fail("artifactBytes must be exact file bytes (string or Uint8Array)");
  const bytes = typeof artifactBytes === "string" ? Buffer.from(artifactBytes, "utf8") : Buffer.from(artifactBytes);
  const actual = sha256Bytes(bytes);
  const expected = hash(expectedSha256, "expected CanonicalTag SHA-256");
  if (actualSha256 !== undefined && hash(actualSha256, "actual CanonicalTag SHA-256") !== actual) fail("actualSha256 does not match actual CanonicalTag artifact bytes");
  if (actual !== expected) fail("expected CanonicalTag SHA-256 does not match actual artifact bytes");
  let artifact;
  try { artifact = JSON.parse(bytes.toString("utf8")); } catch { fail("CanonicalTag artifact bytes must contain JSON"); }
  return parseCanonicalTagV1(artifact, actual);
}

/** CLI-friendly alias: `{ artifact, expectedSha256, actualSha256? }`, artifact is exact bytes. */
export function validateCanonicalTagArtifact({ artifact, expectedSha256, actualSha256 } = {}) {
  return validateCanonicalTagV1Bytes({ artifactBytes: artifact, expectedSha256, actualSha256 });
}

export function sourceMappingGroupIdentity(group) {
  // Hash a length-delimited JSON tuple instead of joining raw values with a
  // delimiter: exact upstream tokens may themselves contain newlines.
  return sha256Bytes(Buffer.from(JSON.stringify([
    "LANE_B_MAPPING_GROUP_V1",
    group.channel_app_id,
    group.raw_language_scope,
    group.exact_raw_token,
  ]), "utf8"));
}

function sourceGroupEvidencePayload(group) {
  return {
    schema: "LANE_B_SOURCE_GROUP_EVIDENCE_V1",
    channel_app_id: group.channel_app_id,
    raw_language_scope: group.raw_language_scope,
    exact_raw_token: group.exact_raw_token,
    frequency: group.frequency,
    occurrence_count: group.occurrence_count,
    carrier_book_ids: group.carrier_book_ids,
    carrier_book_ids_complete: group.carrier_book_ids_complete === true,
    evaluation_sample_count: group.evaluation_sample_count ?? evaluationSampleCount(group.frequency),
    samples: group.samples,
    cooccurrence: group.cooccurrence ?? [],
  };
}

export function sourceGroupEvidenceSha256(group) {
  return sha256CanonicalPayload(sourceGroupEvidencePayload(group));
}

function validateFinalSampleBookIds(finalSampleBookIds) {
  if (!Array.isArray(finalSampleBookIds)) fail("final_sample_book_ids must be a complete array");
  const result = finalSampleBookIds.map((bookId, index) => text(bookId, `final_sample_book_ids[${index}]`));
  if (new Set(result).size !== result.length) fail("final_sample_book_ids must be unique");
  return result;
}

export function sourceEvidenceDigest({ source_groups, final_sample_book_ids, raw_manifest_sha256 } = {}) {
  if (!Array.isArray(source_groups)) fail("authoritative source_groups must be an array");
  const finalIds = validateFinalSampleBookIds(final_sample_book_ids);
  const rawManifestSha256 = hash(raw_manifest_sha256, "raw_manifest_sha256");
  const groups = source_groups.map((group, index) => {
    object(group, `authoritative_source_groups[${index}]`);
    return {
      group_identity: sourceMappingGroupIdentity(group),
      source_evidence_sha256: sourceGroupEvidenceSha256(group),
    };
  }).sort((left, right) => left.group_identity < right.group_identity ? -1 : left.group_identity > right.group_identity ? 1 : 0);
  return sha256CanonicalPayload({
    schema: "LANE_B_SOURCE_EVIDENCE_SET_V1",
    raw_manifest_sha256: rawManifestSha256,
    final_sample_book_ids: [...finalIds].sort(),
    groups,
  });
}

function bindReviewedSourceGroups(authoritativeGroups, reviewedGroups) {
  if (!Array.isArray(authoritativeGroups)) fail("authoritative_source_groups must be an array");
  if (!Array.isArray(reviewedGroups)) fail("reviewed_source_groups must be an array");
  const authoritativeById = new Map();
  for (const [index, raw] of authoritativeGroups.entries()) {
    const authoritative = object(raw, `authoritative_source_groups[${index}]`);
    const identity = sourceMappingGroupIdentity(authoritative);
    if (authoritativeById.has(identity)) fail(`duplicate authoritative exact mapping group identity ${JSON.stringify(identity)}`);
    if (Object.hasOwn(authoritative, "group_identity") && authoritative.group_identity !== identity) {
      fail(`authoritative_source_groups[${index}].group_identity does not match exact source identity`);
    }
    const evidenceSha256 = sourceGroupEvidenceSha256(authoritative);
    if (Object.hasOwn(authoritative, "source_evidence_sha256") && authoritative.source_evidence_sha256 !== evidenceSha256) {
      fail(`authoritative_source_groups[${index}].source_evidence_sha256 does not match evidence`);
    }
    authoritativeById.set(identity, { authoritative, index, evidenceSha256 });
  }

  const reviewedById = new Map();
  for (const [index, raw] of reviewedGroups.entries()) {
    const reviewed = object(raw, `reviewed_source_groups[${index}]`);
    const identity = sourceMappingGroupIdentity(reviewed);
    if (reviewedById.has(identity)) fail(`duplicate reviewed exact mapping group identity ${JSON.stringify(identity)}`);
    reviewedById.set(identity, { reviewed, index });
  }
  if (reviewedById.size !== authoritativeById.size) fail("reviewed source group set does not exactly match authoritative source group set");

  return [...authoritativeById.entries()].map(([identity, { authoritative, evidenceSha256 }]) => {
    const reviewedEntry = reviewedById.get(identity);
    if (!reviewedEntry) fail(`reviewed source group set is missing authoritative group ${JSON.stringify(identity)}`);
    const { reviewed, index: reviewedIndex } = reviewedEntry;
    const decisionKeys = new Set(["proposals", "unmapped_reason"]);
    const authoritativeKeys = new Set(Object.keys(authoritative));
    for (const key of Object.keys(reviewed)) {
      if (!authoritativeKeys.has(key) && !decisionKeys.has(key)) {
        fail(`reviewed_source_groups[${reviewedIndex}].${key} is not an allowed offline decision field`);
      }
    }
    for (const key of Object.keys(authoritative)) {
      if (decisionKeys.has(key)) continue;
      if (!Object.hasOwn(reviewed, key) || stableJson(reviewed[key]) !== stableJson(authoritative[key])) {
        fail(`reviewed_source_groups[${reviewedIndex}].${key} differs from authoritative evidence`);
      }
    }
    if (reviewed.group_identity !== undefined && reviewed.group_identity !== identity) {
      fail(`reviewed_source_groups[${reviewedIndex}].group_identity does not match exact source identity`);
    }
    if (reviewed.source_evidence_sha256 !== undefined && reviewed.source_evidence_sha256 !== evidenceSha256) {
      fail(`reviewed_source_groups[${reviewedIndex}].source_evidence_sha256 does not match authoritative evidence`);
    }
    const merged = {
      ...authoritative,
      group_identity: identity,
      source_evidence_sha256: evidenceSha256,
      proposals: reviewed.proposals,
    };
    if (Object.hasOwn(reviewed, "unmapped_reason")) merged.unmapped_reason = reviewed.unmapped_reason;
    else delete merged.unmapped_reason;
    if (merged.proposals === undefined) fail(`reviewed_source_groups[${reviewedIndex}].proposals must be present`);
    return merged;
  });
}
function tokenEvidence(token, prefix = "") {
  const bytes = Buffer.from(token, "utf8");
  return {
    [`${prefix}exact_raw_token`]: token,
    [`${prefix}exact_raw_token_utf8_base64`]: bytes.toString("base64"),
    [`${prefix}exact_raw_token_sha256`]: sha256Bytes(bytes),
  };
}
function validateSamples(samples, path) {
  if (!Array.isArray(samples)) fail(`${path} must be an array`);
  const validated = samples.map((raw, index) => {
    const sample = object(raw, `${path}[${index}]`);
    const externalBookId = text(sample.external_book_id, `${path}[${index}].external_book_id`);
    const bookIdentity = text(sample.book_identity ?? externalBookId, `${path}[${index}].book_identity`);
    const cooccurring = sample.cooccurring_exact_tokens ?? [];
    if (!Array.isArray(cooccurring)) fail(`${path}[${index}].cooccurring_exact_tokens must be an array`);
    return {
      book_identity: bookIdentity,
      external_book_id: externalBookId,
      external_book_id_raw_json: typeof sample.external_book_id_raw_json === "string" ? sample.external_book_id_raw_json : null,
      title: text(sample.title, `${path}[${index}].title`, { allowEmpty: true }),
      description: typeof sample.description === "string" ? sample.description : "",
      cooccurring_exact_tokens: cooccurring.map((token, tokenIndex) => text(token, `${path}[${index}].cooccurring_exact_tokens[${tokenIndex}]`, { allowEmpty: true })),
    };
  });
  if (new Set(validated.map(({ book_identity }) => book_identity)).size !== validated.length) {
    fail(`${path} must contain distinct carrier book identities`);
  }
  return validated;
}
function validateGroup(raw, index) {
  const source = object(raw, `source_groups[${index}]`);
  const frequency = source.frequency;
  if (!Number.isSafeInteger(frequency) || frequency < 1) fail(`source_groups[${index}].frequency must be a positive integer`);
  if (!Number.isSafeInteger(source.occurrence_count) || source.occurrence_count < frequency) fail(`source_groups[${index}].occurrence_count must be an integer >= frequency`);
  if (!Array.isArray(source.carrier_book_ids) || source.carrier_book_ids.length === 0) fail(`source_groups[${index}].carrier_book_ids must be a non-empty complete exact-id array`);
  const carrier_book_ids = source.carrier_book_ids.map((id, idIndex) => text(id, `source_groups[${index}].carrier_book_ids[${idIndex}]`));
  if (new Set(carrier_book_ids).size !== carrier_book_ids.length) fail(`source_groups[${index}].carrier_book_ids contains duplicate book ids`);
  if (frequency !== carrier_book_ids.length) fail(`source_groups[${index}].frequency must equal unique carrier_book_ids count`);
  const samples = validateSamples(source.samples, `source_groups[${index}].samples`);
  if (samples.some((sample) => !carrier_book_ids.includes(sample.book_identity))) fail(`source_groups[${index}].samples must be carrier books`);
  if (!Array.isArray(source.proposals)) fail(`source_groups[${index}].proposals must be an array`);
  source.proposals.forEach((rawProposal, proposalIndex) => {
    const proposal = object(rawProposal, `source_groups[${index}].proposals[${proposalIndex}]`);
    evidenceFlags(proposal.evidence, `source_groups[${index}].proposals[${proposalIndex}].evidence`);
    decisionText(proposal.reason, `source_groups[${index}].proposals[${proposalIndex}].reason`);
    decisionText(proposal.risk, `source_groups[${index}].proposals[${proposalIndex}].risk`);
  });
  const reason = source.unmapped_reason;
  if (reason !== undefined && !UNMAPPED_REASONS.has(reason)) fail(`source_groups[${index}].unmapped_reason is invalid`);
  if (source.proposals.length === 0 && reason === undefined) fail(`source_groups[${index}] with no proposals must declare an explicit unmapped_reason`);
  const cooccurrence = source.cooccurrence ?? [];
  if (!Array.isArray(cooccurrence)) fail(`source_groups[${index}].cooccurrence must be an array`);
  return {
    channel_app_id: text(source.channel_app_id, `source_groups[${index}].channel_app_id`),
    raw_language_scope: text(source.raw_language_scope, `source_groups[${index}].raw_language_scope`),
    exact_raw_token: text(source.exact_raw_token, `source_groups[${index}].exact_raw_token`, { allowEmpty: true }),
    frequency, occurrence_count: source.occurrence_count, carrier_book_ids, samples, proposals: source.proposals, unmapped_reason: reason,
    cooccurrence: cooccurrence.map((rawItem, itemIndex) => {
      const item = object(rawItem, `source_groups[${index}].cooccurrence[${itemIndex}]`);
      const count = item.count;
      if (!Number.isSafeInteger(count) || count < 0 || count > frequency) fail(`source_groups[${index}].cooccurrence[${itemIndex}].count must be 0..frequency`);
      return { exact_raw_token: text(item.exact_raw_token, `source_groups[${index}].cooccurrence[${itemIndex}].exact_raw_token`, { allowEmpty: true }), count, rate: Number((count / frequency).toFixed(4)) };
    }),
  };
}
function candidateStatus(confidence) {
  if (confidence >= 0.95) return REVIEW_STATUS.HIGH;
  if (confidence >= 0.80) return REVIEW_STATUS.RECOMMENDED;
  return REVIEW_STATUS.HUMAN;
}
function scoreEdge(raw, group, tagIndex, path) {
  const proposal = object(raw, path);
  const canonicalTagId = text(proposal.canonical_tag_id, `${path}.canonical_tag_id`);
  const tag = tagIndex.get(canonicalTagId);
  if (!tag || tag.status === "deprecated") fail(`${path} must target a non-deprecated CanonicalTag v1 id`);
  const targetLocale = text(proposal.target_locale, `${path}.target_locale`);
  if (tag.locale_scope !== "*" && !tag.locale_scope.includes(targetLocale)) fail(`${path}.target_locale is outside CanonicalTag locale_scope`);
  const scoreInput = object(proposal.scores, `${path}.scores`);
  let confidence = 0; const scores = {};
  for (const name of SCORE_NAMES) {
    const value = scoreInput[name];
    if (!QUARTER_VALUES.has(value)) fail(`${path}.scores.${name} must be one of 0, 0.25, 0.5, 0.75, 1`);
    scores[name] = value; confidence += value * SCORE_WEIGHTS[name];
  }
  const evidence = evidenceFlags(proposal.evidence, `${path}.evidence`);
  const reason = decisionText(proposal.reason, `${path}.reason`);
  const risk = decisionText(proposal.risk, `${path}.risk`);
  const caps = [];
  if (evidence.only_lexical === true) caps.push({ code: "ONLY_LEXICAL_CAP", max_confidence: 0.79 });
  if (evidence.only_translation === true) caps.push({ code: "ONLY_TRANSLATION_CAP", max_confidence: 0.79 });
  if (evidence.polysemous === true) caps.push({ code: "POLYSEMOUS_CAP", max_confidence: 0.79 });
  if (evidence.sample_conflict === true) caps.push({ code: "SAMPLE_CONFLICT_CAP", max_confidence: 0.79 });
  if (group.frequency <= 4) caps.push({ code: "FREQUENCY_3_TO_4_CAP", max_confidence: 0.949 });
  for (const cap of caps) confidence = Math.min(confidence, cap.max_confidence);
  return {
    canonical_tag_id: tag.canonical_tag_id, canonical_slug: tag.slug, canonical_display_name: tag.display_name,
    locale: targetLocale, scores, confidence: Number(confidence.toFixed(4)),
    reason, risk,
    evidence_flags: evidence, confidence_caps: caps,
  };
}
function groupFromSource(source, index, tags) {
  const identity = sourceMappingGroupIdentity(source);
  const requiredSamples = evaluationSampleCount(source.frequency);
  const base = { ...source, group_identity: identity, evaluation_sample_count: requiredSamples };
  if (source.frequency < 3 || source.samples.length < requiredSamples) return { ...base, edges: [], fanout: 0, group_min_confidence: null, group_status: "UNMAPPED", unmapped_reason: "INSUFFICIENT_SAMPLE" };
  if (source.proposals.length === 0) return { ...base, edges: [], fanout: 0, group_min_confidence: null, group_status: "UNMAPPED", unmapped_reason: source.unmapped_reason };
  const tagIndex = new Map(tags.map((tag) => [tag.canonical_tag_id, tag])); const targetIds = new Set();
  const edges = source.proposals.map((proposal, proposalIndex) => {
    const edge = scoreEdge(proposal, source, tagIndex, `source_groups[${index}].proposals[${proposalIndex}]`);
    if (targetIds.has(edge.canonical_tag_id)) fail(`duplicate target edge in group ${JSON.stringify(identity)}`);
    targetIds.add(edge.canonical_tag_id); return edge;
  });
  const fanout = edges.length; const groupMin = Math.min(...edges.map((edge) => edge.confidence));
  const status = fanout > 3 ? REVIEW_STATUS.HUMAN : candidateStatus(groupMin);
  for (const edge of edges) {
    edge.review_status = status;
    if (fanout > 3) edge.confidence_caps.push({ code: "FANOUT_GT_3_FORCE_HUMAN", max_confidence: null });
  }
  return { ...base, edges, fanout, group_min_confidence: groupMin, group_status: status, unmapped_reason: null };
}
function mappedCandidate(group, edge) {
  return { source_scope: group.channel_app_id, channel_app_id: group.channel_app_id, raw_language_scope: group.raw_language_scope, ...tokenEvidence(group.exact_raw_token), group_identity: group.group_identity, frequency: group.frequency, occurrence_count: group.occurrence_count, carrier_book_ids: group.carrier_book_ids, sample_count: group.samples.length, evaluation_sample_count: group.evaluation_sample_count, representative_samples: group.samples.slice(0, 12), fanout: group.fanout, group_min_confidence: group.group_min_confidence, group_status: group.group_status, ...edge };
}
function unmappedEntry(group) {
  const reviewStatus = group.unmapped_reason === "CANONICAL_GAP"
    ? REVIEW_STATUS.GAP
    : group.unmapped_reason === "SEMANTIC_UNCERTAIN"
      ? REVIEW_STATUS.HUMAN
      : group.unmapped_reason;
  return { group_identity: group.group_identity, source_scope: group.channel_app_id, channel_app_id: group.channel_app_id, raw_language_scope: group.raw_language_scope, ...tokenEvidence(group.exact_raw_token), frequency: group.frequency, occurrence_count: group.occurrence_count, carrier_book_ids: group.carrier_book_ids, sample_count: group.samples.length, evaluation_sample_count: group.evaluation_sample_count, representative_samples: group.samples.slice(0, 12), unmapped_reason: group.unmapped_reason, review_status: reviewStatus };
}
function pairEvidence(left, right) {
  if (left.channel_app_id !== right.channel_app_id || left.raw_language_scope !== right.raw_language_scope) {
    return {
      evidence_scope_status: "NOT_APPLICABLE_CROSS_LANGUAGE_SCOPE",
      shared_sample_books: null,
      sample_jaccard: null,
      left_to_right_cooccurrence_rate: null,
      right_to_left_cooccurrence_rate: null,
    };
  }
  const leftIds = new Set(left.carrier_book_ids);
  const rightIds = new Set(right.carrier_book_ids);
  const common = [...leftIds].filter((id) => rightIds.has(id)).length;
  const union = new Set([...leftIds, ...rightIds]).size;
  return {
    evidence_scope_status: "SAME_SOURCE_LANGUAGE_SCOPE",
    shared_sample_books: common,
    sample_jaccard: union === 0 ? 0 : Number((common / union).toFixed(4)),
    left_to_right_cooccurrence_rate: left.cooccurrence.find((item) => item.exact_raw_token === right.exact_raw_token)?.rate ?? 0,
    right_to_left_cooccurrence_rate: right.cooccurrence.find((item) => item.exact_raw_token === left.exact_raw_token)?.rate ?? 0,
  };
}

function validateOfflineSemanticClusters(candidates, groups, tags) {
  if (candidates === undefined) return [];
  if (!Array.isArray(candidates)) fail("semantic_cluster_candidates must be an array");
  const groupsById = new Map(groups.map((group) => [group.group_identity, group]));
  const clusterIds = new Set();
  return candidates.map((raw, clusterIndex) => {
    const path = `semantic_cluster_candidates[${clusterIndex}]`;
    const candidate = object(raw, path);
    rejectUnknownKeys(candidate, [
      "cluster_id", "canonical_tag_id", "recommendation", "confidence",
      "review_status", "reason", "risk", "members",
    ], path);
    const clusterId = text(candidate.cluster_id, `${path}.cluster_id`);
    if (clusterIds.has(clusterId)) fail(`${path}.cluster_id must be unique`);
    clusterIds.add(clusterId);
    const recommendation = text(candidate.recommendation, `${path}.recommendation`);
    if (!SEMANTIC_CLUSTER_RECOMMENDATIONS.has(recommendation)) fail(`${path}.recommendation is invalid`);
    if (!QUARTER_VALUES.has(candidate.confidence)) fail(`${path}.confidence must be one of 0, 0.25, 0.5, 0.75, 1`);
    const reviewStatus = text(candidate.review_status, `${path}.review_status`);
    if (!SEMANTIC_CLUSTER_REVIEW_STATUSES.has(reviewStatus)) fail(`${path}.review_status is invalid`);
    const expectedReviewStatus = candidateStatus(candidate.confidence);
    if (reviewStatus !== expectedReviewStatus) fail(`${path}.review_status must match confidence threshold ${expectedReviewStatus}`);
    const reason = decisionText(candidate.reason, `${path}.reason`);
    const risk = decisionText(candidate.risk, `${path}.risk`);
    if (!Array.isArray(candidate.members) || candidate.members.length < 2) fail(`${path}.members must contain at least two source groups`);
    const memberIds = candidate.members.map((rawMember, memberIndex) => {
      const member = object(rawMember, `${path}.members[${memberIndex}]`);
      rejectUnknownKeys(member, ["group_identity", "channel_app_id", "raw_language_scope", "exact_raw_token"], `${path}.members[${memberIndex}]`);
      const groupIdentity = text(member.group_identity, `${path}.members[${memberIndex}].group_identity`);
      const group = groupsById.get(groupIdentity);
      if (!group) fail(`${path}.members[${memberIndex}].group_identity is not a source-group FK`);
      for (const [key, expected] of [
        ["channel_app_id", group.channel_app_id],
        ["raw_language_scope", group.raw_language_scope],
        ["exact_raw_token", group.exact_raw_token],
      ]) {
        if (Object.hasOwn(member, key) && member[key] !== expected) fail(`${path}.members[${memberIndex}].${key} conflicts with source-group FK`);
      }
      return groupIdentity;
    });
    if (new Set(memberIds).size !== memberIds.length) fail(`${path}.members contains duplicate source-group FKs`);
    const canonicalTagId = candidate.canonical_tag_id === null || candidate.canonical_tag_id === undefined
      ? null
      : text(candidate.canonical_tag_id, `${path}.canonical_tag_id`);
    if (canonicalTagId !== null) {
      const canonicalTag = tags.find(({ canonical_tag_id: id }) => id === canonicalTagId);
      if (!canonicalTag || canonicalTag.status === "deprecated") fail(`${path}.canonical_tag_id must reference a non-deprecated CanonicalTag v1 id`);
    }
    return {
      cluster_id: clusterId,
      cluster_origin: "OFFLINE_SEMANTIC_CANDIDATE",
      canonical_tag_id: canonicalTagId,
      recommendation,
      confidence: Number(candidate.confidence.toFixed(4)),
      review_status: reviewStatus,
      reason,
      risk,
      members: memberIds.map((groupIdentity) => {
        const group = groupsById.get(groupIdentity);
        return {
          group_identity: group.group_identity,
          source_scope: group.channel_app_id,
          channel_app_id: group.channel_app_id,
          raw_language_scope: group.raw_language_scope,
          ...tokenEvidence(group.exact_raw_token),
          frequency: group.frequency,
          mapped: group.edges.length > 0,
          unmapped_reason: group.unmapped_reason,
          representative_samples: group.samples.slice(0, 3),
          cooccurrence: group.cooccurrence,
        };
      }),
    };
  });
}

function semanticOutputs(groups, offlineCandidates = []) {
  const byTag = new Map();
  for (const group of groups) for (const edge of group.edges) {
    if (!byTag.has(edge.canonical_tag_id)) byTag.set(edge.canonical_tag_id, []);
    byTag.get(edge.canonical_tag_id).push({ group, edge });
  }
  const semantic_clusters = []; const semantic_pairs = [];
  for (const [canonicalTagId, entries] of byTag) {
    if (entries.length < 2) continue;
    const sharedConfidence = Math.min(...entries.map(({ edge }) => edge.confidence));
    const sharedStatus = entries.some(({ group }) => group.group_status === REVIEW_STATUS.HUMAN)
      ? REVIEW_STATUS.HUMAN
      : entries.some(({ group }) => group.group_status === REVIEW_STATUS.RECOMMENDED)
        ? REVIEW_STATUS.RECOMMENDED
        : REVIEW_STATUS.HIGH;
    const reviewClosed = sharedStatus !== REVIEW_STATUS.HIGH && entries
      .filter(({ group }) => group.group_status !== REVIEW_STATUS.HIGH)
      .every(({ group }) => group.review_closed === true);
    const needsHumanReview = sharedStatus !== REVIEW_STATUS.HIGH && !reviewClosed;
    semantic_clusters.push({
      cluster_id: `mapped:${canonicalTagId}`,
      cluster_origin: "SHARED_CANONICAL_MAPPING",
      canonical_tag_id: canonicalTagId,
      members: entries.map(({ group, edge }) => ({ group_identity: group.group_identity, source_scope: group.channel_app_id, channel_app_id: group.channel_app_id, raw_language_scope: group.raw_language_scope, ...tokenEvidence(group.exact_raw_token), frequency: group.frequency, representative_samples: group.samples.slice(0, 3), cooccurrence: group.cooccurrence, confidence: edge.confidence, mapped: true, unmapped_reason: null })),
      confidence: sharedConfidence,
      recommendation: "SAME_CANONICAL_TAG",
      review_status: sharedStatus,
      review_closed: reviewClosed,
      reason: "Members independently map to the same CanonicalTag candidate.",
      risk: "Shared mapping does not itself prove source tokens are exact synonyms.",
      recommend_same_canonical_tag: true,
      needs_human_review: needsHumanReview,
    });
    for (let i = 0; i < entries.length; i += 1) for (let j = i + 1; j < entries.length; j += 1) {
      const [left, right] = [entries[i].group, entries[j].group];
      semantic_pairs.push({ cluster_id: `mapped:${canonicalTagId}`, cluster_origin: "SHARED_CANONICAL_MAPPING", canonical_tag_id: canonicalTagId, left_group_identity: left.group_identity, left_source_scope: left.channel_app_id, left_raw_language_scope: left.raw_language_scope, ...tokenEvidence(left.exact_raw_token, "left_"), right_group_identity: right.group_identity, right_source_scope: right.channel_app_id, right_raw_language_scope: right.raw_language_scope, ...tokenEvidence(right.exact_raw_token, "right_"), ...pairEvidence(left, right) });
    }
  }
  for (const cluster of offlineCandidates) {
    semantic_clusters.push(cluster);
    for (let i = 0; i < cluster.members.length; i += 1) for (let j = i + 1; j < cluster.members.length; j += 1) {
      const left = groups.find(({ group_identity: identity }) => identity === cluster.members[i].group_identity);
      const right = groups.find(({ group_identity: identity }) => identity === cluster.members[j].group_identity);
      semantic_pairs.push({ cluster_id: cluster.cluster_id, cluster_origin: cluster.cluster_origin, canonical_tag_id: cluster.canonical_tag_id, left_group_identity: left.group_identity, left_source_scope: left.channel_app_id, left_raw_language_scope: left.raw_language_scope, ...tokenEvidence(left.exact_raw_token, "left_"), right_group_identity: right.group_identity, right_source_scope: right.channel_app_id, right_raw_language_scope: right.raw_language_scope, ...tokenEvidence(right.exact_raw_token, "right_"), ...pairEvidence(left, right) });
    }
  }
  return { semantic_clusters, semantic_pairs };
}
function groupSummary(groups, finalSampleBookIds) {
  const total = groups.length; const mapped = groups.filter((group) => group.edges.length > 0);
  const count = (status) => groups.filter((group) => group.group_status === status).length;
  const bookTokens = new Map(finalSampleBookIds.map((bookId) => [bookId, []]));
  for (const group of groups) for (const bookId of group.carrier_book_ids) {
    const bookGroups = bookTokens.get(bookId);
    if (bookGroups === undefined) fail(`carrier book ${JSON.stringify(bookId)} is outside final_sample_book_ids`);
    bookGroups.push(group);
  }
  const books = [...bookTokens.values()];
  const strictBooks = books.filter((bookGroups) => bookGroups.length > 0 && bookGroups.every((group) => group.edges.length > 0)).length;
  const atLeastOneBooks = books.filter((bookGroups) => bookGroups.some((group) => group.edges.length > 0)).length;
  const occurrences = groups.reduce((sum, group) => sum + group.occurrence_count, 0);
  const mappedOccurrences = mapped.reduce((sum, group) => sum + group.occurrence_count, 0);
  const ratio = (numerator, denominator) => Number((denominator === 0 ? 0 : numerator / denominator).toFixed(4));
  return { TOTAL_SOURCE_TOKENS: total, HIGH_CONFIDENCE_MAPPING: count(REVIEW_STATUS.HIGH), REVIEW_RECOMMENDED: count(REVIEW_STATUS.RECOMMENDED), HUMAN_REVIEW_REQUIRED: count(REVIEW_STATUS.HUMAN), REVIEW_CLOSED_OFFLINE: groups.filter((group) => group.review_closed === true).length, CANONICAL_GAP: groups.filter((group) => group.unmapped_reason === "CANONICAL_GAP").length, UNMAPPED_RATE: ratio(total - mapped.length, total), MAPPING_COVERAGE_BY_BOOK: ratio(strictBooks, books.length), BOOK_COVERAGE_ALL_TOKENS_STRICT: ratio(strictBooks, books.length), BOOK_COVERAGE_AT_LEAST_ONE_TOKEN: ratio(atLeastOneBooks, books.length), MAPPING_COVERAGE_BY_OCCURRENCE: ratio(mappedOccurrences, occurrences), MAPPING_COVERAGE_BY_TOKEN: ratio(mapped.length, total) };
}
function humanPackage(groups, semanticClusters = []) {
  const groupItems = groups.filter((group) => group.review_closed !== true && (
    group.group_status === REVIEW_STATUS.RECOMMENDED
    || group.group_status === REVIEW_STATUS.HUMAN
    || group.unmapped_reason === "CANONICAL_GAP"
    || group.unmapped_reason === "SEMANTIC_UNCERTAIN"
    || group.fanout > 3
  )).map((group) => ({ review_item_type: "SOURCE_GROUP", review_item_id: group.group_identity, group_identity: group.group_identity, channel_app_id: group.channel_app_id, raw_language_scope: group.raw_language_scope, ...tokenEvidence(group.exact_raw_token), frequency: group.frequency, occurrence_count: group.occurrence_count, carrier_book_ids: group.carrier_book_ids, group_status: group.group_status, unmapped_reason: group.unmapped_reason, fanout: group.fanout, force_human_review: group.fanout > 3, group_min_confidence: group.group_min_confidence, representative_samples: group.samples.slice(0, 12), edges: group.edges }));
  const clusterItems = semanticClusters.filter((cluster) => cluster.review_closed !== true && (
    cluster.review_status === REVIEW_STATUS.RECOMMENDED || cluster.review_status === REVIEW_STATUS.HUMAN
  )).map((cluster) => ({
    review_item_type: "SEMANTIC_CLUSTER",
    review_item_id: cluster.cluster_id,
    cluster_id: cluster.cluster_id,
    cluster_origin: cluster.cluster_origin,
    canonical_tag_id: cluster.canonical_tag_id,
    recommendation: cluster.recommendation,
    confidence: cluster.confidence,
    review_status: cluster.review_status,
    reason: cluster.reason,
    risk: cluster.risk,
    members: cluster.members,
  }));
  return [...groupItems, ...clusterItems];
}

function fanoutRows(groups) {
  return groups.filter((group) => group.fanout > 0).map((group) => ({
    group_identity: group.group_identity, source_scope: group.channel_app_id, channel_app_id: group.channel_app_id,
    raw_language_scope: group.raw_language_scope, ...tokenEvidence(group.exact_raw_token), frequency: group.frequency,
    occurrence_count: group.occurrence_count, fanout: group.fanout, targets: group.edges.map((edge) => ({ canonical_tag_id: edge.canonical_tag_id, locale: edge.locale })),
    group_status: group.group_status, force_human_review: group.fanout > 3,
  }));
}

function summaryWithDeliveryStatus(summary, groups, semanticClusters = []) {
  const reviewPending = humanPackage(groups, semanticClusters);
  return {
    ...summary,
    LANE_B_MAPPING_STATUS: reviewPending.length ? "PARTIAL_REVIEW_PENDING" : "COMPLETE_CANDIDATES_GENERATED",
    OWNER_REVIEW_ITEMS: new Set(reviewPending.map((item) => `${item.review_item_type}:${item.review_item_id}`)).size,
  };
}

/** Build candidates only after CanonicalTag bytes have passed SHA-256 verification. */
export function prepareMappingReview({
  artifact,
  expectedSha256,
  actualSha256,
  authoritative_source_groups,
  reviewed_source_groups,
  final_sample_book_ids,
  raw_manifest_sha256,
  semantic_cluster_candidates,
} = {}) {
  const canonical = validateCanonicalTagArtifact({ artifact, expectedSha256, actualSha256 });
  const finalSampleBookIds = validateFinalSampleBookIds(final_sample_book_ids);
  const rawManifestSha256 = hash(raw_manifest_sha256, "raw_manifest_sha256");
  const sourceGroups = bindReviewedSourceGroups(authoritative_source_groups, reviewed_source_groups);
  const sourceEvidenceSha256 = sourceEvidenceDigest({
    source_groups: authoritative_source_groups,
    final_sample_book_ids: finalSampleBookIds,
    raw_manifest_sha256: rawManifestSha256,
  });
  const seen = new Set();
  const groups = sourceGroups.map((raw, index) => {
    const group = groupFromSource(validateGroup(raw, index), index, canonical.tags);
    if (seen.has(group.group_identity)) fail(`duplicate exact mapping group identity ${JSON.stringify(group.group_identity)}`);
    seen.add(group.group_identity); return group;
  });
  const mapping_candidates = groups.flatMap((group) => group.edges.map((edge) => mappedCandidate(group, edge)));
  const unmapped = groups.filter((group) => group.edges.length === 0).map(unmappedEntry);
  const offlineSemanticClusters = validateOfflineSemanticClusters(semantic_cluster_candidates, groups, canonical.tags);
  const semantic = semanticOutputs(groups, offlineSemanticClusters);
  const semanticClusterCandidatesSha256 = sha256CanonicalPayload({
    schema: "LANE_B_SEMANTIC_CLUSTER_CANDIDATES_V1",
    clusters: offlineSemanticClusters,
  });
  const result = {
    canonical_version: canonical.canonical_version,
    canonical_sha256: canonical.canonical_sha256,
    raw_manifest_sha256: rawManifestSha256,
    source_evidence_sha256: sourceEvidenceSha256,
    semantic_cluster_candidates_sha256: semanticClusterCandidatesSha256,
    final_sample_book_ids: finalSampleBookIds,
    score_weights: { ...SCORE_WEIGHTS },
    groups,
    mapping_candidates,
    unmapped,
    fanout: fanoutRows(groups),
    offline_semantic_cluster_candidates: offlineSemanticClusters,
    ...semantic,
    summary: summaryWithDeliveryStatus(groupSummary(groups, finalSampleBookIds), groups, semantic.semantic_clusters),
  };
  return { ...result, review_template: createReviewTemplate(result), human_review_package: humanPackage(groups, semantic.semantic_clusters) };
}

/** Explicit second-blind-review form. High confidence groups are intentionally absent. */
export function createReviewTemplate(result) {
  object(result, "prepared B2 result");
  return result.groups.filter((group) => group.review_closed !== true && group.group_status === REVIEW_STATUS.RECOMMENDED).map((group) => ({ canonical_version: result.canonical_version, canonical_sha256: result.canonical_sha256, group_identity: group.group_identity, review_round: 2, current_group_status: group.group_status, decision: "PENDING", reviewer: "", rationale: "", blind_evidence_reference: "" }));
}

/** Consume only second-blind-review records; this never creates edges or auto-approves taxonomy. */
export function finalizeMappingCandidates({ prepared, blind_review_records = [] } = {}) {
  object(prepared, "prepared B2 result");
  if (!Array.isArray(blind_review_records)) fail("blind_review_records must be an array");
  const groups = prepared.groups.map((group) => ({ ...group, edges: group.edges.map((edge) => ({ ...edge })) }));
  const byId = new Map(groups.map((group) => [group.group_identity, group])); const seen = new Set();
  for (const [index, raw] of blind_review_records.entries()) {
    const record = object(raw, `blind_review_records[${index}]`);
    if (record.canonical_version !== prepared.canonical_version || record.canonical_sha256 !== prepared.canonical_sha256) fail(`blind_review_records[${index}] is bound to a different CanonicalTag artifact`);
    if (record.review_round !== 2) fail(`blind_review_records[${index}].review_round must equal 2`);
    const id = text(record.group_identity, `blind_review_records[${index}].group_identity`);
    const group = byId.get(id);
    if (!group || group.group_status !== REVIEW_STATUS.RECOMMENDED) fail(`blind_review_records[${index}] may only resolve an existing REVIEW_RECOMMENDED group`);
    if (seen.has(id)) fail(`duplicate blind review for ${JSON.stringify(id)}`); seen.add(id);
    const decision = record.decision;
    if (!new Set(["CLOSE_RECOMMENDED", "ESCALATE_HUMAN"]).has(decision)) fail(`blind_review_records[${index}].decision must be CLOSE_RECOMMENDED or ESCALATE_HUMAN`);
    const review = { review_round: 2, decision, reviewer: text(record.reviewer, `blind_review_records[${index}].reviewer`), rationale: text(record.rationale, `blind_review_records[${index}].rationale`), blind_evidence_reference: text(record.blind_evidence_reference, `blind_review_records[${index}].blind_evidence_reference`) };
    group.blind_review = review;
    group.review_closed = decision === "CLOSE_RECOMMENDED";
    group.group_status = decision === "CLOSE_RECOMMENDED" ? REVIEW_STATUS.RECOMMENDED : REVIEW_STATUS.HUMAN;
    group.edges.forEach((edge) => {
      edge.review_status = group.group_status;
      edge.review_closed = group.review_closed;
      edge.blind_review = review;
    });
  }
  const mapping_candidates = groups.flatMap((group) => group.edges.map((edge) => mappedCandidate(group, edge)));
  const unmapped = groups.filter((group) => group.edges.length === 0).map(unmappedEntry);
  const offlineSemanticClusters = (prepared.offline_semantic_cluster_candidates ?? []).map((cluster) => ({
    ...cluster,
    members: cluster.members.map((member) => {
      const group = byId.get(member.group_identity);
      return {
        ...member,
        mapped: group.edges.length > 0,
        unmapped_reason: group.unmapped_reason,
        confidence: group.edges.length > 0 ? Math.min(...group.edges.map((edge) => edge.confidence)) : undefined,
      };
    }),
  }));
  const semantic = semanticOutputs(groups, offlineSemanticClusters);
  const result = { ...prepared, groups, mapping_candidates, unmapped, fanout: fanoutRows(groups), offline_semantic_cluster_candidates: offlineSemanticClusters, ...semantic, summary: summaryWithDeliveryStatus(groupSummary(groups, prepared.final_sample_book_ids), groups, semantic.semantic_clusters) };
  return { ...result, review_template: createReviewTemplate(result), human_review_package: humanPackage(groups, semantic.semantic_clusters) };
}

function csvEscape(value) { const source = typeof value === "string" ? value : JSON.stringify(value ?? ""); return /[",\n\r]/.test(source) ? `"${source.replaceAll('"', '""')}"` : source; }
function csv(rows, headers) {
  const body = rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","));
  return `${[headers.join(","), ...body].join("\n")}\n`;
}
export const B2_CSV_HEADERS = Object.freeze({
  "mapping-candidates.csv": Object.freeze([
    "source_scope", "channel_app_id", "raw_language_scope", "exact_raw_token", "exact_raw_token_utf8_base64",
    "exact_raw_token_sha256", "group_identity", "frequency", "occurrence_count", "carrier_book_ids", "sample_count",
    "evaluation_sample_count", "representative_samples", "fanout", "group_min_confidence", "group_status",
    "canonical_tag_id", "canonical_slug", "canonical_display_name", "locale", "scores", "confidence", "reason", "risk",
    "evidence_flags", "confidence_caps", "review_status", "review_closed", "blind_review",
  ]),
  "unmapped-source-tokens.csv": Object.freeze([
    "group_identity", "source_scope", "channel_app_id", "raw_language_scope", "exact_raw_token",
    "exact_raw_token_utf8_base64", "exact_raw_token_sha256", "frequency", "occurrence_count", "carrier_book_ids",
    "sample_count", "evaluation_sample_count", "representative_samples", "unmapped_reason", "review_status",
  ]),
  "source-token-semantic-clusters.csv": Object.freeze([
    "cluster_id", "cluster_origin", "canonical_tag_id", "cluster_confidence", "recommendation",
    "recommend_same_canonical_tag", "review_status", "review_closed", "needs_human_review", "reason", "risk", "group_identity",
    "source_scope", "channel_app_id", "raw_language_scope", "exact_raw_token", "exact_raw_token_utf8_base64",
    "exact_raw_token_sha256", "frequency", "mapped", "unmapped_reason", "member_confidence", "representative_samples", "cooccurrence",
  ]),
  "source-token-semantic-cluster-pairs.csv": Object.freeze([
    "cluster_id", "cluster_origin", "canonical_tag_id", "left_group_identity", "left_source_scope",
    "left_raw_language_scope", "left_exact_raw_token", "left_exact_raw_token_utf8_base64", "left_exact_raw_token_sha256",
    "right_group_identity", "right_source_scope", "right_raw_language_scope", "right_exact_raw_token",
    "right_exact_raw_token_utf8_base64", "right_exact_raw_token_sha256", "evidence_scope_status", "shared_sample_books",
    "sample_jaccard", "left_to_right_cooccurrence_rate", "right_to_left_cooccurrence_rate",
  ]),
  "source-token-fanout-risk.csv": Object.freeze([
    "group_identity", "source_scope", "channel_app_id", "raw_language_scope", "exact_raw_token",
    "exact_raw_token_utf8_base64", "exact_raw_token_sha256", "frequency", "occurrence_count", "fanout", "targets",
    "group_status", "force_human_review",
  ]),
});
function jsonl(rows) { return `${rows.map((row) => JSON.stringify(row)).join("\n")}${rows.length ? "\n" : ""}`; }
function file(name, content) { const bytes = Buffer.from(content, "utf8"); return { name, encoding: "utf8", sha256: sha256Bytes(bytes), bytes_base64: bytes.toString("base64"), content }; }
/** Bundle every B2 deliverable as exact UTF-8 CSV/JSONL, base64 bytes, and SHA-256. */
export function buildB2ArtifactBundle(result) {
  object(result, "final B2 result");
  const clusterRows = result.semantic_clusters.flatMap((cluster) => cluster.members.map((member) => ({
    cluster_id: cluster.cluster_id,
    cluster_origin: cluster.cluster_origin,
    canonical_tag_id: cluster.canonical_tag_id,
    cluster_confidence: cluster.confidence,
    recommendation: cluster.recommendation,
    recommend_same_canonical_tag: cluster.recommend_same_canonical_tag ?? cluster.recommendation === "SAME_CANONICAL_TAG",
    review_status: cluster.review_status,
    review_closed: cluster.review_closed === true,
    needs_human_review: cluster.needs_human_review ?? cluster.review_status === REVIEW_STATUS.HUMAN,
    reason: cluster.reason,
    risk: cluster.risk,
    ...member,
    member_confidence: member.confidence ?? null,
  })));
  const files = [
    file("mapping-candidates.csv", csv(result.mapping_candidates, B2_CSV_HEADERS["mapping-candidates.csv"])),
    file("unmapped-source-tokens.csv", csv(result.unmapped, B2_CSV_HEADERS["unmapped-source-tokens.csv"])),
    file("source-token-semantic-clusters.csv", csv(clusterRows, B2_CSV_HEADERS["source-token-semantic-clusters.csv"])),
    file("source-token-semantic-cluster-pairs.csv", csv(result.semantic_pairs, B2_CSV_HEADERS["source-token-semantic-cluster-pairs.csv"])),
    file("source-token-fanout-risk.csv", csv(result.fanout, B2_CSV_HEADERS["source-token-fanout-risk.csv"])),
    file("human-review-package.jsonl", jsonl(result.human_review_package)),
    file("lane-b-summary.json", `${JSON.stringify(result.summary, null, 2)}\n`),
    file("review-template.jsonl", jsonl(result.review_template)),
    file("authoritative-mapping-candidates.jsonl", jsonl(result.mapping_candidates)),
  ];
  const manifest = {
    canonical_version: result.canonical_version,
    canonical_sha256: result.canonical_sha256,
    raw_manifest_sha256: result.raw_manifest_sha256,
    source_evidence_sha256: result.source_evidence_sha256,
    semantic_cluster_candidates_sha256: result.semantic_cluster_candidates_sha256,
    final_sample_book_count: result.final_sample_book_ids.length,
    files: files.map(({ name, encoding, sha256, bytes_base64 }) => ({ name, encoding, sha256, bytes_base64 })),
  };
  return { manifest, files };
}

// Compatibility alias for callers that already constructed a byte-verified input.
export function buildB2MappingCandidates(input) { return prepareMappingReview(input); }
