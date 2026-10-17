/**
 * 收益同步任务 `changdu.revenue_sync.v1`：取海阅（网文，projectType=1）账号级每日汇总，落库到
 * revenue_sync_scope / revenue_sync_batch / revenue_raw_snapshot / revenue_daily_stat。
 *
 * 账号级：上游 `GetReport` 覆盖该畅读账号下**全部网文应用**的合计，响应里没有应用字段；所以任务行的
 * `channel_app_id` 是 NULL，作用域是“账号 × projectType”（`revenue_sync_scope`）。
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
 * ── v0.6.2 按书与国家（同一任务里追加，不新增任务类型，生产白名单不用动）────────────────────
 * 按日请求成功之后，再依次：
 *   6. 按书：`fetchReport({ breakdown: "book" })`（维度 ["1","8"]）→ `parseNovelBookReportRows` →
 *      `resolveRevenueBookMatches`（seriesId → 本站来源条目 / 剧场）→ 书行合计与日期行对账（只作提示）；
 *   7. 国家：对按日结果里**激活 > 0 的日期**逐日查激活口径（countryReportType=0）、**新用户 > 0 的日期**逐日查
 *      新用户口径（=1），日期升序、同一天先激活后新用户；两种都为 0 的日子不发请求。任何一次失败就停止后续请求，
 *      整段记失败（不留半段数据）。两种口径按国家合并成一行（上游没列出的国家记 0）。
 * 两段各自独立：某一段失败 → 这一段 `failed`、不写该段任何统计行，批次 `partial_failed`
 * （`book_report_failed` / `country_report_failed`），按日数据照常写入。成功的段在 finalize 事务里把
 * 批次区间内的旧行整段删掉再插入（上游回补后，消失的书 / 国家不会残留）。
 * 口令维度（7）从不请求。
 *
 * 红线：web 不读取、不解密凭证密文——解密只发生在这个文件里；token 只活在局部变量里，不进日志、
 * 错误、任务结果、批次、审计。
 */
import { Prisma, type PrismaClient } from "@prisma/client";

import {
  NovelRevenueAdapterError,
  fetchNovelCountryReport,
  fetchNovelDailyReport,
  scrubSecretText,
  type NovelCountryReportType,
} from "../../src/lib/adapters/moboreader-revenue";
import {
  NOVEL_REVENUE_DIMENSIONS,
  NOVEL_REVENUE_PROJECT_TYPE,
} from "../../src/lib/adapters/moboreader-revenue-constants";
import { moboreaderUpstreamRateGate } from "../../src/lib/adapters/moboreader-rate-limit";
import {
  parseNovelBookReportRows,
  parseNovelCountryReport,
  parseNovelReportRows,
  reconcileBookBreakdown,
  reconcileNovelRevenue,
  type ParsedNovelBookReport,
  type ParsedNovelCountryReport,
  type ParsedRevenueDay,
  type ParsedRevenueTotal,
} from "../../src/lib/adapters/moboreader-revenue-parser";
import { readStarScope } from "../../src/lib/credentials/jwt";
import { createHandlerRegistry, redactSecrets, type TaskHandler, type TaskOutcome } from "../../src/lib/tasks";
import {
  REVENUE_RAW_DIMENSION_BOOK,
  REVENUE_RAW_DIMENSION_COUNTRY_ACTIVE_USERS,
  REVENUE_RAW_DIMENSION_COUNTRY_NEW_USERS,
  REVENUE_SYNC_AUDIT_ACTION_COMPLETED,
  REVENUE_SYNC_AUDIT_ACTION_FAILED,
  REVENUE_SYNC_TASK_TYPE,
  RevenueSyncParamsError,
  parseRevenueSyncTaskParams,
  revenueBatchFingerprint,
  revenueRawDedupeKey,
  revenueSyncOperationScopeHash,
  type RevenueSyncTaskParams,
} from "../../src/lib/tasks/revenue-sync";
import { resolveClaimCredentialReadiness } from "../credentials/claim-readiness";
import { logUpstreamCallObservation } from "../observability/upstream-call-log";
import {
  UNMATCHED_REVENUE_BOOK,
  resolveRevenueBookMatches,
  type ResolveRevenueBookMatches,
  type RevenueBookMatch,
} from "../revenue/book-match";

const ERROR_MESSAGE_MAX_LENGTH = 500;
const DIMENSION = NOVEL_REVENUE_DIMENSIONS[0];
/**
 * 成功路径的 finalize 事务超时。v0.6.2 起一次同步除了按日行，还要整段替换按书 / 国家统计行并存档
 * 按书、国家的原始行（每类一天一行，最多 92 天），默认 5 秒不够稳妥。
 */
const SUCCESS_TRANSACTION_TIMEOUT_MS = 60_000;

type RevenueBatchTerminalStatus = "completed" | "partial_failed" | "failed";
type BreakdownStatus = "completed" | "failed";

export interface RevenueSyncHandlerDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  /** 测试注入点；默认 `fetchNovelDailyReport`，接入共享限速闸与观测日志。按日与按书（`breakdown: "book"`）都走它。 */
  readonly fetchReport?: typeof fetchNovelDailyReport;
  /** 测试注入点；默认 `fetchNovelCountryReport`（v0.6.2 国家下钻），接入同一限速闸与观测日志。 */
  readonly fetchCountryReport?: typeof fetchNovelCountryReport;
  /** 测试注入点；默认 `resolveRevenueBookMatches`（worker_app 读 `novel_source_item.raw_payload`）。 */
  readonly resolveBookMatches?: ResolveRevenueBookMatches;
  /** 测试注入点；默认 `resolveClaimCredentialReadiness`（worker 独占的解密路径）。 */
  readonly resolveCredential?: typeof resolveClaimCredentialReadiness;
}

/** 按书这一段的结果。`failed` 时不带数据，只带错误码（进批次备注）。 */
type BookSection =
  | { readonly status: "completed"; readonly report: ParsedNovelBookReport; readonly matches: ReadonlyMap<string, RevenueBookMatch>; readonly mismatchedDates: readonly string[] }
  | { readonly status: "failed"; readonly errorCode: string };

/** 某一天国家这一段的结果：两种口径各自的解析结果；当天该口径人数为 0 时没有发请求，为 null。 */
type CountryDay = {
  readonly date: string;
  readonly activeUsers: ParsedNovelCountryReport | null;
  readonly newUsers: ParsedNovelCountryReport | null;
};

/** 国家这一段的结果。`days` = 实际下钻过的日期（激活或新用户 > 0 的日子），日期升序。 */
type CountrySection =
  | { readonly status: "completed"; readonly days: readonly CountryDay[]; readonly mismatchedDates: readonly string[] }
  | { readonly status: "failed"; readonly errorCode: string; readonly failedDate: string | null; readonly failedReportType: NovelCountryReportType | null };

type CountryRow = { date: string; label: string; code: string | null; newUsers: number; activeUsers: number };

/** 两种口径按（日期, 国家名原文）合并成一行；某口径没列出的国家记 0。 */
function countryRows(section: CountrySection | null): CountryRow[] {
  if (section?.status !== "completed") return [];
  const rows: CountryRow[] = [];
  for (const day of section.days) {
    const byLabel = new Map<string, CountryRow>();
    const row = (label: string, code: string | null) => {
      const existing = byLabel.get(label);
      if (existing) return existing;
      const created: CountryRow = { date: day.date, label, code, newUsers: 0, activeUsers: 0 };
      byLabel.set(label, created);
      return created;
    };
    for (const country of day.activeUsers?.countries ?? []) row(country.label, country.code).activeUsers += country.users;
    for (const country of day.newUsers?.countries ?? []) row(country.label, country.code).newUsers += country.users;
    rows.push(...byLabel.values());
  }
  return rows;
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
  /** v0.6.2：null = 本批次没有拉取这一段（按日请求失败时）。 */
  readonly book: BookSection | null;
  readonly country: CountrySection | null;
}

function bookRowCount(section: BookSection | null): number {
  return section?.status === "completed" ? section.report.books.length : 0;
}

function countryRowCount(section: CountrySection | null): number {
  return countryRows(section).length;
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
    bookStatus: (record.book?.status ?? null) as BreakdownStatus | null,
    bookRowCount: bookRowCount(record.book),
    countryStatus: (record.country?.status ?? null) as BreakdownStatus | null,
    countryRowCount: countryRowCount(record.country),
    // 本版本的国家这一段总是连激活一起拉：只要这一段跑了（成功或失败）就为 true。
    countryActiveIncluded: record.country !== null,
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

  await persistBookSection(tx, { params, scopeId: scope.id, batchId: batch.id }, record.book);
  await persistCountrySection(tx, { params, scopeId: scope.id, batchId: batch.id }, record.country);

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
        bookStatus: record.book?.status ?? null,
        bookRowCount: bookRowCount(record.book),
        countryStatus: record.country?.status ?? null,
        countryRowCount: countryRowCount(record.country),
        countryActiveIncluded: record.country !== null,
      },
    },
  });
  return { batchId: batch.id, scopeId: scope.id };
}

type SectionContext = { readonly params: RevenueSyncTaskParams; readonly scopeId: string; readonly batchId: string };

function rangeWhere(params: RevenueSyncTaskParams) {
  return { gte: dateOnly(params.beginDate), lte: dateOnly(params.endDate) };
}

/**
 * 按书这一段落库（只在 completed 时）：批次区间内的按书统计整段替换；原始行一天一行（日期行连同 subItems）
 * 加一条总计行，按 dedupe_key upsert。
 */
async function persistBookSection(tx: Prisma.TransactionClient, context: SectionContext, section: BookSection | null): Promise<void> {
  if (section?.status !== "completed") return;
  const { params, scopeId, batchId } = context;
  await tx.revenueBookDailyStat.deleteMany({ where: { revenueSyncScopeId: scopeId, statDate: rangeWhere(params) } });
  if (section.report.books.length > 0) {
    await tx.revenueBookDailyStat.createMany({
      data: section.report.books.map((book) => {
        const match = section.matches.get(book.seriesId) ?? UNMATCHED_REVENUE_BOOK;
        return {
          revenueSyncScopeId: scopeId,
          statDate: dateOnly(book.date),
          upstreamSeriesKey: book.seriesKey,
          upstreamSeriesId: book.seriesId,
          upstreamBookName: book.bookName,
          matchStatus: match.status,
          novelSourceItemId: match.novelSourceItemId,
          channelAppId: match.channelAppId,
          realDevNum: book.activeUsers,
          newRealDevNum: book.newUsers,
          realDevNumRate: book.newUserRatio,
          realIncome: book.shareIncomeUsd,
          sourceBatchId: batchId,
        };
      }),
    });
  }

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
  for (const day of section.report.dates) {
    const dedupeKey = revenueRawDedupeKey({
      kind: "detail",
      scopeId,
      projectType: params.projectType,
      dimension: REVENUE_RAW_DIMENSION_BOOK,
      date: day.date,
    });
    await tx.revenueRawSnapshot.upsert({
      where: { dedupeKey },
      create: {
        syncBatchId: batchId,
        projectType: params.projectType,
        dimension: REVENUE_RAW_DIMENSION_BOOK,
        dimensionKey: day.dimensionKey,
        isTotal: false,
        dedupeKey,
        ...rawFields(day),
      },
      update: { syncBatchId: batchId, dimensionKey: day.dimensionKey, ...rawFields(day) },
    });
  }
  const total = section.report.total;
  if (total) {
    const dedupeKey = revenueRawDedupeKey({
      kind: "total",
      scopeId,
      projectType: params.projectType,
      dimension: REVENUE_RAW_DIMENSION_BOOK,
      dimensionKey: total.dimensionKey,
      beginDate: params.beginDate,
      endDate: params.endDate,
    });
    await tx.revenueRawSnapshot.upsert({
      where: { dedupeKey },
      create: {
        syncBatchId: batchId,
        projectType: params.projectType,
        dimension: REVENUE_RAW_DIMENSION_BOOK,
        dimensionKey: total.dimensionKey,
        isTotal: true,
        dedupeKey,
        ...rawFields(total),
      },
      update: { syncBatchId: batchId, dimensionKey: total.dimensionKey, ...rawFields(total) },
    });
  }
}

/**
 * 国家这一段落库（只在 completed 时）：批次区间内的国家统计整段替换（两种口径都为 0 的日子本来就没有行），
 * 新用户与激活按国家合并成一行；每个下钻过的“日期 × 口径”存一条原始行（`data` 整体；新用户口径的上游 total
 * 记在 new_real_dev_num，激活口径的记在 real_dev_num）。
 */
async function persistCountrySection(tx: Prisma.TransactionClient, context: SectionContext, section: CountrySection | null): Promise<void> {
  if (section?.status !== "completed") return;
  const { params, scopeId, batchId } = context;
  await tx.revenueCountryDailyStat.deleteMany({ where: { revenueSyncScopeId: scopeId, statDate: rangeWhere(params) } });
  const rows = countryRows(section).map((row) => ({
    revenueSyncScopeId: scopeId,
    statDate: dateOnly(row.date),
    countryLabel: row.label,
    countryCode: row.code,
    newRealDevNum: row.newUsers,
    realDevNum: row.activeUsers,
    sourceBatchId: batchId,
  }));
  if (rows.length > 0) await tx.revenueCountryDailyStat.createMany({ data: rows });

  const archives: Array<{ dimension: string; report: ParsedNovelCountryReport; totals: { newRealDevNum?: number | null; realDevNum?: number | null } }> = [];
  for (const day of section.days) {
    if (day.activeUsers) archives.push({ dimension: REVENUE_RAW_DIMENSION_COUNTRY_ACTIVE_USERS, report: day.activeUsers, totals: { realDevNum: day.activeUsers.total } });
    if (day.newUsers) archives.push({ dimension: REVENUE_RAW_DIMENSION_COUNTRY_NEW_USERS, report: day.newUsers, totals: { newRealDevNum: day.newUsers.total } });
  }
  for (const archive of archives) {
    const dedupeKey = revenueRawDedupeKey({
      kind: "country",
      scopeId,
      projectType: params.projectType,
      dimension: archive.dimension,
      date: archive.report.date,
    });
    const fields = {
      syncBatchId: batchId,
      dimensionKey: archive.report.date,
      dimensionValue: null,
      ...archive.totals,
      rawPayload: archive.report.raw as Prisma.InputJsonObject,
    };
    await tx.revenueRawSnapshot.upsert({
      where: { dedupeKey },
      create: { projectType: params.projectType, dimension: archive.dimension, isTotal: false, dedupeKey, ...fields },
      update: fields,
    });
  }
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
          book: null,
          country: null,
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
  const fetchCountryReport = dependencies.fetchCountryReport ?? fetchNovelCountryReport;
  const resolveBookMatches = dependencies.resolveBookMatches ?? resolveRevenueBookMatches;
  const resolveCredential = dependencies.resolveCredential ?? resolveClaimCredentialReadiness;
  const upstreamHooks = { rateGate: moboreaderUpstreamRateGate, onUpstreamObservation: logUpstreamCallObservation };

  /** 按书这一段：一次（分页）`GetReport` 维度 ["1","8"] + 一次 seriesId 匹配。任何异常都收敛成 failed。 */
  async function fetchBookSection(input: {
    token: string;
    params: RevenueSyncTaskParams;
    signal: AbortSignal;
  }): Promise<{ section: BookSection; requestCount: number }> {
    let requestCount = 0;
    try {
      const report = await fetchReport({
        token: input.token,
        beginDate: input.params.beginDate,
        endDate: input.params.endDate,
        breakdown: "book",
        signal: input.signal,
        ...upstreamHooks,
      });
      requestCount = report.requestCount;
      const parsed = parseNovelBookReportRows(report.rows);
      const matches = await resolveBookMatches(db, input.params.channelAccountId, parsed.books.map((book) => book.seriesId));
      return {
        section: { status: "completed", report: parsed, matches, mismatchedDates: reconcileBookBreakdown(parsed.dates, parsed.books) },
        requestCount,
      };
    } catch (error) {
      if (error instanceof NovelRevenueAdapterError) {
        return { section: { status: "failed", errorCode: error.code }, requestCount: error.requestCount };
      }
      return { section: { status: "failed", errorCode: "book_breakdown_failed" }, requestCount };
    }
  }

  /**
   * 国家这一段：激活 > 0 的日期查激活口径、新用户 > 0 的日期查新用户口径（日期升序、串行，同一天先激活后新用户，
   * 经共享限速闸）；任何一次失败就停，整段 failed。对账（只作提示）：各口径国家合计 vs 当天合计、国家合计 vs 上游 total。
   */
  async function fetchCountrySection(input: {
    token: string;
    days: readonly ParsedRevenueDay[];
    signal: AbortSignal;
  }): Promise<{ section: CountrySection; requestCount: number }> {
    const totals = new Map<string, { activeUsers: number; newUsers: number }>();
    for (const day of input.days) {
      const current = totals.get(day.date) ?? { activeUsers: 0, newUsers: 0 };
      current.activeUsers += day.activeUsers ?? 0;
      current.newUsers += day.newUsers ?? 0;
      totals.set(day.date, current);
    }
    const dates = [...totals.entries()]
      .filter(([, total]) => total.activeUsers > 0 || total.newUsers > 0)
      .map(([date]) => date)
      .sort();
    const results: CountryDay[] = [];
    const mismatchedDates: string[] = [];
    let requestCount = 0;
    for (const date of dates) {
      const total = totals.get(date)!;
      const day: { date: string; activeUsers: ParsedNovelCountryReport | null; newUsers: ParsedNovelCountryReport | null } = {
        date,
        activeUsers: null,
        newUsers: null,
      };
      const plan: Array<{ reportType: NovelCountryReportType; expected: number; key: "activeUsers" | "newUsers" }> = [];
      if (total.activeUsers > 0) plan.push({ reportType: "active_users", expected: total.activeUsers, key: "activeUsers" });
      if (total.newUsers > 0) plan.push({ reportType: "new_users", expected: total.newUsers, key: "newUsers" });
      let mismatched = false;
      for (const step of plan) {
        try {
          const report = await fetchCountryReport({ token: input.token, date, reportType: step.reportType, signal: input.signal, ...upstreamHooks });
          requestCount += report.requestCount;
          const parsed = parseNovelCountryReport(date, report.data);
          day[step.key] = parsed;
          if (parsed.countrySum !== step.expected || (parsed.total !== null && parsed.total !== parsed.countrySum)) mismatched = true;
        } catch (error) {
          if (error instanceof NovelRevenueAdapterError) {
            return {
              section: { status: "failed", errorCode: error.code, failedDate: date, failedReportType: step.reportType },
              requestCount: requestCount + error.requestCount,
            };
          }
          return {
            section: { status: "failed", errorCode: "country_breakdown_failed", failedDate: date, failedReportType: step.reportType },
            requestCount,
          };
        }
      }
      if (mismatched) mismatchedDates.push(date);
      results.push(day);
    }
    return { section: { status: "completed", days: results, mismatchedDates }, requestCount };
  }

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
    // 也不写批次（不知道该往哪个作用域写）。收益同步是账号级任务，任务行的 `channel_app_id` 是 NULL，
    // 所以业务线不能再从应用上读；任务行里自描述业务线的是 `operation_scope_hash`（折进了 projectType），
    // 与参数里（parse 已校验恒为 1）的 projectType 重新推一遍对拍。
    const task = await db.genericTask.findUnique({
      where: { id: lease.taskId },
      select: {
        taskType: true,
        channelAccountId: true,
        operationScopeHash: true,
      },
    });
    if (
      !task
      || task.taskType !== REVENUE_SYNC_TASK_TYPE
      || task.channelAccountId !== params.channelAccountId
      || task.operationScopeHash !== revenueSyncOperationScopeHash(params.projectType)
    ) {
      return {
        status: "failed",
        error: { code: "revenue_sync_scope_invalid", message: "Revenue sync task does not match its parameters" },
      };
    }

    // 账号仍然 active，并且它所在的 channel 下仍有至少一个 active 的网文应用（原先靠任务行的应用来保证
    // “这是网文业务线”，账号级任务不再挂应用，改在执行时核对）。
    const account = await db.channelAccount.findFirst({
      where: {
        id: params.channelAccountId,
        status: "active",
        deletedAt: null,
        channel: {
          status: "active",
          channelApps: {
            some: { projectType: NOVEL_REVENUE_PROJECT_TYPE, status: "active", sourceApp: { status: "active" } },
          },
        },
      },
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

      // v0.6.2：按日成功之后才追加按书与国家；两段的失败不影响按日数据落库。
      const book = await fetchBookSection({ token: secret, params, signal });
      const country = await fetchCountrySection({ token: secret, days: parsed.detail, signal });
      const requestCount = report.requestCount + book.requestCount + country.requestCount;

      const errorCode = mismatched
        ? "total_row_mismatch"
        : book.section.status === "failed"
          ? "book_report_failed"
          : country.section.status === "failed"
            ? "country_report_failed"
            : null;
      const status: RevenueBatchTerminalStatus = errorCode === null ? "completed" : "partial_failed";
      const notes: string[] = [];
      if (mismatched) {
        notes.push(
          `Detail income sum ${reconciliation.detailIncomeSum} differs from the upstream total row ${reconciliation.totalIncome} by ${reconciliation.difference}`,
        );
      }
      if (parsed.droppedRowCount > 0) notes.push(`${parsed.droppedRowCount} upstream rows without a valid date were dropped`);
      if (book.section.status === "failed") {
        notes.push(`Book breakdown failed (${book.section.errorCode}); no per-book rows were written`);
      } else {
        const dropped = book.section.report.droppedBookRowCount + book.section.report.duplicateBookRowCount;
        if (dropped > 0) notes.push(`${dropped} upstream book rows were dropped (not a novel series key, or duplicated)`);
        if (book.section.mismatchedDates.length > 0) {
          notes.push(`Per-book sums differ from the day totals on ${book.section.mismatchedDates.length} day(s)`);
        }
      }
      if (country.section.status === "failed") {
        notes.push(
          `Country breakdown failed on ${country.section.failedDate ?? "unknown date"} (${country.section.failedReportType ?? "unknown"}, ${country.section.errorCode}); no country rows were written`,
        );
      } else {
        const dropped = country.section.days.reduce(
          (sum, day) => sum + (day.activeUsers?.droppedRowCount ?? 0) + (day.newUsers?.droppedRowCount ?? 0),
          0,
        );
        if (dropped > 0) notes.push(`${dropped} upstream country rows were dropped`);
        if (country.section.mismatchedDates.length > 0) {
          notes.push(`Country sums differ from the day totals on ${country.section.mismatchedDates.length} day(s)`);
        }
      }
      const record: BatchRecord = {
        status,
        requestCount,
        detailRowCount: parsed.detail.length,
        totalRowCount: parsed.totalRowCount,
        reconciliationStatus: reconciliation.status,
        ...identity,
        upstreamStarId: scope.starId,
        errorCode,
        errorMessage: notes.length > 0 ? safeMessage(notes.join("; "), secret) : null,
        startedAt,
        detail: parsed.detail,
        total: parsed.total,
        book: book.section,
        country: country.section,
      };
      const bookMatches = book.section.status === "completed" ? [...book.section.matches.values()] : [];
      return {
        status: "success",
        result: {
          batchStatus: status,
          reconciliationStatus: reconciliation.status,
          requestCount,
          detailRowCount: parsed.detail.length,
          totalRowCount: parsed.totalRowCount,
          droppedRowCount: parsed.droppedRowCount,
          duplicateDateCount: parsed.duplicateDateCount,
          beginDate: params.beginDate,
          endDate: params.endDate,
          bookStatus: book.section.status,
          bookRowCount: bookRowCount(book.section),
          bookCount: bookMatches.length,
          unmatchedBookCount: bookMatches.filter((match) => match.status === "unmatched").length,
          ambiguousBookCount: bookMatches.filter((match) => match.status === "ambiguous").length,
          countryStatus: country.section.status,
          countryDayCount: country.section.status === "completed" ? country.section.days.length : 0,
          countryRowCount: countryRowCount(country.section),
        },
        transactionTimeoutMs: SUCCESS_TRANSACTION_TIMEOUT_MS,
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
