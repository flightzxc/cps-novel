/**
 * 收益同步入队（web 侧，给 server action 调用）。只建任务，**不碰凭证**：凭证的读取与解密只在 worker
 * 的 `moboreader.revenue_sync.v1` handler 里发生（`tests/backend/auth/credential-contracts.test.ts` 守卫）。
 *
 * 返回 `{ ok: true; taskId; duplicate } | { ok: false; code; existingTaskId? }`，`code` 枚举：
 *
 *   - `invalid_request`              requestToken / actor 缺失或超长
 *   - `invalid_date_range`           日期不是真实存在的 YYYY-MM-DD、begin 晚于 end、跨度 > 92 天、
 *                                    或 end 晚于上海时区的今天
 *   - `channel_account_unavailable`  没有可用的渠道账号（网文 channel_app 下没有 active 且未删除的账号）
 *   - `channel_account_ambiguous`    候选账号不止一个——不替运营挑，要先把账号收敛到恰好一个
 *   - `revenue_sync_already_active`  该账号已有 pending / processing 的收益同步任务（带 `existingTaskId`）
 *   - `request_token_conflict`       同一个 requestToken 已用于另一份不同的请求
 *
 * 幂等：同一个 requestToken、同一份请求再次提交，返回既有任务（`duplicate: true`），不会建第二个。
 * “同一账号同一时刻只有一个活跃收益同步任务”由 `generic_task_active_scope_uidx` 在数据库层保证
 * （`operation_scope_hash` 固定为 revenue_sync 的作用域哈希），应用层的先查只是为了给出友好的返回。
 *
 * generic_task + 唯一条目 + operation_audit 在同一个事务里写（照 `createMoboreaderCatalogScanTask`）。
 * 模式恒为 apply：本任务不支持 dry_run（dry_run 下带 protectedWrite 会被判失败）。
 *
 * 部署提示（现状如实记录，不为此加功能）：任务类型必须出现在**主通道** `WORKER_TASK_ALLOWLIST`
 * 里才会被 worker 领取；漏配时任务会一直 pending，既没有告警也不会被 preflight 拦住，并且因为
 * 活跃作用域唯一索引，之后的入队都会返回 `revenue_sync_already_active`，需要先在任务中心中止它。
 */
import { randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";

import { isUniqueConstraintViolation } from "@/lib/db/db-retry";
import {
  REVENUE_SYNC_AUDIT_ACTION_QUEUED,
  REVENUE_SYNC_REQUESTED_BY_MAX_LENGTH,
  REVENUE_SYNC_REQUEST_TOKEN_MAX_LENGTH,
  REVENUE_SYNC_TARGET_TYPE,
  REVENUE_SYNC_TASK_TYPE,
  RevenueSyncParamsError,
  assertValidRevenueSyncRange,
  revenueSyncOperationScopeHash,
  serializeRevenueSyncTaskParams,
  type RevenueSyncTaskParams,
} from "@/lib/tasks/revenue-sync";

import { resolveRevenueChannelAccount } from "./account";

export type EnqueueRevenueSyncFailureCode =
  | "invalid_request"
  | "invalid_date_range"
  | "channel_account_unavailable"
  | "channel_account_ambiguous"
  | "revenue_sync_already_active"
  | "request_token_conflict";

export type EnqueueRevenueSyncResult =
  | { readonly ok: true; readonly taskId: string; readonly duplicate: boolean }
  | { readonly ok: false; readonly code: EnqueueRevenueSyncFailureCode; readonly existingTaskId?: string };

export interface EnqueueRevenueSyncInput {
  readonly beginDate: string;
  readonly endDate: string;
  /** 客户端 / server action 生成的幂等令牌（同一次点击重复提交得到同一个任务）。 */
  readonly requestToken: string;
  /** 后台操作人标识（写入审计与批次的 `requested_by`）。 */
  readonly actor: string;
}

export interface EnqueueRevenueSyncOptions {
  readonly now?: Date;
}

const ACTIVE_STATUSES = ["pending", "processing"] as const;

/** 既有任务（同一个 requestToken）是不是同一份请求：账号与区间一致即可，不重新校验存量参数。 */
function sameRequest(existing: unknown, params: RevenueSyncTaskParams): boolean {
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) return false;
  const stored = existing as Record<string, unknown>;
  return (
    stored.channelAccountId === params.channelAccountId
    && stored.beginDate === params.beginDate
    && stored.endDate === params.endDate
  );
}

export async function enqueueRevenueSync(
  prisma: PrismaClient,
  input: EnqueueRevenueSyncInput,
  options: EnqueueRevenueSyncOptions = {},
): Promise<EnqueueRevenueSyncResult> {
  const now = options.now ?? new Date();
  const requestToken = typeof input.requestToken === "string" ? input.requestToken.trim() : "";
  const actor = typeof input.actor === "string" ? input.actor.trim() : "";
  if (
    !requestToken || requestToken.length > REVENUE_SYNC_REQUEST_TOKEN_MAX_LENGTH
    || !actor || actor.length > REVENUE_SYNC_REQUESTED_BY_MAX_LENGTH
  ) {
    return { ok: false, code: "invalid_request" };
  }
  try {
    assertValidRevenueSyncRange(input.beginDate, input.endDate, now);
  } catch (error) {
    if (error instanceof RevenueSyncParamsError) return { ok: false, code: "invalid_date_range" };
    throw error;
  }

  const account = await resolveRevenueChannelAccount(prisma);
  if (account.status === "unavailable") return { ok: false, code: "channel_account_unavailable" };
  if (account.status === "ambiguous") return { ok: false, code: "channel_account_ambiguous" };

  let params: RevenueSyncTaskParams;
  try {
    params = serializeRevenueSyncTaskParams(
      { channelAccountId: account.channelAccountId, beginDate: input.beginDate, endDate: input.endDate, requestedBy: actor },
      now,
    );
  } catch (error) {
    if (error instanceof RevenueSyncParamsError) {
      return { ok: false, code: error.code === "invalid_date_range" ? "invalid_date_range" : "invalid_request" };
    }
    throw error;
  }

  const operationScopeHash = revenueSyncOperationScopeHash();
  const findByToken = async (): Promise<EnqueueRevenueSyncResult | null> => {
    const existing = await prisma.genericTask.findUnique({
      where: { requestToken },
      select: { id: true, taskType: true, params: true },
    });
    if (!existing) return null;
    if (existing.taskType === REVENUE_SYNC_TASK_TYPE && sameRequest(existing.params, params)) {
      return { ok: true, taskId: existing.id, duplicate: true };
    }
    return { ok: false, code: "request_token_conflict", existingTaskId: existing.id };
  };
  const findActive = async (): Promise<EnqueueRevenueSyncResult | null> => {
    const active = await prisma.genericTask.findFirst({
      where: {
        taskType: REVENUE_SYNC_TASK_TYPE,
        channelAccountId: account.channelAccountId,
        channelAppId: account.channelAppId,
        operationScopeHash,
        status: { in: [...ACTIVE_STATUSES] },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    return active ? { ok: false, code: "revenue_sync_already_active", existingTaskId: active.id } : null;
  };

  const duplicate = await findByToken();
  if (duplicate) return duplicate;
  const alreadyActive = await findActive();
  if (alreadyActive) return alreadyActive;

  const taskId = randomUUID();
  const paramsJson = { ...params } satisfies Prisma.InputJsonObject;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.genericTask.create({
        data: {
          id: taskId,
          taskType: REVENUE_SYNC_TASK_TYPE,
          channelAccountId: account.channelAccountId,
          channelAppId: account.channelAppId,
          operationScopeHash,
          mode: "apply",
          status: "pending",
          requestToken,
          totalCount: 1,
          params: paramsJson,
          items: {
            create: [
              {
                targetType: REVENUE_SYNC_TARGET_TYPE,
                targetId: `${params.beginDate}~${params.endDate}`,
                payload: paramsJson,
              },
            ],
          },
        },
      });
      await tx.operationAudit.create({
        data: {
          actorType: "admin",
          actorId: actor,
          action: REVENUE_SYNC_AUDIT_ACTION_QUEUED,
          entityType: "GenericTask",
          entityId: taskId,
          requestId: requestToken,
          taskType: REVENUE_SYNC_TASK_TYPE,
          taskId,
          afterSnapshot: {
            source: "manual",
            mode: "apply",
            status: "pending",
            projectType: params.projectType,
            beginDate: params.beginDate,
            endDate: params.endDate,
          },
        },
      });
    });
    return { ok: true, taskId, duplicate: false };
  } catch (error) {
    if (!isUniqueConstraintViolation(error)) throw error;
    // 并发下的唯一冲突：先看是不是同一个令牌（同一次点击的重复提交），再看是不是活跃作用域冲突。
    return (await findByToken()) ?? (await findActive()) ?? Promise.reject(error);
  }
}
