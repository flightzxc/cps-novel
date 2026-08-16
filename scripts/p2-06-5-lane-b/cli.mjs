#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { analyzeLaneBRun, verifyB1ArtifactBundle } from "./artifacts.mjs";
import { runB2Io } from "./b2-io.mjs";
import { runB2OwnerFinal, verifyB2FinalBundle } from "./b2-final.mjs";
import { writeB2SourceGroupTemplateFromRawRun } from "./b2-input.mjs";
import { discardLaneBOwnerCredential, prepareLaneBOwnerCredential } from "./http-client.mjs";
import { buildLaneBPreflight, createLaneBRunStore, defaultArtifactRoot, verifyRawRunManifest } from "./run-store.mjs";
import { runLaneBSampling } from "./sampler.mjs";
import { scanLaneBArtifactsForSecrets } from "./secret-scan.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function usage() {
  return `P2-06.5 Lane B

Commands:
  preflight --run-id ID --channel-app-id ID [--artifact-root PATH]
  sample --run-id ID --channel-app-id ID --credential-file OUTSIDE_REPO_PATH [--artifact-root PATH]
  analyze --raw-run-dir PATH --output-dir PATH --channel-app-id ID
  verify-raw --raw-run-dir PATH
  verify-b1 --output-dir PATH
  b2-template --raw-run-dir PATH --channel-app-id ID --output PATH
  b2 --canonical PATH --canonical-sha256-file PATH --source-groups PATH --raw-run-dir PATH --channel-app-id ID --output-dir PATH [--blind-review PATH] [--semantic-clusters PATH]
  b2-finalize --canonical PATH --canonical-sha256-file PATH --cross-review-matrix PATH --owner-waiver PATH --raw-run-dir PATH --channel-app-id ID --output-dir PATH
  verify-b2-final --output-dir PATH

No command accepts a JWT value. Only sample reads --credential-file once.
`;
}

function parse(argv) {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return { command: null, values: { help: true } };
  }
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    strict: true,
    allowPositionals: false,
    options: {
      "run-id": { type: "string" },
      "channel-app-id": { type: "string" },
      "artifact-root": { type: "string" },
      "credential-file": { type: "string" },
      "raw-run-dir": { type: "string" },
      "output-dir": { type: "string" },
      output: { type: "string" },
      canonical: { type: "string" },
      "canonical-sha256-file": { type: "string" },
      "source-groups": { type: "string" },
      "blind-review": { type: "string" },
      "semantic-clusters": { type: "string" },
      "cross-review-matrix": { type: "string" },
      "owner-waiver": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  return { command, values };
}

function required(values, name) {
  const value = values[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`--${name} is required`);
  return value;
}

function safeOutputPath(value) {
  return typeof value === "string" ? value : null;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const { command, values } = parse(argv);
  if (!command || values.help) {
    process.stdout.write(usage());
    return 0;
  }
  if (command === "preflight") {
    const artifactRoot = resolve(values["artifact-root"] ?? defaultArtifactRoot(REPO_ROOT));
    print(buildLaneBPreflight({
      runId: required(values, "run-id"),
      channelAppId: required(values, "channel-app-id"),
      artifactRoot,
    }));
    return 0;
  }
  if (command === "sample") {
    const runId = required(values, "run-id");
    const channelAppId = required(values, "channel-app-id");
    const credentialFile = required(values, "credential-file");
    const artifactRoot = resolve(values["artifact-root"] ?? defaultArtifactRoot(REPO_ROOT));
    const preflight = buildLaneBPreflight({ runId, channelAppId, artifactRoot });
    print({ phase: "PREFLIGHT", ...preflight });
    // Credential validation happens before the create-only run path is claimed.
    // The opaque capsule is consumed once by the HTTP client and cannot be
    // serialized or exposed through CLI arguments, logs, manifests, or errors.
    const credentialCapsule = await prepareLaneBOwnerCredential({ credentialFile, repoRoot: REPO_ROOT });
    let store;
    try {
      store = await createLaneBRunStore({ artifactRoot, runId, channelAppId, preflight });
    } catch (error) {
      discardLaneBOwnerCredential(credentialCapsule);
      throw error;
    }
    const result = await runLaneBSampling({ credentialCapsule, repoRoot: REPO_ROOT, channelAppId, store });
    const secretQa = await scanLaneBArtifactsForSecrets(store.paths.runDir);
    if (!secretQa.ok) throw new Error("Lane B artifact secret scan failed");
    print({ phase: "B1_RAW_COMPLETE", run_dir: store.paths.runDir, manifest: result.manifest });
    return result.manifest.status === "COMPLETE" ? 0 : 2;
  }
  if (command === "analyze") {
    const result = await analyzeLaneBRun({
      rawRunDir: resolve(required(values, "raw-run-dir")),
      outputDir: resolve(required(values, "output-dir")),
      channelAppId: required(values, "channel-app-id"),
    });
    print(result);
    return result.laneBSampleStatus === "COMPLETE" ? 0 : 2;
  }
  if (command === "verify-raw") {
    const result = await verifyRawRunManifest(resolve(required(values, "raw-run-dir")));
    print(result);
    return result.ok ? 0 : 1;
  }
  if (command === "verify-b1") {
    const result = await verifyB1ArtifactBundle(resolve(required(values, "output-dir")));
    print(result);
    return result.ok ? 0 : 1;
  }
  if (command === "b2-template") {
    const count = await writeB2SourceGroupTemplateFromRawRun({
      rawRunDir: resolve(required(values, "raw-run-dir")),
      channelAppId: required(values, "channel-app-id"),
      outputPath: resolve(required(values, "output")),
    });
    print({ source_group_templates: count, output: safeOutputPath(values.output) });
    return 0;
  }
  if (command === "b2") {
    const shaFile = resolve(required(values, "canonical-sha256-file"));
    const expectedSha256 = (await readFile(shaFile, "utf8")).trim().split(/\s+/u)[0];
    const result = await runB2Io({
      canonicalPath: resolve(required(values, "canonical")),
      expectedSha256,
      sourceGroupsPath: resolve(required(values, "source-groups")),
      rawRunDir: resolve(required(values, "raw-run-dir")),
      channelAppId: required(values, "channel-app-id"),
      reviewRecordsPath: typeof values["blind-review"] === "string" ? resolve(values["blind-review"]) : undefined,
      semanticClusterCandidatesPath: typeof values["semantic-clusters"] === "string" ? resolve(values["semantic-clusters"]) : undefined,
      outputDir: resolve(required(values, "output-dir")),
    });
    print(result);
    return result.summary.LANE_B_MAPPING_STATUS === "COMPLETE_CANDIDATES_GENERATED" ? 0 : 2;
  }
  if (command === "b2-finalize") {
    const shaFile = resolve(required(values, "canonical-sha256-file"));
    const canonicalSha256 = (await readFile(shaFile, "utf8")).trim().split(/\s+/u)[0];
    const result = await runB2OwnerFinal({
      canonicalPath: resolve(required(values, "canonical")),
      canonicalSha256,
      matrixPath: resolve(required(values, "cross-review-matrix")),
      waiverPath: resolve(required(values, "owner-waiver")),
      rawRunDir: resolve(required(values, "raw-run-dir")),
      channelAppId: required(values, "channel-app-id"),
      outputDir: resolve(required(values, "output-dir")),
    });
    print(result);
    return result.summary.B2_OWNER_REVIEW_REMAINING === 0 ? 0 : 2;
  }
  if (command === "verify-b2-final") {
    const result = await verifyB2FinalBundle(resolve(required(values, "output-dir")));
    print(result);
    return result.ok ? 0 : 1;
  }
  throw new Error(`unknown Lane B command: ${command}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    // Never print response bodies, arguments, credential paths, stacks, or
    // arbitrary error messages: a dependency could reflect credential data.
    const code = typeof error?.code === "string" ? error.code : "lane_b_command_failed";
    process.stderr.write(`${JSON.stringify({ error: code, message: "Lane B command failed safely" })}\n`);
    process.exitCode = 1;
  });
}
