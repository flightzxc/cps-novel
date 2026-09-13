import type { PrismaClient } from "@prisma/client";

import { resolveReadyPromoLinkForNovel } from "./promo";

export type NovelGenerateCandidate = {
  readonly novelId: string;
  readonly title: string;
  readonly locale: string;
  readonly businessId: string;
  readonly hasLiveArticle: boolean;
  readonly promoReady: boolean;
  readonly promoOutcome: "ready" | "promo_link_missing" | "promo_link_not_ready" | "promo_link_deleted";
};

export async function listNovelsForArticleGenerate(
  db: PrismaClient,
  input: { readonly search?: string; readonly locale?: string; readonly limit?: number } = {},
): Promise<readonly NovelGenerateCandidate[]> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const novels = await db.novel.findMany({
    where: {
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
    },
    select: {
      id: true,
      title: true,
      locale: true,
      businessId: true,
      articles: { where: { deletedAt: null }, select: { id: true }, take: 1 },
    },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    take: limit,
  });

  const rows: NovelGenerateCandidate[] = [];
  for (const novel of novels) {
    const promo = await resolveReadyPromoLinkForNovel(db, novel.id);
    rows.push({
      novelId: novel.id,
      title: novel.title,
      locale: novel.locale,
      businessId: novel.businessId,
      hasLiveArticle: novel.articles.length > 0,
      promoReady: promo.outcome === "ready",
      promoOutcome: promo.outcome === "ready" ? "ready" : promo.outcome,
    });
  }
  return rows;
}
