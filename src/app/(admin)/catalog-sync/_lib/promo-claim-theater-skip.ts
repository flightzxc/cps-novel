import type { CatalogBatchContext, CatalogSelection } from "@/domain/catalog-batch";

/**
 * B-44 第 3 条（v0.6.4，Owner 2026-10-19 拍板"自动跳过并提示"）：领取对话框里，所选的书如果
 * 有一部分在「领取已暂停」的剧场（`claimPromo` 能力没开，例如上游不发码的 PlotNovel），提交前
 * 把它们排除掉并提示"已跳过 N 本（PlotNovel 领取暂停）"，其余剧场照常提交——运营不用再一本本
 * 取消勾选。
 *
 * 🔴 "能力开没开"只认服务端算好的 `channelGroups[].claimCapabilityEnabled`
 * （`readCatalogBatchContext`：`channel_capability.claimPromo` 的 `status === "enabled"`，与 worker
 * 枚举时按分组校验的 `capabilities: { some: { capabilityKey: claimPromo, status: "enabled" } }`
 * 是同一个判定），前端不另写规则。被排除的书不进批次：
 * - 勾选模式（`explicit_ids`）：按行的 `channelAppId` 从 ids 里去掉。勾选只在当前页（同一 B-44
 *   的"换页也清空"），所以每个勾选的 id 都能在当前页找到所属剧场；万一找不到（不应发生）就保留，
 *   由 worker 的分组能力校验兜底（记为未提交，不会领码）。
 * - 全选模式（`all_filtered`）：快照加上剧场条件 `channelAppId`，只剩一个可领取的剧场时收窄到它；
 *   可领取的剧场不止一个时快照表达不了"排除某几个剧场"，直接拦下，请运营先在「剧场」筛选里选定。
 *
 * 渠道停用、没有可用账户这两种配置问题不在"跳过"之列，仍按原样整单拦下（那是要修配置，不是暂停）。
 */

export type PromoClaimGroup = CatalogBatchContext["channelGroups"][number] & {
  readonly active?: boolean;
  readonly claimCapabilityEnabled?: boolean;
};

export type PromoClaimTheaterPlan =
  | {
      readonly kind: "submit";
      /** 实际提交（以及预估）用的选择；没有暂停剧场时就是原选择本身。 */
      readonly selection: CatalogSelection;
      /** 参与领取的分组（能力已开）。 */
      readonly claimGroups: readonly PromoClaimGroup[];
      /** 被跳过的分组（能力未开）；空 = 没有跳过任何书。 */
      readonly skippedGroups: readonly PromoClaimGroup[];
      /** 被跳过的书数（各暂停分组 `eligibleCount` 之和）。 */
      readonly skippedCount: number;
    }
  | { readonly kind: "all_paused" }
  | { readonly kind: "all_filtered_needs_theater"; readonly skippedGroups: readonly PromoClaimGroup[] };

export function isClaimPausedGroup(group: PromoClaimGroup): boolean {
  return group.claimCapabilityEnabled === false;
}

/** 提示里用的剧场名：优先来源 App 名（PlotNovel），老数据缺失时退回渠道名。 */
export function promoClaimGroupTheaterName(group: PromoClaimGroup): string {
  return group.sourceAppName || group.channelName;
}

export function planPromoClaimTheaters(
  selection: CatalogSelection,
  groups: readonly PromoClaimGroup[],
  itemChannelAppIds: Readonly<Record<string, string>>,
): PromoClaimTheaterPlan {
  const skippedGroups = groups.filter(isClaimPausedGroup);
  const claimGroups = groups.filter((group) => !isClaimPausedGroup(group));
  if (skippedGroups.length === 0) {
    return { kind: "submit", selection, claimGroups, skippedGroups, skippedCount: 0 };
  }
  if (claimGroups.length === 0) return { kind: "all_paused" };
  const skippedCount = skippedGroups.reduce((sum, group) => sum + group.eligibleCount, 0);
  const skippedIds = new Set(skippedGroups.map((group) => group.channelAppId));
  if (selection.scope === "explicit_ids") {
    const ids = selection.ids.filter((id) => {
      const channelAppId = itemChannelAppIds[id];
      return channelAppId === undefined || !skippedIds.has(channelAppId);
    });
    return { kind: "submit", selection: { scope: "explicit_ids", ids }, claimGroups, skippedGroups, skippedCount };
  }
  if (claimGroups.length === 1) {
    return {
      kind: "submit",
      selection: { scope: "all_filtered", filter: { ...selection.filter, channelAppId: claimGroups[0]!.channelAppId } },
      claimGroups,
      skippedGroups,
      skippedCount,
    };
  }
  return { kind: "all_filtered_needs_theater", skippedGroups };
}

/** "已跳过 N 本（PlotNovel 领取暂停）"；多个暂停剧场用顿号连起来。 */
export function promoClaimSkipNotice(skippedGroups: readonly PromoClaimGroup[], skippedCount: number): string {
  const names = Array.from(new Set(skippedGroups.map(promoClaimGroupTheaterName))).join("、");
  return `已跳过 ${skippedCount.toLocaleString("zh-CN")} 本（${names} 领取暂停）`;
}
