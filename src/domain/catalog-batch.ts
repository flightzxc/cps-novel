export type CatalogFilterSnapshot = Readonly<{
  status?: string;
  search?: string;
  sourceLocale?: string;
}>;

export type CatalogSelection =
  | Readonly<{ scope: "explicit_ids"; ids: readonly string[] }>
  | Readonly<{ scope: "all_filtered"; filter: CatalogFilterSnapshot }>;

export type NormalizedCatalogFilterSnapshot = Readonly<{
  status: "pending" | "linked" | "ignored" | "stale";
  search?: string;
  sourceLocale?: string;
}>;

export type NormalizedCatalogSelection =
  | Readonly<{ scope: "explicit_ids"; ids: readonly string[] }>
  | Readonly<{ scope: "all_filtered"; filter: NormalizedCatalogFilterSnapshot }>;

export class CatalogSelectionInputError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CatalogSelectionInputError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = new Set(["pending", "linked", "ignored", "stale"]);

/** Browser-safe canonicalization used by actions and catalog UI. */
export function normalizeCatalogSelection(selection: CatalogSelection): NormalizedCatalogSelection {
  if (!selection || typeof selection !== "object") throw new CatalogSelectionInputError("selection_required");
  if (selection.scope === "explicit_ids") {
    if (!Array.isArray(selection.ids) || selection.ids.some((id) => typeof id !== "string")) {
      throw new CatalogSelectionInputError("items_invalid");
    }
    const ids = Array.from(new Set(selection.ids.map((id) => id.trim().toLowerCase()))).sort();
    if (ids.length === 0) throw new CatalogSelectionInputError("items_required");
    if (ids.some((id) => !UUID.test(id))) throw new CatalogSelectionInputError("novel_source_item_id_invalid");
    return Object.freeze({ scope: "explicit_ids", ids: Object.freeze(ids) });
  }
  if (selection.scope !== "all_filtered") throw new CatalogSelectionInputError("selection_scope_invalid");
  if (!selection.filter || typeof selection.filter !== "object" || Array.isArray(selection.filter)) {
    throw new CatalogSelectionInputError("filter_invalid");
  }
  const raw = selection.filter;
  if (raw.status !== undefined && typeof raw.status !== "string") throw new CatalogSelectionInputError("filter_status_invalid");
  if (raw.search !== undefined && typeof raw.search !== "string") throw new CatalogSelectionInputError("filter_search_invalid");
  if (raw.sourceLocale !== undefined && typeof raw.sourceLocale !== "string") throw new CatalogSelectionInputError("filter_source_locale_invalid");
  const status = raw.status?.trim() || "pending";
  if (!STATUSES.has(status)) throw new CatalogSelectionInputError("filter_status_invalid");
  const search = raw.search?.trim();
  if (search && search.length > 200) throw new CatalogSelectionInputError("filter_search_too_long");
  const sourceLocale = raw.sourceLocale?.trim();
  if (sourceLocale && sourceLocale.length > 16) throw new CatalogSelectionInputError("filter_source_locale_too_long");
  return Object.freeze({
    scope: "all_filtered",
    filter: Object.freeze({
      status: status as NormalizedCatalogFilterSnapshot["status"],
      ...(search ? { search } : {}),
      ...(sourceLocale ? { sourceLocale } : {}),
    }),
  });
}

/**
 * X10 task control (pause/resume/abort): `paused`/`cancelled` are additive
 * next to `disabled` — a catalog_batch parent (or one of its children) is
 * just as reachable through the generic `TaskControlButtons` UI as any other
 * task, and `pauseTask`/`abortTask` (`src/server/task-admin/service.ts`) now
 * write these two formal statuses instead of `disabled` for that. Guarded
 * the same way `disabled` always was: checked before the
 * `enumerationStatus`-driven aggregation below, so an explicitly paused/
 * aborted batch is never silently re-derived back into `materializing`/
 * `executing`/`completed*` from its enumeration state or its children's
 * counts.
 */
export type CatalogBatchPhase = "queued" | "disabled" | "paused" | "cancelled" | "materializing" | "executing" | "completed" | "completed_with_errors" | "failed" | "expired";

export function deriveCatalogBatchPhase(input: {
  parentStatus: string;
  enumerationStatus?: unknown;
  childStatuses?: readonly string[];
  blockedCount?: number;
}): CatalogBatchPhase {
  if (input.parentStatus === "disabled") return "disabled";
  if (input.parentStatus === "paused") return "paused";
  if (input.parentStatus === "cancelled") return "cancelled";
  if (input.enumerationStatus === "expired") return "expired";
  if (input.enumerationStatus !== "completed") {
    if (input.parentStatus === "failed" || input.parentStatus === "completed_with_errors") return "failed";
    return input.parentStatus === "processing" ? "materializing" : "queued";
  }
  const children = input.childStatuses ?? [];
  if (children.some((status) => status === "pending" || status === "processing")) return "executing";
  if (children.some((status) => status === "cancelled")) return "cancelled";
  if (children.some((status) => status === "paused")) return "paused";
  if (children.some((status) => status === "disabled")) return "disabled";
  if (input.parentStatus === "processing") return "executing";
  if (input.parentStatus === "failed") return "failed";
  if (input.parentStatus === "completed_with_errors") return "completed_with_errors";
  const failures = children.filter((status) => status === "failed" || status === "completed_with_errors").length;
  if (children.length > 0 && children.every((status) => status === "failed")) return "failed";
  if (failures > 0 || (input.blockedCount ?? 0) > 0) return "completed_with_errors";
  return "completed";
}

export type CatalogBatchContext = Readonly<{
  submittedCount: number | null;
  channelGroups: readonly Readonly<{
    channelAppId: string;
    channelCode: string;
    channelName: string;
    active: boolean;
    claimCapabilityEnabled: boolean;
    eligibleCount: number;
    accounts: readonly Readonly<{ id: string; name: string }>[];
  }>[];
  locales: readonly Readonly<{
    locale: string;
    eligibleCount: number;
    templates: readonly Readonly<{ key: string; name: string }> [];
  }>[];
  /**
   * 阶段2 第4步（施工任务 3.6）：`PROMO_CLAIM_LIFECYCLE_V1_ENABLED` 在读取
   * 这个上下文时是否开启——只是一个纯环境变量读取，不是这次查询本身的结果，
   * 放在这里是为了让 `PromoLinkClaimDialog` 不需要单独发一次请求就知道要不
   * 要显示"预计分 N 片、预计耗时 X 小时"。可选字段，缺失按 `false` 处理
   * （现有构造这个类型的测试 fixture 不用全部改）——开关关闭或字段缺失时，
   * 旧对话框行为逐字不变。
   */
  lifecycleEnabled?: boolean;
}>;

/**
 * Only ever populated for `operation: "promo_claim"`, and only when at least
 * one `(channelAppId, channelAccountId)` pair in the submitted scope has a
 * currently-usable credential that is expiring within the promo-claim
 * batch's own TTL window (`CREDENTIAL_EXPIRY_WARNING_WINDOW_MS`,
 * `src/lib/credentials/claim-readiness.ts`) — advisory only, the batch was
 * already admitted. Absent (never an empty array) when there is nothing to
 * warn about, matching this codebase's "absent, not empty" convention for
 * every other optional derived field.
 */
export type PromoLinkClaimCredentialWarning = Readonly<{
  channelAppId: string;
  channelAccountId: string;
  expiresAt: string;
}>;

export type CatalogBatchEnqueueResult = Readonly<{
  taskId: string;
  phase: CatalogBatchPhase;
  credentialWarnings?: readonly PromoLinkClaimCredentialWarning[];
}>;

/**
 * 阶段2 第4步（施工任务 3.6，设计 §5.9）：目录同步页提交确认弹窗"预计分 N
 * 片、预计耗时 X 小时"的预估结果。分片大小/p90 取样复用
 * `src/lib/tasks/promo-claim-shard-sizing.ts` 与枚举时同一套逻辑（不是第二
 * 份实现）。只在开关开启且操作为领推广时才会被调用——旧路径、开关关闭时
 * 前端根本不请求这个预估。
 *
 * `estimatedHours` 的口径（设计原文只写"预计耗时 X 小时"，没有给多渠道账号
 * 场景的精确算法，这是本步的实现判断，已在交付报告里列为待 Owner 确认的
 * 解读）：同一渠道账号任意时刻至多一个分片在跑（D6），所以同一账号名下
 * 多个分组的分片按窗口时间顺序相加；不同渠道账号并行执行，取账号间的最大
 * 值作为总预计耗时的上界——这是一个保守估算，不是精确预测。
 */
export type PromoClaimShardEstimateGroup = Readonly<{
  channelAppId: string;
  channelAccountId: string;
  eligibleCount: number;
  shardSize: number;
  shardCount: number;
}>;

export type PromoClaimShardEstimate = Readonly<{
  totalShardCount: number;
  estimatedHours: number;
  windowMinutes: number;
  groups: readonly PromoClaimShardEstimateGroup[];
}>;

export type CatalogBatchSummary = Readonly<{
  taskId: string;
  phase: CatalogBatchPhase;
  submittedCount: number | null;
  ineligibleCount: number | null;
  alreadyLinkedCount: number | null;
  blockedCount: number | null;
}>;

// ---------------------------------------------------------------------
// 阶段2 第4步（施工任务 3.5）：批次详情页"分片列表 / 领取统计 / 预计完成
// 时间"。只对生命周期批次（lifecycleVersion=1 且 lifecycleRole=batch）
// 生效——旧路径批次继续用上面既有的 `childTasks`/`blockedReasonCounts`。
// ---------------------------------------------------------------------

/** 一个生命周期分片（`promo_link.claim.v1` 子任务）在批次详情页需要展示的字段。 */
export type PromoClaimShardSummaryDto = Readonly<{
  taskId: string;
  shardIndex: number;
  /** 分片自己的原始 `generic_task.status`（disabled/pending/processing/paused/cancelled/completed/completed_with_errors/failed）。 */
  status: string;
  releaseCount: number;
  missedDeadlineCount: number;
  releasedAt?: string;
  deadlineAt?: string;
  totalCount: number;
  successCount: number;
  /** 成功条目中，最终落在"人工核对"（`result.decision === 'manual_review_required'`）的数量——这些条目的 `generic_task_item.status` 仍是 `success`,不是失败,但没有真正拿到新推广码。 */
  manualReviewCount: number;
  failedCount: number;
  skippedCount: number;
  /** 分片当前是否处于系统暂停/人工暂停/人工中止（disabled/paused/cancelled 且带 taskControl 标记）。 */
  holdKind?: string;
  holdReasonCode?: string;
}>;

/** 分片任务状态里代表"已经不会再变化"的终态集合——`disabled`/`paused` 都不算终态（还可能被 scheduler/运营继续推进）。 */
const SHARD_TERMINAL_STATUSES = new Set(["completed", "completed_with_errors", "failed", "cancelled"]);

export function isShardTerminalStatus(status: string): boolean {
  return SHARD_TERMINAL_STATUSES.has(status);
}

/**
 * 按批次 `shardPlan.windowMinutes`（或调用方传入的回退值）与当前放行分片的
 * 剩余窗口时间估算完成时间（分钟）。同一渠道账号任意时刻至多一个分片处于
 * pending/processing（D6），所以这是一个保守的串行估算：当前放行分片按剩余
 * 窗口时间计，其余尚未终结的分片各按整窗口时间计——不是精确预测（真实吞吐
 * 可能明显快于窗口上限，错过截止时间时也可能明显更慢），而是给运营一个
 * "最多还要等多久"量级的参考。全部分片都已终态时返回 0；一个分片都没有
 * （理论上不会发生，枚举总会建至少一片）时返回 `null`。
 */
export function estimatePromoClaimBatchEtaMinutes(
  shards: readonly Pick<PromoClaimShardSummaryDto, "status" | "deadlineAt">[],
  windowMinutes: number,
  now: Date,
): number | null {
  if (shards.length === 0) return null;
  const pending = shards.filter((shard) => !isShardTerminalStatus(shard.status));
  if (pending.length === 0) return 0;
  const active = pending.find((shard) => shard.status === "pending" || shard.status === "processing");
  // 没有分片处于 pending/processing（例如批次刚被暂停，或者所有排队分片都
  // 还没被 scheduler 选中）——不存在"当前放行分片"这个特殊槽位，每个未终态
  // 分片都按整窗口时间计，不能再额外加一份 activeRemainingMinutes。
  if (!active) return pending.length * windowMinutes;
  const activeRemainingMinutes = active.deadlineAt
    ? Math.max(0, Math.ceil((new Date(active.deadlineAt).getTime() - now.getTime()) / 60_000))
    : windowMinutes;
  const queuedCount = pending.length - 1;
  return activeRemainingMinutes + queuedCount * windowMinutes;
}

export type PromoClaimBatchLifecycleDto = Readonly<{
  shardPlan?: Readonly<{
    windowMinutes: number;
    shardSizeMin: number;
    shardSizeMax: number;
    shardCount: number;
    shardSize?: number;
  }>;
  shards: readonly PromoClaimShardSummaryDto[];
  counts: Readonly<{
    total: number;
    claimed: number;
    withCode: number;
    manualReview: number;
    failed: number;
    remaining: number;
  }>;
  etaMinutes: number | null;
}>;

/** 五类计数的纯派生逻辑，从每个分片已经聚合好的条目计数汇总——不重新扫描 `generic_task_item`。 */
export function derivePromoClaimBatchCounts(
  shards: readonly Pick<PromoClaimShardSummaryDto, "totalCount" | "successCount" | "manualReviewCount" | "failedCount" | "skippedCount">[],
): PromoClaimBatchLifecycleDto["counts"] {
  const total = shards.reduce((sum, shard) => sum + shard.totalCount, 0);
  const success = shards.reduce((sum, shard) => sum + shard.successCount, 0);
  const manualReview = shards.reduce((sum, shard) => sum + shard.manualReviewCount, 0);
  const failed = shards.reduce((sum, shard) => sum + shard.failedCount, 0);
  const skipped = shards.reduce((sum, shard) => sum + shard.skippedCount, 0);
  return Object.freeze({
    total,
    claimed: success + failed + skipped,
    withCode: success - manualReview,
    manualReview,
    failed,
    remaining: Math.max(0, total - success - failed - skipped),
  });
}
