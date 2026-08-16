/** P2-06.5 Lane B B2 filesystem boundary — offline, create-only output. */
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadB2SourceGroupTemplateFromRawRun } from "./b2-input.mjs";
import { buildB2ArtifactBundle, finalizeMappingCandidates, prepareMappingReview } from "./b2-mapping.mjs";

function fail(message) { throw new Error(`P2-06.5 Lane B B2 I/O: ${message}`); }

/** Read strict JSONL: blank lines are ignored; each nonblank line must be JSON. */
export async function readJsonl(filePath) {
  const input = await readRegularFile(filePath, "utf8");
  return input.split(/\r?\n/).filter((line) => line.length > 0).map((line, index) => {
    try { return JSON.parse(line); } catch { fail(`${filePath}:${index + 1} is not valid JSONL`); }
  });
}

async function readRegularFile(filePath, encoding) {
  let metadata;
  try { metadata = await lstat(filePath); } catch { fail(`input file cannot be read`); }
  if (metadata.isSymbolicLink() || !metadata.isFile()) fail(`input must be a regular non-symlink file`);
  return readFile(filePath, encoding);
}

async function createOnly(filePath, content) {
  try { await writeFile(filePath, content, { encoding: "utf8", flag: "wx" }); }
  catch (error) { if (error && typeof error === "object" && error.code === "EEXIST") fail(`refusing to overwrite existing output ${filePath}`); throw error; }
}

/**
 * Reads canonical bytes / source JSONL / optional second-blind-review JSONL,
 * compiles B2, then stages and renames a complete bundle (never overwrites).
 */
export async function runB2Io({
  canonicalPath,
  expectedSha256,
  sourceGroupsPath,
  reviewRecordsPath,
  semanticClusterCandidatesPath,
  outputDir,
  actualSha256,
  rawRunDir,
  channelAppId,
} = {}) {
  for (const [name, value] of Object.entries({ canonicalPath, expectedSha256, sourceGroupsPath, outputDir })) {
    if (typeof value !== "string" || value.length === 0) fail(`${name} must be a non-empty path/string`);
  }
  if (typeof rawRunDir !== "string" || rawRunDir.length === 0) fail("rawRunDir must be a non-empty path");
  if (typeof channelAppId !== "string" || channelAppId.length === 0) fail("channelAppId must be a non-empty exact source id");
  const [artifact, source_groups, blind_review_records, semantic_cluster_candidates] = await Promise.all([
    readRegularFile(canonicalPath),
    readJsonl(sourceGroupsPath),
    reviewRecordsPath ? readJsonl(reviewRecordsPath) : Promise.resolve([]),
    semanticClusterCandidatesPath ? readJsonl(semanticClusterCandidatesPath) : Promise.resolve([]),
  ]);
  const authoritative = await loadB2SourceGroupTemplateFromRawRun({ rawRunDir, channelAppId });
  const prepared = prepareMappingReview({
    artifact,
    expectedSha256,
    actualSha256,
    authoritative_source_groups: authoritative.records,
    reviewed_source_groups: source_groups,
    final_sample_book_ids: authoritative.finalSampleBookIds,
    raw_manifest_sha256: authoritative.rawManifestSha256,
    semantic_cluster_candidates,
  });
  const result = finalizeMappingCandidates({ prepared, blind_review_records });
  const bundle = buildB2ArtifactBundle(result);
  const manifest = {
    canonical_version: result.canonical_version,
    canonical_sha256: result.canonical_sha256,
    raw_manifest_sha256: result.raw_manifest_sha256,
    source_evidence_sha256: result.source_evidence_sha256,
    semantic_cluster_candidates_sha256: result.semantic_cluster_candidates_sha256,
    final_sample_book_count: result.final_sample_book_ids.length,
    files: bundle.files.map(({ name, sha256, content }) => ({ filename: name, sha256, bytes: Buffer.byteLength(content, "utf8") })),
  };
  const parent = path.dirname(outputDir);
  const basename = path.basename(outputDir);
  await mkdir(parent, { recursive: true });
  try {
    const outputMetadata = await lstat(outputDir);
    if (outputMetadata.isSymbolicLink() || !outputMetadata.isDirectory()) fail(`outputDir must be a non-symlink directory path`);
    if ((await readdir(outputDir)).length === 0) {
      fail(`refusing to replace an existing outputDir; choose a new path`);
    }
    fail(`refusing to overwrite non-empty outputDir`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const staging = await mkdtemp(path.join(parent, `.${basename}.staging-`));
  try {
    for (const entry of bundle.files) await createOnly(path.join(staging, entry.name), entry.content);
    await createOnly(path.join(staging, "b2-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(staging, outputDir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return { summary: result.summary, manifest };
}
