/**
 * 目录扫描按机构分流（v0.6.0）。
 *
 * 上游 `getlistpc` 目录接口不带剧场参数，返回的是**所有机构**的书目混在一起（MoboReader = 机构 3366，
 * PlotNovel = 机构 1351）。此前整页都记到"本次扫描任务所属的剧场"名下，PlotNovel 的书因此被登记成了
 * MoboReader 的书。现在每本书按自己的机构编号落到对应的剧场（`channel_app`）：
 *
 *   - 候选剧场 = 与任务剧场**同一渠道、同一 projectType**、且 `status = active`（渠道与来源应用也 active）的剧场；
 *   - 一个剧场通过 `config.agencyIds` 声明自己拥有哪些机构编号（见 `theater-promo-mode.ts`）；
 *   - 书的机构编号命中某个候选剧场 → 落到那个剧场；
 *   - 找不到（新机构、没有机构编号、或同一个机构号被两个 active 剧场同时声明）→ 仍落在本次扫描任务的
 *     剧场下，保持改动前的行为、不丢数据，同时由调用方计数（`unmapped`），便于以后发现新机构。
 *
 * 只有 **active** 的剧场参与分流。新登记的剧场默认是 `registered_disabled`（见
 * `scripts/register-plotnovel-theater.ts`），在运维手册规定的"改挂完成"那一步之前，目录扫描的落点与改动前
 * 完全一致——不会出现"存量还挂在 MoboReader、新书却落进 PlotNovel"的重复建档。
 */
import type { Prisma, PrismaClient } from "@prisma/client";

import { parseTheaterPromoConfig, type TheaterPromoMode } from "@/server/publication/theater-promo-mode";

export type CatalogRoute = Readonly<{
  channelAppId: string;
  sourceAppCode: string;
  promoMode: TheaterPromoMode;
}>;

export type CatalogRouteDecision = Readonly<{
  route: CatalogRoute;
  /** `true` = 按机构编号命中了某个 active 剧场；`false` = 退回任务剧场。 */
  mapped: boolean;
  /** 退回任务剧场的原因（`mapped = true` 时为 `null`）。 */
  fallbackReason: "no_agency_id" | "unmapped_agency" | "ambiguous_agency" | null;
}>;

export type CatalogRouting = Readonly<{
  taskRoute: CatalogRoute;
  /** 任务剧场 + 同渠道同 projectType 的全部 active 剧场（去重），用于"这本书在不在库里"这类跨剧场判断。 */
  routableChannelAppIds: readonly string[];
  resolve(agencyId: string | null | undefined): CatalogRouteDecision;
}>;

const APP_SELECT = {
  id: true,
  channelId: true,
  projectType: true,
  config: true,
  sourceApp: { select: { code: true } },
} as const satisfies Prisma.ChannelAppSelect;

type AppRow = Prisma.ChannelAppGetPayload<{ select: typeof APP_SELECT }>;

export type CatalogRoutingDb = Pick<PrismaClient, "channelApp"> | Pick<Prisma.TransactionClient, "channelApp">;

function toRoute(row: AppRow): CatalogRoute {
  return Object.freeze({
    channelAppId: row.id,
    sourceAppCode: row.sourceApp.code,
    promoMode: parseTheaterPromoConfig(row.config).promoMode,
  });
}

/** 纯函数：把剧场行建成分流表。导出以便单测直接喂行，不必起数据库。 */
export function buildCatalogRouting(taskApp: AppRow, activeApps: readonly AppRow[]): CatalogRouting {
  const taskRoute = toRoute(taskApp);
  const owners = new Map<string, CatalogRoute>();
  const ambiguous = new Set<string>();
  for (const app of activeApps) {
    // 同渠道、同 projectType 才参与（调用方的查询已经限定，这里再守一次，纯函数不信任输入）。
    if (app.channelId !== taskApp.channelId || app.projectType !== taskApp.projectType) continue;
    const route = toRoute(app);
    for (const agencyId of parseTheaterPromoConfig(app.config).agencyIds) {
      const existing = owners.get(agencyId);
      if (existing && existing.channelAppId !== route.channelAppId) {
        ambiguous.add(agencyId);
      } else {
        owners.set(agencyId, route);
      }
    }
  }
  for (const agencyId of ambiguous) owners.delete(agencyId);
  const routable = new Set<string>([taskApp.id]);
  for (const app of activeApps) {
    if (app.channelId === taskApp.channelId && app.projectType === taskApp.projectType) routable.add(app.id);
  }

  return Object.freeze({
    taskRoute,
    routableChannelAppIds: Object.freeze([...routable]),
    resolve(agencyId: string | null | undefined): CatalogRouteDecision {
      const key = typeof agencyId === "string" ? agencyId.trim() : "";
      if (key.length === 0) return { route: taskRoute, mapped: false, fallbackReason: "no_agency_id" };
      if (ambiguous.has(key)) return { route: taskRoute, mapped: false, fallbackReason: "ambiguous_agency" };
      const owner = owners.get(key);
      if (!owner) return { route: taskRoute, mapped: false, fallbackReason: "unmapped_agency" };
      return { route: owner, mapped: true, fallbackReason: null };
    },
  });
}

export async function loadCatalogRouting(db: CatalogRoutingDb, taskChannelAppId: string): Promise<CatalogRouting> {
  const taskApp = await db.channelApp.findUnique({ where: { id: taskChannelAppId }, select: APP_SELECT });
  if (!taskApp) throw new Error("catalog_task_app_missing");
  const activeApps = await db.channelApp.findMany({
    where: {
      channelId: taskApp.channelId,
      projectType: taskApp.projectType,
      status: "active",
      channel: { status: "active" },
      sourceApp: { status: "active" },
    },
    select: APP_SELECT,
    orderBy: { id: "asc" },
  });
  return buildCatalogRouting(taskApp, activeApps);
}

/** 页面级分流统计（写进每页的 `result`，任务级汇总由 finalize 累加）。 */
export type CatalogRoutingTally = {
  /** `channelAppId → 本页落到它名下的书数`。 */
  routedByChannelApp: Record<string, number>;
  /** 退回任务剧场的书数（含没有机构编号的）。 */
  unmappedBooks: number;
  /** 退回任务剧场且有机构编号的：`机构编号 → 本数`（最多记 20 个不同编号，防止异常数据撑大 JSON）。 */
  unmappedAgencies: Record<string, number>;
  ambiguousBooks: number;
};

export const MAX_TALLIED_UNMAPPED_AGENCIES = 20;

export function emptyCatalogRoutingTally(): CatalogRoutingTally {
  return { routedByChannelApp: {}, unmappedBooks: 0, unmappedAgencies: {}, ambiguousBooks: 0 };
}

export function recordCatalogRouting(
  tally: CatalogRoutingTally,
  decision: CatalogRouteDecision,
  agencyId: string | null | undefined,
): void {
  const app = decision.route.channelAppId;
  tally.routedByChannelApp[app] = (tally.routedByChannelApp[app] ?? 0) + 1;
  if (decision.mapped) return;
  tally.unmappedBooks += 1;
  if (decision.fallbackReason === "ambiguous_agency") tally.ambiguousBooks += 1;
  const key = typeof agencyId === "string" ? agencyId.trim() : "";
  if (key.length > 0) {
    if (key in tally.unmappedAgencies || Object.keys(tally.unmappedAgencies).length < MAX_TALLIED_UNMAPPED_AGENCIES) {
      tally.unmappedAgencies[key] = (tally.unmappedAgencies[key] ?? 0) + 1;
    }
  }
}
