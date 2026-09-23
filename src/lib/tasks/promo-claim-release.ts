/**
 * 领推广链接批次生命周期（正式修复第 2 阶段，第 3 步：scheduler 放行与暂停）。
 *
 * 决策来源：`docs/adr/ADR-PROMO-CLAIM-BATCH-LIFECYCLE.md`（D1–D9）、设计
 * `设计_领推广生命周期与自动分片_阶段2_2026-09-23.md` §5.4/§5.5/§5.7/§5.8。
 *
 * 本模块只做"放行 / 暂停"的判定与数据库写入，不做任何领取的真实执行——
 * getcode、预读、回读、意图记录全部保持在 `worker/handlers/
 * promo-link-claim.ts`（第 1 步已冻结，本步一行未动）。scheduler 也绝不读取
 * 凭据密文或任何密钥：本模块只读 `channel_account_credential` 的非秘密列
 * （`status`/`last_validated_at`/`expires_at`/`created_at`），与
 * `src/lib/credentials/claim-readiness.ts` 的 Web 层预检同一条纪律。
 *
 * 虽然物理上不在 `scheduler/` 目录下，但既然这里的逻辑是专供 scheduler 调用
 * 的（`scheduler/index.ts` 每轮调用 {@link runPromoClaimReleaseTick}），本文件
 * 同样遵守施工任务里对 `scheduler/` 的文本守卫：不出现对称解密原语或其调用
 * 名、不出现渠道凭据加密密钥的环境变量前缀，也不出现任务管理后台adjudicator
 * 模块那条导入路径的字面量（后者会被 `tests/backend/task-admin/
 * read-contracts.test.ts` 的跨目录文本扫描命中——本段说明文字如果直接写出
 * 那三个被禁字符串本身，反而会让本文件自己撞上同一条守卫，所以刻意不逐字
 * 拼出它们）。
 *
 * 三层写入原则（设计 §5.4 第 6 条、§5.6、§5.7）：
 *   - 放行只改 `generic_task`（分片状态、批次 `firstReleasedAt`），从不改
 *     `generic_task_item`——条目的领取仍完全由 worker 的
 *     `claimPendingItem`/`finalizeTaskItem` 驱动。
 *   - 任何系统暂停（`approval_expired`/`credential_not_ready`/
 *     `deadline_missed`/`deadline_missed_twice`/`lifecycle_disabled`）都只是
 *     把父任务（批次或分片）的 `status` 改成 `disabled` 并写
 *     `taskControl` 标记——零条目被写成 `failed`，这是设计 §5.6/§5.7 的硬
 *     约束（"零条目写入"/"零条目写成失败"）。
 *   - 每一次放行 / 暂停 / 解除暂停都写一条 `operation_audit`
 *     （`actorType: "system"`，与 `worker/handlers/
 *     promo-link-claim-system-hold.ts` 的既有系统暂停同一约定）。
 */
import { Prisma, type PrismaClient } from "@prisma/client";

import { isUniqueConstraintViolation, summarizeDbError, withDbRetry } from "../db/db-retry";
import { classifyCredentialRowsForClaim } from "../credentials/claim-readiness";
import { isPromoLinkClaimEnabled, isPromoLinkClaimWriteAllowed } from "../flags";
import { CATALOG_BATCH_TASK_TYPE } from "./catalog-batch";
import { PROMO_LINK_CLAIM_TASK_TYPE } from "./promo-link-claim-limits";
import {
  computeShardDeadline,
  evaluateCredentialReadiness,
  isApprovalExpired,
  resolvePromoClaimLifecycleConfig,
  type PromoClaimLifecycleConfig,
  type PromoClaimSystemHoldReasonCode,
} from "./promo-claim-lifecycle";
import { mergeTaskControlResult, readTaskControlMarker, type TaskControlMarker } from "./task-control";
import { recomputeParentTask } from "./store";

/**
 * `side_effect_intent.operation_type` 的字面量，与 `worker/handlers/
 * promo-link-claim.ts` 里 `prepareSideEffectIntent` 调用点写入的值逐字一致
 * （该文件本步不改，也没有导出这个常量——两处字面量的一致性由
 * `tests/backend/tasks/promo-claim-release.test.ts` 的一条文本一致性用例
 * 守护，防止未来两边其中一处改了字面量却忘了改另一处）。
 */
export const PROMO_CLAIM_INTENT_OPERATION_TYPE = "promo_link.claim_promo";

const ACTIVE_TASK_STATUSES = ["pending", "processing"] as const;
/**
 * 阶段2 第4步：导出（原为模块私有）供
 * `src/lib/tasks/promo-claim-batch-control.ts`（批次级暂停/恢复/中止，
 * 施工任务 3.1）复用同一份"批次已经不是正常状态"判据——批次级暂停的可放行性
 * 判定与本文件 `selectNextReleasableShard` 排除已暂停/已中止/系统暂停批次的
 * 判定必须是同一份数组，不能各自维护一份字面量，否则两处对"正常"的定义迟早
 * 会漂移。
 */
export const HELD_BATCH_STATUSES = ["paused", "cancelled", "disabled"] as const;

// ---------------------------------------------------------------------
// 纯判定（可独立单测，不接触数据库）。
// ---------------------------------------------------------------------

export type ShardReleaseEligibility = "awaiting_release" | "deadline_missed_retry" | "not_eligible";

/**
 * 一个 `disabled` 分片当前的任务控制标记，是否属于"可以被放行"的两种状态之一
 * （设计 §5.4 第 3 条、§5.7 第 4 条）：第一次放行前的 `awaiting_release`，或
 * 错过截止时间一次后、等待按 §5.7 重新放行的 `system_hold:deadline_missed`。
 * 其它一切（`approval_expired`/`credential_not_ready`/
 * `deadline_missed_twice`/`lifecycle_disabled`，或人工 `paused`/`aborted`）
 * 都不可被 scheduler 自动放行。
 */
export function classifyShardReleaseEligibility(marker: TaskControlMarker | undefined): ShardReleaseEligibility {
  if (marker?.kind === "awaiting_release") return "awaiting_release";
  if (marker?.kind === "system_hold" && marker.reasonCode === "deadline_missed") return "deadline_missed_retry";
  return "not_eligible";
}

/**
 * 错过截止时间后下一步该进入哪个系统暂停原因码（设计 §5.7 第 4/5 条）：
 * 第 1 次是 `deadline_missed`（下一轮可能自动重新放行），第 2 次起是
 * `deadline_missed_twice`（只能人工处理）。`missedDeadlineCount` 是这一次
 * 错过之后的计数（调用方已经 +1），不是错过之前的值。
 */
export function nextMissedDeadlineReasonCode(
  missedDeadlineCount: number,
): Extract<PromoClaimSystemHoldReasonCode, "deadline_missed" | "deadline_missed_twice"> {
  return missedDeadlineCount >= 2 ? "deadline_missed_twice" : "deadline_missed";
}

// ---------------------------------------------------------------------
// 结果类型
// ---------------------------------------------------------------------

export type PromoClaimReleaseAction =
  | "released"
  | "admission_blocked"
  | "deadline_missed"
  | "deadline_missed_twice"
  | "lifecycle_disabled"
  | "promo_feature_disabled"
  | "approval_expired"
  | "credential_not_ready"
  | "no_eligible_shard"
  | "skipped_active_scope_conflict"
  | "error";

export interface PromoClaimReleaseOutcome {
  readonly channelAccountId: string;
  readonly action: PromoClaimReleaseAction;
  readonly batchId?: string;
  readonly shardId?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface PromoClaimReleaseTickOptions {
  readonly now?: Date;
  readonly env?: NodeJS.ProcessEnv;
  /** 结构化日志钩子；默认按一行一个事件写 `console.info`（设计施工任务 §3.2 "结构化日志一行一个事件"）。 */
  readonly logger?: (event: Readonly<Record<string, unknown>>) => void;
}

function defaultLogger(event: Readonly<Record<string, unknown>>): void {
  // eslint-disable-next-line no-console
  console.info(JSON.stringify({ component: "promo_claim_release", ...event }));
}

// ---------------------------------------------------------------------
// 内部小工具
// ---------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toDateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.valueOf()) ? null : value;
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function clearTaskControlResult(existingResult: unknown): Record<string, unknown> {
  const base = { ...asRecord(existingResult) };
  delete base.taskControl;
  return base;
}

interface RawTaskRow {
  id: string;
  parent_task_id: string | null;
  status: string;
  params: unknown;
  result: unknown;
}

interface ShardRow {
  readonly id: string;
  readonly parentTaskId: string;
  readonly status: string;
  readonly params: Record<string, unknown>;
  readonly result: unknown;
}

interface BatchRow {
  readonly id: string;
  readonly status: string;
  readonly params: Record<string, unknown>;
  readonly result: unknown;
}

function toShardRow(row: RawTaskRow): ShardRow {
  return {
    id: row.id,
    parentTaskId: row.parent_task_id ?? "",
    status: row.status,
    params: asRecord(row.params),
    result: row.result,
  };
}

function toBatchRow(id: string, status: string, params: unknown, result: unknown): BatchRow {
  return { id, status, params: asRecord(params), result };
}

/**
 * 按渠道账号的事务级咨询锁（设计 §5.4："全部在一个事务里，并按渠道账号加
 * 事务级咨询锁，防止两轮同时放出两个分片"）。
 *
 * 派生方式：复用仓库已有的 `pg_advisory_xact_lock(hashtextextended(key, 0))`
 * 约定——`src/server/tagging/service.ts`/`admin-service.ts` 的
 * `lockRequest`/`lockNamespace` 已经这样锁 `requestId`/`namespace` 字符串。
 * `hashtextextended` 是 64 位哈希（而不是 `hashtext` 的 32 位）。这里键前缀
 * `promo_claim_release:` 把这个锁域和仓库里其它同样调用
 * `hashtextextended(..., 0)` 的调用点区分开——即使某个 `requestId`/
 * `namespace` 字符串碰巧等于某个 `channelAccountId` 的 UUID 文本，加了前缀
 * 后两者送进哈希函数的输入也不同，不会互相误锁。
 *
 * 冲突概率：64 位哈希，按生日悖论，需要同时存在约 2^32（43 亿）量级的渠道
 * 账号才有约 50% 概率撞见一次哈希碰撞——这个系统的渠道账号规模是几十到几百
 * 个数量级，实际冲突概率可忽略不计。即使真的撞了，后果也只是把两个不同
 * 账号的放行意外串行化一轮，不是正确性问题。
 */
async function acquireAccountReleaseLock(tx: Prisma.TransactionClient, accountId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtextextended(${`promo_claim_release:${accountId}`}, 0))
  `);
}

async function shardItemCounts(
  tx: Prisma.TransactionClient,
  shardId: string,
): Promise<{ pending: number; processing: number }> {
  const rows = await tx.$queryRaw<Array<{ pending: number; processing: number }>>(Prisma.sql`
    SELECT
      count(*) FILTER (WHERE status = 'pending')::int AS pending,
      count(*) FILTER (WHERE status = 'processing')::int AS processing
    FROM generic_task_item WHERE task_id = ${shardId}::uuid
  `);
  return rows[0] ?? { pending: 0, processing: 0 };
}

/**
 * 设计 §5.7 第 2 条的前置检查：分片重新放行前，它的每一个 `pending` 条目都
 * 必须满足"从未尝试过、且没有任何 getcode 副作用"，否则整条分片转人工。
 * `attempt_count <> 0` 挡住"曾经被 worker 拿到过租约"的条目（哪怕最终因为
 * 过期回退成了 `pending`）；`side_effect_intent` 存在性挡住"曾经真正准备过
 * getcode 调用"的条目——`prepareSideEffectIntent`
 * （`worker/handlers/promo-link-claim.ts`）在真正调用 `claimPromo` 之前就会
 * 写这条记录，所以它的存在本身就证明流程已经越过了"从未尝试"这条线，即使
 * 那次调用最终因为其它原因（例如租约在写意图记录之后、调用 getcode 之前丢失）
 * 没有真正打到上游。
 *
 * 按 `request_summary ->> 'novelSourceItemId'` 关联，而不是
 * `side_effect_intent.target_id`——`worker/handlers/promo-link-claim.ts`
 * 把 `targetId` 写成 `scope.idempotencyKey`（一个业务幂等键），把
 * `novelSourceItemId` 写进 `requestSummary`；分片条目
 * （`generic_task_item.target_id`）本身就是 `novelSourceItemId`
 * （`worker/handlers/catalog-batch.ts` 枚举时 `targetId: member.id`），两者
 * 通过这个 JSON 字段对齐，而不是通过 `target_id` 直接相等。
 *
 * 查不到结果（理论上不会发生，`EXISTS` 恒有一行）时按"不安全"处理
 * （fail-closed）——宁可多一次转人工，也不能悄悄放行一个可能重复调用
 * 非幂等 getcode 的分片。
 */
async function hasUnsafePendingItems(
  tx: Prisma.TransactionClient,
  shardId: string,
  channelAccountId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ unsafe: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1
      FROM generic_task_item i
      WHERE i.task_id = ${shardId}::uuid AND i.status = 'pending'
        AND (
          i.attempt_count <> 0
          OR EXISTS (
            SELECT 1 FROM side_effect_intent se
            WHERE se.operation_type = ${PROMO_CLAIM_INTENT_OPERATION_TYPE}
              AND se.channel_account_id = ${channelAccountId}::uuid
              AND se.request_summary ->> 'novelSourceItemId' = i.target_id
          )
        )
    ) AS unsafe
  `);
  return rows[0]?.unsafe ?? true;
}

async function auditSystemAction(
  tx: Prisma.TransactionClient,
  input: {
    action: string;
    entityId: string;
    taskType: string;
    taskId: string;
    reason?: string | null;
    afterSnapshot?: Prisma.InputJsonValue;
  },
): Promise<void> {
  await tx.operationAudit.create({
    data: {
      actorType: "system",
      actorId: null,
      action: input.action,
      entityType: "GenericTask",
      entityId: input.entityId,
      taskType: input.taskType,
      taskId: input.taskId,
      reason: input.reason ?? null,
      ...(input.afterSnapshot !== undefined ? { afterSnapshot: input.afterSnapshot } : {}),
    },
  });
}

async function holdBatchSystemHold(
  tx: Prisma.TransactionClient,
  batch: BatchRow,
  reasonCode: PromoClaimSystemHoldReasonCode,
  now: Date,
  reason?: string,
): Promise<void> {
  const marker: TaskControlMarker = { kind: "system_hold", source: "system", at: now.toISOString(), reasonCode };
  await tx.genericTask.update({
    where: { id: batch.id },
    data: {
      status: "disabled",
      result: mergeTaskControlResult(batch.result, marker) as unknown as Prisma.InputJsonObject,
    },
  });
  await auditSystemAction(tx, {
    action: "promo_claim_batch.system_hold",
    entityId: batch.id,
    taskType: CATALOG_BATCH_TASK_TYPE,
    taskId: batch.id,
    reason: reason ?? reasonCode,
    afterSnapshot: { reasonCode },
  });
}

async function restoreBatchStatus(
  tx: Prisma.TransactionClient,
  batch: { id: string; result: unknown },
  clearedReasonCode: PromoClaimSystemHoldReasonCode,
): Promise<void> {
  // 批次自己的状态由它自身的枚举条目（`catalog_filter_snapshot`）决定，与
  // 分片进度无关（`recomputeParentTask` 的 `generic` 分支按批次自己的
  // `generic_task_item` 计数计算）。先把 `status` 从 `disabled`
  // 移出（`recomputeParentTask` 把 `disabled` 当作冻结状态、不会重新计算），
  // 再调用现有的 `recomputeParentTask` 重新算出真实状态——不猜测暂停前是
  // 什么状态，而是重新算一遍，无论暂停前后有没有变化都正确。
  await tx.genericTask.update({
    where: { id: batch.id },
    data: {
      status: "pending",
      result: clearTaskControlResult(batch.result) as unknown as Prisma.InputJsonObject,
    },
  });
  await recomputeParentTask(tx, "generic", batch.id);
  await auditSystemAction(tx, {
    action: "promo_claim_batch.system_hold_cleared",
    entityId: batch.id,
    taskType: CATALOG_BATCH_TASK_TYPE,
    taskId: batch.id,
    reason: clearedReasonCode,
  });
}

async function holdShardSystemHold(
  tx: Prisma.TransactionClient,
  shard: ShardRow,
  reasonCode: Extract<PromoClaimSystemHoldReasonCode, "deadline_missed" | "deadline_missed_twice">,
  missedDeadlineCount: number,
  now: Date,
  reason?: string,
): Promise<void> {
  const marker: TaskControlMarker = { kind: "system_hold", source: "system", at: now.toISOString(), reasonCode };
  await tx.genericTask.update({
    where: { id: shard.id },
    data: {
      status: "disabled",
      params: { ...shard.params, missedDeadlineCount } as unknown as Prisma.InputJsonObject,
      result: mergeTaskControlResult(shard.result, marker) as unknown as Prisma.InputJsonObject,
    },
  });
  await auditSystemAction(tx, {
    action: "promo_claim_shard.system_hold",
    entityId: shard.id,
    taskType: PROMO_LINK_CLAIM_TASK_TYPE,
    taskId: shard.id,
    reason: reason ?? reasonCode,
    afterSnapshot: { reasonCode, missedDeadlineCount },
  });
}

/** 设计 §5.4 第 6 条：放行只改 `generic_task`，从不改 `generic_task_item`。 */
async function releaseShard(
  tx: Prisma.TransactionClient,
  shard: ShardRow,
  batch: BatchRow,
  now: Date,
  deadlineAt: Date,
): Promise<void> {
  const releaseCount = (typeof shard.params.releaseCount === "number" ? shard.params.releaseCount : 0) + 1;
  await tx.genericTask.update({
    where: { id: shard.id },
    data: {
      status: "pending",
      params: {
        ...shard.params,
        releasedAt: now.toISOString(),
        deadlineAt: deadlineAt.toISOString(),
        releaseCount,
      } as unknown as Prisma.InputJsonObject,
      // 放行后清掉 taskControl 标记——`awaiting_release`/
      // `system_hold:deadline_missed` 都不再描述这一片现在的状态
      // （`status = 'pending'` 已经自解释），留着旧标记只会误导以后读
      // `result.taskControl` 的界面代码。
      result: clearTaskControlResult(shard.result) as unknown as Prisma.InputJsonObject,
    },
  });
  if (!("firstReleasedAt" in batch.params)) {
    await tx.genericTask.update({
      where: { id: batch.id },
      data: { params: { ...batch.params, firstReleasedAt: now.toISOString() } as unknown as Prisma.InputJsonObject },
    });
  }
  await auditSystemAction(tx, {
    action: "promo_claim_shard.released",
    entityId: shard.id,
    taskType: PROMO_LINK_CLAIM_TASK_TYPE,
    taskId: shard.id,
    afterSnapshot: {
      batchId: batch.id,
      releaseCount,
      releasedAt: now.toISOString(),
      deadlineAt: deadlineAt.toISOString(),
    },
  });
}

/**
 * 找出这个账号名下、当前因某个具体原因码被系统暂停的批次（`unholdLifecycleDisabledBatches`/
 * `unholdCredentialNotReadyBatchesIfReady` 共用的查询形状）。
 */
async function findHeldBatches(
  tx: Prisma.TransactionClient,
  accountId: string,
  reasonCode: PromoClaimSystemHoldReasonCode,
): Promise<Array<{ id: string; result: unknown }>> {
  return tx.$queryRaw<Array<{ id: string; result: unknown }>>(Prisma.sql`
    SELECT b.id, b.result
    FROM generic_task b
    WHERE b.id IN (
      SELECT DISTINCT s.parent_task_id FROM generic_task s
      WHERE s.channel_account_id = ${accountId}::uuid
        AND s.task_type = ${PROMO_LINK_CLAIM_TASK_TYPE}
        AND s.params->>'lifecycleVersion' = '1' AND s.params->>'lifecycleRole' = 'shard'
    )
    AND b.status = 'disabled' AND b.result->'taskControl'->>'reasonCode' = ${reasonCode}
    FOR UPDATE OF b
  `);
}

/**
 * 设计 §5.1/§5.8："开关关闭 → 这些批次进入系统暂停 lifecycle_disabled"。
 * 只对当前状态"正常"（未暂停、未中止）的批次生效——已经因为其它原因
 * （`approval_expired`/`credential_not_ready`/已有的
 * `deadline_missed_twice`）被暂停的批次保持原状，不会被这条更笼统的原因
 * 覆盖掉更具体的原因。
 */
async function holdOpenBatchesAsLifecycleDisabled(
  tx: Prisma.TransactionClient,
  accountId: string,
  now: Date,
): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string; status: string; params: unknown; result: unknown }>>(Prisma.sql`
    SELECT b.id, b.status, b.params, b.result
    FROM generic_task b
    WHERE b.id IN (
      SELECT DISTINCT s.parent_task_id FROM generic_task s
      WHERE s.channel_account_id = ${accountId}::uuid
        AND s.task_type = ${PROMO_LINK_CLAIM_TASK_TYPE}
        AND s.params->>'lifecycleVersion' = '1' AND s.params->>'lifecycleRole' = 'shard'
        AND s.status = 'disabled'
    )
    AND b.status NOT IN (${Prisma.join(HELD_BATCH_STATUSES)})
    FOR UPDATE OF b
  `);
  for (const row of rows) {
    await holdBatchSystemHold(tx, toBatchRow(row.id, row.status, row.params, row.result), "lifecycle_disabled", now);
  }
  return rows.map((row) => row.id);
}

/** 设计 §5.8："回退开关已关闭 → 重新开启开关后自动恢复"。 */
async function unholdLifecycleDisabledBatches(tx: Prisma.TransactionClient, accountId: string): Promise<string[]> {
  const rows = await findHeldBatches(tx, accountId, "lifecycle_disabled");
  for (const row of rows) {
    await restoreBatchStatus(tx, row, "lifecycle_disabled");
  }
  return rows.map((row) => row.id);
}

/**
 * D5 凭据三条件（设计 §5.4 第 5 条）。行选择策略复用
 * `classifyCredentialRowsForClaim`（`src/lib/credentials/claim-readiness.ts`）
 * ——与 Web 层预检、worker 深层检查同一份"哪一行凭据算数"的判定，避免第三份
 * 实现悄悄分叉。凭据是账号级的事实，与具体哪个批次/分片无关，因此这个判定
 * 同时供"选中候选分片后的放行前置检查"与"扫描 credential_not_ready 暂停
 * 是否可以自动解除"两处调用，不重复实现。
 */
async function evaluateAccountCredentialReasons(
  tx: Prisma.TransactionClient,
  accountId: string,
  config: PromoClaimLifecycleConfig,
  now: Date,
): Promise<readonly string[]> {
  const credentialRows = await tx.$queryRaw<Array<{
    id: string; status: string; last_validated_at: Date | null; expires_at: Date | null; created_at: Date;
  }>>(Prisma.sql`
    SELECT id, status, last_validated_at, expires_at, created_at
    FROM channel_account_credential
    WHERE channel_account_id = ${accountId}::uuid AND status = 'active'
  `);
  const selection = classifyCredentialRowsForClaim(
    credentialRows.map((row) => ({ id: row.id, expiresAt: row.expires_at })),
    now,
  );
  if (selection.status === "not_ready") return [selection.code];
  const row = credentialRows.find((candidateRow) => candidateRow.id === selection.row.id)!;
  return evaluateCredentialReadiness({
    status: row.status,
    lastValidatedAt: row.last_validated_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    now,
    windowMinutes: config.shardWindowMinutes,
    safetyMarginMinutes: config.credentialSafetyMarginMinutes,
  }).reasons;
}

/**
 * 设计 §5.8："凭据未就绪 → 条件重新满足后，scheduler 自动恢复"。与
 * `unholdLifecycleDisabledBatches` 同一形状，但多一步：先看有没有被这个原因
 * 暂停的批次（没有就直接返回，省一次凭据查询），有的话才真正判定凭据是否
 * 已经就绪。
 */
async function unholdCredentialNotReadyBatchesIfReady(
  tx: Prisma.TransactionClient,
  accountId: string,
  config: PromoClaimLifecycleConfig,
  now: Date,
): Promise<string[]> {
  const rows = await findHeldBatches(tx, accountId, "credential_not_ready");
  if (rows.length === 0) return [];
  const reasons = await evaluateAccountCredentialReasons(tx, accountId, config, now);
  if (reasons.length > 0) return [];
  for (const row of rows) {
    await restoreBatchStatus(tx, row, "credential_not_ready");
  }
  return rows.map((row) => row.id);
}

interface ReleasableCandidate {
  readonly shard: ShardRow;
  readonly batch: BatchRow;
  readonly eligibility: ShardReleaseEligibility;
}

/**
 * 设计 §5.4 第 3 条："按批次批准时刻先后，选第一个状态正常的批次里
 * shardIndex 最小的待放行 / 待重新放行分片"。批次 `approvedAt` 缺失时退回
 * `created_at`（理论上不会发生——生命周期批次一律写 `approvedAt`——纯粹是
 * 防御，不让排序在异常数据下报错）。
 */
async function selectNextReleasableShard(
  tx: Prisma.TransactionClient,
  accountId: string,
): Promise<ReleasableCandidate | null> {
  const rows = await tx.$queryRaw<Array<{
    id: string; parent_task_id: string; status: string; params: unknown; result: unknown;
    batch_id: string; batch_status: string; batch_params: unknown; batch_result: unknown;
  }>>(Prisma.sql`
    SELECT s.id, s.parent_task_id, s.status, s.params, s.result,
           b.id AS batch_id, b.status AS batch_status, b.params AS batch_params, b.result AS batch_result
    FROM generic_task s
    JOIN generic_task b ON b.id = s.parent_task_id
    WHERE s.channel_account_id = ${accountId}::uuid
      AND s.task_type = ${PROMO_LINK_CLAIM_TASK_TYPE}
      AND s.params->>'lifecycleVersion' = '1' AND s.params->>'lifecycleRole' = 'shard'
      AND s.status = 'disabled'
      AND b.status NOT IN (${Prisma.join(HELD_BATCH_STATUSES)})
      AND (
        s.result->'taskControl'->>'kind' = 'awaiting_release'
        OR (s.result->'taskControl'->>'kind' = 'system_hold' AND s.result->'taskControl'->>'reasonCode' = 'deadline_missed')
      )
    ORDER BY COALESCE(b.params->>'approvedAt', b.created_at::text)::timestamptz ASC, (s.params->>'shardIndex')::int ASC
    LIMIT 1
    FOR UPDATE OF s, b SKIP LOCKED
  `);
  const row = rows[0];
  if (!row) return null;
  const shard = toShardRow({ id: row.id, parent_task_id: row.parent_task_id, status: row.status, params: row.params, result: row.result });
  const batch = toBatchRow(row.batch_id, row.batch_status, row.batch_params, row.batch_result);
  const eligibility = classifyShardReleaseEligibility(readTaskControlMarker(row.result));
  return { shard, batch, eligibility };
}

/**
 * 找出这一轮需要处理的渠道账号：至少存在一个尚未终结的生命周期分片
 * （`disabled`/`pending`/`processing`）——已经 `success`/`failed`/
 * `completed_with_errors` 的分片不再出现在这个集合里，查询范围随时间自然
 * 收敛，不会随着历史分片越堆越多而变慢。
 */
export async function findPromoClaimReleaseCandidateAccountIds(
  db: PrismaClient | Prisma.TransactionClient,
): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ channel_account_id: string }>>(Prisma.sql`
    SELECT DISTINCT channel_account_id
    FROM generic_task
    WHERE task_type = ${PROMO_LINK_CLAIM_TASK_TYPE}
      AND channel_account_id IS NOT NULL
      AND params->>'lifecycleVersion' = '1' AND params->>'lifecycleRole' = 'shard'
      AND status IN (${Prisma.join(["disabled", ...ACTIVE_TASK_STATUSES])})
  `);
  return rows.map((row) => row.channel_account_id);
}

/**
 * 对单个渠道账号执行一次完整的"放行 / 暂停"判定（设计 §5.4 全部七步 +
 * §5.7）。调用方负责把这个函数包在一个事务里（{@link runPromoClaimReleaseTick}
 * 已经这样做）——本函数自己只负责在事务开始时取咨询锁，不自己开事务，方便
 * 集成测试直接在已打开的事务里调用它做场景验证。
 */
export async function releasePromoClaimShardsForAccount(
  tx: Prisma.TransactionClient,
  accountId: string,
  config: PromoClaimLifecycleConfig,
  now: Date,
  env: NodeJS.ProcessEnv,
): Promise<PromoClaimReleaseOutcome> {
  await acquireAccountReleaseLock(tx, accountId);

  // 5.7：先处理这个账号当前"已放行"的生命周期分片（D6 保证至多一个；即使
  // 出现异常多于一个的情况，也逐一处理，不假设只有一个）。这一步同时承担了
  // D6 准入判定的一半：只要还有 pending/processing 的生命周期分片，账号就
  // 被占用，本轮不放行新的。
  const activeShardRows = await tx.$queryRaw<RawTaskRow[]>(Prisma.sql`
    SELECT id, parent_task_id, status, params, result
    FROM generic_task
    WHERE channel_account_id = ${accountId}::uuid
      AND task_type = ${PROMO_LINK_CLAIM_TASK_TYPE}
      AND params->>'lifecycleVersion' = '1' AND params->>'lifecycleRole' = 'shard'
      AND status IN (${Prisma.join(ACTIVE_TASK_STATUSES)})
    ORDER BY created_at ASC
    FOR UPDATE
  `);

  let admissionBlocked = activeShardRows.length > 0;
  for (const raw of activeShardRows) {
    const shard = toShardRow(raw);
    const counts = await shardItemCounts(tx, shard.id);
    if (counts.processing > 0) continue; // 正常收尾，本轮不动（§5.6 最后一句）。
    if (counts.pending === 0) continue; // 即将被 recomputeParentTask 收尾为终态，不算错过。
    const deadlineAt = toDateOrNull(shard.params.deadlineAt);
    if (!deadlineAt || now < deadlineAt) continue; // 还在窗口内。

    const missedDeadlineCount = (typeof shard.params.missedDeadlineCount === "number" ? shard.params.missedDeadlineCount : 0) + 1;
    const reasonCode = nextMissedDeadlineReasonCode(missedDeadlineCount);
    await holdShardSystemHold(
      tx, shard, reasonCode, missedDeadlineCount, now,
      reasonCode === "deadline_missed_twice" ? "missed_deadline_twice_consecutive" : undefined,
    );
    return {
      channelAccountId: accountId, action: reasonCode, shardId: shard.id, batchId: shard.parentTaskId,
      detail: { missedDeadlineCount },
    };
  }
  if (admissionBlocked) return { channelAccountId: accountId, action: "admission_blocked" };

  // D6 同时覆盖旧路径的领取任务（不带生命周期标记的 promo_link.claim.v1）。
  const [{ count: otherActiveCount }] = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    SELECT count(*)::int AS count FROM generic_task
    WHERE channel_account_id = ${accountId}::uuid AND task_type = ${PROMO_LINK_CLAIM_TASK_TYPE}
      AND status IN (${Prisma.join(ACTIVE_TASK_STATUSES)})
  `);
  if (otherActiveCount > 0) return { channelAccountId: accountId, action: "admission_blocked" };

  // 5.4 第 1 条：回退开关。
  if (!config.enabled) {
    const heldBatchIds = await holdOpenBatchesAsLifecycleDisabled(tx, accountId, now);
    return { channelAccountId: accountId, action: "lifecycle_disabled", detail: { heldBatchIds } };
  }
  await unholdLifecycleDisabledBatches(tx, accountId);
  // 设计 §5.8：凭据未就绪的暂停同样要在每一轮扫描一次是否可以自动解除——
  // 不是只在"选中候选分片后"才判定一次；否则一个已经因为 credential_not_ready
  // 被暂停的批次，一旦 status 变成 disabled 就会被 selectNextReleasableShard
  // 的 `b.status NOT IN (...)` 过滤条件永远排除在外，凭据修好之后也再也没有
  // 机会被重新选中——这是集成测试在一次性 Postgres 容器上真实抓到的缺陷。
  await unholdCredentialNotReadyBatchesIfReady(tx, accountId, config, now);

  // 第 2 步遗留待办（本步收口）：真正放行前，promo 功能开关必须两个都开——
  // `worker/handlers/catalog-batch.ts` 枚举生命周期分片时故意不查这两个
  // 开关（那是给"立即可跑的子任务"设计的双闸），把检查推迟到这里；
  // `worker/handlers/promo-link-claim.ts` 自己在真正执行时仍会独立检查
  // `isPromoLinkClaimEnabled`，这里只是多一层「不开就不放行」，不放行时不
  // 触碰批次/分片的状态或标记——只跳过，不写系统暂停，因为这是运维配置项
  // 而不是这个批次自己的生命周期事件，配置一旦打开，下一轮自然继续放行。
  if (!isPromoLinkClaimEnabled(env) || !isPromoLinkClaimWriteAllowed(env)) {
    return { channelAccountId: accountId, action: "promo_feature_disabled" };
  }

  const candidate = await selectNextReleasableShard(tx, accountId);
  if (!candidate) return { channelAccountId: accountId, action: "no_eligible_shard" };
  const { batch, shard } = candidate;

  // D1 批准时钟：只在这个批次从未放行过任何分片时生效。
  if (
    isApprovalExpired({
      firstReleasedAt: batch.params.firstReleasedAt as string | undefined,
      approvalValidUntil: batch.params.approvalValidUntil as string | undefined,
      now,
    })
  ) {
    await holdBatchSystemHold(tx, batch, "approval_expired", now);
    return { channelAccountId: accountId, action: "approval_expired", batchId: batch.id, shardId: shard.id };
  }

  // D5 凭据三条件（判定逻辑与上面的 `unholdCredentialNotReadyBatchesIfReady`
  // 共用同一个 `evaluateAccountCredentialReasons`，不重复实现）。
  const readinessReasons = await evaluateAccountCredentialReasons(tx, accountId, config, now);
  if (readinessReasons.length > 0) {
    await holdBatchSystemHold(tx, batch, "credential_not_ready", now, readinessReasons.join(","));
    return {
      channelAccountId: accountId, action: "credential_not_ready", batchId: batch.id, shardId: shard.id,
      detail: { reasons: readinessReasons },
    };
  }

  // D4 前置检查（施工任务 3.2 收口）：只要这个分片曾经被放行过至少一次
  // （`releaseCount > 0`），不论它现在的标记是 `awaiting_release`（例如
  // 批次级暂停后又被恢复——`resumePromoClaimBatch` 会把已放行过的分片交还
  // 成 `disabled` + `awaiting_release`，同时原样保留 `releaseCount`，见
  // `src/lib/tasks/promo-claim-batch-control.ts`）还是
  // `system_hold:deadline_missed`（错过截止时间自动等待重新放行），放行前
  // 都必须重新跑一遍这条安全检查。原先只在 `eligibility ===
  // "deadline_missed_retry"` 时检查，遗漏了"手动暂停→恢复"这条同样可能已经
  // 产生 getcode 副作用的路径——一个已经被放行过、其中某个条目已经调用过
  // getcode（或已有意图记录）的分片，如果被人工暂停后又恢复，不能被当成
  // "第一次放行"直接免检。第一次放行（`releaseCount === 0`）则完全不变——
  // 它从未被放行过，结构上不可能有任何 getcode 副作用。
  const releaseCount = typeof shard.params.releaseCount === "number" ? shard.params.releaseCount : 0;
  if (releaseCount > 0) {
    const unsafe = await hasUnsafePendingItems(tx, shard.id, accountId);
    if (unsafe) {
      const missedDeadlineCount = typeof shard.params.missedDeadlineCount === "number" ? shard.params.missedDeadlineCount : 1;
      // 复用 `deadline_missed_twice` 这一个"需要人工处理"的终态桶，不新增
      // 第六个系统暂停原因码——`PROMO_CLAIM_SYSTEM_HOLD_REASON_CODES`
      // （第 1 步）已经把五个原因码定为常量数组，设计 §5.8 的暂停/恢复
      // 一览表也只列了这五种。这里通过 `TaskControlMarker.reason`
      // （自由文本，不是 `reasonCode`）写 `unsafe_to_auto_retry`
      // 来区分"因为不安全被卡住"与"连续两次单纯超时"，供审计/人工排查
      // 时分辨,但两者在恢复方式上完全一样：都只能人工处理。
      await holdShardSystemHold(tx, shard, "deadline_missed_twice", missedDeadlineCount, now, "unsafe_to_auto_retry");
      return {
        channelAccountId: accountId, action: "deadline_missed_twice", batchId: batch.id, shardId: shard.id,
        detail: { reason: "unsafe_to_auto_retry" },
      };
    }
  }

  const deadlineAt = computeShardDeadline(now, config.shardWindowMinutes);
  await releaseShard(tx, shard, batch, now, deadlineAt);
  return {
    channelAccountId: accountId, action: "released", batchId: batch.id, shardId: shard.id,
    detail: { deadlineAt: deadlineAt.toISOString() },
  };
}

/**
 * scheduler 每轮调用的入口。每个候选账号各自开一个事务（`withDbRetry` 包一层
 * 瞬时故障重试，与 `store.ts` 的 `claimPendingItem`/`finalizeTaskItem`
 * 同一约定），任一账号出错都只记录、不影响其它账号、不影响调用方
 * （`scheduler/index.ts`）的其它调度逻辑——本函数自己永不 throw。
 *
 * 唯一约束冲突（`generic_task_active_scope_uidx`）的优雅处理：某一片放行时
 * 如果撞上这个唯一索引（结构上极不可能，因为每片的 `operationScopeHash`
 * 由它自己的书目集合算出，但设计要求防御性处理），Postgres 会让那个账号
 * 当前的整个事务失败并回滚——同一事务里更早做的批准时钟/凭据检查等写入也
 * 一起回滚（幂等：下一轮重新判定一次，结果一致）。这里只需要把这一种失败
 * 从"未知错误"里单独分类出来，记成 `skipped_active_scope_conflict`，而不是
 * 让它当作一般错误抛出中断整轮。
 */
export async function runPromoClaimReleaseTick(
  prisma: PrismaClient,
  options: PromoClaimReleaseTickOptions = {},
): Promise<PromoClaimReleaseOutcome[]> {
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  const log = options.logger ?? defaultLogger;
  const config = resolvePromoClaimLifecycleConfig(env);
  const accountIds = await findPromoClaimReleaseCandidateAccountIds(prisma);

  const outcomes: PromoClaimReleaseOutcome[] = [];
  for (const accountId of accountIds) {
    try {
      const outcome = await withDbRetry(
        () => prisma.$transaction(
          (tx) => releasePromoClaimShardsForAccount(tx, accountId, config, now, env),
          { timeout: 15_000 },
        ),
        { op: "tasks.promoClaimRelease", sourceKey: accountId },
      );
      outcomes.push(outcome);
      log({ event: "promo_claim_release.tick", ...outcome });
    } catch (error) {
      const outcome: PromoClaimReleaseOutcome = isUniqueConstraintViolation(error)
        ? { channelAccountId: accountId, action: "skipped_active_scope_conflict" }
        : { channelAccountId: accountId, action: "error", detail: { message: summarizeDbError(error) } };
      outcomes.push(outcome);
      log({ event: "promo_claim_release.tick_error", ...outcome });
    }
  }
  return outcomes;
}
