import { pickReadyPromoLink, type PromoLinkCandidate } from "@/server/article-rebind/guards";

export type ReadyPromoLink = PromoLinkCandidate & {
  readonly publicRedirectCode: string;
};

export type PromoResolution =
  | { readonly outcome: "ready"; readonly promo: ReadyPromoLink }
  | { readonly outcome: "promo_link_missing" }
  | { readonly outcome: "promo_link_not_ready" }
  | { readonly outcome: "promo_link_deleted" };

type PromoDb = {
  promoLink: {
    findMany: (args: {
      where: { novelId: string; deletedAt: null; status: "fetched" };
      select: {
        id: true;
        status: true;
        webUrl: true;
        appUrl: true;
        fetchedAt: true;
        publicRedirectCode: true;
      };
      orderBy: [{ fetchedAt: "desc" }, { id: "asc" }];
    }) => Promise<ReadyPromoLink[]>;
    count: (args: { where: { novelId: string; deletedAt: null | { not: null } } }) => Promise<number>;
  };
};

/**
 * Execution-time promo pick for article generation. Reuses C-30
 * `pickReadyPromoLink` + `isPromoReady` and the same fetched/not-deleted
 * query order. Does not invent income attribution filters.
 */
export async function resolveReadyPromoLinkForNovel(
  db: PromoDb,
  novelId: string,
): Promise<PromoResolution> {
  const fetched = await db.promoLink.findMany({
    where: { novelId, deletedAt: null, status: "fetched" },
    select: {
      id: true,
      status: true,
      webUrl: true,
      appUrl: true,
      fetchedAt: true,
      publicRedirectCode: true,
    },
    orderBy: [{ fetchedAt: "desc" }, { id: "asc" }],
  });
  const ready = pickReadyPromoLink(fetched);
  if (ready) {
    return { outcome: "ready", promo: ready as ReadyPromoLink };
  }
  const liveCount = await db.promoLink.count({
    where: { novelId, deletedAt: null },
  });
  if (liveCount > 0) {
    return { outcome: "promo_link_not_ready" };
  }
  const deletedCount = await db.promoLink.count({
    where: { novelId, deletedAt: { not: null } },
  });
  return deletedCount > 0 ? { outcome: "promo_link_deleted" } : { outcome: "promo_link_missing" };
}

export function promoRedirectUrlFor(code: string): string {
  return `/go/${code}`;
}
