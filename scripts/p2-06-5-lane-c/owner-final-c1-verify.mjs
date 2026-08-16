import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Verify accepted C1 v2 artifacts without importing any C1 v3 WIP module. */
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

