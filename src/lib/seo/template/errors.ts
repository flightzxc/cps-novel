/**
 * 模板渲染错误面（P2-02）。
 *
 * 形态照搬 CPS `src/lib/template-engine.ts:37-74` 的 `TemplateVarEmptyError`：
 * 一个字符串错误码常量 + 一个 `Error` 子类（把码挂成实例只读属性）+ 一个
 * **鸭子类型** guard。guard 同时接受 `instanceof` 与 `code` 属性判定，这一条不是
 * 多余的防御——Worker 与 Web 是不同的模块 realm，跨 realm 时 `instanceof` 不可靠，
 * CPS 的 `worker/handlers/batch-generate.ts:63-71` 正是靠 `code` 判定把模板错误
 * 归类为「不可重试」。搬运登记见 `docs/governance/port-registry.md`。
 *
 * CPS 只有 `ERR_TEMPLATE_VAR_EMPTY` 一个码，因为它只有 slug 一个严格槽位；小说侧
 * 全槽位严格（`src/lib/seo/README.md`：渲染期缺值 fail-closed），失败原因随之分化，
 * 所以扩成五个码。`ERR_TEMPLATE_VAR_EMPTY` 保持与 CPS 同名同值。
 */

export const ERR_TEMPLATE_SYNTAX = "ERR_TEMPLATE_SYNTAX";
export const ERR_TEMPLATE_FIELD_NOT_REGISTERED = "ERR_TEMPLATE_FIELD_NOT_REGISTERED";
export const ERR_TEMPLATE_VAR_EMPTY = "ERR_TEMPLATE_VAR_EMPTY";
export const ERR_TEMPLATE_VALUE_INVALID = "ERR_TEMPLATE_VALUE_INVALID";
export const ERR_TEMPLATE_OUTPUT_INVALID = "ERR_TEMPLATE_OUTPUT_INVALID";

/**
 * 模板渲染的全部失败原因。都是阻断级：任一出现即该条生成失败，不产出半成品文章。
 *
 * - `ERR_TEMPLATE_SYNTAX`——`{if}` 与 `{endif}` 不配对。CPS 在这种情况下把
 *   `{if x}` 当普通文本泄漏到输出里，本项目视为模板本身有病，直接拒绝。
 * - `ERR_TEMPLATE_FIELD_NOT_REGISTERED`——模板引用了白名单之外的名字。CPS 是
 *   「原样透出」（变量位）或「静默删块」（条件位），两种都会让 `{author}` 悄悄上线。
 * - `ERR_TEMPLATE_VAR_EMPTY`——已登记字段在渲染期没有取值。可空字段的正确写法是
 *   条件块，不是让它渲染成空串。
 * - `ERR_TEMPLATE_VALUE_INVALID`——`url` 类字段的取值不是 http/https 绝对地址。
 * - `ERR_TEMPLATE_OUTPUT_INVALID`——渲染产物违反槽位输出合同（trim 后为空、
 *   或超出目标列长度）。对齐 `article` 表的 `btrim(...) <> ''` 与 `VarChar(500)`。
 */
export const TEMPLATE_ERROR_CODES = Object.freeze([
  ERR_TEMPLATE_SYNTAX,
  ERR_TEMPLATE_FIELD_NOT_REGISTERED,
  ERR_TEMPLATE_VAR_EMPTY,
  ERR_TEMPLATE_VALUE_INVALID,
  ERR_TEMPLATE_OUTPUT_INVALID,
] as const);

export type TemplateErrorCode = (typeof TEMPLATE_ERROR_CODES)[number];

/** 错误定位信息。全部可选：不同失败点能提供的上下文不一样。 */
export type TemplateErrorContext = {
  /** 出错的槽位名（title / body / metaTitle / metaDescription）。 */
  readonly slot?: string;
  /** 出错的模板变量名。未登记字段这里放模板里写的那个原始名字。 */
  readonly field?: string;
  /** 模板记录标识（`ArticleTemplate.templateKey`）。 */
  readonly templateKey?: string;
  /** 出错的小说标识，便于把失败条目落回队列。 */
  readonly novelId?: string;
  /** 输出合同的具体违反项，仅 `ERR_TEMPLATE_OUTPUT_INVALID` 使用。 */
  readonly constraint?: string;
};

/**
 * 模板渲染失败。
 *
 * `message` 只拼接结构化定位信息（`code: k=v k=v`），**不携带渲染出的正文片段**，
 * 避免把内容原文写进日志与错误链路。
 */
export class TemplateRenderError extends Error {
  readonly code: TemplateErrorCode;
  readonly slot?: string;
  readonly field?: string;
  readonly templateKey?: string;
  readonly novelId?: string;
  readonly constraint?: string;

  constructor(code: TemplateErrorCode, context: TemplateErrorContext = {}) {
    const details = [
      context.slot === undefined ? null : `slot=${context.slot}`,
      context.field === undefined ? null : `field=${context.field}`,
      context.constraint === undefined ? null : `constraint=${context.constraint}`,
      context.templateKey === undefined ? null : `templateKey=${context.templateKey}`,
      context.novelId === undefined ? null : `novelId=${context.novelId}`,
    ].filter((part): part is string => part !== null);

    super(details.length > 0 ? `${code}: ${details.join(" ")}` : code);
    this.name = "TemplateRenderError";
    this.code = code;
    if (context.slot !== undefined) this.slot = context.slot;
    if (context.field !== undefined) this.field = context.field;
    if (context.templateKey !== undefined) this.templateKey = context.templateKey;
    if (context.novelId !== undefined) this.novelId = context.novelId;
    if (context.constraint !== undefined) this.constraint = context.constraint;
  }
}

const CODE_SET: ReadonlySet<string> = new Set(TEMPLATE_ERROR_CODES);

/**
 * 是否是模板渲染失败。
 *
 * 🔴 不能只写 `instanceof`：Worker 与 Web 是不同模块 realm，同一个类会有两份构造器。
 * 因此同时接受「带已登记 `code` 属性的对象」这条鸭子类型判定（CPS 同款写法）。
 */
export function isTemplateRenderError(error: unknown): error is TemplateRenderError {
  if (error instanceof TemplateRenderError) return true;
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    CODE_SET.has((error as { code: string }).code)
  );
}
