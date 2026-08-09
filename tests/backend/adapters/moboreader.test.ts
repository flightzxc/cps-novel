import { describe, expect, it, vi } from "vitest";
import {
  MoboreaderAdapterError,
  buildMoboreaderPreviewRequestsFromCatalogRow,
  createMoboreaderReadAdapter,
  parseBookMaterialResponse,
  parseListBooksResponse,
  parsePreviewChaptersResponse,
} from "@/lib/adapters";

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
    });
    expect(parsed.items[0].rawEvidence.source_label).toEqual({ future: "preserve-me" });
    expect(parsed.items[0].rawEvidence.kocCode).toBe("[redacted]");
    expect(parsed.items[0].rawEvidence.publicUrl).toBe("[redacted]");
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
