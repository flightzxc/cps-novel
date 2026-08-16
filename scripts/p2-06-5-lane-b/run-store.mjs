import { createHash } from "node:crypto";
import { appendFile, link, lstat, mkdir, open, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  HISTORICAL_CATALOG_ROWS,
  HTTP_ATTEMPT_CAP,
  PAGE_SIZE,
  PLANNED_UNIQUE_PAGES,
  RETRY_BUDGET,
  SOURCE_LANGUAGE_UPPER_BOUND,
  TARGET_BOOKS,
} from "./constants.mjs";
import { createLaneBBudgetController, SAMPLING_STOP_REASON } from "./budget-controller.mjs";
import { parseLaneBPage } from "./upstream-parser.mjs";
import { selectFinalBooks } from "./sampler.mjs";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const RAW_DATA_ARTIFACT_PATHS = Object.freeze([
  "source-book-samples.jsonl",
  "source-token-observations.jsonl",
  "source-token-structure-anomalies.jsonl",
  "request-attempts.jsonl",
  "duplicate-books.jsonl",
  "final-sample-book-keys.jsonl",
]);
const RAW_JSON_ARTIFACT_PATHS = Object.freeze(["preflight.json"]);

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertInside(root, candidate) {
  const path = relative(root, candidate);
  if (path === "" || path === ".." || path.startsWith(`..${sep}`)) {
    throw new Error("Lane B run path escaped the configured artifact root");
  }
}

function countJsonlRecords(bytes) {
  const text = bytes.toString("utf8");
  if (text.length === 0) return 0;
  if (!text.endsWith("\n")) throw new Error("Lane B JSONL artifact must end with a newline");
  const lines = text.slice(0, -1).split("\n");
  for (const line of lines) JSON.parse(line);
  return lines.length;
}

async function descriptorForFile(runDir, path, { recordCount = false } = {}) {
  const lexicalRoot = resolve(runDir);
  const lexicalPath = resolve(path);
  assertInside(lexicalRoot, lexicalPath);
  const linkInfo = await lstat(path);
  if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) {
    throw new Error("Lane B raw artifact must be a regular non-symlink file");
  }
  const realRoot = await realpath(lexicalRoot);
  const realPath = await realpath(lexicalPath);
  const expectedRealPath = resolve(realRoot, relative(lexicalRoot, lexicalPath));
  if (realPath !== expectedRealPath) throw new Error("Lane B raw artifact path contains a symlink");
  const bytes = await readFile(path);
  const descriptor = {
    path: relative(runDir, path),
    bytes: bytes.length,
    sha256: sha256Bytes(bytes),
  };
  if (recordCount) descriptor.record_count = countJsonlRecords(bytes);
  return descriptor;
}

async function verifyDescriptors(runDir, descriptors) {
  const root = resolve(runDir);
  const realRoot = await realpath(root);
  const failures = [];
  for (const artifact of descriptors) {
    try {
      if (!artifact || typeof artifact.path !== "string" || artifact.path.length === 0) {
        throw new Error("invalid raw artifact path");
      }
      const path = resolve(root, artifact.path);
      assertInside(root, path);
      const linkInfo = await lstat(path);
      if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) throw new Error("invalid raw artifact file");
      const realPath = await realpath(path);
      const expectedRealPath = resolve(realRoot, relative(root, path));
      if (realPath !== expectedRealPath) throw new Error("raw artifact path contains a symlink");
      const bytes = await readFile(path);
      const recordCount = artifact.kind === "raw_data" ? countJsonlRecords(bytes) : undefined;
      if (artifact.kind === "raw_json") JSON.parse(bytes.toString("utf8"));
      if (
        bytes.length !== artifact.bytes
        || sha256Bytes(bytes) !== artifact.sha256
        || (artifact.kind === "raw_data" && recordCount !== artifact.record_count)
      ) throw new Error("raw artifact descriptor mismatch");
    } catch {
      failures.push(artifact?.path ?? null);
    }
  }
  return { ok: failures.length === 0, failures };
}

async function readJsonl(path) {
  const bytes = await readFile(path);
  const text = bytes.toString("utf8");
  if (text.length === 0) return [];
  if (!text.endsWith("\n")) throw new Error("Lane B JSONL artifact must end with a newline");
  return text.slice(0, -1).split("\n").map((line) => JSON.parse(line));
}

function rawPageArtifactPath(pageIndex, attemptNumber) {
  return `raw-api-pages/page-${String(pageIndex).padStart(6, "0")}-attempt-${attemptNumber}.json`;
}

function persistedShape(records) {
  return records.map((record) => JSON.parse(JSON.stringify(record)));
}

async function verifyRawSemanticRoundTrip(runDir, manifest) {
  const failures = [];
  const replay = {
    audits: [],
    successfulPages: 0,
    totalCount: null,
    totalPages: null,
    duplicateCount: 0,
    selection: null,
  };
  try {
    const [audits, actualBooks, actualObservations, actualAnomalies, actualDuplicates, actualSelection, preflight] = await Promise.all([
      readJsonl(join(runDir, "request-attempts.jsonl")),
      readJsonl(join(runDir, "source-book-samples.jsonl")),
      readJsonl(join(runDir, "source-token-observations.jsonl")),
      readJsonl(join(runDir, "source-token-structure-anomalies.jsonl")),
      readJsonl(join(runDir, "duplicate-books.jsonl")),
      readJsonl(join(runDir, "final-sample-book-keys.jsonl")),
      readFile(join(runDir, "preflight.json"), "utf8").then((text) => JSON.parse(text)),
    ]);
    replay.audits = audits;
    if (typeof manifest.channel_app_id !== "string" || manifest.channel_app_id.length === 0) {
      throw new Error("manifest channel_app_id invalid");
    }
    if (preflight.channel_app_id !== manifest.channel_app_id) {
      failures.push("semantic_round_trip:channel_app_id");
    }

    const pageArtifacts = Array.isArray(manifest.raw_page_artifacts) ? manifest.raw_page_artifacts : [];
    const artifactPaths = new Set(pageArtifacts.map(({ path }) => path));
    const auditPaths = new Set();
    const expectedBooks = [];
    const expectedObservations = [];
    const expectedAnomalies = [];
    const expectedDuplicates = [];
    const firstBooks = new Map();
    let acquisitionIndex = 0;

    const successfulPageSet = new Set();
    for (const audit of audits) {
      if (!Number.isSafeInteger(audit.pageIndex) || audit.pageIndex < 1
        || !Number.isSafeInteger(audit.attemptNumber) || audit.attemptNumber < 1 || audit.attemptNumber > 2) {
        throw new Error("request audit page/attempt identity invalid");
      }
      const artifactPath = rawPageArtifactPath(audit.pageIndex, audit.attemptNumber);
      if (artifactPaths.has(artifactPath)) auditPaths.add(artifactPath);
      if (audit.ok !== true) continue;
      if (!artifactPaths.has(artifactPath)) {
        failures.push(`semantic_round_trip:missing_success_raw_page:${artifactPath}`);
        continue;
      }
      let parsed;
      try {
        const payload = JSON.parse(await readFile(join(runDir, artifactPath), "utf8"));
        parsed = parseLaneBPage({
          payload,
          pageIndex: audit.pageIndex,
          fetchedAt: audit.requestedAt,
          channelAppId: manifest.channel_app_id,
        });
      } catch {
        failures.push(`semantic_round_trip:unparseable_success_raw_page:${artifactPath}`);
        continue;
      }
      if (replay.totalCount === null) {
        replay.totalCount = parsed.totalCount;
        replay.totalPages = Math.max(1, Math.ceil(parsed.totalCount / PAGE_SIZE));
      }
      successfulPageSet.add(audit.pageIndex);

      const acceptedRows = new Set();
      for (const book of parsed.books) {
        if (firstBooks.has(book.sampleBookKey)) {
          expectedDuplicates.push({
            sampleBookKey: book.sampleBookKey,
            firstSeen: firstBooks.get(book.sampleBookKey),
            duplicatePageIndex: book.pageIndex,
            duplicateRowIndex: book.rowIndex,
            observedAt: book.fetchedAt,
          });
          continue;
        }
        acquisitionIndex += 1;
        const accepted = { ...book, acquisitionIndex };
        firstBooks.set(book.sampleBookKey, {
          pageIndex: book.pageIndex,
          rowIndex: book.rowIndex,
          fetchedAt: book.fetchedAt,
          acquisitionIndex,
        });
        acceptedRows.add(book.rowIndex);
        expectedBooks.push(accepted);
      }
      expectedObservations.push(...parsed.observations.filter(({ rowIndex }) => acceptedRows.has(rowIndex)));
      expectedAnomalies.push(...parsed.anomalies.filter(({ rowIndex }) => acceptedRows.has(rowIndex)));
    }
    replay.successfulPages = successfulPageSet.size;
    replay.duplicateCount = expectedDuplicates.length;
    replay.selection = selectFinalBooks(expectedBooks, expectedObservations);
    const expectedSelection = replay.selection.selectionAudit.map((entry) => ({
      sampleBookKey: entry.bookIdentity,
      selectedSampleIndex: entry.selectedSampleIndex,
      selectionReason: entry.selectionReason,
    }));
    if (manifest.successful_pages !== replay.successfulPages) failures.push("manifest:successful_pages");
    if (manifest.duplicate_book_observations !== replay.duplicateCount) {
      failures.push("manifest:duplicate_book_observations");
    }
    if (manifest.total_count_refreshed !== replay.totalCount) failures.push("manifest:total_count_refreshed");
    if (manifest.total_pages_refreshed !== replay.totalPages) failures.push("manifest:total_pages_refreshed");
    if (manifest.final_sample_books !== replay.selection.selectedCount) {
      failures.push("manifest:final_sample_books_replayed");
    }

    for (const path of artifactPaths) {
      if (!auditPaths.has(path)) failures.push(`semantic_round_trip:raw_page_without_audit:${path}`);
    }
    const comparisons = [
      ["source-book-samples.jsonl", persistedShape(expectedBooks), actualBooks],
      ["source-token-observations.jsonl", persistedShape(expectedObservations), actualObservations],
      ["source-token-structure-anomalies.jsonl", persistedShape(expectedAnomalies), actualAnomalies],
      ["duplicate-books.jsonl", persistedShape(expectedDuplicates), actualDuplicates],
      ["final-sample-book-keys.jsonl", persistedShape(expectedSelection), actualSelection],
    ];
    for (const [path, expected, actual] of comparisons) {
      if (!isDeepStrictEqual(actual, expected)) failures.push(`semantic_round_trip:${path}`);
    }
  } catch {
    failures.push("semantic_round_trip:replay_failed");
  }
  return { ok: failures.length === 0, failures: [...new Set(failures)], replay };
}

function verifyRequestAuditBudget(audits, manifest) {
  const failures = [];
  try {
    const uniquePages = new Set(audits.map(({ pageIndex }) => pageIndex));
    const retryAttempts = audits.filter(({ isRetry }) => isRetry === true).length;
    const perPageAttempts = new Map();
    let priorRequestStartMs = null;
    let timingQaPassed = true;
    for (const audit of audits) {
      if (!Number.isSafeInteger(audit.pageIndex) || audit.pageIndex < 1) throw new Error("invalid page audit");
      perPageAttempts.set(audit.pageIndex, (perPageAttempts.get(audit.pageIndex) ?? 0) + 1);
      const requestStartMs = Date.parse(audit.requestStartedAt);
      const requestedAtMs = Date.parse(audit.requestedAt);
      const responseReceivedMs = Date.parse(audit.responseReceivedAt);
      if (!Number.isFinite(requestStartMs) || !Number.isFinite(requestedAtMs)
        || !Number.isFinite(responseReceivedMs) || requestStartMs !== requestedAtMs
        || responseReceivedMs < requestStartMs || audit.durationMs !== responseReceivedMs - requestStartMs
        || (priorRequestStartMs !== null && requestStartMs - priorRequestStartMs < 1_000)) {
        timingQaPassed = false;
      }
      priorRequestStartMs = requestStartMs;
    }
    const computedBudgetQa = audits.length <= HTTP_ATTEMPT_CAP
      && uniquePages.size <= PLANNED_UNIQUE_PAGES
      && retryAttempts <= RETRY_BUDGET
      && [...perPageAttempts.values()].every((count) => count <= 2)
      && timingQaPassed;
    if (!timingQaPassed) failures.push("request-attempts.jsonl:start_interval");
    if (manifest.actual_http_attempts !== audits.length) failures.push("manifest:actual_http_attempts");
    if (manifest.actual_unique_pages !== uniquePages.size) failures.push("manifest:actual_unique_pages");
    if (manifest.retry_attempts !== retryAttempts) failures.push("manifest:retry_attempts");
    if (manifest.planned_unique_pages !== PLANNED_UNIQUE_PAGES
      || manifest.retry_budget !== RETRY_BUDGET
      || manifest.http_attempt_cap !== HTTP_ATTEMPT_CAP) failures.push("manifest:frozen_budget");
    return { ok: failures.length === 0 && computedBudgetQa, failures, computedBudgetQa };
  } catch {
    return {
      ok: false,
      failures: ["request-attempts.jsonl:budget_audit"],
      computedBudgetQa: false,
    };
  }
}

const RAW_RUN_STATUSES = new Set(["COMPLETE", "PARTIAL"]);
const STOP_REASONS = new Set(Object.values(SAMPLING_STOP_REASON));

/**
 * Replay stop conditions that are evidenced by request-attempts.jsonl. Two
 * sampler stops happen immediately before an otherwise unrecorded next HTTP
 * attempt (attempt cap and page-universe exhaustion), so those are validated
 * against their frozen manifest counters instead of being invented by replay.
 */
function verifySamplingStopReason(audits, manifest) {
  const failures = [];
  try {
    const claimed = manifest.stop_reason;
    if (claimed !== null && !STOP_REASONS.has(claimed)) {
      return { ok: false, failures: ["manifest:stop_reason"], replayedStopReason: null };
    }

    const budget = createLaneBBudgetController();
    let sequenceValid = true;
    for (const [index, audit] of audits.entries()) {
      if (typeof audit.isRetry !== "boolean" || typeof audit.ok !== "boolean"
        || typeof audit.retryable !== "boolean"
        || (audit.status !== null && (!Number.isSafeInteger(audit.status) || audit.status < 100 || audit.status > 599))) {
        sequenceValid = false;
        break;
      }
      const gate = budget.beforeAttempt(audit.pageIndex);
      if (!gate.allowed
        || gate.retry !== audit.isRetry
        || gate.attemptNumberForPage !== audit.attemptNumber) {
        sequenceValid = false;
        break;
      }
      // The sampler records thrown safety failures as a non-retryable, statusless
      // attempt after stopping the controller with SAFETY_ERROR.
      if (audit.ok !== true && audit.status === null && audit.retryable === false) {
        budget.stop(SAMPLING_STOP_REASON.SAFETY_ERROR);
      }
      budget.afterAttempt(audit.pageIndex, audit);
      if (budget.state().stopped && index !== audits.length - 1) {
        sequenceValid = false;
        break;
      }
    }
    if (!sequenceValid) failures.push("request-attempts.jsonl:stop_sequence");

    let replayedStopReason = budget.state().stopReason;
    if (replayedStopReason === null && claimed === SAMPLING_STOP_REASON.HTTP_ATTEMPT_CAP_REACHED) {
      if (audits.length === HTTP_ATTEMPT_CAP) replayedStopReason = claimed;
    }
    if (replayedStopReason === null && claimed === SAMPLING_STOP_REASON.PAGE_UNIVERSE_EXHAUSTED) {
      const totalPages = manifest.total_pages_refreshed;
      const uniquePages = new Set(audits.map(({ pageIndex }) => pageIndex)).size;
      if (Number.isSafeInteger(totalPages) && totalPages > 0 && totalPages < PLANNED_UNIQUE_PAGES
        && uniquePages === totalPages) replayedStopReason = claimed;
    }

    if (replayedStopReason !== claimed) failures.push("manifest:stop_reason_facts");
    return { ok: failures.length === 0, failures, replayedStopReason };
  } catch {
    return { ok: false, failures: ["request-attempts.jsonl:stop_audit"], replayedStopReason: null };
  }
}

export function validateRunId(runId) {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) {
    throw new Error("run-id must be 1-80 safe filename characters");
  }
  return runId;
}

/** @param {{runId:string, channelAppId:string, artifactRoot:string, now?:Date}} [options] */
export function buildLaneBPreflight({ runId, channelAppId, artifactRoot, now = new Date() } = {}) {
  validateRunId(runId);
  if (typeof channelAppId !== "string" || channelAppId.length === 0) {
    throw new Error("channel-app-id is required");
  }
  const historicalTotalPages = Math.ceil(HISTORICAL_CATALOG_ROWS / PAGE_SIZE);
  return {
    schema_version: 1,
    task: "P2-06.5_LANE_B_B1",
    run_id: runId,
    channel_app_id: channelAppId,
    created_at: now.toISOString(),
    artifact_root: resolve(artifactRoot),
    endpoint_allowlist_count: 1,
    request_contract: {
      method: "POST",
      name: "",
      orderType: 1,
      pageSize: PAGE_SIZE,
      projectType: 1,
    },
    historical_catalog_rows: HISTORICAL_CATALOG_ROWS,
    historical_total_pages: historicalTotalPages,
    planned_unique_pages: PLANNED_UNIQUE_PAGES,
    retry_budget: RETRY_BUDGET,
    http_attempt_cap: HTTP_ATTEMPT_CAP,
    maximum_candidate_rows: PLANNED_UNIQUE_PAGES * PAGE_SIZE,
    target_unique_books: TARGET_BOOKS,
    source_language_upper_bound: SOURCE_LANGUAGE_UPPER_BOUND,
    concurrency: 1,
    min_request_start_interval_ms: 1_000,
    first_page_may_only_recalculate_page_universe: true,
  };
}

async function atomicCreateJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}-${createHash("sha256").update(String(Math.random())).digest("hex").slice(0, 12)}`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    // A hard link publishes the fully-fsynced inode and fails if the final
    // create-only name already exists; no rename-overwrite window is used.
    await link(temporaryPath, path);
    await unlink(temporaryPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function atomicCreateEmpty(path) {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeInitiallyEmptyFile(path, content) {
  const handle = await open(path, "r+");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== 0) {
      const error = new Error("Lane B final selection artifact is not initially empty");
      error.code = "EEXIST";
      throw error;
    }
    await handle.writeFile(content, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** @param {{artifactRoot:string, runId:string, channelAppId:string, preflight:Record<string, unknown>}} options */
export async function createLaneBRunStore({ artifactRoot, runId, channelAppId, preflight }) {
  const root = resolve(artifactRoot);
  const runDir = join(root, validateRunId(runId));
  assertInside(root, runDir);
  const rawPagesDir = join(runDir, "raw-api-pages");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error("Lane B artifact root must be a regular non-symlink directory");
  }
  // A run is create-only. Refusing an existing path before writing prevents a
  // pre-planted run-id symlink from redirecting raw evidence outside root.
  await mkdir(runDir, { recursive: false, mode: 0o700 });
  await mkdir(rawPagesDir, { recursive: false, mode: 0o700 });
  await atomicCreateJson(join(runDir, "preflight.json"), preflight);

  const paths = Object.freeze({
    root,
    runDir,
    rawPagesDir,
    preflight: join(runDir, "preflight.json"),
    bookSamples: join(runDir, "source-book-samples.jsonl"),
    tokenObservations: join(runDir, "source-token-observations.jsonl"),
    structureAnomalies: join(runDir, "source-token-structure-anomalies.jsonl"),
    requestAudit: join(runDir, "request-attempts.jsonl"),
    duplicateAudit: join(runDir, "duplicate-books.jsonl"),
    finalSelection: join(runDir, "final-sample-book-keys.jsonl"),
    rawManifest: join(runDir, "raw-run-manifest.json"),
  });
  const authoritativeJsonlPaths = Object.freeze([
    paths.bookSamples,
    paths.tokenObservations,
    paths.structureAnomalies,
    paths.requestAudit,
    paths.duplicateAudit,
    paths.finalSelection,
  ]);
  await Promise.all(authoritativeJsonlPaths.map((path) => atomicCreateEmpty(path)));

  async function appendJsonl(path, records) {
    if (!Array.isArray(records) || records.length === 0) return;
    if (!authoritativeJsonlPaths.includes(path)) throw new Error("Lane B JSONL path is not allowlisted");
    const content = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    await appendFile(path, content, { encoding: "utf8", mode: 0o600 });
  }

  async function writeRawPage({ pageIndex, attempt, rawText }) {
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 1) throw new Error("Invalid raw page index");
    if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 2) throw new Error("Invalid raw page attempt");
    if (typeof rawText !== "string") throw new Error("Raw page body must be text");
    const path = join(rawPagesDir, `page-${String(pageIndex).padStart(6, "0")}-attempt-${attempt}.json`);
    await writeFile(path, rawText, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return {
      path: relative(runDir, path),
      bytes: Buffer.byteLength(rawText, "utf8"),
      sha256: sha256Bytes(Buffer.from(rawText, "utf8")),
    };
  }

  async function finalizeRawManifest(manifest) {
    if (manifest.channel_app_id !== channelAppId || manifest.run_id !== runId) {
      throw new Error("Raw manifest identity mismatch");
    }
    await atomicCreateJson(paths.rawManifest, manifest);
    return paths.rawManifest;
  }

  let finalizationPromise = null;
  async function finalizeRun({ manifest, selectionRecords }) {
    if (finalizationPromise !== null) return finalizationPromise;
    finalizationPromise = (async () => {
      if (!Array.isArray(selectionRecords)) throw new Error("Lane B final selection records must be an array");
      const selectionContent = `${selectionRecords.map((record) => JSON.stringify(record)).join("\n")}${selectionRecords.length > 0 ? "\n" : ""}`;
      try {
        await writeInitiallyEmptyFile(paths.finalSelection, selectionContent);
        const rawDataArtifacts = await Promise.all(authoritativeJsonlPaths.map(async (path) => ({
          ...await descriptorForFile(runDir, path, { recordCount: true }),
          kind: "raw_data",
        })));
        const rawJsonArtifacts = [{
          ...await descriptorForFile(runDir, paths.preflight),
          kind: "raw_json",
        }];
        const verification = await verifyDescriptors(runDir, [
          ...(manifest.raw_page_artifacts ?? []).map((item) => ({ ...item, kind: "raw_page" })),
          ...rawDataArtifacts,
          ...rawJsonArtifacts,
        ]);
        const semanticVerification = await verifyRawSemanticRoundTrip(runDir, manifest);
        const budgetVerification = verifyRequestAuditBudget(semanticVerification.replay.audits, manifest);
        const rawRoundTripQaPassed = verification.ok && semanticVerification.ok;
        const requestBudgetQaPassed = budgetVerification.computedBudgetQa;
        const finalManifest = {
          ...manifest,
          status: rawRoundTripQaPassed && requestBudgetQaPassed ? manifest.status : "PARTIAL",
          raw_data_artifacts: rawDataArtifacts,
          raw_json_artifacts: rawJsonArtifacts,
          raw_round_trip_qa_passed: rawRoundTripQaPassed,
          request_budget_qa_passed: requestBudgetQaPassed,
        };
        await finalizeRawManifest(finalManifest);
        const committedVerification = await verifyRawRunManifest(runDir);
        manifest.status = finalManifest.status;
        manifest.raw_data_artifacts = rawDataArtifacts;
        manifest.raw_json_artifacts = rawJsonArtifacts;
        manifest.raw_round_trip_qa_passed = finalManifest.raw_round_trip_qa_passed;
        manifest.request_budget_qa_passed = finalManifest.request_budget_qa_passed;
        if (!committedVerification.ok && finalManifest.status === "COMPLETE") {
          throw new Error("Lane B committed COMPLETE manifest failed verification");
        }
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        let storedManifest;
        let storedSelection;
        try {
          [storedManifest, storedSelection] = await Promise.all([
            readFile(paths.rawManifest, "utf8"),
            readFile(paths.finalSelection, "utf8"),
          ]);
        } catch {
          throw error;
        }
        const parsedStoredManifest = JSON.parse(storedManifest);
        const comparableManifest = {
          ...manifest,
          raw_data_artifacts: parsedStoredManifest.raw_data_artifacts,
          raw_json_artifacts: parsedStoredManifest.raw_json_artifacts,
        };
        if (storedManifest !== `${JSON.stringify(comparableManifest, null, 2)}\n` || storedSelection !== selectionContent) {
          throw error;
        }
        manifest.raw_data_artifacts = parsedStoredManifest.raw_data_artifacts;
        manifest.raw_json_artifacts = parsedStoredManifest.raw_json_artifacts;
        manifest.raw_round_trip_qa_passed = parsedStoredManifest.raw_round_trip_qa_passed;
      }
      return Object.freeze({ rawManifest: paths.rawManifest, finalSelection: paths.finalSelection });
    })();
    return finalizationPromise;
  }

  return Object.freeze({ paths, appendJsonl, writeRawPage, finalizeRawManifest, finalizeRun });
}

export async function verifyRawRunManifest(runDir) {
  const root = resolve(runDir);
  const manifestPath = join(root, "raw-run-manifest.json");
  const failures = [];
  let raw;
  let manifest;
  try {
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("invalid raw run root");
    const manifestInfo = await lstat(manifestPath);
    if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) throw new Error("invalid raw manifest file");
    raw = await readFile(manifestPath);
    manifest = JSON.parse(raw.toString("utf8"));
  } catch {
    return { ok: false, failures: ["raw-run-manifest.json"], manifest: null, manifestSha256: null };
  }

  const pageArtifacts = Array.isArray(manifest.raw_page_artifacts) ? manifest.raw_page_artifacts : [];
  const dataArtifacts = Array.isArray(manifest.raw_data_artifacts) ? manifest.raw_data_artifacts : [];
  const jsonArtifacts = Array.isArray(manifest.raw_json_artifacts) ? manifest.raw_json_artifacts : [];
  if (!Array.isArray(manifest.raw_page_artifacts)) failures.push("manifest:raw_page_artifacts");
  if (!Array.isArray(manifest.raw_data_artifacts)) failures.push("manifest:raw_data_artifacts");
  if (!Array.isArray(manifest.raw_json_artifacts)) failures.push("manifest:raw_json_artifacts");
  if (!RAW_RUN_STATUSES.has(manifest.status)) failures.push("manifest:status");

  const exactPathSet = (artifacts, expected, label) => {
    const paths = artifacts.map((artifact) => artifact?.path);
    if (paths.some((path) => typeof path !== "string") || new Set(paths).size !== paths.length) {
      failures.push(`manifest:${label}:invalid_or_duplicate_path`);
      return;
    }
    const sorted = [...paths].sort();
    const expectedSorted = [...expected].sort();
    if (JSON.stringify(sorted) !== JSON.stringify(expectedSorted)) failures.push(`manifest:${label}:path_set`);
  };
  exactPathSet(dataArtifacts, RAW_DATA_ARTIFACT_PATHS, "raw_data_artifacts");
  exactPathSet(jsonArtifacts, RAW_JSON_ARTIFACT_PATHS, "raw_json_artifacts");
  const pagePaths = pageArtifacts.map((artifact) => artifact?.path);
  if (
    pagePaths.some((path) => typeof path !== "string" || !/^raw-api-pages\/page-\d{6}-attempt-[12]\.json$/u.test(path))
    || new Set(pagePaths).size !== pagePaths.length
  ) failures.push("manifest:raw_page_artifacts:path_set");

  const descriptorVerification = await verifyDescriptors(root, [
    ...pageArtifacts.map((item) => ({ ...item, kind: "raw_page" })),
    ...dataArtifacts.map((item) => ({ ...item, kind: "raw_data" })),
    ...jsonArtifacts.map((item) => ({ ...item, kind: "raw_json" })),
  ]);
  failures.push(...descriptorVerification.failures);

  const semanticVerification = await verifyRawSemanticRoundTrip(root, manifest);
  failures.push(...semanticVerification.failures);
  const computedRawRoundTripQa = descriptorVerification.ok && semanticVerification.ok;
  if (manifest.raw_round_trip_qa_passed !== computedRawRoundTripQa) {
    failures.push("manifest:raw_round_trip_qa_passed");
  }

  try {
    const rawPagesDirectory = join(root, "raw-api-pages");
    const rawPagesInfo = await lstat(rawPagesDirectory);
    if (rawPagesInfo.isSymbolicLink() || !rawPagesInfo.isDirectory()) throw new Error("invalid raw page directory");
    const diskPagePaths = [];
    for (const entry of await readdir(rawPagesDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("invalid raw page entry");
      diskPagePaths.push(`raw-api-pages/${entry.name}`);
    }
    if (JSON.stringify(diskPagePaths.sort()) !== JSON.stringify([...pagePaths].sort())) {
      failures.push("raw-api-pages:disk_set");
    }
  } catch {
    failures.push("raw-api-pages");
  }

  const budgetVerification = verifyRequestAuditBudget(semanticVerification.replay.audits, manifest);
  failures.push(...budgetVerification.failures);
  if (manifest.request_budget_qa_passed !== budgetVerification.computedBudgetQa) {
    failures.push("manifest:request_budget_qa_passed");
  }
  const stopVerification = verifySamplingStopReason(semanticVerification.replay.audits, manifest);
  failures.push(...stopVerification.failures);

  const selectionDescriptor = dataArtifacts.find(({ path }) => path === "final-sample-book-keys.jsonl");
  const bookDescriptor = dataArtifacts.find(({ path }) => path === "source-book-samples.jsonl");
  if (selectionDescriptor && manifest.final_sample_books !== selectionDescriptor.record_count) {
    failures.push("manifest:final_sample_books");
  }
  if (bookDescriptor && manifest.candidate_unique_books !== bookDescriptor.record_count) {
    failures.push("manifest:candidate_unique_books");
  }
  if (manifest.status === "COMPLETE" && (
    manifest.successful_pages !== PLANNED_UNIQUE_PAGES
    || manifest.final_sample_books !== TARGET_BOOKS
    || manifest.language_quota_satisfied_or_exhausted !== true
    || manifest.request_budget_qa_passed !== true
    || manifest.raw_round_trip_qa_passed !== true
  )) failures.push("manifest:complete_gate");

  return {
    ok: failures.length === 0,
    failures: [...new Set(failures)],
    manifest,
    manifestSha256: sha256Bytes(raw),
  };
}

export function defaultArtifactRoot(repoRoot) {
  return join(resolve(repoRoot), "artifacts", "p2-06-5-lane-b");
}

export function runDirectoryName(runDir) {
  return basename(resolve(runDir));
}
