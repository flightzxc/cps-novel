import { describe, expect, it } from "vitest";

import {
  isTruthyTotalRow,
  isValidCalendarDate,
  parseNovelReportRows,
  parseRatioFraction,
  reconcileNovelRevenue,
  toAmountString,
  toIntegerOrNull,
} from "@/lib/adapters/moboreader-revenue-parser";

import { detailRow, totalRow } from "./support";

describe("总计行与明细行（变异目标②：总计行不得进明细、不得被重复计数）", () => {
  it("总计行单独返回，不进 detail：实测形态（09-26 一行 + 总计行）", () => {
    const parsed = parseNovelReportRows([
      detailRow("2026-09-26", { realDevNum: 1, newRealDevNum: 1, realDevNumRate: "100%", realIncome: 0 }),
      totalRow({ realDevNum: 1, newRealDevNum: 1, realIncome: 0 }),
    ]);

    expect(parsed.detail.map((day) => day.date)).toEqual(["2026-09-26"]);
    expect(parsed.total).not.toBeNull();
    expect(parsed.total?.dimensionKey).toBe("总计");
    expect(parsed.totalRowCount).toBe(1);
    expect(parsed.droppedRowCount).toBe(0);
  });

  it("总计行不被重复计数：明细合计只含按日明细行，激活 / 新用户 / 收入都不含总计行", () => {
    const parsed = parseNovelReportRows([
      detailRow("2026-10-01", { realDevNum: 10, newRealDevNum: 3, realIncome: "5.50" }),
      detailRow("2026-10-02", { realDevNum: 20, newRealDevNum: 4, realIncome: "4.50" }),
      totalRow({ realDevNum: 30, newRealDevNum: 7, realIncome: "10.00" }),
    ]);

    expect(parsed.detail).toHaveLength(2);
    expect(parsed.detail.map((day) => day.shareIncomeUsd)).toEqual(["5.5", "4.5"]);
    expect(parsed.detail.reduce((sum, day) => sum + (day.newUsers ?? 0), 0)).toBe(7);
    expect(parsed.total?.shareIncomeUsd).toBe("10");
    // 对账只在「明细合计 vs 总计行」之间发生，总计行自己不会被加进合计里变成 20。
    expect(reconcileNovelRevenue(parsed.detail, parsed.total)).toMatchObject({ status: "matched", detailIncomeSum: "10" });
  });

  it.each([
    [1, true],
    [true, true],
    ["1", true],
    ["true", true],
    ["TRUE", true],
    [" 1 ", true],
    [0, false],
    [false, false],
    ["0", false],
    ["", false],
    [null, false],
    [undefined, false],
    ["yes", false],
  ])("isTotal=%j → 总计行? %s", (flag, expected) => {
    expect(isTruthyTotalRow(flag)).toBe(expected);
  });

  it("isTotal 取 true / '1' 的行同样被识别为总计行，不会混进明细", () => {
    const parsed = parseNovelReportRows([
      detailRow("2026-10-01"),
      { ...totalRow(), isTotal: true },
      { ...totalRow(), isTotal: "1" },
    ]);
    expect(parsed.detail).toHaveLength(1);
    expect(parsed.totalRowCount).toBe(2);
  });

  it("没有总计行 → total 为 null、totalRowCount 为 0", () => {
    const parsed = parseNovelReportRows([detailRow("2026-10-01")]);
    expect(parsed.total).toBeNull();
    expect(parsed.totalRowCount).toBe(0);
  });

  it("空列表是合法结果：detail 为空、不丢弃任何行", () => {
    expect(parseNovelReportRows([])).toEqual({
      detail: [],
      total: null,
      totalRowCount: 0,
      droppedRowCount: 0,
      duplicateDateCount: 0,
    });
  });
});

describe("字段口径：缺失 = null，'0' = 0", () => {
  it("字段整个缺失 → null；字符串 '0' 与数字 0 → 0", () => {
    const missing = parseNovelReportRows([{ dimensionValue: "2026-10-01" }]).detail[0]!;
    expect(missing).toMatchObject({
      activeUsers: null,
      newUsers: null,
      newUserRatio: null,
      shareIncomeUsd: null,
      distribIncomeUsd: null,
      profitUsd: null,
    });

    const zero = parseNovelReportRows([
      { dimensionValue: "2026-10-01", realDevNum: "0", newRealDevNum: 0, realDevNumRate: "0%", realIncome: "0", realDistribIncome: 0, realProfit: "0.00" },
    ]).detail[0]!;
    expect(zero).toMatchObject({
      activeUsers: 0,
      newUsers: 0,
      newUserRatio: "0",
      shareIncomeUsd: "0",
      distribIncomeUsd: "0",
      profitUsd: "0",
    });
  });

  it.each([
    ["28.27%", "0.2827"],
    [" 28.27% ", "0.2827"],
    ["100%", "1"],
    ["0%", "0"],
    [0.2827, "0.2827"],
    ["0.2827", "0.2827"],
    // 裸数字不隐含除以 100（与 CPS 一致）
    ["28.27", "28.27"],
    [28.27, "28.27"],
    ["12.5%", "0.125"],
  ])("比例 %j → %j", (input, expected) => {
    expect(parseRatioFraction(input)).toBe(expected);
  });

  it.each([[null], [undefined], [""], ["   "], ["abc"], ["%"], ["12abc%"], [Number.NaN], [Number.POSITIVE_INFINITY], [5000], ["500000%"], [{}], [true]])(
    "无法解析 / 越界的比例 %j → null（不抛、不落脏值）",
    (input) => {
      expect(parseRatioFraction(input)).toBeNull();
    },
  );

  it("金额一律十进制字符串：不经浮点，数字与字符串写法得到同一个值", () => {
    expect(toAmountString("28.88")).toBe("28.88");
    expect(toAmountString(28.88)).toBe("28.88");
    expect(toAmountString("0")).toBe("0");
    expect(toAmountString(0)).toBe("0");
    expect(toAmountString("  7.10 ")).toBe("7.1");
    expect(toAmountString("-3.5")).toBe("-3.5");
    expect(toAmountString("1e2")).toBe("100");
    expect(toAmountString("12345678901234.5678")).toBe("12345678901234.5678");
  });

  it.each([[null], [undefined], [""], ["abc"], ["0x10"], ["NaN"], ["Infinity"], ["1,234.50"], [Number.NaN], [{}], [[]], [true], ["100000000000000"]])(
    "无法解析 / 超出 numeric(18,4) 的金额 %j → null",
    (input) => {
      expect(toAmountString(input)).toBeNull();
    },
  );

  it("用户数取整，越界 / 非数字 → null", () => {
    expect(toIntegerOrNull("12")).toBe(12);
    expect(toIntegerOrNull(12.9)).toBe(12);
    expect(toIntegerOrNull("0")).toBe(0);
    expect(toIntegerOrNull(2_147_483_647)).toBe(2_147_483_647);
    expect(toIntegerOrNull(2_147_483_648)).toBeNull();
    expect(toIntegerOrNull("abc")).toBeNull();
    expect(toIntegerOrNull(null)).toBeNull();
    expect(toIntegerOrNull(undefined)).toBeNull();
    expect(toIntegerOrNull(true)).toBeNull();
  });
});

describe("日期：dimensionValue 回落 dimensionKey；坏日期丢弃并计数", () => {
  it("日期取 dimensionValue；dimensionValue 缺失时回落 dimensionKey", () => {
    const parsed = parseNovelReportRows([
      { dimensionKey: "2026-10-03", dimensionValue: "2026-10-02" },
      { dimensionKey: "2026-10-04" },
    ]);
    expect(parsed.detail.map((day) => day.date)).toEqual(["2026-10-02", "2026-10-04"]);
  });

  it.each([
    ["2026-9-1"],
    ["2026/09/01"],
    ["20260901"],
    ["2026-02-30"],
    ["2026-13-01"],
    ["总计"],
    ["2026-09-01 00:00:00"],
    [""],
  ])("日期 %j 不是真实存在的 YYYY-MM-DD → 丢弃并计数", (date) => {
    const parsed = parseNovelReportRows([
      detailRow("2026-10-01"),
      { dimensionKey: date, dimensionValue: date, realIncome: "9.99" },
    ]);
    expect(parsed.detail.map((day) => day.date)).toEqual(["2026-10-01"]);
    expect(parsed.droppedRowCount).toBe(1);
  });

  it("没有任何日期字段的行、以及不是对象的条目，都被丢弃并计数", () => {
    const parsed = parseNovelReportRows([{ realIncome: "1" }, null, 5, "x", ["2026-10-01"], detailRow("2026-10-01")]);
    expect(parsed.detail).toHaveLength(1);
    expect(parsed.droppedRowCount).toBe(5);
  });

  it("isValidCalendarDate：闰日与月末", () => {
    expect(isValidCalendarDate("2028-02-29")).toBe(true);
    expect(isValidCalendarDate("2026-02-29")).toBe(false);
    expect(isValidCalendarDate("2026-04-31")).toBe(false);
    expect(isValidCalendarDate("2026-12-31")).toBe(true);
  });

  it("同一日期出现多次：都留在 detail 里（让对账暴露不一致），并计入 duplicateDateCount", () => {
    const parsed = parseNovelReportRows([detailRow("2026-10-01"), detailRow("2026-10-01"), detailRow("2026-10-02")]);
    expect(parsed.detail).toHaveLength(3);
    expect(parsed.duplicateDateCount).toBe(1);
  });
});

describe("原始行原样存档", () => {
  it("约 49 个字段整行保留，不加工（含上游自己的比例字符串）", () => {
    const row: Record<string, unknown> = detailRow("2026-09-26", { realIncome: "28.88", realDevNumRate: "28.27%" });
    for (let index = 0; index < 40; index += 1) row[`extraField${index}`] = index % 2 === 0 ? `v${index}` : index;
    const parsed = parseNovelReportRows([row]);
    expect(parsed.detail[0]?.raw).toEqual(row);
    expect(parsed.detail[0]?.raw.realDevNumRate).toBe("28.27%");
    expect(Object.keys(parsed.detail[0]!.raw).length).toBeGreaterThanOrEqual(49);
  });

  it("token 类键被防御性遮蔽，其余原样", () => {
    const parsed = parseNovelReportRows([
      detailRow("2026-10-01", { token: "should-never-be-stored", Authorization: "Bearer abc", jwt: "x", note: "ok" }),
    ]);
    const raw = parsed.detail[0]!.raw;
    expect(raw.token).toBe("[redacted]");
    expect(raw.Authorization).toBe("[redacted]");
    expect(raw.jwt).toBe("[redacted]");
    expect(raw.note).toBe("ok");
    expect(JSON.stringify(raw)).not.toContain("should-never-be-stored");
  });

  it("过长的 dimensionKey / dimensionValue 被截到列宽，不会撞 varchar", () => {
    const parsed = parseNovelReportRows([{ ...totalRow(), dimensionKey: "k".repeat(200), dimensionValue: "v".repeat(300) }]);
    expect(parsed.total?.dimensionKey).toHaveLength(64);
    expect(parsed.total?.dimensionValue).toHaveLength(128);
  });
});

describe("对账 reconcileNovelRevenue", () => {
  const days = (...incomes: Array<string | null>) =>
    incomes.map((shareIncomeUsd) => ({ shareIncomeUsd }));

  it("一致 → matched；差恰好 0.01 仍 matched；超过 0.01 → mismatched", () => {
    expect(reconcileNovelRevenue(days("1.10", "2.20"), { shareIncomeUsd: "3.30" }).status).toBe("matched");
    expect(reconcileNovelRevenue(days("1.10", "2.20"), { shareIncomeUsd: "3.31" })).toMatchObject({
      status: "matched",
      difference: "0.01",
    });
    expect(reconcileNovelRevenue(days("1.10", "2.20"), { shareIncomeUsd: "3.32" })).toMatchObject({
      status: "mismatched",
      difference: "0.02",
    });
  });

  it("不走 JS 浮点：0.1 + 0.2 与 0.3 精确相等（浮点求和得 0.30000000000000004）", () => {
    const result = reconcileNovelRevenue(days("0.1", "0.2"), { shareIncomeUsd: "0.3" }, "0");
    expect(result).toMatchObject({ status: "matched", detailIncomeSum: "0.3", difference: "0" });
  });

  it("大额也精确：十几位整数 + 四位小数", () => {
    const result = reconcileNovelRevenue(days("12345678901234.5678", "0.0001"), { shareIncomeUsd: "12345678901234.5679" }, "0");
    expect(result.status).toBe("matched");
  });

  it("无总计行 → not_applicable（没有可对的东西）；总计行没有金额字段同理", () => {
    expect(reconcileNovelRevenue(days("1"), null)).toEqual({
      status: "not_applicable",
      detailIncomeSum: null,
      totalIncome: null,
      difference: null,
    });
    expect(reconcileNovelRevenue(days("1"), { shareIncomeUsd: null }).status).toBe("not_applicable");
  });

  it("空明细 + 总计行 0 → matched（合计 0）；空明细 + 总计行有收入 → mismatched", () => {
    expect(reconcileNovelRevenue([], { shareIncomeUsd: "0" }).status).toBe("matched");
    expect(reconcileNovelRevenue([], { shareIncomeUsd: "5" }).status).toBe("mismatched");
  });

  it("明细里缺金额字段的行按 0 计：总计行有而明细缺 → mismatched", () => {
    expect(reconcileNovelRevenue(days(null, "1"), { shareIncomeUsd: "3" }).status).toBe("mismatched");
    expect(reconcileNovelRevenue(days(null, "3"), { shareIncomeUsd: "3" }).status).toBe("matched");
  });

  it("被丢弃的坏日期行带着收入时，对账自然暴露为 mismatched", () => {
    const parsed = parseNovelReportRows([
      detailRow("2026-10-01", { realIncome: "1.00" }),
      detailRow("2026-13-40", { realIncome: "2.00" }),
      totalRow({ realIncome: "3.00" }),
    ]);
    expect(parsed.droppedRowCount).toBe(1);
    expect(reconcileNovelRevenue(parsed.detail, parsed.total).status).toBe("mismatched");
  });
});
