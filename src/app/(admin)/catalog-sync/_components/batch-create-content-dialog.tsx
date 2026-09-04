"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { buttonClassName } from "@/components/ui/button";
import { EmptyRow, TBody, TD, TH, THead, Table } from "@/components/ui/table";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";

import { applyContentCreationBatchAction, dryRunContentCreationBatchAction } from "../_actions";
import {
  batchActionInvalidInputMessage,
  batchItemStatusLabel,
  batchItemStatusTone,
  batchNotProcessedHint,
  batchSummaryLine,
  describeBatchItem,
  type ContentCreationBatchApplyData,
  type ContentCreationBatchApplyItem,
  type ContentCreationBatchDryRunData,
  type ContentCreationBatchDryRunItem,
  type OutcomeTone,
} from "../_lib/batch-create-copy";
import type { SourceItemRow } from "../_lib/read-source-items";

/**
 * RC-4 "批量创建内容" — dry-run preview → confirm apply, explicit selection
 * only (the same `selectedIds` state `CatalogSyncClient`'s toolbar already
 * maintains for "领取推广链接"; there is no second selection mechanism and
 * no "创建全部匹配当前筛选" shortcut here either).
 *
 * Two-step like `CreateContentDialog` (auto dry-run on mount, write only on
 * an explicit "确认创建" click) rather than `PromoLinkClaimDialog`'s
 * manual mode picker — batch content creation shares the single-item flow's
 * capability model (`content:view` unlocks the preview, `content:publish`
 * unlocks the write), not promo-claim's single-capability-for-both-modes
 * model. See `../_actions.ts`'s `dryRunContentCreationBatchAction`/
 * `applyContentCreationBatchAction` header for the full reasoning.
 *
 * Cross-`channelApp` selections are allowed, unlike the promo-claim dialog —
 * creation never scopes to a channel account, so there is nothing here that
 * would silently fall outside a single channel app's boundary the way a
 * claim task would.
 */

type Stage =
  | { readonly kind: "loading" }
  | { readonly kind: "preview"; readonly data: ContentCreationBatchDryRunData }
  | { readonly kind: "applying" }
  | { readonly kind: "result"; readonly data: ContentCreationBatchApplyData }
  | { readonly kind: "invalid_input"; readonly message: string }
  | { readonly kind: "access_denied"; readonly message: string };

const TONE_STYLE: Readonly<Record<OutcomeTone, string>> = Object.freeze({
  success: "border-emerald-200 bg-emerald-50 text-emerald-900",
  info: "border-blue-200 bg-blue-50 text-blue-900",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
  danger: "border-red-200 bg-red-50 text-red-900",
});

const STATUS_BADGE_STYLE: Readonly<Record<OutcomeTone, string>> = Object.freeze({
  success: "bg-emerald-100 text-emerald-800",
  info: "bg-blue-100 text-blue-800",
  warning: "bg-amber-100 text-amber-800",
  danger: "bg-red-100 text-red-800",
});

function ItemRow({
  item,
  title,
}: {
  item: ContentCreationBatchDryRunItem | ContentCreationBatchApplyItem;
  title: string;
}) {
  const copy = describeBatchItem(item);
  const tone = batchItemStatusTone(item.status);
  return (
    <tr data-testid={`batch-create-item-${item.novelSourceItemId}`}>
      <TD>
        <p className="font-medium text-gray-900">{title}</p>
        <p className="text-xs text-gray-400">{item.novelSourceItemId}</p>
      </TD>
      <TD>
        <span
          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_STYLE[tone]}`}
          data-testid={`batch-create-item-status-${item.novelSourceItemId}`}
        >
          {batchItemStatusLabel(item.status)}
        </span>
      </TD>
      <TD className="text-xs text-gray-600">{copy.body}</TD>
    </tr>
  );
}

function ItemsTable({
  items,
  itemsById,
}: {
  items: readonly (ContentCreationBatchDryRunItem | ContentCreationBatchApplyItem)[];
  itemsById: ReadonlyMap<string, SourceItemRow>;
}) {
  return (
    <Table>
      <THead>
        <tr>
          <TH>来源条目</TH>
          <TH>状态</TH>
          <TH>说明</TH>
        </tr>
      </THead>
      <TBody>
        {items.map((item) => (
          <ItemRow
            key={item.novelSourceItemId}
            item={item}
            title={itemsById.get(item.novelSourceItemId)?.title ?? item.novelSourceItemId}
          />
        ))}
        {items.length === 0 && <EmptyRow colSpan={3}>没有可展示的条目</EmptyRow>}
      </TBody>
    </Table>
  );
}

export function BatchCreateContentDialog({
  selectedItems,
  maxBatchSize,
  contentPublishGranted,
  contentPublishBlockedReason,
  onClose,
  onSubmitted,
}: {
  selectedItems: readonly SourceItemRow[];
  maxBatchSize: number;
  contentPublishGranted: boolean;
  contentPublishBlockedReason: string | null;
  onClose: () => void;
  /** Called once an apply submission returns (any outcome) so the parent can clear the row selection — same contract as `PromoLinkClaimDialog`'s `onSubmitted`. */
  onSubmitted: () => void;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [stage, setStage] = useState<Stage>({ kind: "loading" });

  const itemsById = new Map(selectedItems.map((item) => [item.id, item] as const));
  const overLimit = selectedItems.length > maxBatchSize;
  const empty = selectedItems.length === 0;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  // Auto-preview on mount, same UX rule `CreateContentDialog` uses ("dry run
  // kicks off as soon as the dialog opens") — skipped when the selection is
  // already known-invalid client-side (over the cap, or empty), so an
  // obviously-rejected request is never actually sent.
  useEffect(() => {
    if (overLimit || empty) return;
    let cancelled = false;
    dryRunContentCreationBatchAction({
      novelSourceItemIds: selectedItems.map((item) => item.id),
      requestId: crypto.randomUUID(),
    }).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setStage(
          result.kind === "invalid_input"
            ? { kind: "invalid_input", message: batchActionInvalidInputMessage(result.code) }
            : { kind: "access_denied", message: errorEnvelopeCopy(result.envelope) },
        );
        return;
      }
      setStage({ kind: "preview", data: result.data });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the selection is fixed for this dialog instance's whole lifetime, see PromoLinkClaimDialog's own note on the same pattern
  }, []);

  async function confirmApply() {
    setStage({ kind: "applying" });
    const result = await applyContentCreationBatchAction({
      novelSourceItemIds: selectedItems.map((item) => item.id),
      requestId: crypto.randomUUID(),
    });
    if (!result.ok) {
      setStage(
        result.kind === "invalid_input"
          ? { kind: "invalid_input", message: batchActionInvalidInputMessage(result.code) }
          : { kind: "access_denied", message: errorEnvelopeCopy(result.envelope) },
      );
      return;
    }
    setStage({ kind: "result", data: result.data });
    onSubmitted();
    // Only meaningful if at least one item actually reached "created" — a
    // batch where nothing wrote anything (all skipped/failed/not_processed)
    // leaves every other page's render exactly as it was.
    if (result.data.counts.created > 0) router.refresh();
  }

  const isApplying = stage.kind === "applying";
  const creatableCount = stage.kind === "preview" ? stage.data.counts.creatable : 0;
  const canConfirm = stage.kind === "preview" && creatableCount > 0;

  return (
    <dialog
      ref={dialogRef}
      onCancel={(event) => {
        event.preventDefault();
        if (!isApplying) onClose();
      }}
      className="w-full max-w-3xl rounded-xl border border-gray-200 p-0 text-gray-900 shadow-xl backdrop:bg-gray-900/40"
    >
      <div className="space-y-4 p-5">
        <h2 className="text-base font-semibold">批量创建内容</h2>

        <p className="text-sm text-gray-600" data-testid="batch-create-selection-count">
          已选择 <span className="font-medium text-gray-900">{selectedItems.length}</span> 条来源条目
          （单次上限 {maxBatchSize} 条）
        </p>

        {empty && (
          <p role="alert" className={`rounded-lg border px-3 py-2 text-sm ${TONE_STYLE.danger}`}>
            未勾选任何来源条目，请先在列表中勾选后再打开本对话框。
          </p>
        )}

        {overLimit && (
          <p role="alert" className={`rounded-lg border px-3 py-2 text-sm ${TONE_STYLE.danger}`} data-testid="batch-create-over-limit">
            所选数量超过单次上限 {maxBatchSize} 条，请取消部分勾选后再提交。
          </p>
        )}

        {stage.kind === "loading" && !overLimit && !empty && (
          <p role="status" className="text-sm text-gray-500">
            正在生成批量创建预览…
          </p>
        )}

        {stage.kind === "preview" && (
          <div className="space-y-3">
            <p className={`rounded-lg border px-3 py-2 text-sm ${TONE_STYLE.info}`} role="status" data-testid="batch-create-preview-summary">
              尚未写入任何数据。{batchSummaryLine(stage.data.counts, "可创建")}
            </p>
            <ItemsTable items={stage.data.items} itemsById={itemsById} />
            {!contentPublishGranted && contentPublishBlockedReason && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {contentPublishBlockedReason}
              </p>
            )}
          </div>
        )}

        {stage.kind === "applying" && (
          <p role="status" className="text-sm text-gray-500">
            正在批量创建…
          </p>
        )}

        {stage.kind === "result" && (
          <div className="space-y-3">
            <p
              role="status"
              className={`rounded-lg border px-3 py-2 text-sm ${TONE_STYLE.success}`}
              data-testid="batch-create-result-summary"
            >
              {batchSummaryLine(stage.data.counts, "已创建")}
            </p>
            {batchNotProcessedHint(stage.data.counts.not_processed) && (
              <p
                role="alert"
                className={`rounded-lg border px-3 py-2 text-sm ${TONE_STYLE.warning}`}
                data-testid="batch-create-not-processed-hint"
              >
                {batchNotProcessedHint(stage.data.counts.not_processed)}
              </p>
            )}
            <ItemsTable items={stage.data.items} itemsById={itemsById} />
            {stage.data.previewEnqueue && (
              <p data-testid="batch-preview-enqueue-result" className={`rounded-lg border px-3 py-2 text-sm ${TONE_STYLE.info}`}>
                {stage.data.previewEnqueue.queued
                  ? stage.data.previewEnqueue.status === "enqueued" && stage.data.previewEnqueue.taskStatus === "disabled"
                    ? "聚合预览任务已创建，但目录写闸关闭，任务状态为 disabled。"
                    : "批量创建后的聚合预览刷新已处理；任务中心可查看结果。"
                  : `聚合预览未入队（${stage.data.previewEnqueue.reason}）；已创建内容不受影响。`}
              </p>
            )}
          </div>
        )}

        {stage.kind === "invalid_input" && (
          <p role="alert" className={`rounded-lg border px-3 py-2 text-sm ${TONE_STYLE.danger}`}>
            {stage.message}
          </p>
        )}
        {stage.kind === "access_denied" && (
          <p role="alert" className={`rounded-lg border px-3 py-2 text-sm ${TONE_STYLE.danger}`}>
            {stage.message}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={isApplying}
            onClick={onClose}
            className={buttonClassName("secondary")}
          >
            {stage.kind === "result" ? "关闭" : "取消"}
          </button>
          {stage.kind === "preview" && (
            <button
              type="button"
              disabled={!canConfirm || !contentPublishGranted}
              onClick={confirmApply}
              className={buttonClassName("primary")}
            >
              确认创建（批量，共 {creatableCount} 条可创建）
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
}
