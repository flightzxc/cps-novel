"use client";

import Link from "next/link";
import type { FormEvent } from "react";

export type MappingFilterValues = {
  readonly search?: string;
  readonly active?: string;
  readonly rawLanguageScope?: string;
  readonly rawToken?: string;
  /** Set only when the page was reached via `/tags/canonical?...` with a target in mind. */
  readonly canonicalTagId?: string;
};

/**
 * Three-state status filter, same discipline as `TagFilters`' `activity` and
 * `CanonicalTagFilters`' `active`: `"all"` is both the kernel's own default
 * (`normalizeSourceLabelMappingGet` → `normalizePage` falls back to `"all"`
 * when the query string carries no `active`) and this `<select>`'s default,
 * so there is exactly one place that default lives, not two that could drift
 * apart. Values are never the empty string — see the blank-value note below.
 */
const ACTIVE_OPTIONS: readonly { readonly value: "all" | "active" | "inactive"; readonly label: string }[] =
  Object.freeze([
    { value: "all", label: "全部" },
    { value: "active", label: "生效中" },
    { value: "inactive", label: "已停用" },
  ]);

/**
 * Builds the "清除" href by re-serialising the *other* filter values this
 * component already has, minus `canonicalTagId` — same technique as
 * `NovelFilters`' `clearLabelHref`: it does not read the live
 * `URLSearchParams`, so a filter this component has never heard of cannot
 * leak into or out of the clear link.
 */
function clearCanonicalTagHref(values: MappingFilterValues): string {
  const next = new URLSearchParams();
  if (values.search) next.set("search", values.search);
  if (values.active) next.set("active", values.active);
  if (values.rawLanguageScope) next.set("rawLanguageScope", values.rawLanguageScope);
  if (values.rawToken) next.set("rawToken", values.rawToken);
  const query = next.toString();
  return query ? `/tags/mappings?${query}` : "/tags/mappings";
}

/**
 * A native `<form method="GET">` always submits a present-but-empty value
 * for a text field the operator left blank (`rawLanguageScope=`), not an
 * absent one. The server treats "absent" and "present-but-empty" very
 * differently for these two fields specifically: `optionalExact` in
 * `admin-service.ts` accepts *undefined* (no filter) but rejects an empty
 * *string* with `invalid_tag_request`, because an operator who actually
 * wants to match an empty raw token would have to say so some other way —
 * this page never lets them, since `approve_edge` itself rejects an empty
 * `rawToken`/`rawLanguageScope` at creation time.
 *
 * A disabled form control is excluded from submission entirely (HTML forms
 * spec), so disabling an emptied field right before the browser serialises
 * the query string removes it from the URL instead of sending `key=`. This
 * only touches the field the user is about to navigate away from — a plain
 * GET form is a full navigation, not client state, so there is nothing left
 * to re-enable afterwards.
 */
function omitBlankExactFields(event: FormEvent<HTMLFormElement>): void {
  const form = event.currentTarget;
  for (const name of ["rawLanguageScope", "rawToken"]) {
    const field = form.elements.namedItem(name);
    if (field instanceof HTMLInputElement && field.value === "") field.disabled = true;
  }
}

/**
 * Filter bar for `/tags/mappings`. `search` is one fuzzy/trimmed group;
 * `rawLanguageScope` + `rawToken` are a visually separate exact-match group,
 * so an operator cannot mistake padding a token into the fuzzy box for
 * "searched and it's not there" — the exact box is the only one that can
 * ever answer that question, and it is labelled as such.
 */
export function MappingFilters({ values }: { values: MappingFilterValues }) {
  return (
    <div className="space-y-3">
      {values.canonicalTagId && (
        <div
          className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-800"
          data-testid="mapping-canonical-filter-banner"
        >
          已按目标 Canonical Tag 筛选
          <span className="mx-1.5 text-blue-300">·</span>
          <Link
            href={clearCanonicalTagHref(values)}
            className="font-medium underline-offset-2 hover:underline"
            data-testid="mapping-canonical-filter-clear"
          >
            清除
          </Link>
        </div>
      )}
      <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <form method="GET" role="search" className="space-y-3" onSubmit={omitBlankExactFields}>
          {values.canonicalTagId && (
            <input type="hidden" name="canonicalTagId" value={values.canonicalTagId} />
          )}
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-[220px] flex-1">
              <input
                type="text"
                name="search"
                defaultValue={values.search ?? ""}
                aria-label="模糊搜索"
                placeholder="模糊搜索：渠道 App / canonical tag / rawToken…"
                className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <p className="mt-1 text-xs text-gray-400">模糊匹配，服务端会去除首尾空格再比较</p>
            </div>
            <select
              name="active"
              defaultValue={values.active ?? "all"}
              aria-label="映射状态"
              className="rounded-lg border border-gray-300 py-2 pl-3 pr-8 text-sm focus:border-blue-500 focus:outline-none"
            >
              {ACTIVE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
            >
              搜索
            </button>
          </div>
          <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-3">
            <p className="mb-2 text-xs font-medium text-gray-500">
              精确匹配（原始字节比较，不裁剪空格、不做大小写归一化）
            </p>
            <div className="flex flex-wrap gap-3">
              <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-xs text-gray-500">
                语言范围 rawLanguageScope
                <input
                  type="text"
                  name="rawLanguageScope"
                  defaultValue={values.rawLanguageScope ?? ""}
                  aria-label="语言范围（精确匹配）"
                  className="rounded-lg border border-gray-300 px-3 py-1.5 font-mono text-sm focus:border-blue-500 focus:outline-none"
                />
              </label>
              <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-xs text-gray-500">
                Raw Token
                <input
                  type="text"
                  name="rawToken"
                  defaultValue={values.rawToken ?? ""}
                  aria-label="Raw Token（精确匹配）"
                  className="rounded-lg border border-gray-300 px-3 py-1.5 font-mono text-sm focus:border-blue-500 focus:outline-none"
                />
              </label>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
