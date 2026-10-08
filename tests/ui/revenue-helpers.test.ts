import { describe, expect, it } from "vitest";

import { isStalePendingTask, shortTaskId } from "@/app/(admin)/revenue/_lib/active-task";
import {
  REVENUE_WORKER_CLAIM_WARN_MS,
  batchStatusView,
  enqueueFailureCopy,
  reconciliationView,
} from "@/app/(admin)/revenue/_lib/copy";
import {
  REVENUE_MAX_SPAN_DAYS,
  addDays,
  checkRangeShape,
  checkSyncRange,
  inclusiveSpanDays,
  isCalendarDate,
  trailingRange,
} from "@/app/(admin)/revenue/_lib/dates";
import {
  PLACEHOLDER,
  formatAverage,
  formatCount,
  formatRatioPercent,
  formatUsd,
  truncate,
} from "@/app/(admin)/revenue/_lib/format";
import { resolveRevenueRange } from "@/app/(admin)/revenue/_lib/range";
import { REVENUE_SYNC_MAX_SPAN_DAYS, assertValidRevenueSyncRange } from "@/lib/tasks/revenue-sync";

/**
 * `/revenue` 页面层纯函数：数值展示（不经过浮点）、日期校验（与后端同口径）、区间解析回落、
 * "排队过久未被认领"的判定边界。
 */

describe("formatUsd · 金额两位小数，只在字符串 / BigInt 上取整", () => {
  it("四位小数的十进制串四舍五入到两位（远离零）", () => {
    expect(formatUsd("28.8800")).toBe("28.88");
    expect(formatUsd("28.8750")).toBe("28.88");
    expect(formatUsd("28.8749")).toBe("28.87");
    expect(formatUsd("0.0050")).toBe("0.01");
    expect(formatUsd("0.0049")).toBe("0.00");
    expect(formatUsd("0.0000")).toBe("0.00");
  });

  it("千分位分组；整数、一位小数、负数也能处理", () => {
    expect(formatUsd("1234567.8900")).toBe("1,234,567.89");
    expect(formatUsd("12")).toBe("12.00");
    expect(formatUsd("3.5")).toBe("3.50");
    expect(formatUsd("-1234.5678")).toBe("-1,234.57");
    expect(formatUsd("-0.0001")).toBe("0.00");
  });

  it("超出 JS 浮点精度的值也不丢位：BigInt 路径，不是 parseFloat", () => {
    // 2^53 + 1 在浮点里表示不出来；字符串 / BigInt 路径必须原样保留。
    expect(formatUsd("9007199254740993.1250")).toBe("9,007,199,254,740,993.13");
    expect(formatUsd("0.1000")).toBe("0.10");
    expect(formatUsd("1.0049999999999999999")).toBe("1.00");
  });

  it("null / 非十进制串 → 占位，绝不显示成 0.00", () => {
    expect(formatUsd(null)).toBe(PLACEHOLDER);
    expect(formatUsd(undefined)).toBe(PLACEHOLDER);
    expect(formatUsd("abc")).toBe(PLACEHOLDER);
    expect(formatUsd("1e3")).toBe(PLACEHOLDER);
    expect(formatUsd("")).toBe(PLACEHOLDER);
  });
});

describe("formatRatioPercent · 小数 → 百分比两位小数", () => {
  it("0.2827 → 28.27%", () => {
    expect(formatRatioPercent("0.2827")).toBe("28.27%");
    expect(formatRatioPercent("0.282700")).toBe("28.27%");
    expect(formatRatioPercent("0.28275")).toBe("28.28%");
    expect(formatRatioPercent("1")).toBe("100.00%");
    expect(formatRatioPercent("0")).toBe("0.00%");
    expect(formatRatioPercent("0.000049")).toBe("0.00%");
  });

  it("null → 占位", () => {
    expect(formatRatioPercent(null)).toBe(PLACEHOLDER);
    expect(formatRatioPercent("x")).toBe(PLACEHOLDER);
  });
});

describe("formatCount / formatAverage", () => {
  it("计数补千分位，null → 占位，0 就是 0", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(12345)).toBe("12,345");
    expect(formatCount(null)).toBe(PLACEHOLDER);
    expect(formatCount(undefined)).toBe(PLACEHOLDER);
  });

  it("日均保留两位并补千分位；null → 占位", () => {
    expect(formatAverage("1234.50")).toBe("1,234.50");
    expect(formatAverage("0.00")).toBe("0.00");
    expect(formatAverage(null)).toBe(PLACEHOLDER);
  });

  it("truncate 超长才截断", () => {
    expect(truncate("abc", 5)).toBe("abc");
    expect(truncate("abcdef", 5)).toBe("abcde…");
  });
});

describe("日期工具", () => {
  it("isCalendarDate 拒绝不存在的日期与错误形状", () => {
    expect(isCalendarDate("2026-10-08")).toBe(true);
    expect(isCalendarDate("2024-02-29")).toBe(true);
    expect(isCalendarDate("2026-02-29")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("2026-1-1")).toBe(false);
    expect(isCalendarDate("20261008")).toBe(false);
    expect(isCalendarDate("")).toBe(false);
    expect(isCalendarDate(undefined)).toBe(false);
    expect(isCalendarDate(20261008)).toBe(false);
  });

  it("addDays / inclusiveSpanDays 跨月跨年", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-10-08", -6)).toBe("2026-10-02");
    expect(inclusiveSpanDays("2026-10-02", "2026-10-08")).toBe(7);
    expect(inclusiveSpanDays("2026-10-08", "2026-10-08")).toBe(1);
    expect(trailingRange("2026-10-08", 7)).toEqual({ dateFrom: "2026-10-02", dateTo: "2026-10-08" });
    expect(trailingRange("2026-10-08", 30)).toEqual({ dateFrom: "2026-09-09", dateTo: "2026-10-08" });
  });

  it("单一真源：跨度上限与后端一致", () => {
    expect(REVENUE_MAX_SPAN_DAYS).toBe(REVENUE_SYNC_MAX_SPAN_DAYS);
  });
});

describe("页面日期校验与后端入队校验逐项对拍（后端规则变了这里必须跟着变）", () => {
  const TODAY = "2026-10-08";
  // 后端的"今天"取上海时区：这里给一个上海时区恰为 TODAY 的时刻。
  const NOW = new Date("2026-10-08T06:00:00.000Z");

  const CASES: ReadonlyArray<readonly [string, string]> = [
    ["2026-10-02", "2026-10-08"], // 正常 7 天
    ["2026-10-08", "2026-10-08"], // 单日
    ["2026-10-09", "2026-10-09"], // 明天：未来
    ["2026-10-02", "2026-10-09"], // 结束日在未来
    ["2026-10-08", "2026-10-02"], // 反向
    ["2026-02-30", "2026-03-01"], // 不存在的日期
    ["2026-1-1", "2026-10-08"], // 形状不对
    ["", ""], // 空
    ["2026-07-09", "2026-10-08"], // 恰好 92 天
    ["2026-07-08", "2026-10-08"], // 93 天
    ["2026-01-01", "2026-10-08"], // 远超
  ];

  it.each(CASES)("同步区间 %s ~ %s", (begin, end) => {
    let backendOk = true;
    try {
      assertValidRevenueSyncRange(begin, end, NOW);
    } catch {
      backendOk = false;
    }
    expect(checkSyncRange(begin, end, TODAY).ok).toBe(backendOk);
  });

  it.each(CASES)("读取区间形状 %s ~ %s（后端读服务不看未来，用远未来的 now 排除该条）", (begin, end) => {
    let backendOk = true;
    try {
      assertValidRevenueSyncRange(begin, end, new Date("2099-01-01T00:00:00.000Z"));
    } catch {
      backendOk = false;
    }
    expect(checkRangeShape(begin, end).ok).toBe(backendOk);
  });

  it("恰好 92 天可以、93 天不行", () => {
    expect(checkRangeShape("2026-07-09", "2026-10-08")).toEqual({ ok: true });
    expect(checkRangeShape("2026-07-08", "2026-10-08")).toEqual({ ok: false, problem: "span" });
  });
});

describe("resolveRevenueRange · 非法区间回落默认并给出原因", () => {
  const TODAY = "2026-10-08";
  const FALLBACK = { dateFrom: "2026-09-09", dateTo: "2026-10-08" };

  it("两个参数都没给 → 默认区间，不提示", () => {
    expect(resolveRevenueRange({}, TODAY, FALLBACK)).toEqual({ ...FALLBACK, fallbackNotice: null });
    expect(resolveRevenueRange({ from: "", to: "  " }, TODAY, FALLBACK).fallbackNotice).toBeNull();
  });

  it("合法区间原样使用", () => {
    expect(resolveRevenueRange({ from: "2026-10-01", to: "2026-10-07" }, TODAY, FALLBACK)).toEqual({
      dateFrom: "2026-10-01",
      dateTo: "2026-10-07",
      fallbackNotice: null,
    });
  });

  it.each([
    ["缺一端", { from: "2026-10-01" }, "同时给出"],
    ["格式不对", { from: "2026-1-1", to: "2026-10-07" }, "格式"],
    ["不存在的日期", { from: "2026-02-30", to: "2026-03-05" }, "格式"],
    ["反向", { from: "2026-10-07", to: "2026-10-01" }, "不能晚于结束日期"],
    ["跨度 93 天", { from: "2026-07-08", to: "2026-10-08" }, "92"],
    ["结束日期晚于今天", { from: "2026-10-01", to: "2026-10-09" }, "今天"],
    ["重复参数（数组）", { from: ["2026-10-01", "2026-10-02"], to: "2026-10-07" }, "格式"],
  ] as const)("%s → 回落默认并说明原因", (_label, params, expectedFragment) => {
    const result = resolveRevenueRange(params as never, TODAY, FALLBACK);
    expect(result.dateFrom).toBe(FALLBACK.dateFrom);
    expect(result.dateTo).toBe(FALLBACK.dateTo);
    expect(result.fallbackNotice).toContain("所选区间无效");
    expect(result.fallbackNotice).toContain(expectedFragment);
  });
});

describe("isStalePendingTask · 排队超过 10 分钟仍未被认领", () => {
  const NOW = Date.parse("2026-10-08T12:00:00.000Z");
  const ago = (ms: number) => new Date(NOW - ms).toISOString();

  it("pending 且严格超过阈值 → true", () => {
    expect(isStalePendingTask({ status: "pending", createdAt: ago(REVENUE_WORKER_CLAIM_WARN_MS + 1) }, NOW)).toBe(true);
    expect(isStalePendingTask({ status: "pending", createdAt: ago(3 * 60 * 60 * 1000) }, NOW)).toBe(true);
  });

  it("恰好等于阈值或更短 → false", () => {
    expect(isStalePendingTask({ status: "pending", createdAt: ago(REVENUE_WORKER_CLAIM_WARN_MS) }, NOW)).toBe(false);
    expect(isStalePendingTask({ status: "pending", createdAt: ago(60 * 1000) }, NOW)).toBe(false);
  });

  it("processing（已有 worker 领走）即使很久也不是这个信号", () => {
    expect(isStalePendingTask({ status: "processing", createdAt: ago(5 * 60 * 60 * 1000) }, NOW)).toBe(false);
  });

  it("创建时间解析不出来 → 不亮", () => {
    expect(isStalePendingTask({ status: "pending", createdAt: "not-a-date" }, NOW)).toBe(false);
  });

  it("阈值就是 10 分钟", () => {
    expect(REVENUE_WORKER_CLAIM_WARN_MS).toBe(600_000);
  });

  it("shortTaskId 只露前 8 位", () => {
    expect(shortTaskId("0123456789abcdef")).toBe("01234567");
  });
});

describe("文案表", () => {
  it("批次状态：完成 / 部分异常 / 失败；未知状态显示原文", () => {
    expect(batchStatusView("completed").label).toBe("完成");
    expect(batchStatusView("partial_failed").label).toBe("部分异常");
    expect(batchStatusView("failed").label).toBe("失败");
    expect(batchStatusView("brand_new")).toEqual({ label: "brand_new", tone: "neutral" });
  });

  it("对账：一致 / 不一致 / 无总计行；null → 不显示", () => {
    expect(reconciliationView("matched")?.label).toBe("一致");
    expect(reconciliationView("mismatched")?.label).toBe("不一致");
    expect(reconciliationView("not_applicable")?.label).toBe("无总计行");
    expect(reconciliationView(null)).toBeNull();
  });

  it("入队失败 code：后端六个 code 都有中文；未知 code 显示原文", () => {
    for (const code of [
      "invalid_request",
      "invalid_date_range",
      "channel_account_unavailable",
      "channel_account_ambiguous",
      "revenue_sync_already_active",
      "request_token_conflict",
    ]) {
      expect(enqueueFailureCopy(code)).not.toContain(code);
      expect(enqueueFailureCopy(code)).toMatch(/[一-鿿]/);
    }
    expect(enqueueFailureCopy("totally_new_code")).toContain("totally_new_code");
  });
});
