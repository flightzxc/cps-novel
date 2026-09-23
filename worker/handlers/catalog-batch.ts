import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { NormalizedCatalogSelection } from "../../src/domain/catalog-batch";
import { evaluateNovelMaterializationLocale } from "../../src/domain/novel-materialization-locale";
import {
  CATALOG_BATCH_ENUM_ELIGIBILITY_POLICY_V1,
  CATALOG_BATCH_ENUM_ELIGIBILITY_POLICY_V2,
  CATALOG_BATCH_CHUNK_SIZE, CATALOG_BATCH_TASK_TYPE,
  CONTENT_CREATE_TARGET_TYPE,
  NOVEL_MATERIALIZE_TASK_TYPE, NOVEL_MATERIALIZE_TARGET_TYPE,
  type CatalogBatchPayload,
} from "../../src/lib/tasks/catalog-batch";
import {
  LEGACY_CONTENT_CREATE_RETIRED_CODE,
  LEGACY_CONTENT_CREATE_RETIRED_MESSAGE,
} from "../../src/lib/tasks/legacy-content-create";
import { operationScopeHash, UPSTREAM_EXISTING_PROMO_OFFER_TYPE } from "../../src/lib/tasks/promo-link-claim";
import {
  PROMO_LINK_CLAIM_CAPABILITY_KEY,
  PROMO_LINK_CLAIM_TARGET_TYPE,
  PROMO_LINK_CLAIM_TASK_TYPE,
} from "../../src/lib/tasks/promo-link-claim-limits";
import {
  computeShardSize,
  PROMO_CLAIM_LIFECYCLE_DEFAULTS,
  PROMO_CLAIM_LIFECYCLE_ROLE_BATCH,
  PROMO_CLAIM_LIFECYCLE_ROLE_SHARD,
  PROMO_CLAIM_LIFECYCLE_VERSION,
  PROMO_CLAIM_SHARD_LIFECYCLE_TAG,
  resolvePromoClaimLifecycleConfig,
  type PromoClaimLifecycleConfig,
} from "../../src/lib/tasks/promo-claim-lifecycle";
import { mergeTaskControlResult } from "../../src/lib/tasks/task-control";
import { createHandlerRegistry, type TaskHandler } from "../../src/lib/tasks";
import { isPromoLinkClaimEnabled, isPromoLinkClaimWriteAllowed } from "../../src/lib/flags";

type SnapshotRow = { id: string; channelAppId: string; sourceLocale: string | null; status: string; novelId: string | null };
const ROW_SELECT = { id: true, channelAppId: true, sourceLocale: true, status: true, novelId: true } as const;

export function parsePayload(value: unknown): CatalogBatchPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("catalog_batch_payload_invalid");
  const p = value as Partial<CatalogBatchPayload>;
  if ((p.operation !== "content_create" && p.operation !== "promo_claim" && p.operation !== "novel_materialize") || !p.selection
    || typeof p.actorId !== "string" || !p.actorId || typeof p.requestId !== "string" || !p.requestId
    || typeof p.submittedAt !== "string" || !Number.isFinite(Date.parse(p.submittedAt))
    || typeof p.expiresAt !== "string" || !Number.isFinite(Date.parse(p.expiresAt))) throw new Error("catalog_batch_payload_invalid");
  if (p.selection.scope === "explicit_ids") {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!Array.isArray(p.selection.ids) || p.selection.ids.some((id) => typeof id !== "string" || !uuid.test(id))) throw new Error("catalog_batch_payload_invalid");
  } else if (p.selection.scope !== "all_filtered" || !p.selection.filter || typeof p.selection.filter.status !== "string") {
    throw new Error("catalog_batch_payload_invalid");
  }
  for (const record of [p.channelAccounts, p.templateKeysByLocale]) {
    if (record !== undefined && (!record || typeof record !== "object" || Array.isArray(record)
      || Object.entries(record).some(([key, item]) => !key || typeof item !== "string" || !item))) throw new Error("catalog_batch_payload_invalid");
  }
  const enumEligibilityPolicyVersion = p.enumEligibilityPolicyVersion === undefined
    ? CATALOG_BATCH_ENUM_ELIGIBILITY_POLICY_V1
    : p.enumEligibilityPolicyVersion;
  if (
    (enumEligibilityPolicyVersion !== CATALOG_BATCH_ENUM_ELIGIBILITY_POLICY_V1
      && enumEligibilityPolicyVersion !== CATALOG_BATCH_ENUM_ELIGIBILITY_POLICY_V2)
    || (enumEligibilityPolicyVersion === CATALOG_BATCH_ENUM_ELIGIBILITY_POLICY_V2
      && p.operation !== "novel_materialize")
  ) {
    throw new Error("catalog_batch_payload_invalid");
  }
  // 阶段2 第2步：批次自己的 lifecycleVersion/lifecycleRole/approvedAt/
  // approvalValidUntil 四个字段要么一起出现,要么一起缺席（`src/lib/tasks/
  // catalog-batch.ts` 的 `enqueueCatalogBatch` 只会一起写）——半个不认识
  // 的组合一律拒绝解析,而不是猜测式地各自独立生效。角色在这一层被固定断言
  // 为 "batch"：`worker/handlers/catalog-batch.ts` 自己创建的分片子任务从不
  // 经过这个函数解析（分片是 `promo_link.claim.v1`，由 `worker/handlers/
  // promo-link-claim.ts` 解析自己的载荷）。
  if (
    p.lifecycleVersion !== undefined || p.lifecycleRole !== undefined
    || p.approvedAt !== undefined || p.approvalValidUntil !== undefined
  ) {
    if (
      p.lifecycleVersion !== PROMO_CLAIM_LIFECYCLE_VERSION
      || p.lifecycleRole !== PROMO_CLAIM_LIFECYCLE_ROLE_BATCH
      || p.operation !== "promo_claim"
      || typeof p.approvedAt !== "string" || !Number.isFinite(Date.parse(p.approvedAt))
      || typeof p.approvalValidUntil !== "string" || !Number.isFinite(Date.parse(p.approvalValidUntil))
    ) {
      throw new Error("catalog_batch_payload_invalid");
    }
  }
  return { ...p, enumEligibilityPolicyVersion } as CatalogBatchPayload;
}

/** True exactly for a 阶段2 lifecycle batch (设计 §5.2) — judged purely from the persisted payload, never by re-reading the enable switch (see `catalog-batch.ts`'s `enqueueCatalogBatch` doc comment on why). */
export function isLifecycleBatchPayload(payload: CatalogBatchPayload): boolean {
  return payload.operation === "promo_claim"
    && payload.lifecycleVersion === PROMO_CLAIM_LIFECYCLE_VERSION
    && payload.lifecycleRole === PROMO_CLAIM_LIFECYCLE_ROLE_BATCH;
}

export type LifecycleSizingBasis = Readonly<{
  p90Seconds: number;
  sampleCount: number;
  source: "measured_recent_completed_items" | "fallback_insufficient_sample";
}>;

export type LifecycleShardGroupPlan = Readonly<{
  channelAppId: string;
  channelAccountId: string;
  memberCount: number;
  shardSize: number;
  shardCount: number;
  sizingBasis: LifecycleSizingBasis;
}>;

export type LifecycleShardPlan = Readonly<{
  windowMinutes: number;
  shardSizeMin: number;
  shardSizeMax: number;
  shardCount: number;
  groups: readonly LifecycleShardGroupPlan[];
  shardSize?: number;
  sizingBasis?: LifecycleSizingBasis;
}>;

/**
 * 阶段2 第2步（设计 §5.2）：pure construction of the batch's own
 * `result.shardPlan`, extracted for unit testing. Multiple groups (a batch's
 * `channelAccounts` map can route more than one channelApp to distinct
 * accounts, each with its own historical throughput) never collapse into a
 * single `shardSize`/`sizingBasis` — those two convenience top-level fields
 * (matching 设计 §5.2's flat example shape) are only populated when the batch
 * touched exactly one (channelAppId, channelAccountId) group, which is the
 * overwhelmingly common real-world shape (one operator submission, one
 * channel account). `groups` always carries the full per-group breakdown
 * regardless.
 */
export function buildLifecycleShardPlan(
  groupPlans: readonly LifecycleShardGroupPlan[],
  config: Pick<PromoClaimLifecycleConfig, "shardWindowMinutes" | "shardSizeMin" | "shardSizeMax">,
): LifecycleShardPlan {
  return {
    windowMinutes: config.shardWindowMinutes,
    shardSizeMin: config.shardSizeMin,
    shardSizeMax: config.shardSizeMax,
    shardCount: groupPlans.reduce((sum, group) => sum + group.shardCount, 0),
    groups: groupPlans,
    ...(groupPlans.length === 1
      ? { shardSize: groupPlans[0]!.shardSize, sizingBasis: groupPlans[0]!.sizingBasis }
      : {}),
  };
}

/**
 * 阶段2 第2步（设计 §5.3）：splits `members` into consecutive shards of at
 * most `shardSize` each, preserving order — pure bucketing logic extracted
 * for unit testing of the boundary cases (exact division, remainder, a
 * single member, `shardSize` at or above `members.length`). `shardSize` must
 * be a positive integer (guaranteed by `computeShardSize`'s own `min`/`max`
 * clamp, both of which are positive per `promo-claim-lifecycle.ts`'s config
 * resolution); a non-positive `shardSize` would loop forever, so this
 * asserts rather than silently producing an empty result.
 */
export function chunkMembersIntoShards<T>(members: readonly T[], shardSize: number): T[][] {
  if (!Number.isFinite(shardSize) || shardSize <= 0) {
    throw new Error(`chunkMembersIntoShards: shardSize must be a positive integer, got ${shardSize}`);
  }
  const shards: T[][] = [];
  for (let i = 0; i < members.length; i += shardSize) shards.push(members.slice(i, i + shardSize));
  return shards;
}

/**
 * 设计 §5.3 第一步：该渠道账号最近 500 条已结束 `promo_link.claim.v1` 条目
 * （`started_at`/`finished_at` 均非空——`maxAttempts: 1` 且该任务类型从不产生
 * `retry` 结局，所以这个条件就是"已终态"）的执行耗时 p90（秒）与样本量。
 * 样本为空时 `p90Seconds` 为 `null`；调用方按"样本量 < 50"决定是否改用回退值
 * （设计原文"样本不足(例如 < 50 条)按 5 秒"），而不是依赖 `computeShardSize`
 * 内部“非正数才回退”的兜底——那条兜底只保证"没有样本"时安全，这里还要额外
 * 保证"样本太少、统计意义不足"时同样回退。
 */
async function measureRecentShardP90(
  tx: Prisma.TransactionClient,
  channelAccountId: string,
): Promise<{ p90Seconds: number | null; sampleCount: number }> {
  const rows = await tx.$queryRaw<Array<{ p90_seconds: number | null; sample_count: number }>>(Prisma.sql`
    SELECT
      percentile_cont(0.9) WITHIN GROUP (ORDER BY recent.duration_seconds) AS p90_seconds,
      count(*)::int AS sample_count
    FROM (
      SELECT EXTRACT(EPOCH FROM (i.finished_at - i.started_at)) AS duration_seconds
      FROM generic_task_item i
      JOIN generic_task t ON t.id = i.task_id
      WHERE t.task_type = ${PROMO_LINK_CLAIM_TASK_TYPE}
        AND t.channel_account_id = ${channelAccountId}::uuid
        AND i.started_at IS NOT NULL
        AND i.finished_at IS NOT NULL
      ORDER BY i.finished_at DESC
      LIMIT 500
    ) recent
  `);
  const row = rows[0];
  return { p90Seconds: row?.p90_seconds ?? null, sampleCount: row?.sample_count ?? 0 };
}

const LIFECYCLE_MIN_SAMPLE_COUNT = 50;

async function resolveLifecycleShardSize(
  tx: Prisma.TransactionClient,
  channelAccountId: string,
  config: PromoClaimLifecycleConfig,
): Promise<{ shardSize: number; sizingBasis: LifecycleSizingBasis }> {
  const { p90Seconds, sampleCount } = await measureRecentShardP90(tx, channelAccountId);
  const sufficientSample = sampleCount >= LIFECYCLE_MIN_SAMPLE_COUNT && p90Seconds !== null && p90Seconds > 0;
  const effectiveP90 = sufficientSample ? p90Seconds! : PROMO_CLAIM_LIFECYCLE_DEFAULTS.fallbackP90ItemSeconds;
  const shardSize = computeShardSize({
    p90ItemSeconds: sufficientSample ? p90Seconds : null,
    windowMinutes: config.shardWindowMinutes,
    min: config.shardSizeMin,
    max: config.shardSizeMax,
  });
  return {
    shardSize,
    sizingBasis: {
      p90Seconds: effectiveP90,
      sampleCount,
      source: sufficientSample ? "measured_recent_completed_items" : "fallback_insufficient_sample",
    },
  };
}

function selectionWhere(selection: NormalizedCatalogSelection): Prisma.NovelSourceItemWhereInput {
  if (selection.scope === "explicit_ids") return { deletedAt: null };
  const f = selection.filter;
  return { deletedAt: null, status: f.status,
    ...(f.search ? { title: { contains: f.search, mode: "insensitive" } } : {}),
    ...(f.sourceLocale ? { sourceLocale: f.sourceLocale === "__unknown" ? null : f.sourceLocale } : {}),
  };
}

async function streamSelection(
  tx: Prisma.TransactionClient,
  selection: NormalizedCatalogSelection,
  visit: (rows: readonly SnapshotRow[]) => Promise<void>,
): Promise<void> {
  if (selection.scope === "explicit_ids") {
    for (let i = 0; i < selection.ids.length; i += CATALOG_BATCH_CHUNK_SIZE) {
      const rows = await tx.novelSourceItem.findMany({
        where: { ...selectionWhere(selection), id: { in: selection.ids.slice(i, i + CATALOG_BATCH_CHUNK_SIZE) } },
        orderBy: { id: "asc" }, select: ROW_SELECT,
      });
      await visit(rows);
    }
    return;
  }
  let after: string | undefined;
  while (true) {
    const rows = await tx.novelSourceItem.findMany({
      where: { ...selectionWhere(selection), ...(after ? { id: { gt: after } } : {}) },
      orderBy: { id: "asc" }, take: CATALOG_BATCH_CHUNK_SIZE, select: ROW_SELECT,
    });
    if (!rows.length) return;
    await visit(rows); after = rows.at(-1)!.id;
    if (rows.length < CATALOG_BATCH_CHUNK_SIZE) return;
  }
}

function childToken(parentId: string, operation: string, group: string): string {
  return `catalog_child:${createHash("sha256").update(`${parentId}\n${operation}\n${group}`).digest("hex")}`;
}

export function createCatalogBatchHandler(
  db: PrismaClient,
  dependencies: { env?: NodeJS.ProcessEnv } = {},
): TaskHandler {
  void db;
  const env = dependencies.env ?? process.env;
  // Resolved once at handler construction, same "fail fast at startup on a
  // config typo" discipline as `worker/handlers/promo-link-claim.ts`'s own
  // `readbackPolicy`/`lifecycleConfig`. Only `shardWindowMinutes`/
  // `shardSizeMin`/`shardSizeMax` are ever read below (enumeration-time
  // concerns); `approvalTtlMinutes` belongs to enqueue time
  // (`src/lib/tasks/catalog-batch.ts`) and `credentialSafetyMarginMinutes`/
  // `deadlineGraceMinutes` belong to the scheduler/handler (steps 3/1).
  const lifecycleConfig = resolvePromoClaimLifecycleConfig(env);
  return async ({ lease }) => {
    if (lease.taskType !== CATALOG_BATCH_TASK_TYPE || lease.itemId === "") throw new Error("catalog_batch_lease_invalid");
    const payload = parsePayload(lease.payload);
    const enumEligibilityPolicyVersion = payload.enumEligibilityPolicyVersion!;
    // 阶段2 第2步：judged purely from the persisted payload (stamped once at
    // enqueue time by `enqueueCatalogBatch`), never by re-reading the switch
    // here — see that function's own doc comment (D8: a batch's lifecycle
    // never changes semantics after creation).
    const isLifecycleBatch = isLifecycleBatchPayload(payload);
    return {
      status: "success",
      transactionIsolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      transactionTimeoutMs: 120_000,
      protectedWrite: async (tx) => {
        if (payload.operation === "content_create") {
          await tx.genericTask.update({
            where: { id: lease.taskId },
            data: {
              result: {
                enumerationStatus: "failed",
                reason: LEGACY_CONTENT_CREATE_RETIRED_CODE,
                message: LEGACY_CONTENT_CREATE_RETIRED_MESSAGE,
                enumEligibilityPolicyVersion,
              },
            },
          });
          return {
            status: "failed",
            error: { code: LEGACY_CONTENT_CREATE_RETIRED_CODE, message: LEGACY_CONTENT_CREATE_RETIRED_MESSAGE },
            result: { enumerationStatus: "failed", reason: LEGACY_CONTENT_CREATE_RETIRED_CODE, enumEligibilityPolicyVersion },
          };
        }
        const expiry = Date.parse(payload.expiresAt);
        if (!Number.isFinite(expiry) || Date.now() >= expiry) {
          await tx.genericTask.update({ where: { id: lease.taskId }, data: { result: {
            enumerationStatus: "expired", submittedCount: 0, ineligibleCount: 0,
            expiresAt: payload.expiresAt, enumEligibilityPolicyVersion,
          } } });
          return { status: "skipped", result: { enumerationStatus: "expired", enumEligibilityPolicyVersion } };
        }

        const groups = new Map<string, SnapshotRow[]>();
        let selectedCount = payload.selection.scope === "explicit_ids" ? payload.selection.ids.length : 0;
        let observedCount = 0;
        let submittedCount = 0;
        let ineligibleCount = 0;
        let alreadyLinkedCount = 0;
        const blockedReasonCounts: Record<string, number> = {};
        await streamSelection(tx, payload.selection, async (rows) => {
          if (payload.selection.scope === "all_filtered") selectedCount += rows.length;
          observedCount += rows.length;
          let activePromo = new Set<string>();
          if (payload.operation === "promo_claim" && rows.length) {
            const active = await tx.genericTaskItem.findMany({ where: {
              targetType: CONTENT_CREATE_TARGET_TYPE, targetId: { in: rows.map((r) => r.id) },
              task: { taskType: PROMO_LINK_CLAIM_TASK_TYPE, status: { in: ["pending", "processing"] } },
            }, select: { targetId: true } });
            activePromo = new Set(active.map((r) => r.targetId));
          }
          for (const row of rows) {
            if (payload.operation === "promo_claim" && activePromo.has(row.id)) {
              blockedReasonCounts.active_item_conflict = (blockedReasonCounts.active_item_conflict ?? 0) + 1;
              continue;
            }
            if (payload.operation === "novel_materialize" && row.status === "linked" && row.novelId !== null) {
              alreadyLinkedCount += 1;
              continue;
            }
            const eligible = payload.operation === "novel_materialize"
              ? row.status === "pending" && row.novelId === null
              : row.status === "linked" && row.novelId !== null;
            if (!eligible) { ineligibleCount += 1; continue; }
            if (
              payload.operation === "novel_materialize"
              && enumEligibilityPolicyVersion === CATALOG_BATCH_ENUM_ELIGIBILITY_POLICY_V2
            ) {
              const localeEligibility = evaluateNovelMaterializationLocale(row.sourceLocale);
              if (!localeEligibility.eligible) {
                blockedReasonCounts[localeEligibility.code] = (blockedReasonCounts[localeEligibility.code] ?? 0) + 1;
                continue;
              }
            }
            const accountId = payload.operation === "promo_claim" ? payload.channelAccounts?.[row.channelAppId] : undefined;
            if (payload.operation === "promo_claim" && !accountId) {
              blockedReasonCounts.channel_account_required = (blockedReasonCounts.channel_account_required ?? 0) + 1;
              continue;
            }
            const key = payload.operation === "promo_claim" ? `${row.channelAppId}\n${accountId}` : row.channelAppId;
            const bucket = groups.get(key) ?? [];
            bucket.push(row); groups.set(key, bucket); submittedCount += 1;
          }
        });
        if (payload.selection.scope === "explicit_ids") ineligibleCount += selectedCount - observedCount;

        let childTaskCount = 0;
        // 阶段2 第2步（设计 §5.2/§5.3）：per-group sizing basis, one entry per
        // (channelAppId, channelAccountId) group this lifecycle batch touched
        // — a batch's `channelAccounts` map can route more than one
        // channelApp to distinct accounts (or, less commonly, the same
        // account), each with its own historical throughput, so the p90/
        // shard size is never assumed to be a single batch-wide number.
        // Folded into the batch's own `result.shardPlan` below.
        const shardGroupPlans: LifecycleShardGroupPlan[] = [];
        const enumeratedAt = new Date().toISOString();
        for (const [groupKey, members] of groups) {
          const channelAppId = members[0]!.channelAppId;
          const channelAccountId = payload.operation === "promo_claim" ? payload.channelAccounts![channelAppId]! : null;
          if (payload.operation === "promo_claim") {
            const binding = await tx.channelApp.findFirst({ where: {
              id: channelAppId, status: "active", channel: { status: "active", channelAccounts: { some: { id: channelAccountId!, status: "active", deletedAt: null } } },
              capabilities: { some: { capabilityKey: PROMO_LINK_CLAIM_CAPABILITY_KEY, status: "enabled" } },
            }, select: { id: true } });
            if (!binding) {
              blockedReasonCounts.channel_binding_or_capability_unavailable = (blockedReasonCounts.channel_binding_or_capability_unavailable ?? 0) + members.length;
              submittedCount -= members.length;
              continue;
            }
          }

          if (isLifecycleBatch) {
            // 设计 §5.3：每个分组内按现有成员顺序（`members` 的顺序即
            // `streamSelection` 按 id 升序流式读取的顺序，未被本步改变）每 S
            // 本切成一个分片。分片一律建成 disabled + awaiting_release——不
            // 走旧的 `isPromoLinkClaimEnabled`/`isPromoLinkClaimWriteAllowed`
            // 双闸判断（那是给"立即可跑的子任务"设计的）。真正放行前的 promo
            // 功能开关检查是第3步 scheduler 的职责；`worker/handlers/
            // promo-link-claim.ts` 自身在真正执行时仍会独立检查
            // `isPromoLinkClaimEnabled`，所以即使开关中途被关闭，分片也不会被
            // 错误执行。
            //
            // 也不查旧的 `active_scope_conflict`（每片的 `operationScopeHash`
            // 由这一片自己的书目集合算出，天然与其它分片、其它批次不同，
            // 结构上不会撞见活跃范围唯一约束）。这不代表跨批次并发提交完全
            // 不可能让同一本书出现在两个尚未放行的分片里——`activePromo` 逐
            // 条目过滤只挡 `status IN ('pending','processing')` 的任务，挡不住
            // 挂在另一个"仍在排队、尚未放行"的 disabled 分片下的书（旧路径
            // 双闸关闭时的 disabled 子任务同样有这个盲区，非本步新增）。真正
            // 防止对同一本书重复调用非幂等 getcode 的是 handler 里完全未改动
            // 的红线：`SideEffectIntent` 唯一性、`PromoLink.idempotencyKey`
            // upsert、以及 `existingPromoLink?.status === "fetched"` 的提前
            // 短路——这三层在条目真正执行时生效，与它挂在哪个任务/分片下无关。
            const { shardSize, sizingBasis } = await resolveLifecycleShardSize(tx, channelAccountId!, lifecycleConfig);
            const shardBuckets = chunkMembersIntoShards(members, shardSize);
            for (const [shardIndex, shardMembers] of shardBuckets.entries()) {
              const scopeHash = operationScopeHash(
                shardMembers.map((m) => ({ novelSourceItemId: m.id, offerType: UPSTREAM_EXISTING_PROMO_OFFER_TYPE })),
              );
              const shardId = randomUUID();
              await tx.genericTask.create({ data: {
                id: shardId, parentTaskId: lease.taskId, taskType: PROMO_LINK_CLAIM_TASK_TYPE, channelAppId, channelAccountId,
                operationScopeHash: scopeHash, mode: "apply", status: "disabled",
                requestToken: childToken(lease.taskId, payload.operation, `${groupKey}\nshard:${shardIndex}`),
                totalCount: shardMembers.length,
                params: {
                  actorId: payload.actorId, requestId: payload.requestId, submittedAt: payload.submittedAt,
                  expiresAt: payload.expiresAt,
                  lifecycleVersion: PROMO_CLAIM_LIFECYCLE_VERSION,
                  lifecycleRole: PROMO_CLAIM_LIFECYCLE_ROLE_SHARD,
                  shardIndex,
                  releaseCount: 0,
                  missedDeadlineCount: 0,
                  // releasedAt/deadlineAt intentionally absent until the
                  // scheduler (step 3) releases this shard (设计 §5.3).
                },
                result: mergeTaskControlResult(undefined, {
                  kind: "awaiting_release",
                  source: "system",
                  at: enumeratedAt,
                }),
              } });
              childTaskCount += 1;
              for (let i = 0; i < shardMembers.length; i += CATALOG_BATCH_CHUNK_SIZE) {
                await tx.genericTaskItem.createMany({ data: shardMembers.slice(i, i + CATALOG_BATCH_CHUNK_SIZE).map((member) => ({
                  taskId: shardId,
                  targetType: PROMO_LINK_CLAIM_TARGET_TYPE,
                  targetId: member.id,
                  payload: {
                    novelSourceItemId: member.id, offerType: UPSTREAM_EXISTING_PROMO_OFFER_TYPE,
                    channelAccountId: channelAccountId!, channelAppId, actorId: payload.actorId,
                    requestId: `${payload.requestId}:${member.id}`,
                    // 兼容值（可解析，但 handler 对 shard_v1 条目不再据此判断
                    // 过期——只看任务级 params.deadlineAt，由 scheduler 放行时
                    // 写入。见 src/lib/tasks/promo-claim-lifecycle.ts 与
                    // worker/handlers/promo-link-claim.ts 对 shard_v1 的说明。
                    expiresAt: payload.expiresAt,
                    lifecycle: PROMO_CLAIM_SHARD_LIFECYCLE_TAG,
                  },
                })) });
              }
              await tx.operationAudit.create({ data: {
                actorType: "worker", actorId: lease.workerId, action: `${PROMO_LINK_CLAIM_TASK_TYPE}.queued`,
                entityType: "GenericTask", entityId: shardId, requestId: payload.requestId,
                taskType: PROMO_LINK_CLAIM_TASK_TYPE, taskId: shardId,
                afterSnapshot: {
                  parentTaskId: lease.taskId,
                  eligibleCount: shardMembers.length,
                  expiresAt: payload.expiresAt,
                  enumEligibilityPolicyVersion,
                  shardIndex,
                  shardCount: shardBuckets.length,
                },
              } });
            }
            shardGroupPlans.push({
              channelAppId, channelAccountId: channelAccountId!, memberCount: members.length,
              shardSize, shardCount: shardBuckets.length, sizingBasis,
            });
            continue;
          }

          const taskType = payload.operation === "promo_claim" ? PROMO_LINK_CLAIM_TASK_TYPE : NOVEL_MATERIALIZE_TASK_TYPE;
          const promoFeatureEnabled = isPromoLinkClaimEnabled();
          const promoWriteAllowed = isPromoLinkClaimWriteAllowed();
          const childStatus = payload.operation === "promo_claim" && (!promoFeatureEnabled || !promoWriteAllowed) ? "disabled" : "pending";
          const scopeHash = payload.operation === "promo_claim"
            ? operationScopeHash(members.map((m) => ({ novelSourceItemId: m.id, offerType: UPSTREAM_EXISTING_PROMO_OFFER_TYPE })))
            : createHash("sha256").update(JSON.stringify(members.map((m) => m.id).sort())).digest("hex");
          const existingScope = await tx.genericTask.findFirst({ where: {
            taskType, channelAppId, channelAccountId,
            operationScopeHash: scopeHash, status: { in: ["pending", "processing"] },
          }, select: { id: true } });
          if (existingScope) {
            blockedReasonCounts.active_scope_conflict = (blockedReasonCounts.active_scope_conflict ?? 0) + members.length;
            submittedCount -= members.length;
            continue;
          }
          const childId = randomUUID();
          await tx.genericTask.create({ data: {
            id: childId, parentTaskId: lease.taskId, taskType, channelAppId, channelAccountId,
            operationScopeHash: scopeHash, mode: "apply", status: childStatus,
            requestToken: childToken(lease.taskId, payload.operation, groupKey), totalCount: members.length,
            params: { actorId: payload.actorId, requestId: payload.requestId, submittedAt: payload.submittedAt, expiresAt: payload.expiresAt,
              ...(payload.operation === "promo_claim" ? { featureFlagEnabled: promoFeatureEnabled, allowWriteEnabled: promoWriteAllowed } : {}) },
          } });
          childTaskCount += 1;
          for (let i = 0; i < members.length; i += CATALOG_BATCH_CHUNK_SIZE) {
            await tx.genericTaskItem.createMany({ data: members.slice(i, i + CATALOG_BATCH_CHUNK_SIZE).map((member) => ({
              taskId: childId,
              targetType: payload.operation === "promo_claim" ? "novel_source_item" : NOVEL_MATERIALIZE_TARGET_TYPE,
              targetId: member.id,
              payload: payload.operation === "promo_claim" ? {
                novelSourceItemId: member.id, offerType: UPSTREAM_EXISTING_PROMO_OFFER_TYPE,
                channelAccountId: channelAccountId!, channelAppId, actorId: payload.actorId,
                requestId: `${payload.requestId}:${member.id}`, expiresAt: payload.expiresAt,
              } : {
                novelSourceItemId: member.id, channelAppId, actorId: payload.actorId,
                requestId: `${payload.requestId}:${member.id}`, expiresAt: payload.expiresAt,
              },
            })) });
          }
          await tx.operationAudit.create({ data: {
            actorType: "worker", actorId: lease.workerId, action: `${taskType}.queued`,
            entityType: "GenericTask", entityId: childId, requestId: payload.requestId,
            taskType, taskId: childId,
            afterSnapshot: {
              parentTaskId: lease.taskId,
              eligibleCount: members.length,
              expiresAt: payload.expiresAt,
              enumEligibilityPolicyVersion,
            },
          } });
        }
        const blockedCount = Object.values(blockedReasonCounts).reduce((sum, count) => sum + count, 0);
        // 设计 §5.2：批次结果写入 shardPlan（构造逻辑见 `buildLifecycleShardPlan`
        // 的文档注释——多个渠道账号分组时没有单一的 shardSize/sizingBasis）。
        const shardPlan = isLifecycleBatch ? buildLifecycleShardPlan(shardGroupPlans, lifecycleConfig) : undefined;
        await tx.genericTask.update({ where: { id: lease.taskId }, data: { result: {
          enumerationStatus: "completed", selectedCount, submittedCount, ineligibleCount, alreadyLinkedCount,
          blockedCount, failedCount: 0,
          childTaskCount, blockedReasonCounts, expiresAt: payload.expiresAt, enumEligibilityPolicyVersion,
          ...(shardPlan ? { shardPlan } : {}),
        } } });
        await tx.operationAudit.create({ data: {
          actorType: "worker", actorId: lease.workerId, action: "catalog_batch.materialized",
          entityType: "GenericTask", entityId: lease.taskId, requestId: payload.requestId,
          taskType: CATALOG_BATCH_TASK_TYPE, taskId: lease.taskId,
          afterSnapshot: {
            selectedCount, submittedCount, ineligibleCount, alreadyLinkedCount, blockedReasonCounts,
            expiresAt: payload.expiresAt, enumEligibilityPolicyVersion,
            ...(shardPlan ? { shardPlan } : {}),
          },
        } });
        return { status: "success", result: {
          enumerationStatus: "completed", submittedCount, ineligibleCount, alreadyLinkedCount, blockedCount,
          enumEligibilityPolicyVersion,
          ...(shardPlan ? { shardPlan } : {}),
        } };
      },
    };
  };
}

export function createCatalogBatchWorkerHandlers(db: PrismaClient) {
  return createHandlerRegistry({ [CATALOG_BATCH_TASK_TYPE]: { family: "generic", maxAttempts: 3, handler: createCatalogBatchHandler(db) } });
}
