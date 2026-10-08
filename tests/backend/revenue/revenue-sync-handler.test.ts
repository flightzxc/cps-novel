import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { NovelRevenueAdapterError } from "@/lib/adapters/moboreader-revenue";
import { moboreaderUpstreamRateGate } from "@/lib/adapters/moboreader-rate-limit";
import type { TaskLease, TaskOutcome } from "@/lib/tasks";
import {
  REVENUE_SYNC_TARGET_TYPE,
  REVENUE_SYNC_TASK_TYPE,
  revenueBatchFingerprint,
  revenueRawDedupeKey,
} from "@/lib/tasks/revenue-sync";
import { createRevenueSyncHandler, createRevenueSyncWorkerHandlers } from "../../../worker/handlers/revenue-sync";

import { detailRow, fakeAggregateJwt, fakeStarJwt, totalRow } from "./support";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const ITEM_ID = "33333333-3333-4333-8333-333333333333";
const SCOPE_ID = "44444444-4444-4444-8444-444444444444";
const BATCH_ID = "55555555-5555-4555-8555-555555555555";
const CREDENTIAL_ID = "66666666-6666-4666-8666-666666666666";
const NOW = new Date("2026-10-08T04:00:00.000Z"); // 上海 12:00，今天 = 2026-10-08
const TOKEN = fakeStarJwt();

const PARAMS = {
  channelAccountId: ACCOUNT_ID,
  projectType: 1,
  beginDate: "2026-09-20",
  endDate: "2026-10-07",
  requestedBy: "admin-1",
} as const;

function lease(payload: unknown = PARAMS, mode: "apply" | "dry_run" = "apply"): TaskLease {
  return {
    family: "generic",
    taskType: REVENUE_SYNC_TASK_TYPE,
    targetType: REVENUE_SYNC_TARGET_TYPE,
    mode,
    itemId: ITEM_ID,
    taskId: TASK_ID,
    workerId: "worker-test",
    executionToken: "tok",
    leaseEpoch: 1n,
    attemptCount: 1,
    lockedUntil: new Date(NOW.getTime() + 30_000),
    payload,
  };
}

function makeDb(overrides: { task?: unknown; account?: unknown; scope?: unknown; credential?: unknown } = {}) {
  return {
    genericTask: {
      findUnique: vi.fn(async () =>
        "task" in overrides
          ? overrides.task
          : { taskType: REVENUE_SYNC_TASK_TYPE, channelAccountId: ACCOUNT_ID, channelApp: { projectType: 1 } }),
    },
    channelAccount: { findFirst: vi.fn(async () => ("account" in overrides ? overrides.account : { id: ACCOUNT_ID })) },
    revenueSyncScope: { findUnique: vi.fn(async () => ("scope" in overrides ? overrides.scope : null)) },
    channelAccountCredential: {
      findUnique: vi.fn(async () => ("credential" in overrides ? overrides.credential : { fingerprintPrefix: "abc123def456" })),
    },
  };
}

function makeTx() {
  const calls: Array<{ model: string; method: string; args: Record<string, any> }> = [];
  const record = (model: string, method: string, result: unknown) =>
    vi.fn(async (args: Record<string, any>) => {
      calls.push({ model, method, args });
      return typeof result === "function" ? (result as (a: unknown) => unknown)(args) : result;
    });
  const tx = {
    revenueSyncScope: { upsert: record("scope", "upsert", { id: SCOPE_ID, status: "active" }) },
    revenueSyncBatch: { upsert: record("batch", "upsert", { id: BATCH_ID }) },
    revenueRawSnapshot: { upsert: record("raw", "upsert", {}) },
    revenueDailyStat: { upsert: record("daily", "upsert", {}) },
    operationAudit: { create: record("audit", "create", {}) },
  };
  return { tx, calls };
}

const readyCredential = () => vi.fn(async () => ({
  status: "ready" as const,
  credentialId: CREDENTIAL_ID,
  secret: TOKEN,
  expiresAt: new Date("2100-01-01T00:00:00Z"),
  expiringSoon: false,
}));

function build(options: {
  rows?: unknown[];
  requestCount?: number;
  fetchReport?: ReturnType<typeof vi.fn>;
  secret?: string;
  db?: ReturnType<typeof makeDb>;
  resolveCredential?: ReturnType<typeof vi.fn>;
}) {
  const db = options.db ?? makeDb();
  const fetchReport = options.fetchReport
    ?? vi.fn(async () => ({ rows: options.rows ?? [], requestCount: options.requestCount ?? 1 }));
  const resolveCredential = options.resolveCredential
    ?? (options.secret
      ? vi.fn(async () => ({ status: "ready" as const, credentialId: CREDENTIAL_ID, secret: options.secret!, expiresAt: null, expiringSoon: false }))
      : readyCredential());
  const handler = createRevenueSyncHandler(db as unknown as PrismaClient, {
    now: () => NOW,
    env: {} as NodeJS.ProcessEnv,
    fetchReport: fetchReport as never,
    resolveCredential: resolveCredential as never,
  });
  return { db, fetchReport, resolveCredential, handler };
}

async function run(handler: ReturnType<typeof createRevenueSyncHandler>, theLease: TaskLease = lease()) {
  return handler({ lease: theLease, mode: theLease.mode, signal: new AbortController().signal, heartbeat: async () => true });
}

async function persist(outcome: TaskOutcome) {
  const { tx, calls } = makeTx();
  expect(outcome.protectedWrite).toBeTypeOf("function");
  await outcome.protectedWrite!(tx as never);
  return { tx, calls };
}

function noToken(value: unknown) {
  const serialized = JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
  expect(serialized).not.toContain(TOKEN);
  expect(serialized).not.toContain(TOKEN.split(".")[1]!);
  expect(serialized).not.toMatch(/Bearer\s+[A-Za-z0-9]/);
}

describe("成功路径：全部业务写入在 protectedWrite 里，顺序 scope → batch → raw → daily → audit", () => {
  const rows = [
    detailRow("2026-09-26", { realDevNum: 1, newRealDevNum: 1, realDevNumRate: "100%", realIncome: "28.88" }),
    detailRow("2026-09-27", { realDevNum: 5, newRealDevNum: 2, realDevNumRate: "40%", realIncome: "1.12" }),
    totalRow({ realDevNum: 6, newRealDevNum: 3, realIncome: "30.00" }),
  ];

  it("写入 scope / batch / 原始行（明细 + 总计）/ 日统计，批次记录凭证、指纹前缀、StarId、请求数、对账结论", async () => {
    const { handler, fetchReport } = build({ rows, requestCount: 1 });
    const outcome = await run(handler);

    expect(outcome.status).toBe("success");
    expect(outcome.result).toMatchObject({
      batchStatus: "completed",
      reconciliationStatus: "matched",
      requestCount: 1,
      detailRowCount: 2,
      totalRowCount: 1,
      beginDate: "2026-09-20",
      endDate: "2026-10-07",
    });
    // 读取点：数据库里没有产生任何写入，写入全部延后到 protectedWrite。
    expect(fetchReport).toHaveBeenCalledTimes(1);

    const { calls } = await persist(outcome);
    expect(calls.map((call) => `${call.model}.${call.method}`)).toEqual([
      "scope.upsert",
      "batch.upsert",
      "raw.upsert",
      "daily.upsert",
      "raw.upsert",
      "daily.upsert",
      "raw.upsert",
      "audit.create",
    ]);

    const scope = calls[0]!.args;
    expect(scope.where).toEqual({ channelAccountId_projectType: { channelAccountId: ACCOUNT_ID, projectType: 1 } });
    expect(scope.create).toEqual({ channelAccountId: ACCOUNT_ID, projectType: 1, status: "active" });

    const batch = calls[1]!.args;
    const fingerprint = revenueBatchFingerprint({
      scopeId: SCOPE_ID, projectType: 1, beginDate: "2026-09-20", endDate: "2026-10-07", genericTaskId: TASK_ID,
    });
    expect(batch.where).toEqual({ requestFingerprint: fingerprint });
    expect(batch.create).toMatchObject({
      revenueSyncScopeId: SCOPE_ID,
      genericTaskId: TASK_ID,
      beginDate: new Date("2026-09-20T00:00:00.000Z"),
      endDate: new Date("2026-10-07T00:00:00.000Z"),
      requestFingerprint: fingerprint,
      status: "completed",
      requestCount: 1,
      detailRowCount: 2,
      totalRowCount: 1,
      reconciliationStatus: "matched",
      credentialId: CREDENTIAL_ID,
      credentialFingerprintPrefix: "abc123def456",
      upstreamStarId: "335788",
      errorCode: null,
      errorMessage: null,
      requestedBy: "admin-1",
    });
    expect(batch.create.finishedAt).toEqual(NOW);
    expect(batch.update.status).toBe("completed");

    const rawCalls = calls.filter((call) => call.model === "raw").map((call) => call.args);
    expect(rawCalls).toHaveLength(3);
    expect(rawCalls[0]!.create).toMatchObject({
      syncBatchId: BATCH_ID, projectType: 1, dimension: "1", dimensionKey: "2026-09-26", isTotal: false,
      realDevNum: 1, newRealDevNum: 1, realDevNumRate: "1", realIncome: "28.88",
    });
    expect(rawCalls[0]!.where.dedupeKey).toBe(
      revenueRawDedupeKey({ kind: "detail", scopeId: SCOPE_ID, projectType: 1, dimension: "1", date: "2026-09-26" }),
    );
    expect(rawCalls[2]!.create).toMatchObject({ isTotal: true, dimensionKey: "总计", realIncome: "30" });
    expect(rawCalls[2]!.where.dedupeKey).toBe(
      revenueRawDedupeKey({
        kind: "total", scopeId: SCOPE_ID, projectType: 1, dimension: "1", dimensionKey: "总计",
        beginDate: "2026-09-20", endDate: "2026-10-07",
      }),
    );
    // 上游整行原样存档。
    expect(rawCalls[0]!.create.rawPayload).toEqual(rows[0]);

    const dailyCalls = calls.filter((call) => call.model === "daily").map((call) => call.args);
    expect(dailyCalls).toHaveLength(2);
    expect(dailyCalls[0]!.where).toEqual({
      revenueSyncScopeId_statDate: { revenueSyncScopeId: SCOPE_ID, statDate: new Date("2026-09-26T00:00:00.000Z") },
    });
    expect(dailyCalls[0]!.create).toMatchObject({
      revenueSyncScopeId: SCOPE_ID, realDevNum: 1, newRealDevNum: 1, realDevNumRate: "1", realIncome: "28.88", sourceBatchId: BATCH_ID,
    });
    expect(dailyCalls[1]!.update).toMatchObject({ realDevNum: 5, newRealDevNum: 2, realDevNumRate: "0.4", realIncome: "1.12" });

    const audit = calls.at(-1)!.args.data;
    expect(audit).toMatchObject({
      actorType: "worker", actorId: "worker-test", action: "revenue.sync.completed",
      entityType: "RevenueSyncBatch", entityId: BATCH_ID, taskId: TASK_ID,
    });
    noToken(calls);
    noToken(outcome);
  });

  it("上游请求用的是 readiness 解出的 token + 任务区间 + 共享限速闸；handler 本身没有任何固定 projectType 之外的入口", async () => {
    const { handler, fetchReport } = build({ rows });
    await run(handler);
    expect(fetchReport).toHaveBeenCalledWith(
      expect.objectContaining({
        token: TOKEN,
        beginDate: "2026-09-20",
        endDate: "2026-10-07",
        rateGate: moboreaderUpstreamRateGate,
      }),
    );
    const argument = fetchReport.mock.calls[0]![0] as Record<string, unknown>;
    expect(argument).not.toHaveProperty("projectType");
  });

  it("重复同步幂等：同一个任务两次 protectedWrite 得到完全相同的 where 键（upsert 身份不漂移）", async () => {
    const { handler } = build({ rows });
    const outcome = await run(handler);
    const first = await persist(outcome);
    const second = await persist(outcome);
    expect(second.calls.map((call) => call.args.where)).toEqual(first.calls.map((call) => call.args.where));
  });

  it("空列表 = completed 且明细 0 行（合法，不是失败）：只写 scope + batch + audit，没有原始行 / 日统计", async () => {
    const { handler } = build({ rows: [] });
    const outcome = await run(handler);
    expect(outcome.status).toBe("success");
    expect(outcome.result).toMatchObject({ batchStatus: "completed", detailRowCount: 0, totalRowCount: 0, reconciliationStatus: "not_applicable" });
    const { calls } = await persist(outcome);
    expect(calls.map((call) => `${call.model}.${call.method}`)).toEqual(["scope.upsert", "batch.upsert", "audit.create"]);
    expect(calls[1]!.args.create).toMatchObject({
      status: "completed", detailRowCount: 0, totalRowCount: 0, reconciliationStatus: "not_applicable", errorCode: null,
    });
  });

  it("明细合计与总计行对不上 → batch partial_failed + total_row_mismatch，数据仍然写入；条目仍是 success", async () => {
    const { handler } = build({
      rows: [detailRow("2026-09-26", { realIncome: "10.00" }), totalRow({ realIncome: "12.50" })],
    });
    const outcome = await run(handler);
    expect(outcome.status).toBe("success");
    expect(outcome.result).toMatchObject({ batchStatus: "partial_failed", reconciliationStatus: "mismatched" });
    const { calls } = await persist(outcome);
    expect(calls[1]!.args.create).toMatchObject({
      status: "partial_failed", reconciliationStatus: "mismatched", errorCode: "total_row_mismatch",
    });
    expect(calls[1]!.args.create.errorMessage).toContain("10");
    expect(calls[1]!.args.create.errorMessage).toContain("12.5");
    expect(calls.filter((call) => call.model === "daily")).toHaveLength(1);
    expect(calls.at(-1)!.args.data.action).toBe("revenue.sync.completed");
  });

  it("有被丢弃的坏日期行：批次仍 completed，error_message 里留一句提示，任务结果带计数", async () => {
    const { handler } = build({
      rows: [detailRow("2026-09-26"), { dimensionKey: "not-a-date", dimensionValue: "not-a-date" }, totalRow()],
    });
    const outcome = await run(handler);
    expect(outcome.result).toMatchObject({ batchStatus: "completed", droppedRowCount: 1 });
    const { calls } = await persist(outcome);
    expect(calls[1]!.args.create.status).toBe("completed");
    expect(calls[1]!.args.create.errorCode).toBeNull();
    expect(calls[1]!.args.create.errorMessage).toContain("1 upstream rows without a valid date were dropped");
  });
});

describe("失败路径：也在 protectedWrite 里落一条 failed 批次（脱敏、带错误码与凭证指纹前缀）", () => {
  it("上游错误 → 条目 failed，failed 批次带错误码与请求数，没有日统计 / 原始行", async () => {
    const error = new NovelRevenueAdapterError("upstream_http_error", 401);
    error.requestCount = 1;
    const { handler } = build({ fetchReport: vi.fn(async () => { throw error; }) });
    const outcome = await run(handler);

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toMatchObject({ code: "upstream_http_error" });
    const { calls } = await persist(outcome);
    expect(calls.map((call) => `${call.model}.${call.method}`)).toEqual(["scope.upsert", "batch.upsert", "audit.create"]);
    expect(calls[1]!.args.create).toMatchObject({
      status: "failed",
      errorCode: "upstream_http_error",
      requestCount: 1,
      detailRowCount: 0,
      totalRowCount: 0,
      reconciliationStatus: null,
      credentialId: CREDENTIAL_ID,
      credentialFingerprintPrefix: "abc123def456",
      upstreamStarId: "335788",
    });
    expect(calls[1]!.args.create.errorMessage).toContain("upstream_http_error");
    expect(calls.at(-1)!.args.data).toMatchObject({ action: "revenue.sync.failed", reason: "upstream_http_error" });
    noToken(calls);
    noToken(outcome);
  });

  it("凭证不是达人口径（聚合账号凭证）→ failed credential_not_star_scope，**零上游请求**", async () => {
    const aggregate = fakeAggregateJwt();
    const { handler, fetchReport } = build({ secret: aggregate });
    const outcome = await run(handler);

    expect(fetchReport).not.toHaveBeenCalled();
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toMatchObject({ code: "credential_not_star_scope" });
    const { calls } = await persist(outcome);
    expect(calls[1]!.args.create).toMatchObject({
      status: "failed", errorCode: "credential_not_star_scope", requestCount: 0,
      credentialId: CREDENTIAL_ID, credentialFingerprintPrefix: "abc123def456", upstreamStarId: null,
    });
    expect(JSON.stringify(calls)).not.toContain(aggregate);
    expect(JSON.stringify(outcome)).not.toContain(aggregate);
  });

  it.each([
    ["credential_missing"],
    ["credential_expired"],
    ["credential_ambiguous"],
    ["credential_validation_failed"],
    ["credential_invalid"],
  ])("凭证 not_ready (%s) → failed，错误码透传，不发上游请求，批次没有 credentialId", async (code) => {
    const resolveCredential = vi.fn(async () => ({ status: "not_ready" as const, code, message: "No usable credential" }));
    const { handler, fetchReport } = build({ resolveCredential });
    const outcome = await run(handler);
    expect(fetchReport).not.toHaveBeenCalled();
    expect(outcome.error).toMatchObject({ code });
    const { calls } = await persist(outcome);
    expect(calls[1]!.args.create).toMatchObject({ status: "failed", errorCode: code, credentialId: null, credentialFingerprintPrefix: null });
  });

  it("未预期的异常：批次里只有稳定错误码与泛化信息，不透传原始异常文本（哪怕里面带着 token）", async () => {
    const { handler } = build({ fetchReport: vi.fn(async () => { throw new Error(`boom Bearer ${TOKEN} ${TOKEN}`); }) });
    const outcome = await run(handler);
    expect(outcome.error).toMatchObject({ code: "revenue_sync_failed", message: "Revenue sync failed unexpectedly" });
    const { calls } = await persist(outcome);
    expect(calls[1]!.args.create.errorMessage).toBe("Revenue sync failed unexpectedly");
    noToken(calls);
    noToken(outcome);
  });

  it("适配器错误的 detail 里即使带着 token，写入批次 / 任务错误前也被遮蔽", async () => {
    const error = new NovelRevenueAdapterError("upstream_envelope_error", null, `business_error code=401 token ${TOKEN}`);
    const { handler } = build({ fetchReport: vi.fn(async () => { throw error; }) });
    const outcome = await run(handler);
    const { calls } = await persist(outcome);
    expect(calls[1]!.args.create.errorMessage).toContain("business_error");
    noToken(calls);
    noToken(outcome);
  });

  it("错误信息在批次里被截到 500 字符以内（varchar(500)）", async () => {
    const error = new NovelRevenueAdapterError("upstream_envelope_error", null, "x".repeat(5000));
    const { handler } = build({ fetchReport: vi.fn(async () => { throw error; }) });
    const { calls } = await persist(await run(handler));
    expect(calls[1]!.args.create.errorMessage.length).toBeLessThanOrEqual(500);
  });
});

describe("前置校验：不合规就不动上游，也不写批次（任务行 / 条目被改过时不知道该往哪个作用域写）", () => {
  it("dry_run 不支持：failed，没有 protectedWrite，不访问数据库", async () => {
    const { handler, db, fetchReport } = build({ rows: [] });
    const outcome = await run(handler, lease(PARAMS, "dry_run"));
    expect(outcome).toMatchObject({ status: "failed", error: { code: "revenue_sync_dry_run_unsupported" } });
    expect(outcome.protectedWrite).toBeUndefined();
    expect(fetchReport).not.toHaveBeenCalled();
    expect(db.genericTask.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ["projectType 被改成 2", { ...PARAMS, projectType: 2 }],
    ["区间反向", { ...PARAMS, beginDate: "2026-10-07", endDate: "2026-09-20" }],
    ["跨度 > 92 天", { ...PARAMS, beginDate: "2026-06-01", endDate: "2026-10-07" }],
    ["未来日期", { ...PARAMS, endDate: "2026-10-09" }],
    ["日期格式错", { ...PARAMS, beginDate: "2026/09/20" }],
    ["账号 id 不是 uuid", { ...PARAMS, channelAccountId: "nope" }],
    ["缺 requestedBy", { ...PARAMS, requestedBy: "" }],
    ["不是对象", "oops"],
    ["null", null],
  ])("参数非法（%s）→ failed revenue_sync_params_invalid，不发请求，不写批次", async (_name, payload) => {
    const { handler, fetchReport, db } = build({ rows: [] });
    const outcome = await run(handler, lease(payload));
    expect(outcome).toMatchObject({ status: "failed", error: { code: "revenue_sync_params_invalid" } });
    expect(outcome.protectedWrite).toBeUndefined();
    expect(fetchReport).not.toHaveBeenCalled();
    expect(db.genericTask.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ["任务行不存在", { task: null }],
    ["任务类型不对", { task: { taskType: "catalog_scan", channelAccountId: ACCOUNT_ID, channelApp: { projectType: 1 } } }],
    ["任务行账号与参数不一致", { task: { taskType: REVENUE_SYNC_TASK_TYPE, channelAccountId: "99999999-9999-4999-8999-999999999999", channelApp: { projectType: 1 } } }],
    ["绑定的 channel_app 不是网文 projectType", { task: { taskType: REVENUE_SYNC_TASK_TYPE, channelAccountId: ACCOUNT_ID, channelApp: { projectType: 2 } } }],
    ["没有绑定 channel_app", { task: { taskType: REVENUE_SYNC_TASK_TYPE, channelAccountId: ACCOUNT_ID, channelApp: null } }],
  ])("%s → revenue_sync_scope_invalid，不发请求，不写批次", async (_name, overrides) => {
    const { handler, fetchReport } = build({ db: makeDb(overrides) });
    const outcome = await run(handler);
    expect(outcome).toMatchObject({ status: "failed", error: { code: "revenue_sync_scope_invalid" } });
    expect(outcome.protectedWrite).toBeUndefined();
    expect(fetchReport).not.toHaveBeenCalled();
  });

  it("账号已不再 active / 已删除 → failed channel_account_unavailable（落批次），不读凭证、不发请求", async () => {
    const { handler, fetchReport, resolveCredential } = build({ db: makeDb({ account: null }) });
    const outcome = await run(handler);
    expect(outcome.error).toMatchObject({ code: "channel_account_unavailable" });
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(fetchReport).not.toHaveBeenCalled();
    const { calls } = await persist(outcome);
    expect(calls[1]!.args.create).toMatchObject({ status: "failed", errorCode: "channel_account_unavailable" });
  });

  it("作用域被停用 → failed revenue_scope_disabled（落批次），不读凭证、不发请求", async () => {
    const { handler, fetchReport, resolveCredential } = build({ db: makeDb({ scope: { status: "disabled" } }) });
    const outcome = await run(handler);
    expect(outcome.error).toMatchObject({ code: "revenue_scope_disabled" });
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(fetchReport).not.toHaveBeenCalled();
    const { calls } = await persist(outcome);
    expect(calls[1]!.args.create).toMatchObject({ status: "failed", errorCode: "revenue_scope_disabled" });
  });
});

describe("注册", () => {
  it("任务类型 moboreader.revenue_sync.v1：family generic、maxAttempts 1", () => {
    const registry = createRevenueSyncWorkerHandlers({} as PrismaClient);
    expect(Object.keys(registry)).toEqual(["moboreader.revenue_sync.v1"]);
    expect(registry["moboreader.revenue_sync.v1"]).toMatchObject({ family: "generic", maxAttempts: 1 });
    expect(REVENUE_SYNC_TASK_TYPE).toBe("moboreader.revenue_sync.v1");
  });
});
