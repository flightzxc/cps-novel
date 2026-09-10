import type { TaskFamily } from "@/lib/tasks";
import {
  TASK_ITEM_STATUSES as DATABASE_TASK_ITEM_STATUSES,
  TASK_STATUSES as DATABASE_TASK_STATUSES,
} from "@/domain/database-statuses";

/**
 * Mirrors the private enums in `src/server/task-admin/service.ts`
 * (`TASK_FAMILIES` and `RETRYABLE_PARENT_STATUSES` stay local copies here;
 * `TASK_STATUSES`/`ITEM_STATUSES` are no longer duplicated — both this file
 * and the service import them from `@/domain/database-statuses`, the single
 * source of truth as of Phase C step C-5). `TASK_FAMILIES`/
 * `RETRYABLE_PARENT_STATUSES` are not exported by the service — the module
 * only exports the DTOs and the service functions — so this file keeps its
 * own copy of those two rather than reaching into `src/server/**` internals.
 * If the server's private `TASK_FAMILIES` ever changes, the mismatch
 * surfaces as a `task_admin_invalid_request` from a filter this page still
 * offers; that is a visible, recoverable failure, not a silent drift.
 *
 * Phase C (`施工工单_PhaseC_任务模型迁移与ImportProgress_2026-09-06.md`):
 * `catalog_scan` is no longer a family — it is a `GenericTask.taskType`
 * value under `"generic"`, exactly like every other GenericTask taskType.
 * There is no per-taskType filter on this page (family is the only axis),
 * so a "目录扫描" quick-filter is a natural, accepted casualty of the
 * migration — CPS's own `/tasks` has the same granularity.
 */
export const TASK_FAMILIES: readonly TaskFamily[] = ["channel_sync", "generic"];

export const TASK_FAMILY_LABELS: Readonly<Record<TaskFamily, string>> = Object.freeze({
  channel_sync: "渠道同步",
  generic: "通用任务",
});

export function taskFamilyLabel(family: string): string {
  return TASK_FAMILY_LABELS[family as TaskFamily] ?? family;
}

// Phase C step C-5: sourced from @/domain/database-statuses (the single
// source of truth) instead of a third local literal copy.
export const TASK_STATUSES = DATABASE_TASK_STATUSES;

export type TaskStatusFilter = (typeof TASK_STATUSES)[number];

export const TASK_ITEM_STATUSES = DATABASE_TASK_ITEM_STATUSES;

export type TaskItemStatusFilter = (typeof TASK_ITEM_STATUSES)[number];

/**
 * Phase C: the pre-migration `catalog_scan` family never had a `skipped`
 * item status, which used to make `family=catalog_scan&status=skipped` a
 * guaranteed `task_admin_invalid_request`. `catalog_scan` is now a
 * `GenericTask.taskType` value, and the item-status filter operates at the
 * family granularity only — both remaining families (`channel_sync`,
 * `generic`) genuinely support `skipped` — so there is no longer a
 * family-level exclusion to express here. Kept as a thin passthrough
 * (rather than inlining `TASK_ITEM_STATUSES` at the one call site) so a
 * future family-specific carve-out has one place to land.
 */
export function itemStatusOptionsFor(_family: TaskFamily): readonly TaskItemStatusFilter[] {
  return TASK_ITEM_STATUSES;
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
 * C-9 (task-detail route): gates the ImportProgress polling widget on
 * `/tasks/[id]` — non-terminal (`pending`/`processing`) polls every 2s,
 * terminal renders the final counts once and stops. `TASK_STATUSES` is
 * `["pending", "processing", "completed", "completed_with_errors",
 * "failed", "disabled"]` (`@/domain/database-statuses`); everything but the
 * first two is terminal.
 */
const NON_TERMINAL_TASK_STATUSES = new Set<string>(["pending", "processing"]);

export function isTerminalTaskStatus(status: string): boolean {
  return !NON_TERMINAL_TASK_STATUSES.has(status);
}

/**
 * C-9: item-status tabs for the `/tasks/[id]` items table, CPS-parity
 * labels/order (`STATUS_TABS` in the CPS reference `tasks/[id]/page.tsx`).
 * `key: ""` means "no `status` filter" (all statuses), matching how the URL
 * omits `status` entirely for the "全部" tab.
 */
export const ITEM_STATUS_TABS: readonly Readonly<{ key: string; label: string }>[] = Object.freeze([
  Object.freeze({ key: "", label: "全部" }),
  Object.freeze({ key: "success", label: "成功" }),
  Object.freeze({ key: "failed", label: "失败" }),
  Object.freeze({ key: "skipped", label: "跳过" }),
  Object.freeze({ key: "processing", label: "处理中" }),
  Object.freeze({ key: "pending", label: "待处理" }),
]);

/**
 * C-9: moved from the old same-page panel's `page.tsx:70-77` and corrected
 * in the move — the pre-Phase-C guard compared the task *family* to
 * `"catalog_scan"`, which was meaningful when catalog_scan was its own
 * physical family but has been unreachable ever since Phase C folded it
 * into `GenericTask` (`family` only ever has `"channel_sync"`/`"generic"`
 * values — see `TASK_FAMILIES` above). The real fact this guard exists to
 * protect against — a catalog-scan item is never `skipped`, per the
 * worker's own `guardedFinalize` invariant (`src/lib/tasks/store.ts`) — is
 * keyed on the task's *taskType*, not its family, so this checks that
 * instead. `listAdminTaskItems` itself no longer rejects this combination
 * either way (Phase C's `generic` family genuinely supports `skipped` for
 * every other taskType) — this is UX-only, dropping a filter that would
 * silently return zero rows rather than showing a confusing empty state.
 */
export function shouldDropSkippedFilterForTaskType(taskType: string, itemStatus: string | undefined): boolean {
  return taskType === "catalog_scan" && itemStatus === "skipped";
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
