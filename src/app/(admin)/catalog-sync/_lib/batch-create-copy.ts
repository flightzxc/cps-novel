import type {
  ContentCreationBatchApplyActionResult,
  ContentCreationBatchDryRunActionResult,
} from "../_actions";
import { describeCreateContentOutcome, type CreateContentResult, type OutcomeTone } from "./outcome-copy";

export type { OutcomeTone } from "./outcome-copy";

/**
 * Human copy for the RC-4 "批量创建内容" preview + apply dialog on
 * `/catalog-sync`.
 *
 * Derived structurally from the actions' own return types, the same
 * `outcome-copy.ts` / `promo-claim-copy.ts` pattern: nothing in this
 * client-facing file names `@/server/content-creation/batch` (Codex
 * territory) in a value position. Per-item copy for the "why did this one
 * not get created" question is *not* re-specified here — every item that
 * carries a `result` (a real {@link CreateContentResult}) is described by
 * `describeCreateContentOutcome`, the exact same function
 * `create-content-dialog.tsx` already uses for the single-item flow, so the
 * twelve outcome messages never exist in two places. This file only adds
 * the four-state envelope those per-item outcomes sit inside
 * (created/creatable, skipped, failed, not_processed) plus the two failure
 * shapes that never reach `CreateContentResult` at all: a malformed-input
 * throw (`inputErrorCode`) and an unclassified exception (`unexpectedError`)
 * — see `@/server/content-creation/batch`'s `CoreItemOutcome` doc comment.
 */

export type ContentCreationBatchDryRunData = Extract<
  ContentCreationBatchDryRunActionResult,
  { ok: true }
>["data"];
export type ContentCreationBatchApplyData = Extract<
  ContentCreationBatchApplyActionResult,
  { ok: true }
>["data"];

export type ContentCreationBatchDryRunItem = ContentCreationBatchDryRunData["items"][number];
export type ContentCreationBatchApplyItem = ContentCreationBatchApplyData["items"][number];

export type ContentCreationBatchItemStatus =
  | ContentCreationBatchDryRunItem["status"]
  | ContentCreationBatchApplyItem["status"];

const STATUS_LABEL: Readonly<Record<ContentCreationBatchItemStatus, string>> = Object.freeze({
  creatable: "可创建",
  created: "已创建",
  skipped_already_linked: "已关联，跳过",
  failed: "不可创建 / 失败",
  not_processed: "未处理（预算已用尽）",
});

const STATUS_TONE: Readonly<Record<ContentCreationBatchItemStatus, OutcomeTone>> = Object.freeze({
  creatable: "info",
  created: "success",
  skipped_already_linked: "info",
  failed: "danger",
  not_processed: "warning",
});

export function batchItemStatusLabel(status: ContentCreationBatchItemStatus): string {
  return STATUS_LABEL[status];
}

export function batchItemStatusTone(status: ContentCreationBatchItemStatus): OutcomeTone {
  return STATUS_TONE[status];
}

/**
 * `ContentCreationInputErrorCode` values `createContentFromSourceItem`
 * throws on malformed input — a defensive branch (see
 * `@/server/content-creation/batch`'s `CoreItemOutcome.inputErrorCode` doc
 * comment): every id here comes from an already-loaded `SourceItemRow`, so
 * a real UUID, and `locale`/`actor`/`requestId` are filled in server-side,
 * never by this dialog. Seeing one of these in practice would mean an
 * internal bug, not a bad selection — same posture
 * `promo-link-claim-dialog.tsx`'s own `INVALID_INPUT_COPY` fallback comment
 * takes for the codes it never expects to see either.
 */
const INPUT_ERROR_CODE_COPY: Readonly<Record<string, string>> = Object.freeze({
  invalid_novel_source_item_id: "来源条目标识无效（内部错误），请刷新页面后重试",
  invalid_locale: "语种参数无效（内部错误），请联系工程排查",
  invalid_actor: "无法确认当前操作者身份，请重新登录后重试",
  invalid_request_id: "请求标识无效（内部错误），请刷新页面后重试",
});

export type BatchItemCopy = { readonly tone: OutcomeTone; readonly title: string; readonly body: string };

/**
 * One entry point covering every shape a batch item can arrive in:
 * (1) a real `CreateContentResult` — delegated to `describeCreateContentOutcome`
 *     verbatim, so all twelve outcome messages stay single-sourced;
 * (2) a malformed-input throw — `inputErrorCode` present, `result` absent;
 * (3) an unclassified exception — `unexpectedError` present, both absent;
 * (4) budget-exhausted — none of the three present (`status === "not_processed"`).
 */
export function describeBatchItem(item: {
  readonly status: ContentCreationBatchItemStatus;
  readonly result?: CreateContentResult;
  readonly inputErrorCode?: string;
  readonly unexpectedError?: boolean;
}): BatchItemCopy {
  if (item.result) return describeCreateContentOutcome(item.result);
  if (item.inputErrorCode) {
    return {
      tone: "danger",
      title: "输入无效",
      body: INPUT_ERROR_CODE_COPY[item.inputErrorCode] ?? `输入无效（${item.inputErrorCode}），请刷新页面后重试`,
    };
  }
  if (item.unexpectedError) {
    return {
      tone: "danger",
      title: "发生未分类的内部错误",
      body: "处理该来源条目时发生了服务未预期的错误；已记录服务端日志（不含原始错误文本），请联系工程排查后重试。",
    };
  }
  return {
    tone: "warning",
    title: "未处理",
    body: "本次提交的时间预算已用尽，该来源条目尚未开始处理，也未发生任何写入。可在下一次提交中重新勾选它。",
  };
}

/** Action-level `invalid_input` codes (`items_required`/`batch_size_exceeded`) — distinct from the per-item `inputErrorCode` above, which comes from inside a successfully-accepted batch. */
const ACTION_INVALID_INPUT_COPY: Readonly<Record<string, string>> = Object.freeze({
  items_required: "请至少勾选一条来源条目",
  batch_size_exceeded: "所选来源条目数超过单次上限，请取消部分勾选后再提交",
});

export function batchActionInvalidInputMessage(code: string): string {
  return ACTION_INVALID_INPUT_COPY[code] ?? `输入无效（${code}），请刷新页面后重试`;
}

/**
 * `ContentCreationBatchDryRunData["counts"]` and `ContentCreationBatchApplyData["counts"]`
 * each carry only *their own* four keys ("creatable" xor "created", never
 * both) — a `Partial` over the five-member union of both status sets is
 * what lets one formatter accept either without falsely requiring the
 * other's key. The caller only supplies which label to use for the
 * "primary" (creatable/created) bucket.
 */
export function batchSummaryLine(
  counts: Partial<Readonly<Record<ContentCreationBatchItemStatus, number>>>,
  primaryLabel: string,
): string {
  const primaryCount = counts.created ?? counts.creatable ?? 0;
  const skipped = counts.skipped_already_linked ?? 0;
  const failed = counts.failed ?? 0;
  const notProcessed = counts.not_processed ?? 0;
  return `${primaryLabel} ${primaryCount} 条，已关联跳过 ${skipped} 条，不可创建/失败 ${failed} 条，未处理 ${notProcessed} 条。`;
}

export function batchNotProcessedHint(notProcessedCount: number): string | null {
  if (notProcessedCount <= 0) return null;
  return (
    `本次提交的时间预算已用尽，还有 ${notProcessedCount} 条来源条目尚未处理，未发生任何写入。` +
    "请重新勾选这些条目并再次提交即可继续。"
  );
}
