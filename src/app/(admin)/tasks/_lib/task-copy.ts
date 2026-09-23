import type { TaskFamily } from "@/lib/tasks";
import {
  articleGenerateBlockedReasonLabel,
  type ArticleGenerateBlockedReason,
} from "@/domain/article-generation";
import type { SafeTaskFailureDto } from "@/server/task-admin/safe-task-error";
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

const CATALOG_BATCH_PHASE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  queued: "等待入队",
  disabled: "已禁用",
  // X10 task control: additive next to "disabled" above — see
  // `deriveCatalogBatchPhase`'s own doc comment (`@/domain/catalog-batch`).
  paused: "已暂停",
  cancelled: "已中止",
  materializing: "正在统计",
  executing: "正在执行",
  completed: "已完成",
  completed_with_errors: "完成（有异常）",
  failed: "失败",
  expired: "已过期",
});

const CATALOG_BATCH_BLOCKED_REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  channel_account_required: "缺少可用渠道账户",
  channel_binding_or_capability_unavailable: "渠道绑定或领取能力不可用",
  active_item_conflict: "条目已有进行中的任务",
  active_scope_conflict: "当前范围已有进行中的任务",
  missing_locale: "来源语言缺失",
  unsupported_locale: "来源语言暂不受产品支持",
  // 阶段2 第4步（施工任务 3.4）：书已挂在另一个批次仍在排队（尚未放行/已
  // 暂停）的生命周期分片下——见 `worker/handlers/catalog-batch.ts` 的
  // `queuedElsewhere` 查询。
  queued_in_other_batch: "已在其它排队中的批次里",
});

export function catalogBatchPhaseLabel(phase: string): string {
  return CATALOG_BATCH_PHASE_LABELS[phase] ?? "处理中";
}

/** Only allowlisted backend reason keys become operator-facing copy. */
export function catalogBatchBlockedReasons(counts: Readonly<Record<string, number>> | undefined): readonly string[] {
  if (!counts) return [];
  return Object.entries(counts)
    .filter(([reason, count]) => CATALOG_BATCH_BLOCKED_REASON_LABELS[reason] !== undefined && Number.isFinite(count) && count > 0)
    .map(([reason, count]) => `${CATALOG_BATCH_BLOCKED_REASON_LABELS[reason]}：${count} 条`);
}

export function articleAdmissionBlockedReasons(
  counts: Readonly<Partial<Record<ArticleGenerateBlockedReason, number>>> | undefined,
): readonly string[] {
  if (!counts) return [];
  return Object.entries(counts)
    .filter((entry): entry is [ArticleGenerateBlockedReason, number] =>
      typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] > 0)
    .map(([reason, count]) => `${articleGenerateBlockedReasonLabel(reason)}：${count} 条`);
}

export function safeTaskFailureDisplay(failure: SafeTaskFailureDto): string {
  const context = failure.context;
  const parts = context ? [
    context.httpStatus !== undefined ? `HTTP ${context.httpStatus}` : undefined,
    context.pageNumber !== undefined ? `第 ${context.pageNumber} 页` : undefined,
    context.sqlState ? `SQLSTATE ${context.sqlState}` : undefined,
    context.prismaCode ? `Prisma ${context.prismaCode}` : undefined,
    context.constraint ? `约束 ${context.constraint}` : undefined,
  ].filter((value): value is string => value !== undefined) : [];
  return `${failure.label}（${failure.code}）${parts.length > 0 ? ` · ${parts.join(" · ")}` : ""}`;
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

/**
 * X10 task control (pause/resume/abort). A local copy of the shape, not an
 * import of `TaskControlMarker` (`src/lib/tasks/task-control.ts`) — this
 * file already keeps its own local copies of a few server-side enums
 * (`TASK_FAMILIES`/`RETRYABLE_PARENT_STATUSES` above) rather than reaching
 * into server internals, and this is the same discipline.
 *
 * Only ever meaningful when the task's own `status` is `"paused"`,
 * `"cancelled"`, or `"disabled"` *and* this field is present —
 * `src/server/task-admin/service.ts`'s `taskSummary` only ever populates it
 * in that case, leaving a `disabled` row from any of this codebase's three
 * pre-existing, unrelated reasons (a legacy out-of-band flip, a
 * feature-flag-off task, or a catalog-batch double-gate refusal) with this
 * field absent. `kind` is audit/display metadata only (who/why) — it is
 * never what decides whether a row is paused/cancelled; that is the `status`
 * column itself, read directly by `TaskControlButtons`.
 *
 * `"awaiting_release"` (promo-claim lifecycle, `docs/adr/ADR-PROMO-CLAIM-
 * BATCH-LIFECYCLE.md`) is a fifth additive meaning of a `disabled` row: a
 * lifecycle shard (`promo_link.claim.v1` child task) enumerated but not yet
 * released by the scheduler. It never changes eligibility here either — a
 * `disabled` row (this kind or `system_hold`) is already refused by every
 * resume/retry mutation, which key on `status` alone (see `task-control.ts`'s
 * own module doc for the exact statuses each accepts).
 */
export type TaskControlKind = "paused" | "aborted" | "system_hold" | "awaiting_release";
export type TaskControlSummary = Readonly<{
  kind: TaskControlKind;
  source: "manual" | "system";
  at: string;
  actorId?: string | null;
  reason?: string | null;
  reasonCode?: string;
  terminatedPendingItemCount?: number;
}>;

const TASK_CONTROL_KIND_LABELS: Readonly<Record<TaskControlKind, string>> = Object.freeze({
  paused: "人工暂停",
  aborted: "人工中止",
  system_hold: "系统保护停止",
  awaiting_release: "等待放行",
});

/** Unknown kinds pass through verbatim, same discipline as `taskStatusLabel`. */
export function taskControlKindLabel(kind: string): string {
  return TASK_CONTROL_KIND_LABELS[kind as TaskControlKind] ?? kind;
}

/**
 * Chinese copy for the promo-claim lifecycle's five `system_hold`
 * `reasonCode` values (`src/lib/tasks/promo-claim-lifecycle.ts`'s
 * `PROMO_CLAIM_SYSTEM_HOLD_REASON_CODES`). Every other `reasonCode` this
 * codebase already writes (e.g. `credential_validation_failed` from
 * `worker/handlers/promo-link-claim-system-hold.ts`) is deliberately left
 * out — `taskControlSummaryLine` falls back to the raw code for anything not
 * in this map, unchanged from before this addition.
 */
const SYSTEM_HOLD_REASON_CODE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  approval_expired: "批准已过期",
  credential_not_ready: "凭据未就绪",
  deadline_missed: "错过截止时间",
  deadline_missed_twice: "连续两次错过截止时间",
  lifecycle_disabled: "生命周期开关已关闭",
});

/** Unknown reason codes pass through verbatim, same discipline as `taskControlKindLabel`. */
export function systemHoldReasonCodeLabel(reasonCode: string): string {
  return SYSTEM_HOLD_REASON_CODE_LABELS[reasonCode] ?? reasonCode;
}

/**
 * 阶段2 第4步（施工任务 3.5，设计 §5.8 暂停与恢复一览表）：每个系统暂停
 * 原因对应的中文恢复方式说明——严格按该表格逐条实现，不是重新编一份措辞：
 *
 *   - approval_expired → 只能运营"重新批准"（页面另有按钮，这里的文案不
 *     重复"点击下方按钮"这类与具体 UI 绑死的措辞，只说明"需要做什么"）；
 *   - credential_not_ready → 凭据校验通过且剩余有效期足够后自动恢复；
 *   - deadline_missed → 满足条件（条目从未尝试过）后 scheduler 自动重新
 *     放行；
 *   - deadline_missed_twice → 需要人工处理；`reason` 恰好是
 *     `unsafe_to_auto_retry` 时（`src/lib/tasks/promo-claim-release.ts`
 *     的 `holdShardSystemHold` 调用点唯一会写的这个自由文本原因）额外说明
 *     "存在已尝试或已调用过领取接口的条目，禁止自动重试"——这是设计原文
 *     明确要求的分支措辞，不能用同一句话覆盖两种截然不同的成因（单纯超时
 *     两次 vs. 有副作用风险）；
 *   - lifecycle_disabled → 重新开启开关后自动恢复。
 *
 * 未知原因码返回 `undefined`（不是空字符串）——调用方据此决定要不要渲染
 * 这一行，同 `TaskControlSummary.reasonCode` 本身"可能是这五个已知值之外
 * 的自由字符串"这条既有约定保持一致。
 */
export function systemHoldRecoveryHint(reasonCode: string, reason?: string | null): string | undefined {
  switch (reasonCode) {
    case "approval_expired":
      return "批次批准已过期，且从未放行过任何分片——只能由运营重新批准后才会继续放行。";
    case "credential_not_ready":
      return "渠道账号凭据未就绪（未校验、状态不可用，或剩余有效期不足一个放行窗口）——凭据校验通过且剩余有效期足够后，系统会自动恢复放行。";
    case "deadline_missed":
      return "分片错过了执行截止时间——待处理条目全部满足自动重放条件（从未尝试过、没有任何调用副作用）后，系统会在下一轮自动重新放行。";
    case "deadline_missed_twice":
      return reason === "unsafe_to_auto_retry"
        ? "存在已尝试或已调用过领取接口的条目，禁止自动重试——需要人工处理。"
        : "该分片连续两次错过执行截止时间——需要人工处理（吞吐或上游可能出了问题）。";
    case "lifecycle_disabled":
      return "领推广链接生命周期开关当前已关闭——重新开启开关后，系统会自动恢复放行。";
    default:
      return undefined;
  }
}

/** Compact one-line summary for the tasks-list table's status cell. */
export function taskControlSummaryLine(control: TaskControlSummary): string {
  const label = taskControlKindLabel(control.kind);
  return control.kind === "system_hold" && control.reasonCode
    ? `${label}（${systemHoldReasonCodeLabel(control.reasonCode)}）`
    : label;
}
