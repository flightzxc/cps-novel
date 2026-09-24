import { Prisma, type PrismaClient } from "@prisma/client";
import type { PromoLinkStatusFilter } from "@/domain/catalog-batch";
import { PROMO_CLAIM_INTENT_OPERATION_TYPE } from "./promo-claim-release";

/**
 * B-4（施工提示词_Sonnet_B4_目录同步页推广链接状态筛选_2026-09-24；Opus
 * 复核 2026-09-24 追加规模修复）：目录同步页"推广链接状态"筛选与"领取资格"
 * 列共用的判定，页面列表的 WHERE narrowing 与 worker 枚举
 * `worker/handlers/catalog-batch.ts` 的 `streamSelection` 的 WHERE
 * narrowing 必须产出完全一致的结果——这是"全选一致性"的落地方式。
 *
 * 🔴 规模事故与修复（Opus 在一次性 postgres:16.14 + 本仓库 Prisma 6.19.2 上
 * 实测发现）：v1 实现把"已领取"/"未领取"两个桶各自物化成一份全量
 * `NovelSourceItem` id 集合，再拼 `id: { in }` / `id: { notIn }`。3 万个 id
 * 时还能跑，8 万个 id 时 `notIn` 报
 * "Query parameter limit exceeded … negation filters"（这一种 Prisma/
 * Postgres 都无法再拆页规避），`in` 报
 * "too many bind variables in prepared statement, expected maximum of
 * 32767"。预生产正式领取剩余约 7.6 万本、已领取一旦过约 3.3 万本，目录
 * 同步页的筛选与"全选"枚举会同时失效——这张表本该在书目规模变大后仍然可用，
 * 之前的实现反而在这个功能最需要的时候先坏掉。
 *
 * 修复：
 *   - "已领取"/"未领取"两个桶改用 `NovelSourceItem.promoLinks` 这个既有
 *     Prisma 关系（`some`/`none`），编译成数据库端 `EXISTS`/`NOT EXISTS`
 *     子查询，用到既有索引 `promo_link_source_idx`
 *     （`novel_source_item_id` 上）——不管书目/已领取规模多大，都不再把
 *     任何 id 列表搬进应用层或 SQL 参数列表。
 *   - "人工核对中"桶仍然离不开一份 id 列表：`side_effect_intent` 与
 *     `NovelSourceItem` 之间没有真正的外键关系，只能靠
 *     `request_summary ->> 'novelSourceItemId'` 这个 JSON 字段对齐（同
 *     `src/lib/tasks/promo-claim-release.ts` 的 `hasUnsafePendingItems`），
 *     Prisma 的关系过滤器覆盖不到这种"JSON 字段等值关联"。但这个桶在业务
 *     语义上就是一个运营待处理队列（人工介入的极端情况），不是"大多数书目
 *     最终会落入"的桶——所以用一次数据库端反连接（NOT EXISTS 对
 *     `promo_link.status = 'fetched'`）直接算出"人工核对中且尚无 fetched
 *     推广链接"的 id 列表，仍然是有界小集合，但加了 {@link
 *     MANUAL_REVIEW_ID_CAP} 硬上限——超过时宁可fail-closed 抛出可读错误
 *     （{@link PromoLinkManualReviewScaleError}），也不再悄悄退化成会在
 *     生产上炸掉的大 `id IN/NOT IN`。如果这个桶真的显著增长到上限以上
 *     （不符合它的运营队列定位，可能意味着上游领取管道本身出了问题），
 *     应该先去看管道为什么攒了这么多人工核对，而不是简单调大上限。
 *   - "领取资格"列（每行展示，`classifyPromoLinkRowStatuses`）改成只按
 *     "当前这一页"（≤ `CATALOG_PAGE_SIZE_OPTIONS` 里最大的 200）的
 *     `novelSourceItemId` 查询，从不加载全量集合——这一列的用途就是给
 *     当前渲染的这几十/上百行做标注，永远不需要知道全表状态。
 *
 * 多账号口径与局限（Owner 已知晓，见交付报告；本次改动不扩展多账号 UI）：
 * `PromoLink.idempotencyKey` 覆盖 `(channelAppId, novelSourceItemId,
 * channelAccountId, offerType)` 四元组，但这里的"已领取"判定只按
 * `novelSourceItemId` 聚合（`promoLinks: { some/none: {...} } }` 关系
 * 过滤器天然不区分 `channelAccountId`/`offerType`）。这在预生产（只有一个
 * 渠道账号）下与"该书在该渠道应用下存在 fetched 推广链接"完全等价——
 * `NovelSourceItem.channelAppId` 是固定的单一外键列，而 `worker/handlers/
 * promo-link-claim.ts` 的 `loadClaimScope` 在创建任何 `PromoLink` 行之前
 * 就会校验 `source.channelAppId === payload.channelAppId`（不等则抛
 * `claim_source_binding_missing`），所以一条 `PromoLink` 行的
 * `channelAppId` 结构上必然等于它所属 `NovelSourceItem` 自己的
 * `channelAppId`——按 `novelSourceItemId` 过滤已经天然限定在"这本书自己的
 * 渠道应用"范围内，不需要额外的 `channelAppId` 等值条件。局限：若未来
 * 同一本书在同一渠道应用下出现多个渠道账号/offerType 各自的 `PromoLink`
 * 行，这里会把"任意一个账号/offerType 已领取"就判定为"已有推广码"，不做
 * 账号级别的展示区分——这是本次改动明确选择不做的范围。
 */

/**
 * 硬上限：`side_effect_intent` 里"人工核对中且尚无 fetched 推广链接"的
 * 不同书目数超过这个数时直接 fail-closed（见上方模块头"人工核对中"桶的
 * 说明）。5,000 取自"这本质是运营待处理队列，不是批量书目状态"——预生产
 * 全量 `side_effect_intent` 量级约四千，这个上限已经比全表还宽松；真的
 * 撞到这个上限本身就是一个需要先去排查上游领取管道的信号。
 */
export const MANUAL_REVIEW_ID_CAP = 5_000;

export class PromoLinkManualReviewScaleError extends Error {
  constructor(readonly count: number) {
    super(
      `manual_review_required promo-link-claim intents linked to at least ${count} distinct books, ` +
        `exceeding the safety cap of ${MANUAL_REVIEW_ID_CAP} (see promo-link-status-filter.ts's module header). ` +
        "This bucket is expected to stay a small operator follow-up queue; if it has genuinely grown this " +
        "large, investigate the upstream claim pipeline before raising the cap.",
    );
    this.name = "PromoLinkManualReviewScaleError";
  }
}

// `Pick<PromoLinkDelegate, "findMany">` (not `Pick<PrismaClient, "promoLink">`,
// which would keep every other delegate method) -- the exact minimal shape
// both this module's real callers (the full `prisma`/`tx`) and unit-test
// fakes (`{ promoLink: { findMany: vi.fn() }, $queryRaw: vi.fn() }`) need to
// satisfy structurally.
type PromoLinkStatusQueryClient = {
  promoLink: Pick<PrismaClient["promoLink"], "findMany">;
  $queryRaw: PrismaClient["$queryRaw"];
};

/** Opaque context resolved once per page-load/enumeration and reused across every `promoLinkStatusIdConstraint` call it is needed for. */
export type PromoLinkStatusContext = Readonly<{
  /** Books with a `manual_review_required` intent and no `fetched` PromoLink -- always `.length <= MANUAL_REVIEW_ID_CAP` (a longer result throws instead of returning). */
  manualReviewIds: readonly string[];
}>;

/**
 * Only ever needed for the `"manual_review"`/`"not_claimed"` filter values
 * (`"claimed"` is a pure relation filter, `undefined`/"全部" needs nothing at
 * all) -- callers resolve this lazily, exactly when one of those two values
 * is actually in play, never unconditionally on every page load/enumeration.
 */
export async function resolvePromoLinkStatusContext(db: PromoLinkStatusQueryClient): Promise<PromoLinkStatusContext> {
  // `candidate.novel_source_item_id::text = pl.novel_source_item_id::text`
  // rather than casting the JSON-extracted text up to `::uuid` -- a
  // malformed/unexpected JSON value would otherwise abort the whole query
  // with a cast error instead of just not matching anything.
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT candidate.novel_source_item_id AS id
    FROM (
      SELECT DISTINCT request_summary ->> 'novelSourceItemId' AS novel_source_item_id
      FROM side_effect_intent
      WHERE operation_type = ${PROMO_CLAIM_INTENT_OPERATION_TYPE}
        AND status = 'manual_review_required'
    ) candidate
    WHERE candidate.novel_source_item_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM promo_link pl
        WHERE pl.novel_source_item_id::text = candidate.novel_source_item_id
          AND pl.status = 'fetched' AND pl.deleted_at IS NULL
      )
    LIMIT ${MANUAL_REVIEW_ID_CAP + 1}
  `);
  const manualReviewIds = rows.map((row) => row.id);
  if (manualReviewIds.length > MANUAL_REVIEW_ID_CAP) throw new PromoLinkManualReviewScaleError(manualReviewIds.length);
  return Object.freeze({ manualReviewIds: Object.freeze(manualReviewIds) });
}

/**
 * Translates the "推广链接状态" filter into a `NovelSourceItem` WHERE
 * fragment -- shared verbatim by the page listing (`read-source-items.ts`)
 * and the worker enumeration (`worker/handlers/catalog-batch.ts`'s
 * `selectionWhere`), which is what keeps "界面筛出 N 本 → 全选提交 → 枚举
 * 入片" identical.
 *
 * `"claimed"`/`"not_claimed"` are relation filters against `promoLinks`
 * (`some`/`none` of a `fetched`, non-deleted row) -- these scale to any
 * catalog/PromoLink size, translated by Prisma into a database-side
 * `EXISTS`/`NOT EXISTS` subquery, never an id list. `"manual_review"` and
 * the "not_claimed" branch's exclusion both still need `context` (see
 * {@link resolvePromoLinkStatusContext}'s doc comment for why that one
 * bucket cannot avoid an id list) -- `context` may be omitted only when
 * `filter` is `"claimed"` or `undefined`, both of which never read it.
 */
export function promoLinkStatusIdConstraint(
  filter: PromoLinkStatusFilter | undefined,
  context?: PromoLinkStatusContext,
): Prisma.NovelSourceItemWhereInput {
  if (!filter) return {};
  if (filter === "claimed") {
    return { promoLinks: { some: { status: "fetched", deletedAt: null } } };
  }
  const manualReviewIds = context?.manualReviewIds ?? [];
  if (filter === "manual_review") {
    return { id: { in: [...manualReviewIds] } };
  }
  // "not_claimed": no fetched PromoLink, and not in the (small, capped)
  // manual-review set.
  return {
    promoLinks: { none: { status: "fetched", deletedAt: null } },
    ...(manualReviewIds.length > 0 ? { id: { notIn: [...manualReviewIds] } } : {}),
  };
}

export type PromoLinkRowClassification = "claimed" | "manual_review" | "not_claimed";

/**
 * Per-row "推广链接状态" classification for the "领取资格" column --
 * deliberately scoped to exactly `rowIds` (the current page, ≤ the largest
 * `CATALOG_PAGE_SIZE_OPTIONS`, i.e. 200) rather than reusing a full-table
 * `PromoLinkStatusContext`. This column only ever needs to label the rows
 * actually being rendered, so it never needs -- and must never load -- a
 * full-catalog id set (see this module's header for what happened when the
 * v1 implementation did exactly that at scale).
 *
 * Priority is "claimed" over "manual_review" (a row can only be one label),
 * matching {@link promoLinkStatusIdConstraint}'s "not_claimed" bucket already
 * excluding manual-review books that have since been fetched -- both must
 * agree, or the eligibility column and the filter would contradict each
 * other for the same book.
 */
export async function classifyPromoLinkRowStatuses(
  db: PromoLinkStatusQueryClient,
  rowIds: readonly string[],
): Promise<ReadonlyMap<string, PromoLinkRowClassification>> {
  if (rowIds.length === 0) return new Map();
  const ids = [...rowIds];
  const [fetchedRows, manualReviewRows] = await Promise.all([
    db.promoLink.findMany({
      where: { novelSourceItemId: { in: ids }, status: "fetched", deletedAt: null },
      select: { novelSourceItemId: true },
      distinct: ["novelSourceItemId"],
    }),
    db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT DISTINCT request_summary ->> 'novelSourceItemId' AS id
      FROM side_effect_intent
      WHERE operation_type = ${PROMO_CLAIM_INTENT_OPERATION_TYPE}
        AND status = 'manual_review_required'
        AND request_summary ->> 'novelSourceItemId' = ANY(${ids}::text[])
    `),
  ]);
  const fetchedIds = new Set(fetchedRows.map((row) => row.novelSourceItemId));
  const manualReviewIds = new Set(manualReviewRows.map((row) => row.id));
  const result = new Map<string, PromoLinkRowClassification>();
  for (const id of ids) {
    result.set(id, fetchedIds.has(id) ? "claimed" : manualReviewIds.has(id) ? "manual_review" : "not_claimed");
  }
  return result;
}
