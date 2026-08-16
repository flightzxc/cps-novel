import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { analyzeB1RawRecords, assessDiscoveryStatus } from "./b1-analysis.mjs";
import { verifyRawRunManifest } from "./run-store.mjs";

const CSV_COLUMNS = Object.freeze({
  "source-taxonomy-inventory.csv": [
    ["token_key_sha256", "tokenKeySha256"],
    ["source_scope", "sourceScope"],
    ["language_json_type", "languageJsonType"],
    ["language_json_value_json", "languageJsonValueJson"],
    ["language_name_raw", "languageNameRaw"],
    ["language_name_state", "languageNameState"],
    ["raw_language_scope", "rawLanguageScope"],
    ["site_locale", "siteLocale"],
    ["locale_key", "localeKey"],
    ["exact_raw_token", "exactRawToken"],
    ["raw_token_utf8_base64", "rawTokenUtf8Base64"],
    ["raw_token_sha256", "rawTokenSha256"],
    ["raw_token_codepoint_length", "rawTokenCodepointLength"],
    ["book_frequency", "bookFrequency"],
    ["occurrence_count", "occurrenceCount"],
    ["first_seen_at", "firstSeenAt"],
    ["first_seen_page", "firstSeenPage"],
    ["last_seen_at", "lastSeenAt"],
    ["last_seen_page", "lastSeenPage"],
    ["representative_sample_count", "representativeSampleCount"],
    ["representative_book_keys_json", "representativeBookKeys"],
    ["carrier_book_keys_json", "carrierBookKeys"],
  ],
  "source-token-cooccurrence.csv": [
    ["source_scope", "sourceScope"],
    ["locale_key", "localeKey"],
    ["token_key_a", "tokenKeyA"],
    ["exact_raw_token_a", "exactRawTokenA"],
    ["raw_token_utf8_base64_a", "rawTokenUtf8Base64A"],
    ["raw_token_sha256_a", "rawTokenSha256A"],
    ["token_key_b", "tokenKeyB"],
    ["exact_raw_token_b", "exactRawTokenB"],
    ["raw_token_utf8_base64_b", "rawTokenUtf8Base64B"],
    ["raw_token_sha256_b", "rawTokenSha256B"],
    ["n_a", "nA"],
    ["n_b", "nB"],
    ["n_ab", "nAB"],
    ["jaccard", "jaccard"],
    ["p_b_given_a", "pBGivenA"],
    ["p_a_given_b", "pAGivenB"],
  ],
  "taxonomy-discovery-curve.csv": [
    ["discovery_stage", "discoveryStage"],
    ["checkpoint_scope", "checkpointScope"],
    ["raw_language_scope", "rawLanguageScope"],
    ["checkpoint_sample_count", "checkpointSampleCount"],
    ["block_sample_count", "blockSampleCount"],
    ["new_distinct_mapping_keys", "newDistinctMappingKeys"],
    ["cumulative_distinct_mapping_keys", "cumulativeDistinctMappingKeys"],
    ["block_novelty_rate", "blockNoveltyRate"],
  ],
  "locale-sample-distribution.csv": [
    ["language_json_type", "languageJsonType"],
    ["language_json_value_json", "languageJsonValueJson"],
    ["language_name_raw", "languageNameRaw"],
    ["language_name_state", "languageNameState"],
    ["raw_language_scope", "rawLanguageScope"],
    ["site_locale", "siteLocale"],
    ["locale_key", "localeKey"],
    ["sample_count", "sampleCount"],
  ],
  "source-token-structure-anomaly-summary.csv": [
    ["source_scope", "sourceScope"],
    ["raw_language_scope", "rawLanguageScope"],
    ["reason", "reason"],
    ["structure_status", "structureStatus"],
    ["anomaly_count", "anomalyCount"],
    ["distinct_book_count", "distinctBookCount"],
  ],
});

const B1_TRACKED_ARTIFACTS = Object.freeze([
  "source-token-evidence.jsonl",
  "source-taxonomy-inventory.csv",
  "source-token-cooccurrence.csv",
  "taxonomy-discovery-curve.csv",
  "locale-sample-distribution.csv",
  "source-token-structure-anomaly-summary.csv",
  "LANE_B_REPORT.md",
]);
const B1_MANIFEST_NAME = "lane-b-run-manifest.json";
const B1_BUNDLE_FILES = Object.freeze([...B1_TRACKED_ARTIFACTS, B1_MANIFEST_NAME]);
const B1_TRACKED_SET = new Set(B1_TRACKED_ARTIFACTS);
const B1_BUNDLE_SET = new Set(B1_BUNDLE_FILES);
const SHA256_HEX = /^[a-f0-9]{64}$/u;

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

function failure(code, path = null, details = undefined) {
  return { code, path, ...(details === undefined ? {} : { details }) };
}

function isFlatArtifactName(path) {
  return typeof path === "string"
    && path.length > 0
    && !isAbsolute(path)
    && basename(path) === path
    && path !== "."
    && path !== "..";
}

function sameStringSet(actual, expected) {
  return actual.length === expected.size
    && new Set(actual).size === actual.length
    && actual.every((value) => expected.has(value));
}

async function pathExists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function validateManifestDescriptors(manifest) {
  const failures = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { failures: [failure("MANIFEST_SCHEMA_INVALID", B1_MANIFEST_NAME)], artifacts: [] };
  }
  if (manifest.schemaVersion !== 1) failures.push(failure("MANIFEST_SCHEMA_VERSION_INVALID", B1_MANIFEST_NAME));
  if (!Array.isArray(manifest.artifacts)) {
    failures.push(failure("MANIFEST_ARTIFACTS_INVALID", B1_MANIFEST_NAME));
    return { failures, artifacts: [] };
  }
  const artifacts = manifest.artifacts;
  const paths = [];
  for (const [index, artifact] of artifacts.entries()) {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      failures.push(failure("ARTIFACT_DESCRIPTOR_INVALID", null, { index }));
      continue;
    }
    const path = artifact.path;
    if (!isFlatArtifactName(path) || !B1_TRACKED_SET.has(path)) {
      failures.push(failure("ARTIFACT_PATH_INVALID", typeof path === "string" ? path : null, { index }));
    } else {
      paths.push(path);
    }
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0) {
      failures.push(failure("ARTIFACT_BYTES_INVALID", typeof path === "string" ? path : null, { index }));
    }
    if (typeof artifact.sha256 !== "string" || !SHA256_HEX.test(artifact.sha256)) {
      failures.push(failure("ARTIFACT_SHA256_INVALID", typeof path === "string" ? path : null, { index }));
    }
    if (artifact.rowCount !== null && (!Number.isSafeInteger(artifact.rowCount) || artifact.rowCount < 0)) {
      failures.push(failure("ARTIFACT_ROW_COUNT_INVALID", typeof path === "string" ? path : null, { index }));
    }
  }
  if (new Set(paths).size !== paths.length) failures.push(failure("ARTIFACT_PATH_DUPLICATE", B1_MANIFEST_NAME));
  if (!sameStringSet(paths, B1_TRACKED_SET)) failures.push(failure("ARTIFACT_DESCRIPTOR_SET_MISMATCH", B1_MANIFEST_NAME));
  return { failures, artifacts };
}

function validateBundle(bundle) {
  if (!bundle || typeof bundle !== "object" || !(bundle.contents instanceof Map)) {
    throw new TypeError("Lane B B1 bundle must contain a contents Map");
  }
  const paths = [...bundle.contents.keys()];
  if (!sameStringSet(paths, B1_BUNDLE_SET) || paths.some((path) => !isFlatArtifactName(path))) {
    throw new Error("Lane B B1 bundle contains an invalid, missing, duplicate, or traversing artifact path");
  }
  for (const [path, content] of bundle.contents) {
    if (typeof content !== "string") throw new TypeError(`Lane B B1 artifact ${path} must be UTF-8 text`);
  }
  let manifest;
  try {
    manifest = JSON.parse(bundle.contents.get(B1_MANIFEST_NAME));
  } catch {
    throw new Error("Lane B B1 bundle manifest must be valid JSON");
  }
  const descriptorValidation = validateManifestDescriptors(manifest);
  if (descriptorValidation.failures.length > 0) {
    throw new Error(`Lane B B1 bundle manifest is invalid: ${descriptorValidation.failures.map(({ code }) => code).join(",")}`);
  }
  const descriptors = new Map(descriptorValidation.artifacts.map((artifact) => [artifact.path, artifact]));
  for (const path of B1_TRACKED_ARTIFACTS) {
    const bytes = Buffer.from(bundle.contents.get(path), "utf8");
    const descriptor = descriptors.get(path);
    if (descriptor.bytes !== bytes.length || descriptor.sha256 !== sha256Buffer(bytes)) {
      throw new Error(`Lane B B1 bundle descriptor mismatch: ${path}`);
    }
  }
  return manifest;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (character !== "\r") cell += character;
  }
  if (quoted || row.length > 0 || cell.length > 0) throw new Error("invalid CSV framing");
  if (rows.length === 0) throw new Error("CSV header missing");
  const [header, ...body] = rows;
  if (new Set(header).size !== header.length) throw new Error("CSV header duplicate");
  return body.map((values) => {
    if (values.length !== header.length) throw new Error("CSV row width mismatch");
    return Object.fromEntries(header.map((name, index) => [name, values[index]]));
  });
}

function manifestSemanticFailures(manifest, contentByPath) {
  const failures = [];
  const mismatch = (field) => failures.push(failure("MANIFEST_SEMANTIC_MISMATCH", B1_MANIFEST_NAME, { field }));
  try {
    const evidenceText = contentByPath.get("source-token-evidence.jsonl");
    const evidence = evidenceText.length === 0
      ? []
      : evidenceText.slice(0, -1).split("\n").map((line) => JSON.parse(line));
    const inventory = parseCsv(contentByPath.get("source-taxonomy-inventory.csv"));
    const curves = parseCsv(contentByPath.get("taxonomy-discovery-curve.csv"));
    const distribution = parseCsv(contentByPath.get("locale-sample-distribution.csv"));
    const anomalies = parseCsv(contentByPath.get("source-token-structure-anomaly-summary.csv"));
    const report = contentByPath.get("LANE_B_REPORT.md");

    const sourceScopes = new Set([
      ...inventory.map(({ source_scope }) => source_scope),
      ...evidence.map(({ sourceScope }) => sourceScope),
    ]);
    if (sourceScopes.size > 1 || (sourceScopes.size === 1 && !sourceScopes.has(manifest.sourceScope))) mismatch("sourceScope");
    if (sourceScopes.size === 0 && manifest.sourceScope !== null && typeof manifest.sourceScope !== "string") mismatch("sourceScope");
    if (manifest.totalSourceTokens !== inventory.length) mismatch("totalSourceTokens");

    const finalGlobal = curves.filter(({ discovery_stage, checkpoint_scope }) => (
      discovery_stage === "final_sample" && checkpoint_scope === "global"
    ));
    const candidateGlobal = curves.filter(({ discovery_stage, checkpoint_scope }) => (
      discovery_stage === "candidate_acquisition" && checkpoint_scope === "global"
    ));
    const finalBooks = finalGlobal.length === 0
      ? distribution.reduce((sum, row) => sum + Number(row.sample_count), 0)
      : Number(finalGlobal.at(-1).checkpoint_sample_count);
    const candidateBooks = candidateGlobal.length === 0 ? 0 : Number(candidateGlobal.at(-1).checkpoint_sample_count);
    if (!Number.isSafeInteger(finalBooks) || manifest.actualUniqueBooks !== finalBooks) mismatch("actualUniqueBooks");
    if (!Number.isSafeInteger(candidateBooks) || manifest.candidateUniqueBooks !== candidateBooks) mismatch("candidateUniqueBooks");
    const candidateTokens = candidateGlobal.length === 0 ? 0 : Number(candidateGlobal.at(-1).cumulative_distinct_mapping_keys);
    const expectedCoverage = candidateTokens === 0 ? null : inventory.length / candidateTokens;
    if (!Object.is(manifest.empiricalTokenCoverage, expectedCoverage)) mismatch("empiricalTokenCoverage");
    if (manifest.targetUniqueBooks !== 10_000) mismatch("targetUniqueBooks");
    if (manifest.taxonomyCoverageRate !== null) mismatch("taxonomyCoverageRate");
    if (manifest.taxonomyCoverageStatus !== "NOT_ESTIMABLE_NO_DENOMINATOR") mismatch("taxonomyCoverageStatus");

    const anomalyCount = anomalies.reduce((sum, row) => sum + Number(row.anomaly_count), 0);
    if (!Number.isSafeInteger(anomalyCount) || manifest.structureAnomalyCount !== anomalyCount) mismatch("structureAnomalyCount");
    const expectedSampleStatus = finalBooks === 0
      ? "BLOCKED"
      : finalBooks === manifest.targetUniqueBooks
        && manifest.languageQuotaSatisfiedOrExhausted === true
        && manifest.rawRoundTripQaPassed === true
        && manifest.requestBudgetQaPassed === true ? "COMPLETE" : "PARTIAL";
    if (manifest.laneBSampleStatus !== expectedSampleStatus) mismatch("laneBSampleStatus");
    const discoveryFacts = curves.map((row) => ({
      discoveryStage: row.discovery_stage,
      checkpointScope: row.checkpoint_scope,
      rawLanguageScope: row.raw_language_scope === "" ? null : row.raw_language_scope,
      checkpointSampleCount: Number(row.checkpoint_sample_count),
      blockSampleCount: Number(row.block_sample_count),
      newDistinctMappingKeys: Number(row.new_distinct_mapping_keys),
      cumulativeDistinctMappingKeys: Number(row.cumulative_distinct_mapping_keys),
      blockNoveltyRate: Number(row.block_novelty_rate),
    }));
    if (discoveryFacts.some((row) => [
      row.checkpointSampleCount,
      row.blockSampleCount,
      row.newDistinctMappingKeys,
      row.cumulativeDistinctMappingKeys,
      row.blockNoveltyRate,
    ].some((value) => !Number.isFinite(value)))) throw new Error("invalid discovery curve numeric value");
    const expectedDiscoveryStatus = assessDiscoveryStatus(discoveryFacts, finalBooks, {
      targetUniqueBooks: 10_000,
      languageQuotaSatisfiedOrExhausted: manifest.languageQuotaSatisfiedOrExhausted,
      rawRoundTripQaPassed: manifest.rawRoundTripQaPassed,
      requestBudgetQaPassed: manifest.requestBudgetQaPassed,
    });
    if (manifest.discoveryStatus !== expectedDiscoveryStatus) mismatch("discoveryStatus");
    if (manifest.laneBMappingStatus !== "WAITING_FOR_CANONICAL_TAG_V1") mismatch("laneBMappingStatus");
    if (manifest.ownerReviewItems !== 0) mismatch("ownerReviewItems");
    const fixedLines = [
      `LANE_B_SAMPLE_STATUS=${manifest.laneBSampleStatus}`,
      `LANE_B_MAPPING_STATUS=${manifest.laneBMappingStatus}`,
      `SOURCE_TAXONOMY_DISCOVERY_STATUS=${manifest.discoveryStatus}`,
      `OWNER_REVIEW_ITEMS=${manifest.ownerReviewItems}`,
      `TAXONOMY_COVERAGE_RATE=${manifest.taxonomyCoverageStatus}`,
    ];
    if (fixedLines.some((line) => !report.includes(line))) mismatch("reportFixedStatusBlock");
  } catch {
    failures.push(failure("BUNDLE_SEMANTIC_PARSE_FAILED", null));
  }
  return failures;
}

function jsonValue(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value) || typeof value === "object") return JSON.stringify(value);
  if (typeof value === "number" && !Number.isInteger(value)) return value.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
  return String(value);
}

function csvCell(value) {
  const text = jsonValue(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function rowsToCsv(rows, columns) {
  const header = columns.map(([name]) => csvCell(name)).join(",");
  const body = rows.map((row) => columns.map(([, key]) => csvCell(row[key])).join(","));
  return `${[header, ...body].join("\n")}\n`;
}

export function rowsToJsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : "");
}

function mermaidDiscoveryCurve(curves) {
  const globalFinal = curves.filter(({ discoveryStage, checkpointScope }) => (
    discoveryStage === "final_sample" && checkpointScope === "global"
  ));
  const selected = globalFinal.length > 0 ? globalFinal : curves.filter(({ checkpointScope }) => checkpointScope === "global");
  const xValues = selected.map(({ checkpointSampleCount }) => checkpointSampleCount).join(", ");
  const yValues = selected.map(({ cumulativeDistinctMappingKeys }) => cumulativeDistinctMappingKeys).join(", ");
  const maximum = Math.max(1, ...selected.map(({ cumulativeDistinctMappingKeys }) => cumulativeDistinctMappingKeys));
  return [
    "```mermaid",
    "xychart-beta",
    '    title "Cumulative exact source-token discovery"',
    `    x-axis "Unique sampled books" [${xValues}]`,
    `    y-axis "Distinct mapping keys" 0 --> ${maximum}`,
    `    line [${yValues}]`,
    "```",
  ].join("\n");
}

function mermaidLocaleDistribution(distribution) {
  const labels = distribution.map(({ languageNameRaw, rawLanguageScope }, index) => {
    const name = typeof languageNameRaw === "string" && languageNameRaw.length > 0
      ? languageNameRaw.replace(/[\r\n\[\]",]/gu, " ").slice(0, 18)
      : "unnamed";
    return `"L${index + 1}:${name}:${sha256Buffer(Buffer.from(rawLanguageScope, "utf8")).slice(0, 8)}"`;
  }).join(", ");
  const counts = distribution.map(({ sampleCount }) => sampleCount).join(", ");
  const maximum = Math.max(1, ...distribution.map(({ sampleCount }) => sampleCount));
  return [
    "```mermaid",
    "xychart-beta",
    '    title "Sample distribution by exact locale key"',
    `    x-axis [${labels}]`,
    `    y-axis "Unique sampled books" 0 --> ${maximum}`,
    `    bar [${counts}]`,
    "```",
  ].join("\n");
}

function languageScopeTable(distribution) {
  if (distribution.length === 0) return "_No sampled raw-language scopes._";
  const header = "| Chart label | language JSON type | language JSON value | languageName state/raw | raw-language scope SHA-256 | books |";
  const separator = "| --- | --- | --- | --- | --- | ---: |";
  const rows = distribution.map(({ languageJsonType, languageJsonValueJson, languageNameRaw, languageNameState, rawLanguageScope, sampleCount }, index) => {
    const hash = sha256Buffer(Buffer.from(rawLanguageScope, "utf8"));
    const name = languageNameState === "string"
      ? `string / \`${String(languageNameRaw).replaceAll("`", "\\`")}\``
      : `\`${languageNameState}\``;
    return `| L${index + 1} | \`${languageJsonType}\` | \`${languageJsonValueJson.replaceAll("`", "\\`")}\` | ${name} | \`${hash}\` | ${sampleCount} |`;
  });
  return [header, separator, ...rows].join("\n");
}

export function renderB1Report(analysis, metadata = {}) {
  const summary = analysis.summary;
  const runId = metadata.runId ?? "UNSPECIFIED";
  const generatedAt = metadata.generatedAt ?? "UNSPECIFIED";
  const targetUniqueBooks = metadata.targetUniqueBooks ?? 10_000;
  const operationalQa = metadata.rawVerificationStatus === "PARTIAL_OPERATIONAL_QA_FAILED"
    ? [
      "## Operational QA",
      "",
      "The authoritative raw facts passed semantic round-trip verification, but the frozen request-budget QA failed. This run remains `PARTIAL` and taxonomy discovery remains `TAXONOMY_DISCOVERY_NOT_SATURATED`; no additional requests were made.",
      `- Raw stop reason: \`${metadata.rawStopReason ?? "UNSPECIFIED"}\``,
      `- Verification failures: \`${(metadata.rawVerificationFailures ?? []).join(",") || "UNSPECIFIED"}\``,
      "",
    ]
    : [];
  return [
    "# P2-06.5 Lane B · B1 Source Taxonomy Sampling Report",
    "",
    "## Conclusion",
    "",
    `Run \`${runId}\` contains **${summary.actualUniqueBooks}** exact unique sampled books and **${summary.totalSourceTokens}** distinct \`source scope + locale key + exact raw token\` keys.`,
    `Taxonomy coverage is **${summary.taxonomyCoverageStatus}**: the source exposes no authoritative complete token denominator, so this report does not invent a coverage percentage.`,
    "",
    "## Fact baseline",
    "",
    `- Generated at: \`${generatedAt}\``,
    `- Target unique books: ${targetUniqueBooks}`,
    `- Actual unique books: ${summary.actualUniqueBooks}`,
    `- Exact source-token keys: ${summary.totalSourceTokens}`,
    `- Empirical token coverage (final sample / candidate pool): ${summary.empiricalTokenCoverage === null ? "NOT_ESTIMABLE_EMPTY_CANDIDATE_POOL" : summary.empiricalTokenCoverage.toFixed(6)}`,
    `- Unextractable/ambiguous raw list members: ${analysis.anomalies.length}`,
    `- Discovery assessment: \`${summary.discoveryStatus}\``,
    "",
    ...operationalQa,
    "## Taxonomy discovery curve",
    "",
    mermaidDiscoveryCurve(analysis.discoveryCurves),
    "",
    "## Language / locale distribution",
    "",
    "The chart uses the exact raw-language scope: JSON type + JSON value + raw languageName. Site locale remains null; this report does not guess a locale.",
    "",
    mermaidLocaleDistribution(analysis.localeDistribution),
    "",
    languageScopeTable(analysis.localeDistribution),
    "",
    "## Metric definitions and caveats",
    "",
    "- Token identity is exact UTF-8 text under source scope and locale key. No trim, case fold, Unicode normalization, translation, spelling correction, fuzzy merge, or synonym merge is applied.",
    "- `book_frequency` is distinct sampled books carrying the token; `occurrence_count` retains duplicate occurrences inside a book.",
    "- Co-occurrence first set-deduplicates tokens within each book. `jaccard = n_ab / (n_a + n_b - n_ab)`; both directional conditional probabilities are also reported.",
    "- The inventory CSV carries the exact token, UTF-8 base64, and SHA-256 so spreadsheet transport can be checked against authoritative raw JSONL.",
    "- B1 does not establish any online mapping and does not classify novels.",
    "",
    "## Fixed status block",
    "",
    "```text",
    `LANE_B_SAMPLE_STATUS=${summary.laneBSampleStatus}`,
    `LANE_B_MAPPING_STATUS=${summary.laneBMappingStatus}`,
    `SOURCE_TAXONOMY_DISCOVERY_STATUS=${summary.discoveryStatus}`,
    `OWNER_REVIEW_ITEMS=${summary.ownerReviewItems}`,
    `TAXONOMY_COVERAGE_RATE=${summary.taxonomyCoverageStatus}`,
    `EMPIRICAL_TOKEN_COVERAGE=${summary.empiricalTokenCoverage === null ? "NOT_ESTIMABLE_EMPTY_CANDIDATE_POOL" : summary.empiricalTokenCoverage.toFixed(6)}`,
    "```",
    "",
  ].join("\n");
}

function artifactContent(analysis, metadata) {
  return new Map([
    ["source-token-evidence.jsonl", rowsToJsonl(analysis.evidence)],
    ["source-taxonomy-inventory.csv", rowsToCsv(analysis.inventory, CSV_COLUMNS["source-taxonomy-inventory.csv"])],
    ["source-token-cooccurrence.csv", rowsToCsv(analysis.cooccurrence, CSV_COLUMNS["source-token-cooccurrence.csv"])],
    ["taxonomy-discovery-curve.csv", rowsToCsv(analysis.discoveryCurves, CSV_COLUMNS["taxonomy-discovery-curve.csv"])],
    ["locale-sample-distribution.csv", rowsToCsv(analysis.localeDistribution, CSV_COLUMNS["locale-sample-distribution.csv"])],
    ["source-token-structure-anomaly-summary.csv", rowsToCsv(
      analysis.structureAnomalySummary,
      CSV_COLUMNS["source-token-structure-anomaly-summary.csv"],
    )],
    ["LANE_B_REPORT.md", renderB1Report(analysis, metadata)],
  ]);
}

function defaultManifest(metadata, analysis) {
  const plannedUniquePages = metadata.plannedRequests ?? metadata.planned_unique_pages ?? null;
  const retryBudget = metadata.retry_budget ?? null;
  const httpAttemptCap = metadata.http_attempt_cap ?? null;
  return {
    schemaVersion: 1,
    runId: metadata.runId ?? null,
    sourceScope: metadata.sourceScope ?? null,
    gitHead: metadata.gitHead ?? null,
    generatedAt: metadata.generatedAt ?? null,
    timezone: metadata.timezone ?? "Asia/Tokyo",
    requestBudget: metadata.requestBudget ?? (httpAttemptCap === null ? null : {
      plannedUniquePages,
      retryBudget,
      httpAttemptCap,
    }),
    plannedRequests: plannedUniquePages,
    actualRequests: metadata.actualRequests ?? metadata.actual_http_attempts ?? null,
    pageSize: metadata.pageSize ?? metadata.page_size ?? metadata.request_contract?.pageSize ?? 100,
    targetUniqueBooks: metadata.targetUniqueBooks ?? 10_000,
    actualUniqueBooks: analysis.summary.actualUniqueBooks,
    candidateUniqueBooks: analysis.summary.candidateUniqueBooks,
    totalSourceTokens: analysis.summary.totalSourceTokens,
    empiricalTokenCoverage: analysis.summary.empiricalTokenCoverage,
    taxonomyCoverageRate: analysis.summary.taxonomyCoverageRate,
    taxonomyCoverageStatus: analysis.summary.taxonomyCoverageStatus,
    discoveryStatus: analysis.summary.discoveryStatus,
    laneBSampleStatus: analysis.summary.laneBSampleStatus,
    laneBMappingStatus: analysis.summary.laneBMappingStatus,
    ownerReviewItems: analysis.summary.ownerReviewItems,
    languageQuotaSatisfiedOrExhausted: analysis.summary.languageQuotaSatisfiedOrExhausted,
    rawRoundTripQaPassed: analysis.summary.rawRoundTripQaPassed,
    requestBudgetQaPassed: analysis.summary.requestBudgetQaPassed,
    structureAnomalyCount: analysis.anomalies.length,
    rawManifestSha256: metadata.rawManifestSha256 ?? null,
    rawRunStatus: metadata.rawRunStatus ?? null,
    rawStopReason: metadata.rawStopReason ?? null,
    rawVerificationStatus: metadata.rawVerificationStatus ?? null,
    rawVerificationFailures: metadata.rawVerificationFailures ?? [],
    rawSourceFiles: (metadata.sourceRawFiles ?? []).map((path) => typeof path === "string" ? path.split(/[\\/]/).at(-1) : null).filter(Boolean),
    canonicalTagVersion: null,
    canonicalTagSha256: null,
    artifacts: [],
  };
}

function artifactRowCounts(analysis) {
  return new Map([
    ["source-token-evidence.jsonl", analysis.evidence.length],
    ["source-taxonomy-inventory.csv", analysis.inventory.length],
    ["source-token-cooccurrence.csv", analysis.cooccurrence.length],
    ["taxonomy-discovery-curve.csv", analysis.discoveryCurves.length],
    ["locale-sample-distribution.csv", analysis.localeDistribution.length],
    ["source-token-structure-anomaly-summary.csv", analysis.structureAnomalySummary.length],
    ["LANE_B_REPORT.md", null],
  ]);
}

export function buildB1ArtifactBundle(analysis, metadata = {}) {
  const contents = artifactContent(analysis, metadata);
  const rowCounts = artifactRowCounts(analysis);
  const descriptors = [...contents.entries()].map(([path, content]) => {
    const bytes = Buffer.from(content, "utf8");
    return { path, bytes: bytes.length, sha256: sha256Buffer(bytes), rowCount: rowCounts.get(path) };
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const manifest = { ...defaultManifest(metadata, analysis), artifacts: descriptors };
  contents.set("lane-b-run-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  return { analysis, manifest, contents };
}

export async function writeB1ArtifactBundle(outputDirectory, bundle) {
  if (typeof outputDirectory !== "string" || outputDirectory.length === 0) {
    throw new TypeError("Lane B B1 outputDirectory must be a non-empty path");
  }
  validateBundle(bundle);
  const output = resolve(outputDirectory);
  const parent = dirname(output);
  const outputName = basename(output);
  if (outputName === "." || outputName === ".." || output === parent) {
    throw new Error("Lane B B1 outputDirectory must name a new child directory");
  }
  await mkdir(parent, { recursive: true });
  const parentInfo = await lstat(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new Error("Lane B B1 output parent must be a regular non-symlink directory");
  }
  if (await pathExists(output)) {
    const error = new Error("Lane B B1 refuses to overwrite an existing outputDirectory");
    error.code = "EEXIST";
    throw error;
  }

  const staging = await mkdtemp(join(parent, `.${outputName}.staging-`));
  try {
    for (const artifactPath of B1_BUNDLE_FILES) {
      await writeFile(join(staging, artifactPath), bundle.contents.get(artifactPath), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    }
    const stagedVerification = await verifyB1ArtifactBundle(staging, {
      expectedManifestSha256: sha256Buffer(Buffer.from(bundle.contents.get(B1_MANIFEST_NAME), "utf8")),
    });
    if (!stagedVerification.ok) {
      throw new Error(`Lane B B1 staged bundle verification failed: ${stagedVerification.failures.map(({ code }) => code).join(",")}`);
    }
    if (await pathExists(output)) {
      const error = new Error("Lane B B1 refuses to overwrite an existing outputDirectory");
      error.code = "EEXIST";
      throw error;
    }
    await rename(staging, output);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return outputDirectory;
}

export async function verifyB1ArtifactBundle(outputDirectory, { expectedManifestSha256 } = {}) {
  const output = resolve(outputDirectory);
  const manifestPath = join(output, B1_MANIFEST_NAME);
  const failures = [];
  let manifest = null;
  let manifestBytes = null;
  try {
    const rootInfo = await lstat(output);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      failures.push(failure("OUTPUT_DIRECTORY_INVALID", null));
      return { ok: false, failures, manifestPath: relative(process.cwd(), manifestPath), manifest: null, manifestSha256: null };
    }
    const manifestInfo = await lstat(manifestPath);
    if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) {
      failures.push(failure("MANIFEST_FILE_INVALID", B1_MANIFEST_NAME));
    } else {
      manifestBytes = await readFile(manifestPath);
      const manifestSha256 = sha256Buffer(manifestBytes);
      if (expectedManifestSha256 !== undefined
        && (typeof expectedManifestSha256 !== "string" || !SHA256_HEX.test(expectedManifestSha256))) {
        failures.push(failure("EXPECTED_MANIFEST_SHA256_INVALID", B1_MANIFEST_NAME));
      } else if (expectedManifestSha256 !== undefined && manifestSha256 !== expectedManifestSha256) {
        failures.push(failure("MANIFEST_SHA256_MISMATCH", B1_MANIFEST_NAME, {
          expected: expectedManifestSha256,
          actual: manifestSha256,
        }));
      }
      try {
        manifest = JSON.parse(manifestBytes.toString("utf8"));
      } catch {
        failures.push(failure("MANIFEST_JSON_INVALID", B1_MANIFEST_NAME));
      }
    }
  } catch {
    failures.push(failure("BUNDLE_READ_FAILED", null));
  }

  let diskEntries = [];
  try {
    const entries = await readdir(output, { withFileTypes: true });
    diskEntries = entries.map(({ name }) => name);
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isFile()) failures.push(failure("DISK_ENTRY_INVALID", entry.name));
    }
    if (!sameStringSet(diskEntries, B1_BUNDLE_SET)) failures.push(failure("DISK_ARTIFACT_SET_MISMATCH", null));
  } catch {
    failures.push(failure("DISK_ARTIFACT_SET_UNREADABLE", null));
  }

  const descriptorValidation = validateManifestDescriptors(manifest);
  failures.push(...descriptorValidation.failures);
  const seenPaths = new Set();
  const contentByPath = new Map();
  for (const artifact of descriptorValidation.artifacts) {
    if (!artifact || typeof artifact !== "object" || !isFlatArtifactName(artifact.path)
      || !B1_TRACKED_SET.has(artifact.path) || seenPaths.has(artifact.path)) continue;
    seenPaths.add(artifact.path);
    const artifactPath = join(output, artifact.path);
    try {
      const info = await lstat(artifactPath);
      if (info.isSymbolicLink() || !info.isFile()) {
        failures.push(failure("ARTIFACT_FILE_INVALID", artifact.path));
        continue;
      }
      const bytes = await readFile(artifactPath);
      contentByPath.set(artifact.path, bytes.toString("utf8"));
      const actualSha256 = sha256Buffer(bytes);
      if (Number.isSafeInteger(artifact.bytes) && artifact.bytes >= 0 && bytes.length !== artifact.bytes) {
        failures.push(failure("ARTIFACT_BYTES_MISMATCH", artifact.path, { expected: artifact.bytes, actual: bytes.length }));
      }
      if (typeof artifact.sha256 === "string" && SHA256_HEX.test(artifact.sha256) && actualSha256 !== artifact.sha256) {
        failures.push(failure("ARTIFACT_SHA256_MISMATCH", artifact.path, { expected: artifact.sha256, actual: actualSha256 }));
      }
      if (artifact.path.endsWith(".jsonl") && Number.isSafeInteger(artifact.rowCount)) {
        const text = bytes.toString("utf8");
        let actualRows = 0;
        try {
          if (text.length > 0 && !text.endsWith("\n")) throw new Error("missing final newline");
          for (const line of text.split("\n")) {
            if (line.length === 0) continue;
            JSON.parse(line);
            actualRows += 1;
          }
          if (actualRows !== artifact.rowCount) {
            failures.push(failure("ARTIFACT_ROW_COUNT_MISMATCH", artifact.path, {
              expected: artifact.rowCount,
              actual: actualRows,
            }));
          }
        } catch {
          failures.push(failure("ARTIFACT_JSONL_INVALID", artifact.path));
        }
      }
    } catch {
      failures.push(failure("ARTIFACT_READ_FAILED", artifact.path));
    }
  }
  if (manifest !== null && B1_TRACKED_ARTIFACTS.every((path) => contentByPath.has(path))) {
    failures.push(...manifestSemanticFailures(manifest, contentByPath));
  }
  return {
    ok: failures.length === 0,
    failures,
    manifestPath: relative(process.cwd(), manifestPath),
    manifest,
    manifestSha256: manifestBytes === null ? null : sha256Buffer(manifestBytes),
  };
}

export function buildB1ArtifactsFromRaw(input, metadata = {}, options = {}) {
  return buildB1ArtifactBundle(analyzeB1RawRecords(input, options), metadata);
}

async function existingFiles(directory) {
  try {
    return await readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function parseJsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function parseJsonlFile(path) {
  const text = await readFile(path, "utf8");
  const records = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new Error(`invalid JSONL at ${path}:${index + 1}`);
    }
  }
  return records;
}

function arrayFromPayload(value, keys) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return null;
  for (const key of keys) {
    if (Array.isArray(value[key])) return value[key];
  }
  return null;
}

async function firstRawArray(rawRunDirectory, candidates, keys) {
  const files = new Set(await existingFiles(rawRunDirectory));
  for (const candidate of candidates) {
    if (!files.has(candidate)) continue;
    const path = join(rawRunDirectory, candidate);
    const payload = candidate.endsWith(".jsonl") ? await parseJsonlFile(path) : await parseJsonFile(path);
    const records = arrayFromPayload(payload, keys);
    if (records !== null) return { records, path };
    throw new Error(`${candidate} does not contain an expected record array`);
  }
  return { records: [], path: null };
}

const OPERATIONAL_PARTIAL_FAILURES = new Set(["request-attempts.jsonl:start_interval"]);

function isAllowlistedOperationalPartial(rawVerification) {
  const manifest = rawVerification.manifest;
  return manifest?.status === "PARTIAL"
    && manifest.raw_round_trip_qa_passed === true
    && manifest.request_budget_qa_passed === false
    && rawVerification.manifestSha256 !== null
    && rawVerification.failures.length > 0
    && rawVerification.failures.every((item) => OPERATIONAL_PARTIAL_FAILURES.has(item));
}

async function loadRawRun(rawRunDirectory, { allowOperationalPartial = false } = {}) {
  const rawVerification = await verifyRawRunManifest(rawRunDirectory);
  const acceptedOperationalPartial = allowOperationalPartial && isAllowlistedOperationalPartial(rawVerification);
  if ((!rawVerification.ok && !acceptedOperationalPartial)
    || rawVerification.manifest === null || rawVerification.manifestSha256 === null) {
    const details = rawVerification.failures.length > 0 ? `: ${rawVerification.failures.join(",")}` : "";
    throw new Error(`Lane B authoritative raw run verification failed${details}`);
  }
  const books = await firstRawArray(rawRunDirectory, [
    "source-book-samples.jsonl",
    "books.jsonl",
    "sample-books.jsonl",
    "raw-books.jsonl",
    "source-book-samples.json",
    "books.json",
  ], ["books", "samples", "records", "items"]);
  const observations = await firstRawArray(rawRunDirectory, [
    "source-token-observations.jsonl",
    "token-observations.jsonl",
    "observations.jsonl",
    "source-token-observations.json",
  ], ["observations", "tokens", "records", "items"]);
  const anomalies = await firstRawArray(rawRunDirectory, [
    "source-token-structure-anomalies.jsonl",
    "token-structure-anomalies.jsonl",
    "source-token-structure-anomalies.json",
  ], ["anomalies", "records", "items"]);
  const finalSelection = await firstRawArray(rawRunDirectory, [
    "final-sample-book-keys.jsonl",
    "final-sample-selection.jsonl",
    "final-sample-book-keys.json",
  ], ["selection", "selected", "records", "items"]);
  return {
    books: books.records,
    observations: observations.path === null ? undefined : observations.records,
    anomalies: anomalies.records,
    finalSelection: finalSelection.records,
    finalSelectionPresent: finalSelection.path !== null,
    manifest: rawVerification.manifest,
    manifestSha256: rawVerification.manifestSha256,
    verificationFailures: rawVerification.failures,
    verificationStatus: acceptedOperationalPartial ? "PARTIAL_OPERATIONAL_QA_FAILED" : "VERIFIED",
    sourceFiles: [books.path, observations.path, anomalies.path, finalSelection.path].filter(Boolean),
  };
}

function firstRecordValue(record, keys) {
  if (!record || typeof record !== "object") return undefined;
  for (const key of keys) {
    if (Object.hasOwn(record, key) && record[key] !== undefined) return record[key];
  }
  return undefined;
}

function applyFinalSelection(books, selectionRecords, selectionPresent = selectionRecords.length > 0) {
  if (!Array.isArray(selectionRecords)) throw new TypeError("final selection must be an array");
  if (!selectionPresent) return books;
  const selected = new Map();
  selectionRecords.forEach((record, index) => {
    const key = firstRecordValue(record, ["sampleBookKey", "sample_book_key", "bookIdentity", "book_identity", "identity"]);
    if (typeof key !== "string") throw new TypeError(`final selection record ${index + 1} requires a book identity`);
    const suppliedIndex = firstRecordValue(record, ["selectedSampleIndex", "selected_sample_index", "selectionIndex", "selection_index"]);
    const selectedIndex = suppliedIndex ?? index + 1;
    if (!Number.isSafeInteger(selectedIndex) || selectedIndex < 1) {
      throw new TypeError(`final selection record ${index + 1} has an invalid selected sample index`);
    }
    if (selected.has(key)) throw new Error(`duplicate final selection identity: ${key}`);
    selected.set(key, selectedIndex);
  });
  const matched = new Set();
  const enriched = books.map((book) => {
    const key = firstRecordValue(book, ["sampleBookKey", "sample_book_key", "bookIdentity", "book_identity", "identity"]);
    const selectedIndex = typeof key === "string" ? selected.get(key) : undefined;
    if (selectedIndex !== undefined) matched.add(key);
    return { ...book, selectedSampleIndex: selectedIndex ?? null };
  });
  if (matched.size !== selected.size) {
    const missing = [...selected.keys()].filter((key) => !matched.has(key));
    throw new Error(`final selection references unknown book identities: ${missing.join(", ")}`);
  }
  return enriched;
}

function overrideRunStatus(analysis, rawManifest) {
  const status = rawManifest?.status ?? rawManifest?.runStatus ?? rawManifest?.run_status ?? null;
  if (status === null) return analysis;
  const completed = new Set(["COMPLETE", "COMPLETED", "SUCCESS"]);
  if (!completed.has(String(status).toUpperCase())) {
    return {
      ...analysis,
      summary: { ...analysis.summary, laneBSampleStatus: analysis.books.length === 0 ? "BLOCKED" : "PARTIAL" },
    };
  }
  return analysis;
}

function firstManifestValue(manifest, keys) {
  if (!manifest || typeof manifest !== "object") return undefined;
  for (const key of keys) {
    if (Object.hasOwn(manifest, key) && manifest[key] !== undefined) return manifest[key];
  }
  return undefined;
}

function analysisOptionsFromRawManifest(rawManifest, options, finalSelectionProvided = false) {
  return {
    targetUniqueBooks: firstManifestValue(rawManifest, ["targetUniqueBooks", "target_unique_books"]),
    languageQuotaSatisfiedOrExhausted: firstManifestValue(rawManifest, [
      "languageQuotaSatisfiedOrExhausted",
      "language_quota_satisfied_or_exhausted",
    ]),
    rawRoundTripQaPassed: firstManifestValue(rawManifest, ["rawRoundTripQaPassed", "raw_round_trip_qa_passed"]),
    requestBudgetQaPassed: firstManifestValue(rawManifest, ["requestBudgetQaPassed", "request_budget_qa_passed"]),
    finalSelectionProvided,
    ...options,
  };
}

/**
 * CLI-facing B1 handoff. It reads only authoritative raw artifacts, emits the
 * complete derived bundle, and remains useful for failed/partial raw runs.
 * @param {{
 *   rawRunDir: string,
 *   outputDir: string,
 *   channelAppId: string,
 *   sourceScope?: string,
 *   runId?: string,
 *   generatedAt?: string,
 *   metadata?: Record<string, unknown>,
 *   options?: Record<string, unknown>,
 * }} params
 */
export async function analyzeLaneBRun({
  rawRunDir,
  outputDir,
  channelAppId,
  sourceScope = channelAppId,
  runId,
  generatedAt = new Date().toISOString(),
  metadata = {},
  options = {},
}) {
  const loaded = await loadAndAnalyzeLaneBRun({
    rawRunDir,
    channelAppId,
    sourceScope,
    options,
    allowOperationalPartial: true,
  });
  const { raw, analysis } = loaded;
  const finalAnalysis = overrideRunStatus(analysis, raw.manifest);
  const bundle = buildB1ArtifactBundle(finalAnalysis, {
    ...raw.manifest,
    ...metadata,
    runId: runId ?? raw.manifest?.runId ?? raw.manifest?.run_id ?? null,
    generatedAt,
    channelAppId,
    sourceScope: loaded.sourceScope,
    sourceRawFiles: raw.sourceFiles,
    rawManifestSha256: raw.manifestSha256,
    rawRunStatus: raw.manifest.status,
    rawStopReason: raw.manifest.stop_reason,
    rawVerificationStatus: raw.verificationStatus,
    rawVerificationFailures: raw.verificationFailures,
  });
  await writeB1ArtifactBundle(outputDir, bundle);
  return { ...finalAnalysis.summary, outputDir, manifest: bundle.manifest };
}

/**
 * Read and recompute a raw Lane B run without writing derived artifacts.
 * @param {{
 *   rawRunDir: string,
 *   channelAppId: string,
 *   sourceScope?: string,
 *   options?: Record<string, unknown>,
 *   allowOperationalPartial?: boolean,
 * }} params
 */
export async function loadAndAnalyzeLaneBRun({
  rawRunDir,
  channelAppId,
  sourceScope = channelAppId,
  options = {},
  allowOperationalPartial = false,
}) {
  if (typeof rawRunDir !== "string" || rawRunDir.length === 0) throw new TypeError("rawRunDir is required");
  if (typeof channelAppId !== "string" || channelAppId.length === 0) throw new TypeError("channelAppId is required");
  const raw = await loadRawRun(rawRunDir, { allowOperationalPartial });
  const authoritativeSourceScope = raw.manifest?.channel_app_id;
  if (typeof authoritativeSourceScope !== "string" || authoritativeSourceScope.length === 0) {
    throw new Error("Lane B verified raw manifest requires an exact channel_app_id");
  }
  if (channelAppId !== authoritativeSourceScope) {
    throw new Error("Lane B channelAppId does not match the verified raw-run manifest");
  }
  if (sourceScope !== authoritativeSourceScope) {
    throw new Error("Lane B sourceScope must equal the verified raw-run channel_app_id");
  }
  const scopedBooks = applyFinalSelection(raw.books, raw.finalSelection, raw.finalSelectionPresent)
    .map((book) => ({ ...book, sourceScope: authoritativeSourceScope, channelAppId: authoritativeSourceScope }));
  const scopedObservations = raw.observations?.map((observation) => ({
    ...observation,
    sourceScope: authoritativeSourceScope,
    channelAppId: authoritativeSourceScope,
  }));
  const analysis = analyzeB1RawRecords({
    books: scopedBooks,
    observations: scopedObservations,
    anomalies: raw.anomalies,
  }, analysisOptionsFromRawManifest(raw.manifest, options, raw.finalSelectionPresent));
  return { raw, analysis, sourceScope: authoritativeSourceScope };
}

export const renderLaneBReport = renderB1Report;

export { CSV_COLUMNS };
