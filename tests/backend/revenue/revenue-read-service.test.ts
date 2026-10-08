import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  RevenueDashboardQueryError,
  buildRevenueDays,
  defaultRevenueRange,
  loadRevenueDashboard,
  summarizeRevenueDays,
  type RevenueDayRow,
} from "@/server/revenue";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const APP_ID = "22222222-2222-4222-8222-222222222222";
const SCOPE_ID = "44444444-4444-4444-8444-444444444444";
const D = (value: string) => new Prisma.Decimal(value);
const utc = (date: string) => new Date(`${date}T00:00:00.000Z`);

function stat(date: string, overrides: Partial<{ realDevNum: number | null; newRealDevNum: number | null; realDevNumRate: string | null; realIncome: string | null }> = {}) {
  const value = { realDevNum: 1, newRealDevNum: 1, realDevNumRate: "1", realIncome: "0", ...overrides };
  return {
    statDate: utc(date),
    realDevNum: value.realDevNum,
    newRealDevNum: value.newRealDevNum,
    realDevNumRate: value.realDevNumRate === null ? null : D(value.realDevNumRate),
    realIncome: value.realIncome === null ? null : D(value.realIncome),
  };
}

describe("每一天的三态 coverage（纯函数）", () => {
  const days = buildRevenueDays({
    dateFrom: "2026-10-01",
    dateTo: "2026-10-10",
    stats: [stat("2026-10-05", { realDevNum: 7, newRealDevNum: 2, realDevNumRate: "0.282700", realIncome: "28.88" })],
    coveredRanges: [{ beginDate: "2026-10-03", endDate: "2026-10-07" }],
  });
  const byDate = Object.fromEntries(days.map((day) => [day.date, day]));

  it("覆盖区间内每一天，日期倒序", () => {
    expect(days).toHaveLength(10);
    expect(days.map((day) => day.date)).toEqual([
      "2026-10-10", "2026-10-09", "2026-10-08", "2026-10-07", "2026-10-06",
      "2026-10-05", "2026-10-04", "2026-10-03", "2026-10-02", "2026-10-01",
    ]);
  });

  it("reported：有上游行，数值取自日统计，金额 4 位小数字符串、比例小数字符串", () => {
    expect(byDate["2026-10-05"]).toEqual({
      date: "2026-10-05", coverage: "reported", activeUsers: 7, newUsers: 2, newUserRatio: "0.2827", shareIncomeUsd: "28.8800",
    });
  });

  it("no_upstream_row：被成功批次覆盖但上游没返回 → 视为 0 活动", () => {
    for (const date of ["2026-10-03", "2026-10-04", "2026-10-06", "2026-10-07"]) {
      expect(byDate[date], date).toEqual({
        date, coverage: "no_upstream_row", activeUsers: 0, newUsers: 0, newUserRatio: null, shareIncomeUsd: "0.0000",
      });
    }
  });

  it("not_synced：没有任何成功批次覆盖 → 数值全是 null（不是 0）", () => {
    for (const date of ["2026-10-01", "2026-10-02", "2026-10-08", "2026-10-09", "2026-10-10"]) {
      expect(byDate[date], date).toEqual({
        date, coverage: "not_synced", activeUsers: null, newUsers: null, newUserRatio: null, shareIncomeUsd: null,
      });
    }
  });

  it("有行优先于覆盖区间：已有日统计的日子即使不在任何批次区间内也是 reported", () => {
    const result = buildRevenueDays({ dateFrom: "2026-10-01", dateTo: "2026-10-02", stats: [stat("2026-10-01")], coveredRanges: [] });
    expect(result.find((day) => day.date === "2026-10-01")?.coverage).toBe("reported");
    expect(result.find((day) => day.date === "2026-10-02")?.coverage).toBe("not_synced");
  });

  it("字段缺失 = null、'0' = 0 的区别带到视图里", () => {
    const [missing, zero] = buildRevenueDays({
      dateFrom: "2026-10-01",
      dateTo: "2026-10-02",
      stats: [
        stat("2026-10-02", { realDevNum: null, newRealDevNum: null, realDevNumRate: null, realIncome: null }),
        stat("2026-10-01", { realDevNum: 0, newRealDevNum: 0, realDevNumRate: "0", realIncome: "0" }),
      ],
      coveredRanges: [],
    });
    expect(missing).toEqual({ date: "2026-10-02", coverage: "reported", activeUsers: null, newUsers: null, newUserRatio: null, shareIncomeUsd: null });
    expect(zero).toEqual({ date: "2026-10-01", coverage: "reported", activeUsers: 0, newUsers: 0, newUserRatio: "0", shareIncomeUsd: "0.0000" });
  });
});

describe("汇总（纯函数）", () => {
  const row = (partial: Partial<RevenueDayRow> & Pick<RevenueDayRow, "coverage">): RevenueDayRow => ({
    date: "2026-10-01", activeUsers: null, newUsers: null, newUserRatio: null, shareIncomeUsd: null, ...partial,
  });

  it("分成收入合计只用 Decimal：0.1 + 0.2 = 0.3000（不是 0.30000000000000004）", () => {
    const summary = summarizeRevenueDays([
      row({ coverage: "reported", shareIncomeUsd: "0.1000", activeUsers: 1, newUsers: 1 }),
      row({ coverage: "reported", shareIncomeUsd: "0.2000", activeUsers: 1, newUsers: 1 }),
    ]);
    expect(summary.shareIncomeUsdTotal).toBe("0.3000");
  });

  it("大额合计精确到 4 位小数", () => {
    const summary = summarizeRevenueDays([
      row({ coverage: "reported", shareIncomeUsd: "12345678901234.5678", activeUsers: 1, newUsers: 0 }),
      row({ coverage: "reported", shareIncomeUsd: "0.0001", activeUsers: 1, newUsers: 0 }),
    ]);
    expect(summary.shareIncomeUsdTotal).toBe("12345678901234.5679");
  });

  it("新用户合计、三态天数；日均激活 = (reported 激活合计) / (reported + no_upstream_row 天数)，no_upstream_row 记 0", () => {
    const summary = summarizeRevenueDays([
      row({ coverage: "reported", activeUsers: 10, newUsers: 3, shareIncomeUsd: "5.0000" }),
      row({ coverage: "reported", activeUsers: 20, newUsers: 4, shareIncomeUsd: "1.5000" }),
      row({ coverage: "no_upstream_row", activeUsers: 0, newUsers: 0, shareIncomeUsd: "0.0000" }),
      row({ coverage: "no_upstream_row", activeUsers: 0, newUsers: 0, shareIncomeUsd: "0.0000" }),
      row({ coverage: "not_synced" }),
    ]);
    expect(summary).toEqual({
      shareIncomeUsdTotal: "6.5000",
      newUsersTotal: 7,
      avgActiveUsers: "7.50",
      reportedDays: 2,
      noUpstreamRowDays: 2,
      notSyncedDays: 1,
    });
  });

  it("日均保留 2 位小数（四舍五入）", () => {
    const summary = summarizeRevenueDays([
      row({ coverage: "reported", activeUsers: 1, newUsers: 0, shareIncomeUsd: "0.0000" }),
      row({ coverage: "reported", activeUsers: 1, newUsers: 0, shareIncomeUsd: "0.0000" }),
      row({ coverage: "reported", activeUsers: 2, newUsers: 0, shareIncomeUsd: "0.0000" }),
    ]);
    expect(summary.avgActiveUsers).toBe("1.33");
  });

  it("没有任何可计算的天 → avgActiveUsers 为 null，合计为 0", () => {
    const summary = summarizeRevenueDays([row({ coverage: "not_synced" }), row({ coverage: "not_synced" })]);
    expect(summary).toMatchObject({ avgActiveUsers: null, shareIncomeUsdTotal: "0.0000", newUsersTotal: 0, notSyncedDays: 2 });
  });

  it("reported 但激活用户字段缺失的天不进日均的分母（未知 ≠ 0）", () => {
    const summary = summarizeRevenueDays([
      row({ coverage: "reported", activeUsers: null, newUsers: null, shareIncomeUsd: null }),
      row({ coverage: "reported", activeUsers: 10, newUsers: 1, shareIncomeUsd: "1.0000" }),
    ]);
    expect(summary.avgActiveUsers).toBe("10.00");
    expect(summary.reportedDays).toBe(2);
  });
});

function makeDb(options: {
  apps?: unknown[];
  scope?: unknown;
  stats?: unknown[];
  covering?: unknown[];
  recent?: unknown[];
  lastSuccess?: unknown;
  activeTask?: unknown;
  credentials?: unknown[];
} = {}) {
  const apps = options.apps ?? [{ id: APP_ID, channel: { channelAccounts: [{ id: ACCOUNT_ID, accountName: "chenweifeng@qq.com" }] } }];
  const batchFindMany = vi.fn(async (args: { take?: number }) => (args.take ? options.recent ?? [] : options.covering ?? []));
  return {
    channelApp: { findMany: vi.fn(async () => apps) },
    revenueSyncScope: { findUnique: vi.fn(async () => ("scope" in options ? options.scope : { id: SCOPE_ID })) },
    revenueDailyStat: { findMany: vi.fn(async () => options.stats ?? []) },
    revenueSyncBatch: { findMany: batchFindMany, findFirst: vi.fn<(...args: any[]) => Promise<any>>(async () => options.lastSuccess ?? null) },
    genericTask: { findFirst: vi.fn(async () => options.activeTask ?? null) },
    channelAccountCredential: { findMany: vi.fn<(...args: any[]) => Promise<any>>(async () => options.credentials ?? []) },
  };
}
const asPrisma = (db: unknown) => db as PrismaClient;

describe("loadRevenueDashboard", () => {
  const range = { dateFrom: "2026-10-01", dateTo: "2026-10-07" };

  it("组装完整视图：脱敏账号标签、区间、三态天、汇总、最近批次、活跃任务、凭证元数据、最近成功时间", async () => {
    const db = makeDb({
      stats: [stat("2026-10-05", { realDevNum: 7, newRealDevNum: 2, realDevNumRate: "0.2827", realIncome: "28.88" })],
      covering: [{ beginDate: utc("2026-10-03"), endDate: utc("2026-10-06") }],
      recent: [
        {
          id: "batch-2", createdAt: new Date("2026-10-08T01:00:00Z"), finishedAt: new Date("2026-10-08T01:00:05Z"),
          beginDate: utc("2026-10-01"), endDate: utc("2026-10-07"), status: "partial_failed", detailRowCount: 1, totalRowCount: 1,
          reconciliationStatus: "mismatched", upstreamStarId: "335788", credentialFingerprintPrefix: "abc123def456",
          errorCode: "total_row_mismatch", errorMessage: "Detail income sum 1 differs", genericTaskId: "task-2",
        },
        {
          id: "batch-1", createdAt: new Date("2026-10-07T01:00:00Z"), finishedAt: null,
          beginDate: utc("2026-09-20"), endDate: utc("2026-10-07"), status: "failed", detailRowCount: 0, totalRowCount: 0,
          reconciliationStatus: null, upstreamStarId: null, credentialFingerprintPrefix: null,
          errorCode: "credential_not_star_scope", errorMessage: "msg", genericTaskId: null,
        },
      ],
      lastSuccess: { finishedAt: new Date("2026-10-08T01:00:05Z") },
      activeTask: { id: "task-3", status: "pending", createdAt: new Date("2026-10-08T02:00:00Z") },
      credentials: [
        { id: "c2", channelAccountId: ACCOUNT_ID, credentialType: "bearer_jwt", fingerprintPrefix: "p2", status: "superseded", expiresAt: new Date("2026-10-01T00:00:00Z"), lastValidatedAt: null },
        { id: "c1", channelAccountId: ACCOUNT_ID, credentialType: "bearer_jwt", fingerprintPrefix: "p1", status: "active", expiresAt: new Date("2026-10-15T00:00:00Z"), lastValidatedAt: null },
      ],
    });

    const view = await loadRevenueDashboard(asPrisma(db), range);

    expect(view.account).toEqual({ id: ACCOUNT_ID, label: "ch***@qq.com", novelAppCount: 1 });
    expect(view.range).toEqual({ ...range, dayCount: 7 });
    expect(view.days.map((day) => `${day.date}:${day.coverage}`)).toEqual([
      "2026-10-07:not_synced", "2026-10-06:no_upstream_row", "2026-10-05:reported", "2026-10-04:no_upstream_row",
      "2026-10-03:no_upstream_row", "2026-10-02:not_synced", "2026-10-01:not_synced",
    ]);
    expect(view.summary).toEqual({
      shareIncomeUsdTotal: "28.8800", newUsersTotal: 2, avgActiveUsers: "1.75", reportedDays: 1, noUpstreamRowDays: 3, notSyncedDays: 3,
    });
    expect(view.batches).toHaveLength(2);
    expect(view.batches[0]).toEqual({
      id: "batch-2", createdAt: "2026-10-08T01:00:00.000Z", finishedAt: "2026-10-08T01:00:05.000Z",
      beginDate: "2026-10-01", endDate: "2026-10-07", status: "partial_failed", detailRowCount: 1, totalRowCount: 1,
      reconciliationStatus: "mismatched", upstreamStarId: "335788", credentialFingerprintPrefix: "abc123def456",
      errorCode: "total_row_mismatch", errorMessage: "Detail income sum 1 differs", genericTaskId: "task-2",
    });
    expect(view.batches[1]).toMatchObject({ id: "batch-1", finishedAt: null, reconciliationStatus: null, genericTaskId: null });
    expect(view.activeTask).toEqual({ id: "task-3", status: "pending", createdAt: "2026-10-08T02:00:00.000Z" });
    expect(view.credential).toEqual({ status: "active", expiresAt: "2026-10-15T00:00:00.000Z" });
    expect(view.lastSuccessfulSyncAt).toBe("2026-10-08T01:00:05.000Z");
  });

  it("覆盖只看 completed / partial_failed 批次——failed 批次没有写入任何数据，不能证明“上游当天没有活动”", async () => {
    const db = makeDb();
    await loadRevenueDashboard(asPrisma(db), range);
    const coveringCall = db.revenueSyncBatch.findMany.mock.calls.map((call) => call[0] as Record<string, any>).find((args) => !args.take)!;
    expect(coveringCall.where.status).toEqual({ in: ["completed", "partial_failed"] });
    expect(coveringCall.where.revenueSyncScopeId).toBe(SCOPE_ID);
    const lastSuccess = db.revenueSyncBatch.findFirst.mock.calls[0]![0] as Record<string, any>;
    expect(lastSuccess.where.status).toEqual({ in: ["completed", "partial_failed"] });
  });

  it("最近批次：创建时间倒序、最多 20 个", async () => {
    const db = makeDb();
    await loadRevenueDashboard(asPrisma(db), range);
    const recentCall = db.revenueSyncBatch.findMany.mock.calls.map((call) => call[0] as Record<string, any>).find((args) => args.take)!;
    expect(recentCall.take).toBe(20);
    expect(recentCall.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });

  it("凭证只读元数据：select 里没有密文 / 完整指纹；没有 active 时取最新一条；没有凭证为 null", async () => {
    const expired = { id: "c1", channelAccountId: ACCOUNT_ID, credentialType: "bearer_jwt", fingerprintPrefix: "p1", status: "expired", expiresAt: new Date("2026-09-01T00:00:00Z"), lastValidatedAt: null };
    const db = makeDb({ credentials: [expired] });
    const view = await loadRevenueDashboard(asPrisma(db), range);
    expect(view.credential).toEqual({ status: "expired", expiresAt: "2026-09-01T00:00:00.000Z" });
    const select = (db.channelAccountCredential.findMany.mock.calls[0]![0] as { select: Record<string, boolean> }).select;
    expect(Object.keys(select)).not.toContain("encryptedSecret");
    expect(Object.keys(select)).not.toContain("secretFingerprint");
    expect((await loadRevenueDashboard(asPrisma(makeDb({ credentials: [] })), range)).credential).toBeNull();
  });

  it("还没有作用域（从未同步过）：每一天 not_synced，不查日统计 / 批次；活跃任务与凭证照常返回", async () => {
    const db = makeDb({ scope: null, activeTask: { id: "t", status: "processing", createdAt: new Date("2026-10-08T00:00:00Z") } });
    const view = await loadRevenueDashboard(asPrisma(db), range);
    expect(view.days.every((day) => day.coverage === "not_synced")).toBe(true);
    expect(view.summary).toMatchObject({ reportedDays: 0, noUpstreamRowDays: 0, notSyncedDays: 7, avgActiveUsers: null });
    expect(view.batches).toEqual([]);
    expect(view.lastSuccessfulSyncAt).toBeNull();
    expect(view.activeTask).toMatchObject({ id: "t", status: "processing" });
    expect(db.revenueDailyStat.findMany).not.toHaveBeenCalled();
    expect(db.revenueSyncBatch.findMany).not.toHaveBeenCalled();
  });

  it("同一账号下挂两个 active 网文应用 → 视图正常返回（不是 account=null），account.novelAppCount = 2", async () => {
    const account = { id: ACCOUNT_ID, accountName: "chenweifeng@qq.com" };
    const db = makeDb({
      apps: [
        { id: APP_ID, channel: { channelAccounts: [account] } },
        { id: "33333333-3333-4333-8333-333333333333", channel: { channelAccounts: [account] } },
      ],
    });
    const view = await loadRevenueDashboard(asPrisma(db), range);
    expect(view.account).toEqual({ id: ACCOUNT_ID, label: "ch***@qq.com", novelAppCount: 2 });
  });

  it.each([
    ["没有可用账号", []],
    ["候选账号不止一个", [{ id: APP_ID, channel: { channelAccounts: [{ id: ACCOUNT_ID, accountName: "a" }, { id: "99999999-9999-4999-8999-999999999999", accountName: "b" }] } }]],
  ])("%s → account 为 null，页面照常渲染但每一天都是未同步，不碰收益表", async (_name, apps) => {
    const db = makeDb({ apps });
    const view = await loadRevenueDashboard(asPrisma(db), range);
    expect(view.account).toBeNull();
    expect(view.credential).toBeNull();
    expect(view.activeTask).toBeNull();
    expect(view.batches).toEqual([]);
    expect(view.days).toHaveLength(7);
    expect(view.days.every((day) => day.coverage === "not_synced")).toBe(true);
    expect(db.revenueSyncScope.findUnique).not.toHaveBeenCalled();
    expect(db.genericTask.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ["反向区间", { dateFrom: "2026-10-07", dateTo: "2026-10-01" }],
    ["超过 92 天", { dateFrom: "2026-06-01", dateTo: "2026-10-07" }],
    ["坏格式", { dateFrom: "2026-10-1", dateTo: "2026-10-07" }],
    ["不存在的日期", { dateFrom: "2026-02-30", dateTo: "2026-03-05" }],
  ])("非法区间（%s）→ RevenueDashboardQueryError，不碰数据库", async (_name, query) => {
    const db = makeDb();
    await expect(loadRevenueDashboard(asPrisma(db), query)).rejects.toBeInstanceOf(RevenueDashboardQueryError);
    expect(db.channelApp.findMany).not.toHaveBeenCalled();
  });

  it("区间边界：恰好 92 天可以", async () => {
    const view = await loadRevenueDashboard(asPrisma(makeDb()), { dateFrom: "2026-07-08", dateTo: "2026-10-07" });
    expect(view.range.dayCount).toBe(92);
    expect(view.days).toHaveLength(92);
  });
});

describe("defaultRevenueRange", () => {
  it("上海时区今天往前共 30 天（含今天）", () => {
    expect(defaultRevenueRange(new Date("2026-10-08T04:00:00.000Z"))).toEqual({ dateFrom: "2026-09-09", dateTo: "2026-10-08" });
  });

  it("以上海日期为准：UTC 还在前一天的 16:30 已是上海次日", () => {
    expect(defaultRevenueRange(new Date("2026-10-07T16:30:00.000Z")).dateTo).toBe("2026-10-08");
    expect(defaultRevenueRange(new Date("2026-10-07T15:30:00.000Z")).dateTo).toBe("2026-10-07");
  });

  it("默认区间本身合法：恰好 30 天，可以直接喂给 loadRevenueDashboard", async () => {
    const range = defaultRevenueRange(new Date("2026-03-01T00:00:00.000Z"));
    expect(range).toEqual({ dateFrom: "2026-01-31", dateTo: "2026-03-01" });
    const view = await loadRevenueDashboard(asPrisma(makeDb()), range);
    expect(view.range.dayCount).toBe(30);
  });
});
