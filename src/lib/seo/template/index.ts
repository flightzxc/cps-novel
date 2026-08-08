/**
 * 小说 Template Engine（P2-02）对外入口。
 *
 * 纯函数库：无数据库、无 HTTP、无环境变量、无 secret、无 React/DOM、
 * 不取当前时间、不产生随机数——相同输入恒等输出。
 *
 * 🔴 **不建 `src/lib/seo/index.ts`。** SEO 目录下另有 URL / canonical / 可索引判定等
 * 并行落地的模块，一个 seo 根 barrel 会变成所有人都要改的同一个文件。每个子模块
 * 各自出一个 barrel。
 *
 * 🔴 **本模块不构造 URL、不生成 slug、不做发布判定。** URL 构造走共享契约登记的
 * 构造函数（调用方解析好后作为取值传入），slug 归 P2-03/P2-06，发布准入归 P2-07。
 */

export {
  ARTICLE_TEMPLATE_SLOTS,
  TEMPLATE_SEO_SCHEMA_VERSION,
  narrowArticleTemplateSource,
  renderArticleDraft,
  type ArticleTemplateSlot,
  type ArticleTemplateSource,
  type RenderArticleContext,
  type RenderedArticleDraft,
  type RenderedArticleSeoMetadata,
} from "./article";

export {
  ERR_TEMPLATE_FIELD_NOT_REGISTERED,
  ERR_TEMPLATE_HTML_CONTEXT,
  ERR_TEMPLATE_OUTPUT_INVALID,
  ERR_TEMPLATE_SYNTAX,
  ERR_TEMPLATE_VALUE_INVALID,
  ERR_TEMPLATE_VAR_EMPTY,
  TEMPLATE_ERROR_CODES,
  TemplateRenderError,
  isTemplateRenderError,
  type TemplateErrorCode,
  type TemplateErrorContext,
} from "./errors";

export {
  analyzeHtmlInterpolation,
  type HtmlInterpolationIssue,
  type HtmlInterpolationReason,
} from "./html";

export {
  REGISTERED_TEMPLATE_FIELDS,
  TEMPLATE_FIELD_KEYS,
  getTemplateField,
  isRegisteredTemplateField,
  type TemplateFieldDefinition,
  type TemplateFieldKey,
  type TemplateFieldKind,
} from "./fields";

export {
  analyzeTemplate,
  escapeHtmlText,
  renderTemplateSlot,
  type RenderSlotOptions,
  type TemplateAnalysis,
} from "./render";

export {
  buildNovelTemplateValues,
  type NovelTemplateInput,
  type NovelTemplateValues,
} from "./values";
