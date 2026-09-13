import type { Prisma, PrismaClient } from "@prisma/client";

import {
  ARTICLE_GENERATE_UUID,
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
  articles: readonly { id: string }[];
};

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
  promo: PromoResolution | undefined,
): NovelGenerateCandidate {
  const outcome = promo?.outcome ?? "promo_link_missing";
  return {
    novelId: novel.id,
    title: novel.title,
    locale: novel.locale,
    businessId: novel.businessId,
    hasLiveArticle: novel.articles.length > 0,
    promoReady: outcome === "ready",
    promoOutcome: outcome === "ready" ? "ready" : outcome,
  };
}

async function decorateNovels(
  db: PrismaClient,
  novels: readonly NovelListRow[],
): Promise<NovelGenerateCandidate[]> {
  const promos = await resolveReadyPromoLinksForNovels(
    db,
    novels.map((novel) => novel.id),
  );
  return novels.map((novel) => toCandidate(novel, promos.get(novel.id)));
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
        articles: { where: { deletedAt: null }, select: { id: true }, take: 1 },
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
      articles: { where: { deletedAt: null }, select: { id: true }, take: 1 },
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
