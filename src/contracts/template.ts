/**
 * P2-02 模板引擎共享契约。
 *
 * 引擎实现在 `src/lib/seo/template/`（Owner: Claude 独占写入）；本文件只是它跨所有权
 * 边界的 **DTO 表面**，供 Codex 侧的发布 Worker / Server Action 引用形状，而不越界
 * 直接依赖实现细节。
 *
 * ## 为什么全是 `export type`
 *
 * 契约层规则一是零运行时依赖：只允许 `import type` 引用 `src/lib/**` 与 `src/server/**`
 * （见本目录 `README.md`）。因此登记表、错误码常量、渲染函数这些**值**留在
 * `src/lib/seo/template/`，本文件一个值都不导出，编译后是空模块。
 *
 * 这也避免了第二份同值数组：字段白名单的键在全项目只有一处定义
 * （`src/lib/seo/template/fields.ts`），这里只是把它的类型引过来。
 *
 * ## 为什么不进 `src/contracts/index.ts`
 *
 * 那个 barrel 的自述是「浏览器唯一可以收到的形状」，成员都是带投影函数的前台 DTO。
 * 模板渲染产物不是浏览器载荷，消费方直接 `import type ... from "@/contracts/template"`。
 *
 * ## 与 P2-01 的边界
 *
 * `title` / `body` 两个槽位名与 `PUBLISH_REQUIRED_METADATA_FIELDS` 逐字相同，P2-07
 * 把渲染失败映射成 `required_metadata_missing.missingFields` 时不需要翻译表。
 * 但引擎**不做发布判定**：它返回产物或抛错，永不返回 `PublishGateResult`，
 * 也不新增任何门禁理由码。
 */

export type {
  ArticleTemplateSlot,
  ArticleTemplateSource,
  RenderArticleContext,
  RenderedArticleDraft,
  RenderedArticleSeoMetadata,
} from "@/lib/seo/template/article";

export type { TemplateErrorCode, TemplateErrorContext } from "@/lib/seo/template/errors";

export type {
  TemplateFieldDefinition,
  TemplateFieldKey,
  TemplateFieldKind,
} from "@/lib/seo/template/fields";

export type { RenderSlotOptions, TemplateAnalysis } from "@/lib/seo/template/render";

export type { NovelTemplateInput, NovelTemplateValues } from "@/lib/seo/template/values";
