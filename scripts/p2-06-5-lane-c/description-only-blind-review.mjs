/**
 * P2-06.5 Lane C — description-only precision blind review sample builder.
 *
 * Reads an already-written Lane C C1 run directory and emits a 400-novel blind
 * review package for an independent reviewer.  Like the rest of Lane C this
 * module is offline only: no Prisma, no adapters, no fetch, no Worker.  Its
 * only inputs are the versioned JSON/JSONL files of a completed run.
 *
 * It never mutates the run it reads.  It never re-scores, never re-runs C1,
 * never edits the taxonomy, and never authorises a tag write.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { CALIBRATION_STATUS, RECOMMENDATION_STATUS, fingerprint, readJsonFile, readJsonlFile } from "./calibration.mjs";
import { scanLaneBArtifactsForSecrets } from "../p2-06-5-lane-b/secret-scan.mjs";

/** The single candidate under review this round: description weighted equal to title. */
export const REVIEWED_CONFIG_ID = "C";
export const REVIEWED_MAX_TEXT_TAGS = 3;

/** Declared sampling seed.  Folded into the sort key; no RNG is used anywhere. */
export const SAMPLING_SEED = "20260816";

export const POPULATION_SAMPLE_TARGET = 320;
export const RISK_SAMPLE_TARGET = 80;
export const TOTAL_SAMPLE_TARGET = POPULATION_SAMPLE_TARGET + RISK_SAMPLE_TARGET;
export const POST_FIX_POPULATION_SAMPLE_TARGET = 150;
export const POST_FIX_RISK_SAMPLE_TARGET = 50;

/** Strata with at least this many novels are guaranteed a minimum representation. */
const STRATUM_FLOOR_POPULATION = 6;
const STRATUM_FLOOR_SAMPLE = 2;

export const BLIND_REVIEW_STATUS = "READY_FOR_INDEPENDENT_REVIEW";
export const AUTO_WRITE_AUTHORIZED = "NO";

/**
 * Authoritative lineage this builder refuses to run without.  Both values are
 * Owner-frozen; a mismatch means the caller pointed at the wrong artifact.
 */
export const EXPECTED_CANONICAL_SHA256 = "8bc8cdae8be2176bde170173e98bad2b9fa0e1770818174a57320816eefdccad";
export const EXPECTED_C1_INPUT_SHA256 = "046fe9234b317eba145c3fbb35edd2e72af49e41309dcd5d5f45f7bc43d1776d";
export const EXPECTED_CANONICAL_TAG_COUNT = 123;

/**
 * Keyword seeds already known to be defective before this round started.  They
 * are NOT excluded from the population — the sample stays proportional so the
 * Owner gets a true estimate of the artifact as it stands — but they are
 * labelled in the hidden reference so precision can be reported with and
 * without them.  See the KNOWN_SEED_DEFECT section of the sample report.
 */
export const KNOWN_DEFECTIVE_KEYWORDS = Object.freeze(new Set(["he", "be"]));

/**
 * Tags whose concept is a person's role/profession/identity, or a bare setting.
 * These are the classic "mentioned in passing" false-positive generators, so
 * they get a dedicated risk cell.  Tags carrying the `setting` facet in the
 * canonical artifact are added to this set at load time.
 */
const ROLE_OR_SETTING_TAG_SLUGS = Object.freeze([
  "assassin", "chef", "crown-prince", "doctor", "emperor", "genius", "heir", "impostor",
  "lawyer", "legitimate-daughter", "mafia", "maid", "military", "miracle-healer", "playboy",
  "princess", "royalty", "secretary", "security-guard", "single-mother", "student",
  "substitute", "urban-hero", "vampire", "warrior-protagonist", "wealthy-ceo", "werewolf",
  "werewolf-alpha", "werewolf-luna",
  "apocalypse", "campus", "entertainment-industry", "future-world", "gaming-esports", "village-life",
]);

/** A description at or beyond this code-point length counts as "long". */
const LONG_DESCRIPTION_CODE_POINTS = 1000;

/**
 * Risk cells, in the fixed order they are filled.  A novel may carry several
 * risk flags; it is assigned to the first cell below that still has quota.
 * `GENERIC_KEYWORD_HE_BE` deliberately has no cell — it is already represented
 * proportionally in the population layer, so the risk budget goes to unknown
 * failure modes instead.
 */
export const RISK_CELLS = Object.freeze([
  { flag: "SAME_REGION_MULTI_TAG", quota: 14 },
  { flag: "ROLE_OR_SETTING_TAG", quota: 14 },
  { flag: "LONG_DESC_SINGLE_OCCURRENCE", quota: 12 },
  { flag: "SELECTED_TAG_COUNT_GE3", quota: 12 },
  { flag: "RAW_TAG_COUNT_GE4", quota: 10 },
  { flag: "SOURCE_TEXT_DISAGREE_TEXT_ONLY", quota: 8 },
  { flag: "CROSS_SCRIPT_KEYWORD", quota: 6 },
  { flag: "SHORT_GENERIC_KEYWORD_NON_HE_BE", quota: 4 },
]);

/**
 * Tags carrying a grade-B `LOW_EVIDENCE_LOCALE_RULE` in the keyword eligibility
 * overlay.  The rule was drawn from single-digit observations, so the surviving
 * edges are the evidence that decides whether it keeps the right ones.
 */
export const LOCALE_RULE_TAG_IDS = Object.freeze(new Set(["ct-v1-chef", "ct-v1-werewolf-luna"]));

/**
 * Scaled 80 → 50.  `LOCALE_COLLISION_SURVIVOR` is filled first and given the
 * largest quota on purpose: the post-fix round's stated priority is to gather
 * evidence on the low-evidence chef/luna locale rules, and those survivors are
 * rare enough that a proportional draw returns almost none of them.
 */
export const POST_FIX_RISK_CELLS = Object.freeze([
  { flag: "LOCALE_COLLISION_SURVIVOR", quota: 12 },
  { flag: "SAME_REGION_MULTI_TAG", quota: 7 },
  { flag: "ROLE_OR_SETTING_TAG", quota: 7 },
  { flag: "LONG_DESC_SINGLE_OCCURRENCE", quota: 6 },
  { flag: "SELECTED_TAG_COUNT_GE3", quota: 5 },
  { flag: "RAW_TAG_COUNT_GE4", quota: 5 },
  { flag: "SOURCE_TEXT_DISAGREE_TEXT_ONLY", quota: 4 },
  { flag: "CROSS_SCRIPT_KEYWORD", quota: 2 },
  { flag: "SHORT_GENERIC_KEYWORD_NON_HE_BE", quota: 2 },
]);

/** Field names that must never appear anywhere in the reviewer package. */
export const FORBIDDEN_REVIEWER_FIELDS = Object.freeze([
  "seriesTypeList", "raw_series_types", "sourceExactSeriesTypeTokens",
  "mapped_source_tags", "sourceMappedTagIds", "sourceMappedTagCount",
  "sourceTextRelation", "sourceEvidenceStatus", "manualCanonicalTagIds",
  "novelIdentity", "sampleRowId", "sourceSnapshotId",
  "totalScore", "descriptionScore", "titleScore", "descriptionWeight", "titleWeight",
  "threshold", "evidenceClass", "riskFlags", "sampleStratum", "selectedAfterCap",
  "keywordId", "configId",
]);

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Deterministic id, matching the Lane C `caseId` idiom. */
function reviewId(prefix, values) {
  return `${prefix}_${sha256(values.join("\n")).slice(0, 24)}`;
}

/** Deterministic ordering; the repo-wide substitute for a seeded RNG. */
function sortByHash(rows, key) {
  return [...rows].sort((left, right) => {
    const leftKey = key(left);
    const rightKey = key(right);
    return sha256(leftKey).localeCompare(sha256(rightKey)) || leftKey.localeCompare(rightKey);
  });
}

function codePoints(value) {
  return Array.from(value);
}

/** Matcher offsets are code-point offsets into the NFC-normalised field. */
function normalizeField(value) {
  return (value ?? "").normalize("NFC");
}

function isCjk(value) {
  return /[㐀-鿿豈-﫿]|[\uD840-\uD87F][\uDC00-\uDFFF]/u.test(value);
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

/**
 * Upstream descriptions really do contain U+2028 LINE SEPARATOR, which
 * `JSON.stringify` leaves raw and which several line-based readers (including
 * Node's own `readline`) treat as a line break.  Escaping both separators keeps
 * the emitted JSONL parseable by any consumer without changing the decoded
 * string, so the reviewer package cannot be shredded in transit.
 */
function jsonlLine(row) {
  return JSON.stringify(row).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

function rowsToJsonl(rows) {
  return rows.map(jsonlLine).join("\n") + (rows.length > 0 ? "\n" : "");
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Streams a JSONL file so the multi-hundred-megabyte diagnostics never have to
 * be materialised.  Splits on `/\r?\n/` exactly like `readJsonlFile`, and
 * deliberately does NOT use `node:readline`: these artifacts contain raw U+2028
 * LINE SEPARATOR inside descriptions, which readline would treat as a record
 * break and shred the row.
 */
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

async function verifyAgainstManifest(runDir, manifest, relativePath) {
  const descriptor = manifest.artifacts.find((entry) => entry.path === relativePath);
  if (!descriptor) fail(`run manifest has no entry for ${relativePath}`);
  const path = join(runDir, "scored", relativePath);
  const actual = await hashFile(path);
  if (actual !== descriptor.sha256) fail(`${relativePath} SHA-256 mismatch: expected ${descriptor.sha256}, read ${actual}`);
  return path;
}

/** Create-only directory write: staging dir, `wx` files, then atomic rename. */
async function atomicWriteDirectory(outputDir, files) {
  try {
    await lstat(outputDir);
    fail(`output directory already exists: ${outputDir}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(outputDir), { recursive: true });
  const staging = await mkdtemp(join(dirname(outputDir), `.${basename(outputDir)}.staging-`));
  try {
    for (const [name, content] of files) await writeFile(join(staging, name), content, { encoding: "utf8", flag: "wx" });
    await rename(staging, outputDir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function artifactDescriptors(contents) {
  return [...contents.entries()]
    .map(([path, content]) => {
      const bytes = Buffer.from(content, "utf8");
      const rowCount = path.endsWith(".jsonl") ? (content === "" ? 0 : content.trimEnd().split("\n").length) : null;
      return { path, bytes: bytes.length, sha256: sha256(bytes), rowCount };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

// ---------------------------------------------------------------------------
// Population
// ---------------------------------------------------------------------------

/**
 * Loads the run and derives the description-only population for the reviewed
 * candidate.  A DESCRIPTION_ONLY edge is a selected text tag whose description
 * matched and whose title did not.
 */
export async function loadDescriptionOnlyPopulation({ runDir, canonicalPath }) {
  const manifest = await readJsonFile(join(runDir, "scored", "lane-c-run-manifest.json"));
  if (manifest.lane !== "P2-06.5/C") fail(`unexpected lane ${manifest.lane}`);
  if (manifest.status !== CALIBRATION_STATUS) fail(`unexpected run status ${manifest.status}`);

  const canonicalBytes = await readFile(canonicalPath);
  const canonicalSha256 = sha256(canonicalBytes);
  if (canonicalSha256 !== EXPECTED_CANONICAL_SHA256) fail(`CanonicalTag v1 Final SHA-256 mismatch: read ${canonicalSha256}`);
  const canonical = JSON.parse(canonicalBytes.toString("utf8"));
  if (canonical.tags.length !== EXPECTED_CANONICAL_TAG_COUNT) fail(`CanonicalTag count is ${canonical.tags.length}, expected ${EXPECTED_CANONICAL_TAG_COUNT}`);
  const canonicalById = new Map(canonical.tags.map((tag) => [tag.stable_id, tag]));

  const roleOrSetting = new Set(ROLE_OR_SETTING_TAG_SLUGS.map((slug) => `ct-v1-${slug}`));
  for (const tag of canonical.tags) if (tag.facet === "setting") roleOrSetting.add(tag.stable_id);

  const c1InputSha256 = await hashFile(join(runDir, "c1-input.jsonl"));
  if (c1InputSha256 !== EXPECTED_C1_INPUT_SHA256) fail(`c1-input.jsonl SHA-256 mismatch: read ${c1InputSha256}`);

  const rawSamples = await readJsonlFile(join(runDir, "samples.jsonl"));
  const samplesFingerprint = fingerprint(rawSamples);
  if (samplesFingerprint !== manifest.samples.fingerprint) fail("samples.jsonl fingerprint differs from the run manifest");
  const samplesById = new Map(rawSamples.map((row) => [row.sampleRowId, row]));

  const evidencePath = await verifyAgainstManifest(runDir, manifest, "text-evidence.jsonl");
  const edgesByRow = new Map();
  const titleSupportedRows = new Set();
  await streamJsonl(evidencePath, (row) => {
    if (row.configId !== REVIEWED_CONFIG_ID || row.maxTextTags !== REVIEWED_MAX_TEXT_TAGS) return;
    if (!row.selectedAfterCap) return;
    if (row.titleMatched) {
      titleSupportedRows.add(row.sampleRowId);
      return;
    }
    if (!row.descriptionMatched) return;
    const existing = edgesByRow.get(row.sampleRowId);
    if (existing) existing.push(row);
    else edgesByRow.set(row.sampleRowId, [row]);
  });

  const diagnosticsPath = await verifyAgainstManifest(runDir, manifest, "text-book-diagnostics.jsonl");
  const diagnosticsByRow = new Map();
  let authoritativeDescriptionOnlyBooks = 0;
  await streamJsonl(diagnosticsPath, (row) => {
    if (row.configId !== REVIEWED_CONFIG_ID || row.maxTextTags !== REVIEWED_MAX_TEXT_TAGS) return;
    if (row.hasDescriptionOnly) authoritativeDescriptionOnlyBooks += 1;
    if (edgesByRow.has(row.sampleRowId)) diagnosticsByRow.set(row.sampleRowId, row);
  });

  // Reconcile the edge-derived population against the run's own book-level flag.
  if (authoritativeDescriptionOnlyBooks !== edgesByRow.size) {
    fail(`description-only population disagrees with the run: edge-derived ${edgesByRow.size}, book-level flag ${authoritativeDescriptionOnlyBooks}`);
  }

  const novels = [];
  for (const [sampleRowId, edges] of edgesByRow) {
    const sample = samplesById.get(sampleRowId);
    if (!sample) fail(`text-evidence references unknown sampleRowId ${sampleRowId}`);
    const diagnostics = diagnosticsByRow.get(sampleRowId);
    if (!diagnostics) fail(`no book diagnostics for ${sampleRowId}`);
    const description = normalizeField(sample.description);
    const descriptionPoints = codePoints(description);

    const proposals = sortByHash(edges, (edge) => edge.canonicalTagId).map((edge) => {
      const tag = canonicalById.get(edge.canonicalTagId);
      if (!tag) fail(`${sampleRowId} proposes ${edge.canonicalTagId}, which is not in CanonicalTag v1 Final`);
      if (edge.titleMatched) fail(`${sampleRowId}/${edge.canonicalTagId} is not description-only`);
      const matches = edge.descriptionMatches.map((match) => {
        const text = descriptionPoints.slice(match.start, match.end).join("");
        if (text.toLowerCase() !== match.keyword.toLowerCase()) {
          fail(`${sampleRowId}/${edge.canonicalTagId} span [${match.start},${match.end}) is ${JSON.stringify(text)}, expected ${JSON.stringify(match.keyword)}`);
        }
        return { ...match, text };
      });
      return { edge, tag, matches };
    });

    novels.push({
      sampleRowId,
      sample,
      diagnostics,
      description,
      descriptionLength: descriptionPoints.length,
      proposals,
      hasTitleSupportedTextEdge: titleSupportedRows.has(sampleRowId),
      rawLanguageScope: sample.rawLanguageScope,
      riskFlags: [],
    });
  }

  for (const novel of novels) novel.riskFlags = riskFlagsFor(novel, roleOrSetting);
  novels.sort((left, right) => left.sampleRowId.localeCompare(right.sampleRowId));

  return {
    manifest,
    novels,
    lineage: {
      run_id: manifest.runId,
      canonical_sha256: canonicalSha256,
      c1_input_sha256: c1InputSha256,
      samples_fingerprint: samplesFingerprint,
      taxonomy_fingerprint: manifest.taxonomy.fingerprint,
      source_mapping_fingerprint: manifest.sourceMapping.fingerprint,
      text_evidence_sha256: manifest.artifacts.find((entry) => entry.path === "text-evidence.jsonl").sha256,
      text_book_diagnostics_sha256: manifest.artifacts.find((entry) => entry.path === "text-book-diagnostics.jsonl").sha256,
    },
  };
}

function riskFlagsFor(novel, roleOrSetting) {
  const flags = [];
  const { diagnostics, proposals, descriptionLength } = novel;

  // Two different tags fired inside the same stretch of the description.
  const regions = new Map();
  for (const proposal of proposals) {
    for (const match of proposal.matches) {
      const bucket = Math.floor(match.start / 160);
      const seen = regions.get(bucket) ?? new Set();
      seen.add(proposal.edge.canonicalTagId);
      regions.set(bucket, seen);
    }
  }
  if ([...regions.values()].some((tags) => tags.size > 1)) flags.push("SAME_REGION_MULTI_TAG");

  if (proposals.some((proposal) => roleOrSetting.has(proposal.edge.canonicalTagId))) flags.push("ROLE_OR_SETTING_TAG");
  if (descriptionLength >= LONG_DESCRIPTION_CODE_POINTS && proposals.some((proposal) => proposal.matches.length === 1)) {
    flags.push("LONG_DESC_SINGLE_OCCURRENCE");
  }
  if (diagnostics.selectedTextTagCount >= 3) flags.push("SELECTED_TAG_COUNT_GE3");
  if (diagnostics.rawEligibleTextTagCount >= 4) flags.push("RAW_TAG_COUNT_GE4");
  if (diagnostics.truncatedTextTagCount > 0) flags.push("CAP_TRUNCATED");
  if (diagnostics.sourceTextRelation === "TEXT_ONLY") flags.push("SOURCE_TEXT_DISAGREE_TEXT_ONLY");
  if (proposals.length >= 2) flags.push("MULTI_DESC_ONLY_EDGE");

  const keywords = proposals.flatMap((proposal) => proposal.matches.map((match) => match.keyword));
  if (proposals.some((proposal) => proposal.matches.some((match) => isCjk(match.keyword) !== (proposal.edge.scriptBucket === "cjk")))) {
    flags.push("CROSS_SCRIPT_KEYWORD");
  }
  if (keywords.some((keyword) => KNOWN_DEFECTIVE_KEYWORDS.has(keyword.toLowerCase()))) flags.push("GENERIC_KEYWORD_HE_BE");
  if (proposals.some((proposal) => LOCALE_RULE_TAG_IDS.has(proposal.edge.canonicalTagId))) flags.push("LOCALE_COLLISION_SURVIVOR");
  if (keywords.some((keyword) => {
    if (KNOWN_DEFECTIVE_KEYWORDS.has(keyword.toLowerCase())) return false;
    const length = codePoints(keyword).length;
    return isCjk(keyword) ? length <= 1 : length <= 4;
  })) {
    flags.push("SHORT_GENERIC_KEYWORD_NON_HE_BE");
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/**
 * Proportional allocation by largest remainder, with a floor for strata that
 * are big enough to carry one, and never more than a stratum actually has.
 */
export function allocateStrata(populationByStratum, target) {
  const strata = [...populationByStratum.keys()].sort();
  const exact = new Map(strata.map((key) => [key, (populationByStratum.get(key) / totalOf(populationByStratum)) * target]));
  const allocation = new Map();
  for (const key of strata) {
    const population = populationByStratum.get(key);
    const floor = Math.floor(exact.get(key));
    allocation.set(key, Math.min(population, population >= STRATUM_FLOOR_POPULATION ? Math.max(STRATUM_FLOOR_SAMPLE, floor) : Math.max(1, floor)));
  }
  const byRemainder = [...strata].sort((left, right) => {
    const leftRemainder = exact.get(left) - Math.floor(exact.get(left));
    const rightRemainder = exact.get(right) - Math.floor(exact.get(right));
    return rightRemainder - leftRemainder || populationByStratum.get(right) - populationByStratum.get(left) || left.localeCompare(right);
  });
  let assigned = totalOf(allocation);
  // Grow toward the target, then shrink if the floors overshot it.
  for (let guard = 0; assigned < target && guard < target * 4; guard += 1) {
    const key = byRemainder[guard % byRemainder.length];
    if (allocation.get(key) < populationByStratum.get(key)) {
      allocation.set(key, allocation.get(key) + 1);
      assigned += 1;
    }
  }
  for (let guard = 0; assigned > target && guard < target * 4; guard += 1) {
    const key = byRemainder[byRemainder.length - 1 - (guard % byRemainder.length)];
    const floor = populationByStratum.get(key) >= STRATUM_FLOOR_POPULATION ? STRATUM_FLOOR_SAMPLE : 1;
    if (allocation.get(key) > floor) {
      allocation.set(key, allocation.get(key) - 1);
      assigned -= 1;
    }
  }
  if (assigned !== target) fail(`stratified allocation reached ${assigned}, expected ${target}`);
  return allocation;
}

function totalOf(map) {
  let sum = 0;
  for (const value of map.values()) sum += value;
  return sum;
}

/** Sort key: declared seed + input lineage + stratum coordinates + row id. */
function samplingKey(seedContext, stratum, sampleRowId) {
  return [SAMPLING_SEED, seedContext, stratum, sampleRowId].join("\n");
}

export function selectSample(novels, {
  c1InputSha256,
  populationTarget = POPULATION_SAMPLE_TARGET,
  riskTarget = RISK_SAMPLE_TARGET,
  riskCells = RISK_CELLS,
}) {
  // Spec fallback: when the real candidate pool cannot fill the package, review
  // all of it rather than inventing strata.
  if (novels.length <= populationTarget + riskTarget) {
    const selected = [...novels]
      .sort((left, right) => left.sampleRowId.localeCompare(right.sampleRowId))
      .map((novel) => ({ novel, stratum: "POPULATION", riskCell: null }));
    const populationByStratum = new Map();
    for (const novel of novels) populationByStratum.set(novel.rawLanguageScope, (populationByStratum.get(novel.rawLanguageScope) ?? 0) + 1);
    return {
      selected,
      allocation: new Map(populationByStratum),
      populationByStratum,
      shortfalls: [{ layer: "POPULATION", stratum: "ALL", requested: populationTarget + riskTarget, available: novels.length, shortfall: populationTarget + riskTarget - novels.length }],
      riskCounts: new Map(),
      census: true,
    };
  }

  const byStratum = new Map();
  for (const novel of novels) {
    const bucket = byStratum.get(novel.rawLanguageScope) ?? [];
    bucket.push(novel);
    byStratum.set(novel.rawLanguageScope, bucket);
  }
  const populationByStratum = new Map([...byStratum].map(([key, rows]) => [key, rows.length]));
  const allocation = allocateStrata(populationByStratum, populationTarget);

  const chosen = new Map();
  const shortfalls = [];
  for (const stratum of [...byStratum.keys()].sort()) {
    const requested = allocation.get(stratum);
    const ordered = sortByHash(byStratum.get(stratum), (novel) => samplingKey(c1InputSha256, stratum, novel.sampleRowId));
    const taken = ordered.slice(0, requested);
    if (taken.length < requested) {
      shortfalls.push({ layer: "POPULATION", stratum, requested, available: ordered.length, shortfall: requested - taken.length });
    }
    for (const novel of taken) chosen.set(novel.sampleRowId, { novel, stratum: "POPULATION", riskCell: null });
  }

  const remaining = novels.filter((novel) => !chosen.has(novel.sampleRowId));
  let riskBudget = riskTarget;
  const riskCounts = new Map();
  for (const { flag, quota } of riskCells) {
    const pool = remaining.filter((novel) => !chosen.has(novel.sampleRowId) && novel.riskFlags.includes(flag));
    const requested = Math.min(quota, riskBudget);
    const ordered = sortByHash(pool, (novel) => samplingKey(c1InputSha256, `RISK|${flag}`, novel.sampleRowId));
    const taken = ordered.slice(0, requested);
    if (taken.length < requested) {
      shortfalls.push({ layer: "RISK", stratum: flag, requested, available: ordered.length, shortfall: requested - taken.length });
    }
    for (const novel of taken) chosen.set(novel.sampleRowId, { novel, stratum: "RISK", riskCell: flag });
    riskCounts.set(flag, taken.length);
    riskBudget -= taken.length;
  }

  // Redistribute any unfilled risk quota across novels carrying any risk flag,
  // then across the remainder, so the package still reaches 400 unique novels.
  if (riskBudget > 0) {
    for (const scope of ["ANY_RISK_FLAG", "REMAINDER"]) {
      if (riskBudget === 0) break;
      const pool = novels.filter((novel) => {
        if (chosen.has(novel.sampleRowId)) return false;
        const hasFlag = novel.riskFlags.length > 0;
        return scope === "ANY_RISK_FLAG" ? hasFlag : true;
      });
      const ordered = sortByHash(pool, (novel) => samplingKey(c1InputSha256, `RISK_BACKFILL|${scope}`, novel.sampleRowId));
      const taken = ordered.slice(0, riskBudget);
      for (const novel of taken) chosen.set(novel.sampleRowId, { novel, stratum: "RISK", riskCell: `BACKFILL_${scope}` });
      riskBudget -= taken.length;
    }
  }

  const selected = [...chosen.values()].sort((left, right) => left.novel.sampleRowId.localeCompare(right.novel.sampleRowId));
  return { selected, allocation, populationByStratum, shortfalls, riskCounts };
}

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

/**
 * Builds the reviewer row from an explicit allow-list.  The source row is never
 * spread — every field here is named on purpose, so a new upstream field can
 * never leak into a blind package by accident.
 */
function reviewerRow(novelReviewId, entry) {
  const { novel } = entry;
  return {
    novel_review_id: novelReviewId,
    raw_language_scope: novel.rawLanguageScope,
    title: normalizeField(novel.sample.title),
    description: novel.description,
    proposed_tags: novel.proposals.map(({ tag, matches }) => ({
      canonical_stable_id: tag.stable_id,
      slug: tag.slug,
      display_name_zh: tag.display_name_zh,
      canonical_definition: tag.canonical_definition,
      matched_text_span: matches.map((match) => ({ start: match.start, end: match.end, text: match.text })),
    })),
  };
}

function hiddenReferenceRow(novelReviewId, entry) {
  const { novel, stratum, riskCell } = entry;
  return {
    novel_review_id: novelReviewId,
    sample_row_id: novel.sampleRowId,
    novel_identity: novel.sample.novelIdentity,
    channel_app_id: novel.sample.channelAppId,
    raw_language_scope: novel.rawLanguageScope,
    source_language_code: novel.sample.sourceLanguageCode,
    source_language_name: novel.sample.sourceLanguageName,
    script_bucket: novel.sample.scriptBucket,
    source_snapshot_id: novel.sample.sourceSnapshotId,
    sample_stratum: stratum,
    risk_cell: riskCell,
    risk_flags: novel.riskFlags,
    raw_series_types: novel.sample.seriesTypeList,
    source_mapped_tag_ids: novel.diagnostics.sourceMappedTagIds,
    source_text_relation: novel.diagnostics.sourceTextRelation,
    manual_canonical_tag_ids: novel.sample.manualCanonicalTagIds ?? [],
    has_title_supported_text_edge: novel.hasTitleSupportedTextEdge,
    raw_eligible_text_tag_count: novel.diagnostics.rawEligibleTextTagCount,
    selected_text_tag_count: novel.diagnostics.selectedTextTagCount,
    truncated_text_tag_count: novel.diagnostics.truncatedTextTagCount,
    description_code_points: novel.descriptionLength,
    description_only_edges: novel.proposals.map(({ edge, tag, matches }) => ({
      canonical_stable_id: tag.stable_id,
      slug: tag.slug,
      title_matched: edge.titleMatched,
      description_matched: edge.descriptionMatched,
      selected_after_cap: edge.selectedAfterCap,
      evidence_class: edge.evidenceClass,
      total_score: edge.totalScore,
      description_score: edge.descriptionScore,
      keyword_coverage_status: edge.keywordCoverageStatus,
      is_known_defective_keyword: matches.some((match) => KNOWN_DEFECTIVE_KEYWORDS.has(match.keyword.toLowerCase())),
      matches: matches.map((match) => ({
        keyword_id: match.keywordId,
        keyword: match.keyword,
        match_mode: match.matchMode,
        start: match.start,
        end: match.end,
        text: match.text,
        excerpt: match.excerpt,
        input_field_sha256: match.inputFieldSha256,
      })),
    })),
  };
}

const REVIEWER_CSV_COLUMNS = Object.freeze([
  ["novel_review_id", "novel_review_id"],
  ["raw_language_scope", "raw_language_scope"],
  ["title", "title"],
  ["description", "description"],
  ["proposed_tag_count", "proposed_tag_count"],
  ["proposed_tags", "proposed_tags_flat"],
]);

function reviewerCsvRow(row) {
  return {
    ...row,
    proposed_tag_count: row.proposed_tags.length,
    proposed_tags_flat: row.proposed_tags
      .map((tag) => `${tag.canonical_stable_id}|${tag.slug}|${tag.display_name_zh}|${tag.matched_text_span.map((span) => span.text).join("/")}`)
      .join(" ;; "),
  };
}

// ---------------------------------------------------------------------------
// Statistics and QA
// ---------------------------------------------------------------------------

function scopeLabel(rawLanguageScope) {
  try {
    const parsed = JSON.parse(rawLanguageScope);
    const name = Array.isArray(parsed[2]) && parsed[2].length > 1 ? parsed[2][1] : null;
    const code = JSON.parse(parsed[1])[1];
    return name ? `${name} (${code})` : `code ${code}, no upstream name`;
  } catch {
    return rawLanguageScope;
  }
}

function summarize({ novels, selected, populationByStratum, allocation, riskCounts, riskCells = RISK_CELLS }) {
  const selectedByRow = new Map(selected.map((entry) => [entry.novel.sampleRowId, entry]));
  const strata = [...populationByStratum.keys()].sort((left, right) => populationByStratum.get(right) - populationByStratum.get(left) || left.localeCompare(right));
  const byScope = strata.map((stratum) => {
    const sampled = selected.filter((entry) => entry.novel.rawLanguageScope === stratum);
    const populationCount = populationByStratum.get(stratum);
    return {
      raw_language_scope: stratum,
      label: scopeLabel(stratum),
      population_count: populationCount,
      population_sample_count: allocation.get(stratum),
      risk_sample_count: sampled.filter((entry) => entry.stratum === "RISK").length,
      sample_count: sampled.length,
      sampling_fraction: Number((sampled.length / populationCount).toFixed(6)),
    };
  });

  const populationEdges = novels.reduce((sum, novel) => sum + novel.proposals.length, 0);
  const sampleEdges = selected.reduce((sum, entry) => sum + entry.novel.proposals.length, 0);
  const tally = (rows, pick) => {
    const counts = new Map();
    for (const row of rows) for (const value of pick(row)) counts.set(value, (counts.get(value) ?? 0) + 1);
    return [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  };

  const defectiveEdges = (list) => list.reduce((sum, novel) => sum + novel.proposals.filter((proposal) => proposal.matches.some((match) => KNOWN_DEFECTIVE_KEYWORDS.has(match.keyword.toLowerCase()))).length, 0);

  return {
    population: {
      novels: novels.length,
      edges: populationEdges,
      distinct_tags: new Set(novels.flatMap((novel) => novel.proposals.map((proposal) => proposal.tag.stable_id))).size,
      known_defect_edges: defectiveEdges(novels),
      known_defect_novels: novels.filter((novel) => novel.riskFlags.includes("GENERIC_KEYWORD_HE_BE")).length,
    },
    sample: {
      novels: selected.length,
      edges: sampleEdges,
      population_layer: selected.filter((entry) => entry.stratum === "POPULATION").length,
      risk_layer: selected.filter((entry) => entry.stratum === "RISK").length,
      distinct_tags: new Set(selected.flatMap((entry) => entry.novel.proposals.map((proposal) => proposal.tag.stable_id))).size,
      known_defect_edges: defectiveEdges(selected.map((entry) => entry.novel)),
      known_defect_novels: selected.filter((entry) => entry.novel.riskFlags.includes("GENERIC_KEYWORD_HE_BE")).length,
    },
    by_raw_language_scope: byScope,
    by_canonical_tag: tally(selected, (entry) => entry.novel.proposals.map((proposal) => proposal.tag.stable_id)).map(([stable_id, edge_count]) => ({ stable_id, edge_count })),
    by_risk_flag: tally(selected, (entry) => entry.novel.riskFlags).map(([flag, novel_count]) => ({ flag, novel_count })),
    risk_cell_fill: riskCells.map(({ flag, quota }) => ({ flag, quota, filled: riskCounts.get(flag) ?? 0 })),
    selected_ids: [...selectedByRow.keys()].sort(),
  };
}

function runQa({ selected, reviewerRows, hiddenRows, canonicalIds, expectedTotal }) {
  const checks = [];
  const record = (name, ok, detail) => {
    checks.push({ check: name, ok, detail });
    if (!ok) fail(`QA failed: ${name} — ${detail}`);
  };

  record("unique_novels_equals_target", selected.length === expectedTotal, `${selected.length} novels`);
  record("review_ids_unique", new Set(reviewerRows.map((row) => row.novel_review_id)).size === reviewerRows.length, `${reviewerRows.length} rows`);
  record("packages_aligned_one_to_one",
    reviewerRows.length === hiddenRows.length
      && reviewerRows.every((row, index) => row.novel_review_id === hiddenRows[index].novel_review_id),
    `${reviewerRows.length} reviewer / ${hiddenRows.length} hidden`);

  const allTitleHitsFalse = hiddenRows.every((row) => row.description_only_edges.every((edge) => edge.title_matched === false && edge.description_matched === true && edge.selected_after_cap === true));
  record("all_edges_are_description_only", allTitleHitsFalse, "title_matched must be false on every edge");

  const proposedIds = new Set(reviewerRows.flatMap((row) => row.proposed_tags.map((tag) => tag.canonical_stable_id)));
  const unknown = [...proposedIds].filter((id) => !canonicalIds.has(id));
  record("all_tags_in_canonical_final", unknown.length === 0, unknown.join(",") || "all proposed tags resolve");

  const serialized = JSON.stringify(reviewerRows);
  const leaked = FORBIDDEN_REVIEWER_FIELDS.filter((field) => serialized.includes(`"${field}"`));
  record("reviewer_package_has_no_source_evidence", leaked.length === 0, leaked.join(",") || "no forbidden field present");

  const spanMismatch = [];
  for (const row of reviewerRows) {
    const points = codePoints(row.description);
    for (const tag of row.proposed_tags) {
      for (const span of tag.matched_text_span) {
        if (points.slice(span.start, span.end).join("") !== span.text) spanMismatch.push(`${row.novel_review_id}/${tag.canonical_stable_id}`);
      }
    }
  }
  record("matched_spans_are_exact_substrings", spanMismatch.length === 0, spanMismatch.slice(0, 5).join(",") || "every span re-derives from the description");

  return checks;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

const OUTPUT_FILES = Object.freeze({
  reviewJsonl: "01-description-only-review-sample.jsonl",
  reviewCsv: "02-description-only-review-sample.csv",
  hidden: "03-description-only-hidden-reference.jsonl",
  manifest: "04-description-only-sample-manifest.json",
  prompt: "05-FABLE5_DESCRIPTION_ONLY_REVIEW_PROMPT.md",
  report: "06-DESCRIPTION_ONLY_SAMPLE_REPORT.md",
  schema: "07-FABLE5_OUTPUT_SCHEMA.json",
});

export const VERDICTS = Object.freeze(["SUPPORTED", "UNSUPPORTED", "UNCERTAIN"]);
export const OVERALL_QUALITY = Object.freeze(["GOOD", "MIXED", "BAD", "UNCERTAIN"]);
export const FALSE_POSITIVE_CAUSES = Object.freeze([
  "NONE", "INCIDENTAL_MENTION", "SECONDARY_CHARACTER", "GENERIC_KEYWORD", "SETTING_ONLY",
  "ROLE_ONLY", "NEGATION_OR_CONTRAST", "PAST_OR_BACKSTORY", "MULTIPLE_MEANING",
  "TRANSLATION_DRIFT", "INSUFFICIENT_CONTEXT", "OTHER",
]);

function renderPrompt(stats) {
  return `# Fable5 · Description-Only CanonicalTag 盲审指令

你是本轮的独立评审。请只依据本文件与随附的评审样本作答。

## 你拿到什么

\`${OUTPUT_FILES.reviewJsonl}\`（同内容的表格视图在 \`${OUTPUT_FILES.reviewCsv}\`）共 **${stats.sample.novels} 本**小说，
合计 **${stats.sample.edges} 条**待判定条目。每条记录包含：

- \`novel_review_id\` — 回传时的唯一标识
- \`raw_language_scope\` — 上游语种范围原值
- \`title\` / \`description\` — 小说标题与简介原文（NFC 规范化）
- \`proposed_tags[]\` — 系统提议的标签，每个含稳定 ID、slug、中文名、标准定义，
  以及 \`matched_text_span\`（关键词在简介中命中的**原文精确片段**及码点下标）

这些标签**全部只由简介触发**：标题没有命中任何关键词。

## 你的判定单位

判定单位是**「小说 × 提议标签」**，不是整本书。一本书有几个 proposed_tag，就要出几条判定。

## 核心问题

CanonicalTag 是**用户找书的入口**，不是文学知识图谱。

对每一条，只问一件事：

> 如果用户主动点击这个 CanonicalTag，这本小说出现在结果页，他会不会明显觉得搜错了？

不要因为简介里出现了一个词就判 SUPPORTED。

- "她嫁给了一名医生" **不自动等于** \`doctor\`——除非医生身份构成稳定的阅读期待。
- "他们的婚姻最终破裂" **不自动等于**所有婚姻类标签成立。

请判断该元素是否满足下列任一条：

- 是主线；
- 是稳定设定；
- 是核心人物身份；
- 或足以形成用户的找书意图。

都不满足，就是 UNSUPPORTED。

## 判定取值

| verdict | 含义 |
| --- | --- |
| \`SUPPORTED\` | 用户点这个标签找书，这本书出现在结果页是合理的 |
| \`UNSUPPORTED\` | 只是背景提及、次要元素、关键词碰撞，或明显不符合检索意图 |
| \`UNCERTAIN\` | 仅凭标题 + 简介无法可靠判断 |

\`false_positive_cause\` 取值（可选，判 SUPPORTED 时填 \`NONE\`）：

${FALSE_POSITIVE_CAUSES.map((cause) => `- \`${cause}\``).join("\n")}

## 每条要输出的字段

\`\`\`
review_id              ← 即 novel_review_id
canonical_stable_id
verdict                ← ${VERDICTS.join(" | ")}
confidence             ← 0.0 ~ 1.0
reason                 ← 一到两句，说明依据简介的哪一部分
false_positive_cause
\`\`\`

同时对**每一本书**给一条整体评价：

\`\`\`
review_id
overall_description_tag_quality  ← ${OVERALL_QUALITY.join(" | ")}
\`\`\`

回传结构以 \`${OUTPUT_FILES.schema}\` 为准。

## 纪律

- 只依据标题与简介判断，不要检索外部资料，不要推测未给出的剧情。
- 不确定就用 \`UNCERTAIN\`，不要猜。
- 不要试图反推系统为什么提议这个标签，也不要迎合它。
- 逐条独立判断；同一本书的多个标签可以有不同结论。

## 交接清单

本轮只应递交给你以下四个文件：

- \`${OUTPUT_FILES.reviewJsonl}\`
- \`${OUTPUT_FILES.reviewCsv}\`
- \`${OUTPUT_FILES.prompt}\`（本文件）
- \`${OUTPUT_FILES.schema}\`

\`${OUTPUT_FILES.hidden}\` 含上游答案，**不得**提供给你。
`;
}

function renderReport({ stats, lineage, shortfalls, qaChecks, runId, generatedAt }) {
  const scopeTable = stats.by_raw_language_scope
    .map((row) => `| ${row.label} | ${row.population_count} | ${row.population_sample_count} | ${row.risk_sample_count} | ${row.sample_count} | ${(row.sampling_fraction * 100).toFixed(2)}% |`)
    .join("\n");
  const tagTable = stats.by_canonical_tag
    .slice(0, 25)
    .map((row) => `| ${row.stable_id} | ${row.edge_count} |`)
    .join("\n");
  const riskTable = stats.risk_cell_fill
    .map((row) => `| ${row.flag} | ${row.quota} | ${row.filled} |`)
    .join("\n");
  const flagTable = stats.by_risk_flag
    .map((row) => `| ${row.flag} | ${row.novel_count} |`)
    .join("\n");
  const defectPopulationPct = ((stats.population.known_defect_edges / stats.population.edges) * 100).toFixed(1);
  const defectSamplePct = ((stats.sample.known_defect_edges / stats.sample.edges) * 100).toFixed(1);

  return `# P2-06.5 Lane C · 简介独立触发标签 400 本盲审样本报告

运行标识 \`${runId}\`，生成于 ${generatedAt}。

本轮**只生成盲审材料，不下结论**。没有设定通过门槛，没有冻结任何方案，没有修改任何既有产物。

## 一、本轮在问什么

文本标签有两条证据线：标题和简介。前两个候选方案把简介分值压在入选线之下，
简介永远无法单独把标签顶进结果；本轮受审的候选方案把简介抬到与标题齐平
（标题权重 30 / 简介权重 30 / 入选线 30 / 每本最多 ${REVIEWED_MAX_TEXT_TAGS} 个文本标签），
简介第一次能够独立触发标签。

唯一要回答的问题是：**这些只靠简介选出来的标签，到底准不准。**

## 二、候选池

「简介独立触发」的定义回到逐条证据：某条文本标签**简介命中、标题未命中、且最终入选**。

| 事项 | 数量 |
| --- | ---: |
| 候选池小说数 | ${stats.population.novels} |
| 候选池条目数（小说 × 标签） | ${stats.population.edges} |
| 涉及标签种类 | ${stats.population.distinct_tags} |
| 语种分层数 | ${stats.by_raw_language_scope.length} |

口径已与运行自带的书级标记双向对账，两边集合完全一致。

## 三、样本构成

| 事项 | 数量 |
| --- | ---: |
| 唯一小说数 | ${stats.sample.novels} |
| 待判定条目数 | ${stats.sample.edges} |
| 总体分层样本 | ${stats.sample.population_layer} |
| 风险追加样本 | ${stats.sample.risk_layer} |
| 覆盖标签种类 | ${stats.sample.distinct_tags} |

### 按语种分层

| 语种 | 候选池 | 总体样本 | 风险样本 | 合计 | 抽样比 |
| --- | ---: | ---: | ---: | ---: | ---: |
${scopeTable}

### 风险单元填充

| 风险类别 | 配额 | 实际 |
| --- | ---: | ---: |
${riskTable}

${shortfalls.length === 0 ? "所有单元均按配额填满，无 shortfall。" : `未填满的单元（如实记录，未静默截断）：\n\n| 层 | 单元 | 请求 | 可用 | 缺口 |\n| --- | --- | ---: | ---: | ---: |\n${shortfalls.map((row) => `| ${row.layer} | ${row.stratum} | ${row.requested} | ${row.available} | ${row.shortfall} |`).join("\n")}`}

### 样本内风险标记分布（一本可带多个）

| 标记 | 小说数 |
| --- | ---: |
${flagTable}

### 样本内标签分布（前 25）

| CanonicalTag | 条目数 |
| --- | ---: |
${tagTable}

## 四、KNOWN_SEED_DEFECT · 「圆满结局 / 悲剧结局」关键词种子缺陷

**这是本轮开工前就已存在的缺陷，本轮不修，仅备案。**

### 根因

在中文短剧圈，HE 是 Happy Ending、BE 是 Bad Ending 的行话缩写。CanonicalTag v1 Final 把它们
原样收进了关键词种子：

- \`ct-v1-happy-ending\` 的 \`keyword_seeds\` = \`["圆满结局", "he", "HE"]\`
- \`ct-v1-tragic-ending\` 的 \`keyword_seeds\` = \`["悲剧结局", "be", "BE"]\`

匹配器对拉丁文本按整词匹配且不分大小写，于是在英文简介里，这两个种子命中的是
**英文人称代词 he 和系动词 be**，与结局无关。

现有的种子停用机制只拦「字系未覆盖」（本轮停用了 6 个），拉丁字系的 he/be 因此未被拦下。

### 足迹

| 口径 | 数量 | 占比 |
| --- | ---: | ---: |
| 候选池中由该缺陷产生的条目 | ${stats.population.known_defect_edges} / ${stats.population.edges} | ${defectPopulationPct}% |
| 候选池中被波及的小说 | ${stats.population.known_defect_novels} / ${stats.population.novels} | ${((stats.population.known_defect_novels / stats.population.novels) * 100).toFixed(1)}% |
| 本样本中由该缺陷产生的条目 | ${stats.sample.known_defect_edges} / ${stats.sample.edges} | ${defectSamplePct}% |
| 本样本中被波及的小说 | ${stats.sample.known_defect_novels} / ${stats.sample.novels} | ${((stats.sample.known_defect_novels / stats.sample.novels) * 100).toFixed(1)}% |

这两个标签因此成为候选池中占比最高的标签之一。

### 本轮处置

1. 样本**按真实比例保留**，不做人为压制——这样 Owner 拿到的是对**现状产物**的真实精度估计。
2. 缺陷标记 \`GENERIC_KEYWORD_HE_BE\` **只写进隐藏参照包**，评审包中不出现，评审全程无感。
3. 风险追加抽样**未给该缺陷配额**，配额留给未知失效模式。
4. 回收 Fable5 判定后，精度须**分三档报告**：整体 / 剔除该缺陷 / 该缺陷单独。
   否则一个已知的机械缺陷会淹没「简介权重本身是否成立」这个真问题。

### 明确声明

本轮**未**修改关键词种子、**未**修改 CanonicalTag 产物、**未**重跑 C1、**未**调整权重或入选线。
是否修复、如何修复，由 Owner 另行决定。

## 五、盲审边界

评审包按**显式字段白名单**构造，从不展开源记录。评审可见：
\`novel_review_id\`、\`raw_language_scope\`、\`title\`、\`description\`，以及每个提议标签的
稳定 ID、slug、中文名、标准定义、原文精确命中片段。

评审**不可见**：上游原始分类词、来源标签映射、来源与文本关系、既有人工标签、
任何得分与权重、证据分类、风险标记、抽样层、原始行号与小说身份标识。

隐藏参照包按 \`novel_review_id\` 与评审包一一对齐，保留全部被排除的证据，供回收判定后对照。

## 六、可复现性

抽样不使用随机数。排序键为：

\`\`\`
sha256([ "${SAMPLING_SEED}", c1_input_sha256, 分层键, sample_row_id ].join("\\n"))
\`\`\`

按哈希序取前 N 本。同脚本、同输入、同 \`--generated-at\` 必然产出逐字节一致的输出目录。

### 血缘

| 项 | 值 |
| --- | --- |
| 运行标识 | \`${lineage.run_id}\` |
| CanonicalTag v1 Final | \`${lineage.canonical_sha256}\` |
| C1 输入 | \`${lineage.c1_input_sha256}\` |
| 样本指纹 | \`${lineage.samples_fingerprint}\` |
| 关键词词典指纹 | \`${lineage.taxonomy_fingerprint}\` |
| 来源映射指纹 | \`${lineage.source_mapping_fingerprint}\` |
| 逐条文本证据 | \`${lineage.text_evidence_sha256}\` |
| 书级诊断 | \`${lineage.text_book_diagnostics_sha256}\` |

## 七、验收

| 检查 | 结果 |
| --- | --- |
${qaChecks.map((check) => `| ${check.check} | ${check.ok ? "PASS" : "FAIL"} — ${check.detail} |`).join("\n")}

未写数据库、未调用生产接口、未调用外部大模型、未修改 CanonicalTag 产物、
未修改来源映射、未修改分类器、未重跑 C1。

## 八、状态

\`\`\`text
DESCRIPTION_ONLY_POPULATION=${stats.population.novels}
DESCRIPTION_ONLY_SAMPLE_COUNT=${stats.sample.novels}
POPULATION_SAMPLE_COUNT=${stats.sample.population_layer}
RISK_SAMPLE_COUNT=${stats.sample.risk_layer}
DESCRIPTION_ONLY_BLIND_REVIEW_STATUS=${BLIND_REVIEW_STATUS}
AUTO_WRITE_AUTHORIZED=${AUTO_WRITE_AUTHORIZED}
\`\`\`

做完即停，等待 Fable5 独立评审回传。
`;
}

function outputSchema() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "P2-06.5 Lane C description-only blind review — Fable5 return format",
    type: "object",
    additionalProperties: false,
    required: ["edge_verdicts", "novel_verdicts"],
    properties: {
      edge_verdicts: {
        type: "array",
        description: "One entry per novel x proposed CanonicalTag edge.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["review_id", "canonical_stable_id", "verdict", "confidence", "reason"],
          properties: {
            review_id: { type: "string" },
            canonical_stable_id: { type: "string" },
            verdict: { enum: [...VERDICTS] },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            reason: { type: "string", minLength: 1 },
            false_positive_cause: { enum: [...FALSE_POSITIVE_CAUSES] },
          },
        },
      },
      novel_verdicts: {
        type: "array",
        description: "One entry per novel.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["review_id", "overall_description_tag_quality"],
          properties: {
            review_id: { type: "string" },
            overall_description_tag_quality: { enum: [...OVERALL_QUALITY] },
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Pure core: sampling, id assignment, both packages, QA and statistics.
 * Kept free of filesystem access so it can be exercised directly.
 */
export function buildReviewPackages(novels, {
  c1InputSha256,
  canonicalIds,
  populationTarget = POPULATION_SAMPLE_TARGET,
  riskTarget = RISK_SAMPLE_TARGET,
  riskCells = RISK_CELLS,
}) {
  if (novels.length === 0) fail("description-only population is empty");
  const { selected, allocation, populationByStratum, shortfalls, riskCounts, census = false } = selectSample(novels, {
    c1InputSha256, populationTarget, riskTarget, riskCells,
  });

  const withIds = selected.map((entry) => ({
    entry,
    novelReviewId: reviewId("nrv", [SAMPLING_SEED, c1InputSha256, entry.novel.sampleRowId]),
  }));
  withIds.sort((left, right) => left.novelReviewId.localeCompare(right.novelReviewId));

  const reviewerRows = withIds.map(({ novelReviewId, entry }) => reviewerRow(novelReviewId, entry));
  const hiddenRows = withIds.map(({ novelReviewId, entry }) => hiddenReferenceRow(novelReviewId, entry));
  const qaChecks = runQa({
    selected,
    reviewerRows,
    hiddenRows,
    canonicalIds,
    expectedTotal: census ? novels.length : populationTarget + riskTarget,
  });
  const stats = summarize({ novels, selected, populationByStratum, allocation, riskCounts, riskCells });
  return { selected, reviewerRows, hiddenRows, qaChecks, stats, shortfalls, census };
}

export async function buildDescriptionOnlyBlindReview({
  runDir,
  canonicalPath,
  outputDir,
  generatedAt,
  populationTarget = POPULATION_SAMPLE_TARGET,
  riskTarget = RISK_SAMPLE_TARGET,
  riskCells = RISK_CELLS,
  packageName = "description-only-precision-blind-review",
}) {
  const loaded = await loadDescriptionOnlyPopulation({ runDir, canonicalPath });
  const { novels, lineage, manifest } = loaded;
  const canonicalIds = new Set(JSON.parse(await readFile(canonicalPath, "utf8")).tags.map((tag) => tag.stable_id));
  const { reviewerRows, hiddenRows, qaChecks, stats, shortfalls } = buildReviewPackages(novels, {
    c1InputSha256: lineage.c1_input_sha256,
    canonicalIds,
    populationTarget,
    riskTarget,
    riskCells,
  });

  const sampleManifest = {
    schema_version: 1,
    lane: "P2-06.5/C",
    package: packageName,
    status: BLIND_REVIEW_STATUS,
    calibration_status: CALIBRATION_STATUS,
    recommendation_status: RECOMMENDATION_STATUS,
    auto_write_authorized: AUTO_WRITE_AUTHORIZED,
    generated_at: generatedAt,
    reviewed_candidate: {
      config_id: REVIEWED_CONFIG_ID,
      title_weight: 30,
      description_weight: 30,
      chapter_weight: 0,
      threshold: 30,
      max_text_tags: REVIEWED_MAX_TEXT_TAGS,
    },
    description_only_edge_definition: "descriptionMatched=true AND titleMatched=false AND selectedAfterCap=true",
    sampling: {
      seed: SAMPLING_SEED,
      method: "deterministic sha256 sort key, no RNG",
      sort_key: `sha256(["${SAMPLING_SEED}", c1_input_sha256, stratum, sample_row_id].join("\\n"))`,
      population_target: populationTarget,
      risk_target: riskTarget,
      stratum_floor_population: STRATUM_FLOOR_POPULATION,
      stratum_floor_sample: STRATUM_FLOOR_SAMPLE,
      risk_cells: riskCells.map(({ flag, quota }) => ({ flag, quota })),
      known_defect_excluded_from_risk_quota: [...KNOWN_DEFECTIVE_KEYWORDS],
    },
    lineage,
    source_run_manifest_sha256: sha256(`${JSON.stringify(manifest, null, 2)}\n`),
    statistics: stats,
    shortfalls,
    qa: qaChecks,
  };

  const contents = new Map();
  contents.set(OUTPUT_FILES.reviewJsonl, rowsToJsonl(reviewerRows));
  contents.set(OUTPUT_FILES.reviewCsv, rowsToCsv(reviewerRows.map(reviewerCsvRow), REVIEWER_CSV_COLUMNS));
  contents.set(OUTPUT_FILES.hidden, rowsToJsonl(hiddenRows));
  contents.set(OUTPUT_FILES.prompt, renderPrompt(stats));
  contents.set(OUTPUT_FILES.report, renderReport({ stats, lineage, shortfalls, qaChecks, runId: manifest.runId, generatedAt }));
  contents.set(OUTPUT_FILES.schema, `${JSON.stringify(outputSchema(), null, 2)}\n`);
  sampleManifest.artifacts = artifactDescriptors(contents);
  contents.set(OUTPUT_FILES.manifest, `${JSON.stringify(sampleManifest, null, 2)}\n`);

  await atomicWriteDirectory(outputDir, [...contents.entries()].sort((left, right) => left[0].localeCompare(right[0])));

  const secretScan = await scanLaneBArtifactsForSecrets(outputDir);
  if (!secretScan.ok) fail(`secret scan found ${secretScan.findings.length} finding(s): ${JSON.stringify(secretScan.findings)}`);

  return {
    outputDir,
    descriptionOnlyPopulation: stats.population.novels,
    descriptionOnlySampleCount: stats.sample.novels,
    populationSampleCount: stats.sample.population_layer,
    riskSampleCount: stats.sample.risk_layer,
    reviewEdgeCount: stats.sample.edges,
    knownDefectEdgesInSample: stats.sample.known_defect_edges,
    shortfalls: shortfalls.length,
    secretScanFindings: secretScan.findings.length,
    status: BLIND_REVIEW_STATUS,
    autoWriteAuthorized: AUTO_WRITE_AUTHORIZED,
    reviewerHandoffFiles: [OUTPUT_FILES.reviewJsonl, OUTPUT_FILES.reviewCsv, OUTPUT_FILES.prompt, OUTPUT_FILES.schema],
    doNotShareFile: OUTPUT_FILES.hidden,
  };
}
