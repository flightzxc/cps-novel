/**
 * 存量改挂（v0.6.0，P3 级生产数据变更）：把机构 1351（PlotNovel）的书目与推广链接，从 MoboReader 剧场
 * 挪到 PlotNovel 剧场名下。
 *
 * 背景：目录扫描过去不分剧场，PlotNovel 的书被一起拉进库、全部挂在 MoboReader 剧场下
 * （生产 10-14 只读：书目 3,830 条，推广链接 2,599 条，其中已领 2,009、排队 590）。新登记的 PlotNovel 剧场
 * 要接手这批书，目录扫描、领取、试读才会按剧场正确工作。
 *
 * 🔴 这不是改一个外键那么简单——下面这些东西都"带着剧场编号"，漏掉任何一个都会出事故：
 *
 *   1. `promo_link.idempotency_key` = sha256("promo_link\n<剧场编号>\n<书目编号>\n<账号>\n<offer>")。
 *      只改 `channel_app_id` 不重算它，领取 handler 用新剧场编号算出的键就找不到这条已有的推广链接，
 *      会再 upsert 出一条重复的（对已领取的书意味着第二次真实 `getcode`，上游接口不幂等）。
 *      所以每条推广链接的键必须在同一事务里按新剧场重算。
 *   2. `side_effect_intent.target_id`（`target_type = 'promo_link'`）存的正是上面那个键，领取 handler 的
 *      "是否已经为这条推广链接做过副作用"检查靠它兜底（`prepared` / `manual_review_required` / `confirmed`）。
 *      键变了而意图没跟着变，等于抹掉了防重复领取的最后一道闸。意图行的 `channel_app_id` 同步改挂。
 *   3. `source_label`（标签字典）和 `source_label_mapping`（标签→分类映射）都按剧场分账，标签投影
 *      （`novel_effective_tag`）要求书目的标签与映射在**同一个剧场**下。所以：为这批书用到的每个标签在
 *      PlotNovel 下建一份（已有就复用）并把书目的标签关联改指过去；再把这批书语种范围内的映射边复制一份
 *      到 PlotNovel 下（复制，不是移动——MoboReader 自己的书还要用）。否则这批书的"上游映射分类"会在
 *      下一次对账时消失。
 *   4. 领取 handler 校验"书目所属剧场 == 任务里的剧场"，改挂后旧任务条目会全部失败，所以执行前这批书不能
 *      有任何 `pending` / `processing` 的任务条目（领推广、试读、物化……），也不能有进行中的目录扫描。
 *   5. 公开网址冻结：如果已有"已发布"的文章挂在这批推广链接上，改挂会把那些页面的可见性规则从"有网址"换成
 *      "有口令码且语种在白名单"，可能让已被搜索引擎收录的页面变成 404（`docs/governance/AI_WORKFLOW.md`）。
 *      所以这种情况直接拒绝执行（`gate_published_pages`），由 Owner 单独决定；草稿 / 已下架的文章不挡路。
 *
 * 明确**不处理**（历史执行记录，改写等于篡改证据）：已结束的 `generic_task` / `channel_sync_task` 及其条目、
 * `operation_audit`、`tracking_event`。它们仍记着当时的剧场；后果只有一个——对历史失败条目点"重试"会在
 * 书目绑定校验上安全失败（fail-closed），需要重新建任务。
 *
 * 用法（必须在 Worker 层执行，`DATABASE_URL` 用 `worker_app` 那一条）：
 *   预演（只读，默认）：
 *     PLOTNOVEL_REHOME_OPERATOR=<operator> npx tsx scripts/rehome-plotnovel-source-items.ts \
 *       --request-id <稳定编号> --reason "<原因>"
 *   执行（同时给出确认短语与期望数量，数量不符立即拒绝）：
 *     ... --apply --confirm REHOME_PLOTNOVEL_SOURCE_ITEMS \
 *         --expected-source-items 3830 --expected-promo-links 2599
 *
 * 单事务、持咨询锁、写一条 `operation_audit`。可重复执行：第二次候选书目为 0，直接报告"已改挂"，改挂 0 行。
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Prisma, PrismaClient } from "@prisma/client";

import { buildPromoLinkIdempotencyKey } from "../src/lib/tasks/promo-link-claim";
import { parseTheaterPromoConfig } from "../src/server/publication/theater-promo-mode";
import { MOBOREADER_FOUNDATION } from "./register-moboreader-foundation";
import { PLOTNOVEL_THEATER } from "./register-plotnovel-theater";

export const REHOME_CONFIRM_PHRASE = "REHOME_PLOTNOVEL_SOURCE_ITEMS";
export const REHOME_AUDIT_ACTION = "plotnovel.rehome.apply";
const ADVISORY_LOCK_KEY = "cps-novel:plotnovel-rehome:v1";
const BLOCKER_SAMPLE_LIMIT = 50;

export type RehomeRefusalCode =
  | "invalid_arguments"
  | "theater_not_ready"
  | "gate_unfinished_tasks"
  | "gate_unique_conflict"
  | "gate_published_pages"
  | "gate_data_anomaly"
  | "count_mismatch"
  | "request_replay_conflict"
  | "post_condition_failed";

export class RehomeRefusedError extends Error {
  constructor(readonly code: RehomeRefusalCode, message: string, readonly detail?: unknown) {
    super(message);
    this.name = "RehomeRefusedError";
  }
}

export type RehomeOptions = {
  readonly apply: boolean;
  readonly operatorId: string;
  readonly requestId: string;
  readonly reason: string;
  readonly confirm?: string;
  readonly expectedSourceItems?: number;
  readonly expectedPromoLinks?: number;
};

export type RehomeCounts = {
  /** 本次要改挂的书目（还挂在 MoboReader 名下、机构属于 PlotNovel 的）。 */
  readonly sourceItems: number;
  /** 机构属于 PlotNovel、且已经挂在 PlotNovel 名下的书目（已改挂过的）。 */
  readonly sourceItemsAlreadyAtTarget: number;
  /** 这批书目引用的推广链接（含软删除的）。 */
  readonly promoLinks: number;
  readonly promoLinksByStatus: Readonly<Record<string, number>>;
  /** 需要跟着改键 / 改剧场的副作用意图（领取记录）。 */
  readonly sideEffectIntents: number;
  /** 书目 ↔ 标签关联行数，以及要在 PlotNovel 下新建的标签数。 */
  readonly labelLinks: number;
  readonly sourceLabelsToCreate: number;
  /** 要复制到 PlotNovel 下的标签映射边数。 */
  readonly mappingEdgesToCopy: number;
};

export type RehomeBlockers = {
  readonly pendingGenericTaskItems: { readonly total: number; readonly sample: readonly Record<string, unknown>[] };
  readonly pendingSyncTaskItems: { readonly total: number; readonly sample: readonly Record<string, unknown>[] };
  readonly activeCatalogScans: { readonly total: number; readonly sample: readonly Record<string, unknown>[] };
  /** 目标剧场下已经存在同 (外部书号, 语种码) 的书目——挪过去会撞唯一键。 */
  readonly uniqueKeyConflicts: { readonly total: number; readonly sample: readonly Record<string, unknown>[] };
  /** 推广链接新键与别的行撞了。 */
  readonly promoKeyConflicts: { readonly total: number };
  /**
   * 已发布（未删除）的文章正挂在这批推广链接上。改挂会把这些页面的可见性规则从"有网址"换成"有口令码且语种在白名单"，
   * 可能让已被搜索引擎收录的页面变成 404——违反"公开网址冻结"（`docs/governance/AI_WORKFLOW.md`），所以必须为 0，
   * 否则拒绝执行，由 Owner 单独批准后另行处理。
   */
  readonly publishedArticles: { readonly total: number; readonly sample: readonly Record<string, unknown>[] };
  /** 机构属于 PlotNovel 的书目挂在 MoboReader 与 PlotNovel 之外的剧场下。 */
  readonly itemsUnderOtherApps: { readonly total: number };
  /** 推广链接的剧场与其书目的剧场不一致（历史数据不一致，不敢动）。 */
  readonly promoLinksNotAtSourceApp: { readonly total: number };
};

export type RehomeApplied = {
  readonly rehomedSourceItems: number;
  readonly rehomedPromoLinks: number;
  readonly rekeyedPromoLinks: number;
  readonly updatedSideEffectIntents: number;
  readonly repointedLabelLinks: number;
  readonly createdSourceLabels: number;
  readonly copiedMappingEdges: number;
  readonly auditId: string;
  readonly sourceItemIdsSha256: string;
};

export type RehomeReport = {
  readonly mode: "dry-run" | "apply";
  readonly sourceChannelAppId: string;
  readonly targetChannelAppId: string;
  readonly targetStatus: string;
  readonly agencyIds: readonly string[];
  readonly counts: RehomeCounts;
  readonly blockers: RehomeBlockers;
  readonly blocked: boolean;
  /** 候选为 0：已经改挂过（或本来就没有要挪的书），不做任何写入。 */
  readonly noop: boolean;
  readonly applied: RehomeApplied | null;
};

type Tx = Prisma.TransactionClient;

type Scope = {
  readonly sourceAppId: string;
  readonly targetAppId: string;
  readonly targetStatus: string;
  readonly agencyIds: readonly string[];
};

function digestIds(ids: readonly string[]): string {
  return createHash("sha256").update([...ids].sort().join("\n"), "utf8").digest("hex");
}

function toNumber(value: bigint | number | null | undefined): number {
  return Number(value ?? 0);
}

async function resolveScope(tx: Tx): Promise<Scope> {
  const channel = await tx.channel.findUnique({ where: { code: MOBOREADER_FOUNDATION.channel.code }, select: { id: true } });
  const moboSourceApp = await tx.sourceApp.findUnique({ where: { code: MOBOREADER_FOUNDATION.sourceApp.code }, select: { id: true } });
  const plotSourceApp = await tx.sourceApp.findUnique({ where: { code: PLOTNOVEL_THEATER.sourceApp.code }, select: { id: true } });
  if (!channel || !moboSourceApp || !plotSourceApp) {
    throw new RehomeRefusedError("theater_not_ready", "MoboReader / PlotNovel source apps are not both registered; run register-plotnovel-theater first");
  }
  const source = await tx.channelApp.findUnique({
    where: {
      channelId_sourceAppId_externalAppId: {
        channelId: channel.id, sourceAppId: moboSourceApp.id, externalAppId: MOBOREADER_FOUNDATION.channelApp.externalAppId,
      },
    },
    select: { id: true, projectType: true },
  });
  const target = await tx.channelApp.findUnique({
    where: {
      channelId_sourceAppId_externalAppId: {
        channelId: channel.id, sourceAppId: plotSourceApp.id, externalAppId: PLOTNOVEL_THEATER.channelApp.externalAppId,
      },
    },
    select: { id: true, projectType: true, status: true, config: true },
  });
  if (!source || !target) {
    throw new RehomeRefusedError("theater_not_ready", "MoboReader / PlotNovel channel_app rows are not both registered");
  }
  if (source.projectType !== target.projectType) {
    throw new RehomeRefusedError("theater_not_ready", "source and target channel_app projectType differ");
  }
  const config = parseTheaterPromoConfig(target.config);
  if (config.promoMode !== "code" || config.agencyIds.length === 0) {
    throw new RehomeRefusedError("theater_not_ready", "target channel_app config must be promoMode=code with at least one agencyId");
  }
  return { sourceAppId: source.id, targetAppId: target.id, targetStatus: target.status, agencyIds: config.agencyIds };
}

type PromoRow = {
  id: string;
  novel_source_item_id: string;
  channel_app_id: string;
  channel_account_id: string;
  offer_type: string;
  idempotency_key: string;
  status: string;
};

async function loadCandidateIds(tx: Tx, scope: Scope, lock: boolean): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT s.id::text AS id
    FROM novel_source_item s
    WHERE s.channel_app_id = ${scope.sourceAppId}::uuid
      AND s.external_agency_id = ANY(${[...scope.agencyIds]}::text[])
    ORDER BY s.id
    ${lock ? Prisma.sql`FOR UPDATE` : Prisma.empty}
  `);
  return rows.map((row) => row.id);
}

async function loadPromoRows(tx: Tx, itemIds: readonly string[], lock: boolean): Promise<PromoRow[]> {
  if (itemIds.length === 0) return [];
  return tx.$queryRaw<PromoRow[]>(Prisma.sql`
    SELECT p.id::text AS id, p.novel_source_item_id::text AS novel_source_item_id, p.channel_app_id::text AS channel_app_id,
           p.channel_account_id::text AS channel_account_id, p.offer_type, trim(p.idempotency_key) AS idempotency_key, p.status
    FROM promo_link p
    WHERE p.novel_source_item_id = ANY(${[...itemIds]}::uuid[])
    ORDER BY p.id
    ${lock ? Prisma.sql`FOR UPDATE` : Prisma.empty}
  `);
}

function newKeyFor(row: PromoRow, targetAppId: string): string {
  return buildPromoLinkIdempotencyKey({
    channelAppId: targetAppId,
    novelSourceItemId: row.novel_source_item_id,
    channelAccountId: row.channel_account_id,
    offerType: row.offer_type,
  });
}

async function sampleRows(tx: Tx, query: Prisma.Sql): Promise<Record<string, unknown>[]> {
  return tx.$queryRaw<Record<string, unknown>[]>(query);
}

/** 只读盘点：所有计数与拦截项。`lock = true` 时给候选行加行锁（apply 路径）。 */
async function inspect(tx: Tx, scope: Scope, lock: boolean) {
  const itemIds = await loadCandidateIds(tx, scope, lock);
  const promoRows = await loadPromoRows(tx, itemIds, lock);
  const promoIds = promoRows.map((row) => row.id);
  const oldKeys = promoRows.map((row) => row.idempotency_key);
  const newKeys = promoRows.map((row) => newKeyFor(row, scope.targetAppId));

  const alreadyAtTarget = toNumber((await tx.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
    SELECT count(*)::bigint AS n FROM novel_source_item
    WHERE channel_app_id = ${scope.targetAppId}::uuid AND external_agency_id = ANY(${[...scope.agencyIds]}::text[])
  `))[0]?.n);

  const underOther = toNumber((await tx.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
    SELECT count(*)::bigint AS n FROM novel_source_item
    WHERE external_agency_id = ANY(${[...scope.agencyIds]}::text[])
      AND channel_app_id NOT IN (${scope.sourceAppId}::uuid, ${scope.targetAppId}::uuid)
  `))[0]?.n);

  const promoLinksByStatus: Record<string, number> = {};
  for (const row of promoRows) promoLinksByStatus[row.status] = (promoLinksByStatus[row.status] ?? 0) + 1;
  const promoNotAtSource = promoRows.filter((row) => row.channel_app_id !== scope.sourceAppId).length;

  const intents = itemIds.length === 0 ? 0 : toNumber((await tx.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
    SELECT count(*)::bigint AS n FROM side_effect_intent
    WHERE (target_type = 'promo_link' AND target_id = ANY(${oldKeys}::text[]))
       OR promo_link_id = ANY(${promoIds}::uuid[])
  `))[0]?.n);

  const labelStats = itemIds.length === 0 ? { links: 0, toCreate: 0 } : await (async () => {
    const [row] = await tx.$queryRaw<Array<{ links: bigint; to_create: bigint }>>(Prisma.sql`
      WITH used AS (
        SELECT sl.label_kind, sl.external_label_value
        FROM novel_source_item_label nsil
        JOIN source_label sl ON sl.id = nsil.source_label_id
        WHERE nsil.novel_source_item_id = ANY(${[...itemIds]}::uuid[]) AND sl.channel_app_id = ${scope.sourceAppId}::uuid
        GROUP BY sl.label_kind, sl.external_label_value
      )
      SELECT
        (SELECT count(*) FROM novel_source_item_label WHERE novel_source_item_id = ANY(${[...itemIds]}::uuid[]))::bigint AS links,
        (SELECT count(*) FROM used u WHERE NOT EXISTS (
          SELECT 1 FROM source_label t
          WHERE t.channel_app_id = ${scope.targetAppId}::uuid AND t.label_kind = u.label_kind AND t.external_label_value = u.external_label_value
        ))::bigint AS to_create
    `);
    return { links: toNumber(row?.links), toCreate: toNumber(row?.to_create) };
  })();

  const mappingEdges = itemIds.length === 0 ? 0 : toNumber((await tx.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
    SELECT count(*)::bigint AS n
    FROM source_label_mapping m
    WHERE m.channel_app_id = ${scope.sourceAppId}::uuid
      AND m.raw_language_scope IN (
        SELECT DISTINCT raw_language_scope FROM novel_source_item
        WHERE id = ANY(${[...itemIds]}::uuid[]) AND raw_language_scope IS NOT NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM source_label_mapping t
        WHERE t.channel_app_id = ${scope.targetAppId}::uuid AND t.raw_language_scope = m.raw_language_scope
          AND t.raw_token = m.raw_token AND t.canonical_tag_id = m.canonical_tag_id
      )
  `))[0]?.n);

  // --- 拦截项 ---
  const pendingGeneric = itemIds.length === 0 ? { total: 0, sample: [] } : {
    total: toNumber((await tx.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
      SELECT count(*)::bigint AS n FROM generic_task_item i
      WHERE i.status IN ('pending', 'processing') AND i.target_id = ANY(${[...itemIds]}::text[])
    `))[0]?.n),
    sample: await sampleRows(tx, Prisma.sql`
      SELECT i.id::text AS item_id, i.task_id::text AS task_id, t.task_type, t.status AS task_status,
             i.target_type, i.target_id, i.status AS item_status
      FROM generic_task_item i JOIN generic_task t ON t.id = i.task_id
      WHERE i.status IN ('pending', 'processing') AND i.target_id = ANY(${[...itemIds]}::text[])
      ORDER BY i.created_at, i.id LIMIT ${BLOCKER_SAMPLE_LIMIT}
    `),
  };
  const pendingSync = itemIds.length === 0 ? { total: 0, sample: [] } : {
    total: toNumber((await tx.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
      SELECT count(*)::bigint AS n FROM channel_sync_task_item i
      WHERE i.status IN ('pending', 'processing') AND i.novel_source_item_id = ANY(${[...itemIds]}::uuid[])
    `))[0]?.n),
    sample: await sampleRows(tx, Prisma.sql`
      SELECT i.id::text AS item_id, i.task_id::text AS task_id, t.task_type, t.status AS task_status,
             i.novel_source_item_id::text AS novel_source_item_id, i.status AS item_status
      FROM channel_sync_task_item i JOIN channel_sync_task t ON t.id = i.task_id
      WHERE i.status IN ('pending', 'processing') AND i.novel_source_item_id = ANY(${[...itemIds]}::uuid[])
      ORDER BY i.created_at, i.id LIMIT ${BLOCKER_SAMPLE_LIMIT}
    `),
  };
  const activeScans = {
    total: toNumber((await tx.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
      SELECT count(*)::bigint AS n FROM generic_task WHERE task_type = 'catalog_scan' AND status IN ('pending', 'processing')
    `))[0]?.n),
    sample: await sampleRows(tx, Prisma.sql`
      SELECT id::text AS task_id, status, channel_app_id::text AS channel_app_id, created_at
      FROM generic_task WHERE task_type = 'catalog_scan' AND status IN ('pending', 'processing')
      ORDER BY created_at LIMIT ${BLOCKER_SAMPLE_LIMIT}
    `),
  };
  const uniqueConflicts = itemIds.length === 0 ? { total: 0, sample: [] } : {
    total: toNumber((await tx.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
      SELECT count(*)::bigint AS n
      FROM novel_source_item t
      JOIN novel_source_item s ON s.external_book_id = t.external_book_id AND s.source_language_code = t.source_language_code
      WHERE t.channel_app_id = ${scope.targetAppId}::uuid AND s.id = ANY(${[...itemIds]}::uuid[])
    `))[0]?.n),
    sample: await sampleRows(tx, Prisma.sql`
      SELECT s.id::text AS source_item_id, t.id::text AS existing_target_item_id, s.external_book_id, s.source_language_code
      FROM novel_source_item t
      JOIN novel_source_item s ON s.external_book_id = t.external_book_id AND s.source_language_code = t.source_language_code
      WHERE t.channel_app_id = ${scope.targetAppId}::uuid AND s.id = ANY(${[...itemIds]}::uuid[])
      ORDER BY s.id LIMIT ${BLOCKER_SAMPLE_LIMIT}
    `),
  };
  const promoKeyConflicts = promoRows.length === 0 ? 0 : toNumber((await tx.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
    SELECT count(*)::bigint AS n FROM promo_link
    WHERE trim(idempotency_key) = ANY(${newKeys}::text[]) AND id <> ALL(${promoIds}::uuid[])
  `))[0]?.n);

  const publishedArticles = promoRows.length === 0 ? { total: 0, sample: [] } : {
    total: toNumber((await tx.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
      SELECT count(*)::bigint AS n FROM article a
      WHERE a.promo_link_id = ANY(${promoIds}::uuid[]) AND a.status = 'published' AND a.deleted_at IS NULL
    `))[0]?.n),
    sample: await sampleRows(tx, Prisma.sql`
      SELECT a.id::text AS article_id, a.locale, a.novel_id::text AS novel_id, a.promo_link_id::text AS promo_link_id
      FROM article a
      WHERE a.promo_link_id = ANY(${promoIds}::uuid[]) AND a.status = 'published' AND a.deleted_at IS NULL
      ORDER BY a.id LIMIT ${BLOCKER_SAMPLE_LIMIT}
    `),
  };

  const counts: RehomeCounts = {
    sourceItems: itemIds.length,
    sourceItemsAlreadyAtTarget: alreadyAtTarget,
    promoLinks: promoRows.length,
    promoLinksByStatus,
    sideEffectIntents: intents,
    labelLinks: labelStats.links,
    sourceLabelsToCreate: labelStats.toCreate,
    mappingEdgesToCopy: mappingEdges,
  };
  const blockers: RehomeBlockers = {
    pendingGenericTaskItems: pendingGeneric,
    pendingSyncTaskItems: pendingSync,
    activeCatalogScans: activeScans,
    uniqueKeyConflicts: uniqueConflicts,
    promoKeyConflicts: { total: promoKeyConflicts },
    publishedArticles,
    itemsUnderOtherApps: { total: underOther },
    promoLinksNotAtSourceApp: { total: promoNotAtSource },
  };
  return { itemIds, promoRows, oldKeys, newKeys, counts, blockers };
}

function isBlocked(blockers: RehomeBlockers): boolean {
  return blockers.pendingGenericTaskItems.total > 0
    || blockers.pendingSyncTaskItems.total > 0
    || blockers.activeCatalogScans.total > 0
    || blockers.uniqueKeyConflicts.total > 0
    || blockers.promoKeyConflicts.total > 0
    || blockers.publishedArticles.total > 0
    || blockers.itemsUnderOtherApps.total > 0
    || blockers.promoLinksNotAtSourceApp.total > 0;
}

function refusalFor(blockers: RehomeBlockers): RehomeRefusedError {
  if (blockers.pendingGenericTaskItems.total > 0 || blockers.pendingSyncTaskItems.total > 0 || blockers.activeCatalogScans.total > 0) {
    return new RehomeRefusedError(
      "gate_unfinished_tasks",
      `refused: ${blockers.pendingGenericTaskItems.total} unfinished task items, ${blockers.pendingSyncTaskItems.total} unfinished sync items `
        + `and ${blockers.activeCatalogScans.total} active catalog scans still reference these books; finish, cancel or wait for them first`,
      blockers,
    );
  }
  if (blockers.uniqueKeyConflicts.total > 0 || blockers.promoKeyConflicts.total > 0) {
    return new RehomeRefusedError(
      "gate_unique_conflict",
      `refused: moving would collide with ${blockers.uniqueKeyConflicts.total} existing source items / ${blockers.promoKeyConflicts.total} promo link keys at the target theater`,
      blockers,
    );
  }
  if (blockers.publishedArticles.total > 0) {
    return new RehomeRefusedError(
      "gate_published_pages",
      `refused: ${blockers.publishedArticles.total} published articles are attached to these promo links; moving them could change `
        + "the visibility of already-public pages (public URL freeze) -- needs a separate Owner decision",
      blockers,
    );
  }
  return new RehomeRefusedError(
    "gate_data_anomaly",
    `refused: ${blockers.itemsUnderOtherApps.total} books of these agencies sit under other theaters, `
      + `${blockers.promoLinksNotAtSourceApp.total} promo links do not match their book's theater; resolve by hand first`,
    blockers,
  );
}

export function validateOptions(options: RehomeOptions): RehomeOptions {
  const bounded = (name: string, value: string, max: number) => {
    const normalized = value.trim();
    if (!normalized || normalized.length > max) {
      throw new RehomeRefusedError("invalid_arguments", `${name} must contain 1-${max} characters`);
    }
    return normalized;
  };
  const integer = (name: string, value: number | undefined) => {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new RehomeRefusedError("invalid_arguments", `${name} must be a non-negative integer`);
    }
  };
  integer("expected-source-items", options.expectedSourceItems);
  integer("expected-promo-links", options.expectedPromoLinks);
  if (options.apply) {
    if (options.confirm !== REHOME_CONFIRM_PHRASE) {
      throw new RehomeRefusedError("invalid_arguments", `--apply requires --confirm ${REHOME_CONFIRM_PHRASE}`);
    }
    if (options.expectedSourceItems === undefined || options.expectedPromoLinks === undefined) {
      throw new RehomeRefusedError("invalid_arguments", "--apply requires both --expected-source-items and --expected-promo-links");
    }
  }
  return {
    ...options,
    operatorId: bounded("operator", options.operatorId, 128),
    requestId: bounded("request-id", options.requestId, 160),
    reason: bounded("reason", options.reason, 1000),
  };
}

export async function rehomePlotnovelSourceItems(db: PrismaClient, rawOptions: RehomeOptions): Promise<RehomeReport> {
  const options = validateOptions(rawOptions);

  if (!options.apply) {
    return db.$transaction(async (tx) => {
      const scope = await resolveScope(tx);
      const found = await inspect(tx, scope, false);
      return {
        mode: "dry-run" as const,
        sourceChannelAppId: scope.sourceAppId,
        targetChannelAppId: scope.targetAppId,
        targetStatus: scope.targetStatus,
        agencyIds: scope.agencyIds,
        counts: found.counts,
        blockers: found.blockers,
        blocked: isBlocked(found.blockers),
        noop: found.counts.sourceItems === 0,
        applied: null,
      };
    }, { timeout: 120_000 });
  }

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${ADVISORY_LOCK_KEY}, 0))::text AS lock_result
    `;
    const scope = await resolveScope(tx);
    const found = await inspect(tx, scope, true);
    const base = {
      mode: "apply" as const,
      sourceChannelAppId: scope.sourceAppId,
      targetChannelAppId: scope.targetAppId,
      targetStatus: scope.targetStatus,
      agencyIds: scope.agencyIds,
      counts: found.counts,
      blockers: found.blockers,
    };

    // 第二次跑：没有要挪的书，一行不动。数量闸门只保护"真的要写"的那一次。
    if (found.counts.sourceItems === 0) {
      return { ...base, blocked: isBlocked(found.blockers), noop: true, applied: null };
    }

    if (isBlocked(found.blockers)) throw refusalFor(found.blockers);

    if (found.counts.sourceItems !== options.expectedSourceItems || found.counts.promoLinks !== options.expectedPromoLinks) {
      throw new RehomeRefusedError(
        "count_mismatch",
        `refused: found ${found.counts.sourceItems} source items / ${found.counts.promoLinks} promo links, `
          + `expected ${options.expectedSourceItems} / ${options.expectedPromoLinks}; nothing was written`,
        { found: { sourceItems: found.counts.sourceItems, promoLinks: found.counts.promoLinks }, expected: { sourceItems: options.expectedSourceItems, promoLinks: options.expectedPromoLinks } },
      );
    }

    const replay = await tx.operationAudit.findFirst({
      where: { actorType: "system", action: REHOME_AUDIT_ACTION, requestId: options.requestId },
      select: { id: true },
    });
    if (replay) {
      throw new RehomeRefusedError("request_replay_conflict", "request-id was already used for a rehome apply; use a new request-id");
    }

    const itemIds = found.itemIds;
    const promoIds = found.promoRows.map((row) => row.id);

    // 1) 书目改挂
    const movedItems = await tx.$executeRaw(Prisma.sql`
      UPDATE novel_source_item SET channel_app_id = ${scope.targetAppId}::uuid, updated_at = now()
      WHERE id = ANY(${[...itemIds]}::uuid[]) AND channel_app_id = ${scope.sourceAppId}::uuid
    `);

    // 2) 推广链接改挂 + 按新剧场重算幂等键
    let movedPromos = 0;
    if (promoIds.length > 0) {
      movedPromos = await tx.$executeRaw(Prisma.sql`
        UPDATE promo_link p SET channel_app_id = ${scope.targetAppId}::uuid, idempotency_key = v.new_key, updated_at = now()
        FROM (SELECT unnest(${promoIds}::uuid[]) AS id, unnest(${found.newKeys}::text[]) AS new_key) v
        WHERE p.id = v.id AND p.channel_app_id = ${scope.sourceAppId}::uuid
      `);
    }

    // 3) 副作用意图：目标键跟着换，所属剧场改挂（状态等其它列一律不动）
    let movedIntents = 0;
    if (promoIds.length > 0) {
      movedIntents += await tx.$executeRaw(Prisma.sql`
        UPDATE side_effect_intent i SET target_id = v.new_key
        FROM (SELECT unnest(${found.oldKeys}::text[]) AS old_key, unnest(${found.newKeys}::text[]) AS new_key) v
        WHERE i.target_type = 'promo_link' AND i.target_id = v.old_key
      `);
      await tx.$executeRaw(Prisma.sql`
        UPDATE side_effect_intent i SET channel_app_id = ${scope.targetAppId}::uuid
        WHERE i.channel_app_id = ${scope.sourceAppId}::uuid
          AND (i.promo_link_id = ANY(${promoIds}::uuid[]) OR (i.target_type = 'promo_link' AND i.target_id = ANY(${found.newKeys}::text[])))
      `);
    }

    // 4) 标签：在 PlotNovel 下补齐这批书用到的标签，并把书目的标签关联改指过去
    const createdLabels = await tx.$executeRaw(Prisma.sql`
      INSERT INTO source_label (id, channel_app_id, label_kind, external_label_value, display_value, created_at, updated_at)
      SELECT gen_random_uuid(), ${scope.targetAppId}::uuid, sl.label_kind, sl.external_label_value, max(sl.display_value), now(), now()
      FROM novel_source_item_label nsil
      JOIN source_label sl ON sl.id = nsil.source_label_id
      WHERE nsil.novel_source_item_id = ANY(${[...itemIds]}::uuid[]) AND sl.channel_app_id = ${scope.sourceAppId}::uuid
      GROUP BY sl.label_kind, sl.external_label_value
      ON CONFLICT (channel_app_id, label_kind, external_label_value) DO NOTHING
    `);
    const repointedLinks = await tx.$executeRaw(Prisma.sql`
      UPDATE novel_source_item_label nsil SET source_label_id = target_label.id
      FROM source_label old_label, source_label target_label
      WHERE nsil.novel_source_item_id = ANY(${[...itemIds]}::uuid[])
        AND old_label.id = nsil.source_label_id AND old_label.channel_app_id = ${scope.sourceAppId}::uuid
        AND target_label.channel_app_id = ${scope.targetAppId}::uuid
        AND target_label.label_kind = old_label.label_kind
        AND target_label.external_label_value = old_label.external_label_value
    `);

    // 5) 标签映射边：复制（不是移动）这批书语种范围内的边
    const copiedEdges = await tx.$executeRaw(Prisma.sql`
      INSERT INTO source_label_mapping
        (id, channel_app_id, raw_language_scope, raw_token, canonical_tag_id, mapping_version, active, approved_by, approved_at, created_at, updated_at)
      SELECT gen_random_uuid(), ${scope.targetAppId}::uuid, m.raw_language_scope, m.raw_token, m.canonical_tag_id,
             m.mapping_version, m.active, m.approved_by, m.approved_at, now(), now()
      FROM source_label_mapping m
      WHERE m.channel_app_id = ${scope.sourceAppId}::uuid
        AND m.raw_language_scope IN (
          SELECT DISTINCT raw_language_scope FROM novel_source_item
          WHERE id = ANY(${[...itemIds]}::uuid[]) AND raw_language_scope IS NOT NULL
        )
      ON CONFLICT (channel_app_id, raw_language_scope, raw_token, canonical_tag_id) DO NOTHING
    `);

    // 6) 事后核对：任何一条不成立就整个事务回滚
    const after = await inspectPostConditions(tx, scope, itemIds, promoIds, found.newKeys);
    if (movedItems !== itemIds.length || movedPromos !== promoIds.length || !after.ok) {
      throw new RehomeRefusedError(
        "post_condition_failed",
        `post-condition check failed: moved ${movedItems}/${itemIds.length} items, ${movedPromos}/${promoIds.length} promo links; ${JSON.stringify(after)}`,
        after,
      );
    }

    const idsSha256 = digestIds(itemIds);
    const audit = await tx.operationAudit.create({
      data: {
        actorType: "system",
        actorId: options.operatorId,
        action: REHOME_AUDIT_ACTION,
        entityType: "ChannelApp",
        entityId: scope.targetAppId,
        requestId: options.requestId,
        reason: options.reason,
        beforeSnapshot: {
          sourceChannelAppId: scope.sourceAppId,
          agencyIds: [...scope.agencyIds],
          counts: found.counts,
          sourceItemIdsSha256: idsSha256,
        } as unknown as Prisma.InputJsonValue,
        afterSnapshot: {
          targetChannelAppId: scope.targetAppId,
          rehomedSourceItems: movedItems,
          rehomedPromoLinks: movedPromos,
          rekeyedPromoLinks: movedPromos,
          updatedSideEffectIntents: movedIntents,
          repointedLabelLinks: repointedLinks,
          createdSourceLabels: createdLabels,
          copiedMappingEdges: copiedEdges,
        },
      },
      select: { id: true },
    });

    return {
      ...base,
      blocked: false,
      noop: false,
      applied: {
        rehomedSourceItems: movedItems,
        rehomedPromoLinks: movedPromos,
        rekeyedPromoLinks: movedPromos,
        updatedSideEffectIntents: movedIntents,
        repointedLabelLinks: repointedLinks,
        createdSourceLabels: createdLabels,
        copiedMappingEdges: copiedEdges,
        auditId: audit.id.toString(),
        sourceItemIdsSha256: idsSha256,
      },
    };
  }, { timeout: 300_000, maxWait: 30_000 });
}

async function inspectPostConditions(
  tx: Tx, scope: Scope, itemIds: readonly string[], promoIds: readonly string[], newKeys: readonly string[],
) {
  const [itemsAtSource, itemsAtTarget, promosAtSource, promosMismatchedWithItem, promosWithWrongKey, labelLinksAtSource] = await Promise.all([
    tx.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
      SELECT count(*)::bigint AS n FROM novel_source_item WHERE id = ANY(${[...itemIds]}::uuid[]) AND channel_app_id <> ${scope.targetAppId}::uuid
    `),
    tx.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
      SELECT count(*)::bigint AS n FROM novel_source_item WHERE id = ANY(${[...itemIds]}::uuid[]) AND channel_app_id = ${scope.targetAppId}::uuid
    `),
    promoIds.length === 0 ? Promise.resolve([{ n: 0n }]) : tx.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
      SELECT count(*)::bigint AS n FROM promo_link WHERE id = ANY(${[...promoIds]}::uuid[]) AND channel_app_id <> ${scope.targetAppId}::uuid
    `),
    promoIds.length === 0 ? Promise.resolve([{ n: 0n }]) : tx.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
      SELECT count(*)::bigint AS n FROM promo_link p JOIN novel_source_item s ON s.id = p.novel_source_item_id
      WHERE p.id = ANY(${[...promoIds]}::uuid[]) AND p.channel_app_id <> s.channel_app_id
    `),
    promoIds.length === 0 ? Promise.resolve([{ n: 0n }]) : tx.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
      SELECT count(*)::bigint AS n FROM promo_link WHERE id = ANY(${[...promoIds]}::uuid[]) AND trim(idempotency_key) <> ALL(${[...newKeys]}::text[])
    `),
    tx.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
      SELECT count(*)::bigint AS n
      FROM novel_source_item_label nsil JOIN source_label sl ON sl.id = nsil.source_label_id
      WHERE nsil.novel_source_item_id = ANY(${[...itemIds]}::uuid[]) AND sl.channel_app_id <> ${scope.targetAppId}::uuid
    `),
  ]);
  const result = {
    itemsNotAtTarget: toNumber(itemsAtSource[0]?.n),
    itemsAtTarget: toNumber(itemsAtTarget[0]?.n),
    promosNotAtTarget: toNumber(promosAtSource[0]?.n),
    promosDisagreeingWithTheirItem: toNumber(promosMismatchedWithItem[0]?.n),
    promosWithStaleKey: toNumber(promosWithWrongKey[0]?.n),
    labelLinksStillAtOldTheater: toNumber(labelLinksAtSource[0]?.n),
  };
  return {
    ...result,
    ok: result.itemsNotAtTarget === 0 && result.itemsAtTarget === itemIds.length && result.promosNotAtTarget === 0
      && result.promosDisagreeingWithTheirItem === 0 && result.promosWithStaleKey === 0 && result.labelLinksStillAtOldTheater === 0,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function valueAfter(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new RehomeRefusedError("invalid_arguments", `${name} requires a value`);
  return value;
}

function integerAfter(argv: readonly string[], name: string): number | undefined {
  const raw = valueAfter(argv, name);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new RehomeRefusedError("invalid_arguments", `${name} must be a non-negative integer`);
  return Number(raw);
}

export function parseCliOptions(argv: readonly string[], env: NodeJS.ProcessEnv): RehomeOptions {
  const confirm = valueAfter(argv, "--confirm");
  const expectedSourceItems = integerAfter(argv, "--expected-source-items");
  const expectedPromoLinks = integerAfter(argv, "--expected-promo-links");
  return validateOptions({
    apply: argv.includes("--apply"),
    operatorId: env.PLOTNOVEL_REHOME_OPERATOR ?? "",
    requestId: valueAfter(argv, "--request-id") ?? "",
    reason: valueAfter(argv, "--reason") ?? "",
    ...(confirm !== undefined ? { confirm } : {}),
    ...(expectedSourceItems !== undefined ? { expectedSourceItems } : {}),
    ...(expectedPromoLinks !== undefined ? { expectedPromoLinks } : {}),
  });
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2), process.env);
  const prisma = new PrismaClient();
  try {
    const report = await rehomePlotnovelSourceItems(prisma, options);
    if (report.mode === "dry-run") console.log("[DRY RUN - no changes written; pass --apply with --confirm and the expected counts to write]");
    console.log(JSON.stringify(report, null, 2));
    if (report.mode === "dry-run" && report.blocked) process.exitCode = 2;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    if (error instanceof RehomeRefusedError) {
      console.error(`${error.code}: ${error.message}`);
      if (error.detail !== undefined) console.error(JSON.stringify(error.detail, null, 2));
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  });
}
