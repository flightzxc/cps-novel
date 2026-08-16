import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildLaneBPreflight,
  createLaneBRunStore,
  verifyRawRunManifest,
} from "../../../scripts/p2-06-5-lane-b/run-store.mjs";
import { scanLaneBArtifactsForSecrets } from "../../../scripts/p2-06-5-lane-b/secret-scan.mjs";
import { parseLaneBPage } from "../../../scripts/p2-06-5-lane-b/upstream-parser.mjs";

const rawBookPage = JSON.stringify({
  data: {
    totalCount: 1,
    list: [{
      id: "book-1",
      seriesName: "Book 1",
      description: "Description 1",
      language: 1,
      languageName: "Language 1",
      seriesTypeList: ["exact-token"],
    }],
  },
});

const fetchedAt = "2026-08-13T00:00:01.000Z";

function successfulAudit() {
  return {
    schemaVersion: 1,
    pageIndex: 1,
    attemptNumber: 1,
    isRetry: false,
    selection: { wave: 0, reason: "TEST" },
    requestedAt: fetchedAt,
    requestStartedAt: fetchedAt,
    responseReceivedAt: "2026-08-13T00:00:01.001Z",
    status: 200,
    ok: true,
    errorCode: null,
    retryable: false,
    durationMs: 1,
  };
}

describe("P2-06.5 Lane B append-only raw store", () => {
  it("refuses a pre-existing run directory or run-id symlink before writing facts", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "lane-b-store-preplanted-"));
    const outside = await mkdtemp(join(tmpdir(), "lane-b-store-outside-"));
    const preflight = buildLaneBPreflight({ runId: "run-link", channelAppId: "app", artifactRoot });
    await symlink(outside, join(artifactRoot, "run-link"));
    await expect(createLaneBRunStore({ artifactRoot, runId: "run-link", channelAppId: "app", preflight }))
      .rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(outside, "preflight.json"), "utf8").catch((error) => error.code)).toBe("ENOENT");

    await mkdir(join(artifactRoot, "run-existing"));
    const existingPreflight = buildLaneBPreflight({ runId: "run-existing", channelAppId: "app", artifactRoot });
    await expect(createLaneBRunStore({ artifactRoot, runId: "run-existing", channelAppId: "app", preflight: existingPreflight }))
      .rejects.toMatchObject({ code: "EEXIST" });
  });

  it("freezes the approved 240+10=250 preflight budget and create-only page artifacts", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "lane-b-store-"));
    const preflight = buildLaneBPreflight({
      runId: "run-1",
      channelAppId: "channel-app-1",
      artifactRoot,
      now: new Date("2026-08-13T00:00:00.000Z"),
    });
    expect(preflight).toMatchObject({
      historical_catalog_rows: 95_479,
      historical_total_pages: 955,
      planned_unique_pages: 240,
      retry_budget: 10,
      http_attempt_cap: 250,
      maximum_candidate_rows: 24_000,
      target_unique_books: 10_000,
      source_language_upper_bound: 18,
    });

    const store = await createLaneBRunStore({
      artifactRoot,
      runId: "run-1",
      channelAppId: "channel-app-1",
      preflight,
    });
    const page = await store.writeRawPage({ pageIndex: 1, attempt: 1, rawText: rawBookPage });
    await expect(store.writeRawPage({ pageIndex: 1, attempt: 1, rawText: "{}" })).rejects.toMatchObject({ code: "EEXIST" });
    const parsed = parseLaneBPage({
      payload: JSON.parse(rawBookPage),
      pageIndex: 1,
      fetchedAt,
      channelAppId: "channel-app-1",
    });
    await store.appendJsonl(store.paths.requestAudit, [successfulAudit()]);
    await store.appendJsonl(store.paths.bookSamples, [{ ...parsed.books[0], acquisitionIndex: 1 }]);
    await store.appendJsonl(store.paths.tokenObservations, parsed.observations);
    await store.finalizeRun({ manifest: {
      schema_version: 1,
      run_id: "run-1",
      channel_app_id: "channel-app-1",
      status: "PARTIAL",
      planned_unique_pages: 240,
      retry_budget: 10,
      http_attempt_cap: 250,
      actual_http_attempts: 1,
      actual_unique_pages: 1,
      successful_pages: 1,
      retry_attempts: 0,
      stop_reason: null,
      candidate_unique_books: 1,
      final_sample_books: 1,
      target_unique_books: 10_000,
      duplicate_book_observations: 0,
      total_count_refreshed: 1,
      total_pages_refreshed: 1,
      language_quota_satisfied_or_exhausted: false,
      raw_round_trip_qa_passed: false,
      request_budget_qa_passed: true,
      raw_page_artifacts: [page],
    }, selectionRecords: [{
      sampleBookKey: parsed.books[0].sampleBookKey,
      selectedSampleIndex: 1,
      selectionReason: "TOKEN_DEFICIT_COVERAGE",
    }] });
    expect(await verifyRawRunManifest(store.paths.runDir)).toMatchObject({ ok: true, failures: [] });
    expect(JSON.parse((await readFile(store.paths.bookSamples, "utf8")).trim())).toMatchObject({
      titleRaw: "Book 1",
      acquisitionIndex: 1,
    });
  });

  it("fails semantic round-trip when a successful raw page has a book but derived facts are empty", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "lane-b-store-empty-derived-"));
    const preflight = buildLaneBPreflight({ runId: "empty-derived", channelAppId: "app", artifactRoot });
    const store = await createLaneBRunStore({ artifactRoot, runId: "empty-derived", channelAppId: "app", preflight });
    const page = await store.writeRawPage({ pageIndex: 1, attempt: 1, rawText: rawBookPage });
    await store.appendJsonl(store.paths.requestAudit, [successfulAudit()]);
    const manifest = {
      schema_version: 1,
      run_id: "empty-derived",
      channel_app_id: "app",
      status: "PARTIAL",
      planned_unique_pages: 240,
      retry_budget: 10,
      http_attempt_cap: 250,
      actual_http_attempts: 1,
      actual_unique_pages: 1,
      successful_pages: 1,
      retry_attempts: 0,
      candidate_unique_books: 0,
      final_sample_books: 0,
      stop_reason: null,
      raw_page_artifacts: [page],
      request_budget_qa_passed: true,
      raw_round_trip_qa_passed: false,
    };
    await store.finalizeRun({ manifest, selectionRecords: [] });
    expect(await verifyRawRunManifest(store.paths.runDir)).toMatchObject({
      ok: false,
      failures: expect.arrayContaining(["semantic_round_trip:source-book-samples.jsonl"]),
    });
    expect(manifest.raw_round_trip_qa_passed).toBe(false);
  });

  it("fails semantic round-trip for a self-consistently hashed but altered derived book", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "lane-b-store-altered-derived-"));
    const preflight = buildLaneBPreflight({ runId: "altered-derived", channelAppId: "app", artifactRoot });
    const store = await createLaneBRunStore({ artifactRoot, runId: "altered-derived", channelAppId: "app", preflight });
    const page = await store.writeRawPage({ pageIndex: 1, attempt: 1, rawText: rawBookPage });
    await store.appendJsonl(store.paths.requestAudit, [successfulAudit()]);
    const parsed = parseLaneBPage({ payload: JSON.parse(rawBookPage), pageIndex: 1, fetchedAt, channelAppId: "app" });
    await store.appendJsonl(store.paths.bookSamples, [{ ...parsed.books[0], titleRaw: "ALTERED", acquisitionIndex: 1 }]);
    await store.appendJsonl(store.paths.tokenObservations, parsed.observations);
    const manifest = {
      schema_version: 1,
      run_id: "altered-derived",
      channel_app_id: "app",
      status: "PARTIAL",
      planned_unique_pages: 240,
      retry_budget: 10,
      http_attempt_cap: 250,
      actual_http_attempts: 1,
      actual_unique_pages: 1,
      successful_pages: 1,
      retry_attempts: 0,
      stop_reason: null,
      candidate_unique_books: 1,
      final_sample_books: 0,
      raw_page_artifacts: [page],
      request_budget_qa_passed: true,
      raw_round_trip_qa_passed: false,
    };
    await store.finalizeRun({ manifest, selectionRecords: [] });
    expect(await verifyRawRunManifest(store.paths.runDir)).toMatchObject({
      ok: false,
      failures: expect.arrayContaining(["semantic_round_trip:source-book-samples.jsonl"]),
    });
  });

  it("persists PARTIAL when request starts violate the one-second interval", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "lane-b-store-fast-starts-"));
    const preflight = buildLaneBPreflight({ runId: "fast-starts", channelAppId: "app", artifactRoot });
    const store = await createLaneBRunStore({ artifactRoot, runId: "fast-starts", channelAppId: "app", preflight });
    const rawEmptyPage = JSON.stringify({ data: { totalCount: 100, list: [] } });
    const page1 = await store.writeRawPage({ pageIndex: 1, attempt: 1, rawText: rawEmptyPage });
    const page2 = await store.writeRawPage({ pageIndex: 2, attempt: 1, rawText: rawEmptyPage });
    const audits = [
      { ...successfulAudit(), pageIndex: 1 },
      {
        ...successfulAudit(),
        pageIndex: 2,
        requestedAt: "2026-08-13T00:00:01.500Z",
        requestStartedAt: "2026-08-13T00:00:01.500Z",
        responseReceivedAt: "2026-08-13T00:00:01.501Z",
      },
    ];
    await store.appendJsonl(store.paths.requestAudit, audits);
    const manifest = {
      schema_version: 1,
      run_id: "fast-starts",
      channel_app_id: "app",
      status: "COMPLETE",
      planned_unique_pages: 240,
      retry_budget: 10,
      http_attempt_cap: 250,
      actual_http_attempts: 2,
      actual_unique_pages: 2,
      successful_pages: 2,
      retry_attempts: 0,
      candidate_unique_books: 0,
      final_sample_books: 0,
      duplicate_book_observations: 0,
      stop_reason: null,
      total_count_refreshed: 100,
      total_pages_refreshed: 1,
      language_quota_satisfied_or_exhausted: false,
      raw_page_artifacts: [page1, page2],
      request_budget_qa_passed: true,
      raw_round_trip_qa_passed: false,
    };
    await store.finalizeRun({ manifest, selectionRecords: [] });
    const persisted = JSON.parse(await readFile(store.paths.rawManifest, "utf8"));
    expect(persisted).toMatchObject({
      status: "PARTIAL",
      raw_round_trip_qa_passed: true,
      request_budget_qa_passed: false,
    });
    expect(manifest).toMatchObject({ status: "PARTIAL", request_budget_qa_passed: false });
    expect(await verifyRawRunManifest(store.paths.runDir)).toMatchObject({
      ok: false,
      failures: expect.arrayContaining(["request-attempts.jsonl:start_interval"]),
    });
  });

  it("finds exact forbidden values and common persisted JWT patterns without echoing values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lane-b-secret-scan-"));
    const forbidden = "owner-only-test-secret";
    await writeFile(join(directory, "safe.json"), '{"status":"PARTIAL"}\n');
    expect(await scanLaneBArtifactsForSecrets(directory, { forbiddenValues: [forbidden] as string[] })).toEqual({ ok: true, findings: [] });
    await writeFile(join(directory, "bad.json"), `{"credential":"${forbidden}"}\n`);
    const result = await scanLaneBArtifactsForSecrets(directory, { forbiddenValues: [forbidden] as string[] });
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      { path: "bad.json", code: "forbidden_exact_value" },
      { path: "bad.json", code: "credential_assignment" },
    ]));
    expect(JSON.stringify(result)).not.toContain(forbidden);
    await writeFile(join(directory, "taxonomy.json"), '{"token":"friendship"}\n');
    const taxonomy = await scanLaneBArtifactsForSecrets(directory, { forbiddenValues: [] });
    expect(taxonomy.findings).not.toContainEqual({ path: "taxonomy.json", code: "credential_assignment" });
  });

  it("finalizes selection plus manifest idempotently without appending a second copy", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "lane-b-store-finalize-"));
    const preflight = buildLaneBPreflight({
      runId: "run-finalize",
      channelAppId: "channel-app-1",
      artifactRoot,
      now: new Date("2026-08-13T00:00:00.000Z"),
    });
    const store = await createLaneBRunStore({
      artifactRoot,
      runId: "run-finalize",
      channelAppId: "channel-app-1",
      preflight,
    });
    const input = {
      manifest: {
        schema_version: 1,
        run_id: "run-finalize",
        channel_app_id: "channel-app-1",
        status: "PARTIAL",
        planned_unique_pages: 240,
        retry_budget: 10,
        http_attempt_cap: 250,
        actual_http_attempts: 0,
        actual_unique_pages: 0,
        successful_pages: 0,
        retry_attempts: 0,
        candidate_unique_books: 0,
        final_sample_books: 0,
        duplicate_book_observations: 0,
        stop_reason: null,
        total_count_refreshed: null,
        total_pages_refreshed: null,
        raw_page_artifacts: [],
      },
      selectionRecords: [],
    };
    await store.finalizeRun(input);
    await store.finalizeRun(input);
    const finalizedManifest = input.manifest as typeof input.manifest & {
      raw_data_artifacts: Array<{ path: string; kind: string; record_count: number }>;
      raw_json_artifacts: Array<{ path: string; kind: string; sha256: string }>;
    };
    expect(await readFile(store.paths.finalSelection, "utf8")).toBe("");
    expect(JSON.parse(await readFile(store.paths.rawManifest, "utf8"))).toMatchObject({
      ...input.manifest,
      raw_round_trip_qa_passed: true,
    });
    expect(finalizedManifest.raw_data_artifacts).toHaveLength(6);
    expect(finalizedManifest.raw_data_artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "source-book-samples.jsonl", kind: "raw_data", record_count: 0 }),
      expect.objectContaining({ path: "source-token-observations.jsonl", kind: "raw_data", record_count: 0 }),
      expect.objectContaining({ path: "source-token-structure-anomalies.jsonl", kind: "raw_data", record_count: 0 }),
      expect.objectContaining({ path: "request-attempts.jsonl", kind: "raw_data", record_count: 0 }),
      expect.objectContaining({ path: "duplicate-books.jsonl", kind: "raw_data", record_count: 0 }),
      expect.objectContaining({ path: "final-sample-book-keys.jsonl", kind: "raw_data", record_count: 0 }),
    ]));
    expect(finalizedManifest.raw_json_artifacts).toEqual([
      expect.objectContaining({ path: "preflight.json", kind: "raw_json", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    ]);
  });

  it("downgrades COMPLETE when any raw descriptor fails final read-back", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "lane-b-store-failed-roundtrip-"));
    const preflight = buildLaneBPreflight({
      runId: "run-failed-roundtrip",
      channelAppId: "channel-app-1",
      artifactRoot,
      now: new Date("2026-08-13T00:00:00.000Z"),
    });
    const store = await createLaneBRunStore({
      artifactRoot,
      runId: "run-failed-roundtrip",
      channelAppId: "channel-app-1",
      preflight,
    });
    const manifest = {
      schema_version: 1,
      run_id: "run-failed-roundtrip",
      channel_app_id: "channel-app-1",
      status: "COMPLETE",
      raw_page_artifacts: [{ path: "raw-api-pages/missing.json", bytes: 0, sha256: "0".repeat(64) }],
      stop_reason: null,
    };
    await store.finalizeRun({ manifest, selectionRecords: [] });
    expect(manifest).toMatchObject({ status: "PARTIAL", raw_round_trip_qa_passed: false });
    expect(JSON.parse(await readFile(store.paths.rawManifest, "utf8"))).toMatchObject({
      status: "PARTIAL",
      raw_round_trip_qa_passed: false,
    });
  });

  it("does not write final selection twice when manifest finalization fails", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "lane-b-store-finalize-error-"));
    const preflight = buildLaneBPreflight({
      runId: "run-finalize-error",
      channelAppId: "channel-app-1",
      artifactRoot,
      now: new Date("2026-08-13T00:00:00.000Z"),
    });
    const store = await createLaneBRunStore({
      artifactRoot,
      runId: "run-finalize-error",
      channelAppId: "channel-app-1",
      preflight,
    });
    await writeFile(store.paths.rawManifest, '{"conflict":true}\n', { flag: "wx" });
    const input = {
      manifest: {
        schema_version: 1,
        run_id: "run-finalize-error",
        channel_app_id: "channel-app-1",
        status: "PARTIAL",
        stop_reason: null,
        raw_page_artifacts: [],
      },
      selectionRecords: [{ sampleBookKey: "book-1", selectedSampleIndex: 1 }],
    };
    await expect(store.finalizeRun(input)).rejects.toMatchObject({ code: "EEXIST" });
    await expect(store.finalizeRun(input)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(store.paths.finalSelection, "utf8")).toBe(
      '{"sampleBookKey":"book-1","selectedSampleIndex":1}\n',
    );
  });

  it("verifies raw data bytes/hash/count and rejects traversal or symlink descriptors", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "lane-b-store-unsafe-manifest-"));
    const outside = join(runDir, "..", "outside.jsonl");
    await writeFile(outside, '{"outside":true}\n');
    const linked = join(runDir, "linked.jsonl");
    await symlink(outside, linked);
    await writeFile(join(runDir, "raw-run-manifest.json"), JSON.stringify({
      raw_page_artifacts: [],
      raw_data_artifacts: [
        { path: "../outside.jsonl", bytes: 17, sha256: "0".repeat(64), record_count: 1 },
        { path: "linked.jsonl", bytes: 17, sha256: "0".repeat(64), record_count: 1 },
      ],
    }));
    expect(await verifyRawRunManifest(runDir)).toEqual(expect.objectContaining({
      ok: false,
      failures: expect.arrayContaining(["../outside.jsonl", "linked.jsonl"]),
    }));
  });

  it("rejects invalid status, dishonest raw QA flags, and stop reasons contradicted by audits", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "lane-b-store-status-facts-"));
    const preflight = buildLaneBPreflight({ runId: "status-facts", channelAppId: "app", artifactRoot });
    const store = await createLaneBRunStore({ artifactRoot, runId: "status-facts", channelAppId: "app", preflight });
    const page = await store.writeRawPage({ pageIndex: 1, attempt: 1, rawText: rawBookPage });
    const parsed = parseLaneBPage({ payload: JSON.parse(rawBookPage), pageIndex: 1, fetchedAt, channelAppId: "app" });
    await store.appendJsonl(store.paths.requestAudit, [successfulAudit()]);
    await store.appendJsonl(store.paths.bookSamples, [{ ...parsed.books[0], acquisitionIndex: 1 }]);
    await store.appendJsonl(store.paths.tokenObservations, parsed.observations);
    await store.finalizeRun({
      manifest: {
        schema_version: 1, run_id: "status-facts", channel_app_id: "app", status: "PARTIAL",
        total_count_refreshed: 1, total_pages_refreshed: 1, planned_unique_pages: 240, retry_budget: 10,
        http_attempt_cap: 250, actual_http_attempts: 1, actual_unique_pages: 1, successful_pages: 1,
        retry_attempts: 0, stop_reason: null, candidate_unique_books: 1, final_sample_books: 1,
        target_unique_books: 10_000, duplicate_book_observations: 0,
        language_quota_satisfied_or_exhausted: false, raw_round_trip_qa_passed: false,
        request_budget_qa_passed: true, raw_page_artifacts: [page],
      },
      selectionRecords: [{
        sampleBookKey: parsed.books[0].sampleBookKey,
        selectedSampleIndex: 1,
        selectionReason: "TOKEN_DEFICIT_COVERAGE",
      }],
    });
    const manifestPath = store.paths.rawManifest;
    const valid = JSON.parse(await readFile(manifestPath, "utf8"));

    await writeFile(manifestPath, `${JSON.stringify({ ...valid, status: "NONSENSE" }, null, 2)}\n`);
    await expect(verifyRawRunManifest(store.paths.runDir)).resolves.toMatchObject({
      ok: false, failures: expect.arrayContaining(["manifest:status"]),
    });
    await writeFile(manifestPath, `${JSON.stringify({ ...valid, raw_round_trip_qa_passed: false }, null, 2)}\n`);
    await expect(verifyRawRunManifest(store.paths.runDir)).resolves.toMatchObject({
      ok: false, failures: expect.arrayContaining(["manifest:raw_round_trip_qa_passed"]),
    });
    await writeFile(manifestPath, `${JSON.stringify({ ...valid, stop_reason: "AUTHORIZATION_REJECTED" }, null, 2)}\n`);
    await expect(verifyRawRunManifest(store.paths.runDir)).resolves.toMatchObject({
      ok: false, failures: expect.arrayContaining(["manifest:stop_reason_facts"]),
    });
  });

  it("rejects attempts made after the first 401/403 authorization stop", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "lane-b-store-auth-stop-"));
    const preflight = buildLaneBPreflight({ runId: "auth-stop", channelAppId: "app", artifactRoot });
    const store = await createLaneBRunStore({ artifactRoot, runId: "auth-stop", channelAppId: "app", preflight });
    const rawUnauthorized = JSON.stringify({ error: "unauthorized" });
    const rawEmpty = JSON.stringify({ data: { totalCount: 100, list: [] } });
    const page1 = await store.writeRawPage({ pageIndex: 1, attempt: 1, rawText: rawUnauthorized });
    const page2 = await store.writeRawPage({ pageIndex: 2, attempt: 1, rawText: rawEmpty });
    await store.appendJsonl(store.paths.requestAudit, [
      { ...successfulAudit(), ok: false, status: 401, retryable: false, errorCode: "upstream_http_error" },
      {
        ...successfulAudit(), pageIndex: 2, requestedAt: "2026-08-13T00:00:02.000Z",
        requestStartedAt: "2026-08-13T00:00:02.000Z", responseReceivedAt: "2026-08-13T00:00:02.001Z",
      },
    ]);
    await store.finalizeRun({
      manifest: {
        schema_version: 1, run_id: "auth-stop", channel_app_id: "app", status: "PARTIAL",
        total_count_refreshed: 100, total_pages_refreshed: 1, planned_unique_pages: 240, retry_budget: 10,
        http_attempt_cap: 250, actual_http_attempts: 2, actual_unique_pages: 2, successful_pages: 1,
        retry_attempts: 0, stop_reason: "AUTHORIZATION_REJECTED", candidate_unique_books: 0,
        final_sample_books: 0, target_unique_books: 10_000, duplicate_book_observations: 0,
        language_quota_satisfied_or_exhausted: false, raw_round_trip_qa_passed: false,
        request_budget_qa_passed: true, raw_page_artifacts: [page1, page2],
      },
      selectionRecords: [],
    });
    await expect(verifyRawRunManifest(store.paths.runDir)).resolves.toMatchObject({
      ok: false,
      failures: expect.arrayContaining(["request-attempts.jsonl:stop_sequence"]),
    });
  });
});
