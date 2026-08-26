import Link from "next/link";

import { taskStatusLabel } from "@/features/admin-ui/content-view";
import { formatDateTime } from "@/features/admin-ui/datetime";
import { AdminTimeZoneNote } from "@/features/admin-ui/time-zone-note";
import type { TaskFamily } from "@/lib/tasks";

import {
  isRetryableTaskStatus,
  itemStatusOptionsFor,
  taskFamilyLabel,
  TASK_LIST_LIMIT_OPTIONS,
} from "../_lib/task-copy";
import { RetryFailedButton } from "./retry-failed-button";

export type TaskDetailRow = {
  readonly family: TaskFamily;
  readonly taskId: string;
  readonly taskType: string;
  readonly status: string;
  readonly totalCount: number;
  readonly successCount: number;
  readonly failedCount: number;
  readonly skippedCount: number;
  readonly errorSummary: "redacted" | null;
};

export type TaskItemRow = {
  readonly itemId: string;
  readonly status: string;
  readonly attemptCount: number;
  readonly leaseEpoch: string;
  readonly lockedUntil: string | null;
  readonly errorSummary: "redacted" | null;
};

function errorSummaryCell(value: "redacted" | null) {
  return value === null ? (
    <span className="text-gray-400">—</span>
  ) : (
    <span className="text-amber-700">已脱敏，详情见审计/日志</span>
  );
}

/** Preserves the list filters, replaces only the item-scoped query params, keeps the same task selected. */
function itemsFilterAction(baseSearch: URLSearchParams): { href: string; hidden: readonly [string, string][] } {
  const hidden: [string, string][] = [];
  for (const key of ["family", "status", "limit", "taskId", "taskFamily"]) {
    const value = baseSearch.get(key);
    if (value) hidden.push([key, value]);
  }
  return { href: "/tasks", hidden };
}

export function TaskDetailPanel({
  detail,
  items,
  itemStatusValue,
  itemLimitValue,
  baseSearch,
}: {
  detail: TaskDetailRow;
  items: readonly TaskItemRow[];
  itemStatusValue?: string;
  itemLimitValue?: string;
  baseSearch: URLSearchParams;
}) {
  const closeParams = new URLSearchParams(baseSearch);
  for (const key of ["taskId", "taskFamily", "itemStatus", "itemLimit"]) closeParams.delete(key);
  const closeHref = `/tasks${closeParams.toString() ? `?${closeParams.toString()}` : ""}`;

  const itemStatusOptions = itemStatusOptionsFor(detail.family);
  const { href: filterAction, hidden } = itemsFilterAction(baseSearch);

  return (
    <section
      aria-labelledby="task-detail-heading"
      data-testid="task-detail-panel"
      className="space-y-4 rounded-xl border border-blue-200 bg-blue-50/30 p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="task-detail-heading" className="text-sm font-semibold text-gray-900">
            任务详情 · {taskFamilyLabel(detail.family)} · {detail.taskType}
          </h2>
          <p className="mt-1 font-mono text-xs text-gray-500">{detail.taskId}</p>
        </div>
        <Link href={closeHref} className="text-xs text-gray-500 hover:text-gray-700" data-testid="task-detail-close">
          收起详情
        </Link>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-gray-400">状态</dt>
          <dd data-testid="task-detail-status">{taskStatusLabel(detail.status)}</dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-gray-400">总数</dt>
          <dd>{detail.totalCount}</dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-gray-400">成功</dt>
          <dd className="text-emerald-700">{detail.successCount}</dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-gray-400">失败</dt>
          <dd className="text-red-700">{detail.failedCount}</dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-gray-400">跳过</dt>
          <dd className="text-gray-500">{detail.skippedCount}</dd>
        </div>
      </dl>

      {isRetryableTaskStatus(detail.status) && (
        <RetryFailedButton family={detail.family} taskId={detail.taskId} />
      )}

      <div className="space-y-2 border-t border-blue-100 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-gray-700">子项（item 级状态与 attempt）</h3>
          <AdminTimeZoneNote />
        </div>
        <form method="GET" action={filterAction} className="flex flex-wrap items-center gap-2" role="search">
          {hidden.map(([key, value]) => (
            <input key={key} type="hidden" name={key} value={value} />
          ))}
          <select
            name="itemStatus"
            defaultValue={itemStatusValue ?? ""}
            aria-label="子项状态"
            className="rounded-lg border border-gray-300 py-1.5 pl-3 pr-8 text-xs focus:border-blue-500 focus:outline-none"
          >
            <option value="">全部子项状态</option>
            {itemStatusOptions.map((status) => (
              <option key={status} value={status}>
                {taskStatusLabel(status)}
              </option>
            ))}
          </select>
          <select
            name="itemLimit"
            defaultValue={itemLimitValue ?? ""}
            aria-label="子项显示条数上限"
            className="rounded-lg border border-gray-300 py-1.5 pl-3 pr-8 text-xs focus:border-blue-500 focus:outline-none"
          >
            {TASK_LIST_LIMIT_OPTIONS.map((limit) => (
              <option key={limit} value={limit}>
                最近 {limit} 条
              </option>
            ))}
          </select>
          <button type="submit" className="rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-200">
            筛选子项
          </button>
        </form>

        {detail.family === "catalog_scan" && itemStatusValue === "skipped" ? (
          <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            目录扫描（catalog_scan）子项没有 skipped 状态，接口会拒绝这个组合——已自动忽略该筛选。
          </p>
        ) : null}

        {items.length === 0 ? (
          <div data-testid="task-items-empty-state" className="rounded-lg border border-gray-200 bg-white px-4 py-8 text-center text-sm text-gray-400">
            没有符合条件的子项。
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
            <table className="w-full text-xs">
              <thead className="border-b border-gray-200 bg-gray-50">
                <tr>
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
                  <tr key={item.itemId} data-testid={`task-item-row-${item.itemId}`}>
                    <td className="px-3 py-2 font-mono text-[11px] text-gray-500">{item.itemId}</td>
                    <td className="px-3 py-2">{taskStatusLabel(item.status)}</td>
                    <td className="px-3 py-2 text-right">{item.attemptCount}</td>
                    <td className="px-3 py-2 font-mono text-[11px] text-gray-500">{item.leaseEpoch}</td>
                    <td className="px-3 py-2 text-gray-500">{formatDateTime(item.lockedUntil)}</td>
                    <td className="px-3 py-2">{errorSummaryCell(item.errorSummary)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
