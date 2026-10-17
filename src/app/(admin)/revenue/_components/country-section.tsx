import { EmptyRow, Table, TBody, TD, TH, THead } from "@/components/ui/table";
import type { RevenueCountrySection } from "@/server/revenue";

import { breakdownUncoveredNotice } from "../_lib/copy";
import { formatCount, formatRatioPercent, PLACEHOLDER } from "../_lib/format";

function CountryName({ label, code }: { label: string; code: string | null }) {
  return (
    <span>
      {label}
      {code === null && <span className="ml-1 text-xs text-gray-400">（未识别国家码）</span>}
    </span>
  );
}

/**
 * 新增用户国家分布（v0.6.2，上游 GetCountryReport 逐日下钻，新用户口径）：区间内国家排行 +「国家 × 日期」。
 * 只有新用户 > 0 的日子才有国家数据，矩阵只列这些日期。
 */
export function CountrySection({ section }: { section: RevenueCountrySection }) {
  const { matrix } = section;
  return (
    <section aria-labelledby="revenue-countries-heading" data-testid="revenue-countries" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="revenue-countries-heading" className="text-sm font-semibold text-gray-900">
          新增用户国家分布
          <span className="ml-2 text-xs font-normal text-gray-500">账号级 · 新用户口径</span>
        </h2>
        <p className="text-xs text-gray-500" data-testid="revenue-country-total">
          区间内新用户 {formatCount(section.newUsersTotal)} · {section.ranking.length} 个国家 / 地区
        </p>
      </div>

      {section.uncoveredDays > 0 && (
        <p role="status" data-testid="revenue-country-uncovered" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {breakdownUncoveredNotice("国家", section.uncoveredDays)}
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
              </tr>
            </THead>
            <TBody>
              {section.ranking.length === 0 ? (
                <EmptyRow colSpan={4}>所选区间没有国家数据</EmptyRow>
              ) : (
                section.ranking.map((row, index) => (
                  <tr key={row.label} data-testid={`revenue-country-${row.code ?? row.label}`}>
                    <TD className="text-right tabular-nums text-gray-400">{index + 1}</TD>
                    <TD>
                      <CountryName label={row.label} code={row.code} />
                    </TD>
                    <TD className="text-right tabular-nums">{formatCount(row.newUsers)}</TD>
                    <TD className="text-right tabular-nums">{row.share === null ? PLACEHOLDER : formatRatioPercent(row.share)}</TD>
                  </tr>
                ))
              )}
            </TBody>
          </Table>
        </div>

        <div className="xl:col-span-2" data-testid="revenue-country-matrix">
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
                <EmptyRow colSpan={matrix.columns.length + (matrix.hasOther ? 3 : 2)}>所选区间没有国家数据</EmptyRow>
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
          <p className="mt-1 text-xs text-gray-500">
            列为区间内新用户最多的 {matrix.columns.length} 个国家（表头是国家码，悬停看全名）；只列有新用户的日期。
          </p>
        </div>
      </div>
    </section>
  );
}
