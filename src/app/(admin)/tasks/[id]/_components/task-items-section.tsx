import Link from "next/link";

import { taskStatusLabel } from "@/features/admin-ui/content-view";
import { formatDateTime } from "@/features/admin-ui/datetime";

import { ContentPagination } from "../../../novels/_components/content-pagination";
import { ITEM_STATUS_TABS } from "../../_lib/task-copy";

export type TaskDetailItemRow = {
  readonly itemId: string;
  readonly status: string;
  readonly attemptCount: number;
  readonly leaseEpoch: string;
  readonly lockedUntil: string | null;
  readonly errorSummary: "redacted" | null;
  readonly stopReason?: string;
  readonly pageNumber?: number;
};

function errorSummaryCell(value: "redacted" | null, stopReason: string | undefined) {
  if (stopReason !== undefined) {
    return (
      <span className="font-mono text-amber-700" title="从任务的停止原因派生，稳定枚举码，非原始错误文本">
        {stopReason}
      </span>
    );
  }
  if (value === null) return <span className="text-gray-400">—</span>;
  return (
    <span className="text-amber-700" title="失败详情已从此列表中脱敏，仅审计日志留有完整记录">
      已脱敏，详情见审计/日志
    </span>
  );
}

/** Builds `/tasks/<id>?status=<tab>&family=<hint>`, always resetting `page` to 1 — same as CPS's own `buildStatusUrl`. */
function statusTabHref(taskId: string, familyHint: string | undefined, status: string): string {
  const params = new URLSearchParams();
  if (familyHint) params.set("family", familyHint);
  if (status) params.set("status", status);
  const query = params.toString();
  return `/tasks/${taskId}${query ? `?${query}` : ""}`;
}

export function TaskItemsSection({
  taskId,
  familyHint,
  taskType,
  items,
  statusValue,
  page,
  total,
  totalPages,
}: {
  taskId: string;
  familyHint?: string;
  taskType: string;
  items: readonly TaskDetailItemRow[];
  statusValue?: string;
  page: number;
  total: number;
  totalPages: number;
}) {
  const isCatalogScan = taskType === "catalog_scan";
  const activeTab = statusValue ?? "";

  return (
    <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm" data-testid="task-items-section">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 bg-gray-50 px-4 py-3">
        <h2 className="shrink-0 text-sm font-semibold text-gray-900">
          子项明细（共 {total} {isCatalogScan ? "页" : "条"}）
        </h2>
        <div className="flex items-center gap-1 text-xs">
          {ITEM_STATUS_TABS.map((tab) => {
            const active = activeTab === tab.key;
            return (
              <Link
                key={tab.key || "all"}
                href={statusTabHref(taskId, familyHint, tab.key)}
                data-testid={`task-item-status-tab-${tab.key || "all"}`}
                className={`rounded-full border px-2.5 py-1 transition-colors ${
                  active
                    ? "border-blue-600 bg-blue-600 text-white"
                    : "border-gray-200 text-gray-500 hover:border-gray-400 hover:text-gray-700"
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </div>
      </div>

      {items.length === 0 ? (
        <div data-testid="task-items-empty-state" className="px-4 py-12 text-center text-sm text-gray-400">
          没有符合条件的子项。
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="border-b border-gray-200 bg-gray-50/50">
              <tr>
                {isCatalogScan && <th className="px-3 py-2 text-left font-medium text-gray-500">页号</th>}
                <th className="px-3 py-2 text-left font-medium text-gray-500">item_id</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">状态</th>
                <th className="px-3 py-2 text-right font-medium text-gray-500">尝试次数</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">lease_epoch</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">锁定至</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">失败原因</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map((item) => (
                <tr
                  key={item.itemId}
                  data-testid={`task-item-row-${item.itemId}`}
                  className={item.status === "failed" ? "bg-red-50/30" : undefined}
                >
                  {isCatalogScan && (
                    <td className="px-3 py-2 text-gray-700">
                      {item.pageNumber !== undefined ? `第 ${item.pageNumber} 页` : "—"}
                    </td>
                  )}
                  <td className="px-3 py-2 font-mono text-[11px] text-gray-500">{item.itemId}</td>
                  <td className="px-3 py-2">{taskStatusLabel(item.status)}</td>
                  <td className="px-3 py-2 text-right">{item.attemptCount}</td>
                  <td className="px-3 py-2 font-mono text-[11px] text-gray-500">{item.leaseEpoch}</td>
                  <td className="px-3 py-2 text-gray-500">{formatDateTime(item.lockedUntil)}</td>
                  <td className="px-3 py-2">{errorSummaryCell(item.errorSummary, item.stopReason)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="border-t border-gray-200 px-4 py-3">
        <ContentPagination
          basePath={`/tasks/${taskId}`}
          params={{ family: familyHint, status: statusValue }}
          page={page}
          totalPages={totalPages}
          total={total}
        />
      </div>
    </section>
  );
}
