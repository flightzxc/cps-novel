import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { loadAndAnalyzeLaneBRun } from "../p2-06-5-lane-b/artifacts.mjs";
import { verifyB2FinalBundle } from "../p2-06-5-lane-b/b2-final.mjs";
import { verifyOwnerTimingWaiver } from "../p2-06-5-lane-b/owner-waiver.mjs";
import { parseCsv } from "../p2-06-5-lane-a/owner-final.mjs";
import {
  C1_V3_CONFIGURATION,
  C1_V3_MAX_TEXT_TAGS,
  buildArtifactBundle,
  buildAuditQueue,
  scoreCalibration,
  verifyArtifactBundle,
  writeArtifactBundle,
} from "./calibration.mjs";
import { compareC1V3 } from "./c1-v3-compare.mjs";
import {
  POST_FIX_POPULATION_SAMPLE_TARGET,
  POST_FIX_RISK_CELLS,
  POST_FIX_RISK_SAMPLE_TARGET,
  buildDescriptionOnlyBlindReview,
} from "./description-only-blind-review.mjs";
import { loadLexiconOverride, normalizeSeed, overlayRuleKey } from "./lexicon-eligibility.mjs";

export const EXPECTED_CANONICAL_COUNT = 123;
export const EXPECTED_SAMPLE_COUNT = 10_000;
export const EXPECTED_CANONICAL_SHA256 = "8bc8cdae8be2176bde170173e98bad2b9fa0e1770818174a57320816eefdccad";
export const EXPECTED_C1_INPUT_SHA256 = "046fe9234b317eba145c3fbb35edd2e72af49e41309dcd5d5f45f7bc43d1776d";
export const C1_V3_GENERATED_AT = "2026-08-16T23:30:00+09:00";
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LATIN = /\p{Script=Latin}/u;
const LETTER = /\p{L}/u;

function fail(message) { throw new Error(`P2-06.5 Lane C1 Owner Final: ${message}`); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function stableTuple(values) { return JSON.stringify(values); }
function jsonl(rows) { return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""); }

function classifyScript(value) {
  let cjk = 0; let latin = 0; let other = 0;
  for (const character of value.normalize("NFC")) {
    if (CJK.test(character)) cjk += 1;
    else if (LATIN.test(character)) latin += 1;
    else if (LETTER.test(character)) other += 1;
  }
  if (cjk === 0 && latin === 0 && other === 0) return "unknown";
  if (cjk >= latin && cjk >= other) return "cjk";
  if (latin >= other) return "latin";
  return "other";
}

function seedScript(value) {
  let hasCjk = false; let hasLatin = false; let hasOther = false;
  for (const character of value.normalize("NFC")) {
    if (CJK.test(character)) hasCjk = true;
    else if (LATIN.test(character)) hasLatin = true;
    else if (LETTER.test(character)) hasOther = true;
  }
  if (hasCjk && !hasLatin && !hasOther) return "cjk";
  if (hasLatin && !hasCjk && !hasOther) return "latin";
  return "other";
}

export function buildLexicon(canonical, overlay = null) {
  if (canonical.artifact_status !== "FINAL" || canonical.count !== EXPECTED_CANONICAL_COUNT || canonical.tags?.length !== EXPECTED_CANONICAL_COUNT) fail("CanonicalTag v1 must be Final 123");
  const occurrences = new Map();
  for (const tag of canonical.tags) {
    for (const seed of tag.keyword_seeds) {
      const key = normalizeSeed(seed);
      const tagIds = occurrences.get(key) ?? new Set();
      tagIds.add(tag.stable_id); occurrences.set(key, tagIds);
    }
  }
  const conflicts = new Set([...occurrences].filter(([, ids]) => ids.size > 1).map(([key]) => key));
  const disabled = [];
  const restricted = [];
  const overlayByKey = overlay?.byKey ?? new Map();
  const canonicalTags = canonical.tags.map((tag) => {
    const seen = new Set();
    const keywords = [];
    for (const seed of tag.keyword_seeds) {
      const normalized = normalizeSeed(seed);
      const script = seedScript(seed);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      if (conflicts.has(normalized) || script === "other") {
        disabled.push({ canonicalTagId: tag.stable_id, seed, normalizedSeed: normalized, reason: conflicts.has(normalized) ? "CROSS_TAG_SEED_COLLISION" : "KEYWORD_COVERAGE_INSUFFICIENT_OTHER_SCRIPT" });
        continue;
      }
      const rule = overlayByKey.get(overlayRuleKey(tag.stable_id, normalized));
      if (rule && rule.enabled === false) {
        disabled.push({
          canonicalTagId: tag.stable_id,
          seed,
          normalizedSeed: normalized,
          reason: rule.reason,
          change_reason: rule.changeReason,
        });
        continue;
      }
      const keyword = {
        keywordId: `kw-${sha256(stableTuple([tag.stable_id, normalized])).slice(0, 24)}`,
        value: seed,
        scriptBuckets: [script],
        matchMode: script === "latin" ? "unicode_word" : "cjk_contiguous",
        sourceLanguageCodes: [],
        riskFlags: [],
      };
      if (rule) {
        if (rule.allowedFields) keyword.allowedFields = rule.allowedFields;
        if (rule.blockedDescriptionNamedScopes.length > 0) {
          keyword.blockedDescriptionNamedScopes = rule.blockedDescriptionNamedScopes;
        }
        restricted.push({
          canonicalTagId: tag.stable_id,
          seed,
          normalizedSeed: normalized,
          reason: rule.reason,
          change_reason: rule.changeReason,
          allowed_fields: rule.allowedFields,
          blocked_description_named_scopes: rule.blockedDescriptionNamedScopes,
        });
      }
      keywords.push(keyword);
    }
    return {
      canonicalTagId: tag.stable_id,
      slug: tag.slug,
      definition: tag.canonical_definition,
      textSelectionPriority: 0,
      keywordCoverageStatus: keywords.length ? "RELIABLE" : "KEYWORD_COVERAGE_INSUFFICIENT",
      keywords,
    };
  });
  const audit = {
    source: overlay
      ? "CanonicalTag v1 keyword_seeds plus keyword-eligibility-v1 overlay"
      : "CanonicalTag v1 keyword_seeds only",
    normalization_for_collision_audit_only: "NFKC+locale-independent lowercase",
    active_keyword_count: canonicalTags.reduce((sum, tag) => sum + tag.keywords.length, 0),
    coverage_insufficient_tag_count: canonicalTags.filter((tag) => tag.keywordCoverageStatus === "KEYWORD_COVERAGE_INSUFFICIENT").length,
    disabled_seed_count: disabled.length,
    disabled,
    tie_break: "ALL_PRIORITY_0_THEN_STABLE_ID",
  };
  if (overlay) {
    audit.restricted_seed_count = restricted.length;
    audit.restricted = restricted;
    audit.lexicon_override_version = overlay.version;
  }
  return {
    taxonomy: {
      taxonomyVersion: canonical.canonical_version,
      keywordLexiconVersion: overlay
        ? `${canonical.canonical_version}-owner-final-seeds-v1-eligibility-v1`
        : `${canonical.canonical_version}-owner-final-seeds-v1`,
      canonicalTags,
    },
    audit,
  };
}

function finalBooks(raw) {
  const byKey = new Map(raw.books.map((book) => [book.sampleBookKey, book]));
  const observations = new Map();
  for (const row of raw.observations) {
    const values = observations.get(row.sampleBookKey) ?? [];
    if (!values.includes(row.exactRawToken)) values.push(row.exactRawToken);
    observations.set(row.sampleBookKey, values);
  }
  const selection = [...raw.finalSelection].sort((left, right) => left.selectedSampleIndex - right.selectedSampleIndex);
  if (selection.length !== EXPECTED_SAMPLE_COUNT) fail("final sample is not 10k");
  return selection.map((selected, index) => {
    const book = byKey.get(selected.sampleBookKey);
    if (!book) fail(`selected book is absent from raw facts at ${index + 1}`);
    return { book, tokens: observations.get(selected.sampleBookKey) ?? [], selectedSampleIndex: index + 1 };
  });
}

function buildSourceMapping(mappingRows, canonicalById) {
  const edges = mappingRows.filter((row) => row.record_type === "MAPPING_EDGE");
  const byGroup = new Map();
  for (const row of edges) {
    if (!canonicalById.has(row.canonical_stable_id)) fail(`B2 edge target is absent from CanonicalTag v1: ${row.canonical_stable_id}`);
    const key = stableTuple([row.channel_app_id, row.raw_language_scope, row.exact_raw_token]);
    const group = byGroup.get(key) ?? { channelAppId: row.channel_app_id, rawLanguageScope: row.raw_language_scope, sourceLabelKind: "series_type", externalLabelValue: row.exact_raw_token, canonicalTagIds: [], evidenceMappingKey: row.mapping_key };
    if (!group.canonicalTagIds.includes(row.canonical_stable_id)) group.canonicalTagIds.push(row.canonical_stable_id);
    byGroup.set(key, group);
  }
  const mappings = [...byGroup.values()].map((row) => ({ ...row, canonicalTagIds: row.canonicalTagIds.sort() })).sort((left, right) => stableTuple([left.rawLanguageScope, left.externalLabelValue]).localeCompare(stableTuple([right.rawLanguageScope, right.externalLabelValue])));
  if (mappings.length !== 194 || edges.length !== 196) fail(`B2 source mapping must be 194 groups / 196 executable edges, got ${mappings.length}/${edges.length}`);
  const exactScoped = new Map(mappings.map((mapping) => [stableTuple([mapping.channelAppId, mapping.rawLanguageScope, mapping.externalLabelValue]), mapping]));
  return {
    mapping: { mappingVersion: "p2-06-5-b2-owner-final-2026-08-16", approvalStatus: "APPROVED_OFFLINE_CANDIDATE_ONLY", mappings, mutuallyExclusivePairs: [] },
    exactScoped,
  };
}

function sourceLanguageCode(value) { return stableTuple([typeof value, value]); }
function rawScopeLocaleStatus(book) {
  return book.languageJsonValue === 19 || book.languageJsonValue === 20
    ? { resolvedLocale: null, localeStatisticsStatus: "BLOCKED_RAW_SCOPE_ONLY" }
    : { resolvedLocale: null, localeStatisticsStatus: "RAW_SCOPE_ONLY" };
}

function buildSamples(rows, rawManifestSha256, sourceMapping, canonicalById) {
  const materializedInput = [];
  const samples = rows.map(({ book, tokens, selectedSampleIndex }) => {
    const sampleRowId = `c1-${String(selectedSampleIndex).padStart(5, "0")}`;
    const mappedSourceTags = tokens.flatMap((token) => {
      const mapping = sourceMapping.exactScoped.get(stableTuple([book.channelAppId, book.rawLanguageScope, token]));
      if (!mapping) return [];
      return mapping.canonicalTagIds.map((canonicalStableId) => {
        const canonical = canonicalById.get(canonicalStableId);
        if (!canonical) fail(`materialized C1 input references unknown CanonicalTag ${canonicalStableId}`);
        return {
          canonical_stable_id: canonicalStableId,
          canonical_slug: canonical.slug,
          mapping_key: mapping.evidenceMappingKey,
          exact_raw_token: token,
        };
      });
    }).sort((left, right) => stableTuple([left.canonical_stable_id, left.mapping_key, left.exact_raw_token]).localeCompare(stableTuple([right.canonical_stable_id, right.mapping_key, right.exact_raw_token])));
    const locale = rawScopeLocaleStatus(book);
    const scriptBucket = classifyScript(`${book.titleRaw}\n${book.descriptionRaw}`);
    materializedInput.push({
      novel_identity: book.sampleBookKey,
      channel_app_id: book.channelAppId,
      raw_language_scope: book.rawLanguageScope,
      resolved_locale: locale.resolvedLocale,
      locale_statistics_status: locale.localeStatisticsStatus,
      script_bucket: scriptBucket,
      title: book.titleRaw,
      description: book.descriptionRaw,
      raw_series_types: tokens,
      mapped_source_tags: mappedSourceTags,
      source_observed_at: book.fetchedAt,
    });
    return {
      sampleRowId,
      novelIdentity: book.sampleBookKey,
      channelAppId: book.channelAppId,
      rawLanguageScope: book.rawLanguageScope,
      resolvedLocale: locale.resolvedLocale,
      localeStatisticsStatus: locale.localeStatisticsStatus,
      sourceLanguageCode: sourceLanguageCode(book.languageJsonValue),
      sourceLanguageName: typeof book.sourceLanguageNameRaw === "string" ? book.sourceLanguageNameRaw : stableTuple([book.sourceLanguageNameRaw]),
      sourceSnapshotId: rawManifestSha256,
      sourceObservedAt: book.fetchedAt,
      scriptBucket,
      title: book.titleRaw,
      description: book.descriptionRaw,
      seriesTypeList: tokens,
      sourceSnapshotComplete: true,
      manualSnapshotComplete: false,
      manualCanonicalTagIds: [],
    };
  });
  const qa = {
    unique_novels: new Set(samples.map(({ novelIdentity }) => novelIdentity)).size,
    unique_sample_rows: new Set(samples.map(({ sampleRowId }) => sampleRowId)).size,
    title_missing_or_empty: samples.filter(({ title }) => title.length === 0).length,
    description_missing_or_empty: samples.filter(({ description }) => description.length === 0).length,
    no_series_type: samples.filter(({ seriesTypeList }) => seriesTypeList.length === 0).length,
    raw_language_19_count: rows.filter(({ book }) => book.languageJsonValue === 19).length,
    raw_language_20_count: rows.filter(({ book }) => book.languageJsonValue === 20).length,
    locale_specific_statistics_blocked_count: samples.filter(({ localeStatisticsStatus }) => localeStatisticsStatus === "BLOCKED_RAW_SCOPE_ONLY").length,
    mapped_source_tag_rows: materializedInput.reduce((sum, row) => sum + row.mapped_source_tags.length, 0),
    novels_with_mapped_source_tags: materializedInput.filter((row) => row.mapped_source_tags.length > 0).length,
    manual_full_snapshot_count: samples.filter(({ manualSnapshotComplete }) => manualSnapshotComplete).length,
  };
  if (qa.unique_novels !== 10_000 || qa.unique_sample_rows !== 10_000 || qa.title_missing_or_empty !== 0 || qa.description_missing_or_empty !== 1 || qa.no_series_type !== 1 || qa.manual_full_snapshot_count !== 0) fail(`C1 input QA differs: ${JSON.stringify(qa)}`);
  return { samples, materializedInput, qa };
}

function verifyMaterializedInput(rows, sourceMapping) {
  for (const [index, row] of rows.entries()) {
    const rawTokens = new Set(row.raw_series_types);
    const seen = new Set();
    for (const tag of row.mapped_source_tags) {
      if (!rawTokens.has(tag.exact_raw_token)) fail(`c1-input[${index}] mapped tag token is absent from raw_series_types`);
      const mapping = sourceMapping.exactScoped.get(stableTuple([row.channel_app_id, row.raw_language_scope, tag.exact_raw_token]));
      if (!mapping || mapping.evidenceMappingKey !== tag.mapping_key || !mapping.canonicalTagIds.includes(tag.canonical_stable_id)) {
        fail(`c1-input[${index}] mapped source tag differs from the exact scoped B2 edge`);
      }
      const identity = stableTuple([tag.exact_raw_token, tag.canonical_stable_id, tag.mapping_key]);
      if (seen.has(identity)) fail(`c1-input[${index}] repeats a mapped source edge`);
      seen.add(identity);
    }
    const expected = row.raw_series_types.reduce((sum, token) => {
      const mapping = sourceMapping.exactScoped.get(stableTuple([row.channel_app_id, row.raw_language_scope, token]));
      return sum + (mapping?.canonicalTagIds.length ?? 0);
    }, 0);
    if (expected !== row.mapped_source_tags.length) fail(`c1-input[${index}] does not materialize every exact scoped B2 edge`);
  }
}

function aggregateRelations(scored) {
  const rows = [];
  for (const summary of scored.summaries) {
    const current = scored.bookDiagnostics.filter((row) => row.configId === summary.configId && row.maxTextTags === summary.maxTextTags);
    const relations = {};
    for (const row of current) relations[row.sourceTextRelation] = (relations[row.sourceTextRelation] ?? 0) + 1;
    const sourceMappedRows = current.filter((row) => row.sourceMappedTagCount > 0);
    const textSupplementRows = current.filter((row) => row.sourceMappedTagCount === 0 && row.selectedTextTagCount > 0);
    const unionRows = current.filter((row) => (row.finalTagCount ?? 0) > 0);
    rows.push({
      config_id: summary.configId,
      max_text_tags: summary.maxTextTags,
      sample_count: summary.overall.sampleCount,
      text_hit_rate: summary.overall.textHitRate,
      title_only_rate: summary.overall.titleOnlyRate,
      description_only_rate: summary.overall.descriptionOnlyRate,
      title_description_both_rate: summary.overall.bothRate,
      zero_hit_rate: summary.overall.zeroHitRate,
      average_text_tags: summary.overall.avgTextTags,
      selected_text_tag_count: summary.overall.selectedTextTagCount,
      raw_text_tag_count: summary.overall.rawTextTagCount,
      cap_truncated_books: summary.overall.capTruncatedBooks,
      cap_truncated_tags: summary.overall.capTruncatedTags,
      keyword_coverage_insufficient_count: summary.overall.keywordCoverageInsufficientCount,
      mapped_count: sourceMappedRows.length,
      text_supplement_count: textSupplementRows.length,
      union_count: unionRows.length,
      source_text_relations: relations,
    });
  }
  return rows;
}

async function atomicWriteDirectory(outputDir, files) {
  try { await lstat(outputDir); fail(`output directory already exists: ${outputDir}`); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  await mkdir(dirname(outputDir), { recursive: true });
  const staging = await mkdtemp(join(dirname(outputDir), `.${basename(outputDir)}.staging-`));
  try {
    for (const [name, content] of files) await writeFile(join(staging, name), content, { encoding: "utf8", flag: "wx" });
    await rename(staging, outputDir);
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}

function rate(value) {
  return value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(2)}%`;
}

function renderV3Report({ qa, c1InputSha256, sampleSha256, overlaySha256, comparisonRows, scored, auditQueue, v3Compare, blind, status }) {
  const row = comparisonRows[0];
  const sourceBlind = scored.sourceBlindSimulation?.[0];
  const cmp = v3Compare.comparison;
  const localeTable = v3Compare.localeRows.map((item) => `| ${item.locale} | ${item.v2_description_edges} | ${item.v3_description_edges} | ${item.removed_edges} |`).join("\n");
  const controlTable = cmp.control.map((item) => `| ${item.canonicalTagId} | ${item.v2Count} | ${item.v3Count} |`).join("\n");
  return `# P2-06.5 Lane C C1 v3 lexicon repair

## Technical summary

C1 v3 re-scored the same 10,000-book sample with a frozen parameter set (scheme C: titleWeight=30, descriptionWeight=30, chapterWeight=0, threshold=30, maxTextTags=3) after applying the keyword-eligibility-v1 overlay. CanonicalTag v1 Final was not modified. Coverage decline is the intended trade for precision.

Removing \`he\`/\`be\` zeroes description-only independent triggering for \`ct-v1-happy-ending\` and \`ct-v1-tragic-ending\` across every named scope and raw 19/20. The remaining seeds are \`圆满结局\` / \`悲剧结局\`, which had zero description hits in v2. **This is the expected outcome, not a defect.** No new ending-class translation seeds were added.

B-level chef/luna rules are marked \`LOW_EVIDENCE_LOCALE_RULE\` and key off already-named \`sourceLanguageName\` values. Language 19/20 stay \`RAW_SCOPE_ONLY\`.

## Input QA and lineage

- Unique novels/sample rows: ${qa.unique_novels}/${qa.unique_sample_rows}
- Empty title: ${qa.title_missing_or_empty}
- Empty description: ${qa.description_missing_or_empty}
- C1 input SHA-256: \`${c1InputSha256}\`
- Scorer sample SHA-256: \`${sampleSha256}\`
- Lexicon overlay SHA-256: \`${overlaySha256}\`
- Sparse text evidence rows: ${scored.evidence.length}

## Scheme C / maxTextTags=3

| hit | title-only | description-only | both | zero | avg | p50/p90/p99 | mapped | supplement | union | source-blind hit | source-blind zero |
| ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| ${rate(row.text_hit_rate)} | ${rate(row.title_only_rate)} | ${rate(row.description_only_rate)} | ${rate(row.title_description_both_rate)} | ${rate(row.zero_hit_rate)} | ${row.average_text_tags.toFixed(3)} | ${row.selected_text_tag_count.p50}/${row.selected_text_tag_count.p90}/${row.selected_text_tag_count.p99} | ${row.mapped_count} | ${row.text_supplement_count} | ${row.union_count} | ${rate(sourceBlind?.sourceBlindTextHitRate)} | ${rate(sourceBlind?.sourceBlindZeroHitRate)} |

## v2 C/3 versus v3

- v2 description-only edges: ${cmp.v2_description_only_edges}
- v3 description-only edges: ${cmp.v3_description_only_edges}
- removed_description_edges: ${cmp.removed_description_edges}
- affected_novel_count: ${cmp.affected_novel_count}
- coverage_delta: ${cmp.coverage_delta}

Coverage decline is not a regression.

## Locale before/after (description-only edges)

| locale | v2 | v3 | removed |
| --- | ---: | ---: | ---: |
${localeTable}

## High-precision control tags

| tag | v2 | v3 |
| --- | ---: | ---: |
${controlTable}

## Precision on surviving population-layer reviewed edges

- v2 population reviewed edges / precision: ${cmp.v2_population_reviewed_edges} / ${rate(cmp.v2_population_precision)}
- v3 surviving reviewed edges / measured precision: ${cmp.measured_surviving_population_edges} / ${rate(cmp.measured_precision_on_surviving_reviewed_edges)}
- predicted (A+B): 330 edges / 73.3%
- within ±2pp of 73.3%: ${cmp.precision_within_tolerance ? "YES" : "NO"}

## Post-fix blind review

- sample count: ${blind?.descriptionOnlySampleCount ?? ""}
- status: ${blind?.status ?? "NOT_RUN"}

## Source/text conflict

- Source/text conflict population: ${auditQueue.postBlindCases.length}

## Fixed status block

\`\`\`text
${Object.entries(status).map(([key, value]) => `${key}=${value}`).join("\n")}
\`\`\`
`;
}

export async function runOwnerFinalC1({
  rawRunDir,
  waiverPath,
  b2Dir,
  canonicalPath,
  canonicalSha256,
  channelAppId,
  authoritativeOutputDir,
  trackedOutputDir,
  runId = "2026-08-16-owner-final-c1",
  generatedAt = new Date().toISOString(),
  lexiconOverridePath = null,
  configurations = null,
  maxTextTags = null,
  expectedC1InputSha256 = null,
  v2AuthoritativeDir = null,
  hiddenReferencePath = null,
  verdictsPath = null,
  postFixBlindOutputDir = null,
} = {}) {
  const overlayLoaded = lexiconOverridePath ? await loadLexiconOverride(lexiconOverridePath) : null;
  const scoreConfigurations = configurations ?? (overlayLoaded ? [C1_V3_CONFIGURATION] : undefined);
  const scoreMaxTextTags = maxTextTags ?? (overlayLoaded ? [...C1_V3_MAX_TEXT_TAGS] : undefined);
  const [waiver, b2Verification, canonicalBytes, mappingBytes, loaded] = await Promise.all([
    verifyOwnerTimingWaiver({ rawRunDir, waiverPath }),
    verifyB2FinalBundle(b2Dir),
    readFile(canonicalPath),
    readFile(join(b2Dir, "mapping-candidates-final.csv")),
    loadAndAnalyzeLaneBRun({ rawRunDir, channelAppId, allowOperationalPartial: true }),
  ]);
  if (!b2Verification.ok) fail(`B2 verification failed: ${b2Verification.failures.join(",")}`);
  if (sha256(canonicalBytes) !== canonicalSha256) fail("CanonicalTag v1 SHA-256 mismatch");
  const canonical = JSON.parse(canonicalBytes.toString("utf8"));
  if (b2Verification.manifest.canonical_sha256 !== canonicalSha256 || b2Verification.manifest.raw_manifest_sha256 !== waiver.verification.manifestSha256) fail("B2 evidence lineage differs from C1 inputs");
  const books = finalBooks(loaded.raw);
  const lexicon = buildLexicon(canonical, overlayLoaded?.overlay ?? null);
  const canonicalById = new Map(canonical.tags.map((tag) => [tag.stable_id, tag]));
  const sourceMapping = buildSourceMapping(parseCsv(mappingBytes.toString("utf8")), canonicalById);
  const { samples, materializedInput, qa } = buildSamples(books, loaded.raw.manifestSha256, sourceMapping, canonicalById);
  verifyMaterializedInput(materializedInput, sourceMapping);
  const inputContent = jsonl(materializedInput);
  const sampleContent = jsonl(samples);
  const c1InputSha256 = sha256(inputContent);
  const sampleSha256 = sha256(sampleContent);
  const requiredInputSha = expectedC1InputSha256 ?? (overlayLoaded ? EXPECTED_C1_INPUT_SHA256 : null);
  if (requiredInputSha && c1InputSha256 !== requiredInputSha) fail(`c1-input.jsonl SHA-256 mismatch: expected ${requiredInputSha}, got ${c1InputSha256}`);
  const lexiconOverrideMeta = overlayLoaded
    ? { version: overlayLoaded.overlay.version, sha256: overlayLoaded.sha256, path: overlayLoaded.path }
    : null;
  const scored = scoreCalibration({
    samples,
    taxonomy: lexicon.taxonomy,
    sourceMapping: sourceMapping.mapping,
    runId,
    generatedAt,
    mode: "C1",
    ...(scoreConfigurations ? { configurations: scoreConfigurations } : {}),
    ...(scoreMaxTextTags ? { maxTextTags: scoreMaxTextTags } : {}),
    lexiconOverride: lexiconOverrideMeta,
  });
  const auditQueue = buildAuditQueue(scored, { targetPerStratum: 50 });
  const bundle = buildArtifactBundle(scored, { auditQueue });
  await atomicWriteDirectory(authoritativeOutputDir, [
    ["c1-input.jsonl", inputContent],
    ["samples.jsonl", sampleContent],
    ["taxonomy-keywords.json", `${JSON.stringify(lexicon.taxonomy, null, 2)}\n`],
    ["keyword-seed-audit.json", `${JSON.stringify(lexicon.audit, null, 2)}\n`],
    ["source-mapping.json", `${JSON.stringify(sourceMapping.mapping, null, 2)}\n`],
    ["c1-input-qa.json", `${JSON.stringify({ ...qa, c1_input_sha256: c1InputSha256, scorer_sample_sha256: sampleSha256 }, null, 2)}\n`],
  ]);
  const scoreDir = join(authoritativeOutputDir, "scored");
  await writeArtifactBundle(scoreDir, bundle);
  const verification = await verifyArtifactBundle(scoreDir);
  if (!verification.ok) fail(`C1 scored bundle read-back failed: ${JSON.stringify(verification.failures)}`);
  const comparison = aggregateRelations(scored);

  let v3Compare = null;
  if (v2AuthoritativeDir) {
    if (!hiddenReferencePath || !verdictsPath) fail("v3 compare requires hidden reference and verdicts");
    const v2Summary = JSON.parse(await readFile(join(v2AuthoritativeDir, "scored", "calibration-summary.json"), "utf8"));
    v3Compare = await compareC1V3({
      v2EvidencePath: join(v2AuthoritativeDir, "scored", "text-evidence.jsonl"),
      v3EvidencePath: join(scoreDir, "text-evidence.jsonl"),
      v2Summary,
      v3Summary: { configurations: comparison },
      hiddenReferencePath,
      verdictsPath,
      overlayRules: overlayLoaded?.overlay.rules ?? [],
    });
    if (!v3Compare.comparison.precision_within_tolerance) {
      fail(`measured precision ${v3Compare.comparison.measured_precision_on_surviving_reviewed_edges} is outside ±2pp of 73.3%`);
    }
  }

  let blind = null;
  if (postFixBlindOutputDir) {
    blind = await buildDescriptionOnlyBlindReview({
      runDir: authoritativeOutputDir,
      canonicalPath,
      outputDir: postFixBlindOutputDir,
      generatedAt,
      populationTarget: POST_FIX_POPULATION_SAMPLE_TARGET,
      riskTarget: POST_FIX_RISK_SAMPLE_TARGET,
      riskCells: POST_FIX_RISK_CELLS,
      packageName: "post-fix-description-only-blind-review",
    });
  }

  const v3 = Boolean(overlayLoaded);
  const row = comparison[0];
  const sourceBlind = scored.sourceBlindSimulation?.[0];
  const status = v3
    ? {
      C1_V3_STATUS: "CALIBRATION_REVIEW_PENDING",
      C1_V3_SAMPLE_COUNT: 10_000,
      TITLE_WEIGHT: 30,
      DESCRIPTION_WEIGHT: 30,
      THRESHOLD: 30,
      MAX_TEXT_TAGS: 3,
      C1_V2_TEXT_HIT_RATE: 0.3596,
      C1_V3_TEXT_HIT_RATE: row.text_hit_rate,
      C1_V2_DESCRIPTION_ONLY_RATE: 0.3034,
      C1_V3_DESCRIPTION_ONLY_RATE: row.description_only_rate,
      REMOVED_BAD_SEED_EDGES: v3Compare?.comparison.removed_description_edges ?? "",
      PREDICTED_PRECISION_FROM_EXISTING_VERDICTS: 0.733,
      MEASURED_PRECISION_ON_SURVIVING_REVIEWED_EDGES: v3Compare?.comparison.measured_precision_on_surviving_reviewed_edges ?? "",
      POST_FIX_BLIND_REVIEW_SAMPLE_COUNT: blind?.descriptionOnlySampleCount ?? "",
      POST_FIX_BLIND_REVIEW_STATUS: blind?.status ?? "NOT_RUN",
      TEXT_PARAMETER_STATUS: "CALIBRATION_RECOMMENDATION_ONLY",
      CHAPTER_EVIDENCE_STATUS: "DEFER",
      C2_SAMPLE_REQUEST: "NONE",
      AUTO_WRITE_AUTHORIZED: "NO",
      OWNER_NEXT_DECISION: "POST_FIX_PRECISION_REVIEW_AND_FINAL_PARAMETER_FREEZE",
      LANGUAGE_19_RESOLUTION: "RAW_SCOPE_ONLY_LOCALE_STATISTICS_BLOCKED",
      LANGUAGE_20_RESOLUTION: "RAW_SCOPE_ONLY_LOCALE_STATISTICS_BLOCKED",
    }
    : {
      LANE_C_C1_STATUS: "CALIBRATION_REVIEW_PENDING",
      C1_SAMPLE_COUNT: 10_000,
      C1_RECOMMENDED_SCHEME: "OWNER_REVIEW_REQUIRED",
      C1_RECOMMENDED_MAX_TEXT_TAGS: "OWNER_REVIEW_REQUIRED",
      C1_RECOMMENDED_THRESHOLD: "OWNER_REVIEW_REQUIRED",
      TEXT_PARAMETER_STATUS: "CALIBRATION_RECOMMENDATION_ONLY",
      CHAPTER_EVIDENCE_STATUS: "DEFER",
      C2_SAMPLE_REQUEST: "NONE_PENDING_C1_ADJUDICATION",
      LANGUAGE_19_RESOLUTION: "RAW_SCOPE_ONLY_LOCALE_STATISTICS_BLOCKED",
      LANGUAGE_20_RESOLUTION: "RAW_SCOPE_ONLY_LOCALE_STATISTICS_BLOCKED",
      OWNER_NEXT_DECISIONS: "C1_INDEPENDENT_ADJUDICATION;TEXT_PARAMETER_FREEZE;C2_NEED_DECISION_AFTER_RECALL_REVIEW",
      AUTO_WRITE_AUTHORIZED: "NO",
    };
  const report = v3
    ? renderV3Report({
      qa, c1InputSha256, sampleSha256, overlaySha256: overlayLoaded.sha256,
      comparisonRows: comparison, scored, auditQueue, v3Compare, blind, status,
    })
    : `# P2-06.5 Lane C C1 10k Calibration v2\n\n## Technical summary\n\nC1 scored the verified 10,000-book final sample across A/B/C × maxTextTags 2/3/5. The output is calibration evidence only; no threshold, scheme, or text cap is frozen.\n\nSource tags use the exact composite key \`channel_app_id + raw_language_scope + exact token\`, are materialized per book in \`c1-input.jsonl\`, remain outside the text cap, and are unioned with selected text tags. Language 19 and 20 remain raw scopes with locale-specific statistics blocked.\n\n## Input QA and lineage\n\n- Unique novels/sample rows: ${qa.unique_novels}/${qa.unique_sample_rows}\n- Empty title: ${qa.title_missing_or_empty}\n- Empty description: ${qa.description_missing_or_empty}\n- No seriesType token: ${qa.no_series_type}\n- Manual FULL_SNAPSHOT rows: ${qa.manual_full_snapshot_count}\n- Novels with mapped source tags: ${qa.novels_with_mapped_source_tags}\n- C1 input SHA-256: \`${c1InputSha256}\`\n- Scorer sample SHA-256: \`${sampleSha256}\`\n- Sparse text evidence rows: ${scored.evidence.length}\n\n## Nine calibration configurations\n\n| scheme | cap | hit | title-only | description-only | both | zero | avg | p50/p90/p99 | truncated books/tags | mapped | supplement | union |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |\n${comparison.map((item) => `| ${item.config_id} | ${item.max_text_tags} | ${(item.text_hit_rate * 100).toFixed(2)}% | ${(item.title_only_rate * 100).toFixed(2)}% | ${(item.description_only_rate * 100).toFixed(2)}% | ${(item.title_description_both_rate * 100).toFixed(2)}% | ${(item.zero_hit_rate * 100).toFixed(2)}% | ${item.average_text_tags.toFixed(3)} | ${item.selected_text_tag_count.p50}/${item.selected_text_tag_count.p90}/${item.selected_text_tag_count.p99} | ${item.cap_truncated_books}/${item.cap_truncated_tags} | ${item.mapped_count} | ${item.text_supplement_count} | ${item.union_count} |`).join("\n")}\n\n## Source-blind and scope evidence\n\nThe text-only source-blind simulation is identical to the text metrics above and is separately materialized in the authoritative scored bundle. Per raw scope, the tracked summary records hit/zero rates, average tags, percentiles, cap truncation and keyword-coverage insufficiency. Raw scopes 19/20 are not relabeled as locales.\n\n## Precision and review status\n\n- False-positive audit: \`UNASSESSED_PENDING_INDEPENDENT_REVIEW\`\n- High false-positive keyword: \`UNASSESSED_PENDING_INDEPENDENT_REVIEW\`\n- Source/text conflict population: ${auditQueue.postBlindCases.length}; zero populations are recorded as shortfalls and are not fabricated.\n- Other-script and scope-level keyword gaps remain \`KEYWORD_COVERAGE_INSUFFICIENT\`.\n\n## Limitations\n\nNo independent C1 adjudications were supplied. Matcher risk flags are queueing signals, not measured false positives. Chapter evidence is deferred, and no C2 corpus was requested or read.\n\n## Fixed status block\n\n\`\`\`text\n${Object.entries(status).map(([key, value]) => `${key}=${value}`).join("\n")}\n\`\`\`\n`;
  const trackedSummary = {
    schema_version: 1,
    generated_at: generatedAt,
    status,
    input_qa: { ...qa, c1_input_sha256: c1InputSha256, scorer_sample_sha256: sampleSha256 },
    input_contract: {
      artifact: "c1-input.jsonl",
      fields: ["novel_identity", "channel_app_id", "raw_language_scope", "title", "description", "raw_series_types", "mapped_source_tags"],
      mapped_source_tag_fields: ["canonical_stable_id", "canonical_slug", "mapping_key", "exact_raw_token"],
    },
    canonical_sha256: canonicalSha256,
    raw_manifest_sha256: waiver.verification.manifestSha256,
    b2_manifest_sha256: b2Verification.manifestSha256,
    waiver_sha256: waiver.waiverSha256,
    authoritative_score_manifest_sha256: sha256(await readFile(join(scoreDir, "lane-c-run-manifest.json"))),
    c1_input_sha256: c1InputSha256,
    scorer_sample_sha256: sampleSha256,
    lexicon_override_sha256: overlayLoaded?.sha256 ?? null,
    lexicon_audit: {
      active_keyword_count: lexicon.audit.active_keyword_count,
      disabled_seed_count: lexicon.audit.disabled_seed_count,
      coverage_insufficient_tag_count: lexicon.audit.coverage_insufficient_tag_count,
      restricted_seed_count: lexicon.audit.restricted_seed_count ?? 0,
    },
    sparse_evidence_row_count: scored.evidence.length,
    audit_queue: { blind_cases: auditQueue.primaryCases.length, post_blind_conflicts: auditQueue.postBlindCases.length, shortfalls: auditQueue.shortfalls.length },
    false_positive_audit_status: "UNASSESSED_PENDING_INDEPENDENT_REVIEW",
    high_false_positive_keyword_status: "UNASSESSED_PENDING_INDEPENDENT_REVIEW",
    configurations: comparison,
    source_blind_simulation: scored.sourceBlindSimulation,
    raw_scope_statistics: scored.summaries.map((summary) => ({ config_id: summary.configId, max_text_tags: summary.maxTextTags, rows: summary.byLanguage })),
    v3_compare: v3Compare?.comparison ?? null,
  };
  const summaryContent = `${JSON.stringify(trackedSummary, null, 2)}\n`;
  const reportContent = report;
  const extraFiles = [];
  if (v3Compare) {
    extraFiles.push(["tag-level-before-after.csv", v3Compare.tagCsv]);
    extraFiles.push(["locale-before-after.csv", v3Compare.localeCsv]);
    extraFiles.push(["precision-from-verdicts.json", `${JSON.stringify(v3Compare.comparison, null, 2)}\n`]);
  }
  const trackedContents = [
    ["calibration-summary.json", summaryContent],
    ["LANE_C_REPORT.md", reportContent],
    ...extraFiles,
  ];
  const manifest = {
    schema_version: 1,
    status: "CALIBRATION_REVIEW_PENDING",
    files: trackedContents.map(([filename, content]) => ({
      filename,
      bytes: Buffer.byteLength(content),
      sha256: sha256(content),
    })),
    lineage: {
      canonical_sha256: canonicalSha256,
      raw_manifest_sha256: waiver.verification.manifestSha256,
      b2_manifest_sha256: b2Verification.manifestSha256,
      waiver_sha256: waiver.waiverSha256,
      c1_input_sha256: c1InputSha256,
      scorer_sample_sha256: sampleSha256,
      ...(overlayLoaded ? { lexicon_override_sha256: overlayLoaded.sha256, lexicon_override_version: overlayLoaded.overlay.version } : {}),
    },
  };
  await atomicWriteDirectory(trackedOutputDir, [
    ...trackedContents,
    ["C1_MANIFEST.json", `${JSON.stringify(manifest, null, 2)}\n`],
  ]);
  return {
    status,
    qa: trackedSummary.input_qa,
    comparison,
    sparseEvidenceRows: scored.evidence.length,
    auditQueue: trackedSummary.audit_queue,
    authoritativeOutputDir,
    trackedOutputDir,
    v3Compare: v3Compare?.comparison ?? null,
    blind,
    sourceBlind,
  };
}

export async function verifyOwnerFinalC1(trackedOutputDir) {
  const manifestBytes = await readFile(join(trackedOutputDir, "C1_MANIFEST.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const failures = [];
  const expected = new Set(["C1_MANIFEST.json", ...manifest.files.map(({ filename }) => filename)]);
  const actual = new Set(await readdir(trackedOutputDir));
  if (expected.size !== actual.size || [...expected].some((name) => !actual.has(name))) failures.push("FILE_SET_MISMATCH");
  for (const descriptor of manifest.files) {
    const bytes = await readFile(join(trackedOutputDir, descriptor.filename));
    if (bytes.length !== descriptor.bytes) failures.push(`${descriptor.filename}:bytes`);
    if (sha256(bytes) !== descriptor.sha256) failures.push(`${descriptor.filename}:sha256`);
  }
  if (!/^[a-f0-9]{64}$/u.test(manifest.lineage?.c1_input_sha256 ?? "")) failures.push("C1_INPUT_SHA256_MISSING");
  if (!/^[a-f0-9]{64}$/u.test(manifest.lineage?.scorer_sample_sha256 ?? "")) failures.push("SCORER_SAMPLE_SHA256_MISSING");
  return { ok: failures.length === 0, failures, manifestSha256: sha256(manifestBytes), manifest };
}
