import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadB2SourceGroupTemplateFromRawRun,
  writeB2SourceGroupTemplateFromRawRun,
} from "../../../scripts/p2-06-5-lane-b/b2-input.mjs";
import { rawLanguageIdentity } from "../../../scripts/p2-06-5-lane-b/raw.mjs";
import { buildLaneBPreflight, createLaneBRunStore, verifyRawRunManifest } from "../../../scripts/p2-06-5-lane-b/run-store.mjs";
import { selectFinalBooks } from "../../../scripts/p2-06-5-lane-b/sampler.mjs";
import { parseLaneBPage } from "../../../scripts/p2-06-5-lane-b/upstream-parser.mjs";

export async function createVerifiedB2RawRun({ books, anomalies = [], runId = "b2-fixture", channelAppId = "channel-app-1" }: any) {
  const artifactRoot = await mkdtemp(join(tmpdir(), "lane-b-b2-raw-root-"));
  const preflight = buildLaneBPreflight({ runId, channelAppId, artifactRoot });
  const store = await createLaneBRunStore({ artifactRoot, runId, channelAppId, preflight });
  const fetchedAt = "2026-08-13T00:00:00.000Z";
  const rows = books.map((book: any, index: number) => {
    const seriesTypeList = [...book.seriesTypeListRaw];
    const row: Record<string, unknown> = {
      id: book.externalBookIdRaw,
      seriesName: book.titleRaw,
      language: book.languageJsonValue,
      seriesTypeList,
    };
    if (Object.hasOwn(book, "sourceLanguageNameRaw")) row.languageName = book.sourceLanguageNameRaw;
    if (book.descriptionPresent === true || Object.hasOwn(book, "descriptionRaw")) row.description = book.descriptionRaw;
    if (index === 0 && anomalies.length > 0) seriesTypeList.push(anomalies[0].rawItemJson);
    return row;
  });
  const payload = { data: { totalCount: rows.length, list: rows } };
  const rawText = JSON.stringify(payload);
  const rawPageArtifact = await store.writeRawPage({ pageIndex: 1, attempt: 1, rawText });
  const parsed = parseLaneBPage({ payload, pageIndex: 1, fetchedAt, channelAppId });
  const parsedBooks = parsed.books.map((book, index) => ({ ...book, acquisitionIndex: index + 1 }));
  await store.appendJsonl(store.paths.bookSamples, parsedBooks);
  await store.appendJsonl(store.paths.tokenObservations, parsed.observations);
  await store.appendJsonl(store.paths.structureAnomalies, parsed.anomalies);
  await store.appendJsonl(store.paths.requestAudit, [{ schemaVersion: 1, pageIndex: 1, attemptNumber: 1, isRetry: false, selection: { wave: 0, reason: "TEST_FIXTURE" }, requestedAt: fetchedAt, requestStartedAt: fetchedAt, responseReceivedAt: fetchedAt, status: 200, ok: true, errorCode: null, retryable: false, durationMs: 0 }]);
  const selectionRecords = selectFinalBooks(parsedBooks, parsed.observations).selectionAudit.map((entry) => ({
    sampleBookKey: entry.bookIdentity,
    selectedSampleIndex: entry.selectedSampleIndex,
    selectionReason: entry.selectionReason,
  }));
  await store.finalizeRun({
    selectionRecords,
    manifest: {
      schema_version: 1, run_id: runId, channel_app_id: channelAppId, status: "PARTIAL",
      total_count_refreshed: books.length, total_pages_refreshed: Math.max(1, Math.ceil(books.length / 100)),
      planned_unique_pages: 240, retry_budget: 10, http_attempt_cap: 250,
      actual_http_attempts: 1, actual_unique_pages: 1, successful_pages: 1, retry_attempts: 0,
      stop_reason: null, candidate_unique_books: parsedBooks.length,
      final_sample_books: selectionRecords.length, target_unique_books: 10_000,
      duplicate_book_observations: 0, language_quota_satisfied_or_exhausted: false,
      raw_round_trip_qa_passed: false, request_budget_qa_passed: true, raw_page_artifacts: [rawPageArtifact],
    },
  });
  const verified = await verifyRawRunManifest(store.paths.runDir);
  if (!verified.ok) throw new Error(`fixture raw run invalid: ${verified.failures.join(",")}`);
  return store.paths.runDir;
}

describe("P2-06.5 Lane B B1 to B2 source-group handoff", () => {
  it("uses only final selection, complete carrier ids, formula-sized evidence, cooccurrence and no guessed proposals", async () => {
    const scope = rawLanguageIdentity(2, "English");
    const books = Array.from({ length: 105 }, (_, index) => ({
      schemaVersion: 1,
      sourceScope: "upstream-will-be-overridden",
      sampleBookKey: `book-${String(index).padStart(3, "0")}`,
      externalBookIdRaw: index + 1,
      titleRaw: `Title ${index}`,
      descriptionRaw: index === 0 ? { rich: ["exact", 1] } : `Description ${index}`,
      descriptionPresent: true,
      languageJsonValue: 2,
      sourceLanguageNameRaw: "English",
      rawLanguageScope: scope,
      seriesTypeListRaw: index < 100 ? ["A", "B"] : ["A", "CANDIDATE_ONLY"],
      acquisitionIndex: index + 1,
      pageIndex: Math.floor(index / 100) + 1,
      rowIndex: index % 100,
      fetchedAt: "2026-08-13T00:00:00.000Z",
    }));
    const selection = books.slice(0, 100).map((book, index) => ({
      sampleBookKey: book.sampleBookKey,
      selectedSampleIndex: index + 1,
    }));
    const anomalies = [{
      sampleBookKey: books[0].sampleBookKey,
      sourceScope: "channel-app-1",
      rawLanguageScope: scope,
      reason: "AMBIGUOUS_STRING_CANDIDATES",
      structureStatus: "AMBIGUOUS_OBJECT",
      rawItemJson: { value: "one", name: "two" },
    }];
    const rawRunDir = await createVerifiedB2RawRun({ books, selection, anomalies });

    const loaded = await loadB2SourceGroupTemplateFromRawRun({
      rawRunDir,
      channelAppId: "channel-app-1",
    });
    expect(loaded.analysis.summary).toMatchObject({ actualUniqueBooks: 105, candidateUniqueBooks: 105 });
    expect(loaded.analysis.anomalies).toHaveLength(1);
    expect(loaded.records.map(({ exact_raw_token }) => exact_raw_token).sort()).toEqual(["A", "B", "CANDIDATE_ONLY"]);

    const a = loaded.records.find(({ exact_raw_token }) => exact_raw_token === "A")!;
    expect(a.channel_app_id).toBe("channel-app-1");
    expect(a.raw_language_scope).toBe(scope);
    expect(a.frequency).toBe(105);
    expect(a.carrier_book_ids).toHaveLength(105);
    expect(new Set(a.carrier_book_ids).size).toBe(105);
    expect(a.carrier_book_ids_complete).toBe(true);
    expect(a.evaluation_sample_count).toBe(11);
    expect(a.samples).toHaveLength(11);
    expect(a.samples[0]).toMatchObject({
      book_identity: expect.stringContaining("LANE_B_BOOK_ID_V1"),
      external_book_id: expect.stringMatching(/^\["number","\d+"\]$/u),
      external_book_id_raw_json: expect.stringMatching(/^\d+$/u),
      title: expect.stringMatching(/^Title \d+$/u),
      title_raw_json: expect.stringMatching(/^"Title \d+"$/u),
      description: expect.any(String),
      description_raw_json: expect.any(String),
      cooccurring_exact_tokens: ["A", "B"],
    });
    expect(a.samples.every(({ description, description_raw_json }: { description: unknown; description_raw_json: unknown }) => (
      typeof description === "string" && typeof description_raw_json === "string"
    ))).toBe(true);
    expect(a.cooccurrence).toEqual(expect.arrayContaining([
      expect.objectContaining({ exact_raw_token: "B", count: 100, jaccard: 100 / 105, conditional_probability: 100 / 105 }),
    ]));
    expect(a.proposals).toEqual([]);
    expect(a.offline_review_instructions.proposal_template.evidence).toEqual({
      only_lexical: false,
      only_translation: false,
      polysemous: false,
      sample_conflict: false,
    });
    expect(a.group_identity).toMatch(/^[a-f0-9]{64}$/u);
    expect(a.source_evidence_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(a).not.toHaveProperty("unmapped_reason");
    expect(loaded.finalSampleBookIds).toHaveLength(books.length);

    const outputPath = join(rawRunDir, "b2-source-groups.jsonl");
    await expect(writeB2SourceGroupTemplateFromRawRun({
      rawRunDir,
      channelAppId: "channel-app-1",
      outputPath,
    })).resolves.toBe(3);
    const written = (await readFile(outputPath, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(written).toEqual(loaded.records);
  });

  it("treats an existing empty final-selection file as an authoritative empty final sample", async () => {
    const books: any[] = [];
    const rawRunDir = await createVerifiedB2RawRun({ books, selection: [] });

    const loaded = await loadB2SourceGroupTemplateFromRawRun({ rawRunDir, channelAppId: "channel-app-1" });
    expect(loaded.analysis.summary).toMatchObject({ actualUniqueBooks: 0, candidateUniqueBooks: 0, totalSourceTokens: 0 });
    expect(loaded.records).toEqual([]);
  });
});
