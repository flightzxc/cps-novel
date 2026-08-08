import type {
  AdminChapterContent,
  AdminChapterDetail,
  AdminChapterListItem,
  AdminChapterSourceSummary,
  AdminContentExceptionCode,
  AdminContentPage,
  AdminContentSyncSummary,
  AdminNovelDetail,
  AdminNovelListItem,
  AdminNovelSourceSummary,
  AdminPreviewSummary,
} from "@/domain/admin-content";
import type { NovelChapterStatus, NovelStatus } from "@/domain/database-statuses";

/**
 * Admin content read surface (P2-04).
 *
 * The P2-04 backend kernel (`src/server/admin-content`) already returns
 * serialisable, ISO-8601 shapes — so the temptation is to hand its objects
 * straight to the browser. This module exists to refuse that.
 *
 * Every projection below takes the **domain type** as its input, so the compiler
 * fails the moment the kernel changes shape: this file cannot drift into a
 * parallel field set. What it does do is *subtract*. The kernel is an operations
 * kernel and legitimately carries commercial and provenance columns that the
 * content-management screens have no business rendering:
 *
 * | dropped here      | why |
 * | ----------------- | --- |
 * | `author`          | upstream site only; the distribution API does not supply it |
 * | `completionStatus`| same — not a design input this phase |
 * | `country`/`region`| same |
 * | `coverUrl`        | needs a host allowlist decision that is not in P2-04 |
 * | `paidFromChapter` | commercial, not content management |
 * | `splitRatio`      | commercial; banned outright from every rendered surface |
 * | `contentHash`     | truncated to 12 chars — a display fingerprint, not a key |
 *
 * Subtraction is done field-by-field, never by spreading a kernel object and
 * deleting keys: a column added upstream must be *added* here on purpose before
 * it can reach a browser, rather than arriving by default.
 *
 * There are no mutation shapes in this module, and none are to be added
 * speculatively — P2-04 is a read vertical slice.
 */

export type { AdminContentExceptionCode };

/** Page envelope. Mirrors {@link AdminContentPage} minus the item type. */
export type AdminContentPageView<T> = {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
};

export type AdminSyncTaskView = {
  readonly taskId: string;
  readonly taskType: string;
  readonly taskStatus: string;
  readonly itemStatus: string;
  readonly mode: string;
  readonly attemptCount: number;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly updatedAt: string;
};

export type AdminSyncSummaryView = {
  readonly sourceItemCount: number;
  readonly sourceAppCodes: readonly string[];
  readonly latestSourceUpdatedAt: string | null;
  readonly latestSeenAt: string | null;
  readonly latestTask: AdminSyncTaskView | null;
  readonly exceptions: readonly AdminContentExceptionCode[];
};

/**
 * Preview counts, with the policy's claim and the materialised reality kept
 * apart on purpose.
 *
 * `policyChapterCount` is what `novel_preview_policy` says was materialised;
 * `materializedChapterCount` is how many `novel_chapter_content` rows actually
 * exist. Collapsing them into one number would hide exactly the drift the
 * `preview_count_mismatch` exception exists to surface.
 */
export type AdminPreviewSummaryView = {
  readonly materializedChapterCount: number;
  readonly displayableChapterCount: number;
  readonly policyChapterCount: number | null;
  readonly policyCountMatchesActual: boolean | null;
};

export type AdminPreviewPolicyView = {
  readonly materializationPolicy: string;
  readonly materializedChapterCount: number;
  readonly displayAuthorized: boolean;
  readonly indexAuthorized: boolean;
  readonly cacheAuthorized: boolean;
  readonly maxMaterializedChapters: number;
  readonly lastRefreshedAt: string | null;
  readonly updatedAt: string;
};

export type AdminNovelListItemView = {
  readonly novelId: string;
  readonly businessId: string;
  readonly title: string;
  readonly slug: string;
  readonly locale: string;
  readonly status: NovelStatus;
  /** Upstream's declared chapter total. */
  readonly totalChapterCount: number;
  /** Rows actually present in `novel_chapter`. */
  readonly chapterRowCount: number;
  readonly preview: AdminPreviewSummaryView;
  readonly sync: AdminSyncSummaryView;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type AdminNovelSourceView = {
  readonly sourceItemId: string;
  readonly channelCode: string;
  readonly channelName: string;
  readonly sourceAppCode: string;
  readonly sourceAppName: string;
  readonly externalBookId: string;
  readonly sourceLanguageCode: string;
  readonly sourceLanguageName: string | null;
  readonly sourceLocale: string | null;
  readonly status: string;
  readonly sourceUpdatedAt: string | null;
  readonly lastSeenAt: string | null;
  readonly updatedAt: string;
};

export type AdminNovelDetailView = AdminNovelListItemView & {
  readonly description: string;
  readonly previewPolicy: AdminPreviewPolicyView | null;
  readonly sources: readonly AdminNovelSourceView[];
  readonly sourcesTruncated: boolean;
};

export type AdminChapterListItemView = {
  readonly chapterId: string;
  readonly novelId: string;
  readonly canonicalChapterNumber: number;
  readonly title: string | null;
  readonly status: NovelChapterStatus;
  /** Whether a `novel_chapter_content` row exists. The body itself is not here. */
  readonly hasContent: boolean;
  readonly charCount: number | null;
  readonly contentHashPrefix: string | null;
  readonly materializedAt: string | null;
  readonly sourceUpdatedAt: string | null;
  readonly sourceItemCount: number;
  readonly updatedAt: string;
};

export type AdminChapterSourceView = {
  readonly sourceId: string;
  readonly novelSourceItemId: string;
  readonly externalChapterId: string;
  readonly sourceChapterNumber: number | null;
  readonly chapterName: string | null;
  readonly chapterShowName: string | null;
  readonly status: string;
  readonly lastSeenAt: string | null;
  readonly sourceUpdatedAt: string | null;
};

export type AdminChapterDetailView = AdminChapterListItemView & {
  readonly novelBusinessId: string;
  readonly novelTitle: string;
  readonly sources: readonly AdminChapterSourceView[];
  readonly sourcesTruncated: boolean;
};

/**
 * The only shape that ever carries chapter prose.
 *
 * Deliberately not reachable from any list projection: the body is copyrighted
 * licensed content and every read of it is audited server-side, so it must be
 * requested one chapter at a time rather than arriving as a field on a page of
 * twenty.
 */
export type AdminChapterContentView = {
  readonly chapterId: string;
  readonly novelId: string;
  readonly canonicalChapterNumber: number;
  readonly chapterTitle: string | null;
  readonly status: NovelChapterStatus;
  readonly body: string;
  readonly charCount: number;
  readonly contentHashPrefix: string;
  readonly materializedAt: string;
  readonly updatedAt: string;
};

/** 12 chars: enough to compare two materialisations by eye, useless as a key. */
const HASH_PREFIX_LENGTH = 12;

function hashPrefix(value: string | null): string | null {
  return value === null ? null : value.slice(0, HASH_PREFIX_LENGTH);
}

function syncSummaryView(sync: AdminContentSyncSummary): AdminSyncSummaryView {
  return Object.freeze({
    sourceItemCount: sync.sourceItemCount,
    sourceAppCodes: Object.freeze([...sync.sourceAppCodes]),
    latestSourceUpdatedAt: sync.latestSourceUpdatedAt,
    latestSeenAt: sync.latestSeenAt,
    latestTask: sync.latest
      ? Object.freeze({
          taskId: sync.latest.taskId,
          taskType: sync.latest.taskType,
          taskStatus: sync.latest.taskStatus,
          itemStatus: sync.latest.itemStatus,
          mode: sync.latest.mode,
          attemptCount: sync.latest.attemptCount,
          requestedAt: sync.latest.requestedAt,
          startedAt: sync.latest.startedAt,
          finishedAt: sync.latest.finishedAt,
          updatedAt: sync.latest.updatedAt,
        })
      : null,
    exceptions: Object.freeze([...sync.exceptions]),
  });
}

function previewSummaryView(preview: AdminPreviewSummary): AdminPreviewSummaryView {
  return Object.freeze({
    materializedChapterCount: preview.actualMaterializedChapterCount,
    displayableChapterCount: preview.actualDisplayableChapterCount,
    policyChapterCount: preview.policy?.materializedChapterCount ?? null,
    policyCountMatchesActual: preview.policyCountMatchesActual,
  });
}

function previewPolicyView(preview: AdminPreviewSummary): AdminPreviewPolicyView | null {
  const policy = preview.policy;
  if (!policy) return null;
  return Object.freeze({
    materializationPolicy: policy.materializationPolicy,
    materializedChapterCount: policy.materializedChapterCount,
    displayAuthorized: policy.displayAuthorized,
    indexAuthorized: policy.indexAuthorized,
    cacheAuthorized: policy.cacheAuthorized,
    maxMaterializedChapters: policy.maxMaterializedChapters,
    lastRefreshedAt: policy.lastRefreshedAt,
    updatedAt: policy.updatedAt,
  });
}

export function projectAdminNovelListItem(novel: AdminNovelListItem): AdminNovelListItemView {
  return Object.freeze({
    novelId: novel.id,
    businessId: novel.businessId,
    title: novel.title,
    slug: novel.slug,
    locale: novel.locale,
    status: novel.status,
    totalChapterCount: novel.totalChapterCount,
    chapterRowCount: novel.actualChapterRowCount,
    preview: previewSummaryView(novel.preview),
    sync: syncSummaryView(novel.sync),
    createdAt: novel.createdAt,
    updatedAt: novel.updatedAt,
  });
}

function novelSourceView(source: AdminNovelSourceSummary): AdminNovelSourceView {
  return Object.freeze({
    sourceItemId: source.id,
    channelCode: source.channelCode,
    channelName: source.channelName,
    sourceAppCode: source.sourceAppCode,
    sourceAppName: source.sourceAppName,
    externalBookId: source.externalBookId,
    sourceLanguageCode: source.sourceLanguageCode,
    sourceLanguageName: source.sourceLanguageName,
    sourceLocale: source.sourceLocale,
    status: source.status,
    sourceUpdatedAt: source.sourceUpdatedAt,
    lastSeenAt: source.lastSeenAt,
    updatedAt: source.updatedAt,
  });
}

export function projectAdminNovelDetail(novel: AdminNovelDetail): AdminNovelDetailView {
  // `AdminNovelDetail` is a structural superset of the list item, so the shared
  // fields go through the *same* projection rather than a second hand-written
  // copy that could quietly disagree with the list.
  return Object.freeze({
    ...projectAdminNovelListItem(novel),
    description: novel.description,
    previewPolicy: previewPolicyView(novel.preview),
    sources: Object.freeze(novel.sources.map(novelSourceView)),
    sourcesTruncated: novel.sourcesTruncated,
  });
}

export function projectAdminChapterListItem(
  chapter: AdminChapterListItem,
): AdminChapterListItemView {
  return Object.freeze({
    chapterId: chapter.id,
    novelId: chapter.novelId,
    canonicalChapterNumber: chapter.canonicalChapterNumber,
    title: chapter.title,
    status: chapter.status,
    hasContent: chapter.hasContent,
    charCount: chapter.charCount,
    contentHashPrefix: hashPrefix(chapter.contentHashPrefix),
    materializedAt: chapter.materializedAt,
    sourceUpdatedAt: chapter.sourceUpdatedAt,
    sourceItemCount: chapter.sourceItemCount,
    updatedAt: chapter.updatedAt,
  });
}

function chapterSourceView(source: AdminChapterSourceSummary): AdminChapterSourceView {
  return Object.freeze({
    sourceId: source.id,
    novelSourceItemId: source.novelSourceItemId,
    externalChapterId: source.externalChapterId,
    sourceChapterNumber: source.sourceChapterNumber,
    chapterName: source.chapterName,
    chapterShowName: source.chapterShowName,
    status: source.status,
    lastSeenAt: source.lastSeenAt,
    sourceUpdatedAt: source.sourceUpdatedAt,
  });
}

export function projectAdminChapterDetail(chapter: AdminChapterDetail): AdminChapterDetailView {
  return Object.freeze({
    chapterId: chapter.id,
    novelId: chapter.novelId,
    novelBusinessId: chapter.novelBusinessId,
    novelTitle: chapter.novelTitle,
    canonicalChapterNumber: chapter.canonicalChapterNumber,
    title: chapter.title,
    status: chapter.status,
    hasContent: chapter.hasContent,
    charCount: chapter.charCount,
    contentHashPrefix: hashPrefix(chapter.contentHash),
    materializedAt: chapter.materializedAt,
    sourceUpdatedAt: chapter.sourceUpdatedAt,
    sourceItemCount: chapter.sources.length,
    updatedAt: chapter.updatedAt,
    sources: Object.freeze(chapter.sources.map(chapterSourceView)),
    sourcesTruncated: chapter.sourcesTruncated,
  });
}

export function projectAdminChapterContent(
  content: AdminChapterContent,
): AdminChapterContentView {
  return Object.freeze({
    chapterId: content.chapterId,
    novelId: content.novelId,
    canonicalChapterNumber: content.canonicalChapterNumber,
    chapterTitle: content.chapterTitle,
    status: content.status,
    body: content.body,
    charCount: content.charCount,
    contentHashPrefix: content.contentHash.slice(0, HASH_PREFIX_LENGTH),
    materializedAt: content.materializedAt,
    updatedAt: content.updatedAt,
  });
}

export function projectAdminContentPage<TDomain, TView>(
  page: AdminContentPage<TDomain>,
  project: (item: TDomain) => TView,
): AdminContentPageView<TView> {
  return Object.freeze({
    items: Object.freeze(page.items.map(project)),
    page: page.page,
    pageSize: page.pageSize,
    total: page.total,
    totalPages: page.totalPages,
  });
}
