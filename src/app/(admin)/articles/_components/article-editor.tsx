"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { buttonClassName } from "@/components/ui/button";
import type { ArticleContentMode, ArticleSeoVisibility, ArticleType } from "@/domain/database-statuses";
import {
  ARTICLE_CONTENT_MODE_LABELS,
  ARTICLE_SEO_VISIBILITY_OPTIONS,
  ARTICLE_TYPE_LABELS,
} from "@/features/admin-ui/content-view";
import { updateArticleAction } from "../_actions";

/**
 * N-7 optimistic lock: `expectedUpdatedAt` is seeded once from the
 * server-read row via `useState`'s initializer, same `expectedUpdatedAt`
 * round-trip contract as the settings form (`site-settings-client.tsx`).
 * This is a Server Component page (`[articleId]/page.tsx`), not a client
 * fetch like settings, so there is no `adminFetch` re-read to call after a
 * conflict; instead the caller keys this component by `article.updatedAt`
 * (see `[articleId]/page.tsx`) so `router.refresh()` — which re-runs the
 * server component and hands back a fresh row on both a successful save and
 * a conflict — remounts this component with the new value, re-arming the
 * lock and every `defaultValue` field at once rather than requiring a
 * render-phase sync effect for just this one field.
 */
export function ArticleEditor({ article, canWrite }: { article: { id: string; title: string; summary: string | null; body: string; seoMetadata: unknown; slug: string; publicPageShortId: string; seoVisibility: string; articleType: string; contentMode: string; updatedAt: string }; canWrite: boolean }) {
  const router = useRouter();
  const meta = article.seoMetadata && typeof article.seoMetadata === "object" && !Array.isArray(article.seoMetadata) ? article.seoMetadata as Record<string, unknown> : {};
  const [preview, setPreview] = useState(article.body);
  const [message, setMessage] = useState<string | null>(null);
  const [expectedUpdatedAt] = useState(article.updatedAt);
  // C-25: the three-pill selector below is a button group, not a native
  // form control with its own `name`/`value` — it needs controlled state
  // read directly by `submit` (same reason `body`'s own edits flow through
  // `preview` state above for the right-hand panel, though `body` itself
  // still round-trips via `formData.get` since its control IS a native
  // `<textarea name="body">`).
  const [seoVisibility, setSeoVisibility] = useState<ArticleSeoVisibility>(
    article.seoVisibility as ArticleSeoVisibility,
  );
  async function submit(formData: FormData) {
    const body = String(formData.get("body") ?? "");
    const result = await updateArticleAction({ requestId: crypto.randomUUID(), articleId: article.id, expectedUpdatedAt, patch: {
      title: String(formData.get("title") ?? ""), summary: String(formData.get("summary") ?? ""), body,
      metaTitle: String(formData.get("metaTitle") ?? ""), metaDescription: String(formData.get("metaDescription") ?? ""),
      seoVisibility,
    } });
    if (!result.ok) {
      setMessage(result.code === "article_conflict" ? "该文章已被其他操作人修改，请刷新后重试。" : result.code);
      router.refresh();
      return;
    }
    setMessage("已保存；slug 与 shortId 保持不变。");
    setPreview(body);
    router.refresh();
  }
  return <div className="grid gap-6 lg:grid-cols-2"><form action={submit} className="space-y-4 rounded-xl border bg-white p-5">
    <label className="block text-sm">标题<input name="title" defaultValue={article.title} required className="mt-1 w-full rounded border p-2" /></label>
    <label className="block text-sm">摘要<textarea name="summary" defaultValue={article.summary ?? ""} rows={4} className="mt-1 w-full rounded border p-2" /></label>
    <label className="block text-sm">正文 HTML<textarea name="body" defaultValue={article.body} required rows={16} className="mt-1 w-full rounded border p-2 font-mono text-xs" onChange={(event) => setPreview(event.target.value)} /></label>
    <label className="block text-sm">SEO 标题<input name="metaTitle" defaultValue={String(meta.metaTitle ?? "")} className="mt-1 w-full rounded border p-2" /></label>
    <label className="block text-sm">SEO 描述<textarea name="metaDescription" defaultValue={String(meta.metaDescription ?? "")} rows={3} className="mt-1 w-full rounded border p-2" /></label>
    {/*
      C-25 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-25):
      three-pill selector, same information structure as CPS's own
      `articles/article-form-v2/featured-fields.tsx` "SEO 可见性" pills (照抄 CPS 那三颗
      药丸按钮的信息结构) — a `role="radiogroup"` of buttons rather than a
      native `<select>`, matching that CPS component's own control shape.
    */}
    <div className="block text-sm" role="radiogroup" aria-label="SEO 可见性">
      <span className="mb-1 block">SEO 可见性</span>
      <div className="flex flex-wrap gap-2">
        {ARTICLE_SEO_VISIBILITY_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={seoVisibility === option.value}
            data-testid={`article-seo-visibility-option-${option.value}`}
            onClick={() => setSeoVisibility(option.value)}
            className={
              seoVisibility === option.value
                ? "rounded-full border border-green-600 bg-green-600 px-4 py-1.5 text-sm font-medium text-white"
                : "rounded-full border border-gray-300 bg-white px-4 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            }
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
    {/*
      C-26 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-26):
      read-only display of 类型/内容模式, deliberately not a form control — the
      plan's own "不移植 CPS 的内容模式与模板选择器的联动" exception: in this
      repo `contentMode` is a system-observed fact about which write path last
      touched the body (`updateArticleContent` → manual, creation/regenerate →
      template — see that function's own doc comment), not an operator
      choice, so giving it an editable control would let an operator claim
      "template" over a body that is actually hand-edited (or vice versa) —
      exactly the "说谎数据" failure mode the plan calls out. `articleType`
      has no editing surface anywhere in this round either (blog creation,
      the only thing that would ever set it to something other than
      `novel_article`, is C-27/C-28 — out of this round's scope).
    */}
    <p className="text-xs text-gray-500" data-testid="article-editor-type-content-mode">
      类型: {ARTICLE_TYPE_LABELS[article.articleType as ArticleType] ?? article.articleType} · 内容模式: {ARTICLE_CONTENT_MODE_LABELS[article.contentMode as ArticleContentMode] ?? article.contentMode}
    </p>
    <p className="text-xs text-gray-500">slug: {article.slug} · shortId: {article.publicPageShortId}</p>{message && <p role="status" className="text-sm">{message}</p>}
    <button disabled={!canWrite} className={buttonClassName("primary")}>保存</button>
  </form><section className="rounded-xl border bg-white p-5"><h2 className="mb-4 font-semibold">正文预览</h2><div className="prose max-w-none" dangerouslySetInnerHTML={{ __html: preview }} /></section></div>;
}
