"use client";

import { useEffect, useId, useRef, useState } from "react";

import type { AdminCanonicalTagListView, AdminCanonicalTagView } from "@/contracts";
import { adminFetch } from "@/features/admin-ui/admin-fetch";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_PAGE_SIZE = 50;

/**
 * `translations` where `locale === "zh"` is the only source for the option's
 * display name. If there is no `zh` row this returns `null` and the caller
 * renders "—" — never the slug, never another locale. Substituting either
 * would read to an operator as "this tag has a Chinese name," which is false
 * and exactly the compensating UI `tags-table.tsx:83-93` (and
 * `canonical-tags-client.tsx`'s own `zhDisplayName`) forbids for the same
 * reason on the two sibling screens.
 */
function zhDisplayName(tag: Pick<AdminCanonicalTagView, "translations">): string | null {
  return tag.translations.find((item) => item.locale === "zh")?.displayName ?? null;
}

/**
 * Search-driven replacement for a hand-typed `canonicalTagId` UUID.
 *
 * CPS parity: every admin form that ultimately submits a raw foreign-key id
 * resolves it through an on-demand search-and-select control instead of
 * asking the operator to paste one — `TagRuleForm`'s "关联 Tag" field is the
 * closest CPS precedent (300ms debounced `GET`, a prefetch so the operator
 * can pick without typing at all, a collapsed "已选：{slug}" summary once
 * something is chosen). One deliberate difference from that precedent: the
 * prefetch fires on first *open*, not on mount — see the effect's own doc
 * comment for why. The always-visible-list layout of the CPS precedent is
 * swapped here for a floating `role="listbox"` combobox — the
 * shape CPS's `SearchableFacetSelect` (`batch-drama-switch-v2-client.tsx`)
 * and `BlogDramaCtaDialog` use for exactly this "collapse to a summary chip
 * with a 重新选择 escape hatch" interaction — because this field sits inside a
 * two-column form grid where an always-open results list would visually
 * fight the neighbouring field.
 *
 * `GET /api/admin/canonical-tags` is already registered, guarded by
 * `content:view` (`admin.api.canonical_tag.read`) and returns
 * `AdminCanonicalTagListView` — no backend change was needed for this. Every
 * request here fixes `active=active`: an inactive canonical tag is not a
 * valid *new*-mapping target (the backend rejects it with 409
 * `inactive_canonical_tag`), so filtering it out of the picker up front is a
 * real constraint, not a cosmetic default. Filtering also means this
 * request is deliberately never combined with `id=` — the backend treats
 * `id` as mutually exclusive with every list filter and returns 400
 * `invalid_tag_request` if both are present in the same call
 * (`tagging-route.ts` `normalizeCanonicalTagGet`).
 */
export function CanonicalTagPicker({
  value,
  onChange,
  testId = "canonical-tag-picker",
}: {
  /** The committed `canonicalTagId` — `""` when nothing has been chosen yet. */
  value: string;
  onChange: (canonicalTagId: string) => void;
  testId?: string;
}) {
  const uid = useId();
  const labelId = `${uid}-label`;
  const listboxId = `${uid}-listbox`;

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<readonly AdminCanonicalTagView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Metadata cache for the committed `value`. Kept separate from `value`
  // itself because `value` can arrive from outside this component (the
  // create form's `prefillCanonicalTagId`, seeded from a hand-edited
  // `?canonicalTagId=` URL) with no matching option ever having been
  // fetched — see the render branch below for how that case is shown.
  const [selected, setSelected] = useState<AdminCanonicalTagView | null>(null);

  const isFirstRun = useRef(true);
  const requestSeqRef = useRef(0);

  async function runSearch(q: string) {
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ active: "active", pageSize: String(SEARCH_PAGE_SIZE) });
    const trimmed = q.trim();
    if (trimmed) params.set("search", trimmed);
    const result = await adminFetch<AdminCanonicalTagListView>(
      `/api/admin/canonical-tags?${params.toString()}`,
    );
    // A slower, now-superseded request must never clobber a faster later
    // one's result — otherwise the last keystroke could show results for an
    // earlier one.
    if (seq !== requestSeqRef.current) return;
    setLoading(false);
    if (!result.ok) {
      setError(errorEnvelopeCopy(result.envelope));
      setOptions([]);
      return;
    }
    setOptions(result.data.items);
  }

  /**
   * One effect covers both required behaviours: an immediate, un-debounced
   * fetch of the first page the first time the field is opened (so the
   * operator can open the list and click without typing anything first),
   * and a 300ms-debounced re-fetch every time `query` changes after that.
   * Coalescing them into a single `[open, query]`-keyed effect is what makes
   * rapid typing send exactly one request — each keystroke's effect run
   * clears the previous run's pending `setTimeout` before scheduling its
   * own.
   *
   * Gated on `open` rather than firing unconditionally on mount: this field
   * lives inside the "新增映射" form, which is on screen (and thus this
   * component is mounted) any time the operator has `tag:manage`, including
   * while they are only reapproving or deactivating an unrelated row. A
   * bare mount-fetch would send a background request nobody asked for on
   * every one of those screens — CPS's own `TagRuleForm` precedent can fire
   * on true mount because nothing else on its page shares a request budget
   * with it; this field does not have that luxury.
   */
  useEffect(() => {
    if (!open) return;
    if (isFirstRun.current) {
      isFirstRun.current = false;
      void runSearch(query);
      return;
    }
    const timer = setTimeout(() => {
      void runSearch(query);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, query]);

  // No effect resets `selected` when the create form clears `value` back to
  // `""` after a successful submission (`mappings-client.tsx`'s `run`) — none
  // is needed. `selected` is only ever *read* while `isSelected` (derived
  // from `value` below) is true, and the only way `selected` and `value` can
  // disagree about *which* tag is current is the URL-prefill case the render
  // branch below already accounts for explicitly. A stale `selected` left
  // over from a submitted mapping is simply never looked at again once
  // `value` goes back to `""`; the next `handleSelect` overwrites it before
  // anything reads it.
  function handleSelect(option: AdminCanonicalTagView) {
    setSelected(option);
    onChange(option.id);
    setOpen(false);
  }

  function handleReselect() {
    setSelected(null);
    onChange("");
    setQuery("");
    setOpen(true);
  }

  const isSelected = value !== "";

  return (
    <div className="flex flex-col gap-1 text-xs text-gray-500">
      <span id={labelId}>目标 Canonical Tag</span>
      {isSelected ? (
        <div
          className="flex items-center justify-between gap-2 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5"
          data-testid={`${testId}-selected`}
        >
          <span className="text-sm text-gray-700">
            已选：
            {selected ? (
              <>
                {zhDisplayName(selected) ?? <span className="text-gray-400">—</span>}
                <span className="mx-1 text-gray-300">·</span>
                <span className="font-mono">{selected.slug}</span>
              </>
            ) : (
              // `value` came from outside (URL prefill) and this component
              // has never fetched that id's metadata — see the doc comment
              // above. Saying so plainly is the honest option; guessing a
              // name (or falling back to the raw UUID the rest of this
              // control exists to stop showing) is exactly the compensating
              // UI this project forbids.
              <span className="text-gray-400">（来自 URL 预填，尚未加载展示名，可直接提交或重新选择）</span>
            )}
          </span>
          <button
            type="button"
            onClick={handleReselect}
            className="shrink-0 text-xs text-blue-600 hover:underline"
            data-testid={`${testId}-reselect`}
          >
            重新选择
          </button>
        </div>
      ) : (
        <div className="relative">
          <input
            aria-labelledby={labelId}
            role="combobox"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-autocomplete="list"
            data-testid={`${testId}-input`}
            autoComplete="off"
            value={query}
            placeholder="搜索 Canonical Tag：中文名 / slug / 定义"
            onFocus={() => setOpen(true)}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") setOpen(false);
            }}
            // A plain `onBlur → setOpen(false)` would close the list before
            // the option button's own `onClick` ever fires. The 120ms delay
            // plus each option's `onMouseDown` preventDefault below is the
            // same pairing CPS's `SearchableFacetSelect`
            // (`batch-drama-switch-v2-client.tsx`) uses to let the click win
            // the race.
            onBlur={() => {
              window.setTimeout(() => setOpen(false), 120);
            }}
            className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
          />
          {open && (
            <div
              id={listboxId}
              role="listbox"
              aria-busy={loading}
              data-testid={`${testId}-listbox`}
              className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg"
            >
              {error && (
                <p
                  role="alert"
                  className="border-b border-red-100 bg-red-50 px-3 py-2 text-xs text-red-600"
                >
                  {error}
                </p>
              )}
              {loading && options.length === 0 && !error && (
                <p className="px-3 py-2 text-xs text-gray-400">搜索中…</p>
              )}
              {!loading && options.length === 0 && !error && (
                <p className="px-3 py-2 text-xs text-gray-400">无匹配结果</p>
              )}
              {options.map((option) => {
                const zh = zhDisplayName(option);
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="option"
                    aria-selected={option.id === value}
                    data-testid={`${testId}-option-${option.id}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => handleSelect(option)}
                    className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-blue-50"
                  >
                    <span
                      data-testid={`${testId}-option-name-${option.id}`}
                      className="min-w-0 truncate text-gray-700"
                    >
                      {zh ?? <span className="text-gray-400">—</span>}
                    </span>
                    <span
                      data-testid={`${testId}-option-slug-${option.id}`}
                      className="shrink-0 font-mono text-xs text-gray-400"
                    >
                      {option.slug}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
