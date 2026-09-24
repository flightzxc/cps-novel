import { Prisma, type PrismaClient } from "@prisma/client";
import type { PromoLinkStatusFilter } from "@/domain/catalog-batch";
import { PROMO_CLAIM_INTENT_OPERATION_TYPE } from "./promo-claim-release";

/**
 * B-4（施工提示词_Sonnet_B4_目录同步页推广链接状态筛选_2026-09-24）：目录
 * 同步页"推广链接状态"筛选与"领取资格"列共用的两个有界 ID 集合——一次查询
 * 算出、两处复用（页面列表的 WHERE narrowing 与 worker 枚举
 * `worker/handlers/catalog-batch.ts` 的 `streamSelection` 的 WHERE
 * narrowing 必须产出完全一致的结果，这正是"全选一致性"的落地方式：两处
 * 不可能因为各自重新判定一遍而产生分歧）。
 *
 * 规模假设（写在这里，供以后规模变化时重新评估）：`promo_link` 全表约四千
 * 行、`side_effect_intent` 全表约四千行，相对于 `novel_source_item` 的八万
 * 行小两个数量级——两次查询（各自只 SELECT 需要的列/投影一个 JSON 字段）
 * 的成本可忽略，不需要为此新增索引，也不需要把整条主查询改写成数据库端
 * EXISTS 子查询（`promo_link_source_idx`/`side_effect_status_created_idx`
 * 这两个既有索引已经足够让这两次查询本身很快）。如果这两张表的规模后续显著
 * 增长（远超万级），应重新评估——把 `promoLinkStatusIdConstraint` 现在产出
 * 的 `id IN/NOT IN (有界集合)` 改成数据库端 EXISTS/LATERAL 子查询直接下推
 * 进主查询，而不是继续在应用层物化整张表的 ID 集合。
 *
 * 多账号口径与局限（Owner 已知晓，见交付报告；本次改动不扩展多账号 UI）：
 * `PromoLink.idempotencyKey` 覆盖 `(channelAppId, novelSourceItemId,
 * channelAccountId, offerType)` 四元组，但这里的"已领取"判定只按
 * `novelSourceItemId` 聚合，不区分 `channelAccountId`/`offerType`。这在预
 * 生产（只有一个渠道账号）下与"该书在该渠道应用下存在 fetched 推广链接"
 * 完全等价——`NovelSourceItem.channelAppId` 是固定的单一外键列，而
 * `worker/handlers/promo-link-claim.ts` 的 `loadClaimScope` 在创建任何
 * `PromoLink` 行之前就会校验 `source.channelAppId === payload.channelAppId`
 * （不等则抛 `claim_source_binding_missing`），所以一条 `PromoLink` 行的
 * `channelAppId` 结构上必然等于它所属 `NovelSourceItem` 自己的
 * `channelAppId`——按 `novelSourceItemId` 过滤已经天然限定在"这本书自己的
 * 渠道应用"范围内，不需要额外的 `channelAppId` 等值条件。
 * 局限：若未来同一本书在同一渠道应用下出现多个渠道账号/offerType 各自的
 * `PromoLink` 行，这里会把"任意一个账号/offerType 已领取"就判定为"已有
 * 推广码"，不做账号级别的展示区分——这是本次改动明确选择不做的范围。
 */
export type PromoLinkStatusSets = Readonly<{
  fetchedSourceItemIds: ReadonlySet<string>;
  manualReviewSourceItemIds: ReadonlySet<string>;
}>;

type PromoLinkStatusQueryClient = Pick<PrismaClient, "promoLink" | "$queryRaw">;

/**
 * 已领取集合：`status = 'fetched' AND deleted_at IS NULL` 的 `PromoLink`
 * 行按 `novelSourceItemId` 去重——与 `src/server/content-creation/promo.ts`/
 * `src/server/publication/visibility.ts` 判定"这本书真的有可用推广链接"时
 * 用的同一个条件组合（`status: "fetched", deletedAt: null`），不是另起
 * 一套口径。
 *
 * 人工核对集合：`side_effect_intent` 里 `operation_type =
 * 'promo_link.claim_promo' AND status = 'manual_review_required'` 的记录，
 * 按 `request_summary ->> 'novelSourceItemId'` 提取——与
 * `src/lib/tasks/promo-claim-release.ts` 的 `hasUnsafePendingItems` 关联
 * `side_effect_intent` 到书的方式一致（`targetId` 在这张表里存的是幂等键，
 * 不是 `novelSourceItemId`，两者只能通过这个 JSON 字段对齐）。用
 * `$queryRaw` 直接在数据库侧提取这一列值，而不是把整个 `request_summary`
 * JSONB 拉回应用层再解析——同一份数据、同一条查询语句既服务于 Web 层的
 * 筛选也服务于 worker 的枚举，两处不会因为各自的 JSON 解析代码而分歧。
 */
export async function resolvePromoLinkStatusSets(db: PromoLinkStatusQueryClient): Promise<PromoLinkStatusSets> {
  const [fetched, manualReview] = await Promise.all([
    db.promoLink.findMany({
      where: { status: "fetched", deletedAt: null },
      select: { novelSourceItemId: true },
      distinct: ["novelSourceItemId"],
    }),
    db.$queryRaw<Array<{ source_item_id: string | null }>>(Prisma.sql`
      SELECT DISTINCT request_summary ->> 'novelSourceItemId' AS source_item_id
      FROM side_effect_intent
      WHERE operation_type = ${PROMO_CLAIM_INTENT_OPERATION_TYPE}
        AND status = 'manual_review_required'
    `),
  ]);
  return Object.freeze({
    fetchedSourceItemIds: new Set(fetched.map((row) => row.novelSourceItemId)),
    manualReviewSourceItemIds: new Set(
      manualReview
        .map((row) => row.source_item_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  });
}

export type PromoLinkStatusIdConstraint = Readonly<{ id?: { in: string[] } | { notIn: string[] } }>;

/**
 * 把"推广链接状态"筛选翻译成 `NovelSourceItem` 查询里的 id 约束——纯函数，
 * 页面列表查询（`read-source-items.ts`）与 worker 枚举查询
 * （`worker/handlers/catalog-batch.ts` 的 `selectionWhere`）共用同一份
 * 实现，这正是"界面筛出 N 本 → 全选提交 → 枚举入片"一致性的落地方式：两处
 * 不可能因为各自重写一遍判定逻辑而产生分歧。
 *
 * "人工核对中"桶按任务口径要求排除已经有 fetched 推广链接的书（一本书理论
 * 上可能先进入人工核对、后来一次重试真的拿到码——那之后应该算"已领取"，不
 * 再算"人工核对中"），所以这里先从 `manualReviewSourceItemIds` 里减去
 * `fetchedSourceItemIds` 再使用；"未领取"桶则是两个集合的并集之外的部分。
 * 三桶互斥、覆盖全部（与 {@link classifyPromoLinkRowStatus} 的判定逐字
 * 一致）。
 */
export function promoLinkStatusIdConstraint(
  filter: PromoLinkStatusFilter | undefined,
  sets: PromoLinkStatusSets,
): PromoLinkStatusIdConstraint {
  if (!filter) return {};
  if (filter === "claimed") {
    return { id: { in: [...sets.fetchedSourceItemIds] } };
  }
  const manualReviewOnly = [...sets.manualReviewSourceItemIds].filter(
    (id) => !sets.fetchedSourceItemIds.has(id),
  );
  if (filter === "manual_review") {
    return { id: { in: manualReviewOnly } };
  }
  // "not_claimed"：既不在已领取集合、也不在人工核对集合里。
  const excluded = new Set([...sets.fetchedSourceItemIds, ...manualReviewOnly]);
  return excluded.size > 0 ? { id: { notIn: [...excluded] } } : {};
}

/**
 * 单本书的"推广链接状态"三态判定——供"领取资格"列使用。与
 * {@link promoLinkStatusIdConstraint} 的三桶判定必须逐字一致（同一份
 * `PromoLinkStatusSets`，"已领取"优先于"人工核对中"），否则会出现"筛选
 * 显示这本书未领取，但列表里的领取资格列却显示已有推广码"这种自相矛盾的
 * 界面。
 */
export function classifyPromoLinkRowStatus(
  sourceItemId: string,
  sets: PromoLinkStatusSets,
): "claimed" | "manual_review" | "not_claimed" {
  if (sets.fetchedSourceItemIds.has(sourceItemId)) return "claimed";
  if (sets.manualReviewSourceItemIds.has(sourceItemId)) return "manual_review";
  return "not_claimed";
}
