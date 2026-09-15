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
  locale?: string;
}>;

export type ArticleGenerateSelection =
  | Readonly<{ scope: "explicit_ids"; novelIds: readonly string[] }>
  | Readonly<{ scope: "all_filtered"; filter: ArticleGenerateFilter }>;

export type NormalizedArticleGenerateFilter = Readonly<{
  search?: string;
  locale?: string;
}>;

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
  if (raw.locale !== undefined && typeof raw.locale !== "string") {
    throw new ArticleGenerateSelectionError("filter_locale_invalid");
  }
  const search = raw.search?.trim() ?? "";
  const locale = raw.locale?.trim() ?? "";
  if (search.length > 200) throw new ArticleGenerateSelectionError("filter_search_too_long");
  if (locale.length > 16) throw new ArticleGenerateSelectionError("filter_locale_too_long");
  return Object.freeze({
    ...(search ? { search } : {}),
    ...(locale ? { locale } : {}),
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
