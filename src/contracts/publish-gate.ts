/**
 * P2-01 发布门禁共享契约（CPS parity，含 Owner supersession 修订）。
 *
 * 权威依据：`docs/p2/P2_01_PUBLISH_GATE_CONTRACT.md`——尤其是其中「Owner
 * supersession（最高权威）」一节，记录了最新一轮 Owner 决策并显式取代了本文件
 * 更早版本的部分内容。`docs/governance/P2_HANDOFF_INPUT.md` 成文早于本轮 Owner
 * 决策，只作背景材料，不包含 supersession 内容，不得当作 supersession 依据引用。
 * 参照 CPS 短剧站 publishType 与发布前硬门禁。变更级别 🔴 FROZEN（变更需 Owner 确认）。
 *
 * 本文件只是 DTO 形状与归一 helper，不是准入状态机、也不是 evaluator：真正逐项
 * 执行发布检查、决定传入哪些理由的是 P2-07。Changdu 试读的物化数量与 policy cap
 * 落在 P2-05（既有 NovelPreviewPolicy 表），本模块不掌握、也不计算具体物化数量。
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
 * promo_link_missing / promo_link_not_ready / promo_url_invalid 三项合起来承接
 * Owner supersession 决策 7（PromoLink 缺失即禁止发布）。public_redirect_code 本身
 * 由数据库 NOT NULL + UNIQUE 约束保证（`prisma/schema.prisma:481`），业务层永远
 * 到达不了"码未分配"这个状态，因此不作为可达的失败理由登记在此。
 * P2 V1 没有任何豁免机制可以绕过这些理由。
 */
export const PUBLISH_GATE_REASONS = Object.freeze([
  "locale_not_publishable", // isPublishableLocale 为 false（D-7 fail-closed）
  "required_metadata_missing", // 标题/slug/正文等发布硬字段缺失；可携带 RequiredMetadataMissingDetail
  "preview_chapter_missing", // 无可信已物化、可公开的试读章节（章节真源边界）
  "preview_body_missing", // 已物化试读章节存在，但正文为空
  "promo_link_missing", // PromoLink 记录不存在
  "promo_link_not_ready", // PromoLink 存在但未达 fetched/可用态
  "promo_url_invalid", // PromoLink 的跳转 URL 未通过校验
  "page_identity_conflict", // slug/(novelId,locale)/短码等页面身份冲突
  "rights_blocked", // 权利态阻断：takedown/withdrawn 等
  "blocking_sync_exception", // DTO 归一阶段的 fail-closed 收敛：未登记理由或非法输入统一收敛于此
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
 * required_metadata_missing 允许携带的缺失字段清单（对应 article 表 published 行
 * CHECK 约束的非空字段）。字段级判定与实际填充是 P2-07 evaluator 的职责，本契约
 * 只冻结取值域的形状。
 */
export const PUBLISH_REQUIRED_METADATA_FIELDS = Object.freeze(["title", "slug", "body"] as const);
export type PublishRequiredMetadataField = (typeof PUBLISH_REQUIRED_METADATA_FIELDS)[number];

/**
 * required_metadata_missing 的可选详情 DTO。它不是 PublishGateResult 的一部分——
 * PublishGateResult 的形状永远只有 publishable/reasons 两个字段；是否附带、如何
 * 附带这份详情由 P2-07 决定，本契约只冻结它的形状。
 */
export type RequiredMetadataMissingDetail = {
  readonly reason: "required_metadata_missing";
  readonly missingFields: readonly PublishRequiredMetadataField[];
};

/**
 * 门禁结果 DTO。形状恒为 publishable/reasons 两个字段，无自由文本字段：不承载
 * 任何异常说明文字或凭证类敏感值——分成比例与来源标签字段永不参与本门禁，见
 * P2_01 文档 §口径。它是 createPublishGateResult 的返回形状，不是一张持久化的
 * 判定记录表。
 */
export type PublishGateResult = {
  readonly publishable: boolean;
  readonly reasons: readonly PublishGateReason[]; // publishable === (reasons.length === 0)
};

/**
 * 聚合/归一发布门禁候选理由为一份 DTO——不是准入状态机，也不是 evaluator。
 * 它不逐项执行 locale/metadata/preview/promo/身份/权利检查，只把已经产出的候选
 * 理由去重、按注册表顺序排序、把未登记值与非法输入 fail-closed 收敛为
 * blocking_sync_exception，属于 DTO 层的输入卫生（hygiene），不是门禁评估本身。
 * 真正逐项执行发布检查、决定传入哪些理由的是 P2-07 的 evaluator；空 reasons
 * 数组只代表"这次调用没有收到失败理由"，不证明所有检查项都已被执行过。
 */
export function createPublishGateResult(candidateReasons: readonly unknown[]): PublishGateResult {
  // 非数组输入（含 null/字符串/类数组对象）本身就是一种归一失败；
  // 与 narrowPublishGateReason 对未登记值的处理对称：fail-closed，绝不抛出。
  if (!Array.isArray(candidateReasons)) {
    return Object.freeze({
      publishable: false,
      reasons: Object.freeze(["blocking_sync_exception"] as const),
    });
  }

  const narrowed: PublishGateReason[] = candidateReasons.map(
    (candidate) => narrowPublishGateReason(candidate) ?? "blocking_sync_exception",
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
 * paid_from_chapter（上游 payEpisFrom）政策：只作为落库来源字段保存，后续变化
 * 不触发任何自动动作。是 Owner supersession 决策 6 的机器可校验形态（呼应 domain
 * 不变量 paidFromChapterMetadata）。
 */
export const PAID_FROM_CHAPTER_POLICY = Object.freeze({
  storedAsSourceValue: true,
  autoWithdrawOnChange: false,
  autoDeleteContentOnChange: false,
  autoSeoRecomputeOnChange: false,
  autoIndexNowOnChange: false,
} as const);
