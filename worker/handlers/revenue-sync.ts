/**
 * 收益同步任务 `moboreader.revenue_sync.v1`：取海阅（网文，projectType=1）账号级每日汇总，落库到
 * revenue_sync_scope / revenue_sync_batch / revenue_raw_snapshot / revenue_daily_stat。
 *
 * 触发方式：只能后台手动（`src/server/revenue/enqueue.ts`），不设定时任务；由**主通道** worker 执行
 * （任务类型登记在 `src/lib/tasks/worker-lanes.mjs` 的 `MOBOREADER_UPSTREAM_TASK_TYPES`，轻量通道不得出现）。
 * `maxAttempts: 1`：失败直接作为批次失败原因呈现给运营，由人决定是否重来。
 *
 * 执行顺序（任何一步失败都会落一条 `failed` 批次，让页面看得到原因）：
 *   1. 解析并重新校验任务参数（不信任存量数据）；任务行与参数的账号 / 业务线必须一致；
 *   2. 取账号当前 active 凭证明文——复用 `worker/credentials/claim-readiness.ts` 的
 *      `resolveClaimCredentialReadiness`（not_ready → 失败，错误码原样透传）；
 *   3. 凭证口径校验 `readStarScope`：不是达人凭证（没有非空、非 -1 的 *StarId）→ `credential_not_star_scope`，
 *      **一个上游请求都不发**（CPS 7 月“87 倍事故”：聚合账号凭证会把整个主体的收益混进来）；
 *   4. `fetchNovelDailyReport`（固定 projectType=1，分页串行）→ 解析 → 对账；
 *   5. 全部业务写入在 `protectedWrite(tx)`（finalize 事务，带租约围栏）里一次完成：upsert scope → upsert 批次（终态，
 *      `request_fingerprint` 让同一任务重试幂等）→ upsert 原始行 → upsert 日统计 → 审计。
 *
 * 结果口径：空列表 = `completed` 且 `detail_row_count = 0`（合法，不是失败）；明细合计与总计行对不上 =
 * `partial_failed` + `total_row_mismatch`（数据仍写入）；有被丢弃的坏日期行时批次仍 `completed`，但 `error_message`
 * 里留一句提示。条目状态：只要数据写进去了（含 partial_failed）就是 success，批次状态才是页面上的真相。
 *
 * 红线：web 不读取、不解密凭证密文——解密只发生在这个文件里；token 只活在局部变量里，不进日志、
 * 错误、任务结果、批次、审计。
 */
import { Prisma, type PrismaClient } from "@prisma/client";

import {
  NovelRevenueAdapterError,
  fetchNovelDailyReport,
  scrubSecretText,
} from "../../src/lib/adapters/moboreader-revenue";
import {
  NOVEL_REVENUE_DIMENSIONS,
  NOVEL_REVENUE_PROJECT_TYPE,
} from "../../src/lib/adapters/moboreader-revenue-constants";
import { moboreaderUpstreamRateGate } from "../../src/lib/adapters/moboreader-rate-limit";
import {
  parseNovelReportRows,
  reconcileNovelRevenue,
  type ParsedRevenueDay,
  type ParsedRevenueTotal,
} from "../../src/lib/adapters/moboreader-revenue-parser";
import { readStarScope } from "../../src/lib/credentials/jwt";
import { createHandlerRegistry, redactSecrets, type TaskHandler, type TaskOutcome } from "../../src/lib/tasks";
import {
  REVENUE_SYNC_AUDIT_ACTION_COMPLETED,
  REVENUE_SYNC_AUDIT_ACTION_FAILED,
  REVENUE_SYNC_TASK_TYPE,
  RevenueSyncParamsError,
  parseRevenueSyncTaskParams,
  revenueBatchFingerprint,
  revenueRawDedupeKey,
  type RevenueSyncTaskParams,
} from "../../src/lib/tasks/revenue-sync";
import { resolveClaimCredentialReadiness } from "../credentials/claim-readiness";
import { logUpstreamCallObservation } from "../observability/upstream-call-log";

const ERROR_MESSAGE_MAX_LENGTH = 500;
const DIMENSION = NOVEL_REVENUE_DIMENSIONS[0];

type RevenueBatchTerminalStatus = "completed" | "partial_failed" | "failed";

export interface RevenueSyncHandlerDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  /** 测试注入点；默认 `fetchNovelDailyReport`，接入共享限速闸与观测日志。 */
  readonly fetchReport?: typeof fetchNovelDailyReport;
  /** 测试注入点；默认 `resolveClaimCredentialReadiness`（worker 独占的解密路径）。 */
  readonly resolveCredential?: typeof resolveClaimCredentialReadiness;
}

interface BatchRecord {
  readonly status: RevenueBatchTerminalStatus;
  readonly requestCount: number;
  readonly detailRowCount: number;
  readonly totalRowCount: number;
  readonly reconciliationStatus: "matched" | "mismatched" | "not_applicable" | null;
  readonly credentialId: string | null;
  readonly credentialFingerprintPrefix: string | null;
  readonly upstreamStarId: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly startedAt: Date;
  readonly detail: readonly ParsedRevenueDay[];
  readonly total: ParsedRevenueTotal | null;
}

/** 错误信息进批次 / 任务错误之前的最后一道脱敏：遮蔽 token 原文，再套仓库统一的 `redactSecrets`，再截断。 */
function safeMessage(message: string, secret: string | null): string {
  const scrubbed = redactSecrets(secret ? scrubSecretText(message, secret) : scrubSecretText(message));
  return scrubbed.length <= ERROR_MESSAGE_MAX_LENGTH ? scrubbed : `${scrubbed.slice(0, ERROR_MESSAGE_MAX_LENGTH - 1)}…`;
}

function dateOnly(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/**
 * 批次落库（只在 finalize 事务里调用）。顺序：scope → batch → raw snapshot → daily stat → audit。
 * 全部是 upsert / create，同一任务重试、不同任务重拉同一区间都幂等。
 */
async function persistRevenueBatch(
  tx: Prisma.TransactionClient,
  context: {
    readonly params: RevenueSyncTaskParams;
    readonly taskId: string;
    readonly workerId: string;
    readonly finishedAt: Date;
  },
  record: BatchRecord,
): Promise<{ batchId: string; scopeId: string }> {
  const { params } = context;
  const scope = await tx.revenueSyncScope.upsert({
    where: { channelAccountId_projectType: { channelAccountId: params.channelAccountId, projectType: params.projectType } },
    create: { channelAccountId: params.channelAccountId, projectType: params.projectType, status: "active" },
    update: {},
  });

  const requestFingerprint = revenueBatchFingerprint({
    scopeId: scope.id,
    projectType: params.projectType,
    beginDate: params.beginDate,
    endDate: params.endDate,
    genericTaskId: context.taskId,
  });
  const batchFields = {
    status: record.status,
    requestCount: record.requestCount,
    detailRowCount: record.detailRowCount,
    totalRowCount: record.totalRowCount,
    reconciliationStatus: record.reconciliationStatus,
    credentialId: record.credentialId,
    credentialFingerprintPrefix: record.credentialFingerprintPrefix,
    upstreamStarId: record.upstreamStarId,
    errorCode: record.errorCode,
    errorMessage: record.errorMessage,
    requestedBy: params.requestedBy,
    startedAt: record.startedAt,
    finishedAt: context.finishedAt,
  };
  const batch = await tx.revenueSyncBatch.upsert({
    where: { requestFingerprint },
    create: {
      revenueSyncScopeId: scope.id,
      genericTaskId: context.taskId,
      beginDate: dateOnly(params.beginDate),
      endDate: dateOnly(params.endDate),
      requestFingerprint,
      ...batchFields,
    },
    update: batchFields,
  });

  const rawFields = (row: ParsedRevenueDay | ParsedRevenueTotal) => ({
    dimensionValue: row.dimensionValue,
    realDevNum: row.activeUsers,
    newRealDevNum: row.newUsers,
    realDevNumRate: row.newUserRatio,
    realIncome: row.shareIncomeUsd,
    realDistribIncome: row.distribIncomeUsd,
    realProfit: row.profitUsd,
    rawPayload: row.raw as Prisma.InputJsonObject,
  });

  for (const day of record.detail) {
    const dedupeKey = revenueRawDedupeKey({
      kind: "detail",
      scopeId: scope.id,
      projectType: params.projectType,
      dimension: DIMENSION,
      date: day.date,
    });
    await tx.revenueRawSnapshot.upsert({
      where: { dedupeKey },
      create: {
        syncBatchId: batch.id,
        projectType: params.projectType,
        dimension: DIMENSION,
        dimensionKey: day.dimensionKey,
        isTotal: false,
        dedupeKey,
        ...rawFields(day),
      },
      update: { syncBatchId: batch.id, dimensionKey: day.dimensionKey, ...rawFields(day) },
    });
    const dailyFields = {
      realDevNum: day.activeUsers,
      newRealDevNum: day.newUsers,
      realDevNumRate: day.newUserRatio,
      realIncome: day.shareIncomeUsd,
      sourceBatchId: batch.id,
    };
    await tx.revenueDailyStat.upsert({
      where: { revenueSyncScopeId_statDate: { revenueSyncScopeId: scope.id, statDate: dateOnly(day.date) } },
      create: { revenueSyncScopeId: scope.id, statDate: dateOnly(day.date), ...dailyFields },
      update: dailyFields,
    });
  }

  if (record.total) {
    const dedupeKey = revenueRawDedupeKey({
      kind: "total",
      scopeId: scope.id,
      projectType: params.projectType,
      dimension: DIMENSION,
      dimensionKey: record.total.dimensionKey,
      beginDate: params.beginDate,
      endDate: params.endDate,
    });
    await tx.revenueRawSnapshot.upsert({
      where: { dedupeKey },
      create: {
        syncBatchId: batch.id,
        projectType: params.projectType,
        dimension: DIMENSION,
        dimensionKey: record.total.dimensionKey,
        isTotal: true,
        dedupeKey,
        ...rawFields(record.total),
      },
      update: { syncBatchId: batch.id, dimensionKey: record.total.dimensionKey, ...rawFields(record.total) },
    });
  }

  await tx.operationAudit.create({
    data: {
      actorType: "worker",
      actorId: context.workerId.slice(0, 128),
      action: record.status === "failed" ? REVENUE_SYNC_AUDIT_ACTION_FAILED : REVENUE_SYNC_AUDIT_ACTION_COMPLETED,
      entityType: "RevenueSyncBatch",
      entityId: batch.id,
      taskType: REVENUE_SYNC_TASK_TYPE,
      taskId: context.taskId,
      reason: record.errorCode,
      afterSnapshot: {
        status: record.status,
        projectType: params.projectType,
        beginDate: params.beginDate,
        endDate: params.endDate,
        requestCount: record.requestCount,
        detailRowCount: record.detailRowCount,
        totalRowCount: record.totalRowCount,
        reconciliationStatus: record.reconciliationStatus,
        upstreamStarId: record.upstreamStarId,
        errorCode: record.errorCode,
      },
    },
  });
  return { batchId: batch.id, scopeId: scope.id };
}

function failedOutcome(
  params: RevenueSyncTaskParams,
  context: { taskId: string; workerId: string; now: () => Date },
  failure: {
    errorCode: string;
    errorMessage: string;
    requestCount?: number;
    credentialId?: string | null;
    credentialFingerprintPrefix?: string | null;
    upstreamStarId?: string | null;
    startedAt: Date;
    secret?: string | null;
  },
): TaskOutcome {
  const message = safeMessage(failure.errorMessage, failure.secret ?? null);
  const result = {
    batchStatus: "failed" as const,
    errorCode: failure.errorCode,
    requestCount: failure.requestCount ?? 0,
    beginDate: params.beginDate,
    endDate: params.endDate,
  };
  return {
    status: "failed",
    result,
    error: { code: failure.errorCode, message },
    protectedWrite: async (tx) => {
      await persistRevenueBatch(
        tx,
        { params, taskId: context.taskId, workerId: context.workerId, finishedAt: context.now() },
        {
          status: "failed",
          requestCount: failure.requestCount ?? 0,
          detailRowCount: 0,
          totalRowCount: 0,
          reconciliationStatus: null,
          credentialId: failure.credentialId ?? null,
          credentialFingerprintPrefix: failure.credentialFingerprintPrefix ?? null,
          upstreamStarId: failure.upstreamStarId ?? null,
          errorCode: failure.errorCode,
          errorMessage: message,
          startedAt: failure.startedAt,
          detail: [],
          total: null,
        },
      );
    },
  };
}

export function createRevenueSyncHandler(
  db: PrismaClient,
  dependencies: RevenueSyncHandlerDependencies = {},
): TaskHandler {
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? (() => new Date());
  const fetchReport = dependencies.fetchReport ?? fetchNovelDailyReport;
  const resolveCredential = dependencies.resolveCredential ?? resolveClaimCredentialReadiness;

  return async ({ lease, mode, signal }) => {
    const startedAt = now();
    if (mode !== "apply") {
      return {
        status: "failed",
        error: { code: "revenue_sync_dry_run_unsupported", message: "Revenue sync only supports apply mode" },
      };
    }

    let params: RevenueSyncTaskParams;
    try {
      params = parseRevenueSyncTaskParams(lease.payload, startedAt);
    } catch (error) {
      const reason = error instanceof RevenueSyncParamsError ? error.reason : "unknown";
      return {
        status: "failed",
        error: { code: "revenue_sync_params_invalid", message: `Revenue sync task parameters are invalid (${reason})` },
      };
    }
    const context = { taskId: lease.taskId, workerId: lease.workerId, now };

    // 任务行本身必须与参数对得上：同一个账号、网文业务线。对不上说明任务行或条目被改过——不信任，
    // 也不写批次（不知道该往哪个作用域写）。
    const task = await db.genericTask.findUnique({
      where: { id: lease.taskId },
      select: {
        taskType: true,
        channelAccountId: true,
        channelApp: { select: { projectType: true } },
      },
    });
    if (
      !task
      || task.taskType !== REVENUE_SYNC_TASK_TYPE
      || task.channelAccountId !== params.channelAccountId
      || task.channelApp?.projectType !== NOVEL_REVENUE_PROJECT_TYPE
    ) {
      return {
        status: "failed",
        error: { code: "revenue_sync_scope_invalid", message: "Revenue sync task does not match its parameters" },
      };
    }

    const account = await db.channelAccount.findFirst({
      where: { id: params.channelAccountId, status: "active", deletedAt: null },
      select: { id: true },
    });
    if (!account) {
      return failedOutcome(params, context, {
        errorCode: "channel_account_unavailable",
        errorMessage: "The channel account is no longer active",
        startedAt,
      });
    }
    const existingScope = await db.revenueSyncScope.findUnique({
      where: { channelAccountId_projectType: { channelAccountId: params.channelAccountId, projectType: params.projectType } },
      select: { status: true },
    });
    if (existingScope && existingScope.status !== "active") {
      return failedOutcome(params, context, {
        errorCode: "revenue_scope_disabled",
        errorMessage: "The revenue sync scope is disabled",
        startedAt,
      });
    }

    const readiness = await resolveCredential(db, params.channelAccountId, startedAt, env);
    if (readiness.status === "not_ready") {
      return failedOutcome(params, context, {
        errorCode: readiness.code,
        errorMessage: readiness.message,
        startedAt,
      });
    }
    const secret = readiness.secret;
    const credential = await db.channelAccountCredential.findUnique({
      where: { id: readiness.credentialId },
      select: { fingerprintPrefix: true },
    });
    const identity = {
      credentialId: readiness.credentialId,
      credentialFingerprintPrefix: credential?.fingerprintPrefix ?? null,
    };

    // 口径校验在任何上游请求之前：不是达人凭证就一个请求都不发。
    const scope = readStarScope(secret);
    if (!scope.ok) {
      return failedOutcome(params, context, {
        errorCode: scope.reason,
        errorMessage: "The active credential is not a creator (Star) credential; revenue would not be scoped to this account",
        ...identity,
        startedAt,
        secret,
      });
    }

    try {
      const report = await fetchReport({
        token: secret,
        beginDate: params.beginDate,
        endDate: params.endDate,
        signal,
        rateGate: moboreaderUpstreamRateGate,
        onUpstreamObservation: logUpstreamCallObservation,
      });
      const parsed = parseNovelReportRows(report.rows);
      const reconciliation = reconcileNovelRevenue(parsed.detail, parsed.total);
      const mismatched = reconciliation.status === "mismatched";
      const status: RevenueBatchTerminalStatus = mismatched ? "partial_failed" : "completed";
      const notes: string[] = [];
      if (mismatched) {
        notes.push(
          `Detail income sum ${reconciliation.detailIncomeSum} differs from the upstream total row ${reconciliation.totalIncome} by ${reconciliation.difference}`,
        );
      }
      if (parsed.droppedRowCount > 0) notes.push(`${parsed.droppedRowCount} upstream rows without a valid date were dropped`);
      const record: BatchRecord = {
        status,
        requestCount: report.requestCount,
        detailRowCount: parsed.detail.length,
        totalRowCount: parsed.totalRowCount,
        reconciliationStatus: reconciliation.status,
        ...identity,
        upstreamStarId: scope.starId,
        errorCode: mismatched ? "total_row_mismatch" : null,
        errorMessage: notes.length > 0 ? safeMessage(notes.join("; "), secret) : null,
        startedAt,
        detail: parsed.detail,
        total: parsed.total,
      };
      return {
        status: "success",
        result: {
          batchStatus: status,
          reconciliationStatus: reconciliation.status,
          requestCount: report.requestCount,
          detailRowCount: parsed.detail.length,
          totalRowCount: parsed.totalRowCount,
          droppedRowCount: parsed.droppedRowCount,
          duplicateDateCount: parsed.duplicateDateCount,
          beginDate: params.beginDate,
          endDate: params.endDate,
        },
        protectedWrite: async (tx) => {
          await persistRevenueBatch(tx, { params, taskId: context.taskId, workerId: context.workerId, finishedAt: context.now() }, record);
        },
      };
    } catch (error) {
      if (error instanceof NovelRevenueAdapterError) {
        return failedOutcome(params, context, {
          errorCode: error.code,
          errorMessage: error.message,
          requestCount: error.requestCount,
          ...identity,
          upstreamStarId: scope.starId,
          startedAt,
          secret,
        });
      }
      // 未预期的异常：批次里只留稳定错误码与泛化信息，不透传原始异常文本（可能带内部细节）。
      return failedOutcome(params, context, {
        errorCode: "revenue_sync_failed",
        errorMessage: "Revenue sync failed unexpectedly",
        ...identity,
        upstreamStarId: scope.starId,
        startedAt,
        secret,
      });
    }
  };
}

export function createRevenueSyncWorkerHandlers(db: PrismaClient, dependencies: RevenueSyncHandlerDependencies = {}) {
  return createHandlerRegistry({
    [REVENUE_SYNC_TASK_TYPE]: {
      family: "generic",
      maxAttempts: 1,
      handler: createRevenueSyncHandler(db, dependencies),
    },
  });
}
