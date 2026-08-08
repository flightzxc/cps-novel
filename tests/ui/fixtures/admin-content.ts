import type {
  AdminChapterContent,
  AdminChapterDetail,
  AdminChapterListItem,
  AdminNovelDetail,
  AdminNovelListItem,
} from "@/domain/admin-content";

/**
 * P2-04 fixtures typed as the **kernel's** shapes, not the view models.
 *
 * That is the point: every UI test drives its component through the real
 * `project*` functions, so a projection that started leaking `author` or
 * `splitRatio` would fail the secret-boundary assertions rather than sail past
 * hand-written view fixtures that never had those fields to begin with.
 */
export const NOVEL_ID = "24040000-0000-4000-8000-000000000011";
export const NOVEL_ID_B = "24040000-0000-4000-8000-000000000012";
export const CHAPTER_ID = "24040000-0000-4000-8000-000000000101";
export const TASK_ID = "24040000-0000-4000-8000-000000000201";

const NOW = "2026-08-08T00:00:00.000Z";

/** Values that must never surface. Asserted against rendered output. */
export const SENTINELS = Object.freeze({
  author: "P2_04_AUTHOR_MUST_NOT_RENDER",
  completionStatus: "P2_04_COMPLETION_MUST_NOT_RENDER",
  country: "P2_04_COUNTRY_MUST_NOT_RENDER",
  region: "P2_04_REGION_MUST_NOT_RENDER",
  coverUrl: "https://example.invalid/P2_04_COVER_MUST_NOT_RENDER.jpg",
  splitRatio: "0.6600",
  contentHashTail: "P2_04_HASH_TAIL_MUST_NOT_RENDER",
});

export function novelListItem(
  overrides: Partial<AdminNovelListItem> = {},
): AdminNovelListItem {
  return {
    id: NOVEL_ID,
    businessId: "novel-biz-0001",
    title: "夜航船",
    coverUrl: SENTINELS.coverUrl,
    locale: "en",
    slug: "ye-hang-chuan",
    author: SENTINELS.author,
    completionStatus: SENTINELS.completionStatus,
    totalChapterCount: 120,
    paidFromChapter: 4,
    splitRatio: SENTINELS.splitRatio,
    status: "published",
    actualChapterRowCount: 118,
    preview: {
      policy: {
        materializationPolicy: "upstream_returned_preview",
        materializedChapterCount: 3,
        displayAuthorized: true,
        indexAuthorized: true,
        cacheAuthorized: false,
        maxMaterializedChapters: 5,
        lastRefreshedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      },
      actualMaterializedChapterCount: 3,
      actualDisplayableChapterCount: 3,
      policyCountMatchesActual: true,
    },
    sync: {
      sourceItemCount: 2,
      sourceAppCodes: ["moboreader"],
      latestSourceUpdatedAt: NOW,
      latestSeenAt: NOW,
      latest: {
        taskId: TASK_ID,
        taskType: "preview_materialization",
        taskStatus: "completed",
        itemStatus: "success",
        mode: "apply",
        attemptCount: 1,
        requestedAt: NOW,
        startedAt: NOW,
        finishedAt: NOW,
        updatedAt: NOW,
      },
      exceptions: [],
    },
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: NOW,
    ...overrides,
  };
}

/** Second row, deliberately unhealthy: mismatch + two exceptions + no policy. */
export function troubledNovelListItem(): AdminNovelListItem {
  return novelListItem({
    id: NOVEL_ID_B,
    businessId: "novel-biz-0002",
    title: "白塔灯火",
    slug: "bai-ta-deng-huo",
    status: "draft",
    totalChapterCount: 80,
    actualChapterRowCount: 12,
    preview: {
      policy: null,
      actualMaterializedChapterCount: 1,
      actualDisplayableChapterCount: 0,
      policyCountMatchesActual: null,
    },
    sync: {
      sourceItemCount: 1,
      sourceAppCodes: ["moboreader"],
      latestSourceUpdatedAt: null,
      latestSeenAt: null,
      latest: null,
      exceptions: ["source_item_stale", "sync_task_failed"],
    },
  });
}

export function novelDetail(overrides: Partial<AdminNovelDetail> = {}): AdminNovelDetail {
  return {
    ...novelListItem(),
    description: "一艘夜里出发的船。",
    country: SENTINELS.country,
    region: SENTINELS.region,
    sources: [
      {
        id: "24040000-0000-4000-8000-000000000021",
        channelCode: "moboreader",
        channelName: "摩宝阅读",
        sourceAppCode: "moboreader_app",
        sourceAppName: "MoboReader",
        externalBookId: "up-book-7788",
        sourceLanguageCode: "1",
        sourceLanguageName: "English",
        sourceLocale: "en",
        status: "linked",
        sourceUpdatedAt: NOW,
        lastSeenAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    sourcesTruncated: false,
    ...overrides,
  };
}

export function chapterListItem(
  overrides: Partial<AdminChapterListItem> = {},
): AdminChapterListItem {
  return {
    id: CHAPTER_ID,
    novelId: NOVEL_ID,
    canonicalChapterNumber: 1,
    title: "第一章 起航",
    status: "preview",
    sourceUpdatedAt: NOW,
    hasContent: true,
    charCount: 2480,
    contentHashPrefix: "a1b2c3d4e5f6",
    materializedAt: NOW,
    sourceItemCount: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function chapterDetail(overrides: Partial<AdminChapterDetail> = {}): AdminChapterDetail {
  return {
    id: CHAPTER_ID,
    novelId: NOVEL_ID,
    novelBusinessId: "novel-biz-0001",
    novelTitle: "夜航船",
    canonicalChapterNumber: 1,
    title: "第一章 起航",
    status: "preview",
    sourceUpdatedAt: NOW,
    hasContent: true,
    charCount: 2480,
    contentHash: `a1b2c3d4e5f6${SENTINELS.contentHashTail}`,
    materializedAt: NOW,
    sources: [
      {
        id: "24040000-0000-4000-8000-000000000111",
        novelSourceItemId: "24040000-0000-4000-8000-000000000021",
        externalChapterId: "up-chapter-1",
        sourceChapterNumber: 1,
        chapterName: "起航",
        chapterShowName: "第一章 起航",
        status: "materialized",
        lastSeenAt: NOW,
        sourceUpdatedAt: NOW,
      },
    ],
    sourcesTruncated: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function chapterContent(
  overrides: Partial<AdminChapterContent> = {},
): AdminChapterContent {
  return {
    chapterId: CHAPTER_ID,
    novelId: NOVEL_ID,
    canonicalChapterNumber: 1,
    chapterTitle: "第一章 起航",
    status: "preview",
    body: "船在午夜离港。\n\n没有人来送。",
    charCount: 2480,
    contentHash: `a1b2c3d4e5f6${SENTINELS.contentHashTail}`,
    materializedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function page<T>(items: readonly T[], overrides: Partial<{
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}> = {}) {
  return {
    items,
    page: overrides.page ?? 1,
    pageSize: overrides.pageSize ?? 20,
    total: overrides.total ?? items.length,
    totalPages: overrides.totalPages ?? 1,
  };
}
