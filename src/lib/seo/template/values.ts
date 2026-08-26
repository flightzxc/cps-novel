/**
 * 模板取值表构建（P2-02）。
 *
 * 形态照搬 CPS `src/lib/template-engine.ts:85-137` 的 `buildWildcardMap`：一张
 * **扁平、预字符串化**的表，`null` 在这里就被折成 `""`，数字在这里就被转成字符串。
 * 正是这一层让引擎本体能保持在百行以内、不需要嵌套路径、不需要类型转换。
 * 字段整表换成小说字段，搬运登记见 `docs/governance/port-registry.md`。
 *
 * 🔴 **取值表恒含全部已登记键**，缺失的填 `""`。这是可空字段能用条件块表达的前提：
 * `{if cover_url}…{endif}` 遇到 `""` 安静地移除整块，而 `{cover_url}` 遇到 `""` 抛错。
 *
 * 🔴 **用 `Map` 而不是普通对象承载取值。** 模板变量名匹配 `\w+`，`{constructor}`
 * `{__proto__}` `{toString}` 都写得出来；普通对象上的 `values[name]` 会顺着原型链取到
 * 函数并渲染出 `[object Function]`。`Map` 结构上不存在这条路径。
 *
 * 🔴 **引擎不构造任何 URL**。`promoRedirectUrl` 是调用方按公开跳转码预先解析好的
 * 字符串（URL 构造的唯一入口是共享契约登记的构造函数），这里只做形态归一。
 *
 * 入参类型全部本地声明，**不 import `@prisma/client`**：本仓库没有
 * `postinstall: prisma generate`，干净 clone 上引用生成类型会让 `typecheck` 直接失败。
 */

import { REGISTERED_TEMPLATE_FIELDS, type TemplateFieldKey } from "./fields";

/** 渲染期取值表。键恒为全部已登记字段，值恒为字符串（缺失即 `""`）。 */
export type NovelTemplateValues = ReadonlyMap<TemplateFieldKey, string>;

/**
 * 构建取值表的入参。
 *
 * 🔴 这里出现的字段就是模板能消费的全部内容，与
 * `src/features/public-ui/types.ts` 的用户端视图模型同源。**不得为了模板方便新增
 * `author` / `country` / `completionStatus` / `rating` / `views` / `splitRatio` /
 * `upstreamCode` / 原始来源标签 / 章节正文**——见 `fields.ts` 的不登记清单。
 */
export type NovelTemplateInput = {
  /** `Novel.title`（非空列） */
  readonly title: string;
  /** `Novel.description`（非空列） */
  readonly description: string;
  /** `Novel.coverUrl`，可空 */
  readonly coverUrl?: string | null;
  /** `Novel.totalChapterCount`。客观标量，默认 0 表示未知，绝不据此生成章节行 */
  readonly totalChapterCount?: number | null;
  /**
   * 实际已物化的试读章节数量（口径对应 `NovelPreviewPolicy.materializedChapterCount`）。
   * 由调用方传入——该表的读写归 P2-05，引擎不自己去读。
   */
  readonly previewChapterCount?: number | null;
  /** 调用方预先解析好的正式阅读地址，可空 */
  readonly promoRedirectUrl?: string | null;
};

function normalizeText(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 计数字段归一。非负整数才有意义；`NaN` / 负数 / 小数 / `null` 一律折成 `""`，
 * 于是模板里引用它会抛 `ERR_TEMPLATE_VAR_EMPTY` 而不是渲染出 `NaN` 或 `null`。
 */
function normalizeCount(value: number | null | undefined): string {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? String(value) : "";
}

/**
 * 构建取值表。纯函数：不读数据库、不发请求、不取当前时间，相同入参恒等输出。
 *
 * 逐键显式赋值——不 spread 入参，也不 spread 数据库行。登记表新增字段却忘了在这里
 * 赋值时，末尾的补齐循环会把它填成 `""`（渲染期报缺值），而不是留一个 `undefined`。
 */
export function buildNovelTemplateValues(input: NovelTemplateInput): NovelTemplateValues {
  const values = new Map<TemplateFieldKey, string>([
    ["novel_title", normalizeText(input.title)],
    ["novel_description", normalizeText(input.description)],
    ["cover_url", normalizeText(input.coverUrl)],
    ["total_chapter_count", normalizeCount(input.totalChapterCount)],
    ["preview_chapter_count", normalizeCount(input.previewChapterCount)],
    ["promo_redirect_url", normalizeText(input.promoRedirectUrl)],
  ]);

  for (const field of REGISTERED_TEMPLATE_FIELDS) {
    if (typeof values.get(field.key) !== "string") {
      values.set(field.key, "");
    }
  }

  return values;
}
