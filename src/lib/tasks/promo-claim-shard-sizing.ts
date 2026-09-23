/**
 * 领推广链接批次生命周期：分片大小的"实测吞吐取样"逻辑（设计 §5.3 第一步，
 * `docs/adr/ADR-PROMO-CLAIM-BATCH-LIFECYCLE.md`）。
 *
 * 阶段2 第2步最初把这段逻辑写在 `worker/handlers/catalog-batch.ts`
 * 里（枚举时用它算每个渠道账号分组的分片大小）。阶段2 第4步（施工任务 3.6）
 * 需要在目录同步页提交前预估"预计分 N 片、预计耗时 X 小时"，必须复用**同一
 * 套** p90 取样 + `computeShardSize` 逻辑，不能再写第二份——两份实现一旦
 * 参数或口径漂移，提交前的预估和枚举时真正切出来的分片数就会对不上，运营
 * 看到的预计值会变成一句谎言。抽成这个独立模块，worker 枚举与 Web 侧的
 * 预估共用同一个函数。
 *
 * 只读一张已完成条目的执行耗时聚合，不写任何数据；接受
 * `PrismaClient | Prisma.TransactionClient`，worker 在枚举事务内传
 * `tx`，Web 侧预估传普通的 `PrismaClient`。
 */
import { Prisma, type PrismaClient } from "@prisma/client";

import { PROMO_LINK_CLAIM_TASK_TYPE } from "./promo-link-claim-limits";
import { computeShardSize, PROMO_CLAIM_LIFECYCLE_DEFAULTS, type PromoClaimLifecycleConfig } from "./promo-claim-lifecycle";

type Db = PrismaClient | Prisma.TransactionClient;

export type LifecycleSizingBasis = Readonly<{
  p90Seconds: number;
  sampleCount: number;
  source: "measured_recent_completed_items" | "fallback_insufficient_sample";
}>;

/** 样本量门槛——低于这个数量即使 p90 算出来了也不采信，回退到保守默认值。 */
export const LIFECYCLE_MIN_SAMPLE_COUNT = 50;

/**
 * 设计 §5.3 第一步：该渠道账号最近 500 条已结束 `promo_link.claim.v1` 条目
 * （`started_at`/`finished_at` 均非空——`maxAttempts: 1` 且该任务类型从不产生
 * `retry` 结局，所以这个条件就是"已终态"）的执行耗时 p90（秒）与样本量。
 * 样本为空时 `p90Seconds` 为 `null`；调用方按"样本量 < 50"决定是否改用回退值
 * （设计原文"样本不足(例如 < 50 条)按 5 秒"），而不是依赖 `computeShardSize`
 * 内部"非正数才回退"的兜底——那条兜底只保证"没有样本"时安全，这里还要额外
 * 保证"样本太少、统计意义不足"时同样回退。
 */
export async function measureRecentShardP90(
  db: Db,
  channelAccountId: string,
): Promise<{ p90Seconds: number | null; sampleCount: number }> {
  const rows = await db.$queryRaw<Array<{ p90_seconds: number | null; sample_count: number }>>(Prisma.sql`
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

/** 按渠道账号解析分片大小与它的计算依据——枚举（worker）与提交前预估（Web）共用。 */
export async function resolveLifecycleShardSize(
  db: Db,
  channelAccountId: string,
  config: Pick<PromoClaimLifecycleConfig, "shardWindowMinutes" | "shardSizeMin" | "shardSizeMax">,
): Promise<{ shardSize: number; sizingBasis: LifecycleSizingBasis }> {
  const { p90Seconds, sampleCount } = await measureRecentShardP90(db, channelAccountId);
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
