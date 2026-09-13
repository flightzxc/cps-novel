"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { buttonClassName } from "@/components/ui/button";
import type { NovelGenerateCandidate, PinnedNovelResult } from "@/domain/article-generation";

import {
  applyArticleGenerateAction,
  dryRunArticleGenerateAction,
  type ArticleGenerateActionResult,
} from "../../_actions";

type TemplateOption = { readonly templateKey: string; readonly locale: string; readonly version: number };

function failureMessage(result: Extract<ArticleGenerateActionResult, { ok: false }>): string {
  if (result.kind === "invalid_input") {
    if (result.code === "invalid_novel_id") return "书目标识无效，请刷新后重试。";
    return `输入无效（${result.code}）。`;
  }
  return "当前账号无法创建文章。";
}

function describeGenerate(outcome: Extract<ArticleGenerateActionResult, { ok: true }>["data"]): { title: string; body: string } {
  switch (outcome.outcome) {
    case "created":
      return {
        title: "文章已创建",
        body: outcome.promoLinkId ? `草稿文章已绑定推广链接 ${outcome.promoLinkId}。` : "草稿文章已创建。",
      };
    case "already_exists":
      return { title: "该书目已有文章", body: "本次未覆盖已有正文、模板或 slug。" };
    case "dry_run":
      return { title: "生成计划", body: "尚未写入。确认后才会创建草稿文章。" };
    case "novel_not_found":
      return { title: "书目不存在", body: "请刷新后重新选择。" };
    case "novel_deleted":
      return { title: "书目已删除", body: "已删除的书目不能创建文章。" };
    case "article_soft_deleted":
      return { title: "该语种文章已被软删除", body: "唯一键仍被占用，不能新建，也不能自动复活。" };
    case "promo_link_missing":
      return { title: "还没有推广链接", body: "请先领取推广链接，再创建文章。" };
    case "promo_link_not_ready":
      return { title: "推广链接未就绪", body: "需要 fetched 且至少有一个可用地址。" };
    case "promo_link_deleted":
      return { title: "推广链接已删除", body: "请重新领取推广链接后再创建文章。" };
    case "template_locale_mismatch":
      return { title: "模板不可用", body: "所选模板不存在、未启用，或语种/类型不匹配。" };
    case "template_not_available":
      return { title: "没有可用模板", body: `语种「${outcome.locale}」没有可用的小说文章模板。` };
    case "slug_unhealthy":
    case "slug_conflict_exhausted":
      return { title: "文章 slug 无法生成", body: outcome.baseSlug };
    case "concurrent_generation_conflict":
      return { title: "并发冲突", body: "请重试，重试会命中已创建结果。" };
    case "template_render_failed":
      return { title: "模板渲染失败", body: outcome.code };
  }
}

function pinnedError(pinned: PinnedNovelResult): string | null {
  if (pinned.status === "invalid") return "书目标识无效。不会改选其它书目。";
  if (pinned.status === "missing") return "指定书目不存在。不会改选其它书目。";
  if (pinned.status === "deleted") return "指定书目已删除。不会改选其它书目。";
  return null;
}

export function ArticleGenerateForm({
  pinned,
  pageNovels,
  templates,
  canWrite,
}: {
  pinned: PinnedNovelResult;
  pageNovels: readonly NovelGenerateCandidate[];
  templates: readonly TemplateOption[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const requested = pinned.status !== "absent";
  const pinnedNovel = pinned.status === "found" ? pinned.novel : null;
  const pinFailed = requested && pinnedNovel === null;
  const [pickedId, setPickedId] = useState(pinnedNovel?.novelId ?? "");
  const novelId = pinFailed ? "" : (pinnedNovel?.novelId ?? pickedId);
  const selected = pinnedNovel
    ?? pageNovels.find((row) => row.novelId === novelId)
    ?? null;
  const localeTemplates = useMemo(
    () => templates.filter((template) => template.locale === selected?.locale),
    [templates, selected?.locale],
  );
  const [templateKey, setTemplateKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(pinnedError(pinned));

  async function run(mode: "dry_run" | "apply") {
    if (!novelId || pinFailed) return;
    setBusy(true);
    setMessage(null);
    try {
      const payload = {
        novelId,
        requestId: crypto.randomUUID(),
        ...(templateKey ? { templateKey } : {}),
      };
      const result = mode === "dry_run"
        ? await dryRunArticleGenerateAction(payload)
        : await applyArticleGenerateAction(payload);
      if (!result.ok) {
        setMessage(failureMessage(result));
        return;
      }
      const copy = describeGenerate(result.data);
      setMessage(`${copy.title}：${copy.body}`);
      if (result.data.outcome === "created") {
        router.refresh();
      }
    } catch {
      setMessage("请求失败，请刷新后重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-4">
      <p className="text-sm text-gray-600">只有明确执行“创建文章”时才选择 ArticleTemplate。纳入书目不会走到这里。</p>
      {pinnedNovel && (
        <p className="rounded border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-900">
          指定书目：{pinnedNovel.title} · {pinnedNovel.locale} · {pinnedNovel.businessId}
          {pinnedNovel.hasLiveArticle ? " · 已有文章" : " · 尚未创建文章"}
        </p>
      )}
      {pinFailed && (
        <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-800">
          {pinnedError(pinned)}
        </p>
      )}
      {!requested && (
        <label className="block text-sm text-gray-700">
          书目
          <select
            value={pickedId}
            onChange={(event) => {
              setPickedId(event.target.value);
              setTemplateKey("");
            }}
            className="mt-1 w-full rounded border border-gray-300 p-2"
          >
            <option value="">请选择书目</option>
            {pageNovels.map((novel) => (
              <option key={novel.novelId} value={novel.novelId}>
                {novel.title} · {novel.locale} · {novel.businessId}
                {novel.hasLiveArticle ? " · 已有文章" : ""}
                {novel.promoReady ? "" : " · 推广未就绪"}
              </option>
            ))}
          </select>
        </label>
      )}
      {selected && (
        <p className="text-sm text-gray-600">
          推广状态：{selected.promoReady ? "已就绪" : selected.promoOutcome}
        </p>
      )}
      <label className="block text-sm text-gray-700">
        文章模板
        <select value={templateKey} onChange={(event) => setTemplateKey(event.target.value)} className="mt-1 w-full rounded border border-gray-300 p-2">
          <option value="">服务默认模板</option>
          {localeTemplates.map((template) => (
            <option key={`${template.templateKey}:${template.version}`} value={template.templateKey}>
              {template.templateKey} · v{template.version}
            </option>
          ))}
        </select>
      </label>
      {message && !pinFailed && <p role="status" className="rounded border border-blue-200 bg-blue-50 p-2 text-sm text-blue-900">{message}</p>}
      <div className="flex gap-2">
        <button type="button" disabled={!novelId || pinFailed || busy} className={buttonClassName("secondary")} onClick={() => void run("dry_run")}>预览计划</button>
        <button type="button" disabled={!novelId || pinFailed || !canWrite || busy} className={buttonClassName("primary")} onClick={() => void run("apply")}>创建文章</button>
        <Link href="/articles" className={buttonClassName("secondary")}>返回列表</Link>
      </div>
    </div>
  );
}
