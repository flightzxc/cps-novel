import type { AdminCapabilityState, AdminCapabilityView } from "@/contracts";
import type { AdminCapability } from "@/lib/auth/capabilities";

export const ADMIN_CAPABILITY_LABELS: Readonly<Record<AdminCapability, string>> = Object.freeze({
  "credential:manage": "凭证管理",
  // X6 companion change in a Claude-owned UI file: Claude custodian review is
  // required before integration; the backend capability is authoritative.
  "settings:manage": "站点设置管理",
  "content:publish": "内容发布",
  "content:takedown": "内容下架",
  "content:view": "内容查看",
  "content:read": "章节正文读取",
  "promo:claim": "推广领取",
  "revenue:view": "收益查看",
});

export function findCapabilityState(
  capabilities: readonly AdminCapabilityView[],
  capability: AdminCapability,
): AdminCapabilityState {
  return capabilities.find((entry) => entry.capability === capability)?.state ?? "denied";
}

/**
 * Acceptance criterion ⑥: a blocked control must name the missing capability
 * rather than say "无权限". The two blocked states need different wording — one
 * is fixable by completing 2FA in this session, the other needs an admin grant.
 *
 * For `content:view` / `content:read` only the grant branch is reachable:
 * `projectAdminCapability` cannot produce `two_factor_required` for a capability
 * configured `requiresTwoFactor: false`.
 */
export function capabilityBlockReason(
  capability: AdminCapability,
  state: AdminCapabilityState,
): string | null {
  const label = `${ADMIN_CAPABILITY_LABELS[capability]}（${capability}）`;
  if (state === "granted") return null;
  return state === "two_factor_required"
    ? `需要先完成当前会话的双重验证才能使用${label}`
    : `缺少能力位 ${label}，请联系管理员授予`;
}
