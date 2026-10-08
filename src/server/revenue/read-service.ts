/**
 * 收益看板读服务（后台 `/revenue` 页用）：网文（projectType=1）账号级每日汇总的只读视图。
 *
 * ── 账号级口径与多剧场（多应用）扩展路径 ──────────────────────────────────────
 * 上游 `GetReport` 是**账号级**的：同一畅读账号、同一 projectType 下所有应用合计，响应里没有应用字段。
 * 今天只有一个网文应用（MoboReader），以后畅读渠道可能在同一账号下再增加别的网文应用；视图里的
 * `account.novelAppCount` 是该账号所在 channel 下 active 的网文应用数，页面据此写“当前 N 个应用”，
 * N ≥ 2 时额外提示“以下为 N 个网文应用的合计”。
 *   1. 同账号多应用：现状即可工作——选账号时按账号 id 去重（`./account.ts`），看板显示合计；
 *   2. 按应用拆分：需先由 Owner 在上游后台日报页选“授权产品”维度并抓取一次真实请求，拿到维度编码；
 *      原始行表已有 `dimension` 列可容纳非日期维度，按应用的日汇总另建一张表（只新增），不改现有表；
 *   3. 多个畅读账号：数据模型已支持（作用域 = 账号 × projectType），但当前页面与入队只支持唯一账号，
 *      多账号时会明确提示 `channel_account_ambiguous`，届时再加账号选择器。
 *
 * 只用 web_app 有权限的表：revenue 四表 SELECT、generic_task、channel_account / channel_app / channel
 * （经 `./account`）、channel_account_credential 的**元数据列**（经 `listCredentialMetadata`）。
 * **绝不读取、绝不解密凭证密文**（`tests/backend/auth/credential-contracts.test.ts` 守卫）。
 *
 * 入队函数 `enqueueRevenueSync` 也从这里再导出，供 server action 调用。返回
 * `{ ok: true; taskId; duplicate } | { ok: false; code; existingTaskId? }`，`code` 枚举见 `./enqueue.ts` 文件头：
 * `invalid_request` / `invalid_date_range` / `channel_account_unavailable` / `channel_account_ambiguous` /
 * `revenue_sync_already_active` / `request_token_conflict`。
 *
 * ── 日期与覆盖口径 ────────────────────────────────────────────────────────────
 * 日期一律是北京时间（Asia/Shanghai）日期。上游**不返回没有活动的日期**，所以每一天的 `coverage` 是三态：
 *   - `reported`        有上游行（`revenue_daily_stat` 里有这一天）；
 *   - `no_upstream_row` 被某个 `completed` / `partial_failed` 批次的区间覆盖，但上游没返回这一天——
 *                       视为当天 0 活动；数值列给 0（`newUserRatio` 无从计算给 null）；
 *   - `not_synced`      没有任何成功批次覆盖——数值列全是 null，页面应显示“未同步”，**不是 0**。
 * `failed` 批次不算覆盖：它没有写入任何数据，不能证明“上游当天没有活动”。
 *
 * ── 汇总口径 ──────────────────────────────────────────────────────────────────
 *   - `shareIncomeUsdTotal` / `newUsersTotal`：只累计 `reported` 的天（`no_upstream_row` 本来就是 0）；
 *   - `avgActiveUsers`：`reported`（激活用户字段非空）+ `no_upstream_row`（记 0）的日均，保留 2 位小数；
 *     没有任何可计算的天 → null；
 *   - 金额全程 Decimal，对外是十进制字符串（`"28.8800"`），不经过 JS 浮点。
 */
import { Prisma, type PrismaClient } from "@prisma/client";

import { NOVEL_REVENUE_PROJECT_TYPE } from "@/lib/adapters/moboreader-revenue-constants";
import { isValidCalendarDate } from "@/lib/adapters/moboreader-revenue-parser";
import {
  REVENUE_SYNC_MAX_SPAN_DAYS,
  REVENUE_SYNC_TASK_TYPE,
  addDaysToDate,
  inclusiveDaySpan,
  shanghaiToday,
} from "@/lib/tasks/revenue-sync";
import { listCredentialMetadata } from "@/server/credentials/service";

import { maskRevenueAccountLabel, resolveRevenueChannelAccount } from "./account";

export { enqueueRevenueSync } from "./enqueue";
export type {
  EnqueueRevenueSyncFailureCode,
  EnqueueRevenueSyncInput,
  EnqueueRevenueSyncOptions,
  EnqueueRevenueSyncResult,
} from "./enqueue";

export type RevenueDayCoverage = "reported" | "no_upstream_row" | "not_synced";

export type RevenueDayRow = {
  date: string; // YYYY-MM-DD（上海日期）
  coverage: RevenueDayCoverage; // reported=有上游行；no_upstream_row=被某个 completed/partial_failed 批次覆盖但上游没返回（视为0活动）；not_synced=没有任何成功批次覆盖
  activeUsers: number | null;
  newUsers: number | null;
  newUserRatio: string | null; // 小数字符串，0.2827
  shareIncomeUsd: string | null; // 十进制字符串，"28.8800"
};

export type RevenueBatchRow = {
  id: string;
  createdAt: string;
  finishedAt: string | null;
  beginDate: string;
  endDate: string;
  status: "pending" | "running" | "completed" | "partial_failed" | "failed";
  detailRowCount: number;
  totalRowCount: number;
  reconciliationStatus: "matched" | "mismatched" | "not_applicable" | null;
  upstreamStarId: string | null;
  credentialFingerprintPrefix: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  genericTaskId: string | null;
};

export type RevenueDashboardView = {
  account: {
    id: string;
    label: string; /* 脱敏，如 ch***@qq.com */
    novelAppCount: number; /* 该账号所在 channel 下 active 的网文应用数（≥ 1）；收益是这些应用的合计 */
  } | null;
  range: { dateFrom: string; dateTo: string; dayCount: number };
  summary: {
    shareIncomeUsdTotal: string; // reported 天的合计
    newUsersTotal: number;
    avgActiveUsers: string | null; // reported+no_upstream_row 天的日均（no_upstream_row 记 0），无覆盖天→null
    reportedDays: number;
    noUpstreamRowDays: number;
    notSyncedDays: number;
  };
  days: RevenueDayRow[]; // 日期倒序，覆盖 [dateFrom, dateTo] 每一天
  batches: RevenueBatchRow[]; // 最近 20 个批次
  activeTask: { id: string; status: string; createdAt: string } | null; // pending/processing 的收益同步任务
  credential: { status: string; expiresAt: string | null } | null; // 只读元数据（复用 listCredentialMetadata），绝不读密文
  lastSuccessfulSyncAt: string | null;
};

export class RevenueDashboardQueryError extends Error {
  constructor(readonly code: "invalid_range") {
    super(`revenue_dashboard_query_invalid: ${code}`);
    this.name = "RevenueDashboardQueryError";
  }
}

export const REVENUE_DASHBOARD_DEFAULT_DAYS = 30;
export const REVENUE_DASHBOARD_BATCH_LIMIT = 20;

/** 上海时区今天往前共 30 天（含今天，即 today-29 ~ today）。 */
export function defaultRevenueRange(now: Date = new Date()): { dateFrom: string; dateTo: string } {
  const dateTo = shanghaiToday(now);
  return { dateFrom: addDaysToDate(dateTo, -(REVENUE_DASHBOARD_DEFAULT_DAYS - 1)), dateTo };
}

const Decimal = Prisma.Decimal;
const SUCCESSFUL_BATCH_STATUSES = ["completed", "partial_failed"] as const;

function dateOnly(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function enumerateDatesDescending(dateFrom: string, dateTo: string): string[] {
  const days: string[] = [];
  for (let date = dateTo; date >= dateFrom; date = addDaysToDate(date, -1)) days.push(date);
  return days;
}

type DailyStatRow = {
  statDate: Date;
  realDevNum: number | null;
  newRealDevNum: number | null;
  realDevNumRate: Prisma.Decimal | null;
  realIncome: Prisma.Decimal | null;
};

type CoverageRange = { beginDate: string; endDate: string };

/** 把一段区间内每一天判成三态，并给出数值（纯函数，便于单测）。 */
export function buildRevenueDays(input: {
  dateFrom: string;
  dateTo: string;
  stats: readonly DailyStatRow[];
  coveredRanges: readonly CoverageRange[];
}): RevenueDayRow[] {
  const statsByDate = new Map(input.stats.map((stat) => [isoDate(stat.statDate), stat]));
  return enumerateDatesDescending(input.dateFrom, input.dateTo).map((date): RevenueDayRow => {
    const stat = statsByDate.get(date);
    if (stat) {
      return {
        date,
        coverage: "reported",
        activeUsers: stat.realDevNum,
        newUsers: stat.newRealDevNum,
        newUserRatio: stat.realDevNumRate === null ? null : stat.realDevNumRate.toFixed(),
        shareIncomeUsd: stat.realIncome === null ? null : stat.realIncome.toFixed(4),
      };
    }
    const covered = input.coveredRanges.some((range) => range.beginDate <= date && date <= range.endDate);
    if (covered) {
      return { date, coverage: "no_upstream_row", activeUsers: 0, newUsers: 0, newUserRatio: null, shareIncomeUsd: "0.0000" };
    }
    return { date, coverage: "not_synced", activeUsers: null, newUsers: null, newUserRatio: null, shareIncomeUsd: null };
  });
}

/** 汇总（纯函数）。金额全程 Decimal。 */
export function summarizeRevenueDays(days: readonly RevenueDayRow[]): RevenueDashboardView["summary"] {
  let income = new Decimal(0);
  let newUsers = 0;
  let activeSum = 0;
  let activeDays = 0;
  let reportedDays = 0;
  let noUpstreamRowDays = 0;
  let notSyncedDays = 0;
  for (const day of days) {
    if (day.coverage === "reported") {
      reportedDays += 1;
      if (day.shareIncomeUsd !== null) income = income.plus(day.shareIncomeUsd);
      newUsers += day.newUsers ?? 0;
      if (day.activeUsers !== null) {
        activeSum += day.activeUsers;
        activeDays += 1;
      }
    } else if (day.coverage === "no_upstream_row") {
      noUpstreamRowDays += 1;
      activeDays += 1; // 视为 0 活动：进分母，分子加 0
    } else {
      notSyncedDays += 1;
    }
  }
  return {
    shareIncomeUsdTotal: income.toFixed(4),
    newUsersTotal: newUsers,
    avgActiveUsers: activeDays === 0 ? null : new Decimal(activeSum).div(activeDays).toFixed(2),
    reportedDays,
    noUpstreamRowDays,
    notSyncedDays,
  };
}

function validateQuery(query: { dateFrom: string; dateTo: string }): void {
  if (
    typeof query?.dateFrom !== "string" || typeof query?.dateTo !== "string"
    || !isValidCalendarDate(query.dateFrom) || !isValidCalendarDate(query.dateTo)
    || query.dateFrom > query.dateTo
    || inclusiveDaySpan(query.dateFrom, query.dateTo) > REVENUE_SYNC_MAX_SPAN_DAYS
  ) {
    throw new RevenueDashboardQueryError("invalid_range");
  }
}

export async function loadRevenueDashboard(
  db: PrismaClient,
  query: { dateFrom: string; dateTo: string },
): Promise<RevenueDashboardView> {
  validateQuery(query);
  const { dateFrom, dateTo } = query;
  const range = { dateFrom, dateTo, dayCount: inclusiveDaySpan(dateFrom, dateTo) };
  const readDb = db;

  const resolution = await resolveRevenueChannelAccount(readDb);
  if (resolution.status !== "ok") {
    // 没有可用 / 唯一的账号：页面照常渲染，但每一天都是“未同步”，不假装有数据。
    const emptyDays = buildRevenueDays({ dateFrom, dateTo, stats: [], coveredRanges: [] });
    return {
      account: null,
      range,
      summary: summarizeRevenueDays(emptyDays),
      days: emptyDays,
      batches: [],
      activeTask: null,
      credential: null,
      lastSuccessfulSyncAt: null,
    };
  }

  const scope = await readDb.revenueSyncScope.findUnique({
    where: { channelAccountId_projectType: { channelAccountId: resolution.channelAccountId, projectType: NOVEL_REVENUE_PROJECT_TYPE } },
    select: { id: true },
  });

  const [stats, covering, recentBatches, lastSuccess, activeTask, credentials] = await Promise.all([
    scope
      ? readDb.revenueDailyStat.findMany({
          where: { revenueSyncScopeId: scope.id, statDate: { gte: dateOnly(dateFrom), lte: dateOnly(dateTo) } },
          select: { statDate: true, realDevNum: true, newRealDevNum: true, realDevNumRate: true, realIncome: true },
        })
      : Promise.resolve([] as DailyStatRow[]),
    scope
      ? readDb.revenueSyncBatch.findMany({
          where: {
            revenueSyncScopeId: scope.id,
            status: { in: [...SUCCESSFUL_BATCH_STATUSES] },
            beginDate: { lte: dateOnly(dateTo) },
            endDate: { gte: dateOnly(dateFrom) },
          },
          select: { beginDate: true, endDate: true },
        })
      : Promise.resolve([] as Array<{ beginDate: Date; endDate: Date }>),
    scope
      ? readDb.revenueSyncBatch.findMany({
          where: { revenueSyncScopeId: scope.id },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: REVENUE_DASHBOARD_BATCH_LIMIT,
          select: {
            id: true, createdAt: true, finishedAt: true, beginDate: true, endDate: true, status: true,
            detailRowCount: true, totalRowCount: true, reconciliationStatus: true, upstreamStarId: true,
            credentialFingerprintPrefix: true, errorCode: true, errorMessage: true, genericTaskId: true,
          },
        })
      : Promise.resolve([]),
    scope
      ? readDb.revenueSyncBatch.findFirst({
          where: { revenueSyncScopeId: scope.id, status: { in: [...SUCCESSFUL_BATCH_STATUSES] }, finishedAt: { not: null } },
          orderBy: { finishedAt: "desc" },
          select: { finishedAt: true },
        })
      : Promise.resolve(null),
    readDb.genericTask.findFirst({
      where: {
        taskType: REVENUE_SYNC_TASK_TYPE,
        channelAccountId: resolution.channelAccountId,
        status: { in: ["pending", "processing"] },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, status: true, createdAt: true },
    }),
    // 只读元数据（指纹前缀 / 状态 / 到期时间），不含密文。
    listCredentialMetadata(db, resolution.channelAccountId),
  ]);

  const days = buildRevenueDays({
    dateFrom,
    dateTo,
    stats,
    coveredRanges: covering.map((batch) => ({ beginDate: isoDate(batch.beginDate), endDate: isoDate(batch.endDate) })),
  });
  const credential = credentials.find((item) => item.status === "active") ?? credentials[0] ?? null;

  return {
    account: {
      id: resolution.channelAccountId,
      label: maskRevenueAccountLabel(resolution.accountName),
      novelAppCount: resolution.novelAppCount,
    },
    range,
    summary: summarizeRevenueDays(days),
    days,
    batches: recentBatches.map((batch): RevenueBatchRow => ({
      id: batch.id,
      createdAt: batch.createdAt.toISOString(),
      finishedAt: batch.finishedAt ? batch.finishedAt.toISOString() : null,
      beginDate: isoDate(batch.beginDate),
      endDate: isoDate(batch.endDate),
      status: batch.status as RevenueBatchRow["status"],
      detailRowCount: batch.detailRowCount,
      totalRowCount: batch.totalRowCount,
      reconciliationStatus: batch.reconciliationStatus as RevenueBatchRow["reconciliationStatus"],
      upstreamStarId: batch.upstreamStarId,
      credentialFingerprintPrefix: batch.credentialFingerprintPrefix,
      errorCode: batch.errorCode,
      errorMessage: batch.errorMessage,
      genericTaskId: batch.genericTaskId,
    })),
    activeTask: activeTask
      ? { id: activeTask.id, status: activeTask.status, createdAt: activeTask.createdAt.toISOString() }
      : null,
    credential: credential ? { status: credential.status, expiresAt: credential.expiresAt } : null,
    lastSuccessfulSyncAt: lastSuccess?.finishedAt ? lastSuccess.finishedAt.toISOString() : null,
  };
}
