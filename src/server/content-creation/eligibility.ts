import type { Prisma, PrismaClient } from "@prisma/client";

import {
  ARTICLE_GENERATE_UUID,
  type ArticleGenerateBlockedReason,
  type NovelGenerateCandidate,
  type NovelGeneratePage,
  type PinnedNovelResult,
} from "@/domain/article-generation";
import { readyPromoLinkWhere } from "@/server/publication/visibility";

import { resolveReadyPromoLinksForNovels, type PromoResolution } from "./promo";

export type { NovelGenerateCandidate } from "@/domain/article-generation";

type NovelListRow = {
  id: string;
  title: string;
  locale: string;
  businessId: string;
  updatedAt: Date;
  deletedAt: Date | null;
  articles: readonly { id: string; locale: string; deletedAt: Date | null }[];
};

export type ArticleGenerateAdmission = Readonly<{
  novelId: string;
  canGenerate: boolean;
  promoOutcome: PromoResolution["outcome"];
  blockedReason?: ArticleGenerateBlockedReason;
}>;

type AdmissionDb = Parameters<typeof resolveReadyPromoLinksForNovels>[0];

function articleForNovelLocale(novel: NovelListRow) {
  return novel.articles.find((article) => article.locale === novel.locale);
}

/**
 * Shared Article admission classification. Promo readiness is intentionally
 * delegated to the existing resolver, which in turn uses pickReadyPromoLink /
 * isPromoReady. This is the only pre-dispatch classifier used by list, direct
 * batch enqueue, and all-filtered enumeration.
 */
export async function resolveArticleGenerateAdmissions(
  db: AdmissionDb,
  requestedNovelIds: readonly string[],
  novels: readonly NovelListRow[],
): Promise<ReadonlyMap<string, ArticleGenerateAdmission>> {
  const rowsById = new Map(novels.map((novel) => [novel.id, novel]));
  const promoCandidateIds = requestedNovelIds.filter((novelId) => {
    const novel = rowsById.get(novelId);
    return Boolean(novel && novel.deletedAt === null);
  });
  const promos = await resolveReadyPromoLinksForNovels(db, promoCandidateIds);
  const admissions = new Map<string, ArticleGenerateAdmission>();

  for (const novelId of requestedNovelIds) {
    const novel = rowsById.get(novelId);
    if (!novel) {
      admissions.set(novelId, {
        novelId,
        canGenerate: false,
        promoOutcome: "promo_link_missing",
        blockedReason: "novel_not_found",
      });
      continue;
    }
    if (novel.deletedAt !== null) {
      admissions.set(novelId, {
        novelId,
        canGenerate: false,
        promoOutcome: "promo_link_missing",
        blockedReason: "novel_deleted",
      });
      continue;
    }
    const promoOutcome = promos.get(novelId)?.outcome ?? "promo_link_missing";
    const existing = articleForNovelLocale(novel);
    if (existing) {
      admissions.set(novelId, {
        novelId,
        canGenerate: false,
        promoOutcome,
        blockedReason: existing.deletedAt === null ? "already_exists" : "article_soft_deleted",
      });
      continue;
    }
    admissions.set(novelId, promoOutcome === "ready"
      ? { novelId, canGenerate: true, promoOutcome }
      : { novelId, canGenerate: false, promoOutcome, blockedReason: promoOutcome });
  }
  return admissions;
}

/**
 * Batch-create-operator-ux foundation step: `promoReadiness` is a
 * listing/counting optimisation layered on top of `eligibleOnly` (no live
 * Article), never a second decision authority — `resolveArticleGenerateAdmissions`
 * (via `isPromoReady`) stays the single classifier for labelling and enqueue
 * admission regardless of which of these three a caller picks. Only takes
 * effect when `eligibleOnly` is true; a caller that doesn't also filter out
 * novels with a live Article has no well-defined "promo-blocked" set to ask
 * about.
 *
 *   - "required": AND has a ready PromoLink (`readyPromoLinkWhere`,
 *     `src/server/publication/visibility.ts`) — the "generatable" set. Used
 *     by `articleGenerateEligibleWhere` (worker enumeration — narrows,
 *     never widens, what the worker would submit) and by
 *     `listNovelsForArticleGenerate`'s default (ineligible rows hidden)
 *     view.
 *   - "excluded": AND does NOT have a ready PromoLink — the
 *     "non-generatable" set, used only to compute the second count for the
 *     batch-generate page's banner (「另有 M 本不可生成」).
 *   - omitted: no promo constraint at all — reproduces this function's
 *     pre-promo-predicate behavior exactly (both ready and not-ready rows),
 *     used when the operator turns the "显示不可生成" view toggle on.
 */
function novelWhere(input: {
  readonly search?: string;
  readonly locales?: readonly string[];
  readonly eligibleOnly?: boolean;
  readonly promoReadiness?: "required" | "excluded";
}): Prisma.NovelWhereInput {
  return {
    deletedAt: null,
    ...(input.locales && input.locales.length > 0 ? { locale: { in: [...input.locales] } } : {}),
    ...(input.search
      ? {
          OR: [
            { title: { contains: input.search, mode: "insensitive" } },
            { businessId: { contains: input.search, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(input.eligibleOnly ? { articles: { none: { deletedAt: null } } } : {}),
    ...(input.eligibleOnly && input.promoReadiness === "required"
      ? { promoLinks: { some: readyPromoLinkWhere() } }
      : {}),
    ...(input.eligibleOnly && input.promoReadiness === "excluded"
      ? { NOT: { promoLinks: { some: readyPromoLinkWhere() } } }
      : {}),
  };
}

function toCandidate(
  novel: NovelListRow,
  admission: ArticleGenerateAdmission,
): NovelGenerateCandidate {
  const outcome = admission.promoOutcome;
  return {
    novelId: novel.id,
    title: novel.title,
    locale: novel.locale,
    businessId: novel.businessId,
    updatedAt: novel.updatedAt.toISOString(),
    hasLiveArticle: novel.articles.some((article) => article.locale === novel.locale && article.deletedAt === null),
    promoReady: outcome === "ready",
    promoOutcome: outcome === "ready" ? "ready" : outcome,
    canGenerateArticle: admission.canGenerate,
    ...(admission.blockedReason ? { generateBlockedReason: admission.blockedReason } : {}),
  };
}

async function decorateNovels(
  db: PrismaClient,
  novels: readonly NovelListRow[],
): Promise<NovelGenerateCandidate[]> {
  const admissions = await resolveArticleGenerateAdmissions(
    db,
    novels.map((novel) => novel.id),
    novels,
  );
  return novels.map((novel) => toCandidate(novel, admissions.get(novel.id)!));
}

export async function listNovelsForArticleGenerate(
  db: PrismaClient,
  input: {
    readonly search?: string;
    readonly locales?: readonly string[];
    readonly page?: number;
    readonly pageSize?: number;
    readonly eligibleOnly?: boolean;
    /**
     * View-only list parameter — default-hides promo-blocked rows (and
     * excludes them from `total`/pagination) when `eligibleOnly` is set.
     * Deliberately NOT part of `NormalizedArticleGenerateFilter`
     * (`src/domain/article-generation.ts`): it never enters
     * `canonicalFiltersEqual`, `inputFingerprint`, or an enqueued task
     * payload — see that module's header on why the filter snapshot stays
     * narrow.
     */
    readonly showIneligible?: boolean;
  } = {},
): Promise<NovelGeneratePage> {
  const pageSize = Math.min(Math.max(input.pageSize ?? 50, 1), 80);
  const page = Math.max(input.page ?? 1, 1);
  const baseFilter = { search: input.search, locales: input.locales };
  // Shared by `where` (below, WITH the locale narrowing) and the locale
  // facet query (below, WITHOUT it) — same view semantics (promo toggle),
  // different scope.
  const viewPromoReadiness = input.eligibleOnly && !input.showIneligible ? "required" as const : undefined;
  const where = novelWhere({ ...baseFilter, eligibleOnly: input.eligibleOnly, promoReadiness: viewPromoReadiness });
  const [total, novels, generatableCount, nonGeneratableCount, localeCountRows] = await Promise.all([
    db.novel.count({ where }),
    db.novel.findMany({
      where,
      select: {
        id: true,
        title: true,
        locale: true,
        businessId: true,
        updatedAt: true,
        deletedAt: true,
        articles: { select: { id: true, locale: true, deletedAt: true } },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    // Two independent COUNT(*) queries (never materialised id lists) so the
    // batch-generate banner can show "可生成 N 本 / 另有 M 本不可生成"
    // regardless of which set `rows`/`total` above currently represents.
    input.eligibleOnly
      ? db.novel.count({ where: novelWhere({ search: input.search, eligibleOnly: true, promoReadiness: "required" }) })
      : Promise.resolve(0),
    input.eligibleOnly
      ? db.novel.count({ where: novelWhere({ search: input.search, eligibleOnly: true, promoReadiness: "excluded" }) })
      : Promise.resolve(0),
    // Locale facet counts — the population the chip group offers to pick
    // FROM, so deliberately omits `locales` from its own `where` (a
    // `groupBy`, never a materialised id list; see `NovelGeneratePage.
    // localeCounts`'s doc comment in `src/domain/article-generation.ts`).
    input.eligibleOnly
      ? db.novel.groupBy({
          by: ["locale"],
          where: novelWhere({ search: input.search, eligibleOnly: true, promoReadiness: viewPromoReadiness }),
          _count: { _all: true },
        })
      : Promise.resolve([] as Array<{ locale: string; _count: { _all: number } }>),
  ]);
  const localeCounts = [...localeCountRows]
    .map((row) => ({ locale: row.locale, count: row._count._all }))
    .sort((a, b) => a.locale.localeCompare(b.locale));
  return {
    rows: await decorateNovels(db, novels),
    total,
    page,
    pageSize,
    generatableCount,
    nonGeneratableCount,
    localeCounts,
  };
}

export async function loadPinnedNovelForArticleGenerate(
  db: PrismaClient,
  novelId: string | undefined,
): Promise<PinnedNovelResult> {
  if (novelId === undefined || novelId.trim() === "") return { status: "absent" };
  if (!ARTICLE_GENERATE_UUID.test(novelId.trim())) return { status: "invalid" };
  const novel = await db.novel.findFirst({
    where: { id: novelId.trim() },
    select: {
      id: true,
      title: true,
      locale: true,
      businessId: true,
      updatedAt: true,
      deletedAt: true,
      articles: { select: { id: true, locale: true, deletedAt: true } },
    },
  });
  if (!novel) return { status: "missing" };
  if (novel.deletedAt !== null) return { status: "deleted" };
  const [candidate] = await decorateNovels(db, [novel]);
  return { status: "found", novel: candidate! };
}

/**
 * Worker enumeration for "按当前筛选全部入队" (`worker/handlers/article-generate-batch.ts`).
 * Adding `promoReadiness: "required"` here only NARROWS what the worker
 * enumerates — it excludes exactly the novels `resolveArticleGenerateAdmissions`
 * would have blocked anyway (promo_link_missing/not_ready/deleted; the other
 * blocked reasons — novel_not_found/deleted, already_exists,
 * article_soft_deleted — are already excluded by `deletedAt: null` and the
 * `eligibleOnly` no-live-article filter above), so it can never admit a
 * novel the per-row admission check would otherwise reject. This avoids
 * spending a child leaf task on a novel that would only ever be recorded as
 * blocked.
 */
export function articleGenerateEligibleWhere(
  filter: { readonly search?: string; readonly locales?: readonly string[] },
): Prisma.NovelWhereInput {
  return novelWhere({ ...filter, eligibleOnly: true, promoReadiness: "required" });
}
