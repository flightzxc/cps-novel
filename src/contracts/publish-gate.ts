import { PREVIEW_MATERIALIZATION_POLICIES } from "@/domain/database-statuses";

/**
 * P2-01 发布门禁共享契约（CPS parity）。
 *
 * 权威依据：`docs/p2/P2_01_PUBLISH_GATE_CONTRACT.md` 与
 * `docs/governance/P2_HANDOFF_INPUT.md` §3/§5/§9；参照 CPS 短剧站 publishType
 * 与发布前硬门禁。变更级别 🔴 FROZEN（变更需 Owner 确认）。
 */

/**
 * 发布意图（CPS parity：publishType draft/now/scheduled，仅请求参数，永不落库）。
 * 小说侧无 pending 生命周期态：scheduled = 保持 draft + 设置 publishAt，由后续调度在到点时走同一 gate 再发布。
 */
export const PUBLISH_INTENTS = Object.freeze(["draft", "now", "scheduled"] as const);
export type PublishIntent = (typeof PUBLISH_INTENTS)[number];

/** CPS parity：publishType 默认 draft（`docs/p1/P1_ADMIN_PARITY_SPEC.md:146`）。 */
export const DEFAULT_PUBLISH_INTENT = "draft" as const satisfies PublishIntent;

const PUBLISH_INTENT_SET: ReadonlySet<string> = new Set(PUBLISH_INTENTS);

/** 未登记值收敛为 null，调用方按无效请求处理。 */
export function narrowPublishIntent(value: unknown): PublishIntent | null {
  return typeof value === "string" && PUBLISH_INTENT_SET.has(value)
    ? (value as PublishIntent)
    : null;
}

/**
 * 发布失败稳定理由码。全部为阻断级：任一存在即拒绝本次 now/scheduled，内容保持 draft。
 * promo_link_missing 与 public_redirect_code_missing 为 Owner 定义的 Hard Gate，
 * 任何未来豁免机制都不得绕过（P2 V1 本就无豁免机制）。
 */
export const PUBLISH_GATE_REASONS = Object.freeze([
  "locale_not_publishable", // isPublishableLocale 为 false（D-7 fail-closed）
  "required_metadata_missing", // 标题/slug/正文等发布硬字段缺失（对应 article published CHECK）
  "preview_unavailable", // 无可信已物化试读章节（章节真源边界）
  "promo_link_missing", // Hard Gate：PromoLink 缺失或非 fetched（CPS promoUrl 门禁 parity）
  "public_redirect_code_missing", // Hard Gate：公开跳转短码未分配（CPS promoCode parity）
  "page_identity_conflict", // slug/(novelId,locale)/短码等页面身份冲突（CPS duplicate_page parity）
  "rights_blocked", // 权利态阻断：takedown/withdrawn 等（CPS rightsStatus parity）
  "blocking_exception", // 机器校验存在未处置异常（含未知理由的 fail-closed 收敛）
] as const);
export type PublishGateReason = (typeof PUBLISH_GATE_REASONS)[number];

const PUBLISH_GATE_REASON_SET: ReadonlySet<string> = new Set(PUBLISH_GATE_REASONS);

/** 未登记值收敛为 null，调用方按无效请求处理。 */
export function narrowPublishGateReason(value: unknown): PublishGateReason | null {
  return typeof value === "string" && PUBLISH_GATE_REASON_SET.has(value)
    ? (value as PublishGateReason)
    : null;
}

/**
 * 门禁结果。无自由文本字段：不承载任何异常说明文字或凭证类敏感值——
 * 分成比例与来源标签字段永不参与本门禁，见 P2_01 文档 §口径。
 */
export type PublishGateResult = {
  readonly publishable: boolean;
  readonly reasons: readonly PublishGateReason[]; // publishable === (reasons.length === 0)
};

/**
 * 组装门禁结果：支持一次返回多个失败原因；未登记的理由不丢弃，
 * 统一 fail-closed 收敛为 blocking_exception；去重并按注册表顺序输出；结果与数组均冻结。
 */
export function buildPublishGateResult(candidateReasons: readonly unknown[]): PublishGateResult {
  // 非数组输入（含 null/字符串/类数组对象）本身就是一种未处置异常，
  // 与 narrowPublishGateReason 对未登记值的处理对称：fail-closed，绝不抛出。
  if (!Array.isArray(candidateReasons)) {
    return Object.freeze({
      publishable: false,
      reasons: Object.freeze(["blocking_exception"]) as readonly PublishGateReason[],
    });
  }

  const narrowed: PublishGateReason[] = candidateReasons.map(
    (candidate) => narrowPublishGateReason(candidate) ?? "blocking_exception",
  );
  const present = new Set<PublishGateReason>(narrowed);
  const ordered = PUBLISH_GATE_REASONS.filter((reason) => present.has(reason));
  const reasons: readonly PublishGateReason[] = Object.freeze(ordered);

  const result: { publishable: boolean; reasons: readonly PublishGateReason[] } = {
    publishable: reasons.length === 0,
    reasons,
  };
  return Object.freeze(result);
}

/**
 * Changdu V1 试读契约：只物化上游可信非空 chapterList[] 实际返回章节，上限 3；
 * 少于 3 章按实际数量；totalChapterCount 永远只是标量，禁止用总数补造章节。
 */
export const CHANGDU_PREVIEW_CHAPTER_CAP = 3;

export const CHANGDU_PREVIEW_POLICY = Object.freeze({
  materializationPolicy: PREVIEW_MATERIALIZATION_POLICIES[0], // "upstream_returned_preview"
  maxChapters: CHANGDU_PREVIEW_CHAPTER_CAP,
} as const);

/**
 * 入参 = 上游可信返回的真实章节数（单一入参，杜绝把总数当输入）。
 * 非整数/负数/非 number 一律 0（fail-closed）；否则 min(count, 3)。
 * 结果用 `|| 0` 归一化负零：`-0` 在数值上等于 0，但 `Object.is(-0, 0)` 为 false，
 * 调用方按整数计数使用时不应该看到带符号的零。
 */
export function resolveChangduPreviewChapterCount(trustedReturnedChapterCount: unknown): number {
  if (typeof trustedReturnedChapterCount !== "number") return 0;
  if (!Number.isInteger(trustedReturnedChapterCount)) return 0;
  if (trustedReturnedChapterCount < 0) return 0;
  return Math.min(trustedReturnedChapterCount, CHANGDU_PREVIEW_CHAPTER_CAP) || 0;
}

/**
 * paid_from_chapter（上游 payEpisFrom）P2 V1 政策：只作为来源字段保存；
 * 后续变化不触发任何自动动作（呼应 domain 不变量 paidFromChapterMetadata）。
 */
export const PAID_FROM_CHAPTER_POLICY = Object.freeze({
  storedAsSourceValue: true,
  autoWithdrawOnChange: false,
  autoDeleteContentOnChange: false,
  autoSeoRecomputeOnChange: false,
  autoIndexNowOnChange: false,
} as const);
