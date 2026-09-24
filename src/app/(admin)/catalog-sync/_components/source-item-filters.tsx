"use client";

import { useRouter } from "next/navigation";
import { NOVEL_SOURCE_ITEM_STATUSES } from "@/domain/database-statuses";
import { NOVEL_SOURCE_ITEM_STATUS_BADGES } from "@/features/admin-ui/content-view";
import { MOBOREADER_LANGUAGE_CODE_TO_LOCALE, UNKNOWN_SOURCE_LOCALE_FILTER } from "@/lib/locale/channel-language";
import { SITE_LOCALE_LABELS, type SiteLocale } from "@/lib/locale/locale-canonical";

export type SourceItemFilterValues = {
  readonly search?: string;
  readonly status?: string;
  readonly sourceLocale?: string;
  readonly promoLinkStatus?: string;
  readonly pageSize?: string;
};

/**
 * B-4：与"来源条目状态"/"来源语种"取交集的独立筛选，值集固定为
 * `PROMO_LINK_STATUS_FILTER_VALUES`（`@/domain/catalog-batch`）——不像
 * 语种筛选那样开放任意字符串,这里的三个值都对应服务端一次性算好的有界 ID
 * 集合,新增第四个值需要同时改服务端判定,所以就地列出而不是从别处派生。
 */
const PROMO_LINK_STATUS_FILTER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "not_claimed", label: "未领取" },
  { value: "claimed", label: "已领取" },
  { value: "manual_review", label: "人工核对中" },
];

/**
 * L10N P1 §1.E: one option per resolvable moboreader locale (18 codes, see
 * `docs/governance/L10N_UPSTREAM_LANGUAGE_EVIDENCE_2026-09-10.md`), deduped
 * to distinct locale values and sorted for a stable render order. Uses
 * `SITE_LOCALE_LABELS` where the locale is a registered site locale; the 4
 * non-site locales (`it`/`fil`/`ms`/`tr`) fall back to the bare code, same
 * as `catalog-sync-client.tsx`'s existing `sourceLocale ?? "未识别"` display
 * convention for anything this table doesn't have a nicer label for.
 */
const SOURCE_LOCALE_FILTER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = Array.from(
  new Set(Object.values(MOBOREADER_LANGUAGE_CODE_TO_LOCALE)),
)
  .sort()
  .map((locale) => ({
    value: locale,
    label: SITE_LOCALE_LABELS[locale as SiteLocale] ?? locale,
  }));

/**
 * Plain `method="GET"` filter bar — `src/app/(admin)/novels/_components/
 * novel-filters.tsx`'s pattern verbatim: field names are the query params, so
 * the filtered URL is shareable and back/forward work with no client state.
 * `page` is not a field for the same reason novel-filters drops it: a new
 * filter invalidates whatever page number was showing.
 */
export function SourceItemFilters({ values }: { values: SourceItemFilterValues }) {
  const router = useRouter();
  const formKey = JSON.stringify(values);
  function submit(form: HTMLFormElement) {
    const params = new URLSearchParams(Array.from(new FormData(form).entries()).map(([key, value]) => [key, String(value)]));
    params.delete("page");
    router.push(`/catalog-sync?${params.toString()}`);
  }
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <form key={formKey} onSubmit={(event) => { event.preventDefault(); submit(event.currentTarget); }} className="flex flex-wrap items-center gap-3" role="search">
        <div className="relative min-w-[200px] flex-1">
          <input
            type="text"
            name="search"
            defaultValue={values.search ?? ""}
            aria-label="搜索标题"
            placeholder="搜索来源条目标题…"
            className="w-full rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-500"
          />
        </div>
        <select
          name="status"
          defaultValue={values.status ?? "pending"}
          aria-label="来源条目状态"
          className="rounded-lg border border-gray-300 bg-white py-2 pl-3 pr-8 text-sm text-gray-900 focus:border-blue-500 focus:outline-none disabled:bg-gray-100 disabled:text-gray-500"
        >
          {NOVEL_SOURCE_ITEM_STATUSES.map((status) => (
            <option key={status} value={status}>
              {NOVEL_SOURCE_ITEM_STATUS_BADGES[status].label}
            </option>
          ))}
        </select>
        <select
          name="sourceLocale"
          defaultValue={values.sourceLocale ?? ""}
          aria-label="来源语种"
          className="rounded-lg border border-gray-300 bg-white py-2 pl-3 pr-8 text-sm text-gray-900 focus:border-blue-500 focus:outline-none disabled:bg-gray-100 disabled:text-gray-500"
        >
          <option value="">全部语种</option>
          {SOURCE_LOCALE_FILTER_OPTIONS.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
          <option value={UNKNOWN_SOURCE_LOCALE_FILTER}>未知语种</option>
        </select>
        <select
          name="promoLinkStatus"
          defaultValue={values.promoLinkStatus ?? ""}
          aria-label="推广链接状态"
          className="rounded-lg border border-gray-300 bg-white py-2 pl-3 pr-8 text-sm text-gray-900 focus:border-blue-500 focus:outline-none disabled:bg-gray-100 disabled:text-gray-500"
        >
          <option value="">全部</option>
          {PROMO_LINK_STATUS_FILTER_OPTIONS.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
        <select
          name="pageSize"
          defaultValue={values.pageSize ?? "100"}
          aria-label="每页条数"
          onChange={(event) => {
            const params = new URLSearchParams(window.location.search);
            params.set("pageSize", event.currentTarget.value);
            params.delete("page");
            router.push(`/catalog-sync?${params.toString()}`);
          }}
          className="rounded-lg border border-gray-300 bg-white py-2 pl-3 pr-8 text-sm text-gray-900 focus:border-blue-500 focus:outline-none disabled:bg-gray-100 disabled:text-gray-500"
        >
          <option value="50">每页 50 条</option>
          <option value="100">每页 100 条</option>
          <option value="200">每页 200 条</option>
        </select>
        <button
          type="submit"
          className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-900 hover:bg-gray-200 disabled:bg-gray-200 disabled:text-gray-500"
        >
          搜索
        </button>
      </form>
    </div>
  );
}
