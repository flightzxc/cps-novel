import { describe, expect, it, vi } from "vitest";

import {
  NOVEL_REVENUE_COUNTRY_ENDPOINT,
  NOVEL_REVENUE_ENDPOINT,
  NovelRevenueAdapterError,
  buildNovelCountryReportBody,
  buildNovelGetReportBody,
  fetchNovelCountryReport,
  fetchNovelDailyReport,
} from "@/lib/adapters/moboreader-revenue";
import {
  parseNovelBookReportRows,
  parseNovelCountryReport,
  reconcileBookBreakdown,
} from "@/lib/adapters/moboreader-revenue-parser";
import type { UpstreamCallObservation } from "@/lib/adapters/upstream-observation";
import { decideRevenueBookMatch } from "../../../worker/revenue/book-match";

import { bookRow, countryData, dateRowWithBooks, detailRow, envelope, fakeStarJwt, jsonResponse, totalRow } from "./support";

/**
 * v0.6.2 按书（GetReport 维度 ["1","8"]）与新增用户国家（GetCountryReport）的适配器 / 解析器 / 匹配规则。
 * 合同来自 10-17 主控在生产 worker 内的只读实测（6 次请求）；这里的值都是测试假数据。
 */
const TOKEN = fakeStarJwt();
const RANGE = { beginDate: "2026-10-10", endDate: "2026-10-16" } as const;

function recordingFetch(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    if (next instanceof Error) throw next;
    return next.clone();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("请求体：维度只能是两组冻结值，口令维度（7）无从拼出", () => {
  it("缺省按日 [\"1\"]（v0.5.11 起的请求体一个字段不变），breakdown: \"book\" → [\"1\",\"8\"]", () => {
    expect(buildNovelGetReportBody({ ...rangeDates(), pageIndex: 1 })).toEqual({
      beginTime: RANGE.beginDate, endTime: RANGE.endDate, dimensions: ["1"], pageIndex: 1, pageSize: 999, projectType: 1,
    });
    expect(buildNovelGetReportBody({ ...rangeDates(), pageIndex: 2, breakdown: "book" })).toEqual({
      beginTime: RANGE.beginDate, endTime: RANGE.endDate, dimensions: ["1", "8"], pageIndex: 2, pageSize: 999, projectType: 1,
    });
  });

  it("任何别的 breakdown（包括想取口令维度的）在发请求前就被拒绝", () => {
    for (const bad of ["code", "7", "promo", ""]) {
      expect(() => buildNovelGetReportBody({ ...rangeDates(), pageIndex: 1, breakdown: bad as never }), bad).toThrowError(NovelRevenueAdapterError);
    }
  });

  it("国家下钻请求体：同一天的日期行路径 + countryReportType（新用户 1 / 激活 0）+ projectType=1", () => {
    expect(buildNovelCountryReportBody({ date: "2026-10-16", reportType: "active_users" })).toMatchObject({ countryReportType: 0 });
    expect(buildNovelCountryReportBody({ date: "2026-10-16", reportType: "new_users" })).toEqual({
      beginTime: "2026-10-16",
      endTime: "2026-10-16",
      dimensions: ["1"],
      pageIndex: 1,
      pageSize: 999,
      projectType: 1,
      countryReportType: 1,
      list: [{ dimension: 1, dimensionValue: "2026-10-16" }],
    });
    expect(() => buildNovelCountryReportBody({ date: "2026-02-30", reportType: "new_users" })).toThrowError(NovelRevenueAdapterError);
    // 收入口径（2）本期不取：没有入口能拼出来。
    for (const bad of ["revenue", "income", "2"]) {
      expect(() => buildNovelCountryReportBody({ date: "2026-10-16", reportType: bad as never }), bad).toThrowError(NovelRevenueAdapterError);
    }
  });

  function rangeDates() {
    return { beginDate: RANGE.beginDate, endDate: RANGE.endDate };
  }
});

describe("fetchNovelDailyReport（breakdown: book）", () => {
  it("同一个 GetReport 端点、同一个观测名 getreport，请求体维度 [\"1\",\"8\"]", async () => {
    const { fetchImpl, calls } = recordingFetch([jsonResponse(envelope([totalRow(), dateRowWithBooks("2026-10-16", [bookRow("1", "A")])]))]);
    const events: UpstreamCallObservation[] = [];
    const report = await fetchNovelDailyReport({ token: TOKEN, ...RANGE, breakdown: "book", fetchImpl, onUpstreamObservation: (event) => events.push(event) });
    expect(report.requestCount).toBe(1);
    expect(calls[0]!.url).toBe(NOVEL_REVENUE_ENDPOINT);
    expect(calls[0]!.body.dimensions).toEqual(["1", "8"]);
    expect(calls[0]!.body.projectType).toBe(1);
    expect(events.map((event) => event.endpoint)).toEqual(["getreport"]);
  });
});

describe("fetchNovelCountryReport", () => {
  it("POST 到 GetCountryReport，Bearer 是传入 token，观测名 getcountryreport，返回 data 原样", async () => {
    const data = countryData([["巴西(BR)", 3], ["俄罗斯(RU)", 2]]);
    const { fetchImpl, calls } = recordingFetch([jsonResponse({ status: true, code: 200, message: "ok", data })]);
    const events: UpstreamCallObservation[] = [];
    const waits: Array<string | undefined> = [];
    const report = await fetchNovelCountryReport({
      token: TOKEN,
      date: "2026-10-16",
      reportType: "new_users",
      fetchImpl,
      onUpstreamObservation: (event) => events.push(event),
      rateGate: { wait: vi.fn(async (endpoint?: string) => { waits.push(endpoint); }) },
    });
    expect(report).toEqual({ date: "2026-10-16", reportType: "new_users", data, requestCount: 1 });
    expect(calls[0]!.url).toBe(NOVEL_REVENUE_COUNTRY_ENDPOINT);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.body).toMatchObject({ countryReportType: 1, projectType: 1, list: [{ dimension: 1, dimensionValue: "2026-10-16" }] });
    expect(waits).toEqual(["getcountryreport"]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ endpoint: "getcountryreport", httpStatus: 200, outcome: "ok" });
    expect(JSON.stringify(events)).not.toContain(TOKEN);
  });

  it("HTTP 429 → upstream_rate_limited，requestCount=1；业务失败 / data.list 缺失 → upstream_envelope_error；错误里没有 token", async () => {
    const limited = recordingFetch([new Response("", { status: 429 })]);
    const error = await fetchNovelCountryReport({ token: TOKEN, date: "2026-10-16", reportType: "active_users", fetchImpl: limited.fetchImpl }).catch((caught: unknown) => caught);
    expect(limited.calls[0]!.body.countryReportType).toBe(0);
    expect(error).toBeInstanceOf(NovelRevenueAdapterError);
    expect(error).toMatchObject({ code: "upstream_rate_limited", status: 429, requestCount: 1 });

    for (const body of [
      { status: false, code: 401, message: `token ${TOKEN} expired` },
      { status: true, code: 200, data: { total: 1 } },
      { status: true, code: 200, data: null },
    ]) {
      const { fetchImpl } = recordingFetch([jsonResponse(body)]);
      const caught = await fetchNovelCountryReport({ token: TOKEN, date: "2026-10-16", reportType: "new_users", fetchImpl }).catch((value: unknown) => value);
      expect(caught).toMatchObject({ code: "upstream_envelope_error", requestCount: 1 });
      expect(String((caught as Error).message)).not.toContain(TOKEN);
    }
  });

  it("没有 token / 日期不合法 → invalid_request，零请求", async () => {
    const { fetchImpl, calls } = recordingFetch([jsonResponse(envelope([]))]);
    await expect(fetchNovelCountryReport({ token: " ", date: "2026-10-16", reportType: "new_users", fetchImpl })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(fetchNovelCountryReport({ token: TOKEN, date: "20261016", reportType: "new_users", fetchImpl })).rejects.toMatchObject({ code: "invalid_request" });
    expect(calls).toHaveLength(0);
  });
});

describe("parseNovelBookReportRows：书行在日期行的 subItems 里", () => {
  it("取出总计行、日期行与书行；书名原文、seriesKey / seriesId、数值都按按日口径解析", () => {
    const parsed = parseNovelBookReportRows([
      totalRow({ dimension: 0, realIncome: "2.63" }),
      dateRowWithBooks("2026-10-16", [
        bookRow("25710418", "Жена генерального директора", { realDevNum: 4, newRealDevNum: 2, realDevNumRate: "50%", realIncome: "1.2345" }),
        bookRow("20125409", "O Retorno Genial da Esposa Rejeitada", { realIncome: "0" }),
      ], { realIncome: "1.2345", newRealDevNum: 3 }),
      dateRowWithBooks("2026-10-15", []),
      dateRowWithBooks("2026-10-14", null as never),
    ]);
    expect(parsed.total).toMatchObject({ dimensionKey: "总计", shareIncomeUsd: "2.63" });
    expect(parsed.dates.map((day) => day.date)).toEqual(["2026-10-16", "2026-10-15", "2026-10-14"]);
    expect(parsed.books).toEqual([
      {
        date: "2026-10-16", seriesKey: "1_25710418", seriesId: "25710418", bookName: "Жена генерального директора",
        activeUsers: 4, newUsers: 2, newUserRatio: "0.5", shareIncomeUsd: "1.2345",
      },
      {
        date: "2026-10-16", seriesKey: "1_20125409", seriesId: "20125409", bookName: "O Retorno Genial da Esposa Rejeitada",
        activeUsers: 1, newUsers: 1, newUserRatio: "1", shareIncomeUsd: "0",
      },
    ]);
    expect(parsed).toMatchObject({ totalRowCount: 1, droppedRowCount: 0, droppedBookRowCount: 0, duplicateBookRowCount: 0 });
  });

  it("丢弃：非网文前缀（2_ 短剧）、维度不是 8、形状不对、非对象；同日同书重复只留第一行", () => {
    const parsed = parseNovelBookReportRows([
      dateRowWithBooks("2026-10-16", [
        bookRow("1", "keep"),
        { ...bookRow("2", "drama"), dimensionValue: "2_2" },
        { ...bookRow("3", "promo code dimension"), dimension: 7 },
        { ...bookRow("4", "bad"), dimensionValue: "1_abc" },
        "not-an-object",
        bookRow("1", "keep again"),
      ]),
      { dimensionKey: "not-a-date", dimensionValue: "not-a-date", subItems: [bookRow("9", "orphan")] },
    ]);
    expect(parsed.books.map((book) => book.bookName)).toEqual(["keep"]);
    expect(parsed).toMatchObject({ droppedBookRowCount: 4, duplicateBookRowCount: 1, droppedRowCount: 1 });
  });

  it("日期行的原始存档保留 subItems（逐层遮蔽 token / 口令类键），按日解析器不受影响", () => {
    const parsed = parseNovelBookReportRows([
      dateRowWithBooks("2026-10-16", [{ ...bookRow("1", "A"), kocCode: "123456", nested: { token: "secret" } }]),
    ]);
    const raw = parsed.dates[0]!.raw as { subItems: Array<Record<string, unknown>> };
    expect(raw.subItems).toHaveLength(1);
    expect(raw.subItems[0]!.kocCode).toBe("[redacted]");
    expect(raw.subItems[0]!.nested).toEqual({ token: "[redacted]" });
    expect(JSON.stringify(parsed)).not.toContain("123456");
  });

  it("reconcileBookBreakdown：只比有书行的日期，新用户必须相等、收入差 ≤ 0.01", () => {
    const dates = [detailRow("2026-10-16"), detailRow("2026-10-15"), detailRow("2026-10-14")].map((row) => ({
      date: row.dimensionValue, newUsers: 2, shareIncomeUsd: "1.00",
    }));
    const books = [
      { date: "2026-10-16", newUsers: 1, shareIncomeUsd: "0.50" },
      { date: "2026-10-16", newUsers: 1, shareIncomeUsd: "0.505" },
      { date: "2026-10-15", newUsers: 1, shareIncomeUsd: "1.00" },
      { date: "2026-10-14", newUsers: 2, shareIncomeUsd: "0.90" },
    ];
    expect(reconcileBookBreakdown(dates, books)).toEqual(["2026-10-14", "2026-10-15"]);
  });
});

describe("parseNovelCountryReport", () => {
  it("“中文国名(ISO 二字码)” 拆出国家码；拆不出时 code=null；同名合并；坏行丢弃；total 照抄", () => {
    const parsed = parseNovelCountryReport("2026-10-16", {
      total: 9,
      list: [
        { name: "巴西(BR)", value: 3 },
        { name: "俄罗斯 ( ru )", value: 2 },
        { name: "未知", value: 1 },
        { name: "巴西(BR)", value: 1 },
        { name: "", value: 1 },
        { name: "葡萄牙(PT)", value: -1 },
        { name: "哥伦比亚(CO)", value: "x" },
        null,
      ],
    });
    expect(parsed.countries).toEqual([
      { label: "巴西(BR)", code: "BR", name: "巴西", users: 4 },
      { label: "俄罗斯 ( ru )", code: "RU", name: "俄罗斯", users: 2 },
      { label: "未知", code: null, name: "未知", users: 1 },
    ]);
    expect(parsed).toMatchObject({ date: "2026-10-16", total: 9, countrySum: 7, droppedRowCount: 4, duplicateRowCount: 1 });
  });

  it("空列表 / 缺 total 也是合法结果", () => {
    expect(parseNovelCountryReport("2026-10-16", { list: [] })).toMatchObject({ total: null, countries: [], countrySum: 0 });
  });
});

describe("decideRevenueBookMatch（seriesId → 本站来源条目）", () => {
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const MOBO = "11111111-1111-4111-8111-111111111111";
  const PLOT = "22222222-2222-4222-8222-222222222222";

  it("没有候选 → unmatched；唯一候选 → matched（连同剧场）", () => {
    expect(decideRevenueBookMatch([])).toEqual({ status: "unmatched", novelSourceItemId: null, channelAppId: null });
    expect(decideRevenueBookMatch([{ id: A, channelAppId: PLOT, deleted: false }])).toEqual({
      status: "matched", novelSourceItemId: A, channelAppId: PLOT,
    });
  });

  it("优先未删除的候选：一活一删 → matched 到活的；全都删了才退回看已删除的", () => {
    expect(decideRevenueBookMatch([{ id: A, channelAppId: MOBO, deleted: true }, { id: B, channelAppId: PLOT, deleted: false }])).toEqual({
      status: "matched", novelSourceItemId: B, channelAppId: PLOT,
    });
    expect(decideRevenueBookMatch([{ id: A, channelAppId: MOBO, deleted: true }])).toEqual({
      status: "matched", novelSourceItemId: A, channelAppId: MOBO,
    });
  });

  it("多个候选 → ambiguous，不替运营挑；同属一个剧场时仍记剧场，跨剧场则不记", () => {
    expect(decideRevenueBookMatch([{ id: A, channelAppId: MOBO, deleted: false }, { id: B, channelAppId: MOBO, deleted: false }])).toEqual({
      status: "ambiguous", novelSourceItemId: null, channelAppId: MOBO,
    });
    expect(decideRevenueBookMatch([{ id: A, channelAppId: MOBO, deleted: false }, { id: B, channelAppId: PLOT, deleted: false }])).toEqual({
      status: "ambiguous", novelSourceItemId: null, channelAppId: null,
    });
  });
});
