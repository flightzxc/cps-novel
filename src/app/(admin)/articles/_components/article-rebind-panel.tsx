"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { buttonClassName } from "@/components/ui/button";
import { NOVEL_STATUS_BADGES } from "@/features/admin-ui/content-view";

import {
  rebindArticleNovelAction,
  rollbackArticleNovelAction,
  searchRebindCandidatesAction,
} from "../_actions";
import type { RebindCandidate, RebindGuardFinding, RebindView } from "../_types/rebind";

/**
 * C-30A (施工工单_C30_换小说_移植CPS换租客_2026-09-08.md §4A.7). Structure
 * ADAPTed from CPS `article-drama-switch-panel.tsx` (532 lines): current-
 * book card / target selector / three-tier guard banner / required-
 * acknowledge checkbox / required reason / rebind history — same
 * information architecture, rebuilt against this repo's own `AdminShell`/
 * `buttonClassName` component vocabulary rather than CPS's.
 *
 * 🔴 Two海阅-specific requirements this component must never regress
 * (施工工单 §4A.7, both covered by `tests/ui/article-rebind-panel.test.tsx`):
 *   1. The target selector is search-based — book title / business id / slug
 *      — never a raw UUID text field. `selectedCandidate` holds a UUID
 *      internally (`novelId`) but it is never rendered into an editable
 *      input; only clicked from a search-result card.
 *   2. "换绑后本页显示的分类将变为目标书目的分类" is always visible,
 *      regardless of guard tier — categories live on `Novel`, not `Article`
 *      (施工工单 §1.3), so this is not a risk to acknowledge, it is a fact
 *      to disclose every time.
 */

type GuardBannerLevel = "ok" | "needs_ack" | "blocked";

const GUARD_BANNER_STYLE: Readonly<Record<GuardBannerLevel, string>> = Object.freeze({
  ok: "border-green-300 bg-green-50 text-green-900",
  needs_ack: "border-amber-300 bg-amber-50 text-amber-900",
  blocked: "border-red-300 bg-red-50 text-red-900",
});

const GUARD_BANNER_LABEL: Readonly<Record<GuardBannerLevel, string>> = Object.freeze({
  ok: "可执行",
  needs_ack: "需确认",
  blocked: "不可执行",
});

function GuardFindingsList({ findings }: { findings: readonly RebindGuardFinding[] }) {
  if (findings.length === 0) return null;
  return (
    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
      {findings.map((finding) => (
        <li key={finding.code}>{finding.message}</li>
      ))}
    </ul>
  );
}

function CandidateCard({
  candidate,
  selected,
  onSelect,
}: {
  candidate: RebindCandidate;
  selected: boolean;
  onSelect: () => void;
}) {
  const badge = NOVEL_STATUS_BADGES[candidate.status as keyof typeof NOVEL_STATUS_BADGES];
  return (
    <button
      type="button"
      data-testid={`rebind-candidate-${candidate.novelId}`}
      onClick={onSelect}
      className={`w-full rounded-lg border p-3 text-left transition-colors ${
        selected ? "border-blue-500 bg-blue-50" : "border-gray-200 bg-white hover:bg-gray-50"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{candidate.title}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs ${badge?.color ?? "bg-gray-100 text-gray-800"}`}>
          {badge?.label ?? candidate.status}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-gray-500">
        业务 ID: {candidate.businessId} · slug: {candidate.slug} · 语种: {candidate.locale}
      </p>
      <span
        data-testid={`rebind-candidate-${candidate.novelId}-guard`}
        className={`mt-1 inline-block rounded px-2 py-0.5 text-xs font-medium ${GUARD_BANNER_STYLE[candidate.guardLevel]}`}
      >
        {GUARD_BANNER_LABEL[candidate.guardLevel]}
      </span>
      {candidate.titleMismatch && (
        <p className="mt-1 text-xs text-amber-700">目标书名与当前书名不同</p>
      )}
    </button>
  );
}

export function ArticleRebindPanel({
  articleId,
  initialView,
  canRebind,
}: {
  articleId: string;
  initialView: RebindView;
  canRebind: boolean;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<readonly RebindCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<RebindCandidate | null>(null);
  const [acknowledgeRisks, setAcknowledgeRisks] = useState(false);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const currentNovel = initialView.currentNovel;
  const hasRebindHistory = useMemo(
    () => initialView.history.some((entry) => entry.action === "article.rebind_novel"),
    [initialView.history],
  );

  async function runSearch(nextQuery: string) {
    setQuery(nextQuery);
    setSelected(null);
    setAcknowledgeRisks(false);
    if (!nextQuery.trim()) {
      setCandidates([]);
      return;
    }
    setSearching(true);
    try {
      const result = await searchRebindCandidatesAction({
        requestId: crypto.randomUUID(),
        articleId,
        query: nextQuery,
      });
      setCandidates(result.ok ? result.data : []);
    } finally {
      setSearching(false);
    }
  }

  function selectCandidate(candidate: RebindCandidate) {
    setSelected(candidate);
    setAcknowledgeRisks(false);
  }

  const needsAck = selected?.guardLevel === "needs_ack";
  const blocked = selected?.guardLevel === "blocked";
  const canSubmit =
    canRebind && !submitting && !!selected && !blocked && (!needsAck || acknowledgeRisks) && reason.trim().length > 0;

  async function submitRebind() {
    if (!selected || !currentNovel) return;
    setSubmitting(true);
    setMessage(null);
    try {
      const result = await rebindArticleNovelAction({
        requestId: crypto.randomUUID(),
        articleId,
        expectedOldNovelId: currentNovel.id,
        targetNovelId: selected.novelId,
        reason,
        acknowledgeRisks,
      });
      if (!result.ok) {
        setMessage(result.code === "rebind_drift" ? "当前书目已被其他操作改变，请刷新后重试。" : result.code);
        router.refresh();
        return;
      }
      setMessage("已换绑；本文章分类已随目标书目变更。");
      setQuery("");
      setCandidates([]);
      setSelected(null);
      setReason("");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  async function submitRollback() {
    setSubmitting(true);
    setMessage(null);
    try {
      const result = await rollbackArticleNovelAction({
        requestId: crypto.randomUUID(),
        articleId,
        reason: reason.trim() || "换回上一次",
      });
      if (!result.ok) {
        setMessage(result.code);
        router.refresh();
        return;
      }
      setMessage("已换回上一次绑定的书目。");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section
      data-testid="article-rebind-panel"
      className="mt-6 space-y-4 rounded-xl border bg-white p-5"
    >
      <h2 className="font-semibold">换小说</h2>

      {/* 🔴 always shown, every guard tier — categories live on Novel, not Article. */}
      <p
        data-testid="rebind-category-notice"
        className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900"
      >
        换绑后本页显示的分类将变为目标书目的分类。
      </p>

      {currentNovel && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
          <p className="font-medium">当前书目：{currentNovel.title}</p>
          <p className="mt-0.5 text-xs text-gray-600">
            语种: {currentNovel.locale} · 状态:{" "}
            {NOVEL_STATUS_BADGES[currentNovel.status as keyof typeof NOVEL_STATUS_BADGES]?.label ?? currentNovel.status}{" "}
            · 推广链接:{" "}
            {currentNovel.promoLinkId ? `已绑定（${currentNovel.promoRedirectCode ?? "—"}）` : "未绑定"}
          </p>
        </div>
      )}

      <div>
        <label className="block text-sm font-medium" htmlFor="rebind-search">
          目标书目搜索（书名 / 业务 ID / slug）
        </label>
        <input
          id="rebind-search"
          data-testid="rebind-search-input"
          type="text"
          value={query}
          onChange={(event) => void runSearch(event.target.value)}
          placeholder="输入书名、业务 ID 或 slug 搜索"
          className="mt-1 w-full rounded border p-2 text-sm"
          disabled={!canRebind}
        />
        {searching && <p className="mt-1 text-xs text-gray-500">搜索中…</p>}
      </div>

      {candidates.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2" data-testid="rebind-candidate-list">
          {candidates.map((candidate) => (
            <CandidateCard
              key={candidate.novelId}
              candidate={candidate}
              selected={selected?.novelId === candidate.novelId}
              onSelect={() => selectCandidate(candidate)}
            />
          ))}
        </div>
      )}

      {selected && (
        <div
          data-testid="rebind-guard-banner"
          className={`rounded-lg border px-3 py-2 text-sm ${GUARD_BANNER_STYLE[selected.guardLevel]}`}
        >
          <p className="font-medium">{GUARD_BANNER_LABEL[selected.guardLevel]}</p>
          <GuardFindingsList findings={selected.findings} />
          {needsAck && (
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                data-testid="rebind-acknowledge-checkbox"
                checked={acknowledgeRisks}
                onChange={(event) => setAcknowledgeRisks(event.target.checked)}
              />
              我已知悉以上风险，仍要继续换绑
            </label>
          )}
        </div>
      )}

      <div>
        <label className="block text-sm font-medium" htmlFor="rebind-reason">
          换绑理由（必填）
        </label>
        <textarea
          id="rebind-reason"
          data-testid="rebind-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          maxLength={500}
          className="mt-1 w-full rounded border p-2 text-sm"
          disabled={!canRebind}
        />
      </div>

      {message && (
        <p role="status" data-testid="rebind-message" className="text-sm">
          {message}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="rebind-submit"
          disabled={!canSubmit}
          onClick={() => void submitRebind()}
          className={buttonClassName("primary")}
        >
          确认换绑
        </button>
        {hasRebindHistory && (
          <button
            type="button"
            data-testid="rebind-rollback-button"
            disabled={!canRebind || submitting}
            onClick={() => void submitRollback()}
            className={buttonClassName("secondary")}
          >
            换回上一次
          </button>
        )}
      </div>

      {initialView.history.length > 0 && (
        <div>
          <h3 className="text-sm font-medium">换绑记录</h3>
          <ul className="mt-1 space-y-1 text-xs text-gray-600" data-testid="rebind-history-list">
            {initialView.history.map((entry) => (
              <li key={entry.id}>
                {entry.createdAt} · {entry.action === "article.rebind_rollback" ? "回滚" : "换绑"}
                {entry.reason ? ` · ${entry.reason}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
