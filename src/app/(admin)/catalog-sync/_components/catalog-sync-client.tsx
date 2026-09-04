"use client";

import { useState } from "react";

import { buttonClassName } from "@/components/ui/button";
import { EmptyRow, TBody, TD, TH, THead, Table } from "@/components/ui/table";
import type { AdminCapabilityState } from "@/contracts";
import { capabilityBlockReason } from "@/features/admin-ui/capability-view";
import { NOVEL_SOURCE_ITEM_STATUS_BADGES, formatDateTime } from "@/features/admin-ui/content-view";

import { BatchCreateContentDialog } from "./batch-create-content-dialog";
import { CreateContentDialog } from "./create-content-dialog";
import { PromoLinkClaimDialog } from "./promo-link-claim-dialog";
import type { ClaimChannelAppOption } from "../_lib/read-channel-apps";
import type { SourceItemRow } from "../_lib/read-source-items";
import { catalogWriteGateState } from "../_lib/scan-task-copy";

/**
 * `/catalog-sync` table + the actions this screen exists for: opening the
 * create-content dialog on a row (`create-content-dialog.tsx`, P0-S13), an
 * explicit multi-select "领取推广链接" launcher (`promo-link-claim-dialog.tsx`,
 * RC-1 — CPS v8.3.6 parity for `submitChangduPromoClaim`), and since RC-4 an
 * explicit multi-select "批量创建内容" launcher
 * (`batch-create-content-dialog.tsx` — CPS v8.3.6 parity for
 * `runChangduPromoteDramaBatch`). Both multi-select launchers share this
 * component's one `selectedIds` state — there is no second, independent
 * selection mechanism for batch content creation.
 *
 * The "创建内容" trigger is always rendered, regardless of `contentPublish` —
 * opening the dialog only runs a dry run, which needs `content:view` (already
 * required to reach this page at all). `contentPublish` instead gates the
 * dialog's own "确认创建" step, so a viewer without the write grant can still
 * see the plan an admin would need to approve, per capability-driven UX
 * (P1-09 acceptance ⑥: name the missing capability, do not hide the feature).
 * The batch launcher follows the exact same rule: the toolbar button is
 * always enabled once something is selected, and `BatchCreateContentDialog`
 * gates only its own "确认创建" step on `contentPublish`.
 *
 * The selection checkbox column has no "select all" control, deliberately —
 * this screen never offers a filter-driven bulk-select shortcut, mirroring
 * the factory's own "explicit ids only, never a filter descriptor" contract
 * (`createPromoLinkClaimTask`'s doc comment) and CPS's own hard rule
 * ("畅读推广码领取只支持显式勾选剧目，不支持当前筛选全量领取") — RC-4's batch
 * creation reuses this same explicit-selection discipline.
 */
export function CatalogSyncClient({
  items,
  catalogGate,
  contentPublish,
  claimChannelApps,
  promoClaimMaxBatchSize,
  promoClaimGranted,
  promoClaimBlockedReason,
  contentCreationBatchMaxSize,
  templateOptions = [],
}: {
  items: readonly SourceItemRow[];
  catalogGate: { readonly featureEnabled: boolean; readonly writeAllowed: boolean };
  contentPublish: AdminCapabilityState;
  claimChannelApps: readonly ClaimChannelAppOption[];
  promoClaimMaxBatchSize: number;
  promoClaimGranted: boolean;
  promoClaimBlockedReason: string | null;
  contentCreationBatchMaxSize: number;
  templateOptions?: readonly { readonly id: string; readonly templateKey: string; readonly locale: string | null; readonly version: number }[];
}) {
  const [activeItem, setActiveItem] = useState<SourceItemRow | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [claimDialogOpen, setClaimDialogOpen] = useState(false);
  const [batchCreateDialogOpen, setBatchCreateDialogOpen] = useState(false);
  const blockedReason = capabilityBlockReason("content:publish", contentPublish);
  const granted = blockedReason === null;
  const gateState = catalogWriteGateState(catalogGate);

  const selectedItems = items.filter((item) => selectedIds.has(item.id));

  function toggleSelected(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <div
        data-testid="catalog-write-gate-status"
        data-state={gateState}
        className={`rounded-lg border px-3 py-2 text-sm ${
          gateState === "apply"
            ? "border-green-200 bg-green-50 text-green-800"
            : gateState === "dry_run"
              ? "border-amber-200 bg-amber-50 text-amber-800"
              : "border-red-200 bg-red-50 text-red-800"
        }`}
      >
        <span className="font-medium">目录写闸：</span>
        {gateState === "apply" && "apply（正式写入已开启）"}
        {gateState === "dry_run" && "dry-run（仅试运行，正式写入关闭）"}
        {gateState === "closed" && "closed（目录同步总闸关闭）"}
      </div>

      {blockedReason && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {blockedReason}
          <span className="ml-1 text-amber-700">仍可预览创建计划，但无法执行创建。</span>
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
        <p className="text-sm text-gray-600" data-testid="promo-claim-toolbar-count">
          已勾选 <span className="font-medium text-gray-900">{selectedItems.length}</span> 条来源条目
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={selectedItems.length === 0}
            className={buttonClassName("secondary", "px-3 py-1.5 text-xs")}
            onClick={() => setBatchCreateDialogOpen(true)}
          >
            批量创建内容
          </button>
          <button
            type="button"
            disabled={selectedItems.length === 0}
            className={buttonClassName("primary", "px-3 py-1.5 text-xs")}
            onClick={() => setClaimDialogOpen(true)}
          >
            领取推广链接
          </button>
        </div>
      </div>

      <Table>
        <THead>
          <tr>
            <TH className="w-8" />
            <TH>来源条目</TH>
            <TH>语种识别</TH>
            <TH>渠道</TH>
            <TH>章节</TH>
            <TH>状态</TH>
            <TH>最近可见</TH>
            <TH>操作</TH>
          </tr>
        </THead>
        <TBody>
          {items.map((item) => (
            <tr key={item.id}>
              <TD>
                <input
                  type="checkbox"
                  aria-label={`勾选 ${item.title}`}
                  checked={selectedIds.has(item.id)}
                  onChange={() => toggleSelected(item.id)}
                  className="h-4 w-4 rounded border-gray-300"
                />
              </TD>
              <TD>
                <p className="font-medium text-gray-900">{item.title}</p>
                <p className="text-xs text-gray-400">
                  {item.sourceAppName}（{item.sourceAppCode}）
                </p>
              </TD>
              <TD className="text-xs text-gray-600">
                {item.sourceLocale ?? "未识别"}
                <span className="ml-1 text-gray-400">
                  （{item.sourceLanguageName ?? item.sourceLanguageCode}）
                </span>
              </TD>
              <TD className="text-xs text-gray-600">
                {item.channelName}（{item.channelCode}）
              </TD>
              <TD className="text-xs text-gray-600">{item.totalChapterCount}</TD>
              <TD>
                <SourceItemStatusBadge status={item.status} />
              </TD>
              <TD className="text-xs text-gray-500">{formatDateTime(item.lastSeenAt)}</TD>
              <TD>
                <button
                  type="button"
                  className={buttonClassName("secondary", "px-2 py-1 text-xs")}
                  onClick={() => setActiveItem(item)}
                >
                  创建内容
                </button>
              </TD>
            </tr>
          ))}
          {items.length === 0 && <EmptyRow colSpan={8}>没有符合条件的来源条目</EmptyRow>}
        </TBody>
      </Table>

      {activeItem && (
        <CreateContentDialog
          item={activeItem}
          contentPublishGranted={granted}
          contentPublishBlockedReason={blockedReason}
          onClose={() => setActiveItem(null)}
          templateOptions={templateOptions}
        />
      )}

      {claimDialogOpen && (
        <PromoLinkClaimDialog
          selectedItems={selectedItems}
          channelApps={claimChannelApps}
          maxBatchSize={promoClaimMaxBatchSize}
          promoClaimGranted={promoClaimGranted}
          promoClaimBlockedReason={promoClaimBlockedReason}
          onClose={() => setClaimDialogOpen(false)}
          onSubmitted={() => setSelectedIds(new Set())}
        />
      )}

      {batchCreateDialogOpen && (
        <BatchCreateContentDialog
          selectedItems={selectedItems}
          maxBatchSize={contentCreationBatchMaxSize}
          contentPublishGranted={granted}
          contentPublishBlockedReason={blockedReason}
          onClose={() => setBatchCreateDialogOpen(false)}
          onSubmitted={() => setSelectedIds(new Set())}
          templateOptions={templateOptions}
        />
      )}
    </div>
  );
}

function SourceItemStatusBadge({ status }: { status: SourceItemRow["status"] }) {
  const badge = NOVEL_SOURCE_ITEM_STATUS_BADGES[status];
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${badge.color}`}
      data-testid={`source-item-status-${status}`}
    >
      {badge.label}
    </span>
  );
}
