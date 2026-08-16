import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createVerifiedB2RawRun } from "./b2-input.test";
import { runB2Io } from "../../../scripts/p2-06-5-lane-b/b2-io.mjs";

const canonical = { canonical_version: "v1", tags: [{ canonical_tag_id: "ct", slug: "tag", display_name: "Tag", locale_scope: "*", definition: "definition", include: ["include"], exclude: ["exclude"], status: "public" }] };
const scores = { literal_meaning: 1, sample_semantic_evidence: 1, cooccurrence_evidence: 1, canonical_definition_fit: 1, filter_semantic_fit: 1 };

function fixtureBooks(tokens: string[]) {
  return tokens.flatMap((token) => Array.from({ length: 5 }, (_, index) => ({
    sampleBookKey: `${token}-${index}`,
    externalBookIdRaw: `${token}-${index}`,
    titleRaw: `Title ${token} ${index}`,
    descriptionRaw: `Description ${token} ${index}`,
    descriptionPresent: true,
    languageJsonValue: 2,
    sourceLanguageNameRaw: "English",
    seriesTypeListRaw: [token],
  })));
}

function selectedAll(books: any[]) {
  return books.map((book, index) => ({ sampleBookKey: book.sampleBookKey, selectedSampleIndex: index + 1 }));
}

describe("P2-06.5 B2 I/O boundary", () => {
  it("reads offline bytes/JSONL and create-only writes a compact manifest", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "p2-06-5-b2-"));
    const artifact = JSON.stringify(canonical); const expectedSha256 = createHash("sha256").update(artifact).digest("hex");
    const canonicalPath = path.join(directory, "canonical.json"); const sourceGroupsPath = path.join(directory, "groups.jsonl"); const outputDir = path.join(directory, "out");
    await writeFile(canonicalPath, artifact);
    const books = fixtureBooks(["爱情"]);
    const rawRunDir = await createVerifiedB2RawRun({ books, selection: selectedAll(books), runId: "b2-io-main", channelAppId: "app" });
    const template = await import("../../../scripts/p2-06-5-lane-b/b2-input.mjs").then(({ loadB2SourceGroupTemplateFromRawRun }) => loadB2SourceGroupTemplateFromRawRun({ rawRunDir, channelAppId: "app" }));
    const reviewed = template.records.map((record: any) => ({ ...record, proposals: [{ canonical_tag_id: "ct", target_locale: "zh", scores, evidence: {}, reason: "Real samples and definition align.", risk: "NONE_IDENTIFIED" }] }));
    await writeFile(sourceGroupsPath, `${reviewed.map((record: any) => JSON.stringify(record)).join("\n")}\n`);
    const io = { canonicalPath, expectedSha256, sourceGroupsPath, outputDir, rawRunDir, channelAppId: "app" };
    const output = await runB2Io(io);
    expect(output.summary.LANE_B_MAPPING_STATUS).toBe("COMPLETE_CANDIDATES_GENERATED");
    const manifest = JSON.parse(await readFile(path.join(outputDir, "b2-manifest.json"), "utf8"));
    expect(manifest.files).toEqual(expect.arrayContaining([expect.objectContaining({ filename: "mapping-candidates.csv", bytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })]));
    expect(JSON.stringify(manifest)).not.toContain("bytes_base64");
    expect(manifest).toMatchObject({ raw_manifest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/), source_evidence_sha256: expect.stringMatching(/^[a-f0-9]{64}$/), final_sample_book_count: 5 });
    await expect(runB2Io(io)).rejects.toThrow(/refusing to overwrite/);
  });

  it("rejects symlink inputs and refuses to replace even an empty output directory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "p2-06-5-b2-"));
    const artifact = JSON.stringify(canonical); const expectedSha256 = createHash("sha256").update(artifact).digest("hex");
    const canonicalPath = path.join(directory, "canonical.json"); const sourceGroupsPath = path.join(directory, "groups.jsonl"); const aliasPath = path.join(directory, "canonical-alias.json"); const sourceAliasPath = path.join(directory, "groups-alias.jsonl"); const reviewPath = path.join(directory, "review.jsonl"); const reviewAliasPath = path.join(directory, "review-alias.jsonl"); const outputDir = path.join(directory, "out");
    await writeFile(canonicalPath, artifact); await writeFile(sourceGroupsPath, ""); await writeFile(reviewPath, ""); await symlink(canonicalPath, aliasPath); await symlink(sourceGroupsPath, sourceAliasPath); await symlink(reviewPath, reviewAliasPath);
    const emptyRawRunDir = await createVerifiedB2RawRun({ books: [], selection: [], runId: "b2-io-empty", channelAppId: "app" });
    const base = { expectedSha256, outputDir, rawRunDir: emptyRawRunDir, channelAppId: "app" };
    await expect(runB2Io({ ...base, canonicalPath: aliasPath, sourceGroupsPath })).rejects.toThrow(/regular non-symlink/);
    await writeFile(sourceGroupsPath, "");
    await expect(runB2Io({ ...base, canonicalPath, sourceGroupsPath: sourceAliasPath })).rejects.toThrow(/regular non-symlink/);
    await expect(runB2Io({ ...base, canonicalPath, sourceGroupsPath, reviewRecordsPath: reviewAliasPath })).rejects.toThrow(/regular non-symlink/);
    await mkdir(outputDir);
    await expect(runB2Io({ ...base, canonicalPath, sourceGroupsPath })).rejects.toThrow(/existing outputDir/);
    expect((await lstat(outputDir)).isDirectory()).toBe(true);
    expect(await readdir(outputDir)).toEqual([]);
  });

  it("reads optional offline semantic-cluster JSONL and carries mapped plus unmapped members", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "p2-06-5-b2-semantic-"));
    const artifact = JSON.stringify(canonical);
    const expectedSha256 = createHash("sha256").update(artifact).digest("hex");
    const canonicalPath = path.join(directory, "canonical.json");
    const sourceGroupsPath = path.join(directory, "groups.jsonl");
    const semanticClusterCandidatesPath = path.join(directory, "semantic-clusters.jsonl");
    const outputDir = path.join(directory, "out");
    await writeFile(canonicalPath, artifact);
    const books = fixtureBooks(["霸总", "强势老板"]);
    const rawRunDir = await createVerifiedB2RawRun({ books, selection: selectedAll(books), runId: "b2-io-semantic", channelAppId: "app" });
    const template = await import("../../../scripts/p2-06-5-lane-b/b2-input.mjs").then(({ loadB2SourceGroupTemplateFromRawRun }) => loadB2SourceGroupTemplateFromRawRun({ rawRunDir, channelAppId: "app" }));
    const reviewed = template.records.map((record: any) => record.exact_raw_token === "霸总"
      ? { ...record, proposals: [{ canonical_tag_id: "ct", target_locale: "zh", scores, evidence: {}, reason: "Real samples align.", risk: "NONE_IDENTIFIED" }] }
      : { ...record, proposals: [], unmapped_reason: "SEMANTIC_UNCERTAIN" });
    const identities = template.records.map((record: any) => record.group_identity);
    await writeFile(sourceGroupsPath, `${reviewed.map((item: any) => JSON.stringify(item)).join("\n")}\n`);
    await writeFile(semanticClusterCandidatesPath, `${JSON.stringify({ cluster_id: "offline-1", canonical_tag_id: null, recommendation: "UNDECIDED", confidence: 0.75, review_status: "HUMAN_REVIEW_REQUIRED", reason: "Requires review.", risk: "Possible over-merge.", members: identities.map((group_identity: string) => ({ group_identity })) })}\n`);
    await runB2Io({ canonicalPath, expectedSha256, sourceGroupsPath, semanticClusterCandidatesPath, outputDir, rawRunDir, channelAppId: "app" });
    const clusterCsv = await readFile(path.join(outputDir, "source-token-semantic-clusters.csv"), "utf8");
    expect(clusterCsv).toContain("offline-1,OFFLINE_SEMANTIC_CANDIDATE");
    expect(clusterCsv).toContain("强势老板");
  });
});
