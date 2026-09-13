"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { buttonClassName } from "@/components/ui/button";
import type { NovelGenerateCandidate } from "@/server/content-creation";

import { enqueueArticleGenerateBatchAction } from "../../_actions";

type TemplateOption = { readonly templateKey: string; readonly locale: string; readonly version: number };

export function ArticleBatchGenerateForm({
  novels,
  templates,
  canWrite,
}: {
  novels: readonly NovelGenerateCandidate[];
  templates: readonly TemplateOption[];
  canWrite: boolean;
}) {
  const eligible = novels.filter((row) => !row.hasLiveArticle);
  const locales = useMemo(() => Array.from(new Set(eligible.map((row) => row.locale))).sort(), [eligible]);
  const [selected, setSelected] = useState<string[]>([]);
  const [templateKeys, setTemplateKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);

  function toggle(id: string) {
    setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  async function submit() {
    if (!selected.length || !canWrite) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await enqueueArticleGenerateBatchAction({
        novelIds: selected,
        requestId: crypto.randomUUID(),
        templateKeysByLocale: Object.fromEntries(Object.entries(templateKeys).filter(([, value]) => value)),
      });
      if (!result.ok) {
        setMessage(result.code === "novel_ids_required" ? "请先选择书目。" : "提交失败，请重试。");
        return;
      }
      setTaskId(result.taskId);
      setMessage("批量创建文章任务已提交。这与「批量再生成」不同：这里只给还没有文章的书目建稿。");
    } catch {
      setMessage("提交失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-4">
      <p className="text-sm text-gray-600">批量创建文章只针对尚未建稿的书目。已有文章请走「批量再生成」，不会在这里被覆盖。</p>
      {locales.map((locale) => (
        <label className="block text-sm text-gray-700" key={locale}>
          {locale} 模板
          <select
            value={templateKeys[locale] ?? ""}
            onChange={(event) => setTemplateKeys((current) => ({ ...current, [locale]: event.target.value }))}
            className="mt-1 w-full rounded border border-gray-300 p-2"
          >
            <option value="">服务默认模板</option>
            {templates.filter((template) => template.locale === locale).map((template) => (
              <option key={`${template.templateKey}:${template.version}`} value={template.templateKey}>
                {template.templateKey} · v{template.version}
              </option>
            ))}
          </select>
        </label>
      ))}
      <div className="space-y-2">
        {eligible.map((novel) => (
          <label key={novel.novelId} className="flex items-start gap-2 text-sm text-gray-800">
            <input type="checkbox" checked={selected.includes(novel.novelId)} onChange={() => toggle(novel.novelId)} />
            <span>
              {novel.title} · {novel.locale} · {novel.businessId}
              {novel.promoReady ? "" : ` · ${novel.promoOutcome}`}
            </span>
          </label>
        ))}
        {eligible.length === 0 && <p className="text-sm text-gray-500">当前没有尚未创建文章的书目。</p>}
      </div>
      {message && <p role="status" className="rounded border border-blue-200 bg-blue-50 p-2 text-sm text-blue-900">{message}</p>}
      {taskId && <Link href={`/tasks/${taskId}`} className="text-sm text-blue-700 underline">查看任务</Link>}
      <div className="flex gap-2">
        <button type="button" disabled={!selected.length || !canWrite || busy} className={buttonClassName("primary")} onClick={() => void submit()}>
          {busy ? "正在提交…" : "提交批量创建文章"}
        </button>
        <Link href="/articles" className={buttonClassName("secondary")}>返回列表</Link>
      </div>
    </div>
  );
}
