import { multiAppTotalHint } from "../_lib/copy";
import { formatAverage, formatCount, formatUsd, PLACEHOLDER } from "../_lib/format";
import type { RevenueDashboardView } from "@/server/revenue";

function Card({
  label,
  value,
  hint,
  testId,
}: {
  label: string;
  value: string;
  hint?: string;
  testId: string;
}) {
  return (
    <div data-testid={testId} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-gray-900">{value}</p>
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

/**
 * 所选区间的 4 张指标卡。
 *
 * 一个容易误导的点：一天都没被同步覆盖时，读服务的合计是 `"0.0000"` / `0`——那是"没有数据可加"，
 * 不是"收入为 0"。所以这种情况下合计显示 `—`；只要有任何一天被覆盖（有记录或上游无记录），
 * 合计就是真实的求和（含"确实是 0"）。有未同步的天时，卡片下方明说"合计偏小"。
 *
 * 账号级：同一畅读账号下有 ≥ 2 个网文应用时（`novelAppCount`），卡片上方加一句灰字提示，说明数字是这些应用的合计。
 */
export function SummaryCards({
  summary,
  novelAppCount = null,
}: {
  summary: RevenueDashboardView["summary"];
  /** 该账号所在 channel 下 active 的网文应用数；没有可用账号时为 null。 */
  novelAppCount?: number | null;
}) {
  const covered = summary.reportedDays + summary.noUpstreamRowDays;
  const hasData = covered > 0;

  return (
    <section aria-label="区间指标" data-testid="revenue-summary" className="space-y-2">
      {novelAppCount !== null && novelAppCount >= 2 && (
        <p data-testid="revenue-multi-app-hint" className="text-xs text-gray-500">
          {multiAppTotalHint(novelAppCount)}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card
          testId="revenue-card-income"
          label="分成收入合计（US$）"
          value={hasData ? formatUsd(summary.shareIncomeUsdTotal) : PLACEHOLDER}
        />
        <Card
          testId="revenue-card-new-users"
          label="新用户合计"
          value={hasData ? formatCount(summary.newUsersTotal) : PLACEHOLDER}
        />
        <Card
          testId="revenue-card-avg-active"
          label="日均激活用户"
          value={formatAverage(summary.avgActiveUsers)}
          hint="上游无记录的天按 0 计入"
        />
        <Card
          testId="revenue-card-coverage"
          label="数据覆盖"
          value={`${summary.reportedDays + summary.noUpstreamRowDays + summary.notSyncedDays} 天`}
          hint={`上游有记录 ${summary.reportedDays} 天 / 上游无记录 ${summary.noUpstreamRowDays} 天 / 未同步 ${summary.notSyncedDays} 天`}
        />
      </div>
      {summary.notSyncedDays > 0 && (
        <p
          role="status"
          data-testid="revenue-not-synced-notice"
          className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          区间内有 {summary.notSyncedDays} 天未同步，合计偏小。
        </p>
      )}
    </section>
  );
}
