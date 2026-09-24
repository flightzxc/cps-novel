/**
 * B-4（施工提示词_Sonnet_B4_目录同步页推广链接状态筛选_2026-09-24）：目录
 * 同步页新增的"推广链接状态"筛选，与既有的书目状态/语种筛选彼此独立、取
 * 交集生效。三态互斥、覆盖全部——`undefined`（字段整体缺席）代表"全部"，
 * 不是第四个值，这样一个没有这个字段的历史 `all_filtered` selection 负载
 * （旧批次重放、旧持久化任务）天然落到"全部"，不需要任何迁移或兼容分支。
 */
export const PROMO_LINK_STATUS_FILTER_VALUES = ["not_claimed", "claimed", "manual_review"] as const;
export type PromoLinkStatusFilter = (typeof PROMO_LINK_STATUS_FILTER_VALUES)[number];

export type CatalogFilterSnapshot = Readonly<{
  status?: string;
  search?: string;
  sourceLocale?: string;
  promoLinkStatus?: string;
}>;

export type CatalogSelection =
  | Readonly<{ scope: "explicit_ids"; ids: readonly string[] }>
  | Readonly<{ scope: "all_filtered"; filter: CatalogFilterSnapshot }>;

export type NormalizedCatalogFilterSnapshot = Readonly<{
  status: "pending" | "linked" | "ignored" | "stale";
  search?: string;
  sourceLocale?: string;
  promoLinkStatus?: PromoLinkStatusFilter;
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
  if (raw.promoLinkStatus !== undefined && typeof raw.promoLinkStatus !== "string") {
    throw new CatalogSelectionInputError("filter_promo_link_status_invalid");
  }
  const promoLinkStatus = raw.promoLinkStatus?.trim();
  if (promoLinkStatus && !(PROMO_LINK_STATUS_FILTER_VALUES as readonly string[]).includes(promoLinkStatus)) {
    throw new CatalogSelectionInputError("filter_promo_link_status_invalid");
  }
  return Object.freeze({
    scope: "all_filtered",
    filter: Object.freeze({
      status: status as NormalizedCatalogFilterSnapshot["status"],
      ...(search ? { search } : {}),
      ...(sourceLocale ? { sourceLocale } : {}),
      ...(promoLinkStatus ? { promoLinkStatus: promoLinkStatus as PromoLinkStatusFilter } : {}),
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

/**
 * Opus 复核（2026-09-24 F1，同日第二轮复核修正 capability_disabled 归类）
 * 钉死的六分类口径——每个条目按 `(generic_task_item.status, result.decision)`
 * 精确落入以下六个桶中的恰好一个，互斥、加总等于条目总数：
 *
 *   - `claimed`（已领取） = status=success ∧ decision ∈ {claimed, readback_recovered}
 *   - `withCode`（已有推广码） = (status=success ∧ decision ∈ {already_available, already_fetched})
 *                              ∨ (status=skipped ∧ decision=already_fetched)
 *   - `manualReview`（人工核对） = status=success ∧ decision=manual_review_required
 *     （另见 {@link classifyPromoClaimItemOutcome} 的 doc comment：任何未识别的
 *     decision 同样并入这一桶，不静默吞掉）
 *   - `failed`（失败） = status=failed ∨ (status=success ∧ decision=capability_disabled)
 *     （`capability_disabled` 归入这里而不是 `manualReview`：理由见下方
 *     {@link classifyPromoClaimItemOutcome} 的 doc comment）
 *   - `skipped`（跳过） = status=skipped ∧ decision≠already_fetched（含人工中止前未尝试）
 *   - `remaining`（剩余） = status ∈ {pending, processing}
 *
 * 分类逻辑的唯一权威实现是 {@link classifyPromoClaimItemOutcome}；
 * `src/server/task-admin/service.ts` 的聚合 SQL（LATERAL 子查询里的 CASE
 * 表达式）必须与它逐字一致——那边为了避免把上万条条目整表拉到 Node 里分类
 * 才直接在 SQL 里算，这个 TS 函数专门用于单测钉死分类口径本身，SQL 那份由
 * 真实 Postgres 集成测试（用 worker 真实写入的各种 decision 值）验证。
 */
export type PromoClaimItemOutcomeBucket = "claimed" | "withCode" | "manualReview" | "failed" | "skipped" | "remaining";

/**
 * 单个条目的六分类判定。`decision` 传 `null`/`undefined` 表示条目的
 * `result` 里没有这个字段（例如人工中止级联把 `error.code =
 * 'task_manually_aborted'` 写在 `error` 而不是 `result.decision` 上的
 * skipped 条目）。
 *
 * `already_fetched`（真正执行时 apply 模式下、`scope.existingPromoLink.status
 * === 'fetched'` 分支，`worker/handlers/promo-link-claim.ts`）与
 * `capability_disabled`（能力位在枚举之后、真正执行之前被关闭，同一个
 * handler 文件约 1147-1152 行）这两个 `status=success` 的 decision 值，
 * Opus 给的六分类表原文没有为它们各自单独定义桶位——处理方式：
 *   - `already_fetched` 并入 `withCode`：与 `already_available` 语义完全
 *     相同（都是"这本书已经有推广码，本次没有发起新的上游调用"），只是
 *     达成路径不同（DB 里的 PromoLink 记录 vs 上游预读命中）。
 *   - `capability_disabled` 并入 `failed`（Opus 复核第二轮修正：最初误并入
 *     `manualReview`，已改正）：这条路径只在 PromoLink 上写 `errorKind:
 *     'capability_disabled'`，既不调用 getcode，也不创建
 *     `side_effect_intent`；后台"人工核对"列表是按 `manual_review_required`
 *     的意图记录驱动展示的，这类条目永远不会出现在那份列表里——继续算进
 *     `manualReview` 会让批次汇总计数和人工核对列表的实际条目数对不上，
 *     运营会去列表里找根本不存在的条目。它的真实语义是"执行时领取能力被
 *     关闭、没拿到码、需要开启能力后重新提交"，属于失败，应计入 `failed`。
 *   - 任何其它未识别的 decision 字符串（例如未来 worker 新增的分支）仍然
 *     并入 `manualReview`——fail-safe：宁可让运营多看一眼真正发生了什么，
 *     也不能把一个陌生的结果悄悄计成"已领取"或"已有推广码"。
 */
export function classifyPromoClaimItemOutcome(
  status: string,
  decision: string | null | undefined,
): PromoClaimItemOutcomeBucket {
  if (status === "pending" || status === "processing") return "remaining";
  if (status === "failed") return "failed";
  if (status === "skipped") return decision === "already_fetched" ? "withCode" : "skipped";
  if (status === "success") {
    if (decision === "claimed" || decision === "readback_recovered") return "claimed";
    if (decision === "already_available" || decision === "already_fetched") return "withCode";
    if (decision === "capability_disabled") return "failed";
    // manual_review_required / 任何未知值。
    return "manualReview";
  }
  // 理论上不会出现的 status（不在 generic_task_item 的 CHECK 约束取值内）
  // ——fail-safe 同上，不静默吞掉。
  return "manualReview";
}

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
  /** 以下七个字段全部按 {@link classifyPromoClaimItemOutcome} 的六分类口径预先聚合好——不是原始 generic_task_item.status 计数,页面/领域层不需要再重新派生。 */
  totalCount: number;
  claimedCount: number;
  withCodeCount: number;
  manualReviewCount: number;
  failedCount: number;
  skippedCount: number;
  remainingCount: number;
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
  /** 六类计数，见 {@link classifyPromoClaimItemOutcome} 的分类口径——六项互斥、加总等于 `total`。 */
  counts: Readonly<{
    total: number;
    claimed: number;
    withCode: number;
    manualReview: number;
    failed: number;
    skipped: number;
    remaining: number;
  }>;
  etaMinutes: number | null;
}>;

/**
 * 六类计数的纯派生逻辑——每个分片自己的六个桶已经在
 * `loadPromoClaimBatchLifecycle`（`src/server/task-admin/service.ts`）的
 * 聚合 SQL 里按 {@link classifyPromoClaimItemOutcome} 同一套口径算好，这里
 * 只是逐分片求和，不重新扫描 `generic_task_item`、也不重新做分类判定。
 */
export function derivePromoClaimBatchCounts(
  shards: readonly Pick<PromoClaimShardSummaryDto, "totalCount" | "claimedCount" | "withCodeCount" | "manualReviewCount" | "failedCount" | "skippedCount" | "remainingCount">[],
): PromoClaimBatchLifecycleDto["counts"] {
  const sum = (key: "totalCount" | "claimedCount" | "withCodeCount" | "manualReviewCount" | "failedCount" | "skippedCount" | "remainingCount") =>
    shards.reduce((total, shard) => total + shard[key], 0);
  return Object.freeze({
    total: sum("totalCount"),
    claimed: sum("claimedCount"),
    withCode: sum("withCodeCount"),
    manualReview: sum("manualReviewCount"),
    failed: sum("failedCount"),
    skipped: sum("skippedCount"),
    remaining: sum("remainingCount"),
  });
}
