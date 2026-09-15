"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { buttonClassName } from "@/components/ui/button";
import {
  articleGenerateBlockedReasonLabel,
  ArticleGenerateSelectionError,
  normalizeArticleGenerateFilter,
  type ArticleGenerateSelection,
  type ArticleTemplateOption,
  type NormalizedArticleGenerateFilter,
  type NovelGeneratePage,
} from "@/domain/article-generation";

import {
  enqueueArticleGenerateBatchAction,
  listArticleGenerateCandidatesAction,
} from "../../_actions";

type DraftFilter = { readonly search: string; readonly locale: string };

type FrozenRequest = Readonly<{
  requestId: string;
  scope: "explicit_ids" | "all_filtered";
  selection: ArticleGenerateSelection;
  templateKeysByLocale: Readonly<Record<string, string>>;
}>;

function canonicalFiltersEqual(
  left: NormalizedArticleGenerateFilter,
  right: NormalizedArticleGenerateFilter,
): boolean {
  return left.search === right.search && left.locale === right.locale;
}

function compactTemplates(templateKeys: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(templateKeys).filter(([, value]) => value));
}

function mergeTemplateCache(
  current: readonly ArticleTemplateOption[],
  incoming: readonly ArticleTemplateOption[],
): ArticleTemplateOption[] {
  const seen = new Set(current.map((row) => `${row.locale}:${row.templateKey}:${row.version}`));
  return [
    ...current,
    ...incoming.filter((row) => {
      const key = `${row.locale}:${row.templateKey}:${row.version}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  ];
}

function submitErrorMessage(code: string): string {
  if (code === "request_replay_mismatch") {
    return "request_replay_mismatch：同一请求号与已入队任务的筛选/模板不一致，不会自动换号重发。";
  }
  if (code === "novel_ids_required") return "请先选择书目。";
  return `提交失败（${code}），请重试。`;
}

export function ArticleBatchGenerateForm({
  initialPage,
  templates,
  canWrite,
}: {
  initialPage: NovelGeneratePage;
  templates: readonly ArticleTemplateOption[];
  canWrite: boolean;
}) {
  const [roundId, setRoundId] = useState(() => crypto.randomUUID());
  const [frozen, setFrozen] = useState<FrozenRequest | null>(null);
  const [page, setPage] = useState(initialPage);
  const [draftFilter, setDraftFilter] = useState<DraftFilter>({ search: "", locale: "" });
  const [appliedFilter, setAppliedFilter] = useState<NormalizedArticleGenerateFilter>({});
  // View-only list parameter — deliberately its own piece of state, never
  // folded into draftFilter/appliedFilter: it must not enter
  // canonicalFiltersEqual, the 「筛选已改动但尚未应用」 dirty check,
  // inputFingerprint, or an enqueued task payload. See
  // `listArticleGenerateCandidatesAction`'s `showIneligible` doc comment.
  const [showIneligible, setShowIneligible] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [templateKeys, setTemplateKeys] = useState<Record<string, string>>({});
  const [templateCache, setTemplateCache] = useState<readonly ArticleTemplateOption[]>(templates);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const filterDirty = !canonicalFiltersEqual(normalizeArticleGenerateFilter(draftFilter), appliedFilter);
  const requestLocked = frozen !== null;
  const locales = useMemo(
    () => Array.from(new Set([
      ...page.rows.map((row) => row.locale),
      ...templateCache.map((row) => row.locale),
      ...(appliedFilter.locale ? [appliedFilter.locale] : []),
    ])).sort(),
    [page.rows, templateCache, appliedFilter.locale],
  );
  const pageCount = Math.max(1, Math.ceil(page.total / page.pageSize));

  function toggle(id: string) {
    if (requestLocked) return;
    const novel = page.rows.find((row) => row.novelId === id);
    if (novel && !novel.canGenerateArticle) return;
    setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  async function load(
    nextPage: number,
    nextFilter: NormalizedArticleGenerateFilter,
    nextShowIneligible: boolean,
    reason: "apply" | "page" | "toggle",
  ) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await listArticleGenerateCandidatesAction({
        requestId: crypto.randomUUID(),
        page: nextPage,
        showIneligible: nextShowIneligible,
        ...nextFilter,
      });
      if (!result.ok) {
        setMessage(`无法读取待建稿书目（${result.code}）。已保留当前筛选与页码。`);
        return;
      }
      setPage(result.data);
      const blockedOnPage = new Set(result.data.rows
        .filter((row) => !row.canGenerateArticle)
        .map((row) => row.novelId));
      setSelected((current) => current.filter((novelId) => !blockedOnPage.has(novelId)));
      setTemplateCache((current) => mergeTemplateCache(current, result.templates));
      if (reason === "apply") {
        const changed = !canonicalFiltersEqual(nextFilter, appliedFilter);
        setAppliedFilter(nextFilter);
        if (changed) {
          setSelected([]);
          setTemplateKeys({});
        }
      }
    } catch {
      setMessage("无法读取待建稿书目。网络失败，已保留当前筛选与页码。");
    } finally {
      setBusy(false);
    }
  }

  function applyDraftFilter() {
    try {
      void load(1, normalizeArticleGenerateFilter(draftFilter), showIneligible, "apply");
    } catch (error) {
      const code = error instanceof ArticleGenerateSelectionError ? error.code : "filter_invalid";
      setMessage(`筛选无效（${code}）。已保留当前筛选与页码。`);
    }
  }

  function toggleShowIneligible() {
    if (requestLocked) return;
    const next = !showIneligible;
    setShowIneligible(next);
    void load(1, appliedFilter, next, "toggle");
  }

  function ensureFrozen(scope: "explicit_ids" | "all_filtered"): FrozenRequest {
    if (frozen) return frozen;
    const next: FrozenRequest = {
      requestId: roundId,
      scope,
      selection: scope === "all_filtered"
        ? { scope: "all_filtered", filter: appliedFilter }
        : { scope: "explicit_ids", novelIds: selected },
      templateKeysByLocale: compactTemplates(templateKeys),
    };
    setFrozen(next);
    return next;
  }

  async function submit(scope: "explicit_ids" | "all_filtered") {
    if (!canWrite || filterDirty) return;
    if (!frozen && scope === "explicit_ids" && selected.length === 0) return;
    const request = ensureFrozen(scope);
    setBusy(true);
    setMessage(null);
    try {
      const result = await enqueueArticleGenerateBatchAction({
        requestId: request.requestId,
        selection: request.selection,
        templateKeysByLocale: request.templateKeysByLocale,
      });
      if (!result.ok) {
        if (result.code === "request_replay_mismatch") {
          setMessage(submitErrorMessage(result.code));
          return;
        }
        setFrozen(null);
        setRoundId(crypto.randomUUID());
        setMessage(submitErrorMessage(result.code));
        return;
      }
      setFrozen(null);
      setRoundId(crypto.randomUUID());
      setTaskId(result.taskId);
      setMessage(
        result.duplicate
          ? "同一请求已存在，已回到原任务，不会新建第二份。"
          : request.scope === "all_filtered"
            ? "已按已应用筛选提交异步批量任务。Worker 会分页枚举尚未建稿的书目，不会在页面里拉全库。"
            : result.admission && result.admission.blockedCount > 0
              ? `任务已提交：已选 ${result.admission.selectedCount} 本，实际提交 ${result.admission.submittedCount} 本，准入阻断 ${result.admission.blockedCount} 本。`
              : "批量创建文章任务已提交。这与「批量再生成」不同：这里只给还没有文章的书目建稿。",
      );
    } catch {
      setMessage("提交结果未知。请再点一次重放同一请求，不要改筛选或模板。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-4">
      <p className="text-sm text-gray-600">批量创建文章只针对尚未建稿的书目。已有文章请走「批量再生成」，不会在这里被覆盖。</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm text-gray-700">
          搜索
          <input
            data-testid="batch-search"
            value={draftFilter.search}
            disabled={busy || requestLocked}
            onChange={(event) => setDraftFilter((current) => ({ ...current, search: event.target.value }))}
            className="mt-1 w-full rounded border border-gray-300 p-2"
          />
        </label>
        <label className="block text-sm text-gray-700">
          语种
          <input
            data-testid="batch-locale"
            value={draftFilter.locale}
            disabled={busy || requestLocked}
            onChange={(event) => setDraftFilter((current) => ({ ...current, locale: event.target.value }))}
            className="mt-1 w-full rounded border border-gray-300 p-2"
          />
        </label>
      </div>
      <button
        type="button"
        data-testid="apply-filter"
        className={buttonClassName("secondary")}
        disabled={busy || requestLocked}
        onClick={applyDraftFilter}
      >
        应用筛选
      </button>
      {filterDirty && (
        <p data-testid="filter-dirty" className="text-sm text-amber-800">
          筛选已改动但尚未应用。表格与入队仍使用已应用筛选；请先应用后再提交。
        </p>
      )}
      {locales.map((item) => (
        <label className="block text-sm text-gray-700" key={item}>
          {item} 模板
          <select
            data-testid={`template-${item}`}
            value={templateKeys[item] ?? ""}
            disabled={busy || requestLocked}
            onChange={(event) => setTemplateKeys((current) => ({ ...current, [item]: event.target.value }))}
            className="mt-1 w-full rounded border border-gray-300 p-2"
          >
            <option value="">服务默认模板</option>
            {templateCache.filter((template) => template.locale === item).map((template) => (
              <option key={`${template.templateKey}:${template.version}`} value={template.templateKey}>
                {template.templateKey} · v{template.version}
              </option>
            ))}
          </select>
        </label>
      ))}
      <p
        className="text-sm text-gray-600"
        data-testid="applied-total"
        data-applied-search={appliedFilter.search ?? ""}
        data-applied-locale={appliedFilter.locale ?? ""}
      >
        当前筛选可生成 {page.generatableCount.toLocaleString("zh-CN")} 本 · 另有{" "}
        {page.nonGeneratableCount.toLocaleString("zh-CN")} 本不可生成 · 本页 {page.rows.length} 本
      </p>
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input
          type="checkbox"
          data-testid="toggle-show-ineligible"
          checked={showIneligible}
          disabled={busy || requestLocked}
          onChange={toggleShowIneligible}
        />
        显示不可生成（{page.nonGeneratableCount.toLocaleString("zh-CN")} 本）
      </label>
      <div className="space-y-2">
        {page.rows.map((novel) => (
          <label key={novel.novelId} className="flex items-start gap-2 text-sm text-gray-800">
            <input
              type="checkbox"
              data-testid={`select-${novel.novelId}`}
              checked={selected.includes(novel.novelId)}
              disabled={requestLocked || !novel.canGenerateArticle}
              onChange={() => toggle(novel.novelId)}
            />
            <span>
              {novel.title} · {novel.locale} · {novel.businessId}
              {novel.generateBlockedReason ? ` · ${articleGenerateBlockedReasonLabel(novel.generateBlockedReason)}` : ""}
            </span>
          </label>
        ))}
        {page.total === 0 && <p className="text-sm text-gray-500">当前筛选下没有尚未创建文章的书目。</p>}
      </div>
      <div className="flex gap-2 text-sm text-gray-700">
        <button
          type="button"
          data-testid="prev-page"
          disabled={busy || requestLocked || page.page <= 1}
          className={buttonClassName("secondary")}
          onClick={() => void load(page.page - 1, appliedFilter, showIneligible, "page")}
        >
          上一页
        </button>
        <span className="self-center">第 {page.page} / {pageCount} 页</span>
        <button
          type="button"
          data-testid="next-page"
          disabled={busy || requestLocked || page.page >= pageCount}
          className={buttonClassName("secondary")}
          onClick={() => void load(page.page + 1, appliedFilter, showIneligible, "page")}
        >
          下一页
        </button>
      </div>
      {message && <p role="status" data-testid="batch-message" className="rounded border border-blue-200 bg-blue-50 p-2 text-sm text-blue-900">{message}</p>}
      {taskId && <Link href={`/tasks/${taskId}`} className="text-sm text-blue-700 underline">查看任务</Link>}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="submit-selected"
          disabled={(!selected.length && !frozen) || !canWrite || busy || filterDirty}
          className={buttonClassName("primary")}
          onClick={() => void submit("explicit_ids")}
        >
          {busy ? "正在提交…" : `提交已选 ${selected.length} 本`}
        </button>
        <button
          type="button"
          data-testid="submit-filtered"
          disabled={(page.total === 0 && !frozen) || !canWrite || busy || filterDirty}
          className={buttonClassName("secondary")}
          onClick={() => void submit("all_filtered")}
        >
          按当前筛选全部入队
        </button>
        <Link href="/articles" className={buttonClassName("secondary")}>返回列表</Link>
      </div>
    </div>
  );
}
