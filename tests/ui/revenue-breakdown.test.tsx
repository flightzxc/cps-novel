import "./setup-cleanup";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BookTable } from "@/app/(admin)/revenue/_components/book-table";
import { CountrySection } from "@/app/(admin)/revenue/_components/country-section";
import type { RevenueBookSection, RevenueBookSummaryRow, RevenueCountrySection } from "@/server/revenue";

/**
 * v0.6.2 `/revenue` 按书统计与新增用户国家分布两个区块（server component，直接渲染）。
 * 数值格式化、文案、链接全部是真的；读服务数据用手写视图。
 *
 * 变异目标：
 *   ⑥ 按书区块“未覆盖天数”提示的条件分支去掉 → "存量批次不当 0" 用例必须变红；
 *   ⑦ 未匹配的书不显示上游书名（只显示本站书名）→ "未匹配保留上游书名" 用例必须变红。
 */
const RANGE = { dateFrom: "2026-10-10", dateTo: "2026-10-16" };
const MOBO = "11111111-1111-4111-8111-111111111111";
const PLOT = "22222222-2222-4222-8222-222222222222";
const NOVEL = "33333333-3333-4333-8333-333333333333";

function bookRow(overrides: Partial<RevenueBookSummaryRow> = {}): RevenueBookSummaryRow {
  return {
    seriesKey: "1_20125409",
    upstreamBookName: "O Retorno Genial da Esposa Rejeitada",
    matchStatus: "matched",
    theater: { id: MOBO, label: "MoboReader" },
    novel: { id: NOVEL, title: "O Retorno Genial", locale: "pt" },
    newUsersTotal: 1234,
    shareIncomeUsdTotal: "2.6350",
    dayCount: 5,
    ...overrides,
  };
}

function books(overrides: Partial<RevenueBookSection> = {}): RevenueBookSection {
  return {
    coveredDays: 7,
    uncoveredDays: 0,
    theaters: [
      { id: MOBO, label: "MoboReader", active: true },
      { id: PLOT, label: "PlotNovel", active: true },
    ],
    filter: null,
    filterNotice: null,
    page: 1,
    pageSize: 50,
    pageCount: 1,
    bookCount: 2,
    newUsersTotal: 1236,
    shareIncomeUsdTotal: "2.6350",
    rows: [
      bookRow(),
      bookRow({
        seriesKey: "1_25710418",
        upstreamBookName: "Жена генерального директора",
        matchStatus: "unmatched",
        theater: null,
        novel: null,
        newUsersTotal: 2,
        shareIncomeUsdTotal: "0.0000",
        dayCount: 1,
      }),
    ],
    detail: null,
    ...overrides,
  };
}

describe("按书统计", () => {
  it("区间汇总表：排名、上游书名 + 本站书链接、剧场、新用户、分成收入（两位小数 + 千分位）、天数、按日链接保留区间与筛选", () => {
    render(<BookTable section={books({ filter: MOBO })} range={RANGE} />);
    const row = screen.getByTestId("revenue-book-1_20125409");
    expect(row.getAttribute("data-match")).toBe("matched");
    expect(row.textContent).toContain("O Retorno Genial da Esposa Rejeitada");
    expect(row.textContent).toContain("MoboReader");
    expect(row.textContent).toContain("1,234");
    expect(row.textContent).toContain("2.64");
    expect(within(row).getByRole("link", { name: /本站：O Retorno Genial/ }).getAttribute("href")).toBe(`/novels/${NOVEL}`);
    expect(within(row).getByRole("link", { name: "按日" }).getAttribute("href")).toBe(
      `/revenue?from=2026-10-10&to=2026-10-16&theater=${MOBO}&book=1_20125409#revenue-book-detail`,
    );
    expect(screen.getByTestId("revenue-book-totals").textContent).toBe("2 本书有数据 · 新用户 1,236 · 分成收入 US$2.64");
  });

  it("未匹配保留上游书名、标“未匹配”，没有本站链接；多本匹配标“多本匹配”", () => {
    render(
      <BookTable
        section={books({ rows: [...books().rows, bookRow({ seriesKey: "1_5", upstreamBookName: "Twin", matchStatus: "ambiguous", novel: null })] })}
        range={RANGE}
      />,
    );
    const unmatched = screen.getByTestId("revenue-book-1_25710418");
    expect(within(unmatched).getByTestId("revenue-book-upstream-name").textContent).toBe("Жена генерального директора");
    expect(unmatched.textContent).toContain("未匹配");
    expect(within(unmatched).queryByRole("link", { name: /本站/ })).toBeNull();
    expect(screen.getByTestId("revenue-book-1_5").textContent).toContain("多本匹配");
  });

  it("剧场筛选：全部 / 各剧场 / 未匹配，都是带区间的普通链接，当前项高亮", () => {
    render(<BookTable section={books({ filter: "unmatched" })} range={RANGE} />);
    const chips = within(screen.getByTestId("revenue-book-filter")).getAllByRole("link");
    expect(chips.map((chip) => [chip.textContent, chip.getAttribute("href"), chip.getAttribute("aria-current")])).toEqual([
      ["全部剧场", "/revenue?from=2026-10-10&to=2026-10-16", null],
      ["MoboReader", `/revenue?from=2026-10-10&to=2026-10-16&theater=${MOBO}`, null],
      ["PlotNovel", `/revenue?from=2026-10-10&to=2026-10-16&theater=${PLOT}`, null],
      ["未匹配", "/revenue?from=2026-10-10&to=2026-10-16&theater=unmatched", "true"],
    ]);
  });

  it("存量批次不当 0：区间内有没被“按书已同步”批次覆盖的天，就明确提示重新同步", () => {
    render(<BookTable section={books({ coveredDays: 4, uncoveredDays: 3 })} range={RANGE} />);
    expect(screen.getByTestId("revenue-book-uncovered").textContent).toContain("有 3 天还没有按书数据");
  });

  it("全部覆盖时不出提示；完全没有数据时空行文案区分“还没同步”和“筛选后为空”", () => {
    const { unmount } = render(<BookTable section={books({ rows: [], bookCount: 0 })} range={RANGE} />);
    expect(screen.queryByTestId("revenue-book-uncovered")).toBeNull();
    expect(screen.getByText("所选区间、所选剧场没有按书数据。")).toBeTruthy();
    unmount();
    render(<BookTable section={books({ rows: [], bookCount: 0, coveredDays: 0, uncoveredDays: 7 })} range={RANGE} />);
    expect(screen.getByText("所选区间还没有按书数据，请先发起同步。")).toBeTruthy();
  });

  it("翻页：第 2 / 3 页时上一页、下一页都在，排名从 51 开始", () => {
    render(<BookTable section={books({ page: 2, pageCount: 3 })} range={RANGE} />);
    const pagination = screen.getByTestId("revenue-book-pagination");
    expect(within(pagination).getByRole("link", { name: "上一页" }).getAttribute("href")).toBe("/revenue?from=2026-10-10&to=2026-10-16#revenue-books");
    expect(within(pagination).getByRole("link", { name: "下一页" }).getAttribute("href")).toBe("/revenue?from=2026-10-10&to=2026-10-16&bookPage=3#revenue-books");
    expect(screen.getByTestId("revenue-book-1_20125409").textContent).toMatch(/^51/);
  });

  it("单书按日明细：日期倒序，激活 / 新用户 / 比例 / 收入逐日；缺失显示 —", () => {
    render(
      <BookTable
        section={books({
          detail: {
            book: bookRow(),
            days: [
              { date: "2026-10-16", activeUsers: 4, newUsers: 2, newUserRatio: "0.5", shareIncomeUsd: "1.2345" },
              { date: "2026-10-14", activeUsers: null, newUsers: 0, newUserRatio: null, shareIncomeUsd: null },
            ],
          },
        })}
        range={RANGE}
      />,
    );
    const detail = screen.getByTestId("revenue-book-detail");
    expect(detail.textContent).toContain("单书按日明细：O Retorno Genial da Esposa Rejeitada");
    expect(within(detail).getByTestId("revenue-book-day-2026-10-16").textContent).toBe("2026-10-164250.00%1.23");
    expect(within(detail).getByTestId("revenue-book-day-2026-10-14").textContent).toBe("2026-10-14—0——");
  });
});

describe("国家分布（新用户 + 激活）", () => {
  const LINKS = { dateFrom: "2026-10-10", dateTo: "2026-10-16", theater: "unmatched", bookPage: 2, book: null };

  function countries(overrides: Partial<RevenueCountrySection> = {}): RevenueCountrySection {
    return {
      coveredDays: 7,
      uncoveredDays: 0,
      activeCoveredDays: 7,
      activeUncoveredDays: 0,
      newUsersTotal: 9,
      avgActiveUsersTotal: "6.14",
      metric: "new",
      ranking: [
        { label: "巴西(BR)", code: "BR", newUsers: 4, share: "0.4444", avgActiveUsers: "2.29" },
        { label: "俄罗斯(RU)", code: "RU", newUsers: 2, share: "0.2222", avgActiveUsers: "0.57" },
        { label: "未知", code: null, newUsers: 3, share: "0.3333", avgActiveUsers: "0.14" },
      ],
      matrix: {
        columns: [{ label: "巴西(BR)", code: "BR" }, { label: "俄罗斯(RU)", code: "RU" }],
        hasOther: true,
        rows: [
          { date: "2026-10-16", values: [3, 2], other: 2, total: 7 },
          { date: "2026-10-15", values: [1, 0], other: 1, total: 2 },
        ],
      },
      ...overrides,
    };
  }

  it("排行：国家名原文、新用户、占比百分比、日均激活；拆不出国家码的标注出来；合计行带日均激活", () => {
    render(<CountrySection section={countries()} links={LINKS} />);
    expect(screen.getByTestId("revenue-country-BR").textContent).toBe("1巴西(BR)444.44%2.29");
    expect(screen.getByTestId("revenue-country-未知").textContent).toContain("未识别国家码");
    expect(screen.getByTestId("revenue-country-total").textContent).toBe("区间内新用户 9 · 日均激活 6.14 · 3 个国家 / 地区");
  });

  it("国家 × 日期：表头是国家码（悬停看全名），有“其他”与“合计”列；口径切换是带区间与按书筛选的普通链接", () => {
    render(<CountrySection section={countries()} links={LINKS} />);
    const matrix = screen.getByTestId("revenue-country-matrix");
    const headers = within(matrix).getAllByRole("columnheader").map((cell) => [cell.textContent, cell.getAttribute("title")]);
    expect(headers).toEqual([["日期", null], ["BR", "巴西(BR)"], ["RU", "俄罗斯(RU)"], ["其他", null], ["合计", null]]);
    expect(within(matrix).getByTestId("revenue-country-day-2026-10-16").textContent).toBe("2026-10-163227");
    const chips = within(screen.getByTestId("revenue-country-metric")).getAllByRole("link");
    expect(chips.map((chip) => [chip.textContent, chip.getAttribute("href"), chip.getAttribute("aria-current")])).toEqual([
      ["新用户", "/revenue?from=2026-10-10&to=2026-10-16&theater=unmatched&bookPage=2#revenue-countries", "true"],
      ["激活", "/revenue?from=2026-10-10&to=2026-10-16&theater=unmatched&bookPage=2&countryMetric=active#revenue-countries", null],
    ]);
  });

  it("激活未同步不当 0：激活一天都没同步时排行、合计、激活矩阵都写“激活未同步”", () => {
    render(
      <CountrySection
        section={countries({
          metric: "active",
          activeCoveredDays: 0,
          activeUncoveredDays: 7,
          avgActiveUsersTotal: null,
          ranking: countries().ranking.map((row) => ({ ...row, avgActiveUsers: null })),
          matrix: { columns: [], hasOther: false, rows: [] },
        })}
        links={LINKS}
      />,
    );
    expect(screen.getByTestId("revenue-country-total").textContent).toContain("日均激活 激活未同步");
    expect(screen.getByTestId("revenue-country-BR").textContent).toContain("激活未同步");
    expect(within(screen.getByTestId("revenue-country-matrix")).getByText("激活未同步")).toBeTruthy();
    expect(screen.getByTestId("revenue-country-active-uncovered").textContent).toContain("有 7 天还没有激活国家数据");
    expect(screen.queryByTestId("revenue-country-uncovered")).toBeNull();
  });

  // B-49（Owner 2026-10-18）：国家报表按国家去重、日报全局去重，各国合计可能略大于当日总数。只改文案，不改数字。
  it("口径说明：同一用户多国出现会在各国分别计数、各国合计可能略大于当日总数、占比以国家合计为分母（有数据和空数据都显示）", () => {
    const NOTE =
      "同一用户当天若在多个国家出现（如使用 VPN、跨境或换网），会在各国分别计数，因此各国合计可能略大于当日总数；国家占比以国家合计为分母。";
    const { unmount } = render(<CountrySection section={countries()} links={LINKS} />);
    expect(screen.getByTestId("revenue-country-dedup-note").textContent).toBe(NOTE);
    // 说明不碰数字：排行与合计照旧（占比 4/9 = 44.44%，分母是国家合计 9）。
    expect(screen.getByTestId("revenue-country-BR").textContent).toBe("1巴西(BR)444.44%2.29");
    expect(screen.getByTestId("revenue-country-total").textContent).toBe("区间内新用户 9 · 日均激活 6.14 · 3 个国家 / 地区");
    unmount();
    render(
      <CountrySection
        section={countries({ ranking: [], newUsersTotal: 0, avgActiveUsersTotal: null, matrix: { columns: [], hasOther: false, rows: [] } })}
        links={LINKS}
      />,
    );
    expect(screen.getByTestId("revenue-country-dedup-note").textContent).toBe(NOTE);
  });

  it("有未覆盖天时提示；没有数据时两张表都写“没有…国家数据”", () => {
    render(
      <CountrySection
        section={countries({
          ranking: [], newUsersTotal: 0, avgActiveUsersTotal: null, matrix: { columns: [], hasOther: false, rows: [] },
          coveredDays: 0, uncoveredDays: 7, activeCoveredDays: 0, activeUncoveredDays: 7,
        })}
        links={LINKS}
      />,
    );
    expect(screen.getByTestId("revenue-country-uncovered").textContent).toContain("有 7 天还没有国家数据");
    // 新用户 / 激活同样 7 天未覆盖时只提示一次，不重复。
    expect(screen.queryByTestId("revenue-country-active-uncovered")).toBeNull();
    expect(screen.getByText("所选区间没有国家数据")).toBeTruthy();
    expect(screen.getByText("所选区间没有新用户国家数据")).toBeTruthy();
  });
});
