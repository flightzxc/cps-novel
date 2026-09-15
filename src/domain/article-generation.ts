export const ARTICLE_GENERATE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type NovelGeneratePromoOutcome =
  | "ready"
  | "promo_link_missing"
  | "promo_link_not_ready"
  | "promo_link_deleted";

export type ArticleGenerateBlockedReason =
  | "novel_not_found"
  | "novel_deleted"
  | "already_exists"
  | "article_soft_deleted"
  | Exclude<NovelGeneratePromoOutcome, "ready">;

export type NovelGenerateCandidate = {
  readonly novelId: string;
  readonly title: string;
  readonly locale: string;
  readonly businessId: string;
  readonly hasLiveArticle: boolean;
  readonly promoReady: boolean;
  readonly promoOutcome: NovelGeneratePromoOutcome;
  readonly canGenerateArticle: boolean;
  readonly generateBlockedReason?: ArticleGenerateBlockedReason;
};

export function articleGenerateBlockedReasonLabel(reason: ArticleGenerateBlockedReason): string {
  const labels: Readonly<Record<ArticleGenerateBlockedReason, string>> = {
    novel_not_found: "书目不存在",
    novel_deleted: "书目已删除",
    already_exists: "已有 Article",
    article_soft_deleted: "已有已删除的 Article，需先处理历史记录",
    promo_link_missing: "缺少推广链接",
    promo_link_not_ready: "推广链接未就绪",
    promo_link_deleted: "推广链接已删除/无有效推广链接",
  };
  return labels[reason];
}

export type ArticleGenerateFilter = Readonly<{
  search?: string;
  locales?: readonly string[];
}>;

export type ArticleGenerateSelection =
  | Readonly<{ scope: "explicit_ids"; novelIds: readonly string[] }>
  | Readonly<{ scope: "all_filtered"; filter: ArticleGenerateFilter }>;

/**
 * Batch-create-operator-ux (locale chips): widened from a single `locale`
 * to `locales` (OR-matched — `novelWhere`'s `{ locale: { in: [...] } }`).
 * `locales` is present only when non-empty — blank/empty array means "key
 * absent", the same convention `search` already used. Sorted + deduped by
 * `normalizeArticleGenerateFilter` so the `JSON.stringify`-based
 * `inputFingerprint`/`articleGenerateParentScopeHash`
 * (`src/lib/tasks/article-generate.ts`) stays stable regardless of chip
 * click order — unstable ordering here would fingerprint the same logical
 * filter two different ways and break idempotency replay detection.
 */
export type NormalizedArticleGenerateFilter = Readonly<{
  search?: string;
  locales?: readonly string[];
}>;

/** Per-entry length cap — matches `Novel.locale @db.VarChar(16)`. */
const ARTICLE_GENERATE_FILTER_LOCALE_MAX_LENGTH = 16;
/**
 * Sensible upper bound on how many locale chips one filter can carry — well
 * above the ~14 locales any real dataset has today (`SITE_LOCALES` itself
 * is 15 members), just enough headroom to reject an abusive payload
 * cheaply before doing any per-entry work.
 */
const ARTICLE_GENERATE_FILTER_LOCALES_MAX_COUNT = 50;

export type NormalizedArticleGenerateSelection =
  | Readonly<{ scope: "explicit_ids"; novelIds: readonly string[] }>
  | Readonly<{ scope: "all_filtered"; filter: NormalizedArticleGenerateFilter }>;

export class ArticleGenerateSelectionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ArticleGenerateSelectionError";
  }
}

export type NovelGeneratePage = Readonly<{
  rows: readonly NovelGenerateCandidate[];
  total: number;
  page: number;
  pageSize: number;
  /**
   * Count of novels matching the current search/locales filter that CAN be
   * generated (no live Article and a ready PromoLink) — independent of
   * `total`/`rows`, which follow whichever view (default-hide vs. the
   * "显示不可生成" toggle) the caller asked `listNovelsForArticleGenerate`
   * for. `0` when the caller didn't ask for `eligibleOnly` filtering at all
   * (e.g. the single-novel "单篇创建文章" page).
   */
  generatableCount: number;
  /**
   * Count of novels matching the current search/locales filter that have no
   * live Article but are NOT promo-ready — the "不可生成" bucket. Same
   * `eligibleOnly`-only caveat as {@link generatableCount}.
   */
  nonGeneratableCount: number;
  /**
   * Per-locale candidate counts for the current `search` + view (promo
   * toggle), deliberately computed WITHOUT the `locales` filter itself —
   * this is the population the locale chip group offers the operator to
   * pick FROM, not a readout of the currently-selected chips. Computed via
   * `db.novel.groupBy` (never a materialised id list). `[]` under the same
   * `eligibleOnly`-only caveat as {@link generatableCount} — the
   * single-novel "单篇创建文章" page has no chip UI and doesn't ask for it.
   */
  localeCounts: readonly Readonly<{ locale: string; count: number }>[];
}>;

export type ArticleTemplateOption = Readonly<{
  templateKey: string;
  locale: string;
  version: number;
}>;

export type PinnedNovelResult =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "deleted" }>
  | Readonly<{ status: "found"; novel: NovelGenerateCandidate }>;

export function normalizeArticleGenerateFilter(
  filter: ArticleGenerateFilter | undefined,
): NormalizedArticleGenerateFilter {
  if (filter !== undefined && (typeof filter !== "object" || filter === null || Array.isArray(filter))) {
    throw new ArticleGenerateSelectionError("filter_invalid");
  }
  const raw = filter ?? {};
  if (raw.search !== undefined && typeof raw.search !== "string") {
    throw new ArticleGenerateSelectionError("filter_search_invalid");
  }
  if (
    raw.locales !== undefined
    && (!Array.isArray(raw.locales) || raw.locales.some((value) => typeof value !== "string"))
  ) {
    throw new ArticleGenerateSelectionError("filter_locales_invalid");
  }
  const search = raw.search?.trim() ?? "";
  if (search.length > 200) throw new ArticleGenerateSelectionError("filter_search_too_long");

  const rawLocales = raw.locales ?? [];
  if (rawLocales.length > ARTICLE_GENERATE_FILTER_LOCALES_MAX_COUNT) {
    throw new ArticleGenerateSelectionError("filter_locales_too_many");
  }
  const trimmedLocales = rawLocales.map((value) => value.trim());
  if (trimmedLocales.some((value) => value.length > ARTICLE_GENERATE_FILTER_LOCALE_MAX_LENGTH)) {
    throw new ArticleGenerateSelectionError("filter_locale_too_long");
  }
  // Dedupe + sort: the fingerprint downstream is a `JSON.stringify` hash,
  // so a stable, order-independent representation is required for replay
  // detection to recognise the same logical filter regardless of chip
  // click order.
  const locales = Array.from(new Set(trimmedLocales.filter((value) => value.length > 0))).sort();

  return Object.freeze({
    ...(search ? { search } : {}),
    ...(locales.length > 0 ? { locales: Object.freeze(locales) } : {}),
  });
}

export function normalizeArticleGenerateSelection(
  selection: ArticleGenerateSelection,
): NormalizedArticleGenerateSelection {
  if (!selection || typeof selection !== "object") {
    throw new ArticleGenerateSelectionError("selection_required");
  }
  if (selection.scope === "explicit_ids") {
    if (!Array.isArray(selection.novelIds) || selection.novelIds.some((id) => typeof id !== "string")) {
      throw new ArticleGenerateSelectionError("novel_ids_invalid");
    }
    const novelIds = Array.from(new Set(selection.novelIds.map((id) => id.trim().toLowerCase()))).sort();
    if (novelIds.length === 0) throw new ArticleGenerateSelectionError("novel_ids_required");
    if (novelIds.length > 200) throw new ArticleGenerateSelectionError("novel_ids_too_many");
    if (novelIds.some((id) => !ARTICLE_GENERATE_UUID.test(id))) {
      throw new ArticleGenerateSelectionError("novel_id_invalid");
    }
    return Object.freeze({ scope: "explicit_ids", novelIds: Object.freeze(novelIds) });
  }
  if (selection.scope !== "all_filtered") {
    throw new ArticleGenerateSelectionError("selection_scope_invalid");
  }
  return Object.freeze({
    scope: "all_filtered",
    filter: normalizeArticleGenerateFilter(selection.filter),
  });
}
