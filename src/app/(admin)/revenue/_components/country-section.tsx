import Link from "next/link";

import { EmptyRow, Table, TBody, TD, TH, THead } from "@/components/ui/table";
import type { RevenueCountryMetric, RevenueCountrySection } from "@/server/revenue";

import { revenueHref } from "../_lib/breakdown-params";
import { activeCountryUncoveredNotice, breakdownUncoveredNotice } from "../_lib/copy";
import { formatAverage, formatCount, formatRatioPercent, PLACEHOLDER } from "../_lib/format";

/** 本区块链接要原样带上的页面状态（区间 + 按书区块的筛选 / 页码 / 单书）。 */
type Links = { dateFrom: string; dateTo: string; theater: string | null; bookPage: number; book: string | null };

const ACTIVE_NOT_SYNCED = "激活未同步";
const METRIC_LABEL: Readonly<Record<RevenueCountryMetric, string>> = Object.freeze({ new: "新用户", active: "激活" });

function CountryName({ label, code }: { label: string; code: string | null }) {
  return (
    <span>
      {label}
      {code === null && <span className="ml-1 text-xs text-gray-400">（未识别国家码）</span>}
    </span>
  );
}

function MetricChips({ section, links }: { section: RevenueCountrySection; links: Links }) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="国家矩阵口径" data-testid="revenue-country-metric">
      {(["new", "active"] as const).map((metric) => {
        const active = section.metric === metric;
        return (
          <Link
            key={metric}
            href={revenueHref({ ...links, countryMetric: metric === "active" ? "active" : null, hash: "revenue-countries" })}
            aria-current={active ? "true" : undefined}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
              active ? "border-blue-300 bg-blue-50 text-blue-700" : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
            }`}
          >
            {METRIC_LABEL[metric]}
          </Link>
        );
      })}
    </div>
  );
}

/**
 * 国家分布（v0.6.2，上游 GetCountryReport 逐日下钻）：新用户与激活两种口径。
 * - 排行：新用户合计、占比、日均激活（激活是当天活跃人数，不能跨日相加）；
 * - 「国家 × 日期」：按所选口径列出前 8 个国家，只列该口径当天有人数的日期。
 * 激活一天都没同步时显示「激活未同步」，不显示 0。
 */
export function CountrySection({ section, links }: { section: RevenueCountrySection; links: Links }) {
  const { matrix } = section;
  const activeSynced = section.activeCoveredDays > 0;
  const matrixEmptyText = section.metric === "active" && !activeSynced ? ACTIVE_NOT_SYNCED : `所选区间没有${METRIC_LABEL[section.metric]}国家数据`;
  return (
    <section id="revenue-countries" aria-labelledby="revenue-countries-heading" data-testid="revenue-countries" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="revenue-countries-heading" className="text-sm font-semibold text-gray-900">
          国家分布
          <span className="ml-2 text-xs font-normal text-gray-500">账号级 · 新用户与激活</span>
        </h2>
        <p className="text-xs text-gray-500" data-testid="revenue-country-total">
          区间内新用户 {formatCount(section.newUsersTotal)} · 日均激活{" "}
          {activeSynced ? formatAverage(section.avgActiveUsersTotal) : ACTIVE_NOT_SYNCED} · {section.ranking.length} 个国家 / 地区
        </p>
      </div>

      {section.uncoveredDays > 0 && (
        <p role="status" data-testid="revenue-country-uncovered" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {breakdownUncoveredNotice("国家", section.uncoveredDays)}
        </p>
      )}
      {section.activeUncoveredDays > section.uncoveredDays && (
        <p role="status" data-testid="revenue-country-active-uncovered" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {activeCountryUncoveredNotice(section.activeUncoveredDays)}
        </p>
      )}

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="xl:col-span-1" data-testid="revenue-country-ranking">
          <Table>
            <THead>
              <tr>
                <TH className="w-10 text-right">#</TH>
                <TH>国家 / 地区</TH>
                <TH className="text-right">新用户</TH>
                <TH className="text-right">占比</TH>
                <TH className="text-right">日均激活</TH>
              </tr>
            </THead>
            <TBody>
              {section.ranking.length === 0 ? (
                <EmptyRow colSpan={5}>所选区间没有国家数据</EmptyRow>
              ) : (
                section.ranking.map((row, index) => (
                  <tr key={row.label} data-testid={`revenue-country-${row.code ?? row.label}`}>
                    <TD className="text-right tabular-nums text-gray-400">{index + 1}</TD>
                    <TD>
                      <CountryName label={row.label} code={row.code} />
                    </TD>
                    <TD className="text-right tabular-nums">{formatCount(row.newUsers)}</TD>
                    <TD className="text-right tabular-nums">{row.share === null ? PLACEHOLDER : formatRatioPercent(row.share)}</TD>
                    <TD className="text-right tabular-nums">
                      {row.avgActiveUsers === null ? <span className="text-xs text-gray-400">{ACTIVE_NOT_SYNCED}</span> : formatAverage(row.avgActiveUsers)}
                    </TD>
                  </tr>
                ))
              )}
            </TBody>
          </Table>
          <p className="mt-1 text-xs text-gray-500">
            日均激活 = 区间内激活合计 ÷ 激活已同步的天数（同一用户多天活跃会重复计，不能跨日相加）。
          </p>
        </div>

        <div className="space-y-2 xl:col-span-2" data-testid="revenue-country-matrix">
          <MetricChips section={section} links={links} />
          <Table>
            <THead>
              <tr>
                <TH>日期</TH>
                {matrix.columns.map((column) => (
                  <TH key={column.label} className="whitespace-nowrap text-right" title={column.label}>
                    {column.code ?? column.label}
                  </TH>
                ))}
                {matrix.hasOther && <TH className="text-right">其他</TH>}
                <TH className="text-right">合计</TH>
              </tr>
            </THead>
            <TBody>
              {matrix.rows.length === 0 ? (
                <EmptyRow colSpan={matrix.columns.length + (matrix.hasOther ? 3 : 2)}>{matrixEmptyText}</EmptyRow>
              ) : (
                matrix.rows.map((row) => (
                  <tr key={row.date} data-testid={`revenue-country-day-${row.date}`}>
                    <TD className="font-mono text-xs">{row.date}</TD>
                    {row.values.map((value, index) => (
                      <TD key={matrix.columns[index]!.label} className={`text-right tabular-nums ${value === 0 ? "text-gray-300" : ""}`}>
                        {formatCount(value)}
                      </TD>
                    ))}
                    {matrix.hasOther && <TD className="text-right tabular-nums">{formatCount(row.other)}</TD>}
                    <TD className="text-right font-medium tabular-nums">{formatCount(row.total)}</TD>
                  </tr>
                ))
              )}
            </TBody>
          </Table>
          <p className="text-xs text-gray-500">
            {METRIC_LABEL[section.metric]}口径：列为区间内{METRIC_LABEL[section.metric]}最多的 {matrix.columns.length} 个国家（表头是国家码，悬停看全名）；
            只列{METRIC_LABEL[section.metric]}人数大于 0 的日期。
          </p>
        </div>
      </div>
    </section>
  );
}
