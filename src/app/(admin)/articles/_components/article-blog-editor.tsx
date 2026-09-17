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
 * C-28 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-28):
 * "编辑页按文章类型分叉:博客走一套没有模板绑定、没有再生成按钮的编辑器".
 * The fork itself lives in the server component
 * (`../[articleId]/page.tsx`), which decides *which* editor to mount based
 * on `article.novel === null` — never inside a single client component
 * branching at render time (the plan's own risk note: doing the fork
 * client-side would risk pulling a server-only import across the client
 * boundary for whichever branch needs one later; deciding server-side and
 * handing each variant only the already-typed props it needs avoids that
 * regardless of what either variant grows into next).
 *
 * `ArticleEditor` (the `novel_article` variant, unchanged by this round) has
 * no template-binding field and no "再生成" button of its own already — that
 * control lives on the list page's per-row/batch actions
 * (`./article-list.tsx`), not on this per-article editor — so there is
 * nothing template/regenerate-shaped to additionally omit here; "没有再生成
 * 按钮的编辑器" is satisfied by construction (this component simply never
 * renders one, the same as `ArticleEditor` never has). What this component
 * *adds* over `ArticleEditor`, genuinely justifying a separate component
 * rather than one shared form with an `if (blog)`: two blog-only
 * `seoMetadata` keys a `novel_article` never has reason to carry —
 * `coverUrl`/`metaKeywords`, both introduced at creation time by
 * `src/server/content-creation/blog.ts` (see that module's header on why
 * `coverUrl` lives inside `seoMetadata` rather than a dedicated column this
 * round). Both round-trip through the same `updateArticleContent`/
 * `admin.article.update` write口 `ArticleEditor` already uses — `ArticleEditInput`
 * was extended additively (`src/server/articles/service.ts`) for exactly
 * this, not duplicated into a second update service; "唯一写口" stays
 * singular.
 */
export function ArticleBlogEditor({
  article,
  canWrite,
}: {
  article: {
    id: string;
    title: string;
    summary: string | null;
    body: string;
    seoMetadata: unknown;
    slug: string;
    publicPageShortId: string;
    seoVisibility: string;
    /**
     * Not assumed to always be `"blog_article"` — this editor is mounted
     * for every non-`novel_article` type (`article.novel === null`, the
     * same fork condition `../[articleId]/page.tsx` uses), which also
     * covers `listicle`/`guide` should either ever gain a creation path.
     * Rendered through the same label maps `ArticleEditor` uses rather than
     * a hardcoded "博客文章" string, so this line stays correct for those
     * too.
     */
    articleType: string;
    contentMode: string;
    updatedAt: string;
  };
  canWrite: boolean;
}) {
  const router = useRouter();
  const meta =
    article.seoMetadata && typeof article.seoMetadata === "object" && !Array.isArray(article.seoMetadata)
      ? (article.seoMetadata as Record<string, unknown>)
      : {};
  const [preview, setPreview] = useState(article.body);
  const [message, setMessage] = useState<string | null>(null);
  const [expectedUpdatedAt] = useState(article.updatedAt);
  const [seoVisibility, setSeoVisibility] = useState<ArticleSeoVisibility>(
    article.seoVisibility as ArticleSeoVisibility,
  );

  async function submit(formData: FormData) {
    const body = String(formData.get("body") ?? "");
    const result = await updateArticleAction({
      requestId: crypto.randomUUID(),
      articleId: article.id,
      expectedUpdatedAt,
      patch: {
        title: String(formData.get("title") ?? ""),
        summary: String(formData.get("summary") ?? ""),
        body,
        metaTitle: String(formData.get("metaTitle") ?? ""),
        metaDescription: String(formData.get("metaDescription") ?? ""),
        metaKeywords: String(formData.get("metaKeywords") ?? ""),
        coverUrl: String(formData.get("coverUrl") ?? ""),
        seoVisibility,
      },
    });
    if (!result.ok) {
      setMessage(result.code === "article_conflict" ? "该文章已被其他操作人修改，请刷新后重试。" : result.code);
      router.refresh();
      return;
    }
    setMessage("已保存；slug 与 shortId 保持不变。");
    setPreview(body);
    router.refresh();
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <form action={submit} className="space-y-4 rounded-xl border bg-white p-5">
        <label className="block text-sm">
          标题
          <input name="title" defaultValue={article.title} required className="mt-1 w-full rounded border p-2" />
        </label>
        <label className="block text-sm">
          摘要
          <textarea name="summary" defaultValue={article.summary ?? ""} rows={4} className="mt-1 w-full rounded border p-2" />
        </label>
        <label className="block text-sm">
          封面 URL
          <input
            name="coverUrl"
            defaultValue={String(meta.coverUrl ?? "")}
            placeholder="https://…"
            className="mt-1 w-full rounded border p-2"
          />
        </label>
        <label className="block text-sm">
          正文 HTML
          <textarea
            name="body"
            defaultValue={article.body}
            required
            rows={16}
            className="mt-1 w-full rounded border p-2 font-mono text-xs"
            onChange={(event) => setPreview(event.target.value)}
          />
        </label>
        <label className="block text-sm">
          SEO 标题
          <input name="metaTitle" defaultValue={String(meta.metaTitle ?? "")} className="mt-1 w-full rounded border p-2" />
        </label>
        <label className="block text-sm">
          SEO 描述
          <textarea name="metaDescription" defaultValue={String(meta.metaDescription ?? "")} rows={3} className="mt-1 w-full rounded border p-2" />
        </label>
        <label className="block text-sm">
          SEO 关键词
          <input name="metaKeywords" defaultValue={String(meta.metaKeywords ?? "")} className="mt-1 w-full rounded border p-2" />
        </label>
        <div className="block text-sm" role="radiogroup" aria-label="SEO 可见性">
          <span className="mb-1 block">SEO 可见性</span>
          <div className="flex flex-wrap gap-2">
            {ARTICLE_SEO_VISIBILITY_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={seoVisibility === option.value}
                data-testid={`article-blog-seo-visibility-option-${option.value}`}
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
        <p className="text-xs text-gray-500" data-testid="article-blog-editor-type-line">
          类型: {ARTICLE_TYPE_LABELS[article.articleType as ArticleType] ?? article.articleType} · 内容模式:{" "}
          {ARTICLE_CONTENT_MODE_LABELS[article.contentMode as ArticleContentMode] ?? article.contentMode}
        </p>
        <p className="text-xs text-gray-500">
          slug: {article.slug} · shortId: {article.publicPageShortId}
        </p>
        {message && <p role="status" className="text-sm">{message}</p>}
        <button disabled={!canWrite} className={buttonClassName("primary")}>保存</button>
      </form>
      <section className="rounded-xl border bg-white p-5">
        <h2 className="mb-4 font-semibold">正文预览</h2>
        <div className="prose max-w-none" dangerouslySetInnerHTML={{ __html: preview }} />
      </section>
    </div>
  );
}
