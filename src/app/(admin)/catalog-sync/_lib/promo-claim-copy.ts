/** Operator-facing reason labels only. Detailed task diagnostics stay in `/tasks`. */
export function skipReasonLabel(reason: string): string {
  return ({
    source_not_linked: "来源条目尚未关联书目",
    item_already_active_elsewhere: "该来源条目已有进行中的领取任务",
    source_unlinked_or_deleted: "来源条目已删除或失去关联",
    already_has_promo_code: "已有推广码",
    manual_review_pending: "人工核对中",
  } as Readonly<Record<string, string>>)[reason] ?? "不符合领取条件";
}

/**
 * B-4：目录同步页"领取资格"列的完整展示文本。`already_has_promo_code`/
 * `manual_review_pending` 按 Owner 措辞原文直接展示（不带"不可领取 · "
 * 前缀）——与"来源条目尚未关联书目"/"该来源条目已有进行中的领取任务"这两个
 * 原有原因的展示格式刻意保持不同：这两个新状态描述的是"这本书已经有一个
 * 结果了"（已经领到码 / 上一次尝试进了人工核对），而不是"暂时不能领取"，
 * 对运营来说信息性质不同，不应该套进同一个"不可领取 · "前缀里。
 */
export function promoClaimEligibilityLabel(eligible: boolean, reason: string | null): string {
  if (eligible) return "可领取";
  if (reason === "already_has_promo_code" || reason === "manual_review_pending") {
    return skipReasonLabel(reason);
  }
  return `不可领取 · ${skipReasonLabel(reason ?? "source_not_linked")}`;
}
