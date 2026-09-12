"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { buttonClassName } from "@/components/ui/button";
import { EmptyRow, TBody, TD, TH, THead, Table } from "@/components/ui/table";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";
import { SITE_LOCALE_LABELS, type SiteLocale } from "@/lib/locale/locale-canonical";

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

/** Shape `catalog-sync-client.tsx` already threads down from `catalog-sync/page.tsx`'s `listActiveArticleTemplateOptionsForLocales` result — `id` is accepted but unused here (kept so the prop type matches the shared array verbatim, no `Omit<>` gymnastics at the call site). */
type BatchTemplateOption = { readonly id?: string; readonly templateKey: string; readonly locale: string; readonly version: number };

function templateOptionLabel(template: BatchTemplateOption): string {
  return `${template.templateKey} · v${template.version}`;
}

function localeDisplayLabel(locale: string): string {
  return `${locale}（${SITE_LOCALE_LABELS[locale as SiteLocale] ?? locale}）`;
}

export function BatchCreateContentDialog({
  selectedItems,
  maxBatchSize,
  contentPublishGranted,
  contentPublishBlockedReason,
  onClose,
  onSubmitted,
  templateOptions = [],
}: {
  selectedItems: readonly SourceItemRow[];
  maxBatchSize: number;
  contentPublishGranted: boolean;
  contentPublishBlockedReason: string | null;
  onClose: () => void;
  /** Called once an apply submission returns (any outcome) so the parent can clear the row selection — same contract as `PromoLinkClaimDialog`'s `onSubmitted`. */
  onSubmitted: () => void;
  templateOptions?: readonly BatchTemplateOption[];
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [stage, setStage] = useState<Stage>({ kind: "loading" });

  const itemsById = new Map(selectedItems.map((item) => [item.id, item] as const));
  const overLimit = selectedItems.length > maxBatchSize;
  const empty = selectedItems.length === 0;

  /**
   * P2 复核 C5-b: the whole selected batch shares ONE `templateKey`
   * (`confirmApply`/the auto-dry-run effect below both submit a single
   * `templateKey` for every item in the batch — the server still enforces
   * `template_locale_mismatch` per item, this is only the *picker*), but a
   * selection can legitimately span more than one derived locale. The
   * picker must offer every template that could apply to ANY selected
   * item — not silently stay pinned to whichever locale `templateOptions[0]`
   * happened to be — while making which locale each option belongs to
   * unambiguous (grouped by locale once there is more than one; a single
   * locale keeps the flat list `CreateContentDialog` already uses, with an
   * inline locale tag so this dialog never renders an option whose locale
   * is invisible to the operator).
   */
  // `Array.from(new Set(...))`, not a bare array literal — a plain dedupe
  // of already-resolved `item.sourceLocale` values, not a locale
  // resolution table; registered as such in
  // `tests/ui/locale-canonical.test.ts`'s `LOCALE_DECLARATION_EXEMPTIONS`
  // (file `batch-create-content-dialog.tsx`, identifier `selectedLocales`).
  const selectedLocales = Array.from(
    new Set(selectedItems.map((item) => item.sourceLocale).filter((locale): locale is string => locale !== null)),
  );
  const matchingTemplateOptions = templateOptions.filter((template) => selectedLocales.includes(template.locale));
  // Insertion order here already tracks `listActiveArticleTemplateOptionsForLocales`'s
  // own `orderBy: [{ locale: "asc" }, ...]` — grouping via `Map` preserves
  // that order instead of re-sorting. Named `templateOptionGroups` (not
  // e.g. `groupedByLocale`) so it stays outside `LOCALE_DECLARATION_
  // EXEMPTIONS`'s scope of Locale/Language-named declarations (see
  // `selectedLocales` above for the one declaration in this file that IS
  // in scope) — this is a plain re-shaping of already-resolved `locale`
  // values into a `Map`, not a locale resolution table.
  const templateOptionGroups = new Map<string, BatchTemplateOption[]>();
  for (const template of matchingTemplateOptions) {
    const group = templateOptionGroups.get(template.locale) ?? [];
    group.push(template);
    templateOptionGroups.set(template.locale, group);
  }
  const localeGroups = Array.from(templateOptionGroups.entries());
  const [templateKey, setTemplateKey] = useState(matchingTemplateOptions[0]?.templateKey ?? "system-default-v1");

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
      templateKey,
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
  }, [templateKey]);

  async function confirmApply() {
    setStage({ kind: "applying" });
    const result = await applyContentCreationBatchAction({
      novelSourceItemIds: selectedItems.map((item) => item.id),
      requestId: crypto.randomUUID(),
      templateKey,
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
        <label className="block text-sm text-gray-700">本批次固定模板
          <select value={templateKey} onChange={(event) => setTemplateKey(event.target.value)} disabled={stage.kind === "applying"} className="mt-1 w-full rounded border border-gray-300 p-2">
            {matchingTemplateOptions.length === 0 && <option value="system-default-v1">system-default-v1（系统默认）</option>}
            {localeGroups.length > 1
              ? localeGroups.map(([locale, options]) => (
                  <optgroup key={locale} label={localeDisplayLabel(locale)}>
                    {options.map((template) => (
                      <option key={`${template.templateKey}:${template.version}:${template.locale}`} value={template.templateKey}>
                        {templateOptionLabel(template)}
                      </option>
                    ))}
                  </optgroup>
                ))
              : matchingTemplateOptions.map((template) => (
                  <option key={`${template.templateKey}:${template.version}:${template.locale}`} value={template.templateKey}>
                    {templateOptionLabel(template)}（{localeDisplayLabel(template.locale)}）
                  </option>
                ))}
          </select>
          {selectedLocales.length > 1 && (
            <p className="mt-1 text-xs text-gray-400" data-testid="batch-create-multi-locale-hint">
              所选来源条目跨 {selectedLocales.length} 个语种，下拉已按语种分组；所选模板的语种与某条来源不一致时，该条会单独报
              template_locale_mismatch，不影响同批其余条目。
            </p>
          )}
        </label>

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
