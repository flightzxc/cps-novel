import type { Prisma, PrismaClient } from "@prisma/client";

import {
  ARTICLE_GENERATE_UUID,
  type ArticleGenerateBlockedReason,
  type NovelGenerateCandidate,
  type NovelGeneratePage,
  type PinnedNovelResult,
} from "@/domain/article-generation";

import { resolveReadyPromoLinksForNovels, type PromoResolution } from "./promo";

export type { NovelGenerateCandidate } from "@/domain/article-generation";

type NovelListRow = {
  id: string;
  title: string;
  locale: string;
  businessId: string;
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

function novelWhere(input: {
  readonly search?: string;
  readonly locale?: string;
  readonly eligibleOnly?: boolean;
}): Prisma.NovelWhereInput {
  return {
    deletedAt: null,
    ...(input.locale ? { locale: input.locale } : {}),
    ...(input.search
      ? {
          OR: [
            { title: { contains: input.search, mode: "insensitive" } },
            { businessId: { contains: input.search, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(input.eligibleOnly ? { articles: { none: { deletedAt: null } } } : {}),
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
    readonly locale?: string;
    readonly page?: number;
    readonly pageSize?: number;
    readonly eligibleOnly?: boolean;
  } = {},
): Promise<NovelGeneratePage> {
  const pageSize = Math.min(Math.max(input.pageSize ?? 50, 1), 80);
  const page = Math.max(input.page ?? 1, 1);
  const where = novelWhere(input);
  const [total, novels] = await Promise.all([
    db.novel.count({ where }),
    db.novel.findMany({
      where,
      select: {
        id: true,
        title: true,
        locale: true,
        businessId: true,
        deletedAt: true,
        articles: { select: { id: true, locale: true, deletedAt: true } },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);
  return {
    rows: await decorateNovels(db, novels),
    total,
    page,
    pageSize,
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
      deletedAt: true,
      articles: { select: { id: true, locale: true, deletedAt: true } },
    },
  });
  if (!novel) return { status: "missing" };
  if (novel.deletedAt !== null) return { status: "deleted" };
  const [candidate] = await decorateNovels(db, [novel]);
  return { status: "found", novel: candidate! };
}

export function articleGenerateEligibleWhere(
  filter: { readonly search?: string; readonly locale?: string },
): Prisma.NovelWhereInput {
  return novelWhere({ ...filter, eligibleOnly: true });
}
