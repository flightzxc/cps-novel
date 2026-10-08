import { describe, expect, it, vi } from "vitest";

import {
  NOVEL_REVENUE_ENDPOINT,
  NOVEL_REVENUE_MAX_PAGES,
  NOVEL_REVENUE_PAGE_SIZE,
  NOVEL_REVENUE_PROJECT_TYPE,
  NovelRevenueAdapterError,
  assertAllowedNovelRevenueEndpoint,
  buildNovelGetReportBody,
  extractNovelReportList,
  fetchNovelDailyReport,
  scrubSecretText,
} from "@/lib/adapters/moboreader-revenue";
import type { UpstreamCallObservation } from "@/lib/adapters/upstream-observation";

import { detailRow, envelope, fakeStarJwt, jsonResponse, totalRow } from "./support";

const TOKEN = fakeStarJwt();
const RANGE = { beginDate: "2026-09-20", endDate: "2026-10-07" } as const;

type FetchCall = { url: string; init: RequestInit; body: Record<string, unknown> };

function recordingFetch(responses: Array<Response | (() => Response | Promise<Response>) | Error>) {
  const calls: FetchCall[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      calls.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      const next = responses[Math.min(calls.length - 1, responses.length - 1)];
      await Promise.resolve();
      if (next instanceof Error) throw next;
      return typeof next === "function" ? await next() : next!.clone();
    } finally {
      inFlight -= 1;
    }
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls, maxInFlight: () => maxInFlight };
}

function fullPage(offset: number) {
  return Array.from({ length: NOVEL_REVENUE_PAGE_SIZE }, (_, index) => {
    const day = new Date(Date.UTC(2020, 0, 1) + (offset * NOVEL_REVENUE_PAGE_SIZE + index) * 86_400_000);
    return detailRow(day.toISOString().slice(0, 10));
  });
}

async function failure(promise: Promise<unknown>): Promise<NovelRevenueAdapterError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(NovelRevenueAdapterError);
    return error as NovelRevenueAdapterError;
  }
  throw new Error("expected the call to fail");
}

describe("请求体恒带 projectType=1（变异目标①）", () => {
  it("buildNovelGetReportBody 无条件写入 projectType:1、dimensions:['1']、pageSize:999", () => {
    expect(buildNovelGetReportBody({ beginDate: "2026-09-20", endDate: "2026-10-07", pageIndex: 1 })).toStrictEqual({
      beginTime: "2026-09-20",
      endTime: "2026-10-07",
      dimensions: ["1"],
      pageIndex: 1,
      pageSize: 999,
      projectType: 1,
    });
    expect(NOVEL_REVENUE_PROJECT_TYPE).toBe(1);
  });

  it("入参里没有 projectType：即使有人强行塞一个别的值也不会生效", () => {
    const body = buildNovelGetReportBody({
      beginDate: "2026-09-20",
      endDate: "2026-10-07",
      pageIndex: 3,
      projectType: 2,
      dimensions: ["9"],
      pageSize: 5,
    } as never);
    expect(body.projectType).toBe(1);
    expect(body.dimensions).toEqual(["1"]);
    expect(body.pageSize).toBe(999);
    expect(body.pageIndex).toBe(3);
  });

  it("真正发出去的每一个请求（含翻页）都带 projectType:1", async () => {
    const { fetchImpl, calls } = recordingFetch([
      jsonResponse(envelope(fullPage(0))),
      jsonResponse(envelope(fullPage(1))),
      jsonResponse(envelope([detailRow("2026-10-01"), totalRow()])),
    ]);

    const report = await fetchNovelDailyReport({ token: TOKEN, ...RANGE, fetchImpl });

    expect(report.requestCount).toBe(3);
    expect(calls).toHaveLength(3);
    for (const [index, call] of calls.entries()) {
      expect(call.body.projectType, `page ${index + 1}`).toBe(1);
      expect(call.body.dimensions).toEqual(["1"]);
      expect(call.body.pageSize).toBe(999);
      expect(call.body.pageIndex).toBe(index + 1);
      expect(call.body.beginTime).toBe("2026-09-20");
      expect(call.body.endTime).toBe("2026-10-07");
    }
  });

  it("请求形状：POST、固定端点、redirect:error、headers 只有 authorization 与 content-type", async () => {
    const { fetchImpl, calls } = recordingFetch([jsonResponse(envelope([]))]);
    await fetchNovelDailyReport({ token: TOKEN, ...RANGE, fetchImpl });

    const call = calls[0]!;
    expect(call.url).toBe("https://kocserver-cn.cdreader.com/api/Report/GetReport");
    expect(call.url).toBe(NOVEL_REVENUE_ENDPOINT);
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("error");
    expect(call.init.headers).toEqual({ authorization: `Bearer ${TOKEN}`, "content-type": "application/json" });
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    [{ beginDate: "2026-9-20", endDate: "2026-10-07", pageIndex: 1 }],
    [{ beginDate: "2026-09-20", endDate: "2026-02-30", pageIndex: 1 }],
    [{ beginDate: "2026-10-08", endDate: "2026-10-07", pageIndex: 1 }],
    [{ beginDate: "2026-09-20", endDate: "2026-10-07", pageIndex: 0 }],
    [{ beginDate: "2026-09-20", endDate: "2026-10-07", pageIndex: 1.5 }],
  ])("非法入参 %j → invalid_request，不发请求", (input) => {
    expect(() => buildNovelGetReportBody(input)).toThrowError(NovelRevenueAdapterError);
  });

  it("非法区间在发任何请求之前就被拒绝", async () => {
    const { fetchImpl } = recordingFetch([jsonResponse(envelope([]))]);
    const error = await failure(fetchNovelDailyReport({ token: TOKEN, beginDate: "2026-10-08", endDate: "2026-10-07", fetchImpl }));
    expect(error.code).toBe("invalid_request");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("没有凭证时不发请求", async () => {
    const { fetchImpl } = recordingFetch([jsonResponse(envelope([]))]);
    const error = await failure(fetchNovelDailyReport({ token: "   ", ...RANGE, fetchImpl }));
    expect(error.code).toBe("invalid_request");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("分页：按“本页明细行数 < pageSize 即停止”，最多 10 页，串行", () => {
  it("一页不满 999 行就停；总计行不计入明细行数", async () => {
    const { fetchImpl, calls } = recordingFetch([jsonResponse(envelope([...fullPage(0).slice(0, 998), totalRow()]))]);
    const report = await fetchNovelDailyReport({ token: TOKEN, ...RANGE, fetchImpl });
    expect(calls).toHaveLength(1);
    expect(report.requestCount).toBe(1);
    expect(report.rows).toHaveLength(999);
  });

  it("满 999 条明细才翻页；总计行不让一页“看起来满了”", async () => {
    const page = [...fullPage(0).slice(0, NOVEL_REVENUE_PAGE_SIZE - 1), totalRow()];
    expect(page).toHaveLength(NOVEL_REVENUE_PAGE_SIZE);
    const { fetchImpl, calls } = recordingFetch([jsonResponse(envelope(page))]);
    await fetchNovelDailyReport({ token: TOKEN, ...RANGE, fetchImpl });
    expect(calls).toHaveLength(1);
  });

  it("多页：各页原样拼接，requestCount = 页数，页与页严格串行（绝不并发）", async () => {
    const { fetchImpl, calls, maxInFlight } = recordingFetch([
      jsonResponse(envelope(fullPage(0))),
      jsonResponse(envelope(fullPage(1))),
      jsonResponse(envelope([detailRow("2026-10-01"), totalRow()])),
    ]);
    const report = await fetchNovelDailyReport({ token: TOKEN, ...RANGE, fetchImpl });
    expect(calls).toHaveLength(3);
    expect(report.rows).toHaveLength(NOVEL_REVENUE_PAGE_SIZE * 2 + 2);
    expect(maxInFlight()).toBe(1);
  });

  it("每页都满 → 恰好 10 页后报 upstream_page_limit_exceeded，不发第 11 次请求", async () => {
    const { fetchImpl, calls } = recordingFetch([jsonResponse(envelope(fullPage(0)))]);
    const error = await failure(fetchNovelDailyReport({ token: TOKEN, ...RANGE, fetchImpl }));
    expect(error.code).toBe("upstream_page_limit_exceeded");
    expect(calls).toHaveLength(NOVEL_REVENUE_MAX_PAGES);
    expect(NOVEL_REVENUE_MAX_PAGES).toBe(10);
  });

  it("空列表是合法结果：0 行、1 次请求", async () => {
    const { fetchImpl } = recordingFetch([jsonResponse(envelope([]))]);
    const report = await fetchNovelDailyReport({ token: TOKEN, ...RANGE, fetchImpl });
    expect(report).toEqual({ rows: [], requestCount: 1 });
  });
});

describe("信封校验与错误分类（稳定错误码）", () => {
  it.each([
    ["status:false", envelope([], { status: false })],
    ["code:500", envelope([], { code: 500 })],
    ["code:'401'", envelope([], { code: "401" })],
    ["data:null", { status: true, code: 200, message: "ok", data: null }],
    ["data 缺失", { status: true, code: 200, message: "ok" }],
    ["list 不是数组", { status: true, code: 200, data: { list: "nope" } }],
    ["list 缺失", { status: true, code: 200, data: { headers: [] } }],
    ["数组响应", [1, 2, 3]],
    ["null 响应", null],
  ])("信封 %s → upstream_envelope_error", async (_name, payload) => {
    const { fetchImpl } = recordingFetch([jsonResponse(payload)]);
    const error = await failure(fetchNovelDailyReport({ token: TOKEN, ...RANGE, fetchImpl }));
    expect(error.code).toBe("upstream_envelope_error");
  });

  it("code 为字符串 '200' 视为成功", async () => {
    const { fetchImpl } = recordingFetch([jsonResponse(envelope([], { code: "200" }))]);
    await expect(fetchNovelDailyReport({ token: TOKEN, ...RANGE, fetchImpl })).resolves.toMatchObject({ requestCount: 1 });
  });

  it("HTTP 非 2xx → upstream_http_error 并带状态码；429 单独 upstream_rate_limited", async () => {
    for (const status of [400, 401, 403, 500, 502, 503]) {
      const { fetchImpl } = recordingFetch([jsonResponse({ message: "boom" }, { status })]);
      const error = await failure(fetchNovelDailyReport({ token: TOKEN, ...RANGE, fetchImpl }));
      expect(error.code, String(status)).toBe("upstream_http_error");
      expect(error.status).toBe(status);
    }
    const { fetchImpl, calls } = recordingFetch([jsonResponse({}, { status: 429, headers: { "retry-after": "5" } })]);
    const limited = await failure(fetchNovelDailyReport({ token: TOKEN, ...RANGE, fetchImpl }));
    expect(limited.code).toBe("upstream_rate_limited");
    expect(limited.status).toBe(429);
    // 不重试：任务是后台手动触发 + maxAttempts 1，失败直接呈现给运营。
    expect(calls).toHaveLength(1);
  });

  it("网络错误 / 重定向 → transport_error；非 JSON 响应 → transport_error", async () => {
    const network = recordingFetch([new TypeError("fetch failed")]);
    expect((await failure(fetchNovelDailyReport({ token: TOKEN, ...RANGE, fetchImpl: network.fetchImpl }))).code).toBe("transport_error");

    const html = recordingFetch([new Response("<html>gateway</html>", { status: 200 })]);
    const notJson = await failure(fetchNovelDailyReport({ token: TOKEN, ...RANGE, fetchImpl: html.fetchImpl }));
    expect(notJson.code).toBe("transport_error");
    expect(notJson.status).toBe(200);
  });

  it("超时 → transport_error（detail=timeout），并真的取消了在途请求", async () => {
    let signalSeen: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => {
      signalSeen = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }) as unknown as typeof fetch;
    const error = await failure(fetchNovelDailyReport({ token: TOKEN, ...RANGE, fetchImpl, timeoutMs: 20 }));
    expect(error.code).toBe("transport_error");
    expect(error.detail).toBe("timeout");
    expect(signalSeen?.aborted).toBe(true);
  });

  it("调用方已取消 → transport_error，且不发请求（限速闸等待之后再检查一次）", async () => {
    const controller = new AbortController();
    const { fetchImpl } = recordingFetch([jsonResponse(envelope([]))]);
    const rateGate = { wait: vi.fn(async () => { controller.abort(); }) };
    const error = await failure(fetchNovelDailyReport({ token: TOKEN, ...RANGE, fetchImpl, signal: controller.signal, rateGate }));
    expect(error.code).toBe("transport_error");
    expect(error.detail).toBe("aborted");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("extractNovelReportList 直接可测：拿到 data.list", () => {
    expect(extractNovelReportList(envelope([{ a: 1 }]), TOKEN)).toEqual([{ a: 1 }]);
  });
});

describe("错误信息里绝不能带 token", () => {
  const leakyCases: Array<[string, () => ReturnType<typeof recordingFetch>]> = [
    ["底层 fetch 错误信息里带 token 与 URL", () => recordingFetch([new TypeError(`fetch failed: Authorization: Bearer ${TOKEN} -> ${NOVEL_REVENUE_ENDPOINT}`)])],
    ["上游业务错误信息回显 token", () => recordingFetch([jsonResponse(envelope([], { status: false, code: 401, message: `invalid token ${TOKEN}; Bearer ${TOKEN}` }))])],
    ["HTTP 500 响应体回显 token", () => recordingFetch([jsonResponse({ message: `Bearer ${TOKEN}` }, { status: 500 })])],
    ["429", () => recordingFetch([jsonResponse({ message: TOKEN }, { status: 429 })])],
    ["非 JSON 响应体回显 token", () => recordingFetch([new Response(`echo ${TOKEN}`, { status: 200 })])],
  ];

  it.each(leakyCases)("%s → message / detail / 序列化后的错误对象都不含 token", async (_name, build) => {
    const { fetchImpl } = build();
    const error = await failure(fetchNovelDailyReport({ token: TOKEN, ...RANGE, fetchImpl }));
    const serialized = JSON.stringify({ message: error.message, detail: error.detail, code: error.code, status: error.status, stack: error.stack?.split("\n")[0] });
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(TOKEN.split(".")[1]!);
    expect(error.message).not.toMatch(/eyJ/);
    expect(error.message).not.toMatch(/Bearer\s+[A-Za-z0-9]/);
  });

  it("上游业务错误的可读文本保留（给运营看原因），但先脱敏并截断", async () => {
    const { fetchImpl } = recordingFetch([jsonResponse(envelope([], { status: false, code: 401, message: `登录已失效 ${TOKEN} ${"x".repeat(500)}` }))]);
    const error = await failure(fetchNovelDailyReport({ token: TOKEN, ...RANGE, fetchImpl }));
    expect(error.detail).toContain("登录已失效");
    expect(error.detail).toContain("[redacted]");
    expect(error.detail!.length).toBeLessThanOrEqual(200);
  });

  it("scrubSecretText：遮蔽 token 本身、Bearer、JWT 形状", () => {
    expect(scrubSecretText(`a ${TOKEN} b`, TOKEN)).toBe("a [redacted] b");
    expect(scrubSecretText("Authorization: Bearer abc.def.ghi")).toBe("Authorization: Bearer [redacted]");
    expect(scrubSecretText(`x ${fakeStarJwt()} y`)).toBe("x [redacted] y");
    expect(scrubSecretText("普通文本 123")).toBe("普通文本 123");
  });

  it("观测事件里没有 token、请求体或响应体", async () => {
    const events: UpstreamCallObservation[] = [];
    const { fetchImpl } = recordingFetch([jsonResponse(envelope([detailRow("2026-10-01")]))]);
    await fetchNovelDailyReport({ token: TOKEN, ...RANGE, fetchImpl, onUpstreamObservation: (event) => events.push(event) });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ endpoint: "getreport", httpStatus: 200, outcome: "ok" });
    expect(JSON.stringify(events)).not.toContain(TOKEN);
  });

  it("观测回调抛错不影响结果（遥测不是失败路径）", async () => {
    const { fetchImpl } = recordingFetch([jsonResponse(envelope([]))]);
    await expect(
      fetchNovelDailyReport({ token: TOKEN, ...RANGE, fetchImpl, onUpstreamObservation: () => { throw new Error("boom"); } }),
    ).resolves.toMatchObject({ requestCount: 1 });
  });
});

describe("限速闸与端点白名单", () => {
  it("每页发请求前先过限速闸（endpoint=getreport），并把响应状态反馈给它", async () => {
    const { fetchImpl } = recordingFetch([jsonResponse(envelope(fullPage(0))), jsonResponse(envelope([]))]);
    const waits: Array<string | undefined> = [];
    const observed: Array<{ endpoint: string; status: number }> = [];
    const rateGate = {
      wait: vi.fn(async (endpoint?: string) => { waits.push(endpoint); }),
      observe: vi.fn((endpoint: string, info: { httpStatus: number }) => { observed.push({ endpoint, status: info.httpStatus }); }),
    };
    await fetchNovelDailyReport({ token: TOKEN, ...RANGE, fetchImpl, rateGate });
    expect(waits).toEqual(["getreport", "getreport"]);
    expect(observed).toEqual([{ endpoint: "getreport", status: 200 }, { endpoint: "getreport", status: 200 }]);
  });

  it("只放行 https://kocserver-cn.cdreader.com/api/Report/GetReport", () => {
    expect(() => assertAllowedNovelRevenueEndpoint(NOVEL_REVENUE_ENDPOINT)).not.toThrow();
    for (const bad of [
      "http://kocserver-cn.cdreader.com/api/Report/GetReport",
      "https://mobotreeserver-cn.cdreader.com/api/Report/GetReport",
      "https://kocserver-cn.cdreader.com.evil.example/api/Report/GetReport",
      "https://kocserver-cn.cdreader.com:8443/api/Report/GetReport",
      "https://user:pass@kocserver-cn.cdreader.com/api/Report/GetReport",
      "https://kocserver-cn.cdreader.com/api/Report/GetReport?projectType=2",
      "https://kocserver-cn.cdreader.com/api/Report/GetReport#x",
      "https://kocserver-cn.cdreader.com/api/Report/GetMDetailsReport",
      "https://kocserver-cn.cdreader.com/api/Report/GetReport/Export",
      "https://kocserver-cn.cdreader.com/api/report/getreport",
      "not a url",
      "",
    ]) {
      expect(() => assertAllowedNovelRevenueEndpoint(bad), bad).toThrowError(NovelRevenueAdapterError);
    }
  });
});
