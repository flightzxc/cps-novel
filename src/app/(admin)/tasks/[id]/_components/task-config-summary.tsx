import { taskModeLabel } from "@/features/admin-ui/content-view";

export type CatalogScanConfigView = {
  readonly pageStart?: number;
  readonly pageEnd?: number;
  readonly pageSize?: number;
  readonly safetyMaxPages?: number;
  readonly languages?: readonly string[];
  readonly source?: "manual";
  readonly requestId?: string;
};

export type CatalogScanAuditView = {
  readonly observedTotal?: number;
  readonly actualFetchedCount?: number;
  readonly lastCompletedPage?: number;
};

function formatAuditValue(value: number | string | undefined): string {
  if (value === undefined) return "—";
  return typeof value === "number" ? value.toLocaleString("zh-CN") : value;
}

/**
 * C-9 (task-detail route): CPS-parity "任务配置" + "目录扫描审计" cards.
 * Every value here comes from `TaskDetailDto`'s already-derived, allowlisted
 * fields (`src/server/task-admin/service.ts`) — this component never sees
 * raw `params`/`result`.
 *
 * C-10b (Phase E rework, 2026-09-07): "停止原因" prefers `originStopReason` —
 * `TaskDetailDto.originStopReason`, the richer *origin-item* line (with HTTP
 * status/page, e.g. `"upstream_error (HTTP 401) @ 第 1 页"`) that
 * `getAdminTaskDetail` now derives itself via one extra query, so it is
 * always available regardless of which items page happens to be currently
 * loaded — unlike the per-item `TaskItemDto.stopReason` the items section
 * below shows, which only exists for whichever row is on the loaded page.
 * Falls back to `stopReason` (the task-level bare code, `TaskSummaryDto.
 * stopReason`) when `originStopReason` is absent — e.g. a task that hasn't
 * finished persisting an item yet, or (defensively) any other case this
 * component can't otherwise account for — so the cell still shows the same
 * code the `/tasks` list page's own "失败原因" column reads.
 */
export function TaskConfigSummary({
  mode,
  catalogScanConfig,
  catalogScanAudit,
  stopReason,
  originStopReason,
}: {
  mode?: string;
  catalogScanConfig?: CatalogScanConfigView;
  catalogScanAudit?: CatalogScanAuditView;
  stopReason?: string;
  originStopReason?: string;
}) {
  const hasConfig = mode !== undefined || catalogScanConfig !== undefined;
  if (!hasConfig) return null;

  const auditEntries = catalogScanAudit
    ? [
        { label: "上游返回 total", value: catalogScanAudit.observedTotal },
        { label: "实际抓取条数", value: catalogScanAudit.actualFetchedCount },
        { label: "停止原因", value: originStopReason ?? stopReason },
        { label: "最后一页", value: catalogScanAudit.lastCompletedPage },
        { label: "保险丝页数", value: catalogScanConfig?.safetyMaxPages },
      ]
    : [];

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm" data-testid="task-config-summary">
        <p className="text-sm font-medium text-gray-700">任务配置</p>
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-500">
          {mode !== undefined && (
            <span>
              运行模式：<strong className="text-gray-700">{taskModeLabel(mode)}</strong>
            </span>
          )}
          {catalogScanConfig?.pageStart !== undefined && catalogScanConfig.pageEnd !== undefined && (
            <span>
              页范围：
              <strong className="text-gray-700">
                第 {catalogScanConfig.pageStart}–{catalogScanConfig.pageEnd} 页
                {catalogScanConfig.pageSize !== undefined ? `（每页 ${catalogScanConfig.pageSize} 条）` : ""}
              </strong>
            </span>
          )}
          {catalogScanConfig?.safetyMaxPages !== undefined && (
            <span>
              保险丝页数：<strong className="text-gray-700">{catalogScanConfig.safetyMaxPages}</strong>
            </span>
          )}
          {catalogScanConfig?.languages !== undefined && catalogScanConfig.languages.length > 0 && (
            <span>
              语种：<strong className="text-gray-700">{catalogScanConfig.languages.join("、")}</strong>
            </span>
          )}
          {catalogScanConfig?.source !== undefined && (
            <span>
              来源：<strong className="text-gray-700">{catalogScanConfig.source}</strong>
            </span>
          )}
          {catalogScanConfig?.requestId !== undefined && (
            <span>
              请求编号：<strong className="font-mono text-gray-700">{catalogScanConfig.requestId}</strong>
            </span>
          )}
        </div>
      </div>

      {catalogScanAudit && (
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm" data-testid="task-catalog-audit">
          <p className="text-sm font-medium text-gray-900">目录扫描审计</p>
          <p className="mt-1 text-xs text-gray-500">
            上游返回 total 与实际抓取条数按任务当前已落库的页汇总；停止原因/最后一页反映的是最近一次停止时的状态。
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {auditEntries.map((entry) => (
              <div key={entry.label} className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
                <p className="text-xs text-gray-400">{entry.label}</p>
                <p className="mt-1 break-all text-sm font-semibold text-gray-800">
                  {formatAuditValue(entry.value)}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
