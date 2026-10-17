/**
 * v0.6.2 收益看板读服务·按书与国家（后台 `/revenue` 页的两个新区块）。
 *
 * 数据由 worker 的 `changdu.revenue_sync.v1` 在同一次同步里写入 `revenue_book_daily_stat` /
 * `revenue_country_daily_stat`（见 `worker/handlers/revenue-sync.ts`）；这里只读，只用 web_app 有权限的表与列：
 * 两张统计表、`revenue_sync_batch`（覆盖判定）、`channel_app` / `source_app`（剧场名）、
 * `novel_source_item` 的 id / title / novel_id（列级授权）、`novel` 的 id / title / locale。
 *
 * ── 覆盖口径（与按日的三态同一思路）────────────────────────────────────────────
 * 某一天“按书已同步” = 被某个 completed / partial_failed 且 `book_status = 'completed'` 的批次区间覆盖；
 * 国家同理看 `country_status`。早于 v0.6.2 的存量批次这两列是 NULL，不算覆盖——页面据此提示
 * “区间内有 N 天的按书数据未同步，重新同步这些日期即可补齐”，而不是把它们当成 0。
 *
 * ── 按书 ──────────────────────────────────────────────────────────────────────
 * 区间汇总按书（上游 seriesKey）分组：新用户合计、分成收入合计、有数据天数；按收入、新用户倒序分页。
 * 激活用户不可跨日相加，所以汇总里不出现，只在单书按日明细里出现。书名、匹配结果、剧场取该书在区间内
 * **最近一天**的行（重新同步会刷新匹配）。剧场筛选：全部 / 某个剧场（channel_app）/ 未匹配。
 *
 * ── 国家（新用户 + 激活）────────────────────────────────────────────────────────
 * 区间内国家排行：新用户合计、占比、日均激活（激活是当天活跃人数，同一用户多天活跃会重复计，不能跨日相加，
 * 所以给“激活合计 ÷ 激活已同步天数”）。“国家 × 日期”矩阵按 `countryMetric`（缺省新用户 / active 激活）取该口径
 * 排行前 N 个国家做列，其余并为“其他”，只列该口径当天有人数的日期。
 * 激活单独判覆盖：要求批次 `country_status = 'completed'` 且 `country_active_included = true`；
 * 早于激活口径的批次写下的国家行 `real_dev_num` 为 NULL，不计入激活——页面显示“激活未同步”，不当 0。
 *
 * 金额全程 Decimal / 十进制字符串，不经过 JS 浮点。
 */
import { Prisma, type PrismaClient } from "@prisma/client";

import { NOVEL_REVENUE_PROJECT_TYPE } from "@/lib/adapters/moboreader-revenue-constants";
import { isValidCalendarDate } from "@/lib/adapters/moboreader-revenue-parser";
import { REVENUE_SYNC_MAX_SPAN_DAYS, addDaysToDate, inclusiveDaySpan } from "@/lib/tasks/revenue-sync";

import { resolveRevenueChannelAccount } from "./account";

export const REVENUE_BOOK_PAGE_SIZE = 50;
export const REVENUE_COUNTRY_MATRIX_COLUMNS = 8;
/** 剧场筛选里“未匹配”的取值（其余取值是 channel_app 的 uuid，或缺省 = 全部）。 */
export const REVENUE_BOOK_FILTER_UNMATCHED = "unmatched";

export type RevenueBookMatchView = "matched" | "ambiguous" | "unmatched";

export type RevenueTheaterOption = { id: string; label: string; active: boolean };

export type RevenueBookSummaryRow = {
  seriesKey: string; // 上游 `1_<seriesId>`
  upstreamBookName: string;
  matchStatus: RevenueBookMatchView;
  theater: { id: string; label: string } | null;
  /** 匹配到的来源条目对应的本站书；来源条目还没建书时为 null。 */
  novel: { id: string; title: string; locale: string } | null;
  newUsersTotal: number;
  shareIncomeUsdTotal: string; // "0.0000"
  dayCount: number;
};

export type RevenueBookDayRow = {
  date: string;
  activeUsers: number | null;
  newUsers: number | null;
  newUserRatio: string | null;
  shareIncomeUsd: string | null;
};

export type RevenueBookSection = {
  /** 区间内被“按书已同步”的批次覆盖的天数 / 未覆盖的天数。 */
  coveredDays: number;
  uncoveredDays: number;
  theaters: RevenueTheaterOption[];
  /** 生效的筛选：null = 全部；"unmatched"；或某个剧场 id。非法取值回落为 null 并给出 `filterNotice`。 */
  filter: string | null;
  filterNotice: string | null;
  page: number;
  pageSize: number;
  pageCount: number;
  bookCount: number; // 当前筛选下区间内有数据的书数
  newUsersTotal: number;
  shareIncomeUsdTotal: string;
  rows: RevenueBookSummaryRow[];
  /** `?book=` 指定的单书按日明细（区间内，日期倒序）；没指定或该书区间内无数据为 null。 */
  detail: { book: RevenueBookSummaryRow; days: RevenueBookDayRow[] } | null;
};

export type RevenueCountryMetric = "new" | "active";

export type RevenueCountryRankRow = {
  label: string; // 上游原文，如 "巴西(BR)"
  code: string | null;
  newUsers: number;
  share: string | null; // 新用户占比小数串，"0.4286"；新用户合计为 0 时 null
  /** 日均激活（两位小数串）= 激活合计 ÷ 区间内激活已同步天数；激活一天都没同步时为 null。 */
  avgActiveUsers: string | null;
};

export type RevenueCountryMatrix = {
  columns: Array<{ label: string; code: string | null }>;
  hasOther: boolean;
  rows: Array<{ date: string; values: number[]; other: number; total: number }>; // 日期倒序
};

export type RevenueCountrySection = {
  /** 新用户口径的覆盖天数（批次 country_status = completed）。 */
  coveredDays: number;
  uncoveredDays: number;
  /** 激活口径的覆盖天数（还要求 country_active_included = true）。 */
  activeCoveredDays: number;
  activeUncoveredDays: number;
  newUsersTotal: number;
  /** 全部国家合计的日均激活；激活一天都没同步时为 null。 */
  avgActiveUsersTotal: string | null;
  /** 矩阵当前展示的口径。 */
  metric: RevenueCountryMetric;
  ranking: RevenueCountryRankRow[];
  matrix: RevenueCountryMatrix;
};

export type RevenueBreakdownView = {
  books: RevenueBookSection;
  countries: RevenueCountrySection;
};

export type RevenueBreakdownQuery = {
  dateFrom: string;
  dateTo: string;
  /** 缺省 / "all" = 全部；"unmatched"；或剧场（channel_app）id。 */
  theater?: string | null;
  bookPage?: number | null;
  /** 单书按日明细：上游 seriesKey（`1_<数字>`）。 */
  book?: string | null;
  /** 国家矩阵的口径：缺省 / 其它取值 = 新用户；"active" = 激活。 */
  countryMetric?: string | null;
};

const Decimal = Prisma.Decimal;
const SUCCESSFUL_BATCH_STATUSES = ["completed", "partial_failed"] as const;
const SERIES_KEY_SHAPE = /^1_\d{1,30}$/;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class RevenueBreakdownQueryError extends Error {
  constructor(readonly code: "invalid_range") {
    super(`revenue_breakdown_query_invalid: ${code}`);
    this.name = "RevenueBreakdownQueryError";
  }
}

function dateOnly(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** 区间内被若干批次区间覆盖的天数（纯函数，便于单测）。 */
export function countCoveredDays(
  dateFrom: string,
  dateTo: string,
  ranges: readonly { beginDate: string; endDate: string }[],
): number {
  let covered = 0;
  for (let date = dateFrom; date <= dateTo; date = addDaysToDate(date, 1)) {
    if (ranges.some((range) => range.beginDate <= date && date <= range.endDate)) covered += 1;
  }
  return covered;
}

type CountryStatRow = { date: string; label: string; code: string | null; newUsers: number; activeUsers: number | null };

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 国家排行 + 矩阵（纯函数）。`rows` 是 (日期, 国家) 粒度的行，`activeUsers` 为 null 表示写这一行的批次没有拉激活
 * （不计入激活）。排行按新用户倒序、激活合计倒序、国名升序。
 */
export function buildCountrySection(input: {
  rows: readonly CountryStatRow[];
  coveredDays: number;
  uncoveredDays: number;
  activeCoveredDays: number;
  activeUncoveredDays: number;
  metric?: RevenueCountryMetric;
  columns?: number;
}): RevenueCountrySection {
  const metric = input.metric ?? "new";
  const totals = new Map<string, { code: string | null; newUsers: number; activeUsers: number }>();
  let newTotal = 0;
  let activeTotal = 0;
  for (const row of input.rows) {
    const current = totals.get(row.label) ?? { code: row.code, newUsers: 0, activeUsers: 0 };
    current.newUsers += row.newUsers;
    current.activeUsers += row.activeUsers ?? 0;
    totals.set(row.label, current);
    newTotal += row.newUsers;
    activeTotal += row.activeUsers ?? 0;
  }
  const average = (sum: number) => (input.activeCoveredDays === 0 ? null : new Decimal(sum).div(input.activeCoveredDays).toFixed(2));
  const ranked = [...totals.entries()]
    .map(([label, value]) => ({ label, ...value }))
    .sort((a, b) => b.newUsers - a.newUsers || b.activeUsers - a.activeUsers || compareText(a.label, b.label));
  const ranking = ranked.map((row): RevenueCountryRankRow => ({
    label: row.label,
    code: row.code,
    newUsers: row.newUsers,
    share: newTotal === 0 ? null : new Decimal(row.newUsers).div(newTotal).toFixed(4),
    avgActiveUsers: average(row.activeUsers),
  }));

  // 矩阵：只取当前口径里人数 > 0 的国家与日期。
  const valueOf = (row: CountryStatRow) => (metric === "active" ? row.activeUsers ?? 0 : row.newUsers);
  const limit = input.columns ?? REVENUE_COUNTRY_MATRIX_COLUMNS;
  const metricRanked = [...ranked]
    .filter((row) => (metric === "active" ? row.activeUsers : row.newUsers) > 0)
    .sort((a, b) => (metric === "active" ? b.activeUsers - a.activeUsers : b.newUsers - a.newUsers) || compareText(a.label, b.label));
  const columns = metricRanked.slice(0, limit).map((row) => ({ label: row.label, code: row.code }));
  const columnIndex = new Map(columns.map((column, index) => [column.label, index]));
  const byDate = new Map<string, { values: number[]; other: number; total: number }>();
  for (const row of input.rows) {
    const value = valueOf(row);
    if (value === 0) continue;
    const entry = byDate.get(row.date) ?? { values: columns.map(() => 0), other: 0, total: 0 };
    const index = columnIndex.get(row.label);
    if (index === undefined) entry.other += value;
    else entry.values[index] += value;
    entry.total += value;
    byDate.set(row.date, entry);
  }
  const matrixRows = [...byDate.entries()]
    .map(([date, entry]) => ({ date, ...entry }))
    .sort((a, b) => compareText(b.date, a.date));

  return {
    coveredDays: input.coveredDays,
    uncoveredDays: input.uncoveredDays,
    activeCoveredDays: input.activeCoveredDays,
    activeUncoveredDays: input.activeUncoveredDays,
    newUsersTotal: newTotal,
    avgActiveUsersTotal: average(activeTotal),
    metric,
    ranking,
    matrix: { columns, hasOther: metricRanked.length > columns.length, rows: matrixRows },
  };
}

function validateQuery(query: RevenueBreakdownQuery): void {
  if (
    typeof query?.dateFrom !== "string" || typeof query?.dateTo !== "string"
    || !isValidCalendarDate(query.dateFrom) || !isValidCalendarDate(query.dateTo)
    || query.dateFrom > query.dateTo
    || inclusiveDaySpan(query.dateFrom, query.dateTo) > REVENUE_SYNC_MAX_SPAN_DAYS
  ) {
    throw new RevenueBreakdownQueryError("invalid_range");
  }
}

function emptyView(query: RevenueBreakdownQuery, dayCount: number): RevenueBreakdownView {
  return {
    books: {
      coveredDays: 0,
      uncoveredDays: dayCount,
      theaters: [],
      filter: null,
      filterNotice: null,
      page: 1,
      pageSize: REVENUE_BOOK_PAGE_SIZE,
      pageCount: 1,
      bookCount: 0,
      newUsersTotal: 0,
      shareIncomeUsdTotal: "0.0000",
      rows: [],
      detail: null,
    },
    countries: buildCountrySection({
      rows: [],
      coveredDays: 0,
      uncoveredDays: dayCount,
      activeCoveredDays: 0,
      activeUncoveredDays: dayCount,
      metric: countryMetricOf(query),
    }),
  };
}

function countryMetricOf(query: RevenueBreakdownQuery): RevenueCountryMetric {
  return query.countryMetric === "active" ? "active" : "new";
}

type BookLatestRow = {
  upstreamSeriesKey: string;
  upstreamBookName: string;
  matchStatus: string;
  channelAppId: string | null;
  novelSourceItem: { novel: { id: string; title: string; locale: string } | null } | null;
};

function toMatchView(value: string): RevenueBookMatchView {
  return value === "matched" || value === "ambiguous" ? value : "unmatched";
}

export async function loadRevenueBreakdowns(db: PrismaClient, query: RevenueBreakdownQuery): Promise<RevenueBreakdownView> {
  validateQuery(query);
  const { dateFrom, dateTo } = query;
  const dayCount = inclusiveDaySpan(dateFrom, dateTo);

  const resolution = await resolveRevenueChannelAccount(db);
  if (resolution.status !== "ok") return emptyView(query, dayCount);
  const scope = await db.revenueSyncScope.findUnique({
    where: { channelAccountId_projectType: { channelAccountId: resolution.channelAccountId, projectType: NOVEL_REVENUE_PROJECT_TYPE } },
    select: { id: true },
  });

  const theaterApps = await db.channelApp.findMany({
    where: { projectType: NOVEL_REVENUE_PROJECT_TYPE, channel: { channelAccounts: { some: { id: resolution.channelAccountId } } } },
    select: { id: true, status: true, sourceApp: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  const theaters: RevenueTheaterOption[] = theaterApps.map((app) => ({
    id: app.id,
    label: app.sourceApp.name,
    active: app.status === "active",
  }));
  const theaterLabel = new Map(theaters.map((theater) => [theater.id, theater.label]));

  // 剧场筛选：只接受“未匹配”或本账号下的剧场 id；其它取值回落为全部并提示。
  const rawFilter = typeof query.theater === "string" && query.theater.trim() && query.theater !== "all" ? query.theater.trim() : null;
  let filter: string | null = null;
  let filterNotice: string | null = null;
  if (rawFilter === REVENUE_BOOK_FILTER_UNMATCHED || (rawFilter && UUID_SHAPE.test(rawFilter) && theaterLabel.has(rawFilter))) {
    filter = rawFilter;
  } else if (rawFilter) {
    filterNotice = "剧场筛选无效，已显示全部剧场。";
  }

  if (!scope) {
    const empty = emptyView(query, dayCount);
    return { ...empty, books: { ...empty.books, theaters, filter, filterNotice } };
  }

  const range = { gte: dateOnly(dateFrom), lte: dateOnly(dateTo) };
  const overlapping = {
    revenueSyncScopeId: scope.id,
    status: { in: [...SUCCESSFUL_BATCH_STATUSES] },
    beginDate: { lte: dateOnly(dateTo) },
    endDate: { gte: dateOnly(dateFrom) },
  };
  const [bookBatches, countryBatches, countryRows] = await Promise.all([
    db.revenueSyncBatch.findMany({ where: { ...overlapping, bookStatus: "completed" }, select: { beginDate: true, endDate: true } }),
    db.revenueSyncBatch.findMany({
      where: { ...overlapping, countryStatus: "completed" },
      select: { beginDate: true, endDate: true, countryActiveIncluded: true },
    }),
    db.revenueCountryDailyStat.findMany({
      where: { revenueSyncScopeId: scope.id, statDate: range },
      select: { statDate: true, countryLabel: true, countryCode: true, newRealDevNum: true, realDevNum: true },
    }),
  ]);
  const toRanges = (batches: Array<{ beginDate: Date; endDate: Date }>) =>
    batches.map((batch) => ({ beginDate: isoDate(batch.beginDate), endDate: isoDate(batch.endDate) }));
  const bookCovered = countCoveredDays(dateFrom, dateTo, toRanges(bookBatches));
  const countryCovered = countCoveredDays(dateFrom, dateTo, toRanges(countryBatches));
  const activeCovered = countCoveredDays(dateFrom, dateTo, toRanges(countryBatches.filter((batch) => batch.countryActiveIncluded)));

  const filterSql = filter === null
    ? Prisma.empty
    : filter === REVENUE_BOOK_FILTER_UNMATCHED
      ? Prisma.sql`AND match_status = 'unmatched'`
      : Prisma.sql`AND channel_app_id = ${filter}::uuid`;
  const baseWhere = Prisma.sql`
    WHERE revenue_sync_scope_id = ${scope.id}::uuid
      AND stat_date BETWEEN ${dateFrom}::date AND ${dateTo}::date
      ${filterSql}`;

  const [totalsRow] = await db.$queryRaw<Array<{ bookCount: number; newUsers: number; income: string }>>`
    SELECT COUNT(DISTINCT upstream_series_key)::int AS "bookCount",
           COALESCE(SUM(new_real_dev_num), 0)::int AS "newUsers",
           COALESCE(SUM(real_income), 0)::text AS "income"
      FROM revenue_book_daily_stat
      ${baseWhere}`;
  const bookCount = totalsRow?.bookCount ?? 0;
  const pageCount = Math.max(1, Math.ceil(bookCount / REVENUE_BOOK_PAGE_SIZE));
  const requestedPage = Number.isSafeInteger(query.bookPage) && (query.bookPage ?? 0) > 0 ? (query.bookPage as number) : 1;
  const page = Math.min(requestedPage, pageCount);

  const aggregates = await db.$queryRaw<Array<{ seriesKey: string; newUsers: number; income: string; dayCount: number }>>`
    SELECT upstream_series_key AS "seriesKey",
           COALESCE(SUM(new_real_dev_num), 0)::int AS "newUsers",
           COALESCE(SUM(real_income), 0)::text AS "income",
           COUNT(*)::int AS "dayCount"
      FROM revenue_book_daily_stat
      ${baseWhere}
     GROUP BY upstream_series_key
     ORDER BY COALESCE(SUM(real_income), 0) DESC, COALESCE(SUM(new_real_dev_num), 0) DESC, upstream_series_key ASC
     LIMIT ${REVENUE_BOOK_PAGE_SIZE} OFFSET ${(page - 1) * REVENUE_BOOK_PAGE_SIZE}`;

  const detailKey = typeof query.book === "string" && SERIES_KEY_SHAPE.test(query.book) ? query.book : null;
  const keys = [...new Set([...aggregates.map((row) => row.seriesKey), ...(detailKey ? [detailKey] : [])])];
  const latestRows: BookLatestRow[] = keys.length === 0
    ? []
    : await db.revenueBookDailyStat.findMany({
        where: { revenueSyncScopeId: scope.id, statDate: range, upstreamSeriesKey: { in: keys } },
        orderBy: [{ statDate: "desc" }],
        distinct: ["upstreamSeriesKey"],
        select: {
          upstreamSeriesKey: true,
          upstreamBookName: true,
          matchStatus: true,
          channelAppId: true,
          novelSourceItem: { select: { novel: { select: { id: true, title: true, locale: true } } } },
        },
      });
  const latest = new Map(latestRows.map((row) => [row.upstreamSeriesKey, row]));

  const summaryRow = (aggregate: { seriesKey: string; newUsers: number; income: string; dayCount: number }): RevenueBookSummaryRow => {
    const row = latest.get(aggregate.seriesKey);
    const channelAppId = row?.channelAppId ?? null;
    return {
      seriesKey: aggregate.seriesKey,
      upstreamBookName: row?.upstreamBookName ?? "",
      matchStatus: toMatchView(row?.matchStatus ?? "unmatched"),
      theater: channelAppId ? { id: channelAppId, label: theaterLabel.get(channelAppId) ?? channelAppId } : null,
      novel: row?.novelSourceItem?.novel ?? null,
      newUsersTotal: aggregate.newUsers,
      shareIncomeUsdTotal: new Decimal(aggregate.income).toFixed(4),
      dayCount: aggregate.dayCount,
    };
  };

  let detail: RevenueBookSection["detail"] = null;
  if (detailKey && latest.has(detailKey)) {
    const dayRows = await db.revenueBookDailyStat.findMany({
      where: { revenueSyncScopeId: scope.id, statDate: range, upstreamSeriesKey: detailKey },
      orderBy: [{ statDate: "desc" }],
      select: { statDate: true, realDevNum: true, newRealDevNum: true, realDevNumRate: true, realIncome: true },
    });
    let newUsers = 0;
    let income = new Decimal(0);
    for (const day of dayRows) {
      newUsers += day.newRealDevNum ?? 0;
      if (day.realIncome !== null) income = income.plus(day.realIncome);
    }
    detail = {
      book: summaryRow({ seriesKey: detailKey, newUsers, income: income.toFixed(), dayCount: dayRows.length }),
      days: dayRows.map((day) => ({
        date: isoDate(day.statDate),
        activeUsers: day.realDevNum,
        newUsers: day.newRealDevNum,
        newUserRatio: day.realDevNumRate === null ? null : day.realDevNumRate.toFixed(),
        shareIncomeUsd: day.realIncome === null ? null : day.realIncome.toFixed(4),
      })),
    };
  }

  return {
    books: {
      coveredDays: bookCovered,
      uncoveredDays: dayCount - bookCovered,
      theaters,
      filter,
      filterNotice,
      page,
      pageSize: REVENUE_BOOK_PAGE_SIZE,
      pageCount,
      bookCount,
      newUsersTotal: totalsRow?.newUsers ?? 0,
      shareIncomeUsdTotal: new Decimal(totalsRow?.income ?? "0").toFixed(4),
      rows: aggregates.map(summaryRow),
      detail,
    },
    countries: buildCountrySection({
      rows: countryRows.map((row) => ({
        date: isoDate(row.statDate),
        label: row.countryLabel,
        code: row.countryCode,
        newUsers: row.newRealDevNum,
        activeUsers: row.realDevNum,
      })),
      coveredDays: countryCovered,
      uncoveredDays: dayCount - countryCovered,
      activeCoveredDays: activeCovered,
      activeUncoveredDays: dayCount - activeCovered,
      metric: countryMetricOf(query),
    }),
  };
}
