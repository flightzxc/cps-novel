import type { AdminErrorCode, ErrorEnvelope } from "@/contracts";

import { ADMIN_CAPABILITY_LABELS } from "./capability-view";

/**
 * The frontend owns this copy.
 *
 * The envelope carries no server message by design, so every string a user sees
 * is authored here and keyed by a stable code. Nothing in this module reads
 * `error.message` — there is none to read.
 */
const COPY: Readonly<Record<AdminErrorCode, string>> = Object.freeze({
  jwt_missing: "登录已失效，请重新登录",
  jwt_invalid: "登录已失效，请重新登录",
  jwt_expired: "会话已过期，请重新登录",
  admin_capability_denied: "当前账号缺少执行该操作所需的能力位",
  admin_two_factor_required: "该操作要求当前会话已完成双重验证",
  admin_route_not_registered: "该接口未登记，已被默认拒绝",
  admin_action_not_registered: "该操作未登记，已被默认拒绝",
  admin_origin_denied: "请求来源校验未通过，请刷新页面后重试",
  admin_mutation_request_id_invalid: "请求标识无效或已被用于另一次提交",
  admin_rate_limited: "操作过于频繁，请稍后重试",
  admin_service_authorization_required: "服务端授权校验未通过，请刷新页面后重试",
  two_factor_failed: "验证码或恢复码不正确",
  two_factor_expired: "验证已过期，请重新开始",
  two_factor_locked: "尝试次数过多，请重新登录",
  credential_validation_queued: "校验任务已入队",
  credential_missing: "未找到对应凭证",
  credential_expired: "该 JWT 已过期",
  credential_fingerprint_conflict: "该 JWT 已被其它账户占用，无法重复启用",
  credential_validation_failed: "凭证校验未通过",
  credential_capability_denied: "缺少凭证管理能力位",
  credential_ambiguous: "同一账户存在多条有效凭证，请先人工处置",
  account_inactive: "该渠道账户已停用，请先启用后再操作",
});

/** Reason refines the code; without it the two session expiries read identically. */
const REASON_COPY: Readonly<Record<string, string>> = Object.freeze({
  idle_timeout: "长时间未操作，会话已超时",
  absolute_timeout: "会话已达 24 小时上限，需要重新登录",
  idempotency_conflict: "该请求标识已用于另一次不同的提交，已拒绝以避免静默覆盖",
});

export function errorEnvelopeCopy(envelope: ErrorEnvelope): string {
  const reason = envelope.details?.reason;
  if (reason && REASON_COPY[reason]) return REASON_COPY[reason];
  if (envelope.code === "admin_capability_denied" && envelope.details?.capability) {
    const capability = envelope.details.capability as keyof typeof ADMIN_CAPABILITY_LABELS;
    const label = ADMIN_CAPABILITY_LABELS[capability];
    if (label) return `缺少能力位 ${label}（${capability}）`;
  }
  if (envelope.code === "admin_rate_limited" && envelope.details?.retryAfterSeconds) {
    return `操作过于频繁，请 ${envelope.details.retryAfterSeconds} 秒后重试`;
  }
  return COPY[envelope.code] ?? "操作失败，请稍后重试";
}
