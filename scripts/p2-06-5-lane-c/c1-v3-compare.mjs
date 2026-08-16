/**
 * P2-06.5 Lane C — v2 C/3 vs v3 description-only comparison.
 * Offline only.  Streams JSONL on /\\r?\\n/; never uses node:readline.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const REVIEWED_CONFIG_ID = "C";
export const REVIEWED_MAX_TEXT_TAGS = 3;
export const EXPECTED_POPULATION_PRECISION = 0.733;
export const PRECISION_TOLERANCE = 0.02;
export const CONTROL_TAGS = Object.freeze([
  "ct-v1-time-travel",
  "ct-v1-werewolf-alpha",
  "ct-v1-rebirth",
  "ct-v1-wealthy-ceo",
  "ct-v1-romance",
  "ct-v1-mafia",
  "ct-v1-revenge",
]);
export const ENDING_TAGS = Object.freeze(["ct-v1-happy-ending", "ct-v1-tragic-ending"]);
export const FOCUS_LOCALES = Object.freeze([
  { key: "英语", label: "英语" },
  { key: "raw19", label: "语种19" },
  { key: "raw20", label: "语种20" },
  { key: "法语", label: "法语" },
  { key: "西语", label: "西语" },
  { key: "葡语", label: "葡语" },
  { key: "德语", label: "德语" },
  { key: "韩语", label: "韩语" },
]);

function fail(message) {
  throw new Error(`P2-06.5 C1 v3 compare: ${message}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function csvCell(value) {
  const text = value === null || value === undefined
    ? ""
    : (Array.isArray(value) || typeof value === "object" ? JSON.stringify(value) : String(value));
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function rowsToCsv(rows, columns) {
  const header = columns.map(([name]) => csvCell(name)).join(",");
  const body = rows.map((row) => columns.map(([, key]) => csvCell(row[key])).join(","));
  return `${[header, ...body].join("\n")}\n`;
}

async function streamJsonl(path, onRow) {
  let pending = "";
  let index = 0;
  const handle = (raw) => {
    index += 1;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") return;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      fail(`${path} line ${index} is not JSON`);
    }
    onRow(row);
  };
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    pending += chunk;
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    for (const part of parts) handle(part);
  }
  if (pending !== "") handle(pending);
}

function localeKey(sourceLanguageName, rawLanguageScope, sourceLanguageCode) {
  if (sourceLanguageCode === '["number",19]') return "raw19";
  if (sourceLanguageCode === '["number",20]') return "raw20";
  return sourceLanguageName ?? "";
}

function edgeKey(sampleRowId, canonicalTagId) {
  return `${sampleRowId}\t${canonicalTagId}`;
}

export async function loadDescriptionOnlyEdges(evidencePath, {
  configId = REVIEWED_CONFIG_ID,
  maxTextTags = REVIEWED_MAX_TEXT_TAGS,
} = {}) {
  const edges = [];
  await streamJsonl(evidencePath, (row) => {
    if (row.configId !== configId || row.maxTextTags !== maxTextTags) return;
    if (!row.selectedAfterCap) return;
    if (!row.descriptionMatched || row.titleMatched) return;
    edges.push({
      sampleRowId: row.sampleRowId,
      canonicalTagId: row.canonicalTagId,
      sourceLanguageName: row.sourceLanguageName,
      sourceLanguageCode: row.sourceLanguageCode,
      rawLanguageScope: row.rawLanguageScope,
      novelIdentity: row.novelIdentity,
    });
  });
  return edges;
}

function countByTag(edges) {
  const counts = new Map();
  for (const edge of edges) counts.set(edge.canonicalTagId, (counts.get(edge.canonicalTagId) ?? 0) + 1);
  return counts;
}

function countByLocale(edges) {
  const counts = new Map();
  for (const edge of edges) {
    const key = localeKey(edge.sourceLanguageName, edge.rawLanguageScope, edge.sourceLanguageCode);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function changeReasonFor(tagId, overlayRules, endingZeroed) {
  if (endingZeroed.has(tagId)) {
    return "GENERIC_KEYWORD_HOMONYM_FULL_DISABLE; description independent trigger expected to reach zero";
  }
  const reasons = [...new Set((overlayRules ?? [])
    .filter((rule) => rule.canonicalTagId === tagId)
    .map((rule) => rule.changeReason))];
  return reasons.join(";") || "UNCHANGED";
}

export async function compareC1V3({
  v2EvidencePath,
  v3EvidencePath,
  v2Summary,
  v3Summary,
  hiddenReferencePath,
  verdictsPath,
  overlayRules = [],
}) {
  const [v2Edges, v3Edges, hiddenBytes, verdictBytes] = await Promise.all([
    loadDescriptionOnlyEdges(v2EvidencePath),
    loadDescriptionOnlyEdges(v3EvidencePath),
    readFile(hiddenReferencePath, "utf8"),
    readFile(verdictsPath, "utf8"),
  ]);
  const v2Keys = new Set(v2Edges.map((edge) => edgeKey(edge.sampleRowId, edge.canonicalTagId)));
  const v3Keys = new Set(v3Edges.map((edge) => edgeKey(edge.sampleRowId, edge.canonicalTagId)));
  const removedKeys = [...v2Keys].filter((key) => !v3Keys.has(key));
  const affectedNovels = new Set(removedKeys.map((key) => key.split("\t")[0]));
  const v2ByTag = countByTag(v2Edges);
  const v3ByTag = countByTag(v3Edges);
  const v2ByLocale = countByLocale(v2Edges);
  const v3ByLocale = countByLocale(v3Edges);

  const endingZeroed = new Set();
  for (const tagId of ENDING_TAGS) {
    if ((v3ByTag.get(tagId) ?? 0) === 0) endingZeroed.add(tagId);
  }

  const hiddenRows = hiddenBytes.split(/\r?\n/u).filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
  const verdicts = JSON.parse(verdictBytes);
  const verdictByEdge = new Map();
  for (const row of verdicts.edge_verdicts ?? []) {
    verdictByEdge.set(`${row.review_id}\t${row.canonical_stable_id}`, row);
  }

  const populationReviewed = [];
  const tagReview = new Map();
  for (const hidden of hiddenRows) {
    if (hidden.sample_stratum !== "POPULATION") continue;
    for (const edge of hidden.description_only_edges ?? []) {
      const verdict = verdictByEdge.get(`${hidden.novel_review_id}\t${edge.canonical_stable_id}`);
      if (!verdict) fail(`missing verdict for ${hidden.novel_review_id}/${edge.canonical_stable_id}`);
      const record = {
        sampleRowId: hidden.sample_row_id,
        canonicalTagId: edge.canonical_stable_id,
        verdict: verdict.verdict,
        key: edgeKey(hidden.sample_row_id, edge.canonical_stable_id),
      };
      populationReviewed.push(record);
      const stats = tagReview.get(edge.canonical_stable_id) ?? { supported: 0, total: 0 };
      stats.total += 1;
      if (verdict.verdict === "SUPPORTED") stats.supported += 1;
      tagReview.set(edge.canonical_stable_id, stats);
    }
  }

  const v2Reviewed = populationReviewed;
  const v3Reviewed = populationReviewed.filter((row) => v3Keys.has(row.key));
  const precisionOf = (rows) => {
    if (rows.length === 0) return null;
    return rows.filter((row) => row.verdict === "SUPPORTED").length / rows.length;
  };
  const v2Precision = precisionOf(v2Reviewed);
  const v3Precision = precisionOf(v3Reviewed);
  if (v3Precision === null) fail("no surviving population-layer reviewed edges");
  const precisionDelta = v3Precision - EXPECTED_POPULATION_PRECISION;
  const precisionWithinTolerance = Math.abs(precisionDelta) <= PRECISION_TOLERANCE;

  const control = CONTROL_TAGS.map((tagId) => {
    const v2Count = v2ByTag.get(tagId) ?? 0;
    const v3Count = v3ByTag.get(tagId) ?? 0;
    const dropRatio = v2Count === 0 ? 0 : (v2Count - v3Count) / v2Count;
    return { canonicalTagId: tagId, v2Count, v3Count, dropRatio, collapsed: v2Count >= 8 && dropRatio > 0.15 };
  });
  const collapsed = control.filter((row) => row.collapsed);
  if (collapsed.length > 0) {
    fail(`high-precision control tags collapsed: ${collapsed.map((row) => `${row.canonicalTagId}:${row.v2Count}->${row.v3Count}`).join(",")}`);
  }

  const allTags = [...new Set([...v2ByTag.keys(), ...v3ByTag.keys()])].sort();
  const tagRows = allTags.map((canonicalTag) => {
    const review = tagReview.get(canonicalTag);
    return {
      canonical_tag: canonicalTag,
      v2_description_edges: v2ByTag.get(canonicalTag) ?? 0,
      v3_description_edges: v3ByTag.get(canonicalTag) ?? 0,
      removed_edges: (v2ByTag.get(canonicalTag) ?? 0) - (v3ByTag.get(canonicalTag) ?? 0),
      v2_review_precision_if_available: review ? (review.supported / review.total).toFixed(4) : "",
      change_reason: changeReasonFor(canonicalTag, overlayRules, endingZeroed),
    };
  });
  const localeRows = FOCUS_LOCALES.map(({ key, label }) => ({
    locale: label,
    v2_description_edges: v2ByLocale.get(key) ?? 0,
    v3_description_edges: v3ByLocale.get(key) ?? 0,
    removed_edges: (v2ByLocale.get(key) ?? 0) - (v3ByLocale.get(key) ?? 0),
  }));

  const v2Config = (v2Summary?.configurations ?? []).find((row) => row.config_id === "C" && row.max_text_tags === 3)
    ?? v2Summary?.summaries?.find((row) => row.configId === "C" && row.maxTextTags === 3);
  const v3Config = (v3Summary?.configurations ?? []).find((row) => row.config_id === "C" && row.max_text_tags === 3)
    ?? v3Summary?.summaries?.find((row) => (row.config_id ?? row.configId) === "C" && (row.max_text_tags ?? row.maxTextTags) === 3);
  const metric = (row, snake, camel) => row?.[snake] ?? row?.[camel] ?? row?.overall?.[camel];

  const comparison = {
    v2_description_only_edges: v2Edges.length,
    v3_description_only_edges: v3Edges.length,
    removed_description_edges: removedKeys.length,
    removed_candidate_edges: removedKeys.length,
    affected_novel_count: affectedNovels.size,
    coverage_delta: v3Edges.length - v2Edges.length,
    ending_description_trigger_zeroed: [...endingZeroed],
    predicted_precision: EXPECTED_POPULATION_PRECISION,
    measured_precision_on_surviving_reviewed_edges: v3Precision,
    predicted_surviving_population_edges: 330,
    measured_surviving_population_edges: v3Reviewed.length,
    v2_population_reviewed_edges: v2Reviewed.length,
    v2_population_precision: v2Precision,
    precision_within_tolerance: precisionWithinTolerance,
    control,
  };

  return {
    comparison,
    tagRows,
    localeRows,
    tagCsv: rowsToCsv(tagRows, [
      ["canonical_tag", "canonical_tag"],
      ["v2_description_edges", "v2_description_edges"],
      ["v3_description_edges", "v3_description_edges"],
      ["removed_edges", "removed_edges"],
      ["v2_review_precision_if_available", "v2_review_precision_if_available"],
      ["change_reason", "change_reason"],
    ]),
    localeCsv: rowsToCsv(localeRows, [
      ["locale", "locale"],
      ["v2_description_edges", "v2_description_edges"],
      ["v3_description_edges", "v3_description_edges"],
      ["removed_edges", "removed_edges"],
    ]),
    v2Config,
    v3Config,
    metric,
    fingerprint: sha256(JSON.stringify({
      v2: v2Edges.length, v3: v3Edges.length, removed: removedKeys.length, precision: v3Precision,
    })),
  };
}
