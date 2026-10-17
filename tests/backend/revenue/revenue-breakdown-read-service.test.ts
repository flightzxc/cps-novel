import { describe, expect, it } from "vitest";

import { buildCountrySection, countCoveredDays } from "@/server/revenue";
import { resolveBreakdownParams, revenueHref } from "@/app/(admin)/revenue/_lib/breakdown-params";

/**
 * v0.6.2 按书 / 国家读服务的纯函数部分（真实库上的查询与角色权限见
 * `tests/integration/revenue/revenue-dashboard-postgres.test.ts`）。
 */
describe("countCoveredDays：区间内被成功批次（该段 completed）覆盖的天数", () => {
  it("多个批次区间取并集，只数落在查询区间里的天", () => {
    expect(countCoveredDays("2026-10-01", "2026-10-10", [])).toBe(0);
    expect(countCoveredDays("2026-10-01", "2026-10-10", [
      { beginDate: "2026-09-25", endDate: "2026-10-03" },
      { beginDate: "2026-10-03", endDate: "2026-10-05" },
      { beginDate: "2026-10-09", endDate: "2026-10-20" },
    ])).toBe(3 + 2 + 2);
  });
});

describe("buildCountrySection：国家排行（新用户 + 日均激活）与「国家 × 日期」矩阵", () => {
  const rows = [
    { date: "2026-10-16", label: "巴西(BR)", code: "BR", newUsers: 3, activeUsers: 10 },
    { date: "2026-10-16", label: "俄罗斯(RU)", code: "RU", newUsers: 2, activeUsers: 4 },
    { date: "2026-10-16", label: "葡萄牙(PT)", code: "PT", newUsers: 1, activeUsers: 1 },
    { date: "2026-10-16", label: "哥伦比亚(CO)", code: "CO", newUsers: 1, activeUsers: 1 },
    { date: "2026-10-15", label: "巴西(BR)", code: "BR", newUsers: 1, activeUsers: 6 },
    { date: "2026-10-15", label: "未知", code: null, newUsers: 1, activeUsers: 1 },
    // 只有激活、没有新用户的国家 / 日子
    { date: "2026-10-14", label: "美国(US)", code: "US", newUsers: 0, activeUsers: 20 },
  ];
  const base = { coveredDays: 7, uncoveredDays: 0, activeCoveredDays: 7, activeUncoveredDays: 0 };

  it("排行按新用户倒序、再按激活合计、再按国名；占比是新用户 4 位小数串；日均激活 = 激活合计 ÷ 激活已同步天数", () => {
    const section = buildCountrySection({ rows, ...base });
    expect(section.newUsersTotal).toBe(9);
    expect(section.avgActiveUsersTotal).toBe("6.14"); // 43 / 7
    expect(section.ranking.map((row) => [row.label, row.newUsers, row.share, row.avgActiveUsers])).toEqual([
      ["巴西(BR)", 4, "0.4444", "2.29"],
      ["俄罗斯(RU)", 2, "0.2222", "0.57"],
      ["哥伦比亚(CO)", 1, "0.1111", "0.14"],
      ["未知", 1, "0.1111", "0.14"],
      ["葡萄牙(PT)", 1, "0.1111", "0.14"],
      ["美国(US)", 0, "0.0000", "2.86"],
    ]);
  });

  it("新用户矩阵：取新用户前 N 国做列，其余并为“其他”；只列新用户 > 0 的日期，日期倒序", () => {
    const section = buildCountrySection({ rows, ...base, columns: 2 });
    expect(section.metric).toBe("new");
    expect(section.matrix.columns).toEqual([{ label: "巴西(BR)", code: "BR" }, { label: "俄罗斯(RU)", code: "RU" }]);
    expect(section.matrix.hasOther).toBe(true);
    expect(section.matrix.rows).toEqual([
      { date: "2026-10-16", values: [3, 2], other: 2, total: 7 },
      { date: "2026-10-15", values: [1, 0], other: 1, total: 2 },
    ]);
  });

  it("激活矩阵：按激活排列国家（美国排第一），只列激活 > 0 的日期", () => {
    const section = buildCountrySection({ rows, ...base, metric: "active", columns: 2 });
    expect(section.matrix.columns).toEqual([{ label: "美国(US)", code: "US" }, { label: "巴西(BR)", code: "BR" }]);
    expect(section.matrix.rows).toEqual([
      { date: "2026-10-16", values: [0, 10], other: 6, total: 16 },
      { date: "2026-10-15", values: [0, 6], other: 1, total: 7 },
      { date: "2026-10-14", values: [20, 0], other: 0, total: 20 },
    ]);
  });

  it("激活没同步（存量批次写的行 activeUsers = null、激活覆盖 0 天）：日均激活为 null，不当 0；激活矩阵为空", () => {
    const legacy = rows.slice(0, 2).map((row) => ({ ...row, activeUsers: null }));
    const section = buildCountrySection({ rows: legacy, coveredDays: 7, uncoveredDays: 0, activeCoveredDays: 0, activeUncoveredDays: 7, metric: "active" });
    expect(section.avgActiveUsersTotal).toBeNull();
    expect(section.ranking.map((row) => row.avgActiveUsers)).toEqual([null, null]);
    expect(section.matrix).toEqual({ columns: [], hasOther: false, rows: [] });
    expect(section.newUsersTotal).toBe(5);
  });

  it("没有数据：排行与矩阵为空，占比不编数字", () => {
    const section = buildCountrySection({ rows: [], coveredDays: 0, uncoveredDays: 30, activeCoveredDays: 0, activeUncoveredDays: 30 });
    expect(section).toMatchObject({ newUsersTotal: 0, ranking: [], matrix: { columns: [], hasOther: false, rows: [] }, uncoveredDays: 30, avgActiveUsersTotal: null });
  });
});

describe("URL 状态（?theater / ?bookPage / ?book）", () => {
  it("重复参数与非法页码一律忽略，不猜", () => {
    expect(resolveBreakdownParams({})).toEqual({ theater: null, bookPage: null, book: null, countryMetric: null });
    expect(resolveBreakdownParams({ theater: ["a", "b"], bookPage: "0", book: " 1_123 " })).toEqual({ theater: null, bookPage: null, book: "1_123", countryMetric: null });
    expect(resolveBreakdownParams({ countryMetric: "active" }).countryMetric).toBe("active");
    expect(resolveBreakdownParams({ countryMetric: "revenue" }).countryMetric).toBeNull();
    expect(resolveBreakdownParams({ theater: "unmatched", bookPage: "3" })).toMatchObject({ theater: "unmatched", bookPage: 3 });
    expect(resolveBreakdownParams({ bookPage: "-1" }).bookPage).toBeNull();
    expect(resolveBreakdownParams({ bookPage: "2abc" }).bookPage).toBeNull();
  });

  it("revenueHref 始终带区间，第 1 页 / 空参数省略", () => {
    expect(revenueHref({ dateFrom: "2026-10-01", dateTo: "2026-10-07" })).toBe("/revenue?from=2026-10-01&to=2026-10-07");
    expect(revenueHref({ dateFrom: "2026-10-01", dateTo: "2026-10-07", theater: "unmatched", bookPage: 1, book: "1_9", hash: "x" }))
      .toBe("/revenue?from=2026-10-01&to=2026-10-07&theater=unmatched&book=1_9#x");
    expect(revenueHref({ dateFrom: "2026-10-01", dateTo: "2026-10-07", bookPage: 3 })).toBe("/revenue?from=2026-10-01&to=2026-10-07&bookPage=3");
    expect(revenueHref({ dateFrom: "2026-10-01", dateTo: "2026-10-07", countryMetric: "active" })).toBe("/revenue?from=2026-10-01&to=2026-10-07&countryMetric=active");
  });
});
