import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  analyzeB1RawRecords,
  buildCooccurrence,
  tokenKey,
} from "../../../scripts/p2-06-5-lane-b/b1-analysis.mjs";
import {
  buildB1ArtifactsFromRaw,
  analyzeLaneBRun,
  loadAndAnalyzeLaneBRun,
  renderB1Report,
  verifyB1ArtifactBundle,
  writeB1ArtifactBundle,
} from "../../../scripts/p2-06-5-lane-b/artifacts.mjs";
import {
  buildLaneBPreflight,
  createLaneBRunStore,
} from "../../../scripts/p2-06-5-lane-b/run-store.mjs";
import { selectFinalBooks } from "../../../scripts/p2-06-5-lane-b/sampler.mjs";
import { parseLaneBPage } from "../../../scripts/p2-06-5-lane-b/upstream-parser.mjs";

function book(overrides: Record<string, unknown> = {}) {
  return {
    sourceScope: "changdu/app-1",
    language: 2,
    languageName: "English",
    externalBookIdRaw: "book-1",
    titleRaw: "Book One",
    descriptionRaw: "First description",
    seriesTypeListRaw: ["Mother", "mother", " Mother"],
    pageIndex: 1,
    rowIndex: 0,
    fetchedAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

async function authoritativeRawRun({
  runId,
  books,
  status = "PARTIAL",
  timingViolation = false,
}: {
  runId: string;
  books: Array<Record<string, unknown>>;
  status?: string;
  timingViolation?: boolean;
}) {
  const artifactRoot = await mkdtemp(join(tmpdir(), "lane-b-authoritative-"));
  const preflight = buildLaneBPreflight({
    runId,
    channelAppId: "channel-app-1",
    artifactRoot,
    now: new Date("2026-08-13T00:00:00.000Z"),
  });
  const store = await createLaneBRunStore({
    artifactRoot,
    runId,
    channelAppId: "channel-app-1",
    preflight,
  });
  const fetchedAt = "2026-08-13T00:00:00.000Z";
  const rawRows = books.map((item) => {
    const row: Record<string, unknown> = {
      id: item.externalBookIdRaw,
      seriesName: item.titleRaw,
      language: item.languageJsonValue ?? item.language,
      seriesTypeList: item.seriesTypeListRaw,
    };
    if (Object.hasOwn(item, "descriptionRaw")) row.description = item.descriptionRaw;
    if (Object.hasOwn(item, "sourceLanguageNameRaw")) row.languageName = item.sourceLanguageNameRaw;
    else if (Object.hasOwn(item, "languageName")) row.languageName = item.languageName;
    return row;
  });
  const payload = { data: { totalCount: rawRows.length, list: rawRows } };
  const rawText = JSON.stringify(payload);
  const rawPageArtifacts = [await store.writeRawPage({ pageIndex: 1, attempt: 1, rawText })];
  if (timingViolation) {
    rawPageArtifacts.push(await store.writeRawPage({
      pageIndex: 2,
      attempt: 1,
      rawText: JSON.stringify({ data: { totalCount: rawRows.length, list: [] } }),
    }));
  }
  const parsed = parseLaneBPage({ payload, pageIndex: 1, fetchedAt, channelAppId: "channel-app-1" });
  const parsedBooks = parsed.books.map((item, index) => ({ ...item, acquisitionIndex: index + 1 }));
  await store.appendJsonl(store.paths.bookSamples, parsedBooks);
  await store.appendJsonl(store.paths.tokenObservations, parsed.observations);
  await store.appendJsonl(store.paths.structureAnomalies, parsed.anomalies);
  const audits = [{
    schemaVersion: 1,
    pageIndex: 1,
    attemptNumber: 1,
    isRetry: false,
    selection: { wave: 0, reason: "TEST_FIXTURE" },
    requestedAt: fetchedAt,
    requestStartedAt: fetchedAt,
    responseReceivedAt: fetchedAt,
    status: 200,
    ok: true,
    errorCode: null,
    retryable: false,
    durationMs: 0,
  }];
  if (timingViolation) {
    audits.push({
      ...audits[0],
      pageIndex: 2,
      requestedAt: "2026-08-13T00:00:00.999Z",
      requestStartedAt: "2026-08-13T00:00:00.999Z",
      responseReceivedAt: "2026-08-13T00:00:00.999Z",
    });
  }
  await store.appendJsonl(store.paths.requestAudit, audits);
  const deterministic = selectFinalBooks(parsedBooks, parsed.observations).selectionAudit.map((entry) => ({
    sampleBookKey: entry.bookIdentity,
    selectedSampleIndex: entry.selectedSampleIndex,
    selectionReason: entry.selectionReason,
  }));
  const finalSelection = deterministic;
  await store.finalizeRun({
    manifest: {
      schema_version: 1,
      run_id: runId,
      channel_app_id: "channel-app-1",
      status,
      raw_page_artifacts: rawPageArtifacts,
      actual_http_attempts: timingViolation ? 2 : 1,
      actual_unique_pages: timingViolation ? 2 : 1,
      retry_attempts: 0,
      successful_pages: timingViolation ? 2 : 1,
      stop_reason: null,
      duplicate_book_observations: 0,
      total_count_refreshed: rawRows.length,
      total_pages_refreshed: Math.max(1, Math.ceil(rawRows.length / 100)),
      planned_unique_pages: 240,
      retry_budget: 10,
      http_attempt_cap: 250,
      request_budget_qa_passed: true,
      language_quota_satisfied_or_exhausted: true,
      final_sample_books: finalSelection.length,
      candidate_unique_books: parsedBooks.length,
    },
    selectionRecords: finalSelection,
  });
  return store;
}

describe("P2-06.5 Lane B B1 exact-token analysis", () => {
  it("keeps first/last seen page and timestamp from the same acquisition facts", () => {
    const analysis = analyzeB1RawRecords({
      books: [
        book({ externalBookIdRaw: "first", pageIndex: 900, fetchedAt: "2026-08-13T00:00:00.000Z", seriesTypeListRaw: ["A"] }),
        book({ externalBookIdRaw: "last", pageIndex: 2, fetchedAt: "2026-08-13T01:00:00.000Z", seriesTypeListRaw: ["A"] }),
      ],
    });
    expect(analysis.inventory[0]).toMatchObject({
      firstSeenAt: "2026-08-13T00:00:00.000Z",
      firstSeenPage: 900,
      lastSeenAt: "2026-08-13T01:00:00.000Z",
      lastSeenPage: 2,
    });
  });

  it("keeps whitespace, case and Unicode byte identity separate and transport-verifiable", () => {
    const nfc = "é";
    const nfd = "e\u0301";
    const analysis = analyzeB1RawRecords({
      books: [book({ seriesTypeListRaw: ["Mother", "mother", " Mother", nfc, nfd, ""] })],
    });

    expect(analysis.inventory).toHaveLength(6);
    expect(new Set(analysis.inventory.map(({ exactRawToken }) => exactRawToken))).toEqual(
      new Set(["Mother", "mother", " Mother", nfc, nfd, ""]),
    );
    for (const token of analysis.inventory) {
      expect(Buffer.from(token.rawTokenUtf8Base64, "base64").toString("utf8")).toBe(token.exactRawToken);
      expect(token.rawTokenSha256).toBe(createHash("sha256").update(token.exactRawToken, "utf8").digest("hex"));
    }
    expect(analysis.inventory.find(({ exactRawToken }) => exactRawToken === "")?.rawTokenUtf8Base64).toBe("");
    expect(analysis.summary.taxonomyCoverageStatus).toBe("NOT_ESTIMABLE_NO_DENOMINATOR");
  });

  it("extracts only unambiguous object tokens and preserves unsupported raw structure as anomalies", () => {
    const analysis = analyzeB1RawRecords({
      books: [book({
        seriesTypeListRaw: [
          { value: "fantasy" },
          { value: "A", name: "B" },
          7,
          { label: "romance", extra: true },
        ],
      })],
    });

    expect(analysis.inventory.map(({ exactRawToken }) => exactRawToken).sort()).toEqual(["fantasy", "romance"]);
    expect(analysis.anomalies).toEqual(expect.arrayContaining([
      expect.objectContaining({ listIndex: 1, structureStatus: "AMBIGUOUS_OBJECT" }),
      expect.objectContaining({ listIndex: 2, structureStatus: "UNSUPPORTED_TYPE" }),
    ]));
  });

  it("keeps language JSON type, value and raw languageName in the mapping scope and never invents site locale", () => {
    const analysis = analyzeB1RawRecords({
      books: [
        book({ externalBookIdRaw: "number", language: 2, languageName: "English", seriesTypeListRaw: ["A"] }),
        book({ externalBookIdRaw: "string", language: "2", languageName: "English", seriesTypeListRaw: ["A"] }),
        book({ externalBookIdRaw: "name", language: 2, languageName: " English", seriesTypeListRaw: ["A"] }),
      ],
    });
    expect(analysis.inventory).toHaveLength(3);
    expect(new Set(analysis.inventory.map(({ rawLanguageScope }) => rawLanguageScope)).size).toBe(3);
    expect(analysis.inventory).toEqual(expect.arrayContaining([
      expect.objectContaining({ languageJsonType: "number", languageJsonValueJson: "2", languageNameRaw: "English", siteLocale: null }),
      expect.objectContaining({ languageJsonType: "string", languageJsonValueJson: '"2"', languageNameRaw: "English", siteLocale: null }),
      expect.objectContaining({ languageJsonType: "number", languageNameRaw: " English", siteLocale: null }),
    ]));
  });

  it("distinguishes a missing languageName from explicit null in exact raw language scope", () => {
    const missing = book({ externalBookIdRaw: "missing", language: 2, seriesTypeListRaw: ["A"] });
    delete (missing as Record<string, unknown>).languageName;
    const analysis = analyzeB1RawRecords({
      books: [missing, book({ externalBookIdRaw: "null", language: 2, languageName: null, seriesTypeListRaw: ["A"] })],
    });
    expect(analysis.inventory).toHaveLength(2);
    expect(new Set(analysis.inventory.map(({ rawLanguageScope }) => rawLanguageScope)).size).toBe(2);
    expect(new Set(analysis.inventory.map(({ languageNameState }) => languageNameState))).toEqual(new Set(["missing", "null"]));
  });

  it("deduplicates same-book occurrences for frequency and co-occurrence but retains occurrence count", () => {
    const analysis = analyzeB1RawRecords({
      books: [
        book({ externalBookIdRaw: "book-1", seriesTypeListRaw: ["A", "A", "B"] }),
        book({ externalBookIdRaw: "book-2", rowIndex: 1, seriesTypeListRaw: ["A", "C"] }),
        book({ externalBookIdRaw: "book-3", rowIndex: 2, seriesTypeListRaw: ["B"] }),
      ],
    });
    const a = analysis.inventory.find(({ exactRawToken }) => exactRawToken === "A");
    expect(a).toMatchObject({ bookFrequency: 2, occurrenceCount: 3 });

    const aKey = tokenKey(analysis.observations.find((observation: { exactRawToken: string }) => observation.exactRawToken === "A")!);
    const bKey = tokenKey(analysis.observations.find((observation: { exactRawToken: string }) => observation.exactRawToken === "B")!);
    const pair = buildCooccurrence(analysis.observations).find(
      ({ tokenKeyA, tokenKeyB }) => new Set([tokenKeyA, tokenKeyB]).has(aKey) && new Set([tokenKeyA, tokenKeyB]).has(bKey),
    );
    expect(pair).toMatchObject({ nA: 2, nB: 2, nAB: 1 });
    expect(pair?.jaccard).toBeCloseTo(1 / 3);
    expect(pair?.pBGivenA).toBeCloseTo(1 / 2);
    expect(pair?.pAGivenB).toBeCloseTo(1 / 2);
  });

  it("deduplicates repeated sampled book identities and emits monotonic discovery checkpoints", () => {
    const books = Array.from({ length: 2_100 }, (_, index) => book({
      externalBookIdRaw: `book-${index}`,
      pageIndex: Math.floor(index / 100) + 1,
      rowIndex: index % 100,
      seriesTypeListRaw: [index < 1_000 ? "A" : index < 2_000 ? "B" : "C"],
    }));
    books.push({ ...books[0], titleRaw: "Duplicate observation" });
    const analysis = analyzeB1RawRecords({ books });

    expect(analysis.summary.actualUniqueBooks).toBe(2_100);
    expect(analysis.discoveryCurves.filter(({ checkpointScope, discoveryStage }) => (
      checkpointScope === "global" && discoveryStage === "final_sample"
    ))).toEqual([
      expect.objectContaining({ checkpointSampleCount: 1_000, blockSampleCount: 1_000, cumulativeDistinctMappingKeys: 1 }),
      expect.objectContaining({ checkpointSampleCount: 2_000, blockSampleCount: 1_000, cumulativeDistinctMappingKeys: 2 }),
      expect.objectContaining({ checkpointSampleCount: 2_100, blockSampleCount: 100, cumulativeDistinctMappingKeys: 3 }),
    ]);
    expect(analysis.summary.discoveryStatus).toBe("TAXONOMY_DISCOVERY_NOT_SATURATED");
  });

  it("emits candidate, final and per-language curves and keeps saturation fail-closed on missing QA", () => {
    const books = Array.from({ length: 1_200 }, (_, index) => book({
      externalBookIdRaw: `candidate-${index}`,
      acquisitionIndex: index + 1,
      selectedSampleIndex: index < 1_000 ? index + 1 : null,
      language: index < 600 ? 2 : 3,
      languageName: index < 600 ? "English" : "Français",
      seriesTypeListRaw: [index < 100 ? "A" : "B"],
    }));
    const analysis = analyzeB1RawRecords({ books }, {
      targetUniqueBooks: 1_000,
      languageQuotaSatisfiedOrExhausted: false,
      rawRoundTripQaPassed: true,
      requestBudgetQaPassed: true,
    });
    expect(analysis.discoveryCurves).toEqual(expect.arrayContaining([
      expect.objectContaining({ discoveryStage: "candidate_acquisition", checkpointScope: "global", checkpointSampleCount: 1_000 }),
      expect.objectContaining({ discoveryStage: "final_sample", checkpointScope: "global", checkpointSampleCount: 1_000 }),
      expect.objectContaining({ discoveryStage: "final_sample", checkpointScope: "raw_language_scope", checkpointSampleCount: 500 }),
    ]));
    expect(analysis.summary.empiricalTokenCoverage).toBe(1);
    expect(analysis.summary.discoveryStatus).toBe("TAXONOMY_DISCOVERY_NOT_SATURATED");
  });
});

describe("P2-06.5 Lane B B1 artifacts", () => {
  it("builds CSV/JSONL/report artifacts with hashes and a fixed conservative status block", async () => {
    const bundle = buildB1ArtifactsFromRaw({
      books: [
        book({ externalBookIdRaw: "book-1", seriesTypeListRaw: [" Mother", "romance"] }),
        book({ externalBookIdRaw: "book-2", language: 3, languageName: "Français", seriesTypeListRaw: ["romance"] }),
      ],
    }, {
      runId: "run-test",
      generatedAt: "2026-08-13T12:00:00.000Z",
      sourceScope: "changdu/app-1",
      actualRequests: 2,
      requestBudget: 100,
    });

    const inventoryCsv = bundle.contents.get("source-taxonomy-inventory.csv")!;
    expect(inventoryCsv).toContain("language_json_type,language_json_value_json,language_name_raw,language_name_state,raw_language_scope,site_locale");
    expect(inventoryCsv).toContain("exact_raw_token,raw_token_utf8_base64,raw_token_sha256");
    expect(inventoryCsv).toContain(" Mother,");
    expect(bundle.contents.get("source-token-cooccurrence.csv")).toContain("raw_token_utf8_base64_a,raw_token_sha256_a");
    expect(bundle.manifest.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "source-taxonomy-inventory.csv", rowCount: 3, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ path: "LANE_B_REPORT.md", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    ]));
    expect(bundle.contents.has("source-token-observations.jsonl")).toBe(false);
    expect(bundle.contents.has("source-token-structure-anomalies.jsonl")).toBe(false);
    expect(bundle.contents.has("lane-b-summary.json")).toBe(false);
    expect(bundle.contents.get("lane-b-run-manifest.json")).toContain('"canonicalTagVersion": null');
    expect(bundle.manifest.artifacts.some(({ path }) => path === "lane-b-run-manifest.json")).toBe(false);

    const report = renderB1Report(bundle.analysis, { runId: "run-test", generatedAt: "now" });
    expect(report).toContain("```mermaid\nxychart-beta");
    expect(report.match(/^\s*line \[/gmu)).toHaveLength(1);
    expect(report).toContain("raw-language scope SHA-256");
    expect(report).not.toContain('x-axis ["[\\"RAW_LANGUAGE_SCOPE_V1');
    expect(report).toContain("TAXONOMY_COVERAGE_RATE=NOT_ESTIMABLE_NO_DENOMINATOR");
    expect(report).toContain("LANE_B_MAPPING_STATUS=WAITING_FOR_CANONICAL_TAG_V1");
    expect(report.trimEnd()).toMatch(/```$/);

    const outputParent = await mkdtemp(join(tmpdir(), "lane-b-artifacts-"));
    const outputDirectory = join(outputParent, "bundle");
    await writeB1ArtifactBundle(outputDirectory, bundle);
    expect(await verifyB1ArtifactBundle(outputDirectory)).toMatchObject({ ok: true, failures: [] });
    const manifest = JSON.parse(await readFile(join(outputDirectory, "lane-b-run-manifest.json"), "utf8"));
    expect(manifest.actualUniqueBooks).toBe(2);
    expect(manifest.taxonomyCoverageStatus).toBe("NOT_ESTIMABLE_NO_DENOMINATOR");
  });

  it("derives the inventory from final sample books while retaining candidate discovery coverage", () => {
    const bundle = buildB1ArtifactsFromRaw({
      books: [
        book({ externalBookIdRaw: "selected", acquisitionIndex: 1, selectedSampleIndex: 1, seriesTypeListRaw: ["A"] }),
        book({ externalBookIdRaw: "candidate-only", acquisitionIndex: 2, selectedSampleIndex: null, seriesTypeListRaw: ["B"] }),
      ],
    });
    expect(bundle.analysis.inventory.map((item: { exactRawToken: string }) => item.exactRawToken)).toEqual(["A"]);
    expect(bundle.analysis.summary).toMatchObject({
      actualUniqueBooks: 1,
      candidateUniqueBooks: 2,
      totalSourceTokens: 1,
      empiricalTokenCoverage: 0.5,
    });
  });

  it("analyzes a partial authoritative raw run via the CLI-facing entrypoint", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "lane-b-output-parent-"));
    const derivedDir = join(outputDir, "derived");
    const rawBook = book({
      sampleBookKey: "partial-book-key",
      externalBookIdRaw: "partial-book",
      seriesTypeListRaw: [" exact "],
    });
    delete (rawBook as Record<string, unknown>).sourceScope;
    const store = await authoritativeRawRun({ runId: "partial-run", books: [rawBook] });
    await writeFile(store.paths.structureAnomalies, `${JSON.stringify({
      sampleBookKey: "external-anomaly-book",
      sourceScope: "channel-app-1",
      rawLanguageScope: "external-language-scope",
      reason: "AMBIGUOUS_STRING_CANDIDATES",
      structureStatus: "AMBIGUOUS_OBJECT",
      rawItemJson: { value: "one", name: "two" },
    })}\n`, { encoding: "utf8", flag: "a" });
    await expect(analyzeLaneBRun({
      rawRunDir: store.paths.runDir,
      outputDir: derivedDir,
      channelAppId: "channel-app-1",
    })).rejects.toThrow(/raw run verification failed/u);

    const validStore = await authoritativeRawRun({
      runId: "partial-valid",
      books: [rawBook],
      status: "PARTIAL",
    });

    const summary = await analyzeLaneBRun({
      rawRunDir: validStore.paths.runDir,
      outputDir: derivedDir,
      channelAppId: "channel-app-1",
      generatedAt: "2026-08-13T12:00:00.000Z",
    });
    expect(summary).toMatchObject({ actualUniqueBooks: 1, laneBSampleStatus: "PARTIAL" });
    expect(await readFile(join(derivedDir, "LANE_B_REPORT.md"), "utf8")).toContain("LANE_B_SAMPLE_STATUS=PARTIAL");
    expect(await verifyB1ArtifactBundle(derivedDir)).toMatchObject({ ok: true });
    const manifest = JSON.parse(await readFile(join(derivedDir, "lane-b-run-manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      requestBudget: { plannedUniquePages: 240, retryBudget: 10, httpAttemptCap: 250 },
      plannedRequests: 240,
      actualRequests: 1,
      pageSize: 100,
      languageQuotaSatisfiedOrExhausted: true,
      rawRoundTripQaPassed: true,
      requestBudgetQaPassed: true,
      structureAnomalyCount: 0,
      rawManifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(manifest.rawSourceFiles).toContain("source-token-structure-anomalies.jsonl");
  });

  it("applies the deterministically replayable final-selection sidecar when raw candidate rows are not annotated", async () => {
    const outputParent = await mkdtemp(join(tmpdir(), "lane-b-output-selection-"));
    const books = [
      book({ sampleBookKey: "key-a", externalBookIdRaw: "a", acquisitionIndex: 1, seriesTypeListRaw: ["A"] }),
      book({ sampleBookKey: "key-b", externalBookIdRaw: "b", acquisitionIndex: 2, seriesTypeListRaw: ["B"] }),
    ];
    const store = await authoritativeRawRun({
      runId: "selection-sidecar",
      books,
    });
    const summary = await analyzeLaneBRun({
      rawRunDir: store.paths.runDir,
      outputDir: join(outputParent, "derived"),
      channelAppId: "channel-app-1",
      generatedAt: "2026-08-13T12:00:00.000Z",
    });
    expect(summary).toMatchObject({ actualUniqueBooks: 2, candidateUniqueBooks: 2, totalSourceTokens: 2, empiricalTokenCoverage: 1 });
    expect(await readFile(join(outputParent, "derived", "source-taxonomy-inventory.csv"), "utf8")).toContain(",B,");
  });

  it("binds B1 source scope to the verified raw-run channel_app_id", async () => {
    const outputParent = await mkdtemp(join(tmpdir(), "lane-b-output-scope-"));
    const store = await authoritativeRawRun({
      runId: "scope-binding",
      books: [book({ externalBookIdRaw: "scope-book", seriesTypeListRaw: ["A"] })],
    });
    await expect(analyzeLaneBRun({
      rawRunDir: store.paths.runDir,
      outputDir: join(outputParent, "wrong-channel"),
      channelAppId: "different-channel-app",
    })).rejects.toThrow(/does not match the verified raw-run manifest/u);
    await expect(analyzeLaneBRun({
      rawRunDir: store.paths.runDir,
      outputDir: join(outputParent, "wrong-scope"),
      channelAppId: "channel-app-1",
      sourceScope: "different-source-scope",
    })).rejects.toThrow(/sourceScope must equal.*channel_app_id/u);
  });

  it("derives a clearly marked PARTIAL B1 bundle when only the frozen start interval QA failed", async () => {
    const books = Array.from({ length: 101 }, (_, index) => book({
      externalBookIdRaw: `timing-${index + 1}`,
      titleRaw: `Timing ${index + 1}`,
      seriesTypeListRaw: [index === 0 ? "rare" : "common"],
    }));
    const store = await authoritativeRawRun({
      runId: "operational-partial",
      books,
      timingViolation: true,
    });
    await expect(loadAndAnalyzeLaneBRun({
      rawRunDir: store.paths.runDir,
      channelAppId: "channel-app-1",
    })).rejects.toThrow(/raw run verification failed/u);

    const outputParent = await mkdtemp(join(tmpdir(), "lane-b-operational-partial-"));
    const outputDir = join(outputParent, "derived");
    const result = await analyzeLaneBRun({
      rawRunDir: store.paths.runDir,
      outputDir,
      channelAppId: "channel-app-1",
    });
    expect(result).toMatchObject({
      actualUniqueBooks: 101,
      requestBudgetQaPassed: false,
      laneBSampleStatus: "PARTIAL",
      discoveryStatus: "TAXONOMY_DISCOVERY_NOT_SATURATED",
    });
    const manifest = JSON.parse(await readFile(join(outputDir, "lane-b-run-manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      rawVerificationStatus: "PARTIAL_OPERATIONAL_QA_FAILED",
      rawVerificationFailures: ["request-attempts.jsonl:start_interval"],
    });
    expect(await verifyB1ArtifactBundle(outputDir)).toMatchObject({ ok: true });
  });

  it("rejects a self-hashed manifest whose summary facts disagree with the bundle", async () => {
    const bundle = buildB1ArtifactsFromRaw({
      books: [book({ sourceScope: "app", externalBookIdRaw: "semantic", seriesTypeListRaw: ["A"] })],
    }, { runId: "semantic-tamper", sourceScope: "app" });
    const parent = await mkdtemp(join(tmpdir(), "lane-b-semantic-tamper-"));
    const outputDirectory = join(parent, "bundle");
    await writeB1ArtifactBundle(outputDirectory, bundle);
    const manifestPath = join(outputDirectory, "lane-b-run-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    Object.assign(manifest, {
      sourceScope: "attacker-scope",
      actualUniqueBooks: 999,
      targetUniqueBooks: 0,
      totalSourceTokens: 999,
      empiricalTokenCoverage: 0.123,
      taxonomyCoverageRate: 1,
      taxonomyCoverageStatus: "ESTIMATED",
      discoveryStatus: "TAXONOMY_DISCOVERY_SATURATED",
      laneBSampleStatus: "COMPLETE",
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const expectedManifestSha256 = createHash("sha256").update(await readFile(manifestPath)).digest("hex");
    const verified = await verifyB1ArtifactBundle(outputDirectory, { expectedManifestSha256 });
    expect(verified.ok).toBe(false);
    expect(verified.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "MANIFEST_SEMANTIC_MISMATCH", details: { field: "sourceScope" } }),
      expect.objectContaining({ code: "MANIFEST_SEMANTIC_MISMATCH", details: { field: "actualUniqueBooks" } }),
      expect.objectContaining({ code: "MANIFEST_SEMANTIC_MISMATCH", details: { field: "targetUniqueBooks" } }),
      expect.objectContaining({ code: "MANIFEST_SEMANTIC_MISMATCH", details: { field: "totalSourceTokens" } }),
      expect.objectContaining({ code: "MANIFEST_SEMANTIC_MISMATCH", details: { field: "empiricalTokenCoverage" } }),
      expect.objectContaining({ code: "MANIFEST_SEMANTIC_MISMATCH", details: { field: "taxonomyCoverageStatus" } }),
      expect.objectContaining({ code: "MANIFEST_SEMANTIC_MISMATCH", details: { field: "laneBSampleStatus" } }),
      expect.objectContaining({ code: "MANIFEST_SEMANTIC_MISMATCH", details: { field: "discoveryStatus" } }),
    ]));
  });
});
