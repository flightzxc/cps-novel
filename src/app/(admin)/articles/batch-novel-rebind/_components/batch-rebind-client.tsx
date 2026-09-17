"use client";

import { useEffect, useState } from "react";

import { buttonClassName } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyRow, TBody, TD, TH, THead, Table } from "@/components/ui/table";

import {
  generateRebindBatchPreviewAction,
  getRebindBatchByTokenAction,
  getRebindBatchDetailAction,
  getRebindBatchFacetsAction,
  getRebindBatchPreviewPageAction,
  resumeRebindBatchAction,
  submitRebindBatchAction,
} from "../../_actions";
import type {
  RebindBatchDetail,
  RebindBatchFacets,
  RebindBatchSummary,
  RebindPreviewCategory,
  RebindPreviewPage,
} from "../../_types/rebind";
import {
  loadLatestActiveRebindBatchPending,
  removeRebindBatchPending,
  saveRebindBatchPending,
  supersedeRebindBatchPending,
  type RebindBatchPendingApply,
} from "../../_lib/rebind-recovery";

/**
 * C-30B (施工工单_C30_换小说_移植CPS换租客_2026-09-08.md §4B.4). Structure
 * ADAPTed from CPS `batch-drama-switch-v2-client.tsx` (1011 lines): 分面
 * 选择 → 生成有界预览 → 四页签 → 卡片列表 → 勾选 → 确认对话框 → 批次详情 →
 * 续跑. Direction is not hardcoded (施工工单 §2.3 item 1) — the channel
 * selectors list whatever `getRebindBatchFacetsAction` returns, which is
 * every registered `Channel` (today: one, `changdu`).
 *
 * 🔴 Requirements this component must never regress:
 *   1. Apply cap enforcement happens client-side too (`REBIND_BATCH_APPLY_CAP`
 *      below), not just server-side — selecting past it disables the submit
 *      button with a Chinese explanation.
 *   2. Zero bare UUIDs rendered anywhere — batch id is the human-readable
 *      `rebind-{...}` string; preview id and request token only ever live in
 *      component state / `sessionStorage`, never JSX text.
 *   3. Ambiguous-category rows are informational only — never checkable.
 *   4. The confirm dialog states "提交后按批次编号查询结果；页面报错或超时时
 *      不要重复提交，请用批次编号查询" verbatim.
 *   5. The request token is written to `sessionStorage` (via
 *      `saveRebindBatchPending`) BEFORE `submitRebindBatchAction` is called —
 *      CPS's own most load-bearing interaction design, ported verbatim in
 *      shape (`../../_lib/rebind-recovery.ts`).
 *   6. "继续执行" (resume) only renders when the batch's derived `status` is
 *      `"interrupted"`.
 */

// CPS is 400; this repo's rebind writes two columns under a composite FK
// per item (施工工单 §4B.1/§7 item 2) — kept in sync with
// `REBIND_BATCH_LIMITS.apply` (`@/server/article-rebind`) by hand, since a
// Client Component may not import anything from `@/server/**`
// (`tests/ui/admin-secret-boundary.test.tsx`).
const REBIND_BATCH_APPLY_CAP = 200;

const CATEGORY_TABS: ReadonlyArray<{ value: RebindPreviewCategory; label: string }> = [
  { value: "executable", label: "可执行" },
  { value: "risk_blocked", label: "有风险/受阻" },
  { value: "ambiguous", label: "歧义" },
  { value: "skipped", label: "未匹配" },
];

function requestId(): string {
  return crypto.randomUUID();
}

function newRequestToken(): string {
  return crypto.randomUUID();
}

function statusLabel(status: RebindBatchDetail["status"]): string {
  const labels: Record<RebindBatchDetail["status"], string> = {
    ready: "待执行",
    processing: "执行中",
    interrupted: "已中断，可续跑",
    completed: "已完成",
    partial: "部分完成",
    failed: "全部失败",
  };
  return labels[status] ?? status;
}

function sessionRecovery() {
  // `sessionStorage` is undefined during SSR / in a non-browser test
  // environment — every call site guards with `typeof window`.
  return typeof window === "undefined" ? null : window.sessionStorage;
}

export function BatchRebindClient() {
  const [facets, setFacets] = useState<RebindBatchFacets | null>(null);
  const [sourceChannelCode, setSourceChannelCode] = useState("");
  const [targetChannelCode, setTargetChannelCode] = useState("");
  const [locale, setLocale] = useState("");
  const [sourceApp, setSourceApp] = useState("");
  const [facetsError, setFacetsError] = useState<string | null>(null);

  const [summary, setSummary] = useState<RebindBatchSummary | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  const [activeCategory, setActiveCategory] = useState<RebindPreviewCategory>("executable");
  const [page, setPage] = useState<RebindPreviewPage | null>(null);
  const [pageIndex, setPageIndex] = useState(1);
  const [pageLoading, setPageLoading] = useState(false);

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [reason, setReason] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [batchDetail, setBatchDetail] = useState<RebindBatchDetail | null>(null);
  // C-30 单 3 W-1 — CPS parity (`batch-drama-switch-v2-client.tsx:407-421`
  // `DetailCard`'s own `leaseExpired` local state). Local-only: true once
  // this batch's lease should have expired, even before the next `刷新状态`
  // click re-derives `status === "interrupted"` server-side. See the effect
  // below and `canResume` near the resume button for the CPS-identical
  // three-way OR this feeds.
  const [leaseExpired, setLeaseExpired] = useState(false);
  // 🔴 recovery affordance: an unresolved pending token from a previous
  // failed/timed-out submit surfaces immediately on mount, before the
  // operator does anything else. A lazy `useState` initializer (not an
  // effect) — this is a synchronous `sessionStorage` read, not a fetch, so
  // there is no async data to synchronize and no `react-hooks/set-state-in-
  // effect` concern (`sessionRecovery()` itself already guards the SSR/
  // non-browser case by returning `null`).
  const [recoveryPending, setRecoveryPending] = useState<RebindBatchPendingApply | null>(() => {
    const storage = sessionRecovery();
    return storage ? loadLatestActiveRebindBatchPending(storage) : null;
  });

  /** Pure fetch, no `setState` of its own — same "effect awaits a plain fetch, state is applied in a `.then()`" shape `../../catalog-sync/_components/create-content-dialog.tsx`'s own mount effect already uses, to keep `react-hooks/set-state-in-effect` satisfied. */
  async function fetchFacets(nextSource: string, nextTarget: string, nextLocale: string) {
    return getRebindBatchFacetsAction({
      requestId: requestId(),
      sourceChannelCode: nextSource,
      targetChannelCode: nextTarget,
      locale: nextLocale || undefined,
    });
  }

  function applyFacetsResult(result: Awaited<ReturnType<typeof fetchFacets>>) {
    if (!result.ok) {
      setFacetsError(result.code);
      return;
    }
    setFacetsError(null);
    setFacets(result.data);
  }

  async function loadFacets(nextSource: string, nextTarget: string, nextLocale: string) {
    applyFacetsResult(await fetchFacets(nextSource, nextTarget, nextLocale));
  }

  useEffect(() => {
    let cancelled = false;
    fetchFacets("", "", "").then((result) => {
      if (!cancelled) applyFacetsResult(result);
    });
    return () => {
      cancelled = true;
    };
    // Only ever runs once on mount — channel/locale changes below re-fetch explicitly via `loadFacets`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // C-30 单 3 W-1 — VERBATIM CPS parity, `batch-drama-switch-v2-client.tsx:
  // 407-421` (`DetailCard`'s lease-expiry `useEffect`, deps `[detail.
  // leaseExpiresAt, detail.persistedStatus]`). Every dependency change first
  // schedules a 0-delay reset back to `false` (handles a refreshed detail
  // whose lease is alive again — see the "详情刷新后租约又活了" UI test), then,
  // only while the PERSISTED status is `"processing"`, schedules a second
  // timer for `leaseExpiresAt - now` (floored at 0) that flips `leaseExpired`
  // true. No polling: this fires once, at most, per dependency change; it
  // never itself calls a Server Action.
  useEffect(() => {
    const isProcessing = batchDetail?.persistedStatus === "processing";
    const resetTimer = window.setTimeout(() => setLeaseExpired(false), 0);
    if (!isProcessing) return () => window.clearTimeout(resetTimer);
    const expiresAt = batchDetail?.leaseExpiresAt ? new Date(batchDetail.leaseExpiresAt).getTime() : 0;
    const expiryTimer = window.setTimeout(() => setLeaseExpired(true), Math.max(0, expiresAt - Date.now()));
    return () => {
      window.clearTimeout(resetTimer);
      window.clearTimeout(expiryTimer);
    };
  }, [batchDetail?.leaseExpiresAt, batchDetail?.persistedStatus]);

  function onSourceChannelChange(value: string) {
    setSourceChannelCode(value);
    setLocale("");
    setSourceApp("");
    void loadFacets(value, targetChannelCode, "");
  }

  function onTargetChannelChange(value: string) {
    setTargetChannelCode(value);
  }

  function onLocaleChange(value: string) {
    setLocale(value);
    setSourceApp("");
    void loadFacets(sourceChannelCode, targetChannelCode, value);
  }

  async function generatePreview() {
    setGenerating(true);
    setPreviewError(null);
    setSummary(null);
    setBatchDetail(null);
    setSelected(new Set());
    try {
      const result = await generateRebindBatchPreviewAction({
        requestId: requestId(),
        sourceChannelCode,
        targetChannelCode,
        locale,
        sourceApp: sourceApp || undefined,
      });
      if (!result.ok) {
        setPreviewError(result.code);
        return;
      }
      setSummary(result.data);
      setActiveCategory("executable");
      setPageIndex(1);
      await loadPage(result.data.previewId, "executable", 1);
    } finally {
      setGenerating(false);
    }
  }

  async function loadPage(previewId: string, category: RebindPreviewCategory, pageNumber: number) {
    setPageLoading(true);
    try {
      const result = await getRebindBatchPreviewPageAction({
        requestId: requestId(),
        previewId,
        category,
        page: pageNumber,
      });
      if (result.ok) setPage(result.data);
    } finally {
      setPageLoading(false);
    }
  }

  function switchCategory(category: RebindPreviewCategory) {
    setActiveCategory(category);
    setPageIndex(1);
    if (summary) void loadPage(summary.previewId, category, 1);
  }

  function changePage(nextPage: number) {
    setPageIndex(nextPage);
    if (summary) void loadPage(summary.previewId, activeCategory, nextPage);
  }

  function toggleSelected(articleId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(articleId)) next.delete(articleId);
      else next.add(articleId);
      return next;
    });
  }

  function toggleSelectAllOnPage() {
    if (!page) return;
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = page.items.every((item) => next.has(item.articleId));
      for (const item of page.items) {
        if (allSelected) next.delete(item.articleId);
        else next.add(item.articleId);
      }
      return next;
    });
  }

  const overCap = selected.size > REBIND_BATCH_APPLY_CAP;
  const canOpenConfirm = selected.size > 0 && !overCap && reason.trim().length > 0 && !submitting;

  async function confirmSubmit() {
    if (!summary) return;
    setSubmitting(true);
    setSubmitError(null);
    const token = newRequestToken();
    const storage = sessionRecovery();
    // 🔴 the token is saved to recovery storage BEFORE the request goes out.
    if (storage) {
      saveRebindBatchPending(storage, {
        requestToken: token,
        previewId: summary.previewId,
        sourceChannelCode,
        targetChannelCode,
        selectedArticleIds: [...selected],
        reason,
        acknowledgeRisks: false,
        locale,
        sourceApp: sourceApp || undefined,
        savedAt: Date.now(),
      });
      setRecoveryPending(loadLatestActiveRebindBatchPending(storage));
    }
    try {
      const result = await submitRebindBatchAction({
        requestId: requestId(),
        previewId: summary.previewId,
        selectedArticleIds: [...selected],
        reason,
        acknowledgeRisks: false,
        requestToken: token,
      });
      if (storage) {
        const pending = loadLatestActiveRebindBatchPending(storage);
        if (pending && pending.requestToken === token) supersedeRebindBatchPending(storage, pending);
      }
      if (!result.ok) {
        setSubmitError(result.code);
        return;
      }
      setBatchDetail(result.data);
      setConfirmOpen(false);
      setSelected(new Set());
      setReason("");
    } catch {
      // A network-level failure (timeout, connection drop) never gets here
      // via `result.ok === false` — the recovery pending record saved above
      // is the only trace this request ever happened, deliberately left
      // "active" so the operator can look it up by `requestToken`/batch id
      // instead of resubmitting. 🔴 Never render the raw caught error (or
      // its `.message`) here — `tests/ui/admin-secret-boundary.test.tsx`
      // forbids any admin Client Component from reading `error.message`,
      // since it could leak internal failure detail; a fixed, opaque
      // Chinese message is the only thing shown.
      setSubmitError("提交请求未完成，请勿重复提交——用批次编号或上方的“查询该次提交结果”确认是否已提交成功。");
    } finally {
      setSubmitting(false);
    }
  }

  async function resumeBatch(batchId: string) {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await resumeRebindBatchAction({ requestId: requestId(), batchId });
      if (!result.ok) {
        setSubmitError(result.code);
        return;
      }
      setBatchDetail(result.data);
    } finally {
      setSubmitting(false);
    }
  }

  async function lookupPendingRecovery() {
    if (!recoveryPending) return;
    const result = await getRebindBatchByTokenAction({ requestId: requestId(), requestToken: recoveryPending.requestToken });
    const storage = sessionRecovery();
    if (result.ok && result.data) {
      setBatchDetail(result.data);
      if (storage) supersedeRebindBatchPending(storage, recoveryPending);
      setRecoveryPending(null);
    } else if (storage) {
      removeRebindBatchPending(storage, recoveryPending.requestToken);
      setRecoveryPending(null);
    }
  }

  async function refreshBatchDetail() {
    if (!batchDetail) return;
    const result = await getRebindBatchDetailAction({ requestId: requestId(), batchId: batchDetail.batchId });
    if (result.ok) setBatchDetail(result.data);
  }

  // C-30 单 3 W-1 — VERBATIM CPS parity, `batch-drama-switch-v2-client.tsx:
  // 424` (`canResume`). Was `status === "interrupted"` only, which misses
  // two real cases: (a) the batch never even got to "processing" — the
  // process died between the atomic create and the first execute call, so
  // `persistedStatus` is stuck at `"ready"` and the server-derived
  // `interrupted` state (which requires `persistedStatus === "processing"`)
  // can never fire; (b) the operator's own detail fetch landed while the
  // lease was still alive, so the server-derived state hasn't flipped yet
  // even though the lease has since expired — `leaseExpired` (the timer
  // above) covers that window without requiring a manual "刷新状态" click
  // first. `resumeRebindBatch` already accepts a `"ready"` batch (it only
  // rejects terminal ones), so this needs no server-side change.
  const canResume = batchDetail !== null && (batchDetail.status === "ready" || batchDetail.status === "interrupted" || leaseExpired);

  return (
    <div className="space-y-6" data-testid="batch-rebind-client">
      {recoveryPending && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900" data-testid="rebind-batch-recovery-banner">
          <p>检测到一次未确认结果的批量提交，请先查询该次提交的结果，不要重新提交。</p>
          <button type="button" className={buttonClassName("secondary", "mt-2")} data-testid="rebind-batch-recovery-lookup" onClick={() => void lookupPendingRecovery()}>
            查询该次提交结果
          </button>
        </div>
      )}

      <section className="space-y-3 rounded-xl border bg-white p-5">
        <h2 className="font-semibold">第一步：选择渠道与语种</h2>
        {facetsError && <p className="text-sm text-red-700">{facetsError}</p>}
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="block text-sm font-medium" htmlFor="rebind-batch-source-channel">来源渠道</label>
            <select
              id="rebind-batch-source-channel"
              data-testid="rebind-batch-source-channel"
              className="mt-1 w-full rounded border p-2 text-sm"
              value={sourceChannelCode}
              onChange={(event) => onSourceChannelChange(event.target.value)}
            >
              <option value="">请选择</option>
              {facets?.channels.map((channel) => (
                <option key={channel.value} value={channel.value}>{channel.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium" htmlFor="rebind-batch-target-channel">目标渠道</label>
            <select
              id="rebind-batch-target-channel"
              data-testid="rebind-batch-target-channel"
              className="mt-1 w-full rounded border p-2 text-sm"
              value={targetChannelCode}
              onChange={(event) => onTargetChannelChange(event.target.value)}
            >
              <option value="">请选择</option>
              {facets?.channels.filter((c) => c.value !== sourceChannelCode).map((channel) => (
                <option key={channel.value} value={channel.value}>{channel.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium" htmlFor="rebind-batch-locale">语种（必填）</label>
            <select
              id="rebind-batch-locale"
              data-testid="rebind-batch-locale"
              className="mt-1 w-full rounded border p-2 text-sm"
              value={locale}
              disabled={!sourceChannelCode}
              onChange={(event) => onLocaleChange(event.target.value)}
            >
              <option value="">请选择</option>
              {facets?.locales.map((item) => (
                <option key={item.value} value={item.value}>{item.label}（{item.count}）</option>
              ))}
            </select>
          </div>
        </div>

        {facets && facets.selectedLocale && facets.previewAllowed && facets.sourceApps.length > 0 && (
          <div>
            <label className="block text-sm font-medium" htmlFor="rebind-batch-source-app">来源应用（可选筛选）</label>
            <select
              id="rebind-batch-source-app"
              data-testid="rebind-batch-source-app"
              className="mt-1 w-64 rounded border p-2 text-sm"
              value={sourceApp}
              onChange={(event) => setSourceApp(event.target.value)}
            >
              <option value="">不限</option>
              {facets.sourceApps.map((item) => (
                <option key={item.value} value={item.value}>{item.label}（{item.count}）</option>
              ))}
            </select>
          </div>
        )}

        {facets && facets.selectedLocale && !facets.previewAllowed && (
          <p className="text-sm text-red-700" data-testid="rebind-batch-source-ceiling-message">
            该语种源文章数（{facets.selectedLocaleSourceCount}）超过单次预览上限（{facets.sourceCeiling}），请缩小范围。
          </p>
        )}

        <button
          type="button"
          data-testid="rebind-batch-generate-preview"
          className={buttonClassName("primary")}
          disabled={!sourceChannelCode || !targetChannelCode || !locale || generating || (facets ? !facets.previewAllowed : false)}
          onClick={() => void generatePreview()}
        >
          {generating ? "生成中…" : "生成有界预览"}
        </button>
        {previewError && <p className="text-sm text-red-700">{previewError}</p>}
      </section>

      {summary && (
        <section className="space-y-3 rounded-xl border bg-white p-5">
          <h2 className="font-semibold">第二步：确认换绑计划</h2>
          <p className="text-sm text-gray-600">
            源扫描 {summary.sourceScanned} 篇 · 可执行 {summary.executableCount} · 有风险/受阻 {summary.riskBlockedCount} · 歧义 {summary.ambiguousCount} · 未匹配 {summary.skippedCount}
          </p>
          <p className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
            换绑后本页显示的分类将变为目标书目的分类；预览快照 30 分钟后过期。
          </p>

          <div className="flex flex-wrap gap-2" role="tablist" data-testid="rebind-batch-category-tabs">
            {CATEGORY_TABS.map((tab) => {
              const count =
                tab.value === "executable"
                  ? summary.executableCount
                  : tab.value === "risk_blocked"
                    ? summary.riskBlockedCount
                    : tab.value === "ambiguous"
                      ? summary.ambiguousCount
                      : summary.skippedCount;
              return (
                <button
                  key={tab.value}
                  type="button"
                  role="tab"
                  aria-selected={activeCategory === tab.value}
                  data-testid={`rebind-batch-tab-${tab.value}`}
                  className={buttonClassName(activeCategory === tab.value ? "primary" : "secondary")}
                  onClick={() => switchCategory(tab.value)}
                >
                  {tab.label}（{count}）
                </button>
              );
            })}
          </div>

          {pageLoading && <p className="text-sm text-gray-500">加载中…</p>}

          {page && (
            <>
              {activeCategory === "executable" && (
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      data-testid="rebind-batch-select-page"
                      checked={page.items.length > 0 && page.items.every((item) => selected.has(item.articleId))}
                      onChange={toggleSelectAllOnPage}
                    />
                    本页全选
                  </label>
                  <p className="text-sm text-gray-600" data-testid="rebind-batch-selected-count">
                    已选择 {selected.size} / {REBIND_BATCH_APPLY_CAP}
                  </p>
                </div>
              )}
              {overCap && (
                <p className="text-sm text-red-700" data-testid="rebind-batch-cap-message">
                  已超过单次执行上限（{REBIND_BATCH_APPLY_CAP} 篇），请减少选择后再提交。
                </p>
              )}

              <div className="overflow-x-auto">
                <Table>
                  <THead>
                    <tr>
                      {activeCategory === "executable" && <TH></TH>}
                      <TH>文章</TH>
                      <TH>当前书目</TH>
                      <TH>目标书目</TH>
                      {activeCategory === "risk_blocked" && <TH>原因</TH>}
                      {activeCategory === "ambiguous" && <TH>候选书目</TH>}
                      {activeCategory === "skipped" && <TH>原因</TH>}
                    </tr>
                  </THead>
                  <TBody>
                    {page.items.length === 0 && <EmptyRow colSpan={5}>暂无数据</EmptyRow>}
                    {page.items.map((item) => (
                      <tr key={item.articleId} data-testid={`rebind-batch-row-${item.articleId}`}>
                        {activeCategory === "executable" && (
                          <TD>
                            <input
                              type="checkbox"
                              data-testid={`rebind-batch-checkbox-${item.articleId}`}
                              checked={selected.has(item.articleId)}
                              onChange={() => toggleSelected(item.articleId)}
                            />
                          </TD>
                        )}
                        <TD>
                          <a href={item.articleAdminUrl} className="text-blue-700 hover:underline">
                            {item.articleTitle || item.articleSlug}
                          </a>
                          {item.drifted && <span className="ml-2 text-xs text-amber-700">计划已漂移，建议重新生成</span>}
                        </TD>
                        <TD>{item.oldNovelTitle}</TD>
                        <TD>{item.targetNovelTitle ?? "—"}</TD>
                        {activeCategory === "risk_blocked" && (
                          <TD>
                            <ul className="list-disc space-y-0.5 pl-4 text-xs text-gray-700">
                              {item.findings.map((finding) => (
                                <li key={finding.code}>{finding.message}</li>
                              ))}
                            </ul>
                            {item.conflictArticle && (
                              <a href={`/articles/${item.conflictArticle.articleId}`} className="text-xs text-blue-700 hover:underline">
                                查看冲突文章
                              </a>
                            )}
                          </TD>
                        )}
                        {activeCategory === "ambiguous" && (
                          <TD className="text-xs text-gray-700">
                            {item.candidateNovelTitles.join("、") || "—"}
                            {item.candidatesTruncated && "（还有更多）"}
                            {/* 🔴 ambiguous rows are never checkable — no input here. */}
                          </TD>
                        )}
                        {activeCategory === "skipped" && <TD className="text-xs text-gray-700">未找到唯一匹配</TD>}
                      </tr>
                    ))}
                  </TBody>
                </Table>
              </div>

              {page.totalPages > 1 && (
                <div className="flex items-center gap-2 text-sm">
                  <button type="button" className={buttonClassName("secondary")} disabled={pageIndex <= 1} onClick={() => changePage(pageIndex - 1)}>
                    上一页
                  </button>
                  <span>第 {page.page} / {page.totalPages} 页</span>
                  <button type="button" className={buttonClassName("secondary")} disabled={pageIndex >= page.totalPages} onClick={() => changePage(pageIndex + 1)}>
                    下一页
                  </button>
                </div>
              )}
            </>
          )}

          {activeCategory === "executable" && (
            <>
              <div>
                <label className="block text-sm font-medium" htmlFor="rebind-batch-reason">换绑理由（必填）</label>
                <textarea
                  id="rebind-batch-reason"
                  data-testid="rebind-batch-reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  rows={3}
                  maxLength={500}
                  className="mt-1 w-full rounded border p-2 text-sm"
                />
              </div>
              <button
                type="button"
                data-testid="rebind-batch-open-confirm"
                className={buttonClassName("primary")}
                disabled={!canOpenConfirm}
                onClick={() => setConfirmOpen(true)}
              >
                确认所选并提交
              </button>
              {submitError && <p className="text-sm text-red-700" data-testid="rebind-batch-submit-error">{submitError}</p>}
            </>
          )}
        </section>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="确认批量换绑"
        confirmLabel="提交"
        pending={submitting}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void confirmSubmit()}
        body={
          <div className="space-y-1" data-testid="rebind-batch-confirm-body">
            <p>来源渠道：{facets?.channels.find((c) => c.value === sourceChannelCode)?.label ?? sourceChannelCode}</p>
            <p>目标渠道：{facets?.channels.find((c) => c.value === targetChannelCode)?.label ?? targetChannelCode}</p>
            <p>语种：{locale}</p>
            <p>选中数量：{selected.size} / 上限 {REBIND_BATCH_APPLY_CAP}</p>
            <p>理由：{reason}</p>
            <p className="font-medium text-amber-700">提交后按批次编号查询结果；页面报错或超时时不要重复提交，请用批次编号查询。</p>
          </div>
        }
      />

      {batchDetail && (
        <section className="space-y-3 rounded-xl border bg-white p-5" data-testid="rebind-batch-detail">
          <h2 className="font-semibold">批次详情</h2>
          {/* 🔴 零裸 UUID — batchId is the human-readable `rebind-{...}` id. */}
          <p className="text-sm">批次编号：<span data-testid="rebind-batch-id">{batchDetail.batchId}</span></p>
          <p className="text-sm">状态：<span data-testid="rebind-batch-status">{statusLabel(batchDetail.status)}</span></p>
          <div className="grid grid-cols-3 gap-2 text-sm sm:grid-cols-6">
            <p>提交 {batchDetail.counts.submitted}</p>
            <p>成功 {batchDetail.counts.applied}</p>
            <p>跳过 {batchDetail.counts.skipped}</p>
            <p>失败 {batchDetail.counts.failed}</p>
            <p>待处理 {batchDetail.counts.pending}</p>
            <p>处理中 {batchDetail.counts.processing}</p>
          </div>
          <div className="flex gap-2">
            <button type="button" className={buttonClassName("secondary")} onClick={() => void refreshBatchDetail()}>
              刷新状态
            </button>
            {canResume && (
              <button
                type="button"
                data-testid="rebind-batch-resume"
                className={buttonClassName("primary")}
                disabled={submitting}
                onClick={() => void resumeBatch(batchDetail.batchId)}
              >
                继续执行
              </button>
            )}
          </div>
          {/* C-30 单 3 §3.6 — static caption for the window between the lease
              timer firing locally and the next 刷新状态/续跑 round-trip
              re-deriving `status === "interrupted"` from the server. Only
              shown in that gap (`leaseExpired` true, server status not yet
              caught up) so it never duplicates the "已中断，可续跑" label the
              status line above already shows once the server does catch up. */}
          {leaseExpired && batchDetail.status !== "interrupted" && (
            <p className="text-xs text-amber-700" data-testid="rebind-batch-lease-expired-note">
              这批的执行租约已过期，可以续跑；点击后从未处理的那一条继续，已完成的不会重做。
            </p>
          )}
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <tr>
                  <TH>文章</TH>
                  <TH>状态</TH>
                  <TH>错误</TH>
                </tr>
              </THead>
              <TBody>
                {batchDetail.items.length === 0 && <EmptyRow colSpan={3}>暂无条目</EmptyRow>}
                {batchDetail.items.map((item) => (
                  <tr key={item.id}>
                    <TD><a href={`/articles/${item.articleId}`} className="text-blue-700 hover:underline">查看文章</a></TD>
                    <TD>{item.status}</TD>
                    <TD className="text-xs text-gray-600">{item.errorMessage ?? "—"}</TD>
                  </tr>
                ))}
              </TBody>
            </Table>
          </div>
        </section>
      )}
    </div>
  );
}
