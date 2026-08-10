import type {
  LabelKind,
  NovelChapterStatus,
  NovelStatus,
} from "./database-statuses";

export const ADMIN_CONTENT_DEFAULT_PAGE_SIZE = 20;
export const ADMIN_CONTENT_MAX_PAGE_SIZE = 100;
export const ADMIN_CONTENT_MAX_SEARCH_LENGTH = 160;
export const ADMIN_CONTENT_MAX_SOURCE_ITEMS = 20;

export type AdminContentExceptionCode =
  | "source_item_stale"
  | "chapter_materialization_failed"
  | "sync_item_failed"
  | "sync_task_failed"
  | "sync_completed_with_errors"
  | "preview_count_mismatch";

export type AdminContentPage<T> = Readonly<{
  items: readonly T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}>;

export type AdminNovelListInput = Readonly<{
  page?: number;
  pageSize?: number;
  status?: NovelStatus;
  locale?: string;
  search?: string;
  labelId?: string;
}>;

export type AdminSourceLabelActivity = "current" | "history" | "all";

export type AdminSourceLabelListInput = Readonly<{
  page?: number;
  pageSize?: number;
  labelKind?: LabelKind;
  search?: string;                        // contains, applied to external_label_value
  activity?: AdminSourceLabelActivity;    // defaults to "current"
}>;

export type AdminSourceLabelListItem = Readonly<{
  labelId: string;
  labelKind: LabelKind;
  externalLabelValue: string;
  displayValue: string | null;
  novelCount: number;                     // COUNT(DISTINCT nsi.novel_id), bound by activity
}>;

export type AdminNovelLabelSummary = Readonly<{
  labelId: string;
  labelKind: LabelKind;
  externalLabelValue: string;
  displayValue: string | null;
}>;

export type AdminChapterListInput = Readonly<{
  novelId: string;
  page?: number;
  pageSize?: number;
  status?: NovelChapterStatus;
}>;

export type AdminContentSyncLatest = Readonly<{
  taskId: string;
  taskType: string;
  taskStatus: string;
  itemStatus: string;
  mode: string;
  attemptCount: number;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}>;

export type AdminContentSyncSummary = Readonly<{
  sourceItemCount: number;
  sourceAppCodes: readonly string[];
  latestSourceUpdatedAt: string | null;
  latestSeenAt: string | null;
  latest: AdminContentSyncLatest | null;
  exceptions: readonly AdminContentExceptionCode[];
}>;

export type AdminPreviewPolicy = Readonly<{
  materializationPolicy: string;
  materializedChapterCount: number;
  displayAuthorized: boolean;
  indexAuthorized: boolean;
  cacheAuthorized: boolean;
  maxMaterializedChapters: number;
  lastRefreshedAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type AdminPreviewSummary = Readonly<{
  policy: AdminPreviewPolicy | null;
  actualMaterializedChapterCount: number;
  actualDisplayableChapterCount: number;
  policyCountMatchesActual: boolean | null;
}>;

export type AdminNovelListItem = Readonly<{
  id: string;
  businessId: string;
  title: string;
  coverUrl: string | null;
  locale: string;
  slug: string;
  author: string | null;
  completionStatus: string | null;
  totalChapterCount: number;
  paidFromChapter: number | null;
  splitRatio: string | null;
  status: NovelStatus;
  actualChapterRowCount: number;
  preview: AdminPreviewSummary;
  sync: AdminContentSyncSummary;
  createdAt: string;
  updatedAt: string;
}>;

export type AdminNovelSourceSummary = Readonly<{
  id: string;
  channelCode: string;
  channelName: string;
  sourceAppCode: string;
  sourceAppName: string;
  externalBookId: string;
  sourceLanguageCode: string;
  sourceLanguageName: string | null;
  sourceLocale: string | null;
  status: string;
  sourceUpdatedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type AdminNovelDetail = Readonly<{
  id: string;
  businessId: string;
  title: string;
  description: string;
  coverUrl: string | null;
  locale: string;
  slug: string;
  author: string | null;
  completionStatus: string | null;
  country: string | null;
  region: string | null;
  totalChapterCount: number;
  paidFromChapter: number | null;
  splitRatio: string | null;
  status: NovelStatus;
  actualChapterRowCount: number;
  preview: AdminPreviewSummary;
  sync: AdminContentSyncSummary;
  sources: readonly AdminNovelSourceSummary[];
  sourcesTruncated: boolean;
  labels: readonly AdminNovelLabelSummary[];
  createdAt: string;
  updatedAt: string;
}>;

export type AdminChapterListItem = Readonly<{
  id: string;
  novelId: string;
  canonicalChapterNumber: number;
  title: string | null;
  status: NovelChapterStatus;
  sourceUpdatedAt: string | null;
  hasContent: boolean;
  charCount: number | null;
  contentHashPrefix: string | null;
  materializedAt: string | null;
  sourceItemCount: number;
  createdAt: string;
  updatedAt: string;
}>;

export type AdminChapterSourceSummary = Readonly<{
  id: string;
  novelSourceItemId: string;
  externalChapterId: string;
  sourceChapterNumber: number | null;
  chapterName: string | null;
  chapterShowName: string | null;
  status: string;
  lastSeenAt: string | null;
  sourceUpdatedAt: string | null;
}>;

export type AdminChapterDetail = Readonly<{
  id: string;
  novelId: string;
  novelBusinessId: string;
  novelTitle: string;
  canonicalChapterNumber: number;
  title: string | null;
  status: NovelChapterStatus;
  sourceUpdatedAt: string | null;
  hasContent: boolean;
  charCount: number | null;
  contentHash: string | null;
  materializedAt: string | null;
  sources: readonly AdminChapterSourceSummary[];
  sourcesTruncated: boolean;
  createdAt: string;
  updatedAt: string;
}>;

export type AdminChapterContent = Readonly<{
  chapterId: string;
  novelId: string;
  canonicalChapterNumber: number;
  chapterTitle: string | null;
  status: NovelChapterStatus;
  body: string;
  charCount: number;
  contentHash: string;
  materializedAt: string;
  updatedAt: string;
}>;

export type AdminChapterContentReadContext = Readonly<{
  actorId: string;
  requestId: string;
}>;
