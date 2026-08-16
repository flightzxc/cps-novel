import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { loadAndAnalyzeLaneBRun } from "./artifacts.mjs";
import { buildB2SourceGroupTemplate } from "./b2-input.mjs";
import { verifyOwnerTimingWaiver } from "./owner-waiver.mjs";
import { parseCsv } from "../p2-06-5-lane-a/owner-final.mjs";

const EXPECTED_MATRIX_SHA256 = "1f1cf172b476d44841cbff234bbbfbd6b182ec7658496cbcba3da0f1cf1a134c";
const EXPECTED_COUNTS = Object.freeze({ MAP: 194, DEFER: 52, IGNORE_DROP: 37, GAP: 2 });
const OWNER_TOKENS = Object.freeze({
  xianxia: new Set(["仙侠情缘", "仙侠武侠", "武侠仙侠", "仙俠情緣", "仙俠武俠"]),
  fanfiction: new Set(["动漫同人", "動漫世界"]),
});

function fail(message) { throw new Error(`P2-06.5 Lane B Owner Final: ${message}`); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function base64(value) { return Buffer.from(value, "utf8").toString("base64"); }
function exactTuple(scope, language, token) { return JSON.stringify([scope, language, token]); }

function csvCell(value) {
  const text = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function rowsToCsv(columns, rows) {
  return `${[columns, ...rows.map((row) => columns.map((column) => row[column]))].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function canonicalIndex(canonical) {
  if (canonical?.artifact_status !== "FINAL" || canonical?.count !== 123 || !Array.isArray(canonical.tags)) fail("CanonicalTag artifact is not Final 123");
  const byId = new Map();
  const bySlug = new Map();
  for (const tag of canonical.tags) {
    if (typeof tag.stable_id !== "string" || typeof tag.slug !== "string" || tag.status !== "public") fail("invalid final CanonicalTag row");
    if (byId.has(tag.stable_id) || bySlug.has(tag.slug)) fail("duplicate CanonicalTag identity");
    byId.set(tag.stable_id, tag); bySlug.set(tag.slug, tag);
  }
  return { byId, bySlug };
}

function finalSampleBookIds(raw) {
  const rows = raw.finalSelection.map((row, index) => ({ id: row.sampleBookKey, order: row.selectedSampleIndex ?? index + 1 }));
  rows.sort((left, right) => left.order - right.order);
  const ids = rows.map(({ id }) => id);
  if (ids.length !== 10_000 || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== "string" || id.length === 0)) fail("final sample identity set is not exact 10k");
  return ids;
}

function targetId(row, slug, canonical) {
  const explicit = row.final_target_canonical_id;
  const id = explicit && !explicit.includes("+") ? explicit : `ct-v1-${slug}`;
  const tag = canonical.byId.get(id) ?? canonical.bySlug.get(slug);
  if (!tag) fail(`mapping target is absent from Final CanonicalTag: ${slug}`);
  return tag;
}

function matrixEdges(rows, canonical) {
  const children = rows.filter((row) => row.parent_mapping_key);
  const edgeRows = children.length > 0 ? children : [rows[0]];
  return edgeRows.map((row) => {
    const slug = row.final_target.replace(/^NEW:/u, "");
    if (!slug || slug.startsWith("(")) fail(`unresolved mapping target for ${row.exact_raw_token}`);
    const tag = targetId(row, slug, canonical);
    return { canonical_stable_id: tag.stable_id, canonical_slug: tag.slug, canonical_display_name_zh: tag.display_name_zh };
  });
}

function ownerDecision(row, canonical) {
  const token = row.exact_raw_token;
  if (token === "Для взрослых") {
    const tag = canonical.bySlug.get("mature-content");
    return { disposition: "MAP", edges: [{ canonical_stable_id: tag.stable_id, canonical_slug: tag.slug, canonical_display_name_zh: tag.display_name_zh }], reason: "Owner Final: Russian source token maps conservatively to mature-content.", risk: "SOURCE_LABEL_MEANING_REQUIRES_FUTURE_RUSSIAN_OPERATIONS_CONFIRMATION" };
  }
  if (OWNER_TOKENS.xianxia.has(token)) {
    const tag = canonical.bySlug.get("xianxia");
    return { disposition: "MAP", edges: [{ canonical_stable_id: tag.stable_id, canonical_slug: tag.slug, canonical_display_name_zh: tag.display_name_zh }], reason: "Owner Final: xianxia is a distinct CanonicalTag.", risk: "LOW_FREQUENCY_SCOPE_RETAINED_BY_EXPLICIT_OWNER_DECISION" };
  }
  if (OWNER_TOKENS.fanfiction.has(token)) return { disposition: "GAP", edges: [], reason: "Owner Final: fanfiction is a documented v1 taxonomy gap.", risk: "IP_COMPLIANCE_BOUNDARY_NOT_FROZEN" };
  if (token === "穿越重生") return { disposition: "DEFER", edges: [], reason: "Owner Final forbids supplier-bucket hard 1:N; book-level text classification must separate time-travel and rebirth.", risk: "HARD_1_TO_N_WOULD_CREATE_DETERMINISTIC_FALSE_POSITIVES" };
  if (token === "ตำนาน") return { disposition: "DEFER", edges: [], reason: "Owner Final closes the low-frequency item conservatively without creating taxonomy.", risk: "INSUFFICIENT_SAMPLE" };
  fail(`unresolved OWNER_REVIEW token ${JSON.stringify(token)}`);
}

function crossReviewDecision(rows, canonical) {
  const row = rows[0];
  if (row.final_verdict === "OWNER_REVIEW") return ownerDecision(row, canonical);
  if (row.final_verdict === "ACCEPT_MAP" || row.final_verdict === "ACCEPT_NEW_CANONICAL") {
    return { disposition: "MAP", edges: matrixEdges(rows, canonical), reason: row.evidence_basis, risk: row.minority_reason || "NONE_IDENTIFIED" };
  }
  if (row.final_verdict === "DEFER_SOURCE_DIRTY") return { disposition: "DEFER", edges: [], reason: row.evidence_basis, risk: row.minority_reason || "SOURCE_BUCKET_SEMANTICALLY_DIRTY" };
  if (row.final_verdict === "ACCEPT_IGNORE") return { disposition: "IGNORE_DROP", subtype: "IGNORE_NON_CONTENT", edges: [], reason: row.evidence_basis, risk: row.minority_reason || "NONE_IDENTIFIED" };
  if (row.final_verdict === "ACCEPT_DROP") return { disposition: "IGNORE_DROP", subtype: "DROP_LOW_VALUE", edges: [], reason: row.evidence_basis, risk: row.minority_reason || "LOW_RETRIEVAL_VALUE" };
  fail(`unsupported matrix verdict ${row.final_verdict}`);
}

function finalReviewDecision(rows, canonical) {
  const row = rows[0];
  if (row.owner_review_required === "true") {
    if (row.final_verdict === "OWNER_REVIEW") return { ...ownerDecision(row, canonical), decision_source: "OWNER_FINAL" };
    const decision = crossReviewDecision(rows, canonical);
    if (row.scope_label === "EN" && row.exact_raw_token === "Young Adult") return { ...decision, decision_source: "OWNER_FINAL", risk: "NOT_CONTENT_SAFETY_EVIDENCE" };
    return { ...decision, decision_source: "OWNER_FINAL" };
  }
  return { ...crossReviewDecision(rows, canonical), decision_source: "CROSS_REVIEW_FINAL" };
}

const COMMON_COLUMNS = [
  "mapping_key", "group_identity", "channel_app_id", "raw_language_scope", "scope_label_non_authoritative",
  "exact_raw_token", "exact_raw_token_utf8_base64", "exact_raw_token_sha256", "book_frequency", "occurrence_count",
  "carrier_book_count", "representative_book_ids_json", "final_disposition", "decision_source", "consensus_tier",
  "review_confidence", "reason", "risk",
];
const MAPPING_COLUMNS = ["record_type", ...COMMON_COLUMNS, "edge_index", "fanout", "canonical_stable_id", "canonical_slug", "canonical_display_name_zh", "candidate_status"];

function baseRow({ key, matrixRow, group, decision }) {
  return {
    mapping_key: key,
    group_identity: group.group_identity,
    channel_app_id: group.channel_app_id,
    raw_language_scope: group.raw_language_scope,
    scope_label_non_authoritative: matrixRow.scope_label,
    exact_raw_token: group.exact_raw_token,
    exact_raw_token_utf8_base64: base64(group.exact_raw_token),
    exact_raw_token_sha256: sha256(group.exact_raw_token),
    book_frequency: group.frequency,
    occurrence_count: group.occurrence_count,
    carrier_book_count: group.carrier_book_ids.length,
    representative_book_ids_json: group.samples.map(({ book_identity: id }) => id),
    final_disposition: decision.disposition === "IGNORE_DROP" ? decision.subtype : decision.disposition === "MAP" ? "APPROVED_MAP_CANDIDATE" : decision.disposition === "DEFER" ? "DEFER_SOURCE_DIRTY" : "CANONICAL_GAP",
    decision_source: decision.decision_source,
    consensus_tier: matrixRow.consensus_tier,
    review_confidence: matrixRow.final_confidence,
    reason: decision.reason,
    risk: decision.risk,
  };
}

function logicalMatrixGroups(rows) {
  const byLogical = new Map();
  const matrixKeys = new Set(rows.map(({ mapping_key: key }) => key));
  for (const row of rows) {
    if (!row.mapping_key || matrixKeys.size !== rows.length) fail("matrix mapping_key must be unique");
    const key = row.parent_mapping_key || row.mapping_key;
    const bucket = byLogical.get(key) ?? [];
    bucket.push(row); byLogical.set(key, bucket);
  }
  for (const [key, group] of byLogical) {
    const parent = group.find((row) => row.mapping_key === key);
    if (!parent) fail(`1:N parent is missing for ${key}`);
    for (const row of group) {
      if (row.raw_language_scope !== parent.raw_language_scope || row.exact_raw_token !== parent.exact_raw_token || row.book_frequency !== parent.book_frequency) fail(`1:N facts differ for ${key}`);
    }
  }
  return byLogical;
}

function coverage(records, finalBookIds) {
  const byBook = new Map(finalBookIds.map((id) => [id, []]));
  let totalOccurrences = 0; let mappedOccurrences = 0;
  for (const record of records) {
    totalOccurrences += record.group.occurrence_count;
    if (record.decision.disposition === "MAP") mappedOccurrences += record.group.occurrence_count;
    for (const id of record.group.carrier_book_ids) byBook.get(id)?.push(record.decision.disposition);
  }
  const atLeastOne = [...byBook.values()].filter((items) => items.includes("MAP")).length;
  const strict = [...byBook.values()].filter((items) => items.length > 0 && items.every((item) => item === "MAP")).length;
  return {
    mapping_coverage_by_token: records.filter(({ decision }) => decision.disposition === "MAP").length / records.length,
    mapping_coverage_by_occurrence: mappedOccurrences / totalOccurrences,
    mapping_coverage_by_book_at_least_one: atLeastOne / finalBookIds.length,
    mapping_coverage_by_book_strict_all_tokens: strict / finalBookIds.length,
    mapped_book_count_at_least_one: atLeastOne,
    mapped_book_count_strict_all_tokens: strict,
  };
}

async function writeBundle(outputDir, files, manifest) {
  try { await lstat(outputDir); fail("output directory already exists"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  await mkdir(dirname(outputDir), { recursive: true });
  const staging = await mkdtemp(join(dirname(outputDir), `.${basename(outputDir)}.staging-`));
  try {
    const descriptors = [];
    for (const [name, content, rows] of files) {
      await writeFile(join(staging, name), content, { encoding: "utf8", flag: "wx" });
      descriptors.push({ filename: name, bytes: Buffer.byteLength(content), sha256: sha256(content), row_count: rows });
    }
    const finalManifest = { ...manifest, files: descriptors };
    await writeFile(join(staging, "B2_FINAL_MANIFEST.json"), `${JSON.stringify(finalManifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    if ((await readdir(staging)).length !== files.length + 1) fail("staged artifact set mismatch");
    await rename(staging, outputDir);
    return finalManifest;
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}

export async function runB2OwnerFinal({ canonicalPath, canonicalSha256, matrixPath, rawRunDir, waiverPath, channelAppId, outputDir } = {}) {
  const waiver = await verifyOwnerTimingWaiver({ rawRunDir, waiverPath });
  const [canonicalBytes, matrixBytes, loaded] = await Promise.all([
    readFile(canonicalPath),
    readFile(matrixPath),
    loadAndAnalyzeLaneBRun({ rawRunDir, channelAppId, allowOperationalPartial: true }),
  ]);
  if (sha256(canonicalBytes) !== canonicalSha256) fail("CanonicalTag SHA-256 mismatch");
  if (sha256(matrixBytes) !== EXPECTED_MATRIX_SHA256) fail("cross-review matrix SHA-256 changed");
  if (loaded.raw.manifestSha256 !== waiver.verification.manifestSha256) fail("raw evidence lineage mismatch");
  const canonical = canonicalIndex(JSON.parse(canonicalBytes.toString("utf8")));
  const matrixGroups = logicalMatrixGroups(parseCsv(matrixBytes.toString("utf8")));
  const sourceGroups = buildB2SourceGroupTemplate({ inventory: loaded.analysis.inventory, evidence: loaded.analysis.evidence, cooccurrence: loaded.analysis.cooccurrence });
  if (sourceGroups.length !== 285 || matrixGroups.size !== 285 || loaded.analysis.inventory.length !== 285) fail("B2 logical universe must be 285");
  const authoritative = new Map(loaded.analysis.inventory.map((item, index) => [item.tokenKeySha256, { inventory: item, group: sourceGroups[index] }]));
  const records = [];
  for (const [key, matrixRows] of matrixGroups) {
    const source = authoritative.get(key);
    if (!source) fail(`matrix key absent from authoritative B1: ${key}`);
    const row = matrixRows[0];
    const { inventory, group } = source;
    if (inventory.rawLanguageScope !== row.raw_language_scope || inventory.exactRawToken !== row.exact_raw_token || String(inventory.bookFrequency) !== row.book_frequency) fail(`matrix facts differ from B1 for ${key}`);
    if (exactTuple(group.channel_app_id, group.raw_language_scope, group.exact_raw_token) !== exactTuple(channelAppId, row.raw_language_scope, row.exact_raw_token)) fail(`exact identity mismatch for ${key}`);
    const decision = finalReviewDecision(matrixRows, canonical);
    records.push({ key, matrixRows, matrixRow: row, group, decision });
  }
  const counts = { MAP: 0, DEFER: 0, IGNORE_DROP: 0, GAP: 0 };
  for (const { decision } of records) counts[decision.disposition] += 1;
  if (JSON.stringify(counts) !== JSON.stringify(EXPECTED_COUNTS)) fail(`final counts differ: ${JSON.stringify(counts)}`);
  const executableMappingEdges = records.flatMap((record) => record.decision.edges.map((edge, index) => ({ record_type: "MAPPING_EDGE", ...baseRow(record), edge_index: index + 1, fanout: record.decision.edges.length, ...edge, candidate_status: "APPROVED_OFFLINE_CANDIDATE_ONLY" })));
  const compoundGroupSummaries = records
    .filter(({ decision }) => decision.edges.length > 1)
    .map((record) => ({ record_type: "COMPOUND_GROUP_SUMMARY", ...baseRow(record), edge_index: "", fanout: record.decision.edges.length, canonical_stable_id: "", canonical_slug: "", canonical_display_name_zh: "", candidate_status: "OFFLINE_GROUP_SUMMARY_NOT_AN_EDGE" }));
  const mappingRows = [...executableMappingEdges, ...compoundGroupSummaries];
  if (executableMappingEdges.length !== 196 || compoundGroupSummaries.length !== 2 || mappingRows.length !== 198) fail(`expected 196 executable edges + 2 compound summaries = 198 rows, found ${executableMappingEdges.length} + ${compoundGroupSummaries.length}`);
  const deferredRows = records.filter(({ decision }) => decision.disposition === "DEFER").map(baseRow);
  const ignoredRows = records.filter(({ decision }) => decision.disposition === "IGNORE_DROP").map(baseRow);
  const gapRows = records.filter(({ decision }) => decision.disposition === "GAP").map(baseRow);
  const finalBookIds = finalSampleBookIds(loaded.raw);
  const coverageMetrics = coverage(records, finalBookIds);
  const summary = {
    LANE_B_B2_STATUS: "COMPLETE_OFFLINE_CANDIDATES_GENERATED",
    B2_MAPPING_KEY_TOTAL: records.length,
    B2_ACCEPT_MAP: counts.MAP,
    B2_MAPPING_CANDIDATE_ROW_COUNT: mappingRows.length,
    B2_EXECUTABLE_MAPPING_EDGE_COUNT: executableMappingEdges.length,
    B2_DEFER: counts.DEFER,
    B2_IGNORE_DROP: counts.IGNORE_DROP,
    B2_CANONICAL_GAP: counts.GAP,
    B2_OWNER_REVIEW_REMAINING: 0,
    ...coverageMetrics,
    AUTO_WRITE_AUTHORIZED: "NO",
  };
  const report = `# P2-06.5 Lane B B2 Owner Final\n\n` +
    `## Technical summary\n\nThe 285 exact B1 mapping groups are closed as offline candidates: **${counts.MAP} mapped**, **${counts.DEFER} deferred**, **${counts.IGNORE_DROP} ignored/dropped**, and **${counts.GAP} Canonical gaps**. No production mapping was created.\n\n` +
    `B1 remains \`PARTIAL\`. The single-run timing waiver accepts only the six recorded 999ms intervals; the global >=1000ms contract is unchanged.\n\n` +
    `## Exact mapping outcome\n\n| disposition | logical groups |\n| --- | ---: |\n| APPROVED_MAP_CANDIDATE | ${counts.MAP} |\n| DEFER_SOURCE_DIRTY | ${counts.DEFER} |\n| IGNORE_NON_CONTENT / DROP_LOW_VALUE | ${counts.IGNORE_DROP} |\n| CANONICAL_GAP | ${counts.GAP} |\n\n` +
    `The ${counts.MAP} mapped groups produce ${executableMappingEdges.length} executable edges. The CSV has ${mappingRows.length} rows because each of the two exact 科幻末世 1:N groups also has one non-edge group-summary row; all ${executableMappingEdges.length} nonblank targets are foreign keys to CanonicalTag v1. 穿越重生 has no hard 1:N.\n\n` +
    `## Coverage\n\n- Token-group coverage: ${(coverageMetrics.mapping_coverage_by_token * 100).toFixed(2)}%\n- Occurrence-weighted mapping coverage: ${(coverageMetrics.mapping_coverage_by_occurrence * 100).toFixed(2)}%\n- Books with at least one mapped source token: ${coverageMetrics.mapped_book_count_at_least_one}/10000 (${(coverageMetrics.mapping_coverage_by_book_at_least_one * 100).toFixed(2)}%)\n- Books whose complete observed token set is mapped: ${coverageMetrics.mapped_book_count_strict_all_tokens}/10000 (${(coverageMetrics.mapping_coverage_by_book_strict_all_tokens * 100).toFixed(2)}%)\n\n` +
    `## Fixed status block\n\n\`\`\`text\n${Object.entries(summary).filter(([key]) => /^[A-Z]/u.test(key)).map(([key, value]) => `${key}=${value}`).join("\n")}\n\`\`\`\n`;
  const files = [
    ["mapping-candidates-final.csv", rowsToCsv(MAPPING_COLUMNS, mappingRows), mappingRows.length],
    ["deferred-source-dirty.csv", rowsToCsv(COMMON_COLUMNS, deferredRows), deferredRows.length],
    ["ignored-source-tokens.csv", rowsToCsv(COMMON_COLUMNS, ignoredRows), ignoredRows.length],
    ["canonical-gaps.csv", rowsToCsv(COMMON_COLUMNS, gapRows), gapRows.length],
    ["B2_FINAL_REPORT.md", report, null],
    ["b2-final-summary.json", `${JSON.stringify(summary, null, 2)}\n`, null],
  ];
  const manifest = await writeBundle(outputDir, files, {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    status: summary.LANE_B_B2_STATUS,
    canonical_sha256: canonicalSha256,
    cross_review_matrix_sha256: sha256(matrixBytes),
    raw_manifest_sha256: waiver.verification.manifestSha256,
    owner_timing_waiver_sha256: waiver.waiverSha256,
    raw_run_status: "PARTIAL",
    raw_verification_status: waiver.status,
    summary,
  });
  return { summary, manifest, outputDir };
}

export async function verifyB2FinalBundle(outputDir) {
  const manifestBytes = await readFile(join(outputDir, "B2_FINAL_MANIFEST.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const failures = [];
  const disk = (await readdir(outputDir)).sort();
  const expected = [...manifest.files.map(({ filename }) => filename), "B2_FINAL_MANIFEST.json"].sort();
  if (JSON.stringify(disk) !== JSON.stringify(expected)) failures.push("ARTIFACT_SET_MISMATCH");
  for (const descriptor of manifest.files) {
    try {
      const bytes = await readFile(join(outputDir, descriptor.filename));
      if (bytes.length !== descriptor.bytes) failures.push(`${descriptor.filename}:bytes`);
      if (sha256(bytes) !== descriptor.sha256) failures.push(`${descriptor.filename}:sha256`);
    } catch { failures.push(`${descriptor.filename}:missing`); }
  }
  if (manifest.summary?.B2_MAPPING_KEY_TOTAL !== 285 || manifest.summary?.B2_OWNER_REVIEW_REMAINING !== 0) failures.push("SUMMARY_SEMANTICS");
  return { ok: failures.length === 0, failures, manifestSha256: sha256(manifestBytes), manifest };
}

export { EXPECTED_COUNTS, MAPPING_COLUMNS, COMMON_COLUMNS };
