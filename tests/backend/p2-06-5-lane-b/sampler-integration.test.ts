import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  LANE_B_ENDPOINT,
  REQUEST_BODY_BASE,
} from "../../../scripts/p2-06-5-lane-b/constants.mjs";
import {
  buildLaneBPreflight,
  createLaneBRunStore,
  verifyRawRunManifest,
} from "../../../scripts/p2-06-5-lane-b/run-store.mjs";
import {
  buildAdaptivePageMetrics,
  resolveLaneBManifestStatus,
  runLaneBSampling,
} from "../../../scripts/p2-06-5-lane-b/sampler.mjs";

const repoRoot = resolve(process.cwd());

async function fixtureStore(runId: string) {
  const artifactRoot = await mkdtemp(join(tmpdir(), "lane-b-sampler-store-"));
  const preflight = buildLaneBPreflight({
    runId,
    channelAppId: "app-e2e",
    artifactRoot,
    now: new Date("2026-08-13T00:00:00.000Z"),
  });
  const store = await createLaneBRunStore({ artifactRoot, runId, channelAppId: "app-e2e", preflight });
  return { artifactRoot, store };
}

async function fixtureCredential() {
  const directory = await mkdtemp(join(tmpdir(), "lane-b-sampler-jwt-"));
  const path = join(directory, "jwt");
  await writeFile(path, "fake.owner.jwt", { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

function responseRows(pageIndex: number) {
  return Array.from({ length: 100 }, (_, rowIndex) => {
    const numericId = ((pageIndex - 1) * 100) + rowIndex;
    const language = numericId % 3;
    return {
      id: `book-${numericId}`,
      seriesName: `Book ${numericId}`,
      description: `Description ${numericId}`,
      language,
      languageName: `Language ${language}`,
      seriesTypeList: [
        `shared-${numericId % 25}`,
        numericId % 997 === 0 ? `rare-${numericId}` : `language-${language}`,
      ],
    };
  });
}

describe("P2-06.5 Lane B sampler integration", () => {
  it("never reports COMPLETE while a feasible language quota remains unmet", () => {
    expect(resolveLaneBManifestStatus({
      requestedStatus: "COMPLETE",
      selectionComplete: true,
      languageQuotaSatisfiedOrExhausted: false,
    })).toBe("PARTIAL");
    expect(resolveLaneBManifestStatus({
      requestedStatus: "COMPLETE",
      selectionComplete: true,
      languageQuotaSatisfiedOrExhausted: true,
    })).toBe("COMPLETE");
  });

  it("scores first-seen page tokens against earlier sampled pages and candidate-pool language counts", () => {
    const books = [
      { sampleBookKey: "a", sourceScope: "app", rawLanguageScope: "lang-a", pageIndex: 10, acquisitionIndex: 1 },
      { sampleBookKey: "b", sourceScope: "app", rawLanguageScope: "lang-a", pageIndex: 2, acquisitionIndex: 2 },
    ];
    const observations = [
      { sampleBookKey: "a", exactRawToken: "repeat" },
      { sampleBookKey: "b", exactRawToken: "repeat" },
      { sampleBookKey: "b", exactRawToken: "new" },
    ];
    const metrics = buildAdaptivePageMetrics({ books, observations });
    expect(metrics).toEqual([
      expect.objectContaining({
        pageIndex: 10,
        uniqueBookCount: 1,
        newDistinctTokenCount: 1,
        underQuotaLanguageBookCount: 1,
      }),
      expect.objectContaining({
        pageIndex: 2,
        uniqueBookCount: 1,
        newDistinctTokenCount: 1,
        underQuotaLanguageBookCount: 1,
      }),
    ]);
  });

  it("keeps only the first row facts when one page repeats an exact book identity", async () => {
    const credentialFile = await fixtureCredential();
    const { store } = await fixtureStore("same-page-duplicate");
    let clock = 500_000;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const pageIndex = Number((JSON.parse(String(init?.body)) as { pageIndex: number }).pageIndex);
      const list = pageIndex === 1 ? [
        { id: "same", seriesName: "First", description: "first", language: 1, languageName: "L", seriesTypeList: ["FIRST"] },
        { id: "same", seriesName: "Second", description: "second", language: 1, languageName: "L", seriesTypeList: ["DUPLICATE_MUST_NOT_LEAK"] },
      ] : [];
      return new Response(JSON.stringify({ data: { totalCount: 1, list } }), { status: 200 });
    });
    const result = await runLaneBSampling({
      credentialFile,
      repoRoot,
      channelAppId: "app-e2e",
      store,
      fetchImpl: fetchImpl as typeof fetch,
      sleep: async (milliseconds: number) => { clock += milliseconds; },
      now: () => new Date(clock),
    });
    expect(result.books).toHaveLength(1);
    expect(result.observations.map(({ exactRawToken }: { exactRawToken: string }) => exactRawToken)).toEqual(["FIRST"]);
    expect(result.manifest.duplicate_book_observations).toBe(1);
  });

  it("stops rewarding a language after prior acquisition pages reach its derived quota", () => {
    const books = Array.from({ length: 301 }, (_, index) => ({
      sampleBookKey: `book-${index}`,
      sourceScope: "app",
      rawLanguageScope: "one-language",
      pageIndex: index < 299 ? 10 : 2,
      acquisitionIndex: index + 1,
    }));
    const observations = books.map(({ sampleBookKey }) => ({ sampleBookKey, exactRawToken: "shared" }));
    const metrics = buildAdaptivePageMetrics({ books, observations });
    expect(metrics).toEqual([
      expect.objectContaining({ pageIndex: 10, underQuotaLanguageBookCount: 299 }),
      expect.objectContaining({ pageIndex: 2, underQuotaLanguageBookCount: 2 }),
    ]);

    const booksAtQuota = Array.from({ length: 503 }, (_, index) => ({
      sampleBookKey: `at-quota-${index}`,
      sourceScope: "app",
      rawLanguageScope: "one-language",
      pageIndex: 10,
      acquisitionIndex: index + 1,
    }));
    const withOneMorePage = buildAdaptivePageMetrics({
      books: [
        ...booksAtQuota,
        ...Array.from({ length: 97 }, (_, index) => ({
          sampleBookKey: `after-quota-${index}`,
          sourceScope: "app",
          rawLanguageScope: "one-language",
          pageIndex: 7,
          acquisitionIndex: 504 + index,
        })),
      ],
      observations: [
        ...booksAtQuota.map(({ sampleBookKey }) => ({ sampleBookKey, exactRawToken: "shared" })),
        ...Array.from({ length: 97 }, (_, index) => ({ sampleBookKey: `after-quota-${index}`, exactRawToken: "shared" })),
      ],
    });
    expect(withOneMorePage.at(-1)).toMatchObject({ pageIndex: 7, underQuotaLanguageBookCount: 0 });
  });

  it("runs all 240 unique pages with fixed requests and writes a complete verified 10k manifest", async () => {
    const credentialFile = await fixtureCredential();
    const { store } = await fixtureStore("e2e-240");
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    let clock = 1_000_000;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url: String(url), body });
      const pageIndex = Number(body.pageIndex);
      return new Response(JSON.stringify({
        data: {
          totalCount: 95_479,
          list: responseRows(pageIndex),
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const result = await runLaneBSampling({
      credentialFile,
      repoRoot,
      channelAppId: "app-e2e",
      store,
      fetchImpl: fetchImpl as typeof fetch,
      sleep: async (milliseconds: number) => { clock += milliseconds; },
      now: () => new Date(clock),
    });

    expect(requests).toHaveLength(240);
    expect(new Set(requests.map(({ body }) => body.pageIndex)).size).toBe(240);
    expect(new Set(requests.map(({ url }) => url))).toEqual(new Set([LANE_B_ENDPOINT]));
    expect(requests.every(({ body }) => {
      const { pageIndex, ...base } = body;
      return Number.isSafeInteger(pageIndex) && JSON.stringify(base) === JSON.stringify(REQUEST_BODY_BASE);
    })).toBe(true);
    expect(result.manifest).toMatchObject({
      status: "COMPLETE",
      actual_http_attempts: 240,
      actual_unique_pages: 240,
      successful_pages: 240,
      retry_attempts: 0,
      candidate_unique_books: 24_000,
      final_sample_books: 10_000,
      target_unique_books: 10_000,
      raw_round_trip_qa_passed: true,
      request_budget_qa_passed: true,
    });
    expect(result.selection.selectedCount).toBe(10_000);
    expect(new Set(result.selection.selectedBookIdentities).size).toBe(10_000);
    expect(result.manifest.raw_data_artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "source-book-samples.jsonl", record_count: 24_000, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ path: "source-token-observations.jsonl", record_count: 48_000, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ path: "request-attempts.jsonl", record_count: 240, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ path: "final-sample-book-keys.jsonl", record_count: 10_000, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    ]));
    expect(result.manifest.raw_data_artifacts).toHaveLength(6);
    expect(result.manifest.raw_json_artifacts).toEqual([
      expect.objectContaining({ path: "preflight.json", kind: "raw_json", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    ]);
    expect(await verifyRawRunManifest(store.paths.runDir)).toMatchObject({ ok: true, failures: [] });
    expect((await readFile(store.paths.finalSelection, "utf8")).trim().split("\n")).toHaveLength(10_000);
  }, 30_000);

  it("turns valid-JSON schema failures into retryable page failures and freezes the first page universe", async () => {
    const credentialFile = await fixtureCredential();
    const { store } = await fixtureStore("schema-failure");
    let clock = 2_000_000;
    const attempts = new Map<number, number>();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const pageIndex = Number((JSON.parse(String(init?.body)) as { pageIndex: number }).pageIndex);
      attempts.set(pageIndex, (attempts.get(pageIndex) ?? 0) + 1);
      const attempt = attempts.get(pageIndex)!;
      if (pageIndex === 1 && attempt === 1) {
        return new Response(JSON.stringify({ data: { totalCount: 95_479, list: "invalid" } }), { status: 200 });
      }
      const changedTotal = pageIndex === 1 ? 95_479 : 100;
      return new Response(JSON.stringify({ data: { totalCount: changedTotal, list: responseRows(pageIndex) } }), { status: 200 });
    });

    const result = await runLaneBSampling({
      credentialFile,
      repoRoot,
      channelAppId: "app-e2e",
      store,
      fetchImpl: fetchImpl as typeof fetch,
      sleep: async (milliseconds: number) => { clock += milliseconds; },
      now: () => new Date(clock),
    });
    expect(attempts.get(1)).toBe(2);
    expect(result.manifest).toMatchObject({
      total_count_refreshed: 95_479,
      total_pages_refreshed: 955,
      retry_attempts: 1,
      actual_http_attempts: 241,
      actual_unique_pages: 240,
      successful_pages: 240,
    });
    expect(result.requestAudits).toEqual(expect.arrayContaining([
      expect.objectContaining({ pageIndex: 1, errorCode: "upstream_schema_invalid", retryable: true }),
      expect.objectContaining({ catalogTotalChangedFrom: 95_479, catalogTotalChangedTo: 100 }),
    ]));
    expect(result.requestAudits).toHaveLength(241);
    const persistedAudits = (await readFile(store.paths.requestAudit, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(persistedAudits).toHaveLength(241);
    expect(persistedAudits).toEqual(expect.arrayContaining([
      expect.objectContaining({ pageIndex: 1, errorCode: "upstream_schema_invalid", retryable: true }),
      expect.objectContaining({ catalogTotalChangedFrom: 95_479, catalogTotalChangedTo: 100 }),
    ]));
  }, 30_000);
});
