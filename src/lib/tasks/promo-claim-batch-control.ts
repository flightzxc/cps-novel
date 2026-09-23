/**
 * 领推广链接批次生命周期（正式修复第 2 阶段，第 4 步：批次级暂停 / 恢复 /
 * 中止 / 重新批准）。
 *
 * 决策来源：设计 `设计_领推广生命周期与自动分片_阶段2_2026-09-23.md`
 * §5.1/§5.5/§5.8，施工任务 `施工任务_领推广生命周期阶段2_2026-09-23.md`
 * 第 4 步 3.1/3.3。
 *
 * 本模块只做"批次 ↔ 分片"两层的状态级联判定与数据库写入，不做任何 2FA / 幂等
 * 重放（那些是任务管理后台 mutation service 的职责，同 `pauseTask`/
 * `resumeTask`/`abortTask` 已有的分工——这层只管"给定一个已开启的事务 + 已经
 * 通过身份校验的操作者，把批次和它的分片一起改成什么状态"，不关心 HTTP/
 * 会话/审计幂等键怎么解析）。因此这里的函数从不 throw 业务错误，而是返回一个
 * 判别联合（`{ ok: false, error }`），由调用方（那个 mutation service）翻译成
 * 它自己的错误类型——`src/lib/tasks/` 不认识、也不应该认识那个类型，这也是
 * `worker/`、`scheduler/`、`src/lib/tasks/` 禁止出现管理后台 service 模块
 * 那条导入路径字样这条文本守卫的直接体现（若这里 import 那个类型/模块，就会
 * 撞上它——本段说明文字同样刻意不逐字拼出被禁字符串本身）。
 *
 * 三个动作与 `src/lib/tasks/promo-claim-release.ts`（scheduler 放行/暂停）
 * 共用同一份"批次正常与否"判据（`HELD_BATCH_STATUSES`，从那个文件导出）：
 *
 *   - **暂停**：批次不能已经是 paused/cancelled/disabled（正常运行中——包括
 *     它自己的枚举 item 早已 success、raw status 已经变成 completed 的
 *     常见情形——都算"可以暂停"）；批次自身置 `paused`；名下当前处于
 *     `pending`/`processing` 的分片（D6 保证至多一个）同样置 `paused`；仍在
 *     排队（`disabled` + `awaiting_release` 或任一 `system_hold`）的分片原样
 *     不动——scheduler 的 `selectNextReleasableShard` 已经把
 *     `b.status NOT IN (paused,cancelled,disabled)` 作为选片前提，一个
 *     `paused` 批次不会再有新分片被选中放行。
 *   - **恢复**：只允许从批次自己的 `status === "paused"` 恢复（对称于
 *     `resumeTask` 只接受 `"paused"` 的既有约定）；被暂停的已放行分片
 *     **不得直接改回 `pending`**——一律交还成 `disabled` +
 *     `awaiting_release`，`releaseCount`/`missedDeadlineCount` 等 params
 *     原样保留、一个字段都不碰，重新交给 scheduler 走 D1/D5/D4 全套前置
 *     检查后再放行（`promo-claim-release.ts` 3.2 节已经把 D4 检查的触发条件
 *     从"只看 `deadline_missed_retry`"放宽成"只要 `releaseCount > 0`"，
 *     专门覆盖这条路径）。批次自身按现有的"重新算一遍"方式恢复
 *     （`status = 'pending'` 之后调用 `recomputeParentTask`，与
 *     `promo-claim-release.ts` 的 `restoreBatchStatus` 同一手法——不猜测
 *     暂停前是什么状态）。
 *   - **中止**：终止态是 `cancelled`，不可逆；批次自身还残留的 pending 条目
 *     （理论上只可能是它自己那一条 `catalog_filter_snapshot` 枚举条目）与
 *     **所有**未终结的分片（`pending`/`processing`/`paused`/`disabled`——
 *     含仍在排队、从未放行过的）一律终止：还是 `pending` 的条目统一标记为
 *     `skipped`（"人工中止前未尝试"），正在 `processing` 的条目不受影响、
 *     照常收尾——绝不触发任何 getcode（这里从不调用领取 handler，只翻状态
 *     位和终止 *pending* 条目，`processing` 中的租约完全不动）。
 *
 * `reapprovePromoClaimBatchTx`（3.3）：只有批次当前恰好停在
 * `system_hold:approval_expired` **且** 从未放行过任何分片
 * （`!('firstReleasedAt' in params)`）时才允许——这两个条件在设计里理论上
 * 应该总是同时成立（`approval_expired` 本身的定义就是"从未放行过"），但故意
 * 分开显式校验，而不是只看 `reasonCode`：如果只看 `reasonCode`，未来
 * `holdBatchSystemHold` 的调用点一旦被改错（例如误把 `approval_expired` 用
 * 到了一个已经放行过分片的批次上），这里会毫无察觉地允许重新批准一个其实
 * 已经在执行中的批次，把执行期批次的截止时间悄悄重置——这正是设计
 * §5.5 明确排除的"做成全批次 TTL"。
 */
import { Prisma } from "@prisma/client";

import { CATALOG_BATCH_TASK_TYPE } from "./catalog-batch";
import { PROMO_LINK_CLAIM_TASK_TYPE } from "./promo-link-claim-limits";
import {
  isLifecycleBatchParams,
  type PromoClaimLifecycleConfig,
} from "./promo-claim-lifecycle";
import { HELD_BATCH_STATUSES } from "./promo-claim-release";
import { mergeTaskControlResult, readTaskControlMarker, type TaskControlMarker } from "./task-control";
import { terminatePendingTaskItems } from "./task-termination";
import { recomputeParentTask } from "./store";

type TxClient = Prisma.TransactionClient;

/**
 * `terminatePendingTaskItems` 的中止原因码，逐字等于任务管理后台 mutation
 * service 模块的 `TASK_ABORT_TERMINATION_REASON`——两处字面量的一致性由
 * `tests/backend/tasks/promo-claim-batch-control.test.ts` 的一条文本一致性
 * 用例守护（`src/lib/tasks/` 不能导入那个 server 层模块，见本文件顶部说明，
 * 所以这里只能是一份独立字面量，不是同一个常量的两处引用）。
 */
export const PROMO_CLAIM_BATCH_ABORT_TERMINATION_REASON = "task_manually_aborted";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function clearTaskControlResult(existingResult: unknown): Record<string, unknown> {
  const base = { ...asRecord(existingResult) };
  delete base.taskControl;
  return base;
}

export type PromoClaimBatchLookupError = "not_found" | "not_lifecycle_batch";
export type PromoClaimBatchControlError = PromoClaimBatchLookupError | "state_conflict";

interface LockedBatchRow {
  readonly id: string;
  readonly status: string;
  readonly params: Record<string, unknown>;
  readonly result: unknown;
}

interface LockedShardRow {
  readonly id: string;
  readonly status: string;
  readonly params: Record<string, unknown>;
  readonly result: unknown;
}

async function lockLifecycleBatch(
  tx: TxClient,
  batchId: string,
): Promise<{ ok: true; batch: LockedBatchRow } | { ok: false; error: PromoClaimBatchLookupError }> {
  const rows = await tx.$queryRaw<Array<{ id: string; status: string; params: unknown; result: unknown }>>(Prisma.sql`
    SELECT id, status, params, result FROM generic_task
    WHERE id = ${batchId}::uuid AND task_type = ${CATALOG_BATCH_TASK_TYPE}
    FOR UPDATE
  `);
  const row = rows[0];
  if (!row) return { ok: false, error: "not_found" };
  const params = asRecord(row.params);
  if (!isLifecycleBatchParams(params)) return { ok: false, error: "not_lifecycle_batch" };
  return { ok: true, batch: { id: row.id, status: row.status, params, result: row.result } };
}

/** 按 shardIndex 升序返回、并 `FOR UPDATE` 锁住这个批次名下、状态属于 `statuses` 集合的生命周期分片。 */
async function lockChildShards(
  tx: TxClient,
  batchId: string,
  statuses: readonly string[],
): Promise<LockedShardRow[]> {
  const rows = await tx.$queryRaw<Array<{ id: string; status: string; params: unknown; result: unknown }>>(Prisma.sql`
    SELECT id, status, params, result FROM generic_task
    WHERE parent_task_id = ${batchId}::uuid AND task_type = ${PROMO_LINK_CLAIM_TASK_TYPE}
      AND params->>'lifecycleVersion' = '1' AND params->>'lifecycleRole' = 'shard'
      AND status = ANY(${statuses}::text[])
    ORDER BY (params->>'shardIndex')::int ASC
    FOR UPDATE
  `);
  return rows.map((row) => ({ id: row.id, status: row.status, params: asRecord(row.params), result: row.result }));
}

async function auditBatchAction(
  tx: TxClient,
  input: {
    actorId: string;
    action: string;
    batchId: string;
    requestId: string;
    reason?: string | null;
    beforeSnapshot: Prisma.InputJsonValue;
    afterSnapshot: Prisma.InputJsonValue;
  },
): Promise<string> {
  const audit = await tx.operationAudit.create({
    data: {
      actorType: "admin",
      actorId: input.actorId,
      action: input.action,
      entityType: "GenericTask",
      entityId: input.batchId,
      requestId: input.requestId,
      taskType: CATALOG_BATCH_TASK_TYPE,
      taskId: input.batchId,
      reason: input.reason ?? null,
      beforeSnapshot: input.beforeSnapshot,
      afterSnapshot: input.afterSnapshot,
    },
    select: { id: true },
  });
  return audit.id.toString();
}

// ---------------------------------------------------------------------
// 3.1：暂停
// ---------------------------------------------------------------------

export type PromoClaimBatchPauseResult =
  | { readonly ok: false; readonly error: PromoClaimBatchControlError }
  | { readonly ok: true; readonly batchId: string; readonly pausedShardIds: readonly string[]; readonly auditId: string };

export async function pausePromoClaimBatchTx(
  tx: TxClient,
  input: { readonly batchId: string; readonly actorId: string; readonly reason: string | null; readonly requestId: string; readonly now: Date },
): Promise<PromoClaimBatchPauseResult> {
  const looked = await lockLifecycleBatch(tx, input.batchId);
  if (!looked.ok) return looked;
  const { batch } = looked;
  if ((HELD_BATCH_STATUSES as readonly string[]).includes(batch.status)) {
    return { ok: false, error: "state_conflict" };
  }

  const marker: TaskControlMarker = {
    kind: "paused", source: "manual", at: input.now.toISOString(), actorId: input.actorId, reason: input.reason,
  };
  await tx.genericTask.update({
    where: { id: batch.id },
    data: { status: "paused", result: mergeTaskControlResult(batch.result, marker) as unknown as Prisma.InputJsonObject },
  });

  // 只有"当前已放行"（pending/processing，D6 保证至多一个）的分片才跟着暂停；
  // 仍在排队（disabled）的分片原样不动——见本文件顶部说明。
  const releasedShards = await lockChildShards(tx, batch.id, ["pending", "processing"]);
  for (const shard of releasedShards) {
    await tx.genericTask.update({
      where: { id: shard.id },
      data: { status: "paused", result: mergeTaskControlResult(shard.result, marker) as unknown as Prisma.InputJsonObject },
    });
  }

  const auditId = await auditBatchAction(tx, {
    actorId: input.actorId, action: "promo_claim_batch.pause", batchId: batch.id, requestId: input.requestId, reason: input.reason,
    beforeSnapshot: { status: batch.status },
    afterSnapshot: { status: "paused", pausedShardIds: releasedShards.map((shard) => shard.id) },
  });
  return { ok: true, batchId: batch.id, pausedShardIds: releasedShards.map((shard) => shard.id), auditId };
}

// ---------------------------------------------------------------------
// 3.1：恢复
// ---------------------------------------------------------------------

export type PromoClaimBatchResumeResult =
  | { readonly ok: false; readonly error: PromoClaimBatchControlError }
  | { readonly ok: true; readonly batchId: string; readonly releasedShardIds: readonly string[]; readonly auditId: string };

export async function resumePromoClaimBatchTx(
  tx: TxClient,
  input: { readonly batchId: string; readonly actorId: string; readonly requestId: string; readonly now: Date },
): Promise<PromoClaimBatchResumeResult> {
  const looked = await lockLifecycleBatch(tx, input.batchId);
  if (!looked.ok) return looked;
  const { batch } = looked;
  if (batch.status !== "paused") return { ok: false, error: "state_conflict" };

  // 被暂停的已放行分片一律交还成 disabled + awaiting_release——绝不直接改回
  // pending（设计 §5.1/施工任务 3.1 的硬约束）。params（releaseCount/
  // missedDeadlineCount/releasedAt/deadlineAt/shardIndex 等）原样保留、一个
  // 字段都不碰，只改 status 和 result.taskControl。
  const pausedShards = await lockChildShards(tx, batch.id, ["paused"]);
  const releaseMarker: TaskControlMarker = {
    kind: "awaiting_release", source: "manual", at: input.now.toISOString(), actorId: input.actorId,
  };
  for (const shard of pausedShards) {
    await tx.genericTask.update({
      where: { id: shard.id },
      data: { status: "disabled", result: mergeTaskControlResult(shard.result, releaseMarker) as unknown as Prisma.InputJsonObject },
    });
  }

  // 批次自身：不猜测暂停前是什么状态，重新算一遍——同
  // `promo-claim-release.ts` 的 `restoreBatchStatus` 同一手法。批次自己的
  // 状态由它自己的枚举条目决定，与分片进度无关。
  await tx.genericTask.update({
    where: { id: batch.id },
    data: { status: "pending", result: clearTaskControlResult(batch.result) as unknown as Prisma.InputJsonObject },
  });
  await recomputeParentTask(tx, "generic", batch.id);

  const auditId = await auditBatchAction(tx, {
    actorId: input.actorId, action: "promo_claim_batch.resume", batchId: batch.id, requestId: input.requestId,
    beforeSnapshot: { status: "paused" },
    afterSnapshot: { status: "pending", releasedShardIds: pausedShards.map((shard) => shard.id) },
  });
  return { ok: true, batchId: batch.id, releasedShardIds: pausedShards.map((shard) => shard.id), auditId };
}

// ---------------------------------------------------------------------
// 3.1：中止
// ---------------------------------------------------------------------

export type PromoClaimBatchAbortResult =
  | { readonly ok: false; readonly error: PromoClaimBatchControlError }
  | {
      readonly ok: true;
      readonly batchId: string;
      readonly terminatedShardIds: readonly string[];
      readonly terminatedItemCount: number;
      readonly auditId: string;
    };

const ABORT_CASCADE_STATUSES = ["pending", "processing", "paused", "disabled"] as const;

export async function abortPromoClaimBatchTx(
  tx: TxClient,
  input: { readonly batchId: string; readonly actorId: string; readonly reason: string | null; readonly requestId: string; readonly now: Date },
): Promise<PromoClaimBatchAbortResult> {
  const looked = await lockLifecycleBatch(tx, input.batchId);
  if (!looked.ok) return looked;
  const { batch } = looked;
  if (batch.status === "cancelled") return { ok: false, error: "state_conflict" };

  const abortReason = { code: PROMO_CLAIM_BATCH_ABORT_TERMINATION_REASON, message: "Task was manually aborted before this item was ever attempted" };

  // 批次自身残留的 pending 条目（理论上只有它自己那一条枚举条目）。
  const ownTerminated = await terminatePendingTaskItems(tx, "generic", batch.id, abortReason);
  let terminatedItemCount = ownTerminated.terminatedCount;

  // 级联：所有未终结的分片，含仍在排队、从未放行过的 disabled 分片。
  const shards = await lockChildShards(tx, batch.id, ABORT_CASCADE_STATUSES);
  const marker: TaskControlMarker = {
    kind: "aborted", source: "manual", at: input.now.toISOString(), actorId: input.actorId, reason: input.reason,
  };
  for (const shard of shards) {
    const shardTerminated = await terminatePendingTaskItems(tx, "generic", shard.id, abortReason);
    terminatedItemCount += shardTerminated.terminatedCount;
    await tx.genericTask.update({
      where: { id: shard.id },
      data: {
        status: "cancelled",
        result: mergeTaskControlResult(shard.result, {
          ...marker, terminatedPendingItemCount: shardTerminated.terminatedCount,
        }) as unknown as Prisma.InputJsonObject,
      },
    });
  }

  await tx.genericTask.update({
    where: { id: batch.id },
    data: {
      status: "cancelled",
      result: mergeTaskControlResult(batch.result, {
        ...marker, terminatedPendingItemCount: ownTerminated.terminatedCount,
      }) as unknown as Prisma.InputJsonObject,
    },
  });

  const auditId = await auditBatchAction(tx, {
    actorId: input.actorId, action: "promo_claim_batch.abort", batchId: batch.id, requestId: input.requestId, reason: input.reason,
    beforeSnapshot: { status: batch.status },
    afterSnapshot: { status: "cancelled", terminatedShardIds: shards.map((shard) => shard.id), terminatedItemCount },
  });
  return { ok: true, batchId: batch.id, terminatedShardIds: shards.map((shard) => shard.id), terminatedItemCount, auditId };
}

// ---------------------------------------------------------------------
// 3.3：重新批准
// ---------------------------------------------------------------------

export type PromoClaimBatchReapproveResult =
  | { readonly ok: false; readonly error: PromoClaimBatchControlError }
  | {
      readonly ok: true;
      readonly batchId: string;
      readonly approvedAt: string;
      readonly approvalValidUntil: string;
      readonly auditId: string;
    };

export async function reapprovePromoClaimBatchTx(
  tx: TxClient,
  input: {
    readonly batchId: string;
    readonly actorId: string;
    readonly requestId: string;
    readonly now: Date;
    readonly config: Pick<PromoClaimLifecycleConfig, "approvalTtlMinutes">;
  },
): Promise<PromoClaimBatchReapproveResult> {
  const looked = await lockLifecycleBatch(tx, input.batchId);
  if (!looked.ok) return looked;
  const { batch } = looked;

  const marker = readTaskControlMarker(batch.result);
  const isApprovalExpiredHold = batch.status === "disabled" && marker?.kind === "system_hold" && marker.reasonCode === "approval_expired";
  // 显式独立校验"从未放行过任何分片"，不依赖 reasonCode 本身——见本文件
  // 顶部说明。
  const neverReleased = batch.params.firstReleasedAt === undefined || batch.params.firstReleasedAt === null;
  if (!isApprovalExpiredHold || !neverReleased) return { ok: false, error: "state_conflict" };

  const approvedAt = input.now.toISOString();
  const approvalValidUntil = new Date(input.now.getTime() + input.config.approvalTtlMinutes * 60_000).toISOString();
  await tx.genericTask.update({
    where: { id: batch.id },
    data: {
      status: "pending",
      params: { ...batch.params, approvedAt, approvalValidUntil } as unknown as Prisma.InputJsonObject,
      result: clearTaskControlResult(batch.result) as unknown as Prisma.InputJsonObject,
    },
  });
  await recomputeParentTask(tx, "generic", batch.id);

  const auditId = await auditBatchAction(tx, {
    actorId: input.actorId, action: "promo_claim_batch.reapprove", batchId: batch.id, requestId: input.requestId,
    beforeSnapshot: { status: "disabled", reasonCode: "approval_expired" },
    afterSnapshot: { status: "pending", approvedAt, approvalValidUntil },
  });
  return { ok: true, batchId: batch.id, approvedAt, approvalValidUntil, auditId };
}
