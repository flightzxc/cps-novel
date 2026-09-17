"use client";

import { useMemo, useState } from "react";
import { buttonClassName } from "@/components/ui/button";
import { EmptyRow, TBody, TD, TH, THead, Table } from "@/components/ui/table";
import type { AdminCapabilityState } from "@/contracts";
import type { CatalogFilterSnapshot, CatalogSelection } from "@/domain/catalog-batch";
import { capabilityBlockReason } from "@/features/admin-ui/capability-view";
import { NOVEL_SOURCE_ITEM_STATUS_BADGES, formatDateTime } from "@/features/admin-ui/content-view";
import { BatchCreateContentDialog } from "./batch-create-content-dialog";
import { CreateContentDialog } from "./create-content-dialog";
import { PromoLinkClaimDialog } from "./promo-link-claim-dialog";
import { skipReasonLabel } from "../_lib/promo-claim-copy";
import type { SourceItemRow } from "../_lib/read-source-items";

export function CatalogSyncClient({ items, catalogGate, contentPublish, promoClaimGranted, promoClaimBlockedReason, filter = {}, total = 0 }: { items: readonly SourceItemRow[]; catalogGate: { readonly featureEnabled: boolean }; contentPublish: AdminCapabilityState; promoClaimGranted: boolean; promoClaimBlockedReason: string | null; filter?: CatalogFilterSnapshot; total?: number }) {
  const [selection, setSelection] = useState<CatalogSelection>({ scope: "explicit_ids", ids: [] });
  const [activeItem, setActiveItem] = useState<SourceItemRow | null>(null);
  const [claimOpen, setClaimOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const blockedReason = capabilityBlockReason("content:publish", contentPublish);
  const ids = useMemo(() => new Set(selection.scope === "explicit_ids" ? selection.ids : []), [selection]);
  const selectedOnPage = items.filter((item) => selection.scope === "all_filtered" || ids.has(item.id));
  const allPageSelected = items.length > 0 && selectedOnPage.length === items.length;
  const somePageSelected = selectedOnPage.length > 0 && !allPageSelected;
  const selectedCount = selection.scope === "all_filtered" ? total : selection.ids.length;
  function toggleItem(id: string) { if (selection.scope === "all_filtered") return; setSelection((current) => { if (current.scope !== "explicit_ids") return current; const next = new Set(current.ids); if (next.has(id)) next.delete(id); else next.add(id); return { scope: "explicit_ids", ids: [...next] }; }); }
  function togglePage() { if (selection.scope === "all_filtered") { setSelection({ scope: "explicit_ids", ids: [] }); return; } setSelection((current) => { if (current.scope !== "explicit_ids") return current; const next = new Set(current.ids); const select = !items.every((item) => next.has(item.id)); items.forEach((item) => { if (select) next.add(item.id); else next.delete(item.id); }); return { scope: "explicit_ids", ids: [...next] }; }); }
  return <div className="space-y-4">
    <div data-testid="catalog-sync-gate-status" data-state={catalogGate.featureEnabled ? "enabled" : "disabled"} className={`rounded-lg border px-3 py-2 text-sm ${catalogGate.featureEnabled ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-800"}`}>{catalogGate.featureEnabled ? "目录同步总闸已启用。" : "FEATURE_NOVEL_CATALOG_SYNC 未启用，后台暂不允许创建目录扫描任务。"}</div>
    {blockedReason && <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{blockedReason}</p>}
    <div className="flex justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2"><p data-testid="promo-claim-toolbar-count">已勾选 <b>{selectedCount}</b> 条来源条目</p><div className="flex gap-2"><button disabled={!selectedCount} onClick={() => setCreateOpen(true)} className={buttonClassName("secondary")}>批量纳入书目</button><button disabled={!selectedCount} onClick={() => setClaimOpen(true)} className={buttonClassName("primary")}>领取推广链接</button></div></div>
    {selection.scope === "explicit_ids" && allPageSelected && <p>已选择本页 {items.length} 条 · <button onClick={() => setSelection({ scope: "all_filtered", filter })}>选择符合当前筛选条件的全部 {total} 条</button></p>}
    {selection.scope === "all_filtered" && <p data-testid="all-filtered-selection">已选择符合当前筛选条件的全部 {total} 条 · <button onClick={() => setSelection({ scope: "explicit_ids", ids: [] })}>取消全选</button></p>}
    <Table><THead><tr><TH><input aria-label="选择当前页" type="checkbox" checked={allPageSelected} ref={(el) => { if (el) el.indeterminate = somePageSelected; }} onChange={togglePage} /></TH><TH>来源条目</TH><TH>语种识别</TH><TH>渠道</TH><TH>章节</TH><TH>状态</TH><TH>领取资格</TH><TH>最近可见</TH><TH>操作</TH></tr></THead><TBody>{items.map((item) => <tr key={item.id}><TD><input aria-label={`勾选 ${item.title}`} type="checkbox" checked={selection.scope === "all_filtered" || ids.has(item.id)} disabled={selection.scope === "all_filtered"} onChange={() => toggleItem(item.id)} /></TD><TD><b>{item.title}</b><p>{item.sourceAppName}（{item.sourceAppCode}）</p></TD><TD>{item.sourceLocale ?? "未识别"}<p>{item.sourceLanguageName ?? "未命名"}（{item.sourceLanguageCode}）</p></TD><TD>{item.channelName}（{item.channelCode}）</TD><TD>{item.totalChapterCount}</TD><TD><span data-testid={`source-item-status-${item.status}`}>{NOVEL_SOURCE_ITEM_STATUS_BADGES[item.status].label}</span></TD><TD><span data-testid={`promo-claim-eligibility-${item.promoClaimEligible ? "eligible" : "ineligible"}`}>{item.promoClaimEligible ? "可领取" : `不可领取 · ${skipReasonLabel(item.promoClaimIneligibleReason ?? "source_not_linked")}`}</span></TD><TD>{formatDateTime(item.lastSeenAt)}</TD><TD><button onClick={() => setActiveItem(item)}>纳入书目</button></TD></tr>)}{!items.length && <EmptyRow colSpan={9}>没有符合条件的来源条目</EmptyRow>}</TBody></Table>
    {activeItem && <CreateContentDialog item={activeItem} contentPublishGranted={!blockedReason} contentPublishBlockedReason={blockedReason} onClose={() => setActiveItem(null)} />}
    {claimOpen && <PromoLinkClaimDialog selection={selection} promoClaimGranted={promoClaimGranted} promoClaimBlockedReason={promoClaimBlockedReason} onClose={() => setClaimOpen(false)} onSubmitted={() => setSelection({ scope: "explicit_ids", ids: [] })} />}
    {createOpen && <BatchCreateContentDialog selection={selection} contentPublishGranted={!blockedReason} contentPublishBlockedReason={blockedReason} onClose={() => setCreateOpen(false)} onSubmitted={() => setSelection({ scope: "explicit_ids", ids: [] })} />}
  </div>;
}
