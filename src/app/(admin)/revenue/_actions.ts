"use server";

import { randomUUID } from "node:crypto";

import { headers } from "next/headers";

import type { ErrorEnvelope } from "@/contracts";
import { AdminAccessError } from "@/lib/auth/errors";
import { requireAdminActionAccess, requireFreshAdminServiceMutation } from "@/server/auth/guards";
import { enqueueRevenueSync, type EnqueueRevenueSyncFailureCode } from "@/server/revenue";

import { canonicalOrigin, guardDependencies, prisma, readSessionToken } from "../../api/admin/_lib/deps";
import { toErrorEnvelope } from "../../api/admin/_lib/respond";

/**
 * `/revenue` 的"立即同步"。登记为 `admin.revenue.sync.enqueue`（`revenue:view`，见
 * `src/app/api/admin/_lib/registry.ts` 的 `ADMIN_REVENUE_ACTIONS`）。
 *
 * 两步授权，和 `catalog-sync/_actions.ts` 同一个形状：
 *   1. `requireAdminActionAccess`：会话 + 能力位 + 同源 + 限流 + 请求标识，签发一次性服务端授权；
 *   2. 写入前 `requireFreshAdminServiceMutation(…, "revenue:view", …)`：重新读会话与身份，确认
 *      授权没被换绑、会话没被吊销、2FA 仍有效。
 * 两步任何一步失败都**不会触达** `enqueueRevenueSync`（`tests/ui/revenue-sync-action.test.ts` 钉死）。
 *
 * 幂等令牌（`generic_task.request_token`）由**服务端**生成，不信任客户端：客户端只给一个
 * 一次性的 `requestId`（用于同源 / 限流 / 授权绑定）。同一次点击的重复提交由"同一账号同时只有一个
 * 活跃任务"兜住（返回 `revenue_sync_already_active`）。
 *
 * 返回值三种：
 *   - `{ ok: true, data }`                     任务已建（`duplicate: true` 表示命中了既有任务）；
 *   - `{ ok: false, kind: "enqueue_failed" }`  后端业务拒绝，带原始 `code`（页面按 code 出中文；未知 code 显示原文）；
 *   - `{ ok: false, kind: "access_denied" }`   授权 / 会话 / 2FA / 限流等失败，或任何未预期异常
 *                                              （`toErrorEnvelope` 统一收敛，不外泄 message）。
 *
 * 不碰凭证：凭证的读取与解密只在 worker 的 handler 里发生。
 */

// "use server" 文件只允许导出 async 函数（常量导出会让 next build 报错），所以这个 id 不导出。
const ENQUEUE_REVENUE_SYNC_ACTION_ID = "admin.revenue.sync.enqueue" as const;

export type EnqueueRevenueSyncActionInput = {
  readonly beginDate: string;
  readonly endDate: string;
  /** 客户端生成的一次性请求标识（同源 / 限流 / 授权绑定用）；不是入队幂等令牌。 */
  readonly requestId: string;
};

export type EnqueueRevenueSyncActionResult =
  | { readonly ok: true; readonly data: { readonly taskId: string; readonly duplicate: boolean } }
  | {
      readonly ok: false;
      readonly kind: "enqueue_failed";
      readonly code: EnqueueRevenueSyncFailureCode;
      readonly existingTaskId?: string;
    }
  | { readonly ok: false; readonly kind: "access_denied"; readonly envelope: ErrorEnvelope };

async function authorizeAction(requestId: string) {
  const requestHeaders = await headers();
  return requireAdminActionAccess(
    {
      actionId: ENQUEUE_REVENUE_SYNC_ACTION_ID,
      sessionToken: await readSessionToken(),
      origin: requestHeaders.get("origin"),
      canonicalOrigin: await canonicalOrigin(),
      requestId,
    },
    guardDependencies(),
  );
}

export async function enqueueRevenueSyncAction(
  input: EnqueueRevenueSyncActionInput,
): Promise<EnqueueRevenueSyncActionResult> {
  try {
    const requestId = typeof input?.requestId === "string" ? input.requestId : "";
    const { serviceAuthorization } = await authorizeAction(requestId);
    if (!serviceAuthorization) {
      // 按本 action 的登记（带 capability）不可达；留作登记被改坏时的兜底，宁可拒绝也不放行。
      throw new AdminAccessError(
        "admin_service_authorization_required",
        403,
        "Action is not bound to a capability",
      );
    }
    const guards = guardDependencies();
    const fresh = await requireFreshAdminServiceMutation(serviceAuthorization, "revenue:view", {
      identities: guards.identities,
      sessions: guards.sessions,
      entryId: ENQUEUE_REVENUE_SYNC_ACTION_ID,
      requestId,
    });

    const result = await enqueueRevenueSync(prisma, {
      beginDate: input.beginDate,
      endDate: input.endDate,
      requestToken: randomUUID(),
      actor: fresh.identity.id,
    });
    if (!result.ok) {
      return {
        ok: false,
        kind: "enqueue_failed",
        code: result.code,
        ...(result.existingTaskId ? { existingTaskId: result.existingTaskId } : {}),
      };
    }
    return { ok: true, data: { taskId: result.taskId, duplicate: result.duplicate } };
  } catch (error) {
    return { ok: false, kind: "access_denied", envelope: toErrorEnvelope(error) };
  }
}
