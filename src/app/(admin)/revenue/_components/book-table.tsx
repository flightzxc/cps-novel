import Link from "next/link";

import { StatusBadge } from "@/components/ui/status-badge";
import { EmptyRow, Table, TBody, TD, TH, THead } from "@/components/ui/table";
import { REVENUE_BOOK_FILTER_UNMATCHED, type RevenueBookSection, type RevenueBookSummaryRow } from "@/server/revenue";

import { revenueHref } from "../_lib/breakdown-params";
import { bookMatchView, breakdownUncoveredNotice } from "../_lib/copy";
import { formatCount, formatRatioPercent, formatUsd, PLACEHOLDER } from "../_lib/format";

type Range = { dateFrom: string; dateTo: string };

function BookCell({ row }: { row: RevenueBookSummaryRow }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <div className="break-words font-medium text-gray-900" data-testid="revenue-book-upstream-name">
        {row.upstreamBookName || <span className="text-gray-400">（上游未给书名）</span>}
      </div>
      {row.novel ? (
        <Link href={`/novels/${row.novel.id}`} className="block text-xs text-blue-600 hover:text-blue-700">
          本站：{row.novel.title}
          <span className="ml-1 text-gray-400">{row.novel.locale}</span>
        </Link>
      ) : row.matchStatus === "matched" ? (
        <div className="text-xs text-gray-500">已匹配来源条目，尚未建书</div>
      ) : null}
      <div className="font-mono text-[11px] text-gray-400">{row.seriesKey}</div>
    </div>
  );
}

function TheaterCell({ row }: { row: RevenueBookSummaryRow }) {
  const match = bookMatchView(row.matchStatus);
  return (
    <div className="space-y-1">
      {row.theater && <div className="text-sm text-gray-900">{row.theater.label}</div>}
      {row.matchStatus !== "matched" && <StatusBadge tone={match.tone}>{match.label}</StatusBadge>}
    </div>
  );
}

function FilterChips({ section, range }: { section: RevenueBookSection; range: Range }) {
  const chips: Array<{ key: string; label: string; value: string | null }> = [
    { key: "all", label: "全部剧场", value: null },
    ...section.theaters.map((theater) => ({
      key: theater.id,
      label: theater.active ? theater.label : `${theater.label}（已停用）`,
      value: theater.id,
    })),
    { key: REVENUE_BOOK_FILTER_UNMATCHED, label: "未匹配", value: REVENUE_BOOK_FILTER_UNMATCHED },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="剧场筛选" data-testid="revenue-book-filter">
      {chips.map((chip) => {
        const active = section.filter === chip.value;
        return (
          <Link
            key={chip.key}
            href={revenueHref({ ...range, theater: chip.value })}
            aria-current={active ? "true" : undefined}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
              active ? "border-blue-300 bg-blue-50 text-blue-700" : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
            }`}
          >
            {chip.label}
          </Link>
        );
      })}
    </div>
  );
}

function Pagination({ section, range }: { section: RevenueBookSection; range: Range }) {
  if (section.pageCount <= 1) return null;
  const link = (page: number, label: string) => (
    <Link
      href={revenueHref({ ...range, theater: section.filter, bookPage: page, hash: "revenue-books" })}
      className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label="按书翻页" className="flex items-center gap-2 text-sm text-gray-500" data-testid="revenue-book-pagination">
      {section.page > 1 && link(section.page - 1, "上一页")}
      <span>
        第 {section.page} / {section.pageCount} 页
      </span>
      {section.page < section.pageCount && link(section.page + 1, "下一页")}
    </nav>
  );
}

function BookDetail({ detail, section, range }: { detail: NonNullable<RevenueBookSection["detail"]>; section: RevenueBookSection; range: Range }) {
  return (
    <div id="revenue-book-detail" data-testid="revenue-book-detail" className="space-y-2 rounded-xl border border-blue-200 bg-blue-50/40 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-900">
          单书按日明细：{detail.book.upstreamBookName || detail.book.seriesKey}
          {detail.book.theater && <span className="ml-2 text-xs font-normal text-gray-500">{detail.book.theater.label}</span>}
        </h3>
        <Link
          href={revenueHref({ ...range, theater: section.filter, bookPage: section.page, hash: "revenue-books" })}
          className="text-xs text-blue-600 hover:text-blue-700"
        >
          收起
        </Link>
      </div>
      <Table>
        <THead>
          <tr>
            <TH>日期（北京时间）</TH>
            <TH className="text-right">激活用户</TH>
            <TH className="text-right">新用户</TH>
            <TH className="text-right">新用户比例</TH>
            <TH className="text-right">分成收入（US$）</TH>
          </tr>
        </THead>
        <TBody>
          {detail.days.map((day) => (
            <tr key={day.date} data-testid={`revenue-book-day-${day.date}`}>
              <TD className="font-mono text-xs">{day.date}</TD>
              <TD className="text-right tabular-nums">{formatCount(day.activeUsers)}</TD>
              <TD className="text-right tabular-nums">{formatCount(day.newUsers)}</TD>
              <TD className="text-right tabular-nums">
                {day.newUserRatio === null ? PLACEHOLDER : formatRatioPercent(day.newUserRatio)}
              </TD>
              <TD className="text-right tabular-nums">{formatUsd(day.shareIncomeUsd)}</TD>
            </tr>
          ))}
        </TBody>
      </Table>
      <p className="text-xs text-gray-500">只列出上游有这本书数据的日期；没列出的已同步日期，这本书当天没有活动。</p>
    </div>
  );
}

/**
 * 按书统计（v0.6.2）：区间汇总按书排行（收入、新用户倒序），可按剧场筛选、翻页，点「按日」看单本书每天的数据。
 * 页面参照 CPS 畅读收入页的「收益统计（剧场 × 短剧）」，但网文的书级数据来自 GetReport 维度 8，
 * 不是短剧专用的 GetMDetailsReport。激活用户不可跨日相加，所以汇总表里不出现，只在单书按日明细里出现。
 */
export function BookTable({ section, range }: { section: RevenueBookSection; range: Range }) {
  const offset = (section.page - 1) * section.pageSize;
  return (
    <section id="revenue-books" aria-labelledby="revenue-books-heading" data-testid="revenue-books" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="revenue-books-heading" className="text-sm font-semibold text-gray-900">
          按书统计
          <span className="ml-2 text-xs font-normal text-gray-500">区间汇总；点「按日」看单本书每天的数据</span>
        </h2>
        <p className="text-xs text-gray-500" data-testid="revenue-book-totals">
          {section.bookCount} 本书有数据 · 新用户 {formatCount(section.newUsersTotal)} · 分成收入 US${formatUsd(section.shareIncomeUsdTotal)}
        </p>
      </div>

      {section.uncoveredDays > 0 && (
        <p role="status" data-testid="revenue-book-uncovered" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {breakdownUncoveredNotice("按书", section.uncoveredDays)}
        </p>
      )}
      {section.filterNotice && (
        <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {section.filterNotice}
        </p>
      )}

      <FilterChips section={section} range={range} />

      <Table>
        <THead>
          <tr>
            <TH className="w-12 text-right">#</TH>
            <TH>书（上游书名 / 本站书）</TH>
            <TH>剧场</TH>
            <TH className="text-right">新用户</TH>
            <TH className="text-right">分成收入（US$）</TH>
            <TH className="text-right">有数据天数</TH>
            <TH>明细</TH>
          </tr>
        </THead>
        <TBody>
          {section.rows.length === 0 ? (
            <EmptyRow colSpan={7}>
              {section.coveredDays === 0 ? "所选区间还没有按书数据，请先发起同步。" : "所选区间、所选剧场没有按书数据。"}
            </EmptyRow>
          ) : (
            section.rows.map((row, index) => (
              <tr key={row.seriesKey} data-testid={`revenue-book-${row.seriesKey}`} data-match={row.matchStatus}>
                <TD className="text-right tabular-nums text-gray-400">{offset + index + 1}</TD>
                <TD className="max-w-md">
                  <BookCell row={row} />
                </TD>
                <TD>
                  <TheaterCell row={row} />
                </TD>
                <TD className="text-right tabular-nums">{formatCount(row.newUsersTotal)}</TD>
                <TD className="text-right tabular-nums">{formatUsd(row.shareIncomeUsdTotal)}</TD>
                <TD className="text-right tabular-nums">{formatCount(row.dayCount)}</TD>
                <TD>
                  <Link
                    href={revenueHref({ ...range, theater: section.filter, bookPage: section.page, book: row.seriesKey, hash: "revenue-book-detail" })}
                    className="text-xs text-blue-600 hover:text-blue-700"
                  >
                    按日
                  </Link>
                </TD>
              </tr>
            ))
          )}
        </TBody>
      </Table>
      <Pagination section={section} range={range} />
      {section.detail && <BookDetail detail={section.detail} section={section} range={range} />}
    </section>
  );
}
