import { Prisma, type PrismaClient } from "@prisma/client";

import {
  ADMIN_CONTENT_DEFAULT_PAGE_SIZE,
  ADMIN_CONTENT_MAX_PAGE_SIZE,
  ADMIN_CONTENT_MAX_SEARCH_LENGTH,
  ADMIN_CONTENT_MAX_SOURCE_ITEMS,
  type AdminChapterContent,
  type AdminChapterContentReadContext,
  type AdminChapterDetail,
  type AdminChapterListInput,
  type AdminChapterListItem,
  type AdminChapterSourceSummary,
  type AdminContentExceptionCode,
  type AdminContentPage,
  type AdminContentSyncSummary,
  type AdminNovelDetail,
  type AdminNovelLabelSummary,
  type AdminNovelListInput,
  type AdminNovelListItem,
  type AdminNovelSourceSummary,
  type AdminPreviewPolicy,
  type AdminPreviewSummary,
  type AdminSourceLabelActivity,
  type AdminSourceLabelListInput,
  type AdminSourceLabelListItem,
} from "@/domain/admin-content";
import {
  LABEL_KINDS,
  NOVEL_CHAPTER_STATUSES,
  NOVEL_STATUSES,
  type LabelKind,
  type NovelChapterStatus,
  type NovelStatus,
} from "@/domain/database-statuses";
import { SITE_LOCALES } from "@/lib/locale/locale-canonical";

type QueryClient = Pick<PrismaClient, "$queryRaw">;

export type AdminContentQueryErrorCode =
  | "invalid_page"
  | "invalid_page_size"
  | "invalid_search"
  | "invalid_status"
  | "invalid_locale"
  | "invalid_identifier"
  | "invalid_read_context"
  | "invalid_label_kind"
  | "invalid_activity";

export class AdminContentQueryError extends Error {
  readonly code: AdminContentQueryErrorCode;

  constructor(code: AdminContentQueryErrorCode, message: string) {
    super(message);
    this.name = "AdminContentQueryError";
    this.code = code;
  }
}

type NormalizedPage = { page: number; pageSize: number; offset: number };
type NormalizedNovelList = NormalizedPage & {
  status?: NovelStatus;
  locale?: string;
  search?: string;
  labelId?: string;
};
type NormalizedChapterList = NormalizedPage & {
  novelId: string;
  status?: NovelChapterStatus;
};
type NormalizedSourceLabelList = NormalizedPage & {
  labelKind?: LabelKind;
  search?: string;
  activity: AdminSourceLabelActivity;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADMIN_SOURCE_LABEL_ACTIVITIES: readonly AdminSourceLabelActivity[] = ["current", "history", "all"];

function normalizePage(page: unknown, pageSize: unknown): NormalizedPage {
  const normalizedPage = page ?? 1;
  const normalizedPageSize = pageSize ?? ADMIN_CONTENT_DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(normalizedPage) || Number(normalizedPage) < 1) {
    throw new AdminContentQueryError("invalid_page", "Page must be a positive integer");
  }
  if (
    !Number.isInteger(normalizedPageSize)
    || Number(normalizedPageSize) < 1
    || Number(normalizedPageSize) > ADMIN_CONTENT_MAX_PAGE_SIZE
  ) {
    throw new AdminContentQueryError(
      "invalid_page_size",
      `Page size must be between 1 and ${ADMIN_CONTENT_MAX_PAGE_SIZE}`,
    );
  }
  const value = Number(normalizedPage);
  const size = Number(normalizedPageSize);
  return { page: value, pageSize: size, offset: (value - 1) * size };
}

function requireUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new AdminContentQueryError("invalid_identifier", "A valid UUID identifier is required");
  }
  return value.toLowerCase();
}

export function normalizeAdminNovelListInput(input: AdminNovelListInput = {}): NormalizedNovelList {
  const pagination = normalizePage(input.page, input.pageSize);
  if (input.status !== undefined && !NOVEL_STATUSES.includes(input.status as NovelStatus)) {
    throw new AdminContentQueryError("invalid_status", "Novel status is not registered");
  }
  if (input.locale !== undefined && !SITE_LOCALES.includes(input.locale as never)) {
    throw new AdminContentQueryError("invalid_locale", "Locale is not registered");
  }
  if (input.search !== undefined && typeof input.search !== "string") {
    throw new AdminContentQueryError("invalid_search", "Search must be a string");
  }
  const search = input.search?.trim();
  if (search && search.length > ADMIN_CONTENT_MAX_SEARCH_LENGTH) {
    throw new AdminContentQueryError(
      "invalid_search",
      `Search must not exceed ${ADMIN_CONTENT_MAX_SEARCH_LENGTH} characters`,
    );
  }
  const labelId = input.labelId !== undefined ? requireUuid(input.labelId) : undefined;
  return {
    ...pagination,
    status: input.status,
    locale: input.locale,
    search: search || undefined,
    labelId,
  };
}

export function normalizeAdminSourceLabelListInput(
  input: AdminSourceLabelListInput = {},
): NormalizedSourceLabelList {
  const pagination = normalizePage(input.page, input.pageSize);
  if (input.labelKind !== undefined && !LABEL_KINDS.includes(input.labelKind as LabelKind)) {
    throw new AdminContentQueryError("invalid_label_kind", "Label kind is not registered");
  }
  if (input.search !== undefined && typeof input.search !== "string") {
    throw new AdminContentQueryError("invalid_search", "Search must be a string");
  }
  const search = input.search?.trim();
  if (search && search.length > ADMIN_CONTENT_MAX_SEARCH_LENGTH) {
    throw new AdminContentQueryError(
      "invalid_search",
      `Search must not exceed ${ADMIN_CONTENT_MAX_SEARCH_LENGTH} characters`,
    );
  }
  const activity = input.activity ?? "current";
  if (!ADMIN_SOURCE_LABEL_ACTIVITIES.includes(activity)) {
    throw new AdminContentQueryError("invalid_activity", "Activity filter is not registered");
  }
  return {
    ...pagination,
    labelKind: input.labelKind,
    search: search || undefined,
    activity,
  };
}

export function normalizeAdminChapterListInput(input: AdminChapterListInput): NormalizedChapterList {
  const pagination = normalizePage(input.page, input.pageSize);
  if (input.status !== undefined && !NOVEL_CHAPTER_STATUSES.includes(input.status as NovelChapterStatus)) {
    throw new AdminContentQueryError("invalid_status", "Chapter status is not registered");
  }
  return {
    ...pagination,
    novelId: requireUuid(input.novelId),
    status: input.status,
  };
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function requiredIso(value: Date): string {
  return value.toISOString();
}

function count(value: string | number | bigint | null | undefined): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Admin content count exceeded the safe integer range");
  }
  return parsed;
}

function pageResult<T>(items: readonly T[], total: number, pagination: NormalizedPage): AdminContentPage<T> {
  return {
    items,
    page: pagination.page,
    pageSize: pagination.pageSize,
    total,
    totalPages: Math.ceil(total / pagination.pageSize),
  };
}

type SyncColumns = {
  source_item_count: string;
  source_app_codes: string[];
  latest_source_updated_at: Date | null;
  latest_seen_at: Date | null;
  source_stale_count: string;
  chapter_failed_count: string;
  sync_task_id: string | null;
  sync_task_type: string | null;
  sync_task_status: string | null;
  sync_item_status: string | null;
  sync_mode: string | null;
  sync_attempt_count: number | null;
  sync_requested_at: Date | null;
  sync_started_at: Date | null;
  sync_finished_at: Date | null;
  sync_updated_at: Date | null;
  policy_materialized_count: number | null;
  actual_materialized_count: string;
};

function exceptionCodes(row: SyncColumns): AdminContentExceptionCode[] {
  const values: AdminContentExceptionCode[] = [];
  if (count(row.source_stale_count) > 0) values.push("source_item_stale");
  if (count(row.chapter_failed_count) > 0) values.push("chapter_materialization_failed");
  if (row.sync_item_status === "failed") values.push("sync_item_failed");
  if (row.sync_task_status === "failed") values.push("sync_task_failed");
  if (row.sync_task_status === "completed_with_errors") values.push("sync_completed_with_errors");
  if (
    row.policy_materialized_count !== null
    && row.policy_materialized_count !== count(row.actual_materialized_count)
  ) {
    values.push("preview_count_mismatch");
  }
  return values;
}

function syncSummary(row: SyncColumns): AdminContentSyncSummary {
  const latest = row.sync_task_id && row.sync_task_type && row.sync_task_status
    && row.sync_item_status && row.sync_mode && row.sync_requested_at && row.sync_updated_at
    ? {
        taskId: row.sync_task_id,
        taskType: row.sync_task_type,
        taskStatus: row.sync_task_status,
        itemStatus: row.sync_item_status,
        mode: row.sync_mode,
        attemptCount: row.sync_attempt_count ?? 0,
        requestedAt: requiredIso(row.sync_requested_at),
        startedAt: iso(row.sync_started_at),
        finishedAt: iso(row.sync_finished_at),
        updatedAt: requiredIso(row.sync_updated_at),
      }
    : null;
  return {
    sourceItemCount: count(row.source_item_count),
    sourceAppCodes: row.source_app_codes,
    latestSourceUpdatedAt: iso(row.latest_source_updated_at),
    latestSeenAt: iso(row.latest_seen_at),
    latest,
    exceptions: exceptionCodes(row),
  };
}

type PreviewColumns = SyncColumns & {
  policy_materialization_policy: string | null;
  policy_display_authorized: boolean | null;
  policy_index_authorized: boolean | null;
  policy_cache_authorized: boolean | null;
  policy_max_materialized_chapters: number | null;
  policy_last_refreshed_at: Date | null;
  policy_created_at: Date | null;
  policy_updated_at: Date | null;
  actual_displayable_count: string;
};

function previewSummary(row: PreviewColumns): AdminPreviewSummary {
  let policy: AdminPreviewPolicy | null = null;
  if (
    row.policy_materialization_policy !== null
    && row.policy_materialized_count !== null
    && row.policy_display_authorized !== null
    && row.policy_index_authorized !== null
    && row.policy_cache_authorized !== null
    && row.policy_max_materialized_chapters !== null
    && row.policy_created_at !== null
    && row.policy_updated_at !== null
  ) {
    policy = {
      materializationPolicy: row.policy_materialization_policy,
      materializedChapterCount: row.policy_materialized_count,
      displayAuthorized: row.policy_display_authorized,
      indexAuthorized: row.policy_index_authorized,
      cacheAuthorized: row.policy_cache_authorized,
      maxMaterializedChapters: row.policy_max_materialized_chapters,
      lastRefreshedAt: iso(row.policy_last_refreshed_at),
      createdAt: requiredIso(row.policy_created_at),
      updatedAt: requiredIso(row.policy_updated_at),
    };
  }
  const actual = count(row.actual_materialized_count);
  return {
    policy,
    actualMaterializedChapterCount: actual,
    actualDisplayableChapterCount: count(row.actual_displayable_count),
    policyCountMatchesActual: policy ? policy.materializedChapterCount === actual : null,
  };
}

function novelFilters(input: NormalizedNovelList): Prisma.Sql {
  const filters: Prisma.Sql[] = [Prisma.sql`n.deleted_at IS NULL`];
  if (input.status) filters.push(Prisma.sql`n.status = ${input.status}`);
  if (input.locale) filters.push(Prisma.sql`n.locale = ${input.locale}`);
  if (input.search) {
    filters.push(Prisma.sql`(
      POSITION(LOWER(${input.search}) IN LOWER(n.title)) > 0
      OR POSITION(LOWER(${input.search}) IN LOWER(n.business_id)) > 0
      OR POSITION(LOWER(${input.search}) IN LOWER(n.slug)) > 0
      OR n.id::text = ${input.search}
    )`);
  }
  if (input.labelId) {
    // EXISTS, never JOIN: this predicate is reused verbatim by both the count
    // query (single-table `novel n`) and the page CTE. A JOIN here would
    // fan out rows and inflate COUNT(*), and the count query has no
    // novel_source_item/novel_source_item_label aliases to join against.
    filters.push(Prisma.sql`EXISTS (
      SELECT 1 FROM novel_source_item nsi
      JOIN novel_source_item_label nsil ON nsil.novel_source_item_id = nsi.id
      WHERE nsi.novel_id = n.id AND nsi.deleted_at IS NULL
        AND nsil.active AND nsil.source_label_id = ${input.labelId}::uuid
    )`);
  }
  return Prisma.join(filters, " AND ");
}

type NovelListRow = PreviewColumns & {
  id: string;
  business_id: string;
  title: string;
  cover_url: string | null;
  locale: string;
  slug: string;
  author: string | null;
  completion_status: string | null;
  total_chapter_count: number;
  paid_from_chapter: number | null;
  split_ratio: string | null;
  status: NovelStatus;
  actual_chapter_row_count: string;
  created_at: Date;
  updated_at: Date;
};

const aggregateCtes = Prisma.sql`
  chapter_stats AS (
    SELECT nc.novel_id,
      COUNT(*)::text AS actual_chapter_row_count,
      COUNT(ncc.id)::text AS actual_materialized_count,
      COUNT(ncc.id) FILTER (WHERE nc.status = 'preview')::text AS actual_displayable_count
    FROM novel_chapter nc
    JOIN page p ON p.id = nc.novel_id
    LEFT JOIN novel_chapter_content ncc ON ncc.novel_chapter_id = nc.id
    WHERE nc.deleted_at IS NULL
    GROUP BY nc.novel_id
  ),
  source_stats AS (
    SELECT nsi.novel_id,
      COUNT(*)::text AS source_item_count,
      ARRAY_AGG(DISTINCT sa.code ORDER BY sa.code) AS source_app_codes,
      MAX(nsi.source_updated_at) AS latest_source_updated_at,
      MAX(nsi.last_seen_at) AS latest_seen_at,
      COUNT(*) FILTER (WHERE nsi.status = 'stale')::text AS source_stale_count
    FROM novel_source_item nsi
    JOIN page p ON p.id = nsi.novel_id
    JOIN channel_app ca ON ca.id = nsi.channel_app_id
    JOIN source_app sa ON sa.id = ca.source_app_id
    WHERE nsi.deleted_at IS NULL
    GROUP BY nsi.novel_id
  ),
  chapter_failures AS (
    SELECT nsi.novel_id,
      COUNT(*) FILTER (WHERE ncsi.status = 'failed')::text AS chapter_failed_count
    FROM novel_chapter_source_item ncsi
    JOIN novel_source_item nsi ON nsi.id = ncsi.novel_source_item_id
    JOIN page p ON p.id = nsi.novel_id
    WHERE nsi.deleted_at IS NULL
    GROUP BY nsi.novel_id
  ),
  latest_sync AS (
    SELECT DISTINCT ON (nsi.novel_id)
      nsi.novel_id,
      cst.id AS sync_task_id,
      cst.task_type AS sync_task_type,
      cst.status AS sync_task_status,
      csti.status AS sync_item_status,
      cst.mode AS sync_mode,
      csti.attempt_count AS sync_attempt_count,
      cst.requested_at AS sync_requested_at,
      csti.started_at AS sync_started_at,
      csti.finished_at AS sync_finished_at,
      csti.updated_at AS sync_updated_at
    FROM novel_source_item nsi
    JOIN page p ON p.id = nsi.novel_id
    JOIN channel_sync_task_item csti ON csti.novel_source_item_id = nsi.id
    JOIN channel_sync_task cst ON cst.id = csti.task_id
    WHERE nsi.deleted_at IS NULL
    ORDER BY nsi.novel_id, csti.updated_at DESC, csti.id DESC
  )
`;

const aggregateSelect = Prisma.sql`
  COALESCE(cs.actual_chapter_row_count, '0') AS actual_chapter_row_count,
  COALESCE(cs.actual_materialized_count, '0') AS actual_materialized_count,
  COALESCE(cs.actual_displayable_count, '0') AS actual_displayable_count,
  npp.materialization_policy AS policy_materialization_policy,
  npp.materialized_chapter_count AS policy_materialized_count,
  npp.display_authorized AS policy_display_authorized,
  npp.index_authorized AS policy_index_authorized,
  npp.cache_authorized AS policy_cache_authorized,
  npp.max_materialized_chapters AS policy_max_materialized_chapters,
  npp.last_refreshed_at AS policy_last_refreshed_at,
  npp.created_at AS policy_created_at,
  npp.updated_at AS policy_updated_at,
  COALESCE(ss.source_item_count, '0') AS source_item_count,
  COALESCE(ss.source_app_codes, ARRAY[]::text[]) AS source_app_codes,
  ss.latest_source_updated_at,
  ss.latest_seen_at,
  COALESCE(ss.source_stale_count, '0') AS source_stale_count,
  COALESCE(cf.chapter_failed_count, '0') AS chapter_failed_count,
  ls.sync_task_id,
  ls.sync_task_type,
  ls.sync_task_status,
  ls.sync_item_status,
  ls.sync_mode,
  ls.sync_attempt_count,
  ls.sync_requested_at,
  ls.sync_started_at,
  ls.sync_finished_at,
  ls.sync_updated_at
`;

const aggregateJoins = Prisma.sql`
  LEFT JOIN chapter_stats cs ON cs.novel_id = p.id
  LEFT JOIN novel_preview_policy npp ON npp.novel_id = p.id
  LEFT JOIN source_stats ss ON ss.novel_id = p.id
  LEFT JOIN chapter_failures cf ON cf.novel_id = p.id
  LEFT JOIN latest_sync ls ON ls.novel_id = p.id
`;

export async function listAdminNovels(
  db: QueryClient,
  input: AdminNovelListInput = {},
): Promise<AdminContentPage<AdminNovelListItem>> {
  const normalized = normalizeAdminNovelListInput(input);
  const where = novelFilters(normalized);
  const [totalRows, rows] = await Promise.all([
    db.$queryRaw<Array<{ count: string }>>(Prisma.sql`
      SELECT COUNT(*)::text AS count FROM novel n WHERE ${where}
    `),
    db.$queryRaw<NovelListRow[]>(Prisma.sql`
      WITH page AS (
        SELECT n.*
        FROM novel n
        WHERE ${where}
        ORDER BY n.updated_at DESC, n.id DESC
        LIMIT ${normalized.pageSize} OFFSET ${normalized.offset}
      ),
      ${aggregateCtes}
      SELECT
        p.id, p.business_id, p.title, p.cover_url, p.locale, p.slug, p.author,
        p.completion_status, p.total_chapter_count, p.paid_from_chapter,
        p.split_ratio::text AS split_ratio, p.status, p.created_at, p.updated_at,
        ${aggregateSelect}
      FROM page p
      ${aggregateJoins}
      ORDER BY p.updated_at DESC, p.id DESC
    `),
  ]);
  const items = rows.map((row): AdminNovelListItem => ({
    id: row.id,
    businessId: row.business_id,
    title: row.title,
    coverUrl: row.cover_url,
    locale: row.locale,
    slug: row.slug,
    author: row.author,
    completionStatus: row.completion_status,
    totalChapterCount: row.total_chapter_count,
    paidFromChapter: row.paid_from_chapter,
    splitRatio: row.split_ratio,
    status: row.status,
    actualChapterRowCount: count(row.actual_chapter_row_count),
    preview: previewSummary(row),
    sync: syncSummary(row),
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
  }));
  return pageResult(items, count(totalRows[0]?.count), normalized);
}

type NovelDetailRow = NovelListRow & {
  description: string;
  country: string | null;
  region: string | null;
};

type NovelSourceRow = {
  id: string;
  channel_code: string;
  channel_name: string;
  source_app_code: string;
  source_app_name: string;
  external_book_id: string;
  source_language_code: string;
  source_language_name: string | null;
  source_locale: string | null;
  status: string;
  source_updated_at: Date | null;
  last_seen_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function sourceSummary(row: NovelSourceRow): AdminNovelSourceSummary {
  return {
    id: row.id,
    channelCode: row.channel_code,
    channelName: row.channel_name,
    sourceAppCode: row.source_app_code,
    sourceAppName: row.source_app_name,
    externalBookId: row.external_book_id,
    sourceLanguageCode: row.source_language_code,
    sourceLanguageName: row.source_language_name,
    sourceLocale: row.source_locale,
    status: row.status,
    sourceUpdatedAt: iso(row.source_updated_at),
    lastSeenAt: iso(row.last_seen_at),
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
  };
}

type NovelLabelRow = {
  id: string;
  label_kind: LabelKind;
  external_label_value: string;
  display_value: string | null;
};

function novelLabelSummary(row: NovelLabelRow): AdminNovelLabelSummary {
  return {
    labelId: row.id,
    labelKind: row.label_kind,
    externalLabelValue: row.external_label_value,
    displayValue: row.display_value,
  };
}

export async function getAdminNovelDetail(
  db: QueryClient,
  novelId: string,
): Promise<AdminNovelDetail | null> {
  const id = requireUuid(novelId);
  const [rows, sourceRows, labelRows] = await Promise.all([
    db.$queryRaw<NovelDetailRow[]>(Prisma.sql`
      WITH page AS (
        SELECT n.* FROM novel n WHERE n.id = ${id}::uuid AND n.deleted_at IS NULL
      ),
      ${aggregateCtes}
      SELECT
        p.id, p.business_id, p.title, p.description, p.cover_url, p.locale, p.slug,
        p.author, p.completion_status, p.country, p.region, p.total_chapter_count,
        p.paid_from_chapter, p.split_ratio::text AS split_ratio, p.status,
        p.created_at, p.updated_at,
        ${aggregateSelect}
      FROM page p
      ${aggregateJoins}
    `),
    db.$queryRaw<NovelSourceRow[]>(Prisma.sql`
      SELECT nsi.id, c.code AS channel_code, c.name AS channel_name,
        sa.code AS source_app_code, sa.name AS source_app_name,
        nsi.external_book_id, nsi.source_language_code, nsi.source_language_name,
        nsi.source_locale, nsi.status, nsi.source_updated_at, nsi.last_seen_at,
        nsi.created_at, nsi.updated_at
      FROM novel_source_item nsi
      JOIN novel n ON n.id = nsi.novel_id AND n.deleted_at IS NULL
      JOIN channel_app ca ON ca.id = nsi.channel_app_id
      JOIN channel c ON c.id = ca.channel_id
      JOIN source_app sa ON sa.id = ca.source_app_id
      WHERE nsi.novel_id = ${id}::uuid AND nsi.deleted_at IS NULL
      ORDER BY nsi.updated_at DESC, nsi.id DESC
      LIMIT ${ADMIN_CONTENT_MAX_SOURCE_ITEMS}
    `),
    // Labels reach a novel only via novel_source_item; one query across all
    // four label_kind values (never 4 kind-scoped queries), active labels only.
    db.$queryRaw<NovelLabelRow[]>(Prisma.sql`
      SELECT DISTINCT sl.id, sl.label_kind, sl.external_label_value, sl.display_value
      FROM novel_source_item_label nsil
      JOIN novel_source_item nsi ON nsi.id = nsil.novel_source_item_id
      JOIN novel n ON n.id = nsi.novel_id AND n.deleted_at IS NULL
      JOIN source_label sl ON sl.id = nsil.source_label_id
      WHERE nsi.novel_id = ${id}::uuid AND nsi.deleted_at IS NULL AND nsil.active
      -- display_value is nullable and today is always NULL (the write side does
      -- not backfill it yet), so it cannot order anything on its own: fall
      -- through to the raw value and then the id for a total order.
      ORDER BY sl.label_kind, sl.display_value, sl.external_label_value, sl.id
    `),
  ]);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    businessId: row.business_id,
    title: row.title,
    description: row.description,
    coverUrl: row.cover_url,
    locale: row.locale,
    slug: row.slug,
    author: row.author,
    completionStatus: row.completion_status,
    country: row.country,
    region: row.region,
    totalChapterCount: row.total_chapter_count,
    paidFromChapter: row.paid_from_chapter,
    splitRatio: row.split_ratio,
    status: row.status,
    actualChapterRowCount: count(row.actual_chapter_row_count),
    preview: previewSummary(row),
    sync: syncSummary(row),
    sources: sourceRows.map(sourceSummary),
    sourcesTruncated: count(row.source_item_count) > sourceRows.length,
    labels: labelRows.map(novelLabelSummary),
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
  };
}

// Whether `sl` (source_label, must be aliased `sl` in the enclosing query)
// has ever been related to a live source item / novel. Bare dictionary rows do
// not belong to current, history or their union.
const LABEL_HAS_ANY_NOVEL_RELATION = Prisma.sql`EXISTS (
  SELECT 1
  FROM novel_source_item_label nsil
  JOIN novel_source_item nsi ON nsi.id = nsil.novel_source_item_id AND nsi.deleted_at IS NULL
  JOIN novel n2 ON n2.id = nsi.novel_id AND n2.deleted_at IS NULL
  WHERE nsil.source_label_id = sl.id
)`;

// Whether `sl` currently carries at least one active novel association. Do not
// redefine history as "exists an inactive association": one label may have
// both active and inactive relations, but it must appear in current only.
const LABEL_HAS_ACTIVE_NOVEL = Prisma.sql`EXISTS (
  SELECT 1
  FROM novel_source_item_label nsil
  JOIN novel_source_item nsi ON nsi.id = nsil.novel_source_item_id AND nsi.deleted_at IS NULL
  JOIN novel n2 ON n2.id = nsi.novel_id AND n2.deleted_at IS NULL
  WHERE nsil.source_label_id = sl.id AND nsil.active
)`;

function sourceLabelFilters(input: NormalizedSourceLabelList): Prisma.Sql {
  const filters: Prisma.Sql[] = [];
  if (input.labelKind) filters.push(Prisma.sql`sl.label_kind = ${input.labelKind}`);
  if (input.search) {
    filters.push(Prisma.sql`POSITION(LOWER(${input.search}) IN LOWER(sl.external_label_value)) > 0`);
  }
  if (input.activity === "current") filters.push(LABEL_HAS_ACTIVE_NOVEL);
  if (input.activity === "history") {
    filters.push(LABEL_HAS_ANY_NOVEL_RELATION);
    filters.push(Prisma.sql`NOT ${LABEL_HAS_ACTIVE_NOVEL}`);
  }
  if (input.activity === "all") filters.push(LABEL_HAS_ANY_NOVEL_RELATION);
  return filters.length > 0 ? Prisma.join(filters, " AND ") : Prisma.sql`TRUE`;
}

type SourceLabelListRow = {
  id: string;
  label_kind: LabelKind;
  external_label_value: string;
  display_value: string | null;
  novel_count: string;
};

function sourceLabelListItem(row: SourceLabelListRow): AdminSourceLabelListItem {
  return {
    labelId: row.id,
    labelKind: row.label_kind,
    externalLabelValue: row.external_label_value,
    displayValue: row.display_value,
    novelCount: count(row.novel_count),
  };
}

export async function listAdminSourceLabels(
  db: QueryClient,
  input: AdminSourceLabelListInput = {},
): Promise<AdminContentPage<AdminSourceLabelListItem>> {
  const normalized = normalizeAdminSourceLabelListInput(input);
  const where = sourceLabelFilters(normalized);
  const [totalRows, rows] = await Promise.all([
    db.$queryRaw<Array<{ count: string }>>(Prisma.sql`
      SELECT COUNT(*)::text AS count FROM source_label sl WHERE ${where}
    `),
    db.$queryRaw<SourceLabelListRow[]>(Prisma.sql`
      WITH page AS (
        SELECT sl.*
        FROM source_label sl
        WHERE ${where}
        ORDER BY sl.label_kind ASC, sl.external_label_value ASC, sl.id ASC
        LIMIT ${normalized.pageSize} OFFSET ${normalized.offset}
      ),
      label_novel_counts AS (
        -- novelCount is always the "currently active" cardinality, independent
        -- of the activity scope that decided which labels made it into the page.
        -- A "history" row is therefore guaranteed novelCount = 0, and a
        -- "current" row is guaranteed novelCount >= 1 (see LABEL_HAS_ACTIVE_NOVEL).
        SELECT p.id AS source_label_id, COUNT(DISTINCT nsi.novel_id)::text AS novel_count
        FROM novel_source_item_label nsil
        JOIN page p ON p.id = nsil.source_label_id
        JOIN novel_source_item nsi ON nsi.id = nsil.novel_source_item_id AND nsi.deleted_at IS NULL
        JOIN novel n ON n.id = nsi.novel_id AND n.deleted_at IS NULL
        WHERE nsil.active
        GROUP BY p.id
      )
      SELECT p.id, p.label_kind, p.external_label_value, p.display_value,
        COALESCE(lnc.novel_count, '0') AS novel_count
      FROM page p
      LEFT JOIN label_novel_counts lnc ON lnc.source_label_id = p.id
      ORDER BY p.label_kind ASC, p.external_label_value ASC, p.id ASC
    `),
  ]);
  const items = rows.map(sourceLabelListItem);
  return pageResult(items, count(totalRows[0]?.count), normalized);
}

type ChapterListRow = {
  id: string;
  novel_id: string;
  canonical_chapter_number: number;
  title: string | null;
  status: NovelChapterStatus;
  source_updated_at: Date | null;
  content_id: string | null;
  char_count: number | null;
  content_hash_prefix: string | null;
  materialized_at: Date | null;
  source_item_count: string;
  created_at: Date;
  updated_at: Date;
};

function chapterFilters(input: NormalizedChapterList): Prisma.Sql {
  const filters: Prisma.Sql[] = [
    Prisma.sql`nc.novel_id = ${input.novelId}::uuid`,
    Prisma.sql`nc.deleted_at IS NULL`,
    Prisma.sql`n.deleted_at IS NULL`,
  ];
  if (input.status) filters.push(Prisma.sql`nc.status = ${input.status}`);
  return Prisma.join(filters, " AND ");
}

export async function listAdminNovelChapters(
  db: QueryClient,
  input: AdminChapterListInput,
): Promise<AdminContentPage<AdminChapterListItem>> {
  const normalized = normalizeAdminChapterListInput(input);
  const where = chapterFilters(normalized);
  const [totalRows, rows] = await Promise.all([
    db.$queryRaw<Array<{ count: string }>>(Prisma.sql`
      SELECT COUNT(*)::text AS count
      FROM novel_chapter nc
      JOIN novel n ON n.id = nc.novel_id
      WHERE ${where}
    `),
    db.$queryRaw<ChapterListRow[]>(Prisma.sql`
      WITH page AS (
        SELECT nc.*
        FROM novel_chapter nc
        JOIN novel n ON n.id = nc.novel_id
        WHERE ${where}
        ORDER BY nc.canonical_chapter_number ASC, nc.id ASC
        LIMIT ${normalized.pageSize} OFFSET ${normalized.offset}
      ), source_counts AS (
        SELECT ncsi.novel_chapter_id, COUNT(*)::text AS source_item_count
        FROM novel_chapter_source_item ncsi
        JOIN page p ON p.id = ncsi.novel_chapter_id
        GROUP BY ncsi.novel_chapter_id
      )
      SELECT p.id, p.novel_id, p.canonical_chapter_number, p.title, p.status,
        p.source_updated_at, p.created_at, p.updated_at,
        ncc.id AS content_id, ncc.char_count,
        LEFT(ncc.content_hash, 12) AS content_hash_prefix,
        ncc.materialized_at,
        COALESCE(sc.source_item_count, '0') AS source_item_count
      FROM page p
      LEFT JOIN novel_chapter_content ncc ON ncc.novel_chapter_id = p.id
      LEFT JOIN source_counts sc ON sc.novel_chapter_id = p.id
      ORDER BY p.canonical_chapter_number ASC, p.id ASC
    `),
  ]);
  const items = rows.map((row): AdminChapterListItem => ({
    id: row.id,
    novelId: row.novel_id,
    canonicalChapterNumber: row.canonical_chapter_number,
    title: row.title,
    status: row.status,
    sourceUpdatedAt: iso(row.source_updated_at),
    hasContent: row.content_id !== null,
    charCount: row.char_count,
    contentHashPrefix: row.content_hash_prefix,
    materializedAt: iso(row.materialized_at),
    sourceItemCount: count(row.source_item_count),
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
  }));
  return pageResult(items, count(totalRows[0]?.count), normalized);
}

type ChapterDetailRow = {
  id: string;
  novel_id: string;
  novel_business_id: string;
  novel_title: string;
  canonical_chapter_number: number;
  title: string | null;
  status: NovelChapterStatus;
  source_updated_at: Date | null;
  content_id: string | null;
  char_count: number | null;
  content_hash: string | null;
  materialized_at: Date | null;
  source_item_count: string;
  created_at: Date;
  updated_at: Date;
};

type ChapterSourceRow = {
  id: string;
  novel_source_item_id: string;
  external_chapter_id: string;
  source_chapter_number: number | null;
  chapter_name: string | null;
  chapter_show_name: string | null;
  status: string;
  last_seen_at: Date | null;
  source_updated_at: Date | null;
};

function chapterSourceSummary(row: ChapterSourceRow): AdminChapterSourceSummary {
  return {
    id: row.id,
    novelSourceItemId: row.novel_source_item_id,
    externalChapterId: row.external_chapter_id,
    sourceChapterNumber: row.source_chapter_number,
    chapterName: row.chapter_name,
    chapterShowName: row.chapter_show_name,
    status: row.status,
    lastSeenAt: iso(row.last_seen_at),
    sourceUpdatedAt: iso(row.source_updated_at),
  };
}

export async function getAdminChapterDetail(
  db: QueryClient,
  novelId: string,
  chapterId: string,
): Promise<AdminChapterDetail | null> {
  const normalizedNovelId = requireUuid(novelId);
  const normalizedChapterId = requireUuid(chapterId);
  const [rows, sourceRows] = await Promise.all([
    db.$queryRaw<ChapterDetailRow[]>(Prisma.sql`
      SELECT nc.id, nc.novel_id, n.business_id AS novel_business_id,
        n.title AS novel_title, nc.canonical_chapter_number, nc.title, nc.status,
        nc.source_updated_at, nc.created_at, nc.updated_at,
        ncc.id AS content_id, ncc.char_count, ncc.content_hash, ncc.materialized_at,
        (SELECT COUNT(*)::text FROM novel_chapter_source_item ncsi
          WHERE ncsi.novel_chapter_id = nc.id) AS source_item_count
      FROM novel_chapter nc
      JOIN novel n ON n.id = nc.novel_id AND n.deleted_at IS NULL
      LEFT JOIN novel_chapter_content ncc ON ncc.novel_chapter_id = nc.id
      WHERE nc.id = ${normalizedChapterId}::uuid
        AND nc.novel_id = ${normalizedNovelId}::uuid
        AND nc.deleted_at IS NULL
    `),
    db.$queryRaw<ChapterSourceRow[]>(Prisma.sql`
      SELECT ncsi.id, ncsi.novel_source_item_id, ncsi.external_chapter_id,
        ncsi.source_chapter_number, ncsi.chapter_name, ncsi.chapter_show_name,
        ncsi.status, ncsi.last_seen_at, ncsi.source_updated_at
      FROM novel_chapter_source_item ncsi
      JOIN novel_chapter nc ON nc.id = ncsi.novel_chapter_id AND nc.deleted_at IS NULL
      JOIN novel n ON n.id = nc.novel_id AND n.deleted_at IS NULL
      WHERE nc.id = ${normalizedChapterId}::uuid
        AND nc.novel_id = ${normalizedNovelId}::uuid
      ORDER BY ncsi.updated_at DESC, ncsi.id DESC
      LIMIT ${ADMIN_CONTENT_MAX_SOURCE_ITEMS}
    `),
  ]);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    novelId: row.novel_id,
    novelBusinessId: row.novel_business_id,
    novelTitle: row.novel_title,
    canonicalChapterNumber: row.canonical_chapter_number,
    title: row.title,
    status: row.status,
    sourceUpdatedAt: iso(row.source_updated_at),
    hasContent: row.content_id !== null,
    charCount: row.char_count,
    contentHash: row.content_hash,
    materializedAt: iso(row.materialized_at),
    sources: sourceRows.map(chapterSourceSummary),
    sourcesTruncated: count(row.source_item_count) > sourceRows.length,
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
  };
}

type ChapterContentRow = {
  chapter_id: string;
  novel_id: string;
  canonical_chapter_number: number;
  chapter_title: string | null;
  status: NovelChapterStatus;
  body: string;
  char_count: number;
  content_hash: string;
  materialized_at: Date;
  updated_at: Date;
};

function validateReadContext(context: AdminChapterContentReadContext): void {
  if (
    typeof context.actorId !== "string"
    || context.actorId.length === 0
    || context.actorId.length > 128
    || typeof context.requestId !== "string"
    || context.requestId.length === 0
    || context.requestId.length > 160
  ) {
    throw new AdminContentQueryError("invalid_read_context", "A valid content read context is required");
  }
}

/**
 * Reads copyrighted chapter content and appends a metadata-only access audit.
 * The caller must be an Admin Route that has already enforced the proposed
 * `content:read` capability. Body, title and hashes are never copied to Audit.
 */
export async function readAdminChapterContent(
  db: PrismaClient,
  input: {
    novelId: string;
    chapterId: string;
    context: AdminChapterContentReadContext;
  },
): Promise<AdminChapterContent | null> {
  const novelId = requireUuid(input.novelId);
  const chapterId = requireUuid(input.chapterId);
  validateReadContext(input.context);
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<ChapterContentRow[]>(Prisma.sql`
      SELECT nc.id AS chapter_id, nc.novel_id, nc.canonical_chapter_number,
        nc.title AS chapter_title, nc.status, ncc.body, ncc.char_count,
        ncc.content_hash, ncc.materialized_at, ncc.updated_at
      FROM novel_chapter nc
      JOIN novel n ON n.id = nc.novel_id AND n.deleted_at IS NULL
      JOIN novel_chapter_content ncc ON ncc.novel_chapter_id = nc.id
      WHERE nc.id = ${chapterId}::uuid
        AND nc.novel_id = ${novelId}::uuid
        AND nc.deleted_at IS NULL
    `);
    const row = rows[0];
    if (!row) return null;
    await tx.operationAudit.create({
      data: {
        actorType: "admin",
        actorId: input.context.actorId,
        action: "admin.chapter_content.read",
        entityType: "novel_chapter",
        entityId: row.chapter_id,
        requestId: input.context.requestId,
      },
    });
    return {
      chapterId: row.chapter_id,
      novelId: row.novel_id,
      canonicalChapterNumber: row.canonical_chapter_number,
      chapterTitle: row.chapter_title,
      status: row.status,
      body: row.body,
      charCount: row.char_count,
      contentHash: row.content_hash,
      materializedAt: requiredIso(row.materialized_at),
      updatedAt: requiredIso(row.updated_at),
    };
  });
}
