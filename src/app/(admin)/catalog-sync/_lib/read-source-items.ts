import type { PrismaClient } from "@prisma/client";
import { NOVEL_SOURCE_ITEM_STATUSES, type NovelSourceItemStatus } from "@/domain/database-statuses";
import { normalizeCatalogSelection, type CatalogFilterSnapshot, type PromoLinkStatusFilter } from "@/domain/catalog-batch";
import { UNKNOWN_SOURCE_LOCALE_FILTER } from "@/lib/locale/channel-language";
import { PROMO_LINK_CLAIM_TARGET_TYPE, PROMO_LINK_CLAIM_TASK_TYPE } from "@/lib/tasks/promo-link-claim-limits";
import {
  classifyPromoLinkRowStatuses,
  promoLinkStatusIdConstraint,
  resolvePromoLinkStatusContext,
} from "@/lib/tasks/promo-link-status-filter";

import { prisma } from "@/app/api/admin/_lib/deps";

/**
 * B-4: injectable so a real-Postgres integration test can exercise this
 * exact query shape under the `web_app` role (this file's whole point is a
 * page-local read straight off the shared client -- see the module header
 * below -- so there was never a `src/server/**` seam to inject through
 * before). Defaults to the same singleton every existing caller already got
 * implicitly; `page.tsx`'s call site is untouched.
 */
export type SourceItemsDb = Pick<PrismaClient, "novelSourceItem" | "genericTaskItem" | "promoLink" | "$queryRaw">;

/**
 * Read side for `/catalog-sync`.
 *
 * There is no `src/server/admin-content` query for `NovelSourceItem` yet — the
 * P2-04 read kernel only ever covers `Novel`/`Article`/chapters/source labels —
 * and adding one is Codex's territory (`src/server/**`), out of this task's
 * write scope. This follows the same precedent
 * `src/app/(admin)/channel-accounts/page.tsx`'s `readRows` already set: a
 * page-local Prisma read straight off the shared client
 * (`@/app/api/admin/_lib/deps`), scoped to exactly the columns this screen
 * renders. Nothing here writes; `createContentFromSourceItem`
 * (`@/server/content-creation`) is the only write path and it stays entirely
 * inside the Server Action (`../_actions.ts`).
 */

export const CATALOG_PAGE_SIZE_OPTIONS = [50, 100, 200] as const;
const DEFAULT_PAGE_SIZE = 100;

export type SourceItemRow = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly coverUrl: string | null;
  readonly totalChapterCount: number;
  readonly paidFromChapter: number | null;
  /** Site locale the upstream language maps to, once S7a resolves it. Null today for most rows — S7a is not wired (see `_actions.ts`). */
  readonly sourceLocale: string | null;
  readonly sourceLanguageCode: string;
  readonly sourceLanguageName: string | null;
  readonly status: NovelSourceItemStatus;
  /** Non-null only once `status === "linked"`. */
  readonly novelId: string | null;
  readonly lastSeenAt: string | null;
  /**
   * RC-1: the FK the promo-link claim trigger needs to enforce a
   * single-channel-app selection client-side, before ever calling
   * `enqueuePromoLinkClaimAction`. `createPromoLinkClaimTask`
   * (`@/lib/tasks/promo-link-claim`) scopes its own eligibility read to
   * `channelAppId: input.channelAppId` — a multi-channel-app selection
   * would silently fall outside that scope and surface as a confusing
   * `source_unlinked_or_deleted` skip reason instead of an honest
   * "you selected across channel apps" message. `channelCode` /
   * `channelName` below stay the *display* fields; this is the id the
   * claim trigger actually groups and validates on.
   */
  readonly channelAppId: string;
  readonly channelCode: string;
  readonly channelName: string;
  readonly sourceAppCode: string;
  readonly sourceAppName: string;
  /**
   * C-8 (`施工工单_PhaseC_任务模型迁移与ImportProgress_2026-09-06.md` §五):
   * read-only projection of the SAME eligibility guard
   * `createPromoLinkClaimTask` (`@/lib/tasks/promo-link-claim`) runs at
   * claim time -- never a separate judgment, same discipline CPS's own
   * `ClaimEligibilityBadge` doc comment names for its `promoClaimEligible`.
   * `"source_unlinked_or_deleted"` (the factory's third skip reason) is not
   * reachable here: every row in this listing already passed
   * `deletedAt: null` and is already scoped to its own `channelAppId` --
   * the two conditions that reason covers at claim time.
   */
  readonly promoClaimEligible: boolean;
  /**
   * B-4: `already_has_promo_code`/`manual_review_pending` are new, checked
   * ahead of the two original reasons (see `readSourceItemsPage`'s priority
   * order below) -- a book that already reached `fetched` or is sitting in
   * manual review is never just "not linked yet"/"has an active task", it
   * already has an outcome worth surfacing on its own.
   */
  readonly promoClaimIneligibleReason:
    | "source_not_linked"
    | "item_already_active_elsewhere"
    | "already_has_promo_code"
    | "manual_review_pending"
    | null;
};

export type SourceItemsPage = {
  readonly items: readonly SourceItemRow[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
};

export type SourceItemFilters = {
  readonly page?: string;
  readonly pageSize?: string;
  readonly status?: string;
  readonly search?: string;
  /**
   * L10N P1 (`施工提示词_Sonnet_L10N_P1_语言归一与存量重算_2026-09-10.md`
   * §1.E): a resolved `SiteLocale`/non-site locale value (`"ru"`, `"it"`, …),
   * or the `UNKNOWN_SOURCE_LOCALE_FILTER` sentinel (`"__unknown"`, aligned
   * with CPS `3a76877:src/lib/channel-language.ts:57`'s
   * `UNKNOWN_SOURCE_LOCALE_FILTER` and its `changdu-sync-panel.tsx`
   * "全部语种/未知语种" `<select>` shape) meaning `sourceLocale IS NULL`.
   * Absent/empty means "全部语种" — no filter.
   */
  readonly sourceLocale?: string;
  /**
   * B-4: `"not_claimed" | "claimed" | "manual_review"` (see
   * `PROMO_LINK_STATUS_FILTER_VALUES`, `@/domain/catalog-batch`), or absent
   * for "全部" — no filter. Takes an intersection with `status`/`sourceLocale`,
   * never a replacement.
   */
  readonly promoLinkStatus?: string;
};

/** The list and an all-filtered batch must describe exactly the same rows. */
export function canonicalCatalogFilter(filters: SourceItemFilters): CatalogFilterSnapshot {
  const normalized = normalizeCatalogSelection({
    scope: "all_filtered",
    filter: {
      status: filters.status,
      search: filters.search,
      sourceLocale: filters.sourceLocale,
      promoLinkStatus: filters.promoLinkStatus,
    },
  });
  return normalized.scope === "all_filtered" ? normalized.filter : { status: "pending" };
}

const MAX_SEARCH_LENGTH = 200;
/** `NovelSourceItem.sourceLocale` is `@db.VarChar(16)` — reject anything longer outright rather than let Prisma's own error surface. */
const MAX_SOURCE_LOCALE_LENGTH = 16;

function normalizePage(value: string | undefined): number {
  const parsed = value ? Number.parseInt(value, 10) : 1;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function normalizePageSize(value: string | undefined): number {
  const parsed = value ? Number.parseInt(value, 10) : DEFAULT_PAGE_SIZE;
  return (CATALOG_PAGE_SIZE_OPTIONS as readonly number[]).includes(parsed) ? parsed : DEFAULT_PAGE_SIZE;
}

function normalizeStatus(value: string | undefined): NovelSourceItemStatus | undefined {
  return (NOVEL_SOURCE_ITEM_STATUSES as readonly string[]).includes(value ?? "")
    ? (value as NovelSourceItemStatus)
    : undefined;
}

function normalizeSearch(value: string | undefined): string | undefined {
  const trimmed = value?.trim().slice(0, MAX_SEARCH_LENGTH);
  return trimmed ? trimmed : undefined;
}

/**
 * `undefined` = no filter ("全部语种"); `{ isUnknown: true }` = `sourceLocale
 * IS NULL`; `{ locale }` = `sourceLocale = <locale>`. Deliberately does NOT
 * validate `locale` against `SITE_LOCALES`/the moboreader code table — a
 * source item's `sourceLocale` can legally be a non-site locale
 * (`it`/`fil`/`ms`/`tr`), and this is a read-side equality filter, not a
 * write-side registration check; an operator filtering by a value that
 * matches zero rows just sees an empty list, same as any other filter typo.
 */
function parseSourceLocaleFilter(
  value: string | undefined,
): { isUnknown: true } | { locale: string } | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed === UNKNOWN_SOURCE_LOCALE_FILTER) return { isUnknown: true };
  return trimmed.length <= MAX_SOURCE_LOCALE_LENGTH ? { locale: trimmed } : undefined;
}

/**
 * Defaults to `status=pending` — that is the only status this screen's whole
 * purpose (triggering creation) applies to, and an operator landing here cold
 * should see the actionable queue first. The status filter still offers the
 * other three for visibility (why is this one not creating? because it is
 * `linked`/`ignored`/`stale`), it is just not the default.
 */
export async function readSourceItemsPage(
  filters: SourceItemFilters,
  db: SourceItemsDb = prisma,
): Promise<SourceItemsPage> {
  const page = normalizePage(filters.page);
  const pageSize = normalizePageSize(filters.pageSize);
  const canonical = canonicalCatalogFilter(filters);
  const status = normalizeStatus(canonical.status) ?? "pending";
  const search = normalizeSearch(canonical.search);
  const sourceLocaleFilter = parseSourceLocaleFilter(canonical.sourceLocale);
  // `canonicalCatalogFilter` already ran this through `normalizeCatalogSelection`'s
  // strict enum check (throws on anything outside `PROMO_LINK_STATUS_FILTER_VALUES`)
  // -- by this point it is always one of the three values, or absent.
  const promoLinkStatus = canonical.promoLinkStatus as PromoLinkStatusFilter | undefined;

  // B-4 (Opus 复核后的规模修复): only resolved for the two filter values
  // that actually need a (small, capped) id list -- "claimed" compiles to a
  // pure `promoLinks` relation filter (no extra query at all), and "全部"
  // needs nothing. Never resolved unconditionally regardless of scale --
  // see `promo-link-status-filter.ts`'s module header for why the old
  // "always resolve two full sets" shape broke past ~33k claimed books.
  const promoLinkStatusContext = promoLinkStatus === "manual_review" || promoLinkStatus === "not_claimed"
    ? await resolvePromoLinkStatusContext(db)
    : undefined;

  const where = {
    deletedAt: null,
    status,
    ...(search ? { title: { contains: search, mode: "insensitive" as const } } : {}),
    ...(sourceLocaleFilter
      ? "isUnknown" in sourceLocaleFilter
        ? { sourceLocale: null }
        : { sourceLocale: sourceLocaleFilter.locale }
      : {}),
    ...promoLinkStatusIdConstraint(promoLinkStatus, promoLinkStatusContext),
  };

  const [rows, total] = await Promise.all([
    db.novelSourceItem.findMany({
      where,
      // A timestamp alone is not stable when rows share a last-seen value.
      orderBy: [{ lastSeenAt: "desc" }, { id: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        title: true,
        description: true,
        coverUrl: true,
        totalChapterCount: true,
        paidFromChapter: true,
        sourceLocale: true,
        sourceLanguageCode: true,
        sourceLanguageName: true,
        status: true,
        novelId: true,
        lastSeenAt: true,
        channelAppId: true,
        channelApp: {
          select: {
            channel: { select: { code: true, name: true } },
            sourceApp: { select: { code: true, name: true } },
          },
        },
      },
    }),
    db.novelSourceItem.count({ where }),
  ]);

  // C-8: same "cross-task overlap" query `createPromoLinkClaimTask`
  // (`@/lib/tasks/promo-link-claim`) runs at claim time, scoped to just this
  // page's `linked` rows -- a `pending`/`processing` promo-link-claim
  // GenericTaskItem already targeting a row means claiming it again right
  // now would be skipped as `item_already_active_elsewhere`.
  const linkedRowIds = rows.filter((row) => row.status === "linked" && row.novelId).map((row) => row.id);
  const activeElsewhere = linkedRowIds.length > 0
    ? new Set(
      (
        await db.genericTaskItem.findMany({
          where: {
            targetType: PROMO_LINK_CLAIM_TARGET_TYPE,
            targetId: { in: linkedRowIds },
            task: { taskType: PROMO_LINK_CLAIM_TASK_TYPE, status: { in: ["pending", "processing"] } },
          },
          select: { targetId: true },
        })
      ).map((item) => item.targetId),
    )
    : new Set<string>();

  // B-4 (Opus 复核后的规模修复): scoped to exactly this page's row ids
  // (≤200, the largest `CATALOG_PAGE_SIZE_OPTIONS` entry) -- the "领取资格"
  // column only ever needs to label the rows actually being rendered, never
  // a full-catalog set. See `classifyPromoLinkRowStatuses`'s doc comment.
  const promoRowStatuses = await classifyPromoLinkRowStatuses(db, rows.map((row) => row.id));

  return {
    items: rows.map((row) => {
      const sourceNotLinked = row.status !== "linked" || !row.novelId;
      // B-4: priority order (top to bottom) -- a row that has already
      // reached a promo-link outcome (fetched, or a manual-review intent) is
      // reported as that outcome ahead of "currently has an active task"
      // (`item_already_active_elsewhere`), since in practice these do not
      // overlap: `item_already_active_elsewhere` means a `pending`/
      // `processing` task item targets the row right now, while
      // `already_has_promo_code`/`manual_review_pending` both describe a
      // *terminal* outcome of a past attempt.
      const promoRowStatus = promoRowStatuses.get(row.id) ?? "not_claimed";
      const ineligibleReason = sourceNotLinked
        ? ("source_not_linked" as const)
        : promoRowStatus === "claimed"
          ? ("already_has_promo_code" as const)
          : promoRowStatus === "manual_review"
            ? ("manual_review_pending" as const)
            : activeElsewhere.has(row.id)
              ? ("item_already_active_elsewhere" as const)
              : null;
      return {
        id: row.id,
        title: row.title,
        description: row.description,
        coverUrl: row.coverUrl,
        totalChapterCount: row.totalChapterCount,
        paidFromChapter: row.paidFromChapter,
        sourceLocale: row.sourceLocale,
        sourceLanguageCode: row.sourceLanguageCode,
        sourceLanguageName: row.sourceLanguageName,
        status: row.status as NovelSourceItemStatus,
        novelId: row.novelId,
        lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
        channelAppId: row.channelAppId,
        channelCode: row.channelApp.channel.code,
        channelName: row.channelApp.channel.name,
        sourceAppCode: row.channelApp.sourceApp.code,
        sourceAppName: row.channelApp.sourceApp.name,
        promoClaimEligible: ineligibleReason === null,
        promoClaimIneligibleReason: ineligibleReason,
      };
    }),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
