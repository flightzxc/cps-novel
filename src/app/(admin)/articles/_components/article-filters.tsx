import Link from "next/link";

import { ARTICLE_STATUSES } from "@/domain/database-statuses";
import { ARTICLE_STATUS_BADGES } from "@/features/admin-ui/content-view";

export type ArticleTemplateOption = Readonly<{
  id: string;
  templateKey: string;
  locale: string | null;
  version: number;
}>;

export type ArticleCategoryOption = Readonly<{ id: string; label: string }>;

export type ArticleFilterValues = {
  readonly search?: string;
  readonly locale?: string;
  readonly status?: string;
  readonly novelId?: string;
  readonly templateId?: string;
  readonly canonicalTagId?: string;
};

/**
 * Builds the "清除" href by re-serialising the *other* filter values this
 * component already has, minus `novelId`. Same discipline as
 * `../../novels/_components/novel-filters.tsx`'s `clearLabelHref`: it does
 * not read the live `URLSearchParams`, so a filter this component does not
 * know about cannot leak into or out of the clear link.
 */
function clearNovelHref(values: ArticleFilterValues): string {
  const next = new URLSearchParams();
  if (values.search) next.set("search", values.search);
  if (values.locale) next.set("locale", values.locale);
  if (values.status) next.set("status", values.status);
  if (values.templateId) next.set("templateId", values.templateId);
  if (values.canonicalTagId) next.set("canonicalTagId", values.canonicalTagId);
  const query = next.toString();
  return query ? `/articles?${query}` : "/articles";
}

/**
 * C-19 rewrite (`分析_文章管理Parity缺口_2026-09-08.md` §三/§六): replaces the
 * two raw-UUID text inputs (书目 ID / 模板 ID) this filter bar used to
 * require with three CPS-parity, zero-裸-UUID alternatives:
 *
 * - **搜索** — CPS's "搜索标题、slug、短码或 URL…" box, one text field, three
 *   `contains` conditions the service layer ORs together plus a shortId
 *   exact match when the pasted value parses as a front-end URL
 *   (`@/server/articles`'s `buildArticleSearchOr`).
 * - **模板** — a `<select>` sourced from `listActiveArticleTemplateOptions`
 *   (the same query `../../catalog-sync/page.tsx` already uses for its own
 *   template dropdown). The submitted *value* is still the template UUID —
 *   only the operator-facing input changed, not what travels to the server.
 * - **书目** — no picker (a novel picker over tens of thousands of rows would
 *   be the wrong UI). Same "跳转带入 + 提示条 + 清除" pattern as
 *   `../../novels/_components/novel-filters.tsx`'s `labelId` banner: this
 *   component never renders an input for it. `novelId` arrives already set
 *   via `?novelId=…` from a "查看该书目的文章" link elsewhere, rides through
 *   this form as a hidden field so submitting the other filters does not
 *   silently drop it, and is only ever removed via the banner's "清除" link.
 *
 * **分类** is new (CPS parity item #10, ADAPT): a `<select>` over active
 * Canonical Tags (`categoryOptions`, from `../_lib/category-options.ts`),
 * submitting `canonicalTagId` — the service layer resolves it as an EXISTS
 * over the article's novel's tag assignments, not a column on Article
 * itself (see the service's own comment on why).
 *
 * **语种** now lists only `locales` (distinct values actually present among
 * live articles), passed down from the page rather than the full 15-entry
 * `SITE_LOCALES` registry this file used to import directly (CPS parity
 * item #9, ADAPT).
 *
 * C-20 moved **状态**'s option labels from a map that used to live only in
 * this file (`ARTICLE_STATUS_LABELS`) to `@/features/admin-ui/content-view`'s
 * `ARTICLE_STATUS_BADGES`, the same source `article-status-badge.tsx`'s
 * table-column badge now reads — one shared spot for both, not two copies of
 * the same four Chinese strings (item #19).
 */
export function ArticleFilters({
  values,
  novelTitle,
  locales,
  categoryOptions,
  templateOptions,
}: {
  values: ArticleFilterValues;
  /** Resolved book title for the `novelId` banner; `null` when unresolved (bad/deleted id) or `novelId` is absent. */
  novelTitle?: string | null;
  locales: readonly string[];
  categoryOptions: readonly ArticleCategoryOption[];
  templateOptions: readonly ArticleTemplateOption[];
}) {
  return (
    <div className="space-y-3">
      {values.novelId && (
        <div
          className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-800"
          data-testid="article-novel-filter-banner"
        >
          已按书目筛选：《{novelTitle ?? values.novelId}》
          <span className="mx-1.5 text-blue-300">·</span>
          <Link
            href={clearNovelHref(values)}
            className="font-medium underline-offset-2 hover:underline"
            data-testid="article-novel-filter-clear"
          >
            清除
          </Link>
        </div>
      )}
      <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <form method="GET" className="flex flex-wrap items-end gap-3" role="search">
          {values.novelId && <input type="hidden" name="novelId" value={values.novelId} />}
          <label className="min-w-[240px] flex-1 text-sm">
            <span className="mb-1 block text-gray-600">搜索</span>
            <input
              type="text"
              name="search"
              defaultValue={values.search ?? ""}
              aria-label="搜索"
              placeholder="搜索标题、slug、短码或 URL…"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-gray-600">状态</span>
            <select
              name="status"
              defaultValue={values.status ?? ""}
              aria-label="状态"
              className="rounded-lg border border-gray-300 py-2 pl-3 pr-8 text-sm focus:border-blue-500 focus:outline-none"
            >
              <option value="">全部状态</option>
              {ARTICLE_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {ARTICLE_STATUS_BADGES[status].label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-gray-600">语种</span>
            <select
              name="locale"
              defaultValue={values.locale ?? ""}
              aria-label="语种"
              className="rounded-lg border border-gray-300 py-2 pl-3 pr-8 text-sm focus:border-blue-500 focus:outline-none"
            >
              <option value="">全部语种</option>
              {locales.map((locale) => (
                <option key={locale} value={locale}>
                  {locale}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-gray-600">分类</span>
            <select
              name="canonicalTagId"
              defaultValue={values.canonicalTagId ?? ""}
              aria-label="分类"
              className="rounded-lg border border-gray-300 py-2 pl-3 pr-8 text-sm focus:border-blue-500 focus:outline-none"
            >
              <option value="">全部分类</option>
              {categoryOptions.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-gray-600">模板</span>
            <select
              name="templateId"
              defaultValue={values.templateId ?? ""}
              aria-label="模板"
              className="rounded-lg border border-gray-300 py-2 pl-3 pr-8 text-sm focus:border-blue-500 focus:outline-none"
            >
              <option value="">全部模板</option>
              {templateOptions.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.templateKey} · v{template.version}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
          >
            筛选
          </button>
        </form>
      </div>
    </div>
  );
}
