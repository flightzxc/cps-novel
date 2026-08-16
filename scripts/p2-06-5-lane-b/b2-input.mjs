import { readFile, writeFile } from "node:fs/promises";

import { loadAndAnalyzeLaneBRun } from "./artifacts.mjs";
import {
  evaluationSampleCount,
  sourceGroupEvidenceSha256,
  sourceMappingGroupIdentity,
} from "./b2-mapping.mjs";
import { verifyRawRunManifest } from "./run-store.mjs";

function parseJsonl(text, label) {
  return text.split(/\r?\n/u).filter((line) => line.length > 0).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`${label}:${index + 1} is not valid JSONL`); }
  });
}

function requireCompleteCarrierIds(item) {
  if (!Array.isArray(item.carrierBookKeys)) {
    throw new TypeError("inventory carrierBookKeys must be a complete array");
  }
  const carrierBookIds = item.carrierBookKeys.map((value, index) => {
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`inventory carrierBookKeys[${index}] must be an exact non-empty string`);
    }
    return value;
  });
  if (new Set(carrierBookIds).size !== carrierBookIds.length) {
    throw new Error("inventory carrierBookKeys contains duplicate identities");
  }
  if (carrierBookIds.length !== item.bookFrequency) {
    throw new Error("inventory carrierBookKeys must contain every carrier book identity");
  }
  return carrierBookIds;
}

function evidenceSample(row) {
  if (typeof row.sampleBookKey !== "string" || row.sampleBookKey.length === 0) {
    throw new TypeError("B1 evidence sampleBookKey must be an exact non-empty string");
  }
  if (typeof row.externalBookId !== "string" || row.externalBookId.length === 0) {
    throw new TypeError("B1 evidence externalBookId must be an exact non-empty string view");
  }
  return {
    book_identity: row.sampleBookKey,
    external_book_id: row.externalBookId,
    external_book_id_raw_json: stableJsonText(row.externalBookIdRaw),
    title: row.titleRaw ?? "",
    title_raw_json: stableJsonText(row.titleRaw ?? null),
    description: row.descriptionTextView ?? (typeof row.descriptionRaw === "string" ? row.descriptionRaw : ""),
    description_present: row.descriptionPresent ?? row.descriptionRaw !== null,
    description_raw_json: row.descriptionJsonValueJson ?? JSON.stringify(row.descriptionRaw ?? null),
    cooccurring_exact_tokens: row.allExactTokens ?? [],
  };
}

function stableJsonText(value) {
  if (Array.isArray(value)) return `[${value.map(stableJsonText).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJsonText(value[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("B2 source-group evidence must be a JSON value");
  return encoded;
}

function proposalTemplate() {
  return {
    canonical_tag_id: "",
    target_locale: "",
    scores: {
      literal_meaning: null,
      sample_semantic_evidence: null,
      cooccurrence_evidence: null,
      canonical_definition_fit: null,
      filter_semantic_fit: null,
    },
    evidence: {
      only_lexical: false,
      only_translation: false,
      polysemous: false,
      sample_conflict: false,
    },
    reason: "",
    risk: "",
  };
}

/**
 * Generate an offline evidence packet from B1 only. It deliberately emits no
 * guessed CanonicalTag edge; a reviewer/model must fill `proposals` or one
 * explicit unmapped reason before B2 can compile candidates.
 */
export function buildB2SourceGroupTemplate({ inventory, evidence, cooccurrence } = {}) {
  if (!Array.isArray(inventory) || !Array.isArray(evidence) || !Array.isArray(cooccurrence)) {
    throw new TypeError("inventory, evidence and cooccurrence must be arrays");
  }
  const evidenceByToken = new Map();
  for (const row of evidence) {
    const bucket = evidenceByToken.get(row.tokenKeySha256) ?? [];
    bucket.push(row);
    evidenceByToken.set(row.tokenKeySha256, bucket);
  }
  const cooccurrenceByToken = new Map();
  for (const row of cooccurrence) {
    const forward = cooccurrenceByToken.get(row.tokenKeyA) ?? [];
    forward.push({ exact_raw_token: row.exactRawTokenB, count: row.nAB, jaccard: row.jaccard, conditional_probability: row.pBGivenA });
    cooccurrenceByToken.set(row.tokenKeyA, forward);
    const reverse = cooccurrenceByToken.get(row.tokenKeyB) ?? [];
    reverse.push({ exact_raw_token: row.exactRawTokenA, count: row.nAB, jaccard: row.jaccard, conditional_probability: row.pAGivenB });
    cooccurrenceByToken.set(row.tokenKeyB, reverse);
  }
  return inventory.map((item) => {
    const carrierBookIds = requireCompleteCarrierIds(item);
    const carrierSet = new Set(carrierBookIds);
    const allEvidence = (evidenceByToken.get(item.tokenKeySha256) ?? [])
      .filter(({ sampleBookKey }) => carrierSet.has(sampleBookKey))
      .sort((left, right) => (
        (left.evidenceRank ?? Number.MAX_SAFE_INTEGER) - (right.evidenceRank ?? Number.MAX_SAFE_INTEGER)
        || String(left.sampleBookKey).localeCompare(String(right.sampleBookKey))
      ));
    const samplesNeeded = evaluationSampleCount(item.bookFrequency);
    const samples = allEvidence.slice(0, samplesNeeded).map(evidenceSample);
    const record = {
      channel_app_id: item.sourceScope,
      raw_language_scope: item.rawLanguageScope,
      exact_raw_token: item.exactRawToken,
      frequency: item.bookFrequency,
      occurrence_count: item.occurrenceCount,
      carrier_book_ids: carrierBookIds,
      carrier_book_ids_complete: true,
      evaluation_sample_count: samplesNeeded,
      samples,
      cooccurrence: (cooccurrenceByToken.get(item.tokenKeySha256) ?? []).sort((left, right) => (
        right.count - left.count || (left.exact_raw_token < right.exact_raw_token ? -1 : 1)
      )),
      proposals: [],
      ...(item.bookFrequency < 3 || samples.length < samplesNeeded
        ? { unmapped_reason: "INSUFFICIENT_SAMPLE" }
        : {}),
      offline_review_instructions: {
        proposal_template: proposalTemplate(),
        permitted_unmapped_reasons: ["CANONICAL_GAP", "SEMANTIC_UNCERTAIN", "LOW_VALUE_SOURCE_TAG", "INSUFFICIENT_SAMPLE"],
        must_read_real_samples_and_canonical_definition: true,
      },
    };
    return {
      ...record,
      group_identity: sourceMappingGroupIdentity(record),
      source_evidence_sha256: sourceGroupEvidenceSha256(record),
    };
  });
}

function finalSampleBookIds(raw) {
  if (!raw.finalSelectionPresent) throw new Error("B2 requires an authoritative final-sample selection");
  const records = raw.finalSelection.map((record, index) => {
    const bookId = record.sampleBookKey ?? record.sample_book_key ?? record.bookIdentity ?? record.book_identity ?? record.identity;
    const order = record.selectedSampleIndex ?? record.selected_sample_index ?? record.selectionIndex ?? record.selection_index ?? index + 1;
    if (typeof bookId !== "string" || bookId.length === 0) throw new Error(`final selection record ${index + 1} requires an exact book identity`);
    if (!Number.isSafeInteger(order) || order < 1) throw new Error(`final selection record ${index + 1} has an invalid order`);
    return { bookId, order, index };
  }).sort((left, right) => left.order - right.order || left.index - right.index);
  const ids = records.map(({ bookId }) => bookId);
  if (new Set(ids).size !== ids.length) throw new Error("final selection contains duplicate book identities");
  return ids;
}

export async function writeB2SourceGroupTemplate({ inventoryJson, evidenceJsonl, cooccurrenceJson, outputPath }) {
  const [inventory, evidence, cooccurrence] = await Promise.all([
    readFile(inventoryJson, "utf8").then(JSON.parse),
    readFile(evidenceJsonl, "utf8").then((text) => parseJsonl(text, evidenceJsonl)),
    readFile(cooccurrenceJson, "utf8").then(JSON.parse),
  ]);
  const records = buildB2SourceGroupTemplate({ inventory, evidence, cooccurrence });
  await writeFile(outputPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, { encoding: "utf8", flag: "wx" });
  return records.length;
}

export async function loadB2SourceGroupTemplateFromRawRun({
  rawRunDir,
  channelAppId,
  sourceScope = channelAppId,
  options = {},
  verifyRawManifest = true,
}) {
  let rawVerification = null;
  if (verifyRawManifest) {
    rawVerification = await verifyRawRunManifest(rawRunDir);
    if (!rawVerification.ok) throw new Error("B2 requires a verified raw-run manifest");
    if (rawVerification.manifest?.channel_app_id !== channelAppId) {
      throw new Error("B2 channel_app_id does not match the verified raw-run manifest");
    }
  }
  const loaded = await loadAndAnalyzeLaneBRun({ rawRunDir, channelAppId, sourceScope, options });
  const final_sample_book_ids = finalSampleBookIds(loaded.raw);
  return {
    ...loaded,
    rawManifestSha256: rawVerification?.manifestSha256 ?? null,
    finalSampleBookIds: final_sample_book_ids,
    records: buildB2SourceGroupTemplate({
      inventory: loaded.analysis.inventory,
      evidence: loaded.analysis.evidence,
      cooccurrence: loaded.analysis.cooccurrence,
    }),
  };
}

export async function writeB2SourceGroupTemplateFromRawRun({
  rawRunDir,
  channelAppId,
  outputPath,
  sourceScope = channelAppId,
  options = {},
  verifyRawManifest = true,
}) {
  const { records } = await loadB2SourceGroupTemplateFromRawRun({
    rawRunDir,
    channelAppId,
    sourceScope,
    options,
    verifyRawManifest,
  });
  await writeFile(outputPath, `${records.map((record) => JSON.stringify(record)).join("\n")}${records.length ? "\n" : ""}`, {
    encoding: "utf8",
    flag: "wx",
  });
  return records.length;
}
