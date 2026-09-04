import { ARTICLE_STATUSES, type ArticleStatus } from "@/domain/database-statuses";
import { SITE_LOCALES } from "@/lib/locale/locale-canonical";

export type ArticleFilterValues = {
  readonly locale?: string;
  readonly status?: string;
  readonly novelId?: string;
  readonly templateId?: string;
};

/**
 * Chinese labels for the four `Article.status` values (M7). Same wording as
 * `@/features/admin-ui/content-view`'s `NOVEL_STATUS_BADGES` for the three
 * names the two lifecycles share (`draft`/`published`/`unpublished`/
 * `takedown`) — not re-imported, because that module sits outside this
 * lane's file boundary and Article has no `ready` state to carry a badge
 * color scheme for.
 */
const ARTICLE_STATUS_LABELS: Readonly<Record<ArticleStatus, string>> = Object.freeze({
  draft: "草稿",
  published: "已发布",
  unpublished: "已下线",
  takedown: "已撤回",
});

/**
 * M7 filter bar. Same `method="GET"`, field-name-is-the-query-param shape as
 * `../../novels/_components/novel-filters.tsx`: a shareable, back-button-safe
 * URL with no client state. `page` is deliberately not a field — submitting a
 * new filter resets to page 1, the same reasoning as the novel list.
 *
 * `novelId`/`templateId` are plain text inputs rather than pickers: both are
 * opaque UUIDs an operator reaches this page already holding (e.g. copied
 * from a novel's detail URL or a template's admin id), not values chosen from
 * a list rendered on this screen.
 */
export function ArticleFilters({ values }: { values: ArticleFilterValues }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <form method="GET" className="flex flex-wrap items-end gap-3" role="search">
        <label className="text-sm">
          <span className="mb-1 block text-gray-600">语种</span>
          <select
            name="locale"
            defaultValue={values.locale ?? ""}
            aria-label="语种"
            className="rounded-lg border border-gray-300 py-2 pl-3 pr-8 text-sm focus:border-blue-500 focus:outline-none"
          >
            <option value="">全部语种</option>
            {SITE_LOCALES.map((locale) => (
              <option key={locale} value={locale}>
                {locale}
              </option>
            ))}
          </select>
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
                {ARTICLE_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-[220px] flex-1 text-sm">
          <span className="mb-1 block text-gray-600">书目 ID</span>
          <input
            type="text"
            name="novelId"
            defaultValue={values.novelId ?? ""}
            aria-label="书目 ID"
            placeholder="novelId (UUID)"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </label>
        <label className="min-w-[220px] flex-1 text-sm">
          <span className="mb-1 block text-gray-600">模板 ID</span>
          <input
            type="text"
            name="templateId"
            defaultValue={values.templateId ?? ""}
            aria-label="模板 ID"
            placeholder="templateId (UUID)"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </label>
        <button
          type="submit"
          className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
        >
          筛选
        </button>
      </form>
    </div>
  );
}
