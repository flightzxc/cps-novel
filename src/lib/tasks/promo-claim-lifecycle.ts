/**
 * 领推广链接批次生命周期（正式修复第 2 阶段，第 1 步：生命周期基础）。
 *
 * 决策来源：`docs/adr/ADR-PROMO-CLAIM-BATCH-LIFECYCLE.md`（D1–D9）。本模块只
 * 实现该 ADR 里"分片大小计算 / 批准时钟 / 凭据就绪 / 截止时间与宽限"这几条
 * 纯逻辑判定，供 `src/lib/tasks/catalog-batch.ts`（批次入队，第 2 步）、
 * `worker/handlers/catalog-batch.ts`（枚举切分片，第 2 步）、`scheduler/`
 * （放行与暂停，第 3 步）和本步的 `src/lib/tasks/store.ts` /
 * `worker/handlers/promo-link-claim.ts` 共同调用。
 *
 * 刻意保持"纯逻辑"：**不导入 `@prisma/client`、不访问数据库、不读任何密钥**。
 * 这是它可以被 scheduler、worker 和 Web 三侧同时安全导入的前提——与
 * `src/lib/tasks/task-control.ts`、`src/lib/credentials/claim-readiness.ts`
 * 的 `classifyCredentialRowsForClaim` 同一纪律："Web/worker-safe shared
 * policy"，调用方负责把数据库行 select 出的非秘密字段传进来，本模块只做
 * 判定，不做 I/O。
 *
 * 开关默认关闭（`isPromoClaimLifecycleEnabled` 在环境变量缺失时返回
 * `false`）；开关关闭时，`src/lib/tasks/catalog-batch.ts`（第 2 步才会改）
 * 不会写 `lifecycleVersion`，因此本模块导出的判定函数在现有批次上永远不会
 * 被调用到——这是"开关关闭时零行为变化"的落地方式：不是判定函数内部各处
 * 加 `if (enabled)`，而是上游（批次创建、`selectPending` 的下推条件、
 * handler 的分支）只在看到 `lifecycleVersion === 1` / `lifecycle ===
 * "shard_v1"` 时才走这条新路径。
 */

// ---------------------------------------------------------------------
// 版本与载荷标记
// ---------------------------------------------------------------------

/**
 * 批次参数 `params.lifecycleVersion` 的取值。目前只有版本 1；`selectPending`
 * 的下推条件与 scheduler 的放行逻辑都以这个精确值（而不是"存在即生命周期
 * 批次"）作为生命周期批次的判据，为将来的版本演进留出空间——新版本的批次
 * 不会被误判为版本 1 的分片。
 */
export const PROMO_CLAIM_LIFECYCLE_VERSION = 1 as const;

/**
 * 分片条目载荷 `payload.lifecycle` 的取值（设计 §5.3）。`worker/handlers/
 * promo-link-claim.ts` 只认这一个精确字符串；缺失或任何其它值都按"旧条目"
 * 处理，逻辑逐字不变（沿用载荷里的 `expiresAt`）。
 */
export const PROMO_CLAIM_SHARD_LIFECYCLE_TAG = "shard_v1" as const;

/**
 * `params.lifecycleRole` 的取值——区分同样带 `lifecycleVersion: 1` 的两种
 * 父任务：**批次**（`batch.materialize.v1`，设计 §5.2）与**分片**
 * （`promo_link.claim.v1`，设计 §5.3）。
 *
 * 为什么不能只按 `lifecycleVersion === 1` 判定"是否要求 `deadlineAt`"：
 * 批次父任务在设计 §5.2 里同样写 `lifecycleVersion: 1`（连同
 * `approvedAt`/`approvalValidUntil`），但批次**没有** `deadlineAt`——那是
 * 分片放行时才会写的字段（§5.3/§5.4）。如果 `selectPending` 的下推只看
 * `lifecycleVersion`，批次自己枚举时建的条目（`catalog_filter_snapshot`，
 * 挂在批次父任务下，不是挂在分片下）就会被"要求 `deadlineAt` 存在"这条
 * 判定永远挡住——批次永远领不到自己的枚举条目，第 2 步一落地就是一个死锁
 * （2026-09-23 复核实证：对 `{"lifecycleVersion":1,"approvedAt":"..."}`
 * 这样的批次参数，旧谓词求值为 false）。
 *
 * 修法是让下推条件同时判定"版本"与"角色"两个字段，只在角色精确等于
 * `"shard"` 时才要求 `deadlineAt`；角色是 `"batch"`（或角色字段缺失，
 * 兼容不认识 `lifecycleRole` 的旧数据）的父任务完全不受这条下推影响，
 * 按现有逻辑正常放行。
 */
export const PROMO_CLAIM_LIFECYCLE_ROLES = Object.freeze(["batch", "shard"] as const);
export type PromoClaimLifecycleRole = (typeof PROMO_CLAIM_LIFECYCLE_ROLES)[number];

export const PROMO_CLAIM_LIFECYCLE_ROLE_BATCH: PromoClaimLifecycleRole = "batch";
export const PROMO_CLAIM_LIFECYCLE_ROLE_SHARD: PromoClaimLifecycleRole = "shard";

export function isPromoClaimLifecycleRole(value: unknown): value is PromoClaimLifecycleRole {
  return typeof value === "string"
    && (PROMO_CLAIM_LIFECYCLE_ROLES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------
// 系统暂停原因码（新增于 `kind: "system_hold"` 之上，`reasonCode` 字段仍是
// `src/lib/tasks/task-control.ts` 里的自由字符串，这里只是把这一族的字面量
// 集中管理，方便 scheduler/UI 引用同一份取值，不各自造字符串）。
// ---------------------------------------------------------------------

export const PROMO_CLAIM_SYSTEM_HOLD_REASON_CODES = Object.freeze([
  "approval_expired",
  "credential_not_ready",
  "deadline_missed",
  "deadline_missed_twice",
  "lifecycle_disabled",
] as const);

export type PromoClaimSystemHoldReasonCode = (typeof PROMO_CLAIM_SYSTEM_HOLD_REASON_CODES)[number];

export function isPromoClaimSystemHoldReasonCode(value: unknown): value is PromoClaimSystemHoldReasonCode {
  return typeof value === "string"
    && (PROMO_CLAIM_SYSTEM_HOLD_REASON_CODES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------
// 配置：环境变量名、默认值、解析。
//
// 数值型配置的失败方向选择"报错"，不是"回落默认值"——照抄本仓库既有的
// `resolvePromoLinkClaimReadbackPolicy`/`clampedInteger`
// （`src/lib/tasks/promo-link-claim-limits.ts`）的先例：非法输入直接抛出一个
// 具名 Error（这里是 `PromoClaimLifecycleConfigError`），而不是静默吃掉、
// 换成默认值——窗口/批准有效期/分片上下限这些数字一旦被"以为生效、其实被
// 吃成默认值"地悄悄替换，很难在生产被发现，抛错能让部署时就暴露配置笔误。
// ---------------------------------------------------------------------

export const PROMO_CLAIM_LIFECYCLE_ENV = Object.freeze({
  enabled: "PROMO_CLAIM_LIFECYCLE_V1_ENABLED",
  approvalTtlMinutes: "PROMO_CLAIM_BATCH_APPROVAL_TTL_MINUTES",
  shardWindowMinutes: "PROMO_CLAIM_SHARD_WINDOW_MINUTES",
  shardSizeMax: "PROMO_CLAIM_SHARD_SIZE_MAX",
  shardSizeMin: "PROMO_CLAIM_SHARD_SIZE_MIN",
  credentialSafetyMarginMinutes: "PROMO_CLAIM_CREDENTIAL_SAFETY_MARGIN_MINUTES",
  /**
   * 截止宽限（设计 §5.6，默认 10 分钟）。设计文档允许"常量或配置均可"；
   * 做成配置是为了和其它时间类参数保持同一种可调整方式，UAT/预生产可以在
   * 不改代码的情况下调小它去更容易触发"错过截止时间"分支（施工任务第 5
   * 步的 8 万级 dry-run 模拟就依赖这一点）。
   */
  deadlineGraceMinutes: "PROMO_CLAIM_SHARD_DEADLINE_GRACE_MINUTES",
});

export const PROMO_CLAIM_LIFECYCLE_DEFAULTS = Object.freeze({
  approvalTtlMinutes: 1_440,
  shardWindowMinutes: 90,
  shardSizeMax: 1_000,
  shardSizeMin: 50,
  credentialSafetyMarginMinutes: 30,
  deadlineGraceMinutes: 10,
  /** p90 样本缺失或非正数时的保守回退值（设计 §5.3）。 */
  fallbackP90ItemSeconds: 5,
});

export class PromoClaimLifecycleConfigError extends Error {
  constructor(readonly variable: string, message?: string) {
    super(message ?? `${variable} must be a positive integer`);
    this.name = "PromoClaimLifecycleConfigError";
  }
}

function positiveInteger(raw: string | undefined, fallback: number, variable: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new PromoClaimLifecycleConfigError(variable);
  return parsed;
}

function nonNegativeInteger(raw: string | undefined, fallback: number, variable: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new PromoClaimLifecycleConfigError(variable, `${variable} must be a non-negative integer`);
  }
  return parsed;
}

/**
 * 回退开关判定——严格等于字符串 `"true"` 才算开启，任何其它取值（包括
 * `"1"`、`"TRUE"`、缺失）都按关闭处理，与仓库里其它 feature flag
 * （`src/lib/flags/feature-flags.ts` 的"一 flag 一函数、`=== "true"`"约定）
 * 完全一致，代码默认 false（D8）。
 */
export function isPromoClaimLifecycleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PROMO_CLAIM_LIFECYCLE_ENV.enabled] === "true";
}

export interface PromoClaimLifecycleConfig {
  readonly enabled: boolean;
  readonly approvalTtlMinutes: number;
  readonly shardWindowMinutes: number;
  readonly shardSizeMin: number;
  readonly shardSizeMax: number;
  readonly credentialSafetyMarginMinutes: number;
  readonly deadlineGraceMinutes: number;
}

/**
 * 解析全部生命周期配置。任何一项非法数值都会 fail-closed 抛错（见本节头部
 * 说明），而不是回落默认值——调用方（批次入队、枚举、scheduler）应当让这个
 * 错误直接冒出来，而不是吞掉继续用默认值运行。
 */
export function resolvePromoClaimLifecycleConfig(
  env: NodeJS.ProcessEnv = process.env,
): Readonly<PromoClaimLifecycleConfig> {
  const defaults = PROMO_CLAIM_LIFECYCLE_DEFAULTS;
  const approvalTtlMinutes = positiveInteger(
    env[PROMO_CLAIM_LIFECYCLE_ENV.approvalTtlMinutes],
    defaults.approvalTtlMinutes,
    PROMO_CLAIM_LIFECYCLE_ENV.approvalTtlMinutes,
  );
  const shardWindowMinutes = positiveInteger(
    env[PROMO_CLAIM_LIFECYCLE_ENV.shardWindowMinutes],
    defaults.shardWindowMinutes,
    PROMO_CLAIM_LIFECYCLE_ENV.shardWindowMinutes,
  );
  const shardSizeMin = positiveInteger(
    env[PROMO_CLAIM_LIFECYCLE_ENV.shardSizeMin],
    defaults.shardSizeMin,
    PROMO_CLAIM_LIFECYCLE_ENV.shardSizeMin,
  );
  const shardSizeMax = positiveInteger(
    env[PROMO_CLAIM_LIFECYCLE_ENV.shardSizeMax],
    defaults.shardSizeMax,
    PROMO_CLAIM_LIFECYCLE_ENV.shardSizeMax,
  );
  if (shardSizeMin > shardSizeMax) {
    throw new PromoClaimLifecycleConfigError(
      PROMO_CLAIM_LIFECYCLE_ENV.shardSizeMin,
      `${PROMO_CLAIM_LIFECYCLE_ENV.shardSizeMin} (${shardSizeMin}) must not exceed ${PROMO_CLAIM_LIFECYCLE_ENV.shardSizeMax} (${shardSizeMax})`,
    );
  }
  const credentialSafetyMarginMinutes = nonNegativeInteger(
    env[PROMO_CLAIM_LIFECYCLE_ENV.credentialSafetyMarginMinutes],
    defaults.credentialSafetyMarginMinutes,
    PROMO_CLAIM_LIFECYCLE_ENV.credentialSafetyMarginMinutes,
  );
  const deadlineGraceMinutes = nonNegativeInteger(
    env[PROMO_CLAIM_LIFECYCLE_ENV.deadlineGraceMinutes],
    defaults.deadlineGraceMinutes,
    PROMO_CLAIM_LIFECYCLE_ENV.deadlineGraceMinutes,
  );
  return Object.freeze({
    enabled: isPromoClaimLifecycleEnabled(env),
    approvalTtlMinutes,
    shardWindowMinutes,
    shardSizeMin,
    shardSizeMax,
    credentialSafetyMarginMinutes,
    deadlineGraceMinutes,
  });
}

// ---------------------------------------------------------------------
// 分片大小计算（设计 §5.3，D3）。
// ---------------------------------------------------------------------

export interface ComputeShardSizeInput {
  /** 该渠道账号最近已完成领取条目的 p90 执行耗时（秒）。缺失/非正数按 5 秒处理。 */
  readonly p90ItemSeconds: number | null | undefined;
  readonly windowMinutes: number;
  readonly min: number;
  readonly max: number;
}

/**
 * S = clamp(floor(0.7 × windowMinutes × 60 ÷ p90ItemSeconds), min, max)。
 * 0.7 是设计定稿的安全系数（意图：分片吞吐留 30% 余量给抖动，不是"卡着窗口
 * 上限算"），不是本模块另加的猜测值。
 *
 * 实现上刻意不写成 `0.7 * windowMinutes * 60`——`(0.7 * 90) * 60` 在
 * IEEE754 双精度下是 `3779.9999999999995`，不是精确的 `3780`，会让
 * 90 分钟/5 秒这类整数输入算出 755 而不是 756（差 1 本，边界测试会抓到）。
 * `windowMinutes * 42`（`60 秒 × 0.7 = 42`）在数学上完全等价，且对本模块
 * 唯一关心的输入范围（正整数分钟数）不引入这个浮点误差。
 */
export function computeShardSize(input: ComputeShardSizeInput): number {
  const p90 = typeof input.p90ItemSeconds === "number"
    && Number.isFinite(input.p90ItemSeconds)
    && input.p90ItemSeconds > 0
    ? input.p90ItemSeconds
    : PROMO_CLAIM_LIFECYCLE_DEFAULTS.fallbackP90ItemSeconds;
  const budgetSeconds = input.windowMinutes * 42;
  const raw = Math.floor(budgetSeconds / p90);
  return Math.min(input.max, Math.max(input.min, raw));
}

// ---------------------------------------------------------------------
// 批准时钟（设计 §5.5，D1）。
// ---------------------------------------------------------------------

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toDateOrNull(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = toDate(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

export interface ApprovalClockInput {
  /** 批次首个分片放行时刻；为空/null 表示"从未放行过任何分片"。 */
  readonly firstReleasedAt: Date | string | null | undefined;
  /** 批次批准有效期截止时刻（= approvedAt + approvalTtlMinutes）。 */
  readonly approvalValidUntil: Date | string | null | undefined;
  readonly now: Date;
}

/**
 * 批准时钟判定（D1）：只有 `firstReleasedAt` 为空时才看
 * `approvalValidUntil`——首个分片一旦放行过，永远返回"未过期"，不再因为
 * 批次创建时间要求重新批准。
 *
 * `approvalValidUntil` 缺失或无法解析成合法时间，在 `firstReleasedAt` 为空
 * 时按"已过期"处理（fail-closed）——数据不完整时优先选择"停下来、需要人工
 * 重新批准"，而不是放行一个连截止时间都算不出来的批次去调用非幂等的上游
 * 接口。
 */
export function isApprovalExpired(input: ApprovalClockInput): boolean {
  if (toDateOrNull(input.firstReleasedAt)) return false;
  const validUntil = toDateOrNull(input.approvalValidUntil);
  if (!validUntil) return true;
  return input.now.valueOf() >= validUntil.valueOf();
}

// ---------------------------------------------------------------------
// 凭据就绪判定（设计 §5.4 第 5 条，D5）。只接收非秘密字段。
// ---------------------------------------------------------------------

export type CredentialNotReadyReason =
  | "status_not_active"
  | "not_validated"
  | "validated_before_creation"
  | "expires_at_missing"
  | "expires_too_soon";

export interface CredentialReadinessInput {
  readonly status: string;
  readonly lastValidatedAt: Date | string | null | undefined;
  readonly expiresAt: Date | string | null | undefined;
  readonly createdAt: Date | string;
  readonly now: Date;
  readonly windowMinutes: number;
  readonly safetyMarginMinutes: number;
}

export interface CredentialReadinessResult {
  readonly ready: boolean;
  /** 空数组表示三项全部满足；否则列出每一条不满足的具体原因，供 scheduler/审计使用。 */
  readonly reasons: readonly CredentialNotReadyReason[];
}

/**
 * 三项全部满足才 `ready: true`（D5）：
 *   1. `status === "active"`；
 *   2. 校验成功：`lastValidatedAt` 非空，且不早于 `createdAt`；
 *   3. 剩余有效期：`expiresAt` ≥ `now + windowMinutes + safetyMarginMinutes`。
 * 三项互相独立判定、互不short-circuit，`reasons` 可以同时列出多条失败原因。
 */
export function evaluateCredentialReadiness(input: CredentialReadinessInput): CredentialReadinessResult {
  const reasons: CredentialNotReadyReason[] = [];

  if (input.status !== "active") reasons.push("status_not_active");

  const lastValidatedAt = toDateOrNull(input.lastValidatedAt);
  const createdAt = toDate(input.createdAt);
  if (!lastValidatedAt) {
    reasons.push("not_validated");
  } else if (lastValidatedAt.valueOf() < createdAt.valueOf()) {
    reasons.push("validated_before_creation");
  }

  const expiresAt = toDateOrNull(input.expiresAt);
  const requiredUntilMs = input.now.valueOf() + (input.windowMinutes + input.safetyMarginMinutes) * 60_000;
  if (!expiresAt) {
    reasons.push("expires_at_missing");
  } else if (expiresAt.valueOf() < requiredUntilMs) {
    reasons.push("expires_too_soon");
  }

  return Object.freeze({ ready: reasons.length === 0, reasons: Object.freeze(reasons) });
}

// ---------------------------------------------------------------------
// 截止时间与宽限（设计 §5.6/§5.7）。
// ---------------------------------------------------------------------

/** `deadlineAt = releasedAt + windowMinutes`（scheduler 放行时写入，第 3 步实现；本函数只是纯计算）。 */
export function computeShardDeadline(releasedAt: Date, windowMinutes: number): Date {
  return new Date(releasedAt.valueOf() + windowMinutes * 60_000);
}

/** handler 的有效截止 = `deadlineAt + graceMinutes`（设计 §5.6 第二道防线）。 */
export function computeEffectiveDeadlineWithGrace(deadlineAt: Date, graceMinutes: number): Date {
  return new Date(deadlineAt.valueOf() + graceMinutes * 60_000);
}

/**
 * 判定"分片截止时间（含宽限）是否已过"，供 `worker/handlers/
 * promo-link-claim.ts` 对 `lifecycle: "shard_v1"` 条目使用。
 *
 * `deadlineAt` 缺失或无法解析时按"已过期"处理（fail-closed）——这正是设计
 * §5.6 要求的"任务参数缺 deadlineAt 时按过期处理"：一个生命周期分片按理不
 * 应该在没有 `deadlineAt` 的情况下进入 `pending`（`selectPending` 的下推
 * 条件已经把这种情况挡在了领取之前），这里是第二道防线，永远不应该真正
 * 触发；触发时选择"当作过期"而不是"当作永不过期"。
 */
export function isPastDeadlineWithGrace(
  deadlineAt: Date | string | null | undefined,
  graceMinutes: number,
  now: Date,
): boolean {
  const deadline = toDateOrNull(deadlineAt);
  if (!deadline) return true;
  const effective = computeEffectiveDeadlineWithGrace(deadline, graceMinutes);
  return now.valueOf() >= effective.valueOf();
}
