"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";

import { buttonClassName } from "@/components/ui/button";
import type { NovelGeneratePage } from "@/domain/article-generation";

import {
  enqueueArticleGenerateBatchAction,
  listArticleGenerateCandidatesAction,
} from "../../_actions";

type TemplateOption = { readonly templateKey: string; readonly locale: string; readonly version: number };

export function ArticleBatchGenerateForm({
  initialPage,
  templates,
  canWrite,
}: {
  initialPage: NovelGeneratePage;
  templates: readonly TemplateOption[];
  canWrite: boolean;
}) {
  const requestIdRef = useRef(crypto.randomUUID());
  const [page, setPage] = useState(initialPage);
  const [search, setSearch] = useState("");
  const [locale, setLocale] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [templateKeys, setTemplateKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const locales = useMemo(
    () => Array.from(new Set([...page.rows.map((row) => row.locale), ...templates.map((row) => row.locale)])).sort(),
    [page.rows, templates],
  );
  const pageCount = Math.max(1, Math.ceil(page.total / page.pageSize));

  function toggle(id: string) {
    setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  async function load(nextPage: number, nextSearch = search, nextLocale = locale) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await listArticleGenerateCandidatesAction({
        requestId: crypto.randomUUID(),
        page: nextPage,
        ...(nextSearch ? { search: nextSearch } : {}),
        ...(nextLocale ? { locale: nextLocale } : {}),
      });
      if (!result.ok) {
        setMessage("无法读取待建稿书目，请重试。");
        return;
      }
      setPage(result.data);
    } finally {
      setBusy(false);
    }
  }

  async function submit(scope: "explicit_ids" | "all_filtered") {
    if (!canWrite) return;
    if (scope === "explicit_ids" && selected.length === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await enqueueArticleGenerateBatchAction({
        requestId: requestIdRef.current,
        selection: scope === "all_filtered"
          ? { scope: "all_filtered", filter: { ...(search ? { search } : {}), ...(locale ? { locale } : {}) } }
          : { scope: "explicit_ids", novelIds: selected },
        templateKeysByLocale: Object.fromEntries(Object.entries(templateKeys).filter(([, value]) => value)),
      });
      if (!result.ok) {
        requestIdRef.current = crypto.randomUUID();
        setMessage(result.code === "novel_ids_required" ? "请先选择书目。" : "提交失败，请重试。");
        return;
      }
      setTaskId(result.taskId);
      setMessage(
        scope === "all_filtered"
          ? "已按当前筛选提交异步批量任务。Worker 会分页枚举尚未建稿的书目，不会在页面里拉全库。"
          : "批量创建文章任务已提交。这与「批量再生成」不同：这里只给还没有文章的书目建稿。",
      );
    } catch {
      setMessage("提交失败，请重试。网络结果未知时请再点一次，会复用同一请求。");
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
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="mt-1 w-full rounded border border-gray-300 p-2"
          />
        </label>
        <label className="block text-sm text-gray-700">
          语种
          <input
            value={locale}
            onChange={(event) => setLocale(event.target.value)}
            className="mt-1 w-full rounded border border-gray-300 p-2"
          />
        </label>
      </div>
      <button
        type="button"
        className={buttonClassName("secondary")}
        disabled={busy}
        onClick={() => void load(1)}
      >
        应用筛选
      </button>
      {locales.map((item) => (
        <label className="block text-sm text-gray-700" key={item}>
          {item} 模板
          <select
            value={templateKeys[item] ?? ""}
            onChange={(event) => setTemplateKeys((current) => ({ ...current, [item]: event.target.value }))}
            className="mt-1 w-full rounded border border-gray-300 p-2"
          >
            <option value="">服务默认模板</option>
            {templates.filter((template) => template.locale === item).map((template) => (
              <option key={`${template.templateKey}:${template.version}`} value={template.templateKey}>
                {template.templateKey} · v{template.version}
              </option>
            ))}
          </select>
        </label>
      ))}
      <p className="text-sm text-gray-600">
        当前筛选共 {page.total.toLocaleString("zh-CN")} 本尚未创建文章的书目。本页 {page.rows.length} 本。
      </p>
      <div className="space-y-2">
        {page.rows.map((novel) => (
          <label key={novel.novelId} className="flex items-start gap-2 text-sm text-gray-800">
            <input type="checkbox" checked={selected.includes(novel.novelId)} onChange={() => toggle(novel.novelId)} />
            <span>
              {novel.title} · {novel.locale} · {novel.businessId}
              {novel.promoReady ? "" : ` · ${novel.promoOutcome}`}
            </span>
          </label>
        ))}
        {page.total === 0 && <p className="text-sm text-gray-500">当前筛选下没有尚未创建文章的书目。</p>}
      </div>
      <div className="flex gap-2 text-sm text-gray-700">
        <button type="button" disabled={busy || page.page <= 1} className={buttonClassName("secondary")} onClick={() => void load(page.page - 1)}>上一页</button>
        <span className="self-center">第 {page.page} / {pageCount} 页</span>
        <button type="button" disabled={busy || page.page >= pageCount} className={buttonClassName("secondary")} onClick={() => void load(page.page + 1)}>下一页</button>
      </div>
      {message && <p role="status" className="rounded border border-blue-200 bg-blue-50 p-2 text-sm text-blue-900">{message}</p>}
      {taskId && <Link href={`/tasks/${taskId}`} className="text-sm text-blue-700 underline">查看任务</Link>}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!selected.length || !canWrite || busy} className={buttonClassName("primary")} onClick={() => void submit("explicit_ids")}>
          {busy ? "正在提交…" : `提交已选 ${selected.length} 本`}
        </button>
        <button type="button" disabled={page.total === 0 || !canWrite || busy} className={buttonClassName("secondary")} onClick={() => void submit("all_filtered")}>
          按当前筛选全部入队
        </button>
        <Link href="/articles" className={buttonClassName("secondary")}>返回列表</Link>
      </div>
    </div>
  );
}
