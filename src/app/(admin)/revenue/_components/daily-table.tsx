import { EmptyRow, Table, TBody, TD, TH, THead } from "@/components/ui/table";
import type { RevenueDayRow } from "@/server/revenue";

import { COVERAGE_LABEL } from "../_lib/copy";
import { formatCount, formatRatioPercent, formatUsd, PLACEHOLDER } from "../_lib/format";

function StatusCell({ coverage }: { coverage: RevenueDayRow["coverage"] }) {
  if (coverage === "reported") return null; // 有上游行：不显示任何标记
  if (coverage === "no_upstream_row") {
    return (
      <span
        className="text-gray-400"
        title="这天被成功的同步覆盖过，但上游没有返回——按当天 0 活动处理"
      >
        {COVERAGE_LABEL.no_upstream_row}
      </span>
    );
  }
  return (
    <span className="font-medium text-amber-700" title="这天还没有被任何成功的同步覆盖，不是 0">
      {COVERAGE_LABEL.not_synced}
    </span>
  );
}

/**
 * 每日明细（日期倒序，覆盖所选区间的每一天）。三态在这里必须一眼分得清：
 *   - `reported`        有上游行：显示数值，状态列空；
 *   - `no_upstream_row` 上游没返回：数值列是 0，状态灰字「上游无记录」；
 *   - `not_synced`      从没被覆盖：数值列是 `—`（不是 0），状态「未同步」。
 * 数值展示全部走字符串 / BigInt（`../_lib/format`），不经过浮点。
 */
export function DailyTable({ days }: { days: readonly RevenueDayRow[] }) {
  return (
    <section aria-labelledby="revenue-daily-heading" data-testid="revenue-daily" className="space-y-2">
      <h2 id="revenue-daily-heading" className="text-sm font-semibold text-gray-900">
        每日明细
      </h2>
      <Table>
        <THead>
          <tr>
            <TH>日期（北京时间）</TH>
            <TH className="text-right">激活用户</TH>
            <TH className="text-right">新用户</TH>
            <TH className="text-right">新用户比例</TH>
            <TH className="text-right">分成收入（US$）</TH>
            <TH>状态</TH>
          </tr>
        </THead>
        <TBody>
          {days.length === 0 ? (
            <EmptyRow colSpan={6}>所选区间没有日期</EmptyRow>
          ) : (
            days.map((day) => {
              const notSynced = day.coverage === "not_synced";
              return (
                <tr
                  key={day.date}
                  data-testid={`revenue-day-${day.date}`}
                  data-coverage={day.coverage}
                  className={notSynced ? "bg-amber-50/40" : day.coverage === "no_upstream_row" ? "text-gray-400" : ""}
                >
                  <TD className="font-mono text-xs">{day.date}</TD>
                  <TD className="text-right tabular-nums">{formatCount(day.activeUsers)}</TD>
                  <TD className="text-right tabular-nums">{formatCount(day.newUsers)}</TD>
                  <TD className="text-right tabular-nums">
                    {day.newUserRatio === null ? PLACEHOLDER : formatRatioPercent(day.newUserRatio)}
                  </TD>
                  <TD className="text-right tabular-nums">{formatUsd(day.shareIncomeUsd)}</TD>
                  <TD>
                    <StatusCell coverage={day.coverage} />
                  </TD>
                </tr>
              );
            })
          )}
        </TBody>
      </Table>
    </section>
  );
}
