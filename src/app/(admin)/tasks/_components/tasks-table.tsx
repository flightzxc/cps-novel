import Link from "next/link";

import { taskStatusLabel } from "@/features/admin-ui/content-view";

import { taskFamilyLabel } from "../_lib/task-copy";

export type TaskSummaryRow = {
  readonly family: string;
  readonly taskId: string;
  readonly taskType: string;
  readonly status: string;
  readonly totalCount: number;
  readonly successCount: number;
  readonly failedCount: number;
  readonly skippedCount: number;
  readonly errorSummary: "redacted" | null;
  /**
   * C-10 (Phase E rework, 2026-09-07): a stable, allowlisted stop-reason
   * code (e.g. `"upstream_error"`), never free text — see
   * `TaskSummaryDto.stopReason`'s doc comment in
   * `src/server/task-admin/service.ts`. Absent whenever the task has none,
   * not just on success: the "X9 read DTO allowlists" contract test
   * requires the field to be omitted entirely rather than `null` so every
   * pre-existing fixture there keeps matching unmodified.
   */
  readonly stopReason?: string;
};

/**
 * `errorSummary` is never a free-text field — it is `"redacted"` or `null`,
 * always (`TaskSummaryDto` in `src/server/task-admin/service.ts`). This is
 * not a placeholder waiting for a real message to arrive later: the service
 * never selects `error` beyond an `IS NOT NULL` check, by design (X9's
 * read-side kept the payload out of the browser entirely). The column says so
 * in the operator's own words instead of leaving `"redacted"` to read like a
 * broken string.
 *
 * C-10: when the service *did* manage to derive a stable stop-reason code
 * for this task (`stopReason`, an allowlisted enum value — never free
 * text), show that instead of the generic "已脱敏" line — it is strictly
 * more useful and still not raw error content.
 */
function errorSummaryCell(value: "redacted" | null, stopReason: string | undefined) {
  if (stopReason !== undefined) {
    return (
      <span className="font-mono text-amber-700" title="从任务的停止原因派生，稳定枚举码，非原始错误文本">
        {stopReason}
      </span>
    );
  }
  if (value === null) {
    return <span className="text-gray-400">—</span>;
  }
  return (
    <span className="text-amber-700" title="失败详情已从此列表中脱敏，仅审计日志留有完整记录">
      已脱敏，详情见审计/日志
    </span>
  );
}

/** Builds `/tasks?<preserved list filters>&taskId=…&taskFamily=…`, dropping any stale detail params first. */
function detailHref(baseSearch: URLSearchParams, family: string, taskId: string): string {
  const params = new URLSearchParams(baseSearch);
  params.delete("taskId");
  params.delete("taskFamily");
  params.delete("itemStatus");
  params.delete("itemLimit");
  params.set("taskId", taskId);
  params.set("taskFamily", family);
  return `/tasks?${params.toString()}`;
}

export function TasksTable({
  tasks,
  baseSearch,
  selectedTaskId,
}: {
  tasks: readonly TaskSummaryRow[];
  baseSearch: URLSearchParams;
  selectedTaskId?: string;
}) {
  if (tasks.length === 0) {
    return (
      <div
        data-testid="tasks-empty-state"
        className="rounded-xl border border-gray-200 bg-white px-6 py-16 text-center shadow-sm"
      >
        <p className="text-gray-400">没有符合当前筛选条件的任务。清空筛选或换一个 family / 状态再试。</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <table className="w-full text-sm">
        <thead className="border-b border-gray-200 bg-gray-50">
          <tr>
            <th className="px-4 py-3 text-left font-medium text-gray-500">类型</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">task_type</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">状态</th>
            <th className="px-4 py-3 text-right font-medium text-gray-500">总数</th>
            <th className="px-4 py-3 text-right font-medium text-gray-500">成功</th>
            <th className="px-4 py-3 text-right font-medium text-gray-500">失败</th>
            <th className="px-4 py-3 text-right font-medium text-gray-500">跳过</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">失败原因</th>
            <th className="px-4 py-3 text-right font-medium text-gray-500">
              <span className="sr-only">详情</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {tasks.map((task) => (
            <tr
              key={`${task.family}:${task.taskId}`}
              className={`hover:bg-gray-50 ${task.taskId === selectedTaskId ? "bg-blue-50/60" : ""}`}
            >
              <td className="px-4 py-3 text-gray-700">{taskFamilyLabel(task.family)}</td>
              <td className="px-4 py-3">
                <span className="font-mono text-xs text-gray-600">{task.taskType}</span>
                <span className="ml-2 font-mono text-[11px] text-gray-400">{task.taskId}</span>
              </td>
              <td className="px-4 py-3" data-testid={`task-status-${task.taskId}`}>
                {taskStatusLabel(task.status)}
              </td>
              <td className="px-4 py-3 text-right text-gray-600">{task.totalCount}</td>
              <td className="px-4 py-3 text-right text-emerald-700">{task.successCount}</td>
              <td className="px-4 py-3 text-right text-red-700">{task.failedCount}</td>
              <td className="px-4 py-3 text-right text-gray-500">{task.skippedCount}</td>
              <td className="px-4 py-3">{errorSummaryCell(task.errorSummary, task.stopReason)}</td>
              <td className="px-4 py-3 text-right">
                <Link
                  href={detailHref(baseSearch, task.family, task.taskId)}
                  className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                  data-testid={`view-task-detail-${task.taskId}`}
                >
                  查看详情
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
