/**
 * 收益看板（账号级每日汇总）的真实 PostgreSQL 验收。
 *
 * 🔴 角色真实：这个项目出过两次“单测与复核都测不出来的角色权限缺口”事故，所以：
 *   - `worker_app` 真实连接，跑 handler 的 protectedWrite 全链路（scope upsert → 批次 → 原始行 upsert →
 *     日统计 upsert → 审计，含重复同步幂等）以及经真实 `processOneWorkerCycle` 的整条领取 / 执行 / 终态链路——
 *     任何一处缺授权都是 `permission denied`；
 *   - `web_app` 真实连接，跑 `loadRevenueDashboard` 与入队函数；并证明 web 对四表 INSERT / UPDATE / DELETE 都被拒；
 *   - 唯一约束、CHECK、外键删除策略在真实库上生效。
 *
 * 运行方式：`scripts/run-revenue-dashboard-postgres-verification.sh`（一次性 postgres:16.14，真实迁移 +
 * `infra/postgres/grants.sql`，skipped=0 硬断言）。直接 `vitest run` 本文件而不设
 * `REVENUE_DASHBOARD_DATABASE_TEST=1` 时整个文件跳过。
 */
import { randomUUID } from "node:crypto";

import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { fetchNovelDailyReport } from "@/lib/adapters/moboreader-revenue";
import { buildWorkerAllowlist, createHandlerRegistry, type TaskLease } from "@/lib/tasks";
import { isUniqueConstraintViolation } from "@/lib/db/db-retry";
import { REVENUE_SYNC_TARGET_TYPE, REVENUE_SYNC_TASK_TYPE, addDaysToDate, shanghaiToday } from "@/lib/tasks/revenue-sync";
import { enqueueRevenueSync, loadRevenueDashboard } from "@/server/revenue";
import { encryptCredentialSecretForWorker } from "../../../worker/credentials/crypto";
import { createRevenueSyncHandler, createRevenueSyncWorkerHandlers } from "../../../worker/handlers/revenue-sync";
import { processOneWorkerCycle } from "../../../worker/runtime/worker";

import { detailRow, envelope, fakeAggregateJwt, fakeStarJwt, jsonResponse, totalRow } from "../../backend/revenue/support";

const enabled = process.env.REVENUE_DASHBOARD_DATABASE_TEST === "1";
const owner = new PrismaClient({ datasourceUrl: process.env.REVENUE_DASHBOARD_OWNER_DATABASE_URL });
const web = new PrismaClient({ datasourceUrl: process.env.REVENUE_DASHBOARD_WEB_DATABASE_URL });
const worker = new PrismaClient({ datasourceUrl: process.env.REVENUE_DASHBOARD_WORKER_DATABASE_URL });
const analyst = new PrismaClient({ datasourceUrl: process.env.REVENUE_DASHBOARD_ANALYST_DATABASE_URL });
const scheduler = new PrismaClient({ datasourceUrl: process.env.REVENUE_DASHBOARD_SCHEDULER_DATABASE_URL });

const REVENUE_TABLES = ["revenue_sync_scope", "revenue_sync_batch", "revenue_raw_snapshot", "revenue_daily_stat"] as const;
const ADMIN = "revenue-admin-1";
const TODAY = shanghaiToday();
const END = TODAY;
const BEGIN = addDaysToDate(TODAY, -6);
const D1 = addDaysToDate(TODAY, -1);
const D2 = addDaysToDate(TODAY, -2);
const D3 = addDaysToDate(TODAY, -3);

let foundation: { channel: string; app: string; account: string };

async function resetDatabase(options: { credentialJwt?: string } = {}): Promise<void> {
  const [{ name, version }] = await owner.$queryRaw<Array<{ name: string; version: string }>>`
    SELECT current_database() AS name, current_setting('server_version') AS version`;
  if (!name.startsWith("cps_novel_revenue_dashboard_") || !version.startsWith("16.14")) {
    throw new Error(`Refusing revenue-dashboard setup against ${name} (${version})`);
  }
  const tables = await owner.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await owner.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(",")} RESTART IDENTITY CASCADE`);
  const channel = await owner.channel.create({ data: { code: "changdu", name: "local" } });
  const sourceApp = await owner.sourceApp.create({ data: { code: "moboreader", name: "local" } });
  const app = await owner.channelApp.create({
    data: { channelId: channel.id, sourceAppId: sourceApp.id, externalAppId: "local", projectType: 1 },
  });
  const account = await addAccount(channel.id, "chenweifeng@qq.com", options.credentialJwt ?? fakeStarJwt());
  foundation = { channel: channel.id, app: app.id, account };
}

async function addAccount(channelId: string, accountName: string, jwt?: string): Promise<string> {
  const created = await owner.channelAccount.create({ data: { channelId, businessId: randomUUID(), accountName } });
  if (jwt) await setCredential(created.id, jwt);
  return created.id;
}

async function setCredential(accountId: string, jwt: string, fingerprintPrefix = "abc123def456"): Promise<string> {
  await owner.channelAccountCredential.updateMany({ where: { channelAccountId: accountId, status: "active" }, data: { status: "superseded" } });
  const id = randomUUID();
  await owner.channelAccountCredential.create({
    data: {
      id,
      channelAccountId: accountId,
      encryptedSecret: new Uint8Array(encryptCredentialSecretForWorker(jwt, accountId, id, 1)),
      keyVersion: 1,
      secretFingerprint: `hmac-sha256:v1:${randomUUID().replace(/-/g, "").padEnd(64, "a")}`,
      fingerprintPrefix,
      status: "active",
      expiresAt: new Date("2100-01-01T00:00:00Z"),
    },
  });
  return id;
}

/** 上游桩：真实适配器（分页、信封校验、对账前的解析）跑真实代码，只有网络层被替换。 */
function upstream(rows: unknown[] | (() => Response | Promise<Response>)) {
  const calls: Array<Record<string, unknown>> = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return typeof rows === "function" ? rows() : jsonResponse(envelope(rows));
  }) as unknown as typeof fetch;
  const fetchReport = vi.fn((input: Parameters<typeof fetchNovelDailyReport>[0]) =>
    fetchNovelDailyReport({ ...input, rateGate: undefined, onUpstreamObservation: undefined, fetchImpl }));
  return { fetchImpl, fetchReport, calls };
}

function registryWith(fetchReport: ReturnType<typeof upstream>["fetchReport"]) {
  return createRevenueSyncWorkerHandlers(worker, { fetchReport: fetchReport as never });
}

async function cycle(types: string, registry: ReturnType<typeof createHandlerRegistry>): Promise<boolean> {
  return processOneWorkerCycle({
    prisma: worker,
    workerId: "revenue-worker-test",
    handlers: registry,
    allowlist: buildWorkerAllowlist(types, registry),
    signal: new AbortController().signal,
  });
}

async function enqueue(overrides: Partial<Parameters<typeof enqueueRevenueSync>[1]> = {}) {
  return enqueueRevenueSync(web, { beginDate: BEGIN, endDate: END, requestToken: randomUUID(), actor: ADMIN, ...overrides });
}

async function enqueueOk(overrides: Partial<Parameters<typeof enqueueRevenueSync>[1]> = {}): Promise<string> {
  const result = await enqueue(overrides);
  if (!result.ok) throw new Error(`enqueue failed: ${result.code}`);
  return result.taskId;
}

/** 直接调用 handler，并像 finalizeTaskItem 那样以 worker_app 在事务里执行 protectedWrite。 */
async function runHandlerDirect(
  taskId: string,
  fetchReport: ReturnType<typeof upstream>["fetchReport"],
  options: { applyTwice?: boolean } = {},
) {
  const item = await owner.genericTaskItem.findFirstOrThrow({ where: { taskId } });
  const handler = createRevenueSyncHandler(worker, { fetchReport: fetchReport as never });
  const lease: TaskLease = {
    family: "generic",
    taskType: REVENUE_SYNC_TASK_TYPE,
    targetType: REVENUE_SYNC_TARGET_TYPE,
    mode: "apply",
    itemId: item.id,
    taskId,
    workerId: "revenue-worker-test",
    executionToken: randomUUID(),
    leaseEpoch: 1n,
    attemptCount: 1,
    lockedUntil: new Date(Date.now() + 60_000),
    payload: item.payload,
  };
  const outcome = await handler({ lease, mode: "apply", signal: new AbortController().signal, heartbeat: async () => true });
  if (outcome.protectedWrite) {
    await worker.$transaction(async (tx) => { await outcome.protectedWrite!(tx); });
    if (options.applyTwice) await worker.$transaction(async (tx) => { await outcome.protectedWrite!(tx); });
  }
  return outcome;
}

const count = async (table: string) =>
  Number((await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM ${table}`))[0]!.n);

async function expectDbError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await expect(promise).rejects.toThrow(pattern);
}

describe.skipIf(!enabled)("收益看板 · 真实 PostgreSQL（worker_app 写、web_app 读与入队）", () => {
  beforeAll(async () => {
    const roles = await Promise.all([owner, web, worker, analyst, scheduler].map(
      async (client) => (await client.$queryRaw<Array<{ role: string }>>`SELECT current_user AS role`)[0]!.role,
    ));
    expect(roles).toEqual(["migration_owner", "web_app", "worker_app", "analyst_ro", "scheduler_app"]);
  });

  afterAll(async () => {
    await Promise.all([owner, web, worker, analyst, scheduler].map((client) => client.$disconnect()));
  });

  describe("全链路：web_app 入队 → worker_app 经真实 processOneWorkerCycle 领取执行 → web_app 读服务", () => {
    it("成功路径：写入 scope / 批次 / 原始行 / 日统计 / 审计，无 permission denied；读服务拿到三态与精确金额", async () => {
      await resetDatabase();
      const taskId = await enqueueOk();
      const task = await owner.genericTask.findUniqueOrThrow({ where: { id: taskId }, include: { items: true } });
      expect(task).toMatchObject({
        taskType: REVENUE_SYNC_TASK_TYPE, status: "pending", mode: "apply",
        channelAccountId: foundation.account, channelAppId: foundation.app, totalCount: 1,
      });
      expect(task.items).toHaveLength(1);
      expect(task.items[0]).toMatchObject({ targetType: REVENUE_SYNC_TARGET_TYPE, status: "pending" });
      expect(task.params).toEqual({ channelAccountId: foundation.account, projectType: 1, beginDate: BEGIN, endDate: END, requestedBy: ADMIN });
      expect(task.items[0]!.payload).toEqual(task.params);

      const { fetchReport, calls } = upstream([
        detailRow(D1, { realDevNum: 5, newRealDevNum: 2, realDevNumRate: "40%", realIncome: "28.88" }),
        detailRow(D2, { realDevNum: 7, newRealDevNum: 3, realDevNumRate: "28.27%", realIncome: "1.12" }),
        totalRow({ realIncome: "30.00" }),
      ]);
      const registry = registryWith(fetchReport);
      expect(await cycle(REVENUE_SYNC_TASK_TYPE, registry)).toBe(true);

      // 上游请求只发了一次，且带 projectType:1。
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ projectType: 1, dimensions: ["1"], pageSize: 999, pageIndex: 1, beginTime: BEGIN, endTime: END });

      const finished = await owner.genericTask.findUniqueOrThrow({ where: { id: taskId }, include: { items: true } });
      expect(finished.status).toBe("completed");
      expect(finished.items[0]).toMatchObject({ status: "success" });
      expect(finished.items[0]!.result).toMatchObject({ batchStatus: "completed", reconciliationStatus: "matched", detailRowCount: 2, totalRowCount: 1 });
      expect(JSON.stringify(finished, (_key, value) => (typeof value === "bigint" ? value.toString() : value))).not.toContain(fakeStarJwt());

      const scope = await owner.revenueSyncScope.findUniqueOrThrow({
        where: { channelAccountId_projectType: { channelAccountId: foundation.account, projectType: 1 } },
      });
      expect(scope.status).toBe("active");
      const batches = await owner.revenueSyncBatch.findMany();
      expect(batches).toHaveLength(1);
      const batch = batches[0]!;
      expect(batch).toMatchObject({
        revenueSyncScopeId: scope.id, genericTaskId: taskId, status: "completed", requestCount: 1, detailRowCount: 2, totalRowCount: 1,
        reconciliationStatus: "matched", credentialFingerprintPrefix: "abc123def456", upstreamStarId: "335788",
        errorCode: null, errorMessage: null, requestedBy: ADMIN,
      });
      expect(batch.credentialId).not.toBeNull();
      expect(batch.finishedAt).not.toBeNull();
      expect(batch.beginDate.toISOString().slice(0, 10)).toBe(BEGIN);
      expect(batch.endDate.toISOString().slice(0, 10)).toBe(END);

      const raws = await owner.revenueRawSnapshot.findMany({ orderBy: { isTotal: "asc" } });
      expect(raws).toHaveLength(3);
      expect(raws.filter((row) => row.isTotal)).toHaveLength(1);
      expect(raws.every((row) => row.syncBatchId === batch.id && row.projectType === 1 && row.dimension === "1")).toBe(true);
      expect(raws.find((row) => row.dimensionKey === D1)?.realIncome?.toFixed(4)).toBe("28.8800");

      const stats = await owner.revenueDailyStat.findMany({ orderBy: { statDate: "asc" } });
      expect(stats).toHaveLength(2);
      expect(stats.map((stat) => stat.statDate.toISOString().slice(0, 10))).toEqual([D2, D1]);
      const d1 = stats.find((stat) => stat.statDate.toISOString().slice(0, 10) === D1)!;
      expect(d1).toMatchObject({ revenueSyncScopeId: scope.id, realDevNum: 5, newRealDevNum: 2, sourceBatchId: batch.id });
      expect(d1.realIncome?.toFixed(4)).toBe("28.8800");
      expect(d1.realDevNumRate?.toFixed()).toBe("0.4");

      const audits = await owner.operationAudit.findMany({ where: { action: { startsWith: "revenue.sync." } }, orderBy: { id: "asc" } });
      expect(audits.map((audit) => audit.action)).toEqual(["revenue.sync.queued", "revenue.sync.completed"]);

      // web_app 读服务：三态 + 精确金额 + 凭证元数据 + 脱敏标签。
      const view = await loadRevenueDashboard(web, { dateFrom: BEGIN, dateTo: END });
      expect(view.account).toEqual({ id: foundation.account, label: "ch***@qq.com" });
      expect(view.days).toHaveLength(7);
      const byDate = Object.fromEntries(view.days.map((day) => [day.date, day]));
      expect(byDate[D1]).toEqual({ date: D1, coverage: "reported", activeUsers: 5, newUsers: 2, newUserRatio: "0.4", shareIncomeUsd: "28.8800" });
      expect(byDate[D2]).toMatchObject({ coverage: "reported", newUserRatio: "0.2827", shareIncomeUsd: "1.1200" });
      expect(byDate[D3]).toEqual({ date: D3, coverage: "no_upstream_row", activeUsers: 0, newUsers: 0, newUserRatio: null, shareIncomeUsd: "0.0000" });
      expect(byDate[END]).toMatchObject({ coverage: "no_upstream_row" });
      expect(view.summary).toMatchObject({ shareIncomeUsdTotal: "30.0000", newUsersTotal: 5, reportedDays: 2, noUpstreamRowDays: 5, notSyncedDays: 0 });
      expect(view.batches).toHaveLength(1);
      expect(view.batches[0]).toMatchObject({ id: batch.id, status: "completed", upstreamStarId: "335788", credentialFingerprintPrefix: "abc123def456", genericTaskId: taskId });
      expect(view.activeTask).toBeNull();
      expect(view.credential).toMatchObject({ status: "active" });
      expect(view.credential?.expiresAt).toBe("2100-01-01T00:00:00.000Z");
      expect(view.lastSuccessfulSyncAt).not.toBeNull();
      // 区间之外（比批次覆盖更早的日子）仍是“未同步”，不会被当成 0。
      const wider = await loadRevenueDashboard(web, { dateFrom: addDaysToDate(BEGIN, -3), dateTo: END });
      expect(wider.days.filter((day) => day.coverage === "not_synced")).toHaveLength(3);
    });

    it("重复同步（回补）幂等：同一天只有一行，数值被新批次覆盖；原始行与日统计指向最新批次；批次各自保留", async () => {
      await resetDatabase();
      const first = upstream([detailRow(D1, { realDevNum: 5, newRealDevNum: 2, realIncome: "10.00" }), totalRow({ realIncome: "10.00" })]);
      await enqueueOk();
      await cycle(REVENUE_SYNC_TASK_TYPE, registryWith(first.fetchReport));

      const second = upstream([
        detailRow(D1, { realDevNum: 9, newRealDevNum: 4, realIncome: "12.50" }),
        detailRow(D2, { realDevNum: 1, newRealDevNum: 1, realIncome: "0.5" }),
        totalRow({ realIncome: "13.00" }),
      ]);
      await enqueueOk();
      await cycle(REVENUE_SYNC_TASK_TYPE, registryWith(second.fetchReport));

      expect(await count("revenue_sync_scope")).toBe(1);
      expect(await count("revenue_sync_batch")).toBe(2);
      expect(await count("revenue_daily_stat")).toBe(2);
      expect(await count("revenue_raw_snapshot")).toBe(3);
      const batches = await owner.revenueSyncBatch.findMany({ orderBy: { createdAt: "asc" } });
      const latest = batches[1]!;
      const d1 = await owner.revenueDailyStat.findFirstOrThrow({ where: { statDate: new Date(`${D1}T00:00:00.000Z`) } });
      expect(d1).toMatchObject({ realDevNum: 9, newRealDevNum: 4, sourceBatchId: latest.id });
      expect(d1.realIncome?.toFixed(4)).toBe("12.5000");
      const raws = await owner.revenueRawSnapshot.findMany();
      expect(raws.every((row) => row.syncBatchId === latest.id)).toBe(true);
      expect(raws.find((row) => row.isTotal)?.realIncome?.toFixed(4)).toBe("13.0000");
    });

    it("同一个任务的 protectedWrite 重复执行（事务重试 / 租约重放）幂等：行数不变、批次只有一条", async () => {
      await resetDatabase();
      const taskId = await enqueueOk();
      const { fetchReport } = upstream([detailRow(D1, { realIncome: "3.10" }), detailRow(D2, { realIncome: "0.40" }), totalRow({ realIncome: "3.50" })]);
      const outcome = await runHandlerDirect(taskId, fetchReport, { applyTwice: true });
      expect(outcome.status).toBe("success");
      expect(await count("revenue_sync_scope")).toBe(1);
      expect(await count("revenue_sync_batch")).toBe(1);
      expect(await count("revenue_raw_snapshot")).toBe(3);
      expect(await count("revenue_daily_stat")).toBe(2);
    });

    it("空列表 = completed，明细 0 行，不写日统计；读服务仍把整个区间判为“上游无记录”而不是“未同步”", async () => {
      await resetDatabase();
      const taskId = await enqueueOk();
      const { fetchReport } = upstream([]);
      const outcome = await runHandlerDirect(taskId, fetchReport);
      expect(outcome.status).toBe("success");
      const batch = await owner.revenueSyncBatch.findFirstOrThrow();
      expect(batch).toMatchObject({ status: "completed", detailRowCount: 0, totalRowCount: 0, reconciliationStatus: "not_applicable", requestCount: 1 });
      expect(await count("revenue_daily_stat")).toBe(0);
      const view = await loadRevenueDashboard(web, { dateFrom: BEGIN, dateTo: END });
      expect(view.days.every((day) => day.coverage === "no_upstream_row")).toBe(true);
      expect(view.summary).toMatchObject({ reportedDays: 0, noUpstreamRowDays: 7, notSyncedDays: 0, avgActiveUsers: "0.00", shareIncomeUsdTotal: "0.0000" });
    });

    it("明细合计与总计行对不上 → partial_failed + total_row_mismatch，数据仍写入；读服务把区间算作已覆盖", async () => {
      await resetDatabase();
      const taskId = await enqueueOk();
      const { fetchReport } = upstream([detailRow(D1, { realIncome: "10.00" }), totalRow({ realIncome: "12.50" })]);
      await runHandlerDirect(taskId, fetchReport);
      const batch = await owner.revenueSyncBatch.findFirstOrThrow();
      expect(batch).toMatchObject({ status: "partial_failed", reconciliationStatus: "mismatched", errorCode: "total_row_mismatch" });
      expect(await count("revenue_daily_stat")).toBe(1);
      const view = await loadRevenueDashboard(web, { dateFrom: BEGIN, dateTo: END });
      expect(view.batches[0]).toMatchObject({ status: "partial_failed", errorCode: "total_row_mismatch" });
      expect(view.summary.notSyncedDays).toBe(0);
    });
  });

  describe("失败路径：也在 protectedWrite 里（以 worker_app）落一条脱敏的 failed 批次", () => {
    it("凭证不是达人口径（聚合账号凭证）→ credential_not_star_scope，零上游请求，批次记录凭证指纹前缀", async () => {
      await resetDatabase({ credentialJwt: fakeAggregateJwt() });
      const taskId = await enqueueOk();
      const { fetchReport, fetchImpl } = upstream([detailRow(D1)]);
      const outcome = await runHandlerDirect(taskId, fetchReport);

      expect(outcome.status).toBe("failed");
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(fetchReport).not.toHaveBeenCalled();
      const batch = await owner.revenueSyncBatch.findFirstOrThrow();
      expect(batch).toMatchObject({
        status: "failed", errorCode: "credential_not_star_scope", requestCount: 0, upstreamStarId: null,
        credentialFingerprintPrefix: "abc123def456", reconciliationStatus: null,
      });
      expect(batch.credentialId).not.toBeNull();
      expect(batch.finishedAt).not.toBeNull();
      expect(JSON.stringify(batch)).not.toContain(fakeAggregateJwt());
      expect(await count("revenue_daily_stat")).toBe(0);
      expect(await count("revenue_raw_snapshot")).toBe(0);
      const view = await loadRevenueDashboard(web, { dateFrom: BEGIN, dateTo: END });
      // failed 批次不算覆盖：整个区间仍是“未同步”。
      expect(view.days.every((day) => day.coverage === "not_synced")).toBe(true);
      expect(view.batches[0]).toMatchObject({ status: "failed", errorCode: "credential_not_star_scope" });
    });

    it("上游 401 → failed 批次带 upstream_http_error 与请求数，没有写入任何日统计", async () => {
      await resetDatabase();
      const taskId = await enqueueOk();
      const { fetchReport } = upstream(() => jsonResponse({ message: `Bearer ${fakeStarJwt()}` }, { status: 401 }));
      const outcome = await runHandlerDirect(taskId, fetchReport);
      expect(outcome).toMatchObject({ status: "failed", error: { code: "upstream_http_error" } });
      const batch = await owner.revenueSyncBatch.findFirstOrThrow();
      expect(batch).toMatchObject({ status: "failed", errorCode: "upstream_http_error", requestCount: 1, upstreamStarId: "335788" });
      expect(batch.errorMessage).toContain("upstream_http_error");
      expect(JSON.stringify(batch)).not.toContain(fakeStarJwt());
      expect(await count("revenue_daily_stat")).toBe(0);
    });

    it("没有 active 凭证 → 错误码透传（credential_missing），批次没有 credential_id", async () => {
      await resetDatabase();
      await owner.channelAccountCredential.updateMany({ data: { status: "superseded" } });
      const taskId = await enqueueOk();
      const { fetchReport } = upstream([]);
      await runHandlerDirect(taskId, fetchReport);
      const batch = await owner.revenueSyncBatch.findFirstOrThrow();
      expect(batch).toMatchObject({ status: "failed", errorCode: "credential_missing", credentialId: null, credentialFingerprintPrefix: null });
      expect(fetchReport).not.toHaveBeenCalled();
    });

    it("经真实 processOneWorkerCycle：失败条目也能终态化（任务 failed）并留下 failed 批次", async () => {
      await resetDatabase({ credentialJwt: fakeAggregateJwt() });
      const taskId = await enqueueOk();
      const { fetchReport } = upstream([]);
      expect(await cycle(REVENUE_SYNC_TASK_TYPE, registryWith(fetchReport))).toBe(true);
      const task = await owner.genericTask.findUniqueOrThrow({ where: { id: taskId }, include: { items: true } });
      expect(task.status).toBe("failed");
      expect(task.items[0]).toMatchObject({ status: "failed" });
      expect(task.items[0]!.error).toMatchObject({ code: "credential_not_star_scope" });
      expect((await owner.revenueSyncBatch.findFirstOrThrow()).errorCode).toBe("credential_not_star_scope");
    });
  });

  describe("入队（web_app 真实角色）", () => {
    it("同一账号同一时刻只有一个活跃任务：第二次返回 revenue_sync_already_active + 现有任务 id；同令牌重复提交返回同一个任务", async () => {
      await resetDatabase();
      const requestToken = randomUUID();
      const first = await enqueue({ requestToken });
      expect(first).toMatchObject({ ok: true, duplicate: false });
      const again = await enqueue({ requestToken });
      expect(again).toEqual({ ok: true, taskId: (first as { taskId: string }).taskId, duplicate: true });
      const second = await enqueue({ beginDate: D3 });
      expect(second).toEqual({ ok: false, code: "revenue_sync_already_active", existingTaskId: (first as { taskId: string }).taskId });
      expect(await owner.genericTask.count({ where: { taskType: REVENUE_SYNC_TASK_TYPE } })).toBe(1);
      const audits = await owner.operationAudit.count({ where: { action: "revenue.sync.queued" } });
      expect(audits).toBe(1);
      // 同令牌却是另一份请求。
      expect(await enqueue({ requestToken, beginDate: D3 })).toMatchObject({ ok: false, code: "request_token_conflict" });
    });

    it("活跃作用域唯一索引在数据库层兜底：绕过应用层先查，直接插第二个 pending 任务被 23505 拒绝", async () => {
      await resetDatabase();
      const taskId = await enqueueOk();
      const existing = await owner.genericTask.findUniqueOrThrow({ where: { id: taskId } });
      await expect(
        owner.genericTask.create({
          data: {
            taskType: REVENUE_SYNC_TASK_TYPE, channelAccountId: existing.channelAccountId, channelAppId: existing.channelAppId,
            operationScopeHash: existing.operationScopeHash, requestToken: randomUUID(), status: "pending",
          },
        }),
      ).rejects.toSatisfy(isUniqueConstraintViolation);
    });

    it("任务进入终态后可以再次入队；账号变得不唯一 → channel_account_ambiguous；停用后恢复", async () => {
      await resetDatabase();
      const firstId = await enqueueOk();
      await owner.genericTask.update({ where: { id: firstId }, data: { status: "completed" } });
      expect(await enqueue()).toMatchObject({ ok: true });
      await owner.genericTask.updateMany({ where: { status: "pending" }, data: { status: "completed" } });

      const second = await addAccount(foundation.channel, "second@example.com");
      expect(await enqueue()).toEqual({ ok: false, code: "channel_account_ambiguous" });
      await owner.channelAccount.update({ where: { id: second }, data: { status: "disabled" } });
      expect(await enqueue()).toMatchObject({ ok: true });
      await owner.genericTask.updateMany({ where: { status: "pending" }, data: { status: "completed" } });
      await owner.channelAccount.update({ where: { id: foundation.account }, data: { deletedAt: new Date() } });
      expect(await enqueue()).toEqual({ ok: false, code: "channel_account_unavailable" });
      // 读服务在“没有唯一账号”时照常返回，只是每一天都是未同步。
      const view = await loadRevenueDashboard(web, { dateFrom: BEGIN, dateTo: END });
      expect(view.account).toBeNull();
      expect(view.days.every((day) => day.coverage === "not_synced")).toBe(true);
    });

    it("非法区间在数据库之前就被拒绝；任务行里没有任何凭证字段", async () => {
      await resetDatabase();
      expect(await enqueue({ endDate: addDaysToDate(TODAY, 1) })).toEqual({ ok: false, code: "invalid_date_range" });
      expect(await enqueue({ beginDate: addDaysToDate(TODAY, -100) })).toEqual({ ok: false, code: "invalid_date_range" });
      expect(await owner.genericTask.count()).toBe(0);
      await enqueueOk();
      const task = await owner.genericTask.findFirstOrThrow();
      expect(JSON.stringify(task)).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}|Bearer\s|secret|encrypted/i);
    });
  });

  describe("现状：任务类型不在主通道白名单里", () => {
    it("worker 不会领取：任务一直 pending、没有任何报错，后续入队被 revenue_sync_already_active 挡住，读服务能看到活跃任务", async () => {
      await resetDatabase();
      const taskId = await enqueueOk();
      const { fetchReport } = upstream([]);
      // 注册表里有这个类型的 handler，另外还有一个别的类型；白名单只写了别的类型（部署时漏配的情形）。
      const registry = createHandlerRegistry({
        ...registryWith(fetchReport),
        "other.task.v1": { family: "generic", handler: async () => ({ status: "success" as const }) },
      });
      expect(await cycle("other.task.v1", registry)).toBe(false);
      expect(await cycle("", registry)).toBe(false);
      expect(fetchReport).not.toHaveBeenCalled();
      const task = await owner.genericTask.findUniqueOrThrow({ where: { id: taskId }, include: { items: true } });
      expect(task.status).toBe("pending");
      expect(task.items[0]!.status).toBe("pending");
      expect(task.error).toBeNull();
      expect(await enqueue({ beginDate: D3 })).toEqual({ ok: false, code: "revenue_sync_already_active", existingTaskId: taskId });
      const view = await loadRevenueDashboard(web, { dateFrom: BEGIN, dateTo: END });
      expect(view.activeTask).toMatchObject({ id: taskId, status: "pending" });
      // 补上白名单之后，同一个任务被正常领取执行。
      expect(await cycle(REVENUE_SYNC_TASK_TYPE, registry)).toBe(true);
      expect((await owner.genericTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe("completed");
    });
  });

  describe("授权与角色边界（真实角色）", () => {
    it("web_app：四表只读——SELECT 成功，INSERT / UPDATE / DELETE 都是 permission denied", async () => {
      await resetDatabase();
      const taskId = await enqueueOk();
      await runHandlerDirect(taskId, upstream([detailRow(D1, { realIncome: "1.00" }), totalRow({ realIncome: "1.00" })]).fetchReport);
      for (const table of REVENUE_TABLES) {
        await expect(web.$queryRawUnsafe(`SELECT count(*) FROM ${table}`)).resolves.toBeDefined();
        await expectDbError(web.$executeRawUnsafe(`DELETE FROM ${table}`), /42501|permission denied/i);
        await expectDbError(web.$executeRawUnsafe(`UPDATE ${table} SET updated_at = now()`), /42501|permission denied/i);
      }
      await expectDbError(
        web.$executeRawUnsafe(`INSERT INTO revenue_sync_scope (id, channel_account_id, project_type, updated_at) VALUES (gen_random_uuid(), '${foundation.account}', 2, now())`),
        /42501|permission denied/i,
      );
      const scope = await owner.revenueSyncScope.findFirstOrThrow();
      await expectDbError(
        web.$executeRawUnsafe(
          `INSERT INTO revenue_sync_batch (id, revenue_sync_scope_id, begin_date, end_date, request_fingerprint, requested_by, updated_at) VALUES (gen_random_uuid(), '${scope.id}', '${BEGIN}', '${END}', 'web-forged', 'x', now())`,
        ),
        /42501|permission denied/i,
      );
      const batch = await owner.revenueSyncBatch.findFirstOrThrow();
      await expectDbError(
        web.$executeRawUnsafe(
          `INSERT INTO revenue_raw_snapshot (id, sync_batch_id, project_type, dimension, dimension_key, raw_payload, dedupe_key, updated_at) VALUES (gen_random_uuid(), '${batch.id}', 1, '1', 'k', '{}', 'web-forged', now())`,
        ),
        /42501|permission denied/i,
      );
      await expectDbError(
        web.$executeRawUnsafe(
          `INSERT INTO revenue_daily_stat (id, revenue_sync_scope_id, stat_date, source_batch_id, updated_at) VALUES (gen_random_uuid(), '${scope.id}', '${D3}', '${batch.id}', now())`,
        ),
        /42501|permission denied/i,
      );
      // 模型层调用同样被拒（真实代码路径是 Prisma 模型调用）。
      await expectDbError(web.revenueDailyStat.deleteMany({}) as unknown as Promise<unknown>, /42501|permission denied/i);
      // 数据没有被动过。
      expect(await count("revenue_daily_stat")).toBe(1);
      // 凭证密文依旧读不到，而读服务用的元数据列可以读。
      await expectDbError(web.$queryRawUnsafe(`SELECT encrypted_secret FROM channel_account_credential`), /42501|permission denied/i);
      await expect(web.channelAccountCredential.findMany({ select: { id: true, fingerprintPrefix: true, status: true, expiresAt: true } })).resolves.toHaveLength(1);
    });

    it("worker_app：四表 SELECT / INSERT / UPDATE 可用，没有 DELETE", async () => {
      await resetDatabase();
      const taskId = await enqueueOk();
      await runHandlerDirect(taskId, upstream([detailRow(D1, { realIncome: "1.00" }), totalRow({ realIncome: "1.00" })]).fetchReport);
      for (const table of REVENUE_TABLES) {
        await expect(worker.$queryRawUnsafe(`SELECT count(*) FROM ${table}`)).resolves.toBeDefined();
        await expect(worker.$executeRawUnsafe(`UPDATE ${table} SET updated_at = now()`)).resolves.toBeGreaterThanOrEqual(0);
        await expectDbError(worker.$executeRawUnsafe(`DELETE FROM ${table}`), /42501|permission denied/i);
      }
    });

    it("analyst_ro 只读；scheduler_app 对四表没有任何权限", async () => {
      await resetDatabase();
      const taskId = await enqueueOk();
      await runHandlerDirect(taskId, upstream([detailRow(D1, { realIncome: "1.00" }), totalRow({ realIncome: "1.00" })]).fetchReport);
      for (const table of REVENUE_TABLES) {
        await expect(analyst.$queryRawUnsafe(`SELECT count(*) FROM ${table}`)).resolves.toBeDefined();
        await expectDbError(analyst.$executeRawUnsafe(`DELETE FROM ${table}`), /42501|permission denied|read-only/i);
        await expectDbError(scheduler.$queryRawUnsafe(`SELECT count(*) FROM ${table}`), /42501|permission denied/i);
        await expectDbError(scheduler.$executeRawUnsafe(`UPDATE ${table} SET updated_at = now()`), /42501|permission denied/i);
      }
    });
  });

  describe("约束在真实库上生效（migration_owner 直接写，绕开应用层）", () => {
    async function seedScope() {
      await resetDatabase();
      const scope = await owner.revenueSyncScope.create({ data: { channelAccountId: foundation.account, projectType: 1 } });
      const batch = await owner.revenueSyncBatch.create({
        data: {
          revenueSyncScopeId: scope.id, beginDate: new Date(`${BEGIN}T00:00:00Z`), endDate: new Date(`${END}T00:00:00Z`),
          requestFingerprint: randomUUID(), status: "completed", finishedAt: new Date(), requestedBy: ADMIN,
        },
      });
      return { scope, batch };
    }

    it("作用域：(账号, 业务线) 唯一；project_type > 0；状态两值", async () => {
      const { scope } = await seedScope();
      await expect(owner.revenueSyncScope.create({ data: { channelAccountId: foundation.account, projectType: 1 } })).rejects.toSatisfy(isUniqueConstraintViolation);
      // 同账号别的业务线是允许的（本期只写 1，但表结构参数化）。
      await expect(owner.revenueSyncScope.create({ data: { channelAccountId: foundation.account, projectType: 2 } })).resolves.toBeDefined();
      await expectDbError(owner.revenueSyncScope.create({ data: { channelAccountId: foundation.account, projectType: 0 } }) as unknown as Promise<unknown>, /revenue_sync_scope_project_type_check/);
      await expectDbError(owner.revenueSyncScope.update({ where: { id: scope.id }, data: { status: "paused" } }) as unknown as Promise<unknown>, /revenue_sync_scope_status_check/);
    });

    it("批次：begin ≤ end、状态与对账取值域、计数非负、终态形状、指纹唯一", async () => {
      const { scope, batch } = await seedScope();
      const base = (overrides: Record<string, unknown>) => ({
        revenueSyncScopeId: scope.id, beginDate: new Date(`${BEGIN}T00:00:00Z`), endDate: new Date(`${END}T00:00:00Z`),
        requestFingerprint: randomUUID(), requestedBy: ADMIN, ...overrides,
      }) as Prisma.RevenueSyncBatchUncheckedCreateInput;
      await expectDbError(owner.revenueSyncBatch.create({ data: base({ beginDate: new Date(`${END}T00:00:00Z`), endDate: new Date(`${BEGIN}T00:00:00Z`) }) }) as unknown as Promise<unknown>, /revenue_sync_batch_date_range_check/);
      await expectDbError(owner.revenueSyncBatch.create({ data: base({ status: "done" }) }) as unknown as Promise<unknown>, /revenue_sync_batch_status_check/);
      await expectDbError(owner.revenueSyncBatch.create({ data: base({ reconciliationStatus: "maybe" }) }) as unknown as Promise<unknown>, /revenue_sync_batch_reconciliation_status_check/);
      await expectDbError(owner.revenueSyncBatch.create({ data: base({ detailRowCount: -1 }) }) as unknown as Promise<unknown>, /revenue_sync_batch_counts_check/);
      // 终态没有 finished_at / 失败没有 error_code。
      await expectDbError(owner.revenueSyncBatch.create({ data: base({ status: "completed" }) }) as unknown as Promise<unknown>, /revenue_sync_batch_terminal_shape_check/);
      await expectDbError(owner.revenueSyncBatch.create({ data: base({ status: "failed", finishedAt: new Date() }) }) as unknown as Promise<unknown>, /revenue_sync_batch_terminal_shape_check/);
      await expectDbError(owner.revenueSyncBatch.create({ data: base({ status: "partial_failed", finishedAt: new Date() }) }) as unknown as Promise<unknown>, /revenue_sync_batch_terminal_shape_check/);
      // 合法的非终态与合法的失败。
      await expect(owner.revenueSyncBatch.create({ data: base({ status: "running", startedAt: new Date() }) })).resolves.toBeDefined();
      await expect(owner.revenueSyncBatch.create({ data: base({ status: "failed", finishedAt: new Date(), errorCode: "upstream_http_error" }) })).resolves.toBeDefined();
      // 指纹唯一。
      await expect(owner.revenueSyncBatch.create({ data: base({ requestFingerprint: batch.requestFingerprint }) })).rejects.toSatisfy(isUniqueConstraintViolation);
    });

    it("原始行与日统计：dedupe_key 唯一、(作用域, 日期) 唯一；比例 / 金额列宽；project_type > 0", async () => {
      const { scope, batch } = await seedScope();
      const raw = (overrides: Record<string, unknown>) => ({
        syncBatchId: batch.id, projectType: 1, dimension: "1", dimensionKey: D1, rawPayload: {}, dedupeKey: randomUUID(), ...overrides,
      }) as Prisma.RevenueRawSnapshotUncheckedCreateInput;
      const created = await owner.revenueRawSnapshot.create({ data: raw({ dedupeKey: "dup-key" }) });
      expect(created.isTotal).toBe(false);
      await expect(owner.revenueRawSnapshot.create({ data: raw({ dedupeKey: "dup-key" }) })).rejects.toSatisfy(isUniqueConstraintViolation);
      await expectDbError(owner.revenueRawSnapshot.create({ data: raw({ projectType: 0 }) }) as unknown as Promise<unknown>, /revenue_raw_snapshot_project_type_check/);
      // numeric(9,6)：1000 放不下；numeric(18,4)：十五位整数放不下。
      await expectDbError(owner.revenueRawSnapshot.create({ data: raw({ realDevNumRate: "1000" }) }) as unknown as Promise<unknown>, /numeric field overflow|22003/i);
      await expectDbError(owner.revenueRawSnapshot.create({ data: raw({ realIncome: "100000000000000" }) }) as unknown as Promise<unknown>, /numeric field overflow|22003/i);
      // 合法的极值与精度：四位小数原样、五位小数四舍五入。
      const edge = await owner.revenueRawSnapshot.create({ data: raw({ realIncome: "12345678901234.5678", realDevNumRate: "999.999999" }) });
      expect(edge.realIncome?.toFixed(4)).toBe("12345678901234.5678");
      expect((await owner.revenueRawSnapshot.create({ data: raw({ realIncome: "0.12345" }) })).realIncome?.toFixed(4)).toBe("0.1235");

      const day = new Date(`${D1}T00:00:00Z`);
      await owner.revenueDailyStat.create({ data: { revenueSyncScopeId: scope.id, statDate: day, sourceBatchId: batch.id } });
      await expect(owner.revenueDailyStat.create({ data: { revenueSyncScopeId: scope.id, statDate: day, sourceBatchId: batch.id } })).rejects.toSatisfy(isUniqueConstraintViolation);
    });

    it("外键删除策略：被引用的批次 / 作用域 / 账号删不掉（RESTRICT）；删除任务头把批次的 generic_task_id 置空（SET NULL），批次与数据保留", async () => {
      await resetDatabase();
      const taskId = await enqueueOk();
      await runHandlerDirect(taskId, upstream([detailRow(D1, { realIncome: "1.00" }), totalRow({ realIncome: "1.00" })]).fetchReport);
      const batch = await owner.revenueSyncBatch.findFirstOrThrow();
      expect(batch.genericTaskId).toBe(taskId);
      await expectDbError(owner.$executeRawUnsafe(`DELETE FROM revenue_sync_batch WHERE id = '${batch.id}'`), /violates foreign key constraint/i);
      await expectDbError(owner.$executeRawUnsafe(`DELETE FROM revenue_sync_scope WHERE id = '${batch.revenueSyncScopeId}'`), /violates foreign key constraint/i);
      await expectDbError(owner.$executeRawUnsafe(`DELETE FROM channel_account WHERE id = '${foundation.account}'`), /violates foreign key constraint/i);

      await owner.$executeRawUnsafe(`DELETE FROM generic_task WHERE id = '${taskId}'`);
      const after = await owner.revenueSyncBatch.findUniqueOrThrow({ where: { id: batch.id } });
      expect(after.genericTaskId).toBeNull();
      expect(after.status).toBe("completed");
      expect(await count("revenue_daily_stat")).toBe(1);
    });
  });
});
