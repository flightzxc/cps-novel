"use client";

import { useState } from "react";

import { buttonClassName } from "@/components/ui/button";
import { EmptyRow, TBody, TD, TH, THead, Table } from "@/components/ui/table";
import type { AdminCapabilityState } from "@/contracts";
import { capabilityBlockReason } from "@/features/admin-ui/capability-view";
import { NOVEL_SOURCE_ITEM_STATUS_BADGES, formatDateTime } from "@/features/admin-ui/content-view";

import { CreateContentDialog } from "./create-content-dialog";
import type { SourceItemRow } from "../_lib/read-source-items";

/**
 * `/catalog-sync` table + the one action this screen exists for: opening the
 * create-content dialog on a row (`create-content-dialog.tsx`).
 *
 * The "创建内容" trigger is always rendered, regardless of `contentPublish` —
 * opening the dialog only runs a dry run, which needs `content:view` (already
 * required to reach this page at all). `contentPublish` instead gates the
 * dialog's own "确认创建" step, so a viewer without the write grant can still
 * see the plan an admin would need to approve, per capability-driven UX
 * (P1-09 acceptance ⑥: name the missing capability, do not hide the feature).
 */
export function CatalogSyncClient({
  items,
  contentPublish,
}: {
  items: readonly SourceItemRow[];
  contentPublish: AdminCapabilityState;
}) {
  const [activeItem, setActiveItem] = useState<SourceItemRow | null>(null);
  const blockedReason = capabilityBlockReason("content:publish", contentPublish);
  const granted = blockedReason === null;

  return (
    <div className="space-y-4">
      {blockedReason && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {blockedReason}
          <span className="ml-1 text-amber-700">仍可预览创建计划，但无法执行创建。</span>
        </p>
      )}

      <Table>
        <THead>
          <tr>
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
          {items.length === 0 && <EmptyRow colSpan={7}>没有符合条件的来源条目</EmptyRow>}
        </TBody>
      </Table>

      {activeItem && (
        <CreateContentDialog
          item={activeItem}
          contentPublishGranted={granted}
          contentPublishBlockedReason={blockedReason}
          onClose={() => setActiveItem(null)}
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
