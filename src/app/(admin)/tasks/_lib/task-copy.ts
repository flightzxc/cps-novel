import type { TaskFamily } from "@/lib/tasks";

/**
 * Mirrors the private enums in `src/server/task-admin/service.ts`
 * (`TASK_FAMILIES`, `TASK_STATUSES`, `ITEM_STATUSES`,
 * `RETRYABLE_PARENT_STATUSES`). None of those four are exported — the module
 * only exports the DTOs and the service functions — so this file keeps its
 * own copy rather than reaching into `src/server/**` internals. If the
 * server's private lists ever change, the mismatch surfaces as a
 * `task_admin_invalid_request` from a filter this page still offers; that is
 * a visible, recoverable failure, not a silent drift.
 */
export const TASK_FAMILIES: readonly TaskFamily[] = ["catalog_scan", "channel_sync", "generic"];

export const TASK_FAMILY_LABELS: Readonly<Record<TaskFamily, string>> = Object.freeze({
  catalog_scan: "目录扫描",
  channel_sync: "渠道同步",
  generic: "通用任务",
});

export function taskFamilyLabel(family: string): string {
  return TASK_FAMILY_LABELS[family as TaskFamily] ?? family;
}

export const TASK_STATUSES = [
  "pending",
  "processing",
  "completed",
  "completed_with_errors",
  "failed",
  "disabled",
] as const;

export type TaskStatusFilter = (typeof TASK_STATUSES)[number];

export const TASK_ITEM_STATUSES = ["pending", "processing", "success", "skipped", "failed"] as const;

export type TaskItemStatusFilter = (typeof TASK_ITEM_STATUSES)[number];

/**
 * `getAdminTaskItems` throws `task_admin_invalid_request` for
 * `family=catalog_scan&status=skipped` — `CatalogScanTaskItem` has no
 * `skipped` status in its own lifecycle (only `channel_sync`/`generic`
 * items do). Offering that combination in the filter would just be a
 * guaranteed 400 the operator did not cause.
 */
export function itemStatusOptionsFor(family: TaskFamily): readonly TaskItemStatusFilter[] {
  return family === "catalog_scan"
    ? TASK_ITEM_STATUSES.filter((status) => status !== "skipped")
    : TASK_ITEM_STATUSES;
}

/**
 * `retryFailedTask` accepts only these two parent statuses
 * (`RETRYABLE_PARENT_STATUSES` in the service) — everything else is a
 * guaranteed `task_admin_state_conflict`. The retry control is only ever
 * rendered for a task whose status is one of these two.
 */
const RETRYABLE_STATUSES = new Set<string>(["failed", "completed_with_errors"]);

export function isRetryableTaskStatus(status: string): boolean {
  return RETRYABLE_STATUSES.has(status);
}

/**
 * The list route's hard cap (`limit()` in the service: default 50, min 1,
 * max 100). There is no cursor, no `hasMore`, no total count independent of
 * `items.length` — a result at exactly `limit` items does not distinguish
 * "there were exactly this many" from "there were more, cut off here". The
 * UI must say so rather than imply a page 2 that does not exist.
 */
export const TASK_LIST_LIMIT_OPTIONS = [20, 50, 100] as const;
export const TASK_LIST_DEFAULT_LIMIT = 50;
export const TASK_LIST_MAX_LIMIT = 100;

export const LIST_LIMIT_NOTE =
  "本列表没有翻页——接口只支持一次性返回最近的若干条（最多 100 条），不存在第 2 页。" +
  "如果没有看到目标任务，请用左侧的 family / 状态筛选缩小范围，而不是加大条数等待。";
