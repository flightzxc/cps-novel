import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { REVENUE_SYNC_TARGET_TYPE, REVENUE_SYNC_TASK_TYPE, revenueSyncOperationScopeHash } from "@/lib/tasks/revenue-sync";
import { maskRevenueAccountLabel, resolveRevenueChannelAccount } from "@/server/revenue/account";
import { enqueueRevenueSync } from "@/server/revenue/enqueue";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const APP_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-08T04:00:00.000Z");
const INPUT = { beginDate: "2026-10-01", endDate: "2026-10-07", requestToken: "req-token-1", actor: "admin-1" } as const;

type AppRow = { id: string; channel: { channelAccounts: Array<{ id: string; accountName: string }> } };

function app(id: string, accounts: Array<{ id: string; accountName: string }>): AppRow {
  return { id, channel: { channelAccounts: accounts } };
}

function makeDb(options: {
  apps?: AppRow[];
  /** 给了就用带过滤的 channel_app 假库（按 where 真实过滤夹具行），否则直接返回 `apps`。 */
  fixtures?: FixtureApp[];
  byToken?: unknown;
  active?: unknown;
  createError?: unknown;
  byTokenAfterConflict?: unknown;
} = {}) {
  const apps = options.apps ?? [app(APP_ID, [{ id: ACCOUNT_ID, accountName: "chenweifeng@qq.com" }])];
  const tx = {
    genericTask: { create: vi.fn<(...args: any[]) => Promise<any>>(async () => ({})) },
    operationAudit: { create: vi.fn<(...args: any[]) => Promise<any>>(async () => ({})) },
  };
  if (options.createError) tx.genericTask.create = vi.fn<(...args: any[]) => Promise<any>>(async () => { throw options.createError; });
  let tokenLookups = 0;
  const db = {
    channelApp: options.fixtures
      ? makeFilteringDb(options.fixtures).channelApp
      : { findMany: vi.fn<(...args: any[]) => Promise<any>>(async () => apps) },
    genericTask: {
      findUnique: vi.fn<(...args: any[]) => Promise<any>>(async () => {
        tokenLookups += 1;
        return tokenLookups === 1 ? (options.byToken ?? null) : (options.byTokenAfterConflict ?? options.byToken ?? null);
      }),
      findFirst: vi.fn<(...args: any[]) => Promise<any>>(async () => options.active ?? null),
    },
    $transaction: vi.fn<(callback: (client: typeof tx) => Promise<unknown>, ...args: any[]) => Promise<unknown>>(async (callback) => callback(tx)),
  };
  return { db, tx };
}

const asPrisma = (db: unknown) => db as PrismaClient;

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "6.19.2" });
}

/**
 * 带过滤能力的 channel_app 假库：`findMany` 按传入的 `where`（projectType / 应用 status / channel.status /
 * sourceApp.status）真实过滤夹具行，所以“某个应用 disabled → 不计入”测的是查询条件本身，而不是夹具的预先筛选。
 */
type FixtureApp = {
  id: string;
  projectType?: number;
  status?: string;
  channelStatus?: string;
  sourceAppStatus?: string;
  accounts: Array<{ id: string; accountName: string }>;
};

function makeFilteringDb(fixtures: FixtureApp[]) {
  const findMany = vi.fn<(...args: any[]) => Promise<any>>(async (args: { where: any }) => {
    const where = args.where;
    return fixtures
      .filter((row) =>
        (row.projectType ?? 1) === where.projectType
        && (row.status ?? "active") === where.status
        && (row.channelStatus ?? "active") === where.channel.status
        && (row.sourceAppStatus ?? "active") === where.sourceApp.status)
      .map((row) => app(row.id, row.accounts));
  });
  return { channelApp: { findMany } };
}

const OTHER_ACCOUNT_ID = "99999999-9999-4999-8999-999999999999";
const APP_B_ID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_A = { id: ACCOUNT_ID, accountName: "chenweifeng@qq.com" };

describe("选账号：按账号去重，恰好一个 active 且未删除的 channel_account（账号级）", () => {
  it("恰好一个 → ok，带账号名与 novelAppCount（不带 channelAppId）；查询条件钉死 projectType=1 与各层 active", async () => {
    const { db } = makeDb();
    const resolution = await resolveRevenueChannelAccount(db as never);
    expect(resolution).toEqual({ status: "ok", channelAccountId: ACCOUNT_ID, accountName: "chenweifeng@qq.com", novelAppCount: 1 });
    expect(resolution).not.toHaveProperty("channelAppId");
    const where = db.channelApp.findMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({ projectType: 1, status: "active", channel: { status: "active" }, sourceApp: { status: "active" } });
    const accountsFilter = db.channelApp.findMany.mock.calls[0]![0].select.channel.select.channelAccounts.where;
    expect(accountsFilter).toEqual({ status: "active", deletedAt: null });
  });

  it("没有账号 / 没有网文应用 → unavailable", async () => {
    expect(await resolveRevenueChannelAccount(makeDb({ apps: [] }).db as never)).toEqual({ status: "unavailable" });
    expect(await resolveRevenueChannelAccount(makeDb({ apps: [app(APP_ID, [])] }).db as never)).toEqual({ status: "unavailable" });
  });

  it("同一个账号下挂两个 active 网文应用 → ok（不是 ambiguous），novelAppCount = 2", async () => {
    const db = makeFilteringDb([
      { id: APP_ID, accounts: [ACCOUNT_A] },
      { id: APP_B_ID, accounts: [ACCOUNT_A] },
    ]);
    expect(await resolveRevenueChannelAccount(db as never)).toEqual({
      status: "ok", channelAccountId: ACCOUNT_ID, accountName: "chenweifeng@qq.com", novelAppCount: 2,
    });
  });

  it("两个不同的 active 账号（同一应用下，或分挂在不同应用下）→ ambiguous（不替运营挑）", async () => {
    const sameApp = makeDb({ apps: [app(APP_ID, [ACCOUNT_A, { id: OTHER_ACCOUNT_ID, accountName: "b" }])] });
    expect(await resolveRevenueChannelAccount(sameApp.db as never)).toEqual({ status: "ambiguous" });
    const differentApps = makeFilteringDb([
      { id: APP_ID, accounts: [ACCOUNT_A] },
      { id: APP_B_ID, accounts: [{ id: OTHER_ACCOUNT_ID, accountName: "b" }] },
    ]);
    expect(await resolveRevenueChannelAccount(differentApps as never)).toEqual({ status: "ambiguous" });
  });

  it("应用 inactive（或 channel / source_app 非 active，或不是网文 projectType）→ 不计入 novelAppCount", async () => {
    const db = makeFilteringDb([
      { id: APP_ID, accounts: [ACCOUNT_A] },
      { id: APP_B_ID, status: "inactive", accounts: [ACCOUNT_A] },
      { id: "44444444-4444-4444-8444-444444444444", projectType: 2, accounts: [ACCOUNT_A] },
      { id: "55555555-5555-4555-8555-555555555555", sourceAppStatus: "inactive", accounts: [ACCOUNT_A] },
    ]);
    expect(await resolveRevenueChannelAccount(db as never)).toMatchObject({ status: "ok", novelAppCount: 1 });
    // 唯一的应用被停用 → 没有任何网文应用 → unavailable。
    const onlyDisabled = makeFilteringDb([{ id: APP_ID, status: "inactive", accounts: [ACCOUNT_A] }]);
    expect(await resolveRevenueChannelAccount(onlyDisabled as never)).toEqual({ status: "unavailable" });
  });

  it("账号标签脱敏", () => {
    expect(maskRevenueAccountLabel("chenweifeng@qq.com")).toBe("ch***@qq.com");
    expect(maskRevenueAccountLabel("ab")).toBe("a***");
    expect(maskRevenueAccountLabel("novel_operator")).toBe("no***");
    expect(maskRevenueAccountLabel("  ")).toBe("***");
    expect(maskRevenueAccountLabel("x@y.com")).toBe("x***@y.com");
  });
});

describe("入队成功", () => {
  it("同一事务写 generic_task + 唯一条目 + operation_audit；账号级：channel_app_id 为 NULL，作用域哈希折进 projectType，模式 / 状态正确", async () => {
    const { db, tx } = makeDb();
    const result = await enqueueRevenueSync(asPrisma(db), INPUT, { now: NOW });

    expect(result).toMatchObject({ ok: true, duplicate: false });
    const taskId = (result as { taskId: string }).taskId;
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    const task = tx.genericTask.create.mock.calls[0]![0].data;
    expect(task).toMatchObject({
      id: taskId,
      taskType: "changdu.revenue_sync.v1",
      channelAccountId: ACCOUNT_ID,
      channelAppId: null,
      operationScopeHash: revenueSyncOperationScopeHash(1),
      mode: "apply",
      status: "pending",
      requestToken: "req-token-1",
      totalCount: 1,
    });
    const expectedParams = { channelAccountId: ACCOUNT_ID, projectType: 1, beginDate: "2026-10-01", endDate: "2026-10-07", requestedBy: "admin-1" };
    expect(task.params).toEqual(expectedParams);
    expect(task.items.create).toEqual([{ targetType: REVENUE_SYNC_TARGET_TYPE, targetId: "2026-10-01~2026-10-07", payload: expectedParams }]);

    const audit = tx.operationAudit.create.mock.calls[0]![0].data;
    expect(audit).toMatchObject({
      actorType: "admin", actorId: "admin-1", action: "revenue.sync.queued", entityType: "GenericTask", entityId: taskId,
      requestId: "req-token-1", taskType: REVENUE_SYNC_TASK_TYPE, taskId,
    });
    expect(audit.afterSnapshot).toMatchObject({ projectType: 1, beginDate: "2026-10-01", endDate: "2026-10-07", mode: "apply" });
  });

  it("同一账号下挂两个 active 网文应用 → 照常入队（不是 channel_account_ambiguous），任务不属于任何一个应用", async () => {
    const { db, tx } = makeDb({ fixtures: [{ id: APP_ID, accounts: [ACCOUNT_A] }, { id: APP_B_ID, accounts: [ACCOUNT_A] }] });
    const result = await enqueueRevenueSync(asPrisma(db), INPUT, { now: NOW });
    expect(result).toMatchObject({ ok: true, duplicate: false });
    const task = tx.genericTask.create.mock.calls[0]![0].data;
    expect(task).toMatchObject({ channelAccountId: ACCOUNT_ID, channelAppId: null });
  });

  it("入队永远是 apply、projectType 永远是 1：调用方没有任何入参能改它们", async () => {
    const { db, tx } = makeDb();
    await enqueueRevenueSync(asPrisma(db), { ...INPUT, mode: "dry_run", projectType: 2 } as never, { now: NOW });
    const task = tx.genericTask.create.mock.calls[0]![0].data;
    expect(task.mode).toBe("apply");
    expect(task.params.projectType).toBe(1);
  });

  it("参数里没有任何凭证字段：只有账号 id、区间与操作人", async () => {
    const { db, tx } = makeDb();
    await enqueueRevenueSync(asPrisma(db), INPUT, { now: NOW });
    expect(Object.keys(tx.genericTask.create.mock.calls[0]![0].data.params)).toEqual([
      "channelAccountId", "projectType", "beginDate", "endDate", "requestedBy",
    ]);
  });
});

describe("入队拒绝", () => {
  it.each([
    ["区间反向", { beginDate: "2026-10-07", endDate: "2026-10-01" }],
    ["超过 92 天", { beginDate: "2026-06-01", endDate: "2026-10-07" }],
    ["未来日期", { endDate: "2026-10-09" }],
    ["坏格式", { beginDate: "2026-10-1" }],
  ])("%s → invalid_date_range，不碰数据库", async (_name, overrides) => {
    const { db } = makeDb();
    const result = await enqueueRevenueSync(asPrisma(db), { ...INPUT, ...overrides }, { now: NOW });
    expect(result).toEqual({ ok: false, code: "invalid_date_range" });
    expect(db.channelApp.findMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    [{ requestToken: "" }],
    [{ requestToken: "x".repeat(161) }],
    [{ actor: "" }],
    [{ actor: "a".repeat(129) }],
  ])("令牌 / 操作人非法 %j → invalid_request", async (overrides) => {
    const { db } = makeDb();
    expect(await enqueueRevenueSync(asPrisma(db), { ...INPUT, ...overrides }, { now: NOW })).toEqual({ ok: false, code: "invalid_request" });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("没有可用账号 → channel_account_unavailable；候选不止一个 → channel_account_ambiguous", async () => {
    const none = makeDb({ apps: [] });
    expect(await enqueueRevenueSync(asPrisma(none.db), INPUT, { now: NOW })).toEqual({ ok: false, code: "channel_account_unavailable" });
    const many = makeDb({ apps: [app(APP_ID, [{ id: ACCOUNT_ID, accountName: "a" }, { id: "99999999-9999-4999-8999-999999999999", accountName: "b" }])] });
    expect(await enqueueRevenueSync(asPrisma(many.db), INPUT, { now: NOW })).toEqual({ ok: false, code: "channel_account_ambiguous" });
    expect(none.db.$transaction).not.toHaveBeenCalled();
    expect(many.db.$transaction).not.toHaveBeenCalled();
  });

  it("同一账号已有 pending / processing 的收益同步任务 → revenue_sync_already_active（带现有任务 id），不建第二个", async () => {
    const { db } = makeDb({ active: { id: "existing-task" } });
    expect(await enqueueRevenueSync(asPrisma(db), INPUT, { now: NOW })).toEqual({
      ok: false, code: "revenue_sync_already_active", existingTaskId: "existing-task",
    });
    expect(db.$transaction).not.toHaveBeenCalled();
    const filter = db.genericTask.findFirst.mock.calls[0]![0].where;
    expect(filter).toMatchObject({
      taskType: REVENUE_SYNC_TASK_TYPE,
      channelAccountId: ACCOUNT_ID,
      channelAppId: null,
      operationScopeHash: revenueSyncOperationScopeHash(1),
      status: { in: ["pending", "processing"] },
    });
  });
});

describe("幂等", () => {
  const sameParams = { channelAccountId: ACCOUNT_ID, projectType: 1, beginDate: "2026-10-01", endDate: "2026-10-07", requestedBy: "admin-1" };

  it("同一个 requestToken、同一份请求再次提交 → 返回既有任务（duplicate），不建第二个", async () => {
    const { db } = makeDb({ byToken: { id: "task-1", taskType: REVENUE_SYNC_TASK_TYPE, params: sameParams } });
    expect(await enqueueRevenueSync(asPrisma(db), INPUT, { now: NOW })).toEqual({ ok: true, taskId: "task-1", duplicate: true });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("同一个 requestToken 却是另一份请求（不同区间 / 不同任务类型）→ request_token_conflict", async () => {
    const differentRange = makeDb({ byToken: { id: "task-1", taskType: REVENUE_SYNC_TASK_TYPE, params: { ...sameParams, beginDate: "2026-09-01" } } });
    expect(await enqueueRevenueSync(asPrisma(differentRange.db), INPUT, { now: NOW })).toEqual({
      ok: false, code: "request_token_conflict", existingTaskId: "task-1",
    });
    const differentType = makeDb({ byToken: { id: "task-2", taskType: "catalog_scan", params: sameParams } });
    expect(await enqueueRevenueSync(asPrisma(differentType.db), INPUT, { now: NOW })).toMatchObject({ ok: false, code: "request_token_conflict" });
  });

  it("并发下数据库唯一约束先到：同令牌 → 返回既有任务；活跃作用域冲突 → revenue_sync_already_active", async () => {
    const sameToken = makeDb({
      createError: uniqueViolation(),
      byTokenAfterConflict: { id: "task-9", taskType: REVENUE_SYNC_TASK_TYPE, params: sameParams },
    });
    expect(await enqueueRevenueSync(asPrisma(sameToken.db), INPUT, { now: NOW })).toEqual({ ok: true, taskId: "task-9", duplicate: true });

    const scopeConflict = makeDb({ createError: uniqueViolation() });
    scopeConflict.db.genericTask.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "task-active" } as never);
    expect(await enqueueRevenueSync(asPrisma(scopeConflict.db), INPUT, { now: NOW })).toEqual({
      ok: false, code: "revenue_sync_already_active", existingTaskId: "task-active",
    });
  });

  it("不是唯一约束冲突的错误原样抛出，不吞", async () => {
    const { db } = makeDb({ createError: new Error("connection reset") });
    await expect(enqueueRevenueSync(asPrisma(db), INPUT, { now: NOW })).rejects.toThrow("connection reset");
  });
});
