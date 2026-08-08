import type {
  AdminCapabilityState,
  AdminCapabilityView,
  ContentReadCapability,
} from "@/contracts";
import type { AdminCapability } from "@/lib/auth/capabilities";

export const ADMIN_CAPABILITY_LABELS: Readonly<Record<AdminCapability, string>> = Object.freeze({
  "credential:manage": "凭证管理",
  "content:takedown": "内容下架",
  "promo:claim": "推广领取",
  "revenue:view": "收益查看",
});

/**
 * Kept in a second table rather than merged into the one above, because the two
 * families behave differently: an `AdminCapability` can be blocked by a missing
 * 2FA step-up, a read capability never can. Merging them would let a caller pass
 * a read capability where `capabilityBlockReason` would offer to run a 2FA
 * challenge that does not apply.
 */
export const CONTENT_READ_CAPABILITY_LABELS: Readonly<Record<ContentReadCapability, string>> =
  Object.freeze({
    "content:view": "内容查看",
    "content:read": "章节正文读取",
  });

/**
 * Reason copy for a blocked read.
 *
 * Only one branch exists, and that is the point: reads are granted or denied,
 * with no "complete 2FA and retry" middle state to offer.
 */
export function contentReadBlockReason(capability: ContentReadCapability): string {
  return `缺少能力位 ${CONTENT_READ_CAPABILITY_LABELS[capability]}（${capability}），请联系管理员授予`;
}

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
