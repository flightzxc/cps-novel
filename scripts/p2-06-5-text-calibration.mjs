#!/usr/bin/env node
/**
 * P2-06.5 Lane C offline calibration entry point.
 *
 * This command deliberately has no database, network, adapter, Worker, or
 * Scheduler dependencies.  It accepts only local JSON and JSONL snapshots.
 */
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

import {
  assertDirectoryEmpty,
  buildArtifactBundle,
  buildAuditQueue,
  buildC2Run,
  mergeReviewDecisions,
  readJsonFile,
  readJsonlFile,
  scoreCalibration,
  validatePreviewCorpus,
  validateSamples,
  validateSourceMapping,
  validateTaxonomy,
  summarizeC2Reviews,
  writeArtifactBundle,
} from "./p2-06-5-lane-c/calibration.mjs";
import { verifyOwnerFinalC1 } from "./p2-06-5-lane-c/owner-final-c1-verify.mjs";
import {
  POST_FIX_POPULATION_SAMPLE_TARGET,
  POST_FIX_RISK_CELLS,
  POST_FIX_RISK_SAMPLE_TARGET,
  buildDescriptionOnlyBlindReview,
} from "./p2-06-5-lane-c/description-only-blind-review.mjs";

/**
 * Frozen so a plain rerun of the blind-review builder is byte-identical.
 * Override with --generated-at only when deliberately cutting a new package.
 */
const DESCRIPTION_ONLY_REVIEW_GENERATED_AT = "2026-08-16T15:00:00+09:00";

function usage() {
  return [
    "Usage:",
    "  node scripts/p2-06-5-text-calibration.mjs score --samples samples.jsonl --taxonomy taxonomy-keywords.json --output-dir /tmp/lane-c [--source-mapping source-mapping.json] [--run-id id] [--generated-at ISO]",
    "  node scripts/p2-06-5-text-calibration.mjs review --samples samples.jsonl --taxonomy taxonomy-keywords.json --reviews reviews.jsonl --output-dir /tmp/lane-c [--source-mapping source-mapping.json] [--run-id id] [--generated-at ISO]",
    "  node scripts/p2-06-5-text-calibration.mjs c2 --samples samples.jsonl --taxonomy taxonomy-keywords.json --preview-corpus preview-corpus.jsonl --output-dir /tmp/lane-c [--source-mapping source-mapping.json] [--run-id id] [--generated-at ISO]",
    "  node scripts/p2-06-5-text-calibration.mjs owner-final-c1 --raw-run-dir PATH --owner-waiver PATH --b2-dir PATH --canonical PATH --canonical-sha256-file PATH --channel-app-id ID --authoritative-output-dir PATH --tracked-output-dir PATH [--run-id ID] [--generated-at ISO] [--lexicon-override PATH]",
    "  node scripts/p2-06-5-text-calibration.mjs verify-owner-final-c1 --tracked-output-dir PATH",
    "  node scripts/p2-06-5-text-calibration.mjs description-only-blind-review --run-dir PATH --canonical PATH --output-dir PATH [--generated-at ISO] [--population-target N] [--risk-target N]",
    "",
    "Output directories must be absent or empty. All source files are read-only.",
  ].join("\n");
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") return { command: "help", options: {} };
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) throw new TypeError(usage());
    options[key.slice(2)] = value;
  }
  return { command, options };
}

function required(options, key) {
  const value = options[key];
  if (!value) throw new TypeError(`Missing --${key}\n\n${usage()}`);
  return resolve(value);
}

function optional(options, key) {
  return options[key] ? resolve(options[key]) : null;
}

function metadata(options) {
  return {
    runId: options["run-id"] ?? "UNSPECIFIED",
    generatedAt: options["generated-at"] ?? new Date().toISOString(),
  };
}

async function inputs(options, { previewRequired = false, reviewsRequired = false } = {}) {
  const samples = validateSamples(await readJsonlFile(required(options, "samples")));
  const taxonomy = validateTaxonomy(await readJsonFile(required(options, "taxonomy")));
  const mappingPath = optional(options, "source-mapping");
  const sourceMapping = mappingPath ? validateSourceMapping(await readJsonFile(mappingPath), taxonomy) : null;
  const previewPath = optional(options, "preview-corpus");
  if (previewRequired && !previewPath) throw new TypeError(`Missing --preview-corpus\n\n${usage()}`);
  const previewCorpus = previewPath ? validatePreviewCorpus(await readJsonlFile(previewPath), samples.samples) : null;
  const reviewPath = optional(options, "reviews");
  if (reviewsRequired && !reviewPath) throw new TypeError(`Missing --reviews\n\n${usage()}`);
  const reviews = reviewPath ? await readJsonlFile(reviewPath) : null;
  return { samples, taxonomy, sourceMapping, previewCorpus, reviews };
}

async function write(outputDirectory, scored, auditQueue, review, c2Review = null) {
  await assertDirectoryEmpty(outputDirectory);
  const bundle = buildArtifactBundle(scored, { auditQueue, review, c2Review });
  await writeArtifactBundle(outputDirectory, bundle);
  process.stdout.write(`${JSON.stringify({ outputDirectory, status: scored.status, mode: scored.mode, artifacts: bundle.manifest.artifacts.length }, null, 2)}\n`);
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (command === "verify-owner-final-c1") {
    const verification = await verifyOwnerFinalC1(required(options, "tracked-output-dir"));
    process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
    if (!verification.ok) process.exitCode = 1;
    return;
  }
  if (command === "owner-final-c1") {
    const { runOwnerFinalC1, FROZEN_GENERATED_AT_BY_RUN_ID } = await import("./p2-06-5-lane-c/owner-final-c1.mjs");
    const canonicalSha256 = (await readFile(required(options, "canonical-sha256-file"), "utf8")).trim().split(/\s/u)[0];
    // Reproducing an authoritative run must not hinge on the operator recalling
    // its exact timestamp: asking for that run id is enough.  Any unregistered
    // run id still gets a live timestamp, so a future run cannot be stamped
    // with an authoritative run's identity by accident.
    const runId = options["run-id"] ?? "UNSPECIFIED";
    const result = await runOwnerFinalC1({
      rawRunDir: required(options, "raw-run-dir"),
      waiverPath: required(options, "owner-waiver"),
      b2Dir: required(options, "b2-dir"),
      canonicalPath: required(options, "canonical"),
      canonicalSha256,
      channelAppId: options["channel-app-id"] ?? "",
      authoritativeOutputDir: required(options, "authoritative-output-dir"),
      trackedOutputDir: required(options, "tracked-output-dir"),
      lexiconOverridePath: optional(options, "lexicon-override"),
      runId,
      generatedAt: options["generated-at"]
        ?? FROZEN_GENERATED_AT_BY_RUN_ID[runId]
        ?? new Date().toISOString(),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "description-only-blind-review") {
    const populationTarget = options["population-target"] ? Number(options["population-target"]) : undefined;
    const riskTarget = options["risk-target"] ? Number(options["risk-target"]) : undefined;
    const postFix = populationTarget === POST_FIX_POPULATION_SAMPLE_TARGET && riskTarget === POST_FIX_RISK_SAMPLE_TARGET;
    const result = await buildDescriptionOnlyBlindReview({
      runDir: required(options, "run-dir"),
      canonicalPath: required(options, "canonical"),
      outputDir: required(options, "output-dir"),
      generatedAt: options["generated-at"] ?? DESCRIPTION_ONLY_REVIEW_GENERATED_AT,
      ...(populationTarget ? { populationTarget } : {}),
      ...(riskTarget ? { riskTarget } : {}),
      ...(postFix ? { riskCells: POST_FIX_RISK_CELLS, packageName: "post-fix-description-only-blind-review" } : {}),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const outputDirectory = required(options, "output-dir");
  const run = metadata(options);
  if (command === "score" || command === "review") {
    const input = await inputs(options, { reviewsRequired: command === "review" });
    const scored = scoreCalibration({ ...input, ...run });
    const auditQueue = buildAuditQueue(scored);
    const review = command === "review" ? mergeReviewDecisions(scored, auditQueue, input.reviews) : null;
    await write(outputDirectory, scored, auditQueue, review);
    return;
  }
  if (command === "c2") {
    const input = await inputs(options, { previewRequired: true });
    const scored = buildC2Run({ ...input, ...run });
    const auditQueue = buildAuditQueue(scored);
    const c2Review = input.reviews ? summarizeC2Reviews(scored.chapterAuditQueue, input.reviews) : null;
    await write(outputDirectory, scored, auditQueue, null, c2Review);
    return;
  }
  throw new TypeError(`Unknown command ${command}\n\n${usage()}`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
