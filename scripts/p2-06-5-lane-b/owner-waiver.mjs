import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import { verifyRawRunManifest } from "./run-store.mjs";

const ALLOWED_FAILURE = "request-attempts.jsonl:start_interval";

function fail(message) {
  throw new Error(`P2-06.5 Owner timing waiver invalid: ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readRegularFile(path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) fail("waiver must be a regular non-symlink file");
  return readFile(path);
}

function parseJsonl(text, label) {
  return text.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { fail(`${label}:${index + 1} is invalid JSONL`); }
  });
}

function exactKeys(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
}

const WAIVER_KEYS = [
  "allowed_verification_failures",
  "decision",
  "expected_interval_ms",
  "expected_violation_count",
  "global_min_start_interval_ms",
  "raw_manifest_sha256",
  "raw_run_id",
  "raw_run_status",
  "rerun_b1",
  "schema_version",
  "scope",
  "waiver_id",
].sort();

/**
 * Accept exactly one already-recorded operational timing failure. This does
 * not change verifyRawRunManifest and cannot authorize any other raw defect.
 */
export async function verifyOwnerTimingWaiver({ rawRunDir, waiverPath } = {}) {
  if (typeof rawRunDir !== "string" || rawRunDir.length === 0) fail("rawRunDir is required");
  if (typeof waiverPath !== "string" || waiverPath.length === 0) fail("waiverPath is required");

  const [verification, waiverBytes, attemptBytes] = await Promise.all([
    verifyRawRunManifest(rawRunDir),
    readRegularFile(waiverPath),
    readFile(join(rawRunDir, "request-attempts.jsonl")),
  ]);
  let waiver;
  try { waiver = JSON.parse(waiverBytes.toString("utf8")); } catch { fail("waiver is not valid JSON"); }
  if (JSON.stringify(exactKeys(waiver)) !== JSON.stringify(WAIVER_KEYS)) fail("waiver fields do not match the frozen schema");
  if (waiver.schema_version !== 1) fail("schema_version must be 1");
  if (waiver.decision !== "ACCEPT_WITH_TIMING_WAIVER") fail("decision is not accepted");
  if (waiver.raw_run_status !== "PARTIAL") fail("raw_run_status must remain PARTIAL");
  if (waiver.rerun_b1 !== "NO") fail("rerun_b1 must be NO");
  if (waiver.expected_violation_count !== 6 || waiver.expected_interval_ms !== 999) fail("expected timing facts changed");
  if (waiver.global_min_start_interval_ms !== 1000) fail("global timing contract changed");
  if (!Array.isArray(waiver.scope) || waiver.scope.join("|") !== "LANE_A_FINAL|LANE_B_B2_OFFLINE|LANE_C_C1_OFFLINE") fail("waiver scope changed");
  if (JSON.stringify(waiver.allowed_verification_failures) !== JSON.stringify([ALLOWED_FAILURE])) fail("waiver may allow only start_interval");
  if (verification.ok) fail("waiver must not be used for an otherwise valid run");
  if (verification.manifestSha256 !== waiver.raw_manifest_sha256) fail("raw manifest SHA-256 mismatch");
  if (verification.manifest?.run_id !== waiver.raw_run_id) fail("raw run id mismatch");
  if (verification.manifest?.status !== "PARTIAL") fail("authoritative run no longer reports PARTIAL");
  if (verification.manifest?.raw_round_trip_qa_passed !== true) fail("semantic round-trip did not pass");
  if (verification.manifest?.request_budget_qa_passed !== false) fail("timing QA fact changed");
  if (verification.failures.length !== 1 || verification.failures[0] !== ALLOWED_FAILURE) {
    fail(`raw verification has non-waived failures: ${verification.failures.join(",")}`);
  }

  const attempts = parseJsonl(attemptBytes.toString("utf8"), "request-attempts");
  const violations = attempts.slice(1).flatMap((attempt, index) => {
    const prior = attempts[index];
    const intervalMs = Date.parse(attempt.requestStartedAt) - Date.parse(prior.requestStartedAt);
    return intervalMs < waiver.global_min_start_interval_ms
      ? [{ previous_attempt: index + 1, next_attempt: index + 2, interval_ms: intervalMs }]
      : [];
  });
  if (violations.length !== waiver.expected_violation_count
    || violations.some(({ interval_ms: intervalMs }) => intervalMs !== waiver.expected_interval_ms)) {
    fail(`observed timing violations changed: ${JSON.stringify(violations)}`);
  }

  return Object.freeze({
    accepted: true,
    status: "PARTIAL_TIMING_WAIVER_ACCEPTED",
    verification,
    waiver,
    waiverSha256: sha256(waiverBytes),
    violations,
  });
}
