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

describe("buildCountrySection：国家排行与「国家 × 日期」矩阵", () => {
  const rows = [
    { date: "2026-10-16", label: "巴西(BR)", code: "BR", newUsers: 3 },
    { date: "2026-10-16", label: "俄罗斯(RU)", code: "RU", newUsers: 2 },
    { date: "2026-10-16", label: "葡萄牙(PT)", code: "PT", newUsers: 1 },
    { date: "2026-10-16", label: "哥伦比亚(CO)", code: "CO", newUsers: 1 },
    { date: "2026-10-15", label: "巴西(BR)", code: "BR", newUsers: 1 },
    { date: "2026-10-15", label: "未知", code: null, newUsers: 1 },
  ];

  it("排行按新用户倒序、同数按国名升序；占比是 4 位小数串；合计", () => {
    const section = buildCountrySection({ rows, coveredDays: 7, uncoveredDays: 0 });
    expect(section.newUsersTotal).toBe(9);
    expect(section.ranking.map((row) => [row.label, row.newUsers, row.share])).toEqual([
      ["巴西(BR)", 4, "0.4444"],
      ["俄罗斯(RU)", 2, "0.2222"],
      ["哥伦比亚(CO)", 1, "0.1111"],
      ["未知", 1, "0.1111"],
      ["葡萄牙(PT)", 1, "0.1111"],
    ]);
  });

  it("矩阵取前 N 个国家做列，其余并为“其他”；日期倒序；每行合计 = 当天全部国家之和", () => {
    const section = buildCountrySection({ rows, coveredDays: 7, uncoveredDays: 0, columns: 2 });
    expect(section.matrix.columns).toEqual([{ label: "巴西(BR)", code: "BR" }, { label: "俄罗斯(RU)", code: "RU" }]);
    expect(section.matrix.hasOther).toBe(true);
    expect(section.matrix.rows).toEqual([
      { date: "2026-10-16", values: [3, 2], other: 2, total: 7 },
      { date: "2026-10-15", values: [1, 0], other: 1, total: 2 },
    ]);
  });

  it("没有数据：排行与矩阵为空，占比不编数字", () => {
    const section = buildCountrySection({ rows: [], coveredDays: 0, uncoveredDays: 30 });
    expect(section).toMatchObject({ newUsersTotal: 0, ranking: [], matrix: { columns: [], hasOther: false, rows: [] }, uncoveredDays: 30 });
  });
});

describe("URL 状态（?theater / ?bookPage / ?book）", () => {
  it("重复参数与非法页码一律忽略，不猜", () => {
    expect(resolveBreakdownParams({})).toEqual({ theater: null, bookPage: null, book: null });
    expect(resolveBreakdownParams({ theater: ["a", "b"], bookPage: "0", book: " 1_123 " })).toEqual({ theater: null, bookPage: null, book: "1_123" });
    expect(resolveBreakdownParams({ theater: "unmatched", bookPage: "3" })).toMatchObject({ theater: "unmatched", bookPage: 3 });
    expect(resolveBreakdownParams({ bookPage: "-1" }).bookPage).toBeNull();
    expect(resolveBreakdownParams({ bookPage: "2abc" }).bookPage).toBeNull();
  });

  it("revenueHref 始终带区间，第 1 页 / 空参数省略", () => {
    expect(revenueHref({ dateFrom: "2026-10-01", dateTo: "2026-10-07" })).toBe("/revenue?from=2026-10-01&to=2026-10-07");
    expect(revenueHref({ dateFrom: "2026-10-01", dateTo: "2026-10-07", theater: "unmatched", bookPage: 1, book: "1_9", hash: "x" }))
      .toBe("/revenue?from=2026-10-01&to=2026-10-07&theater=unmatched&book=1_9#x");
    expect(revenueHref({ dateFrom: "2026-10-01", dateTo: "2026-10-07", bookPage: 3 })).toBe("/revenue?from=2026-10-01&to=2026-10-07&bookPage=3");
  });
});
