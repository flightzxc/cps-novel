"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { buttonClassName } from "@/components/ui/button";
import type { AdminCapabilityState, AdminNovelListItemView } from "@/contracts";
import { capabilityBlockReason } from "@/features/admin-ui/capability-view";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";

import {
  publishNovelsBatchAction,
  type PublishNovelsBatchItem,
  type PublishNovelsBatchOutcome,
} from "../_actions";
import { MAX_BATCH_PUBLISH_SELECTION } from "../_lib/batch-publish-constants";
import { describePublishGateReason } from "../_lib/publish-gate-copy";
import { describePublishLifecycleError } from "../_lib/publish-outcome-copy";
import { NovelsTable } from "./novels-table";

/**
 * `/novels` list's selection + batch-publish toolbar (PR-C3, task item 4).
 *
 * Owns all selection state itself; `NovelsTable` stays the same
 * presentational component it always was, driven purely through its opt-in
 * `selection` prop (`./novels-table.tsx`). Every list still renders through
 * this wrapper going forward — `page.tsx` no longer calls `NovelsTable`
 * directly — but a page that genuinely wants the pre-PR-C3, no-selection
 * rendering can still get it by passing `<NovelsTable novels={...} />`
 * without this wrapper; nothing about that call path changed.
 */
export function NovelsBatchPublish({
  novels,
  canPublish,
}: {
  novels: readonly AdminNovelListItemView[];
  canPublish: AdminCapabilityState;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [result, setResult] = useState<PublishNovelsBatchOutcome | null>(null);

  const blocked = capabilityBlockReason("content:publish", canPublish);
  const overCap = selected.size > MAX_BATCH_PUBLISH_SELECTION;

  function toggle(novelId: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(novelId)) next.delete(novelId);
      else next.add(novelId);
      return next;
    });
  }

  async function runBatch(novelIds: readonly string[]) {
    if (novelIds.length === 0) return;
    setBusy(true);
    setNotice(null);
    const response = await publishNovelsBatchAction({ novelIds, requestId: crypto.randomUUID() });
    setBusy(false);
    if (!response.ok) {
      const message =
        response.kind === "access_denied"
          ? errorEnvelopeCopy(response.envelope)
          : response.kind === "lifecycle_error"
            ? describePublishLifecycleError(response.code)
            : "未选择任何书目。";
      setNotice({ tone: "error", text: `批量发布失败：${message}` });
      return;
    }
    setResult(response.data);
    setSelected(new Set());
    router.refresh();
  }

  function retryConflicts() {
    if (!result) return;
    const retryIds = result.items
      .filter((item) => item.kind !== "no_article" && item.result.outcome === "conflict")
      .map((item) => item.novelId);
    void runBatch(retryIds);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-sm">
        <span className="text-sm text-gray-600" data-testid="batch-publish-selected-count">
          已选择 {selected.size} 部
          {overCap && (
            <span className="text-red-600">
              {" "}
              超过批量发布上限（{MAX_BATCH_PUBLISH_SELECTION} 部），请减少选择后再提交
            </span>
          )}
        </span>
        <button
          type="button"
          disabled={busy || selected.size === 0 || overCap || blocked !== null}
          title={blocked ?? undefined}
          className={buttonClassName("primary")}
          onClick={() => void runBatch(Array.from(selected))}
          data-testid="batch-publish-submit"
        >
          批量发布
        </button>
        {selected.size > 0 && (
          <button
            type="button"
            disabled={busy}
            className={buttonClassName("ghost")}
            onClick={() => setSelected(new Set())}
            data-testid="batch-publish-clear-selection"
          >
            清空选择
          </button>
        )}
      </div>

      {blocked && <p className="text-xs text-amber-700">{blocked}</p>}
      {notice && (
        <p
          role="status"
          className={`rounded-lg border px-3 py-2 text-sm ${
            notice.tone === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          {notice.text}
        </p>
      )}

      {result && <BatchResultPanel result={result} busy={busy} onRetryConflicts={retryConflicts} />}

      <NovelsTable
        novels={novels}
        selection={{ selected, onToggle: toggle, disabled: () => busy }}
      />
    </div>
  );
}

function assertUnreachableOutcome(value: never): never {
  throw new Error(`Unhandled publish outcome: ${JSON.stringify(value)}`);
}

function describeBatchItemOutcome(item: PublishNovelsBatchItem): string {
  if (item.kind === "no_article") return "无关联文章，未提交发布";
  const { result } = item;
  switch (result.outcome) {
    case "published":
      return result.firstPublish ? "已发布（首次公开）" : "已发布";
    case "not_found":
      return "对应文章不存在";
    case "conflict":
      return "并发冲突，可重试";
    case "rejected":
      return `门禁拒绝：${result.gate.reasons.map((reason) => describePublishGateReason(reason).label).join("、")}`;
    default:
      return assertUnreachableOutcome(result);
  }
}

function BatchResultPanel({
  result,
  busy,
  onRetryConflicts,
}: {
  result: PublishNovelsBatchOutcome;
  busy: boolean;
  onRetryConflicts: () => void;
}) {
  const { summary } = result;
  return (
    <div className="space-y-2 rounded-xl border border-gray-200 bg-white p-4 shadow-sm" data-testid="batch-publish-result">
      <p className="text-sm font-medium text-gray-900">
        批量发布结果：成功 {summary.published} · 拒绝 {summary.rejected} · 冲突 {summary.conflict} · 文章不存在{" "}
        {summary.notFound}
        {summary.noArticle > 0 ? ` · 无关联文章 ${summary.noArticle}` : ""}
      </p>
      {summary.conflict > 0 && (
        <button
          type="button"
          disabled={busy}
          className={buttonClassName("secondary")}
          onClick={onRetryConflicts}
          data-testid="batch-publish-retry-conflicts"
        >
          重试 {summary.conflict} 个冲突项
        </button>
      )}
      <ul className="max-h-64 divide-y divide-gray-100 overflow-y-auto text-xs">
        {result.items.map((item) => (
          <li key={item.novelId} className="flex gap-2 py-1.5" data-testid={`batch-publish-item-${item.novelId}`}>
            <span className="shrink-0 font-mono text-gray-400">{item.novelId.slice(0, 8)}</span>
            <span className="text-gray-700">{describeBatchItemOutcome(item)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
