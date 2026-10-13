import { pickReadyPromoLink, type PromoLinkCandidate } from "@/server/article-rebind/guards";
import { PROMO_READINESS_SELECT } from "@/server/publication/visibility";

export type ReadyPromoLink = PromoLinkCandidate & {
  readonly publicRedirectCode: string;
};

export type PromoResolution =
  | { readonly outcome: "ready"; readonly promo: ReadyPromoLink }
  | { readonly outcome: "promo_link_missing" }
  | { readonly outcome: "promo_link_not_ready" }
  | { readonly outcome: "promo_link_deleted" };

/**
 * v0.6.0：select 里多了口令码模式需要的字段与两个嵌套关系（剧场配置、书的语种），与
 * `PROMO_READINESS_SELECT` 一一对应。字面量类型必须写全——Prisma 的泛型靠它推断返回行形状。
 */
type PromoSelect = {
  id: true;
  status: true;
  webUrl: true;
  appUrl: true;
  upstreamCode: true;
  channelApp: { select: { config: true } };
  novel: { select: { locale: true } };
  fetchedAt: true;
  publicRedirectCode: true;
};

type PromoDb = {
  promoLink: {
    findMany: (args: {
      where: Record<string, unknown>;
      select: PromoSelect & { novelId?: true };
      orderBy: [{ fetchedAt: "desc" }, { id: "asc" }];
    }) => Promise<Array<ReadyPromoLink & { novelId?: string }>>;
    count: (args: { where: { novelId: string; deletedAt: null | { not: null } } }) => Promise<number>;
  };
};

type PromoGroupBy = (args: {
  by: ["novelId"];
  where: { novelId: { in: string[] }; deletedAt: null | { not: null } };
  _count: { _all: true };
}) => Promise<Array<{ novelId: string; _count: { _all: number } }>>;

function promoGroupBy(db: PromoDb): PromoGroupBy | undefined {
  const groupBy = (db.promoLink as PromoDb["promoLink"] & { groupBy?: PromoGroupBy }).groupBy;
  return typeof groupBy === "function" ? groupBy.bind(db.promoLink) : undefined;
}

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
      ...PROMO_READINESS_SELECT,
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

export async function resolveReadyPromoLinksForNovels(
  db: PromoDb,
  novelIds: readonly string[],
): Promise<ReadonlyMap<string, PromoResolution>> {
  const unique = Array.from(new Set(novelIds));
  const resolved = new Map<string, PromoResolution>();
  if (unique.length === 0) return resolved;

  const fetched = await db.promoLink.findMany({
    where: { novelId: { in: unique }, deletedAt: null, status: "fetched" },
    select: {
      id: true,
      ...PROMO_READINESS_SELECT,
      fetchedAt: true,
      publicRedirectCode: true,
      novelId: true,
    },
    orderBy: [{ fetchedAt: "desc" }, { id: "asc" }],
  });

  const byNovel = new Map<string, ReadyPromoLink[]>();
  for (const row of fetched) {
    const novelId = row.novelId;
    if (!novelId) continue;
    const bucket = byNovel.get(novelId) ?? [];
    bucket.push(row);
    byNovel.set(novelId, bucket);
  }

  const unresolved: string[] = [];
  for (const novelId of unique) {
    const ready = pickReadyPromoLink(byNovel.get(novelId) ?? []);
    if (ready) {
      resolved.set(novelId, { outcome: "ready", promo: ready as ReadyPromoLink });
    } else {
      unresolved.push(novelId);
    }
  }

  if (unresolved.length === 0) return resolved;

  const groupBy = promoGroupBy(db);
  const live = groupBy
    ? await groupBy({
        by: ["novelId"],
        where: { novelId: { in: unresolved }, deletedAt: null },
        _count: { _all: true },
      })
    : await Promise.all(
        unresolved.map(async (novelId) => ({
          novelId,
          _count: { _all: await db.promoLink.count({ where: { novelId, deletedAt: null } }) },
        })),
      );
  const liveSet = new Set(live.filter((row) => row._count._all > 0).map((row) => row.novelId));
  const stillMissing = unresolved.filter((novelId) => !liveSet.has(novelId));
  for (const novelId of liveSet) {
    resolved.set(novelId, { outcome: "promo_link_not_ready" });
  }

  if (stillMissing.length === 0) return resolved;

  const deleted = groupBy
    ? await groupBy({
        by: ["novelId"],
        where: { novelId: { in: stillMissing }, deletedAt: { not: null } },
        _count: { _all: true },
      })
    : await Promise.all(
        stillMissing.map(async (novelId) => ({
          novelId,
          _count: { _all: await db.promoLink.count({ where: { novelId, deletedAt: { not: null } } }) },
        })),
      );
  const deletedSet = new Set(deleted.filter((row) => row._count._all > 0).map((row) => row.novelId));
  for (const novelId of stillMissing) {
    resolved.set(
      novelId,
      deletedSet.has(novelId) ? { outcome: "promo_link_deleted" } : { outcome: "promo_link_missing" },
    );
  }
  return resolved;
}

export function promoRedirectUrlFor(code: string): string {
  return `/go/${code}`;
}
