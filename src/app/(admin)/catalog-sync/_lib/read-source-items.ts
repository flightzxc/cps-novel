import { NOVEL_SOURCE_ITEM_STATUSES, type NovelSourceItemStatus } from "@/domain/database-statuses";
import { UNKNOWN_SOURCE_LOCALE_FILTER } from "@/lib/locale/channel-language";
import { PROMO_LINK_CLAIM_TARGET_TYPE, PROMO_LINK_CLAIM_TASK_TYPE } from "@/lib/tasks/promo-link-claim-limits";

import { prisma } from "@/app/api/admin/_lib/deps";

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

const PAGE_SIZE = 20;

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
  readonly promoClaimIneligibleReason: "source_not_linked" | "item_already_active_elsewhere" | null;
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
};

const MAX_SEARCH_LENGTH = 200;
/** `NovelSourceItem.sourceLocale` is `@db.VarChar(16)` — reject anything longer outright rather than let Prisma's own error surface. */
const MAX_SOURCE_LOCALE_LENGTH = 16;

function normalizePage(value: string | undefined): number {
  const parsed = value ? Number.parseInt(value, 10) : 1;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
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
export async function readSourceItemsPage(filters: SourceItemFilters): Promise<SourceItemsPage> {
  const page = normalizePage(filters.page);
  const status = normalizeStatus(filters.status) ?? "pending";
  const search = normalizeSearch(filters.search);
  const sourceLocaleFilter = parseSourceLocaleFilter(filters.sourceLocale);

  const where = {
    deletedAt: null,
    status,
    ...(search ? { title: { contains: search, mode: "insensitive" as const } } : {}),
    ...(sourceLocaleFilter
      ? "isUnknown" in sourceLocaleFilter
        ? { sourceLocale: null }
        : { sourceLocale: sourceLocaleFilter.locale }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.novelSourceItem.findMany({
      where,
      orderBy: { lastSeenAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
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
    prisma.novelSourceItem.count({ where }),
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
        await prisma.genericTaskItem.findMany({
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

  return {
    items: rows.map((row) => {
      const sourceNotLinked = row.status !== "linked" || !row.novelId;
      const ineligibleReason = sourceNotLinked
        ? ("source_not_linked" as const)
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
    pageSize: PAGE_SIZE,
    total,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}
