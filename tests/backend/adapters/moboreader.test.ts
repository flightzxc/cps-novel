import { describe, expect, it, vi } from "vitest";
import {
  MoboreaderAdapterError,
  REDACTED_EVIDENCE_SENTINEL,
  buildMoboreaderPreviewRequestsFromCatalogRow,
  createMoboreaderReadAdapter,
  parseBookMaterialResponse,
  parseListBooksResponse,
  parsePreviewChaptersResponse,
} from "@/lib/adapters";
import { buildChangduPreviewPlan } from "@/lib/preview";

function listPayload() {
  return {
    data: {
      totalCount: 95_479,
      list: [{
        id: "book-1",
        agencyId: "agency-1",
        agencyName: "Agency",
        seriesId: "series-1",
        seriesName: "Book",
        description: "Description",
        coverUrl: "https://images.example/cover.jpg",
        projectType: 1,
        language: 2,
        languageName: "English",
        allEpis: 10,
        payEpisFrom: 4,
        splitRatio: 50,
        seriesTypeList: [{ value: "fantasy" }],
        recommendList: ["featured"],
        source_label: { future: "preserve-me" },
        kocCode: "must-not-leak",
        publicUrl: "https://promo.example/secret",
        promotionalText: "Share with code must-not-leak",
      }],
    },
  };
}

describe("MoboReader read adapter", () => {
  it("passes through a present getlistpc materialType without treating 1 or 1001 as a global constant", () => {
    const requests = buildMoboreaderPreviewRequestsFromCatalogRow({
      id: 332676694,
      seriesId: 7654321,
      agencyId: 6833,
      projectType: 1,
      language: 3,
      materialType: 77,
    });
    expect(requests.material).toEqual({
      agencyId: 6833,
      dataId: 7654321,
      projectType: 1,
      language: 3,
      materialType: 77,
    });
    expect(requests.materialTypeSource).toBe("getlistpc.materialType");
    expect(requests.material.materialType).not.toBe(1);
    expect(requests.material.materialType).not.toBe(1001);
  });

  it.each([undefined, null])("falls back to materialType=1 only when getlistpc materialType is %s", (materialType) => {
    const requests = buildMoboreaderPreviewRequestsFromCatalogRow({
      id: "not-the-data-id",
      seriesId: "series-is-the-data-id",
      agencyId: "agency-1",
      projectType: 1,
      language: 2,
      materialType,
    });
    expect(requests.material).toMatchObject({ dataId: "series-is-the-data-id", materialType: 1 });
    expect(requests.chapters.seriesId).toBe("series-is-the-data-id");
    expect(requests.materialTypeSource).toBe("fallback_1");
    expect(requests.material.materialType).not.toBe(1001);
  });

  it("does not replace a present zero materialType via truthiness fallback", () => {
    expect(buildMoboreaderPreviewRequestsFromCatalogRow({
      seriesId: "series-0",
      agencyId: "agency-1",
      projectType: 1,
      language: 2,
      materialType: 0,
    }).material.materialType).toBe(0);
  });

  it("fails closed instead of substituting getlistpc.id when seriesId is absent", () => {
    expect(() => buildMoboreaderPreviewRequestsFromCatalogRow({
      id: "must-not-be-used",
      agencyId: "agency-1",
      projectType: 1,
      language: 2,
    })).toThrow(MoboreaderAdapterError);
  });

  it("parses getlistpc and confines unknown fields to redacted raw evidence", () => {
    const parsed = parseListBooksResponse(listPayload());
    expect(parsed.totalCount).toBe(95_479);
    expect(parsed.items[0]).toMatchObject({
      externalBookId: "book-1",
      seriesId: "series-1",
      language: "2",
      allEpis: 10,
      payEpisFrom: 4,
      seriesTypeList: ["fantasy"],
      recommendList: ["featured"],
      labelSnapshotComplete: true,
      existingPromo: {
        upstreamCode: "must-not-leak",
        webUrl: "https://promo.example/secret",
      },
    });
    expect(parsed.items[0].rawEvidence.source_label).toEqual({ future: "preserve-me" });
    expect(parsed.items[0].rawEvidence.kocCode).toBe(REDACTED_EVIDENCE_SENTINEL);
    expect(parsed.items[0].rawEvidence.publicUrl).toBe(REDACTED_EVIDENCE_SENTINEL);
    expect(parsed.items[0].rawEvidence.promotionalText).toBe(REDACTED_EVIDENCE_SENTINEL);
    expect(JSON.stringify(parsed.items[0].rawEvidence)).not.toContain("must-not-leak");
  });

  it("uses publicUrl then homeLink for the in-memory promo handoff and assigns no onlineUrl semantics", () => {
    const payload = listPayload() as unknown as { data: { list: Array<Record<string, unknown>>; totalCount: number } };
    payload.data.list[0].publicUrl = "";
    payload.data.list[0].homeLink = "https://promo.example/home";
    payload.data.list[0].onlineUrl = "app://unproven";
    expect(parseListBooksResponse(payload).items[0].existingPromo).toEqual({
      upstreamCode: "must-not-leak",
      webUrl: "https://promo.example/home",
    });
  });

  it("preserves all four source label identities without trimming or mapping", () => {
    const payload = listPayload();
    payload.data.list[0].agencyId = " agency-01 ";
    payload.data.list[0].language = 2;
    payload.data.list[0].seriesTypeList = [{ value: "  fantasy  " }];
    payload.data.list[0].recommendList = ["Featured/特别"];
    const [book] = parseListBooksResponse(payload).items;
    expect({
      agency: book.agencyId,
      language: book.language,
      seriesType: book.seriesTypeList[0],
      recommend: book.recommendList[0],
    }).toEqual({
      agency: " agency-01 ",
      language: "2",
      seriesType: "  fantasy  ",
      recommend: "Featured/特别",
    });
  });

  it("distinguishes a complete empty label snapshot from missing or malformed label structures", () => {
    const complete = listPayload();
    complete.data.list[0].agencyId = null as unknown as string;
    complete.data.list[0].seriesTypeList = [];
    complete.data.list[0].recommendList = [];
    expect(parseListBooksResponse(complete).items[0].labelSnapshotComplete).toBe(true);

    const missingAgency = listPayload() as unknown as { data: { list: Array<Record<string, unknown>>; totalCount: number } };
    delete missingAgency.data.list[0].agencyId;
    expect(parseListBooksResponse(missingAgency).items[0].labelSnapshotComplete).toBe(false);

    const malformed = listPayload() as unknown as { data: { list: Array<Record<string, unknown>>; totalCount: number } };
    malformed.data.list[0].recommendList = ["valid", { unexpected: "value" }];
    const parsed = parseListBooksResponse(malformed).items[0];
    expect(parsed.labelSnapshotComplete).toBe(false);
    expect(parsed.recommendList).toEqual([]);
  });

  it("parses getbydataid without assigning semantics to unknown status values", () => {
    expect(parseBookMaterialResponse({
      data: { dataId: "d1", seriesId: "s1", materialType: 99, materialStatus: 701, statusText: "unknown" },
    })).toMatchObject({ dataId: "d1", seriesId: "s1", materialType: 99, materialStatus: 701 });
  });

  it("parses only actual getchapterinfo chapterList rows", () => {
    const parsed = parsePreviewChaptersResponse({
      data: {
        bookId: "b1",
        currentLanguage: 2,
        allEpis: 999,
        chapterList: [{ i: 1, chapterID: "c1", chapterName: "One", chapterShowName: "Chapter 1", chapterContent: "body" }],
      },
    });
    expect(parsed.chapterList).toHaveLength(1);
    expect(parsed).not.toHaveProperty("allEpis");
  });

  it.each([
    [998877, "998877"],
    ["book-00998877", "book-00998877"],
  ])("normalizes getchapterinfo bookId %s without changing its string contract", (bookId, expected) => {
    const parsed = parsePreviewChaptersResponse({
      data: {
        bookId,
        currentLanguage: 3,
        chapterList: [{ i: 1, chapterID: 5001001, chapterContent: "body" }],
      },
    });
    expect(parsed.bookId).toBe(expected);
    expect(typeof parsed.bookId).toBe("string");
    expect(parsed.chapterList[0].chapterID).toBe("5001001");
  });

  it.each([
    [null, "typeof object (null)"],
    ["", "typeof string (empty)"],
  ])("rejects invalid bookId %s with field and shape diagnostics only", (bookId, shape) => {
    let caught: unknown;
    try {
      parsePreviewChaptersResponse({
        data: {
          bookId,
          currentLanguage: 3,
          chapterList: [{ i: 1, chapterID: "private-chapter-id", chapterContent: "private-body" }],
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MoboreaderAdapterError);
    const error = caught as MoboreaderAdapterError;
    expect(error).toMatchObject({ code: "malformed_payload", retryable: false });
    expect(error.detail).toContain("bookId");
    expect(error.detail).toContain(shape);
    expect(error.message).toContain("bookId");
    expect(error.message).toContain(shape);
    expect(error.message).not.toMatch(/private-chapter-id|private-body/);
  });

  it("accepts a numeric getchapterinfo chapterID by converting it to a string (D-1 fix, aligned with seriesId/externalBookId strictness)", () => {
    const parsed = parsePreviewChaptersResponse({
      data: {
        bookId: "b1",
        currentLanguage: 2,
        chapterList: [{ i: 1, chapterID: 5001001, chapterName: "One", chapterShowName: "Chapter 1", chapterContent: "body" }],
      },
    });
    expect(parsed.chapterList[0].chapterID).toBe("5001001");
    expect(typeof parsed.chapterList[0].chapterID).toBe("string");
  });

  it("accepts a string getchapterinfo chapterID unchanged", () => {
    const parsed = parsePreviewChaptersResponse({
      data: {
        bookId: "b1",
        currentLanguage: 2,
        chapterList: [{ i: 1, chapterID: "c-001", chapterName: "One", chapterShowName: "Chapter 1", chapterContent: "body" }],
      },
    });
    expect(parsed.chapterList[0].chapterID).toBe("c-001");
  });

  it.each([
    ["null", null as unknown],
    ["missing", undefined as unknown],
    ["an empty string", "" as unknown],
  ])("still fails closed on a diagnosable chapterID (%s) naming the field and the received typeof", (_label, chapterID) => {
    const row: Record<string, unknown> = { i: 1, chapterName: "One", chapterShowName: "Chapter 1", chapterContent: "body" };
    if (chapterID !== undefined) row.chapterID = chapterID;
    let caught: unknown;
    try {
      parsePreviewChaptersResponse({ data: { bookId: "b1", currentLanguage: 2, chapterList: [row] } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MoboreaderAdapterError);
    const error = caught as MoboreaderAdapterError;
    expect(error.code).toBe("malformed_payload");
    expect(error.retryable).toBe(false);
    expect(error.detail).toContain("chapterID");
    expect(error.detail).toMatch(/typeof/);
    expect(error.message).toContain("chapterID");
  });

  it("end-to-end: a numeric chapterID in a minimal getchapterinfo fixture parses successfully and reaches the persisted-field boundary as a string", () => {
    // Minimal real-shaped getchapterinfo response with a numeric chapterID,
    // the exact upstream shape the D-1 smoke recheck found the parser rejecting.
    const fixture = {
      data: {
        bookId: "book-998877",
        currentLanguage: 2,
        chapterList: [
          { i: 1, chapterID: 5001001, chapterName: "Chapter One", chapterShowName: null, chapterContent: "Once upon a time." },
        ],
      },
    };
    const parsed = parsePreviewChaptersResponse(fixture);
    expect(parsed.chapterList).toHaveLength(1);
    expect(parsed.chapterList[0].chapterID).toBe("5001001");

    // buildChangduPreviewPlan is the pure planning step whose output chapters
    // feed changdu-materialization.ts's Prisma upsert
    // (`externalChapterId: chapter.chapterID`, NovelChapterSourceItem.externalChapterId
    // is `String @db.VarChar(160)`). Asserting the type here pins the
    // "field written to the DB is a string" invariant without a live database.
    const plan = buildChangduPreviewPlan({
      chapterList: parsed.chapterList,
      maxMaterializedChapters: 3,
      trustedCompleteResponse: true,
    });
    expect(plan.authoritative).toBe(true);
    expect(plan.chapters[0].chapterID).toBe("5001001");
    expect(typeof plan.chapters[0].chapterID).toBe("string");
  });

  it.each([
    {},
    { data: {} },
    { data: { totalCount: 1, list: [{}] } },
  ])("rejects malformed catalog payloads", (payload) => {
    expect(() => parseListBooksResponse(payload)).toThrow(MoboreaderAdapterError);
  });

  it("uses the exact endpoint and five-field getlistpc body", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify(listPayload()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const adapter = createMoboreaderReadAdapter({ fetchImpl });
    await adapter.listBooks({ name: "", orderType: 0, pageIndex: 2, pageSize: 100, projectType: 1 }, "secret-token");
    expect(capturedUrl).toBe("https://kocserver-cn.cdreader.com/api/v1/res/getlistpc");
    expect(JSON.parse(String(capturedInit?.body))).toEqual({ name: "", orderType: 0, pageIndex: 2, pageSize: 100, projectType: 1 });
    expect(new URL(capturedUrl).search).toBe("");
  });

  it("sends the frozen runtime-selected getbydataid request unchanged", async () => {
    let capturedUrl = "";
    let capturedBody: unknown;
    const fetchImpl: typeof fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ data: { list: [], totalCount: 0 } }), { status: 200 });
    };
    const adapter = createMoboreaderReadAdapter({ fetchImpl });
    const { material } = buildMoboreaderPreviewRequestsFromCatalogRow({
      id: 332676694,
      seriesId: 7654321,
      agencyId: 6833,
      projectType: 1,
      language: 3,
    });
    await adapter.fetchBookMaterial(material, "secret-token");
    expect(capturedUrl).toBe("https://kocserver-cn.cdreader.com/api/v1/material/getbydataid");
    expect(capturedBody).toEqual({
      agencyId: 6833,
      dataId: 7654321,
      projectType: 1,
      language: 3,
      materialType: 1,
    });
  });

  it("retries safe reads for retryable status and honors bounded Retry-After", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("unlogged", { status: 503, headers: { "retry-after": "9999" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(listPayload()), { status: 200 }));
    const sleep = vi.fn(async () => undefined);
    const adapter = createMoboreaderReadAdapter({ fetchImpl, sleep });
    await adapter.listBooks({ name: "", orderType: 0, pageIndex: 1, pageSize: 10, projectType: 1 }, "token");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(30_000);
  });

  it("times out and retries no more than three safe-read attempts", async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const adapter = createMoboreaderReadAdapter({ fetchImpl: fetchImpl as typeof fetch, timeoutMs: 5, sleep: async () => undefined });
    await expect(adapter.listBooks({ name: "", orderType: 0, pageIndex: 1, pageSize: 10, projectType: 1 }, "top-secret"))
      .rejects.toMatchObject({ code: "request_timeout", retryable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry malformed payloads or leak credentials/payloads in errors", async () => {
    const fetchImpl = vi.fn(async () => new Response("not-json", { status: 200 }));
    const adapter = createMoboreaderReadAdapter({ fetchImpl, sleep: async () => undefined });
    let message = "";
    try {
      await adapter.listBooks({ name: "sensitive-title", orderType: 0, pageIndex: 1, pageSize: 10, projectType: 1 }, "eyJ.secret.jwt");
    } catch (error) {
      message = String(error);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(message).not.toContain("eyJ.secret.jwt");
    expect(message).not.toContain("sensitive-title");
    expect(message).not.toContain("not-json");
  });
});
