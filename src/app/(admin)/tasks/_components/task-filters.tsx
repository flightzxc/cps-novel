import {
  TASK_FAMILIES,
  TASK_FAMILY_LABELS,
  TASK_LIST_LIMIT_OPTIONS,
  TASK_STATUSES,
} from "../_lib/task-copy";
import { taskStatusLabel } from "@/features/admin-ui/content-view";

export type TaskFilterValues = {
  readonly family?: string;
  readonly status?: string;
  readonly limit?: string;
};

/**
 * Same `method="GET"` + field-name-is-query-param convention as
 * `TagFilters` / `NovelFilters` — see those files for the rationale. `limit`
 * is a field here (not a hidden default) precisely because there is no
 * pagination behind it: raising it is the only way an operator can ask this
 * screen for more rows.
 */
export function TaskFilters({ values }: { values: TaskFilterValues }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <form method="GET" className="flex flex-wrap items-center gap-3" role="search">
        <select
          name="family"
          defaultValue={values.family ?? ""}
          aria-label="任务类型"
          className="rounded-lg border border-gray-300 py-2 pl-3 pr-8 text-sm focus:border-blue-500 focus:outline-none"
        >
          <option value="">全部类型</option>
          {TASK_FAMILIES.map((family) => (
            <option key={family} value={family}>
              {TASK_FAMILY_LABELS[family]}
            </option>
          ))}
        </select>
        <select
          name="status"
          defaultValue={values.status ?? ""}
          aria-label="任务状态"
          className="rounded-lg border border-gray-300 py-2 pl-3 pr-8 text-sm focus:border-blue-500 focus:outline-none"
        >
          <option value="">全部状态</option>
          {TASK_STATUSES.map((status) => (
            <option key={status} value={status}>
              {taskStatusLabel(status)}
            </option>
          ))}
        </select>
        <select
          name="limit"
          defaultValue={values.limit ?? ""}
          aria-label="显示条数上限"
          className="rounded-lg border border-gray-300 py-2 pl-3 pr-8 text-sm focus:border-blue-500 focus:outline-none"
        >
          {TASK_LIST_LIMIT_OPTIONS.map((limit) => (
            <option key={limit} value={limit}>
              最近 {limit} 条
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
        >
          筛选
        </button>
      </form>
    </div>
  );
}
