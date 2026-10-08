import { describe, expect, it } from "vitest";

import {
  REVENUE_SYNC_MAX_SPAN_DAYS,
  REVENUE_SYNC_TASK_TYPE,
  RevenueSyncParamsError,
  addDaysToDate,
  assertValidRevenueSyncRange,
  inclusiveDaySpan,
  parseRevenueSyncTaskParams,
  revenueBatchFingerprint,
  revenueRawDedupeKey,
  revenueSyncOperationScopeHash,
  serializeRevenueSyncTaskParams,
  shanghaiToday,
} from "@/lib/tasks/revenue-sync";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-08T04:00:00.000Z"); // 上海 2026-10-08 12:00

const valid = { channelAccountId: ACCOUNT_ID, beginDate: "2026-09-20", endDate: "2026-10-07", requestedBy: "admin-1" } as const;

function expectParamsError(run: () => unknown, code: "invalid_date_range" | "invalid_params", reason?: string) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(RevenueSyncParamsError);
    expect((error as RevenueSyncParamsError).code).toBe(code);
    if (reason) expect((error as RevenueSyncParamsError).reason).toBe(reason);
    return;
  }
  throw new Error("expected RevenueSyncParamsError");
}

describe("任务参数：单一真源的 serialize / parse", () => {
  it("round-trip：serialize 的输出可被 parse 原样读回；字段顺序固定", () => {
    const serialized = serializeRevenueSyncTaskParams(valid, NOW);
    expect(serialized).toEqual({ ...valid, projectType: 1 });
    expect(Object.keys(serialized)).toEqual(["channelAccountId", "projectType", "beginDate", "endDate", "requestedBy"]);
    // 经 JSON（写进 generic_task.params / 条目 payload 再读回）也不变。
    const stored = JSON.parse(JSON.stringify(serialized)) as unknown;
    expect(parseRevenueSyncTaskParams(stored, NOW)).toEqual(serialized);
  });

  it("projectType 不由调用方决定：缺省时固定为 1；传别的值一律拒绝", () => {
    expect(serializeRevenueSyncTaskParams(valid, NOW).projectType).toBe(1);
    for (const projectType of [2, 0, "1", true, null, 1.5]) {
      expectParamsError(() => serializeRevenueSyncTaskParams({ ...valid, projectType }, NOW), "invalid_params", "projectType");
    }
    for (const projectType of [2, 0, "1", true, undefined, null]) {
      expectParamsError(() => parseRevenueSyncTaskParams({ ...valid, projectType }, NOW), "invalid_params", "projectType");
    }
  });

  it("parse 重新校验，不信任存量数据：反向区间 / 超 92 天 / 未来日期 / 坏格式", () => {
    const stored = { ...valid, projectType: 1 };
    expectParamsError(() => parseRevenueSyncTaskParams({ ...stored, beginDate: "2026-10-07", endDate: "2026-09-20" }, NOW), "invalid_date_range", "begin_after_end");
    expectParamsError(() => parseRevenueSyncTaskParams({ ...stored, beginDate: "2026-06-01", endDate: "2026-10-07" }, NOW), "invalid_date_range", "span_exceeded");
    expectParamsError(() => parseRevenueSyncTaskParams({ ...stored, endDate: "2026-10-09" }, NOW), "invalid_date_range", "end_in_future");
    expectParamsError(() => parseRevenueSyncTaskParams({ ...stored, beginDate: "2026-9-20" }, NOW), "invalid_date_range", "date_format");
    expectParamsError(() => parseRevenueSyncTaskParams({ ...stored, endDate: "2026-02-30" }, NOW), "invalid_date_range", "date_format");
    expectParamsError(() => parseRevenueSyncTaskParams({ ...stored, endDate: 20261007 }, NOW), "invalid_date_range", "date_format");
  });

  it("跨度恰好 92 天（含首尾）可以，93 天不行", () => {
    expect(REVENUE_SYNC_MAX_SPAN_DAYS).toBe(92);
    const end = "2026-10-07";
    const begin92 = addDaysToDate(end, -(92 - 1));
    expect(inclusiveDaySpan(begin92, end)).toBe(92);
    expect(() => assertValidRevenueSyncRange(begin92, end, NOW)).not.toThrow();
    const begin93 = addDaysToDate(end, -92);
    expect(inclusiveDaySpan(begin93, end)).toBe(93);
    expectParamsError(() => assertValidRevenueSyncRange(begin93, end, NOW), "invalid_date_range", "span_exceeded");
  });

  it("end 可以等于上海时区的今天，不能晚于它；以上海日期为准而不是 UTC 日期", () => {
    expect(() => assertValidRevenueSyncRange("2026-10-08", "2026-10-08", NOW)).not.toThrow();
    expectParamsError(() => assertValidRevenueSyncRange("2026-10-08", "2026-10-09", NOW), "invalid_date_range", "end_in_future");
    // UTC 还在 10-07 16:00（上海已是 10-08 00:00）：今天就是 10-08。
    const justAfterShanghaiMidnight = new Date("2026-10-07T16:00:00.000Z");
    expect(shanghaiToday(justAfterShanghaiMidnight)).toBe("2026-10-08");
    expect(() => assertValidRevenueSyncRange("2026-10-08", "2026-10-08", justAfterShanghaiMidnight)).not.toThrow();
    // UTC 10-07 15:59:59（上海 23:59:59）：今天还是 10-07。
    const justBeforeShanghaiMidnight = new Date("2026-10-07T15:59:59.000Z");
    expect(shanghaiToday(justBeforeShanghaiMidnight)).toBe("2026-10-07");
    expectParamsError(() => assertValidRevenueSyncRange("2026-10-08", "2026-10-08", justBeforeShanghaiMidnight), "invalid_date_range", "end_in_future");
  });

  it.each([
    ["账号 id 不是 uuid", { ...valid, channelAccountId: "nope" }, "channelAccountId"],
    ["账号 id 缺失", { ...valid, channelAccountId: undefined }, "channelAccountId"],
    ["requestedBy 为空", { ...valid, requestedBy: "" }, "requestedBy"],
    ["requestedBy 全空白", { ...valid, requestedBy: "   " }, "requestedBy"],
    ["requestedBy 超过 128", { ...valid, requestedBy: "a".repeat(129) }, "requestedBy"],
    ["requestedBy 不是字符串", { ...valid, requestedBy: 7 }, "requestedBy"],
  ])("非法参数：%s → invalid_params", (_name, input, reason) => {
    expectParamsError(() => serializeRevenueSyncTaskParams(input as never, NOW), "invalid_params", reason);
    expectParamsError(() => parseRevenueSyncTaskParams({ ...input, projectType: 1 }, NOW), "invalid_params", reason);
  });

  it.each([[null], [undefined], ["x"], [5], [[]], [true]])("整体不是对象（%j）→ invalid_params / shape", (value) => {
    expectParamsError(() => parseRevenueSyncTaskParams(value, NOW), "invalid_params", "shape");
  });

  it("parse 忽略多余键，serialize 只写这五个键", () => {
    const parsed = parseRevenueSyncTaskParams({ ...valid, projectType: 1, extra: "x", token: "should-not-survive" }, NOW);
    expect(Object.keys(parsed)).toEqual(["channelAccountId", "projectType", "beginDate", "endDate", "requestedBy"]);
    expect(JSON.stringify(parsed)).not.toContain("should-not-survive");
  });

  it("账号 id 规范化为小写；requestedBy 去首尾空白", () => {
    const parsed = serializeRevenueSyncTaskParams({ ...valid, channelAccountId: ACCOUNT_ID.toUpperCase(), requestedBy: "  admin-1  " }, NOW);
    expect(parsed.channelAccountId).toBe(ACCOUNT_ID);
    expect(parsed.requestedBy).toBe("admin-1");
  });

  it("日期工具：加减天数跨月跨年 / 闰年", () => {
    expect(addDaysToDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDaysToDate("2028-03-01", -1)).toBe("2028-02-29");
    expect(addDaysToDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(inclusiveDaySpan("2026-10-07", "2026-10-07")).toBe(1);
    expect(inclusiveDaySpan("2026-02-27", "2026-03-02")).toBe(4);
    expectParamsError(() => addDaysToDate("2026-13-01", 1), "invalid_date_range");
  });
});

describe("幂等键与作用域哈希", () => {
  const base = { scopeId: "scope-1", projectType: 1, beginDate: "2026-09-20", endDate: "2026-10-07", genericTaskId: "task-1" };

  it("批次指纹：同一任务重试相同；换任务 / 区间 / 作用域 / 业务线都不同", () => {
    const fingerprint = revenueBatchFingerprint(base);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(revenueBatchFingerprint({ ...base })).toBe(fingerprint);
    for (const change of [
      { genericTaskId: "task-2" },
      { beginDate: "2026-09-21" },
      { endDate: "2026-10-06" },
      { scopeId: "scope-2" },
      { projectType: 2 },
    ]) {
      expect(revenueBatchFingerprint({ ...base, ...change })).not.toBe(fingerprint);
    }
  });

  it("批次指纹 = sha256(scopeId|projectType|begin|end|genericTaskId)", async () => {
    const { createHash } = await import("node:crypto");
    expect(revenueBatchFingerprint(base)).toBe(
      createHash("sha256").update("scope-1|1|2026-09-20|2026-10-07|task-1").digest("hex"),
    );
  });

  it("原始行 dedupe_key：明细行按日期区分，总计行按区间区分，二者互不相撞", async () => {
    const { createHash } = await import("node:crypto");
    const detail = (date: string) => revenueRawDedupeKey({ kind: "detail", scopeId: "s", projectType: 1, dimension: "1", date });
    expect(detail("2026-09-26")).toBe(createHash("sha256").update("s|1|1|2026-09-26|detail").digest("hex"));
    expect(detail("2026-09-26")).not.toBe(detail("2026-09-27"));
    const total = (beginDate: string, endDate: string) =>
      revenueRawDedupeKey({ kind: "total", scopeId: "s", projectType: 1, dimension: "1", dimensionKey: "总计", beginDate, endDate });
    expect(total("2026-09-20", "2026-10-07")).toBe(createHash("sha256").update("s|1|1|总计|total:2026-09-20~2026-10-07").digest("hex"));
    expect(total("2026-09-20", "2026-10-07")).not.toBe(total("2026-09-21", "2026-10-07"));
    expect(total("2026-09-20", "2026-10-07")).not.toBe(detail("2026-09-26"));
    expect(detail("2026-09-26")).toHaveLength(64);
  });

  it("operation_scope_hash 是 revenue_sync 作用域哈希，且把 projectType 折进去（char(64)，同入参稳定）", async () => {
    const { createHash } = await import("node:crypto");
    const hash = revenueSyncOperationScopeHash(1);
    expect(hash).toBe(createHash("sha256").update(JSON.stringify({ scope: "revenue_sync", projectType: 1 })).digest("hex"));
    expect(hash).toHaveLength(64);
    expect(revenueSyncOperationScopeHash(1)).toBe(hash);
    // 默认入参 = 网文 projectType=1。
    expect(revenueSyncOperationScopeHash()).toBe(hash);
    // projectType 在哈希里：同账号别的业务线的同类任务不会与网文互相挤占活跃作用域。
    expect(revenueSyncOperationScopeHash(2)).not.toBe(hash);
    expect(revenueSyncOperationScopeHash(2)).toBe(createHash("sha256").update(JSON.stringify({ scope: "revenue_sync", projectType: 2 })).digest("hex"));
  });

  it("任务类型常量", () => {
    expect(REVENUE_SYNC_TASK_TYPE).toBe("changdu.revenue_sync.v1");
  });
});
