"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { buttonClassName } from "@/components/ui/button";
import type { ArticleSeoVisibility } from "@/domain/database-statuses";
import { ARTICLE_SEO_VISIBILITY_OPTIONS } from "@/features/admin-ui/content-view";
import { SITE_LOCALES, SITE_LOCALE_LABELS, type SiteLocale } from "@/lib/locale/locale-canonical";
import { textToSlug } from "@/lib/slug/text-to-slug";

import { createBlogArticleAction } from "../../_actions";

/**
 * C-28 field set, CPS `ArticleBlogCreateForm` ADAPTed
 * (`cps-admin-v851-admin-host`'s `article-blog-create-form.tsx`): 语种下拉、
 * 标题、自定义地址（+ "从标题生成"）、封面 URL、SEO 三件套（+ "从文章标题
 * 填充"）、富文本正文 — same information structure. **Deliberately dropped**
 * versus CPS, per the plan's own "去掉 CPS 有而海阅无的三项": 博客分类下拉
 * (cps-novel's taxonomy is a Canonical Tag hung off a *Novel*; a blog Article
 * has no Novel to hang one off, and this repo has no per-Article category
 * relation to add — a genuine schema gap, not a UI oversight, and adding one
 * is its own future工单), 标签多选 (same "hangs off a Novel" reason, this
 * repo's tagging system is a Novel-side Canonical Tag mapping, not a
 * per-Article free-tag join table CPS has), 状态与发布时间选择器 (creation is
 * unconditionally `draft` — see `src/server/content-creation/blog.ts`'s
 * header on why the creation service itself refuses to accept any other
 * value; the "已发布" path is the publish gate, one extra click away, not a
 * checkbox on this form).
 *
 * Slug generation deliberately reuses this project's own canonical
 * `textToSlug` (`@/lib/slug/text-to-slug`) rather than CPS's client-only
 * regex twin (`toClientSlug`) — both are pure, dependency-free, and safe to
 * import into a client component (no `server-only` marker, no Node builtin
 * anywhere in that module's own import graph), and using the *real*
 * server-side slug algorithm for the live preview means what the operator
 * sees here is guaranteed byte-identical to what the server will accept,
 * rather than two independently-maintained slugifiers that could drift.
 */
export function BlogCreateForm() {
  const router = useRouter();
  const [locale, setLocale] = useState<SiteLocale>("en");
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [coverUrl, setCoverUrl] = useState("");
  const [body, setBody] = useState("");
  const [seoVisibility, setSeoVisibility] = useState<ArticleSeoVisibility>("public");
  const [metaTitle, setMetaTitle] = useState("");
  const [metaDescription, setMetaDescription] = useState("");
  const [metaKeywords, setMetaKeywords] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function handleTitleChange(value: string) {
    setTitle(value);
    if (!slugTouched) setSlug(textToSlug(value, locale));
  }

  function validate(): string | null {
    if (!title.trim()) return "标题不能为空";
    if (!slug.trim()) return "Slug 不能为空";
    if (!body.trim()) return "正文内容不能为空";
    return null;
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const result = await createBlogArticleAction({
        requestId: crypto.randomUUID(),
        locale,
        title: title.trim(),
        slug: slug.trim(),
        body,
        seoVisibility,
        metaTitle: metaTitle.trim() || undefined,
        metaDescription: metaDescription.trim() || undefined,
        metaKeywords: metaKeywords.trim() || undefined,
        coverUrl: coverUrl.trim() || undefined,
      });
      if (!result.ok) {
        setError(describeBlogCreateErrorCode(result.code));
        return;
      }
      switch (result.data.outcome) {
        case "created":
          router.push(`/articles/${result.data.articleId}`);
          return;
        case "feature_disabled":
          setError("新建博客功能当前未开启");
          return;
        case "write_disabled":
          setError("新建博客写入当前未获授权");
          return;
        case "slug_conflict":
          setError("该语种下这个地址已被占用，请更换 Slug 后重试");
          return;
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-6">
      {error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="rounded-xl border border-blue-200 bg-blue-50 p-5 text-sm text-blue-900">
        本入口固定创建博客文章，不需要选择书目或模板。
      </div>

      <div className="space-y-5 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="border-b border-gray-200 pb-3 text-lg font-semibold text-gray-900">基础信息</h2>

        <label className="block text-sm">
          语种
          <select
            value={locale}
            onChange={(event) => setLocale(event.target.value as SiteLocale)}
            data-testid="blog-create-locale"
            className="mt-1 w-full rounded border border-gray-300 p-2"
          >
            {SITE_LOCALES.map((item) => (
              <option key={item} value={item}>
                {SITE_LOCALE_LABELS[item]}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm">
          文章标题
          <input
            value={title}
            onChange={(event) => handleTitleChange(event.target.value)}
            required
            data-testid="blog-create-title"
            className="mt-1 w-full rounded border border-gray-300 p-2"
          />
        </label>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">自定义地址 Slug</span>
            <button
              type="button"
              onClick={() => {
                setSlug(textToSlug(title, locale));
                setSlugTouched(true);
              }}
              className="text-xs font-medium text-blue-600 hover:text-blue-800"
            >
              从标题生成
            </button>
          </div>
          <input
            value={slug}
            onChange={(event) => {
              setSlugTouched(true);
              setSlug(event.target.value);
            }}
            required
            data-testid="blog-create-slug"
            className="w-full rounded border border-gray-300 p-2 font-mono text-xs"
          />
          <p className="mt-1 text-xs text-gray-400">保存时按语种 + Slug 校验唯一性，撞了不会自动改名，需手动更换。</p>
        </div>
      </div>

      <label className="block rounded-xl border border-gray-200 bg-white p-6 text-sm shadow-sm">
        封面 URL（可选）
        <input
          value={coverUrl}
          onChange={(event) => setCoverUrl(event.target.value)}
          placeholder="https://…"
          data-testid="blog-create-cover-url"
          className="mt-1 w-full rounded border border-gray-300 p-2"
        />
      </label>

      <div className="space-y-5 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="border-b border-gray-200 pb-3 text-lg font-semibold text-gray-900">SEO 信息</h2>
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">SEO 标题</span>
            <button
              type="button"
              onClick={() => setMetaTitle(title)}
              className="text-xs font-medium text-blue-600 hover:text-blue-800"
            >
              从文章标题填充
            </button>
          </div>
          <input
            value={metaTitle}
            onChange={(event) => setMetaTitle(event.target.value)}
            className="w-full rounded border border-gray-300 p-2"
          />
        </div>
        <label className="block text-sm">
          SEO 描述
          <textarea
            value={metaDescription}
            onChange={(event) => setMetaDescription(event.target.value)}
            rows={3}
            className="mt-1 w-full rounded border border-gray-300 p-2"
          />
        </label>
        <label className="block text-sm">
          SEO 关键词
          <input
            value={metaKeywords}
            onChange={(event) => setMetaKeywords(event.target.value)}
            className="mt-1 w-full rounded border border-gray-300 p-2"
          />
        </label>
        <div role="radiogroup" aria-label="SEO 可见性" className="block text-sm">
          <span className="mb-1 block">SEO 可见性</span>
          <div className="flex flex-wrap gap-2">
            {ARTICLE_SEO_VISIBILITY_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={seoVisibility === option.value}
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
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 border-b border-gray-200 pb-3 text-lg font-semibold text-gray-900">正文内容</h2>
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          required
          rows={16}
          data-testid="blog-create-body"
          className="w-full rounded border border-gray-300 p-2 font-mono text-xs"
        />
      </div>

      <div className="flex justify-end gap-3">
        <button
          type="submit"
          disabled={submitting}
          data-testid="blog-create-submit"
          className={buttonClassName("primary")}
        >
          {submitting ? "保存中…" : "保存博客文章"}
        </button>
      </div>
    </form>
  );
}

/** Field-level input errors forwarded verbatim from `BlogArticleInputError` (`src/server/content-creation/blog.ts`) — every other code falls back to the raw string, same posture `../_actions.ts`'s `writeErrorCode` already takes for the rest of this admin. */
function describeBlogCreateErrorCode(code: string): string {
  switch (code) {
    case "invalid_locale":
      return "语种无效";
    case "invalid_title":
      return "标题不能为空，且不能超过 500 字";
    case "invalid_slug":
      return "Slug 无效：只能是小写字母、数字与连字符";
    case "invalid_body":
      return "正文内容不能为空";
    case "invalid_seo_visibility":
      return "SEO 可见性取值无效";
    default:
      return code;
  }
}
