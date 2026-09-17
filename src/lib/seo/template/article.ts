/**
 * 六槽位文章装配（P2-02，P2-02B 扩为六槽）。
 *
 * 对应 CPS `src/lib/article-generation.ts:204-272` 的 `buildArticleSnapshot`。CPS 把这套
 * 装配逻辑复制了四份（Server Action、Worker、预览、修复脚本），四份的 fallback 链各不
 * 相同，同一条剧在单条路径和批量路径会产出不同的 meta。**这里只有这一个实现**，且
 * 一条 fallback 都不做：模板没写的槽位，产物里就没有那个键。fallback 是发布链路的策略，
 * 属调用方 / P2-07，不属引擎。搬运登记见 `docs/governance/port-registry.md`。
 *
 * ## 模板的存储列与渲染槽
 *
 * P2-02B（CPS parity）给 `ArticleTemplate` 补了 `slugTemplate`（Text）与
 * `metaKeywordsTemplate`（Text）两个专列，本模块的"两列存储"口径随之作废——那条注释是
 * 本轮之前"prisma/ 是 Codex 独占、本轮不改 schema"的历史前提，前提已不成立。当前口径：
 *
 * | 渲染槽 | 存储位置 | 目标 |
 * | --- | --- | --- |
 * | `body` | `bodyTemplate` 列（由 `compile-blocks.ts` 从 `contentTemplate` 编译而来） | `Article.body` |
 * | `title` | `seoTemplate.title` | `Article.title` |
 * | `metaTitle` | `seoTemplate.metaTitle` | `Article.seoMetadata` |
 * | `metaDescription` | `seoTemplate.metaDescription` | `Article.seoMetadata` |
 * | `metaKeywords` | `metaKeywordsTemplate` 列 | `Article.seoMetadata` |
 * | `slug` | `slugTemplate` 列 | 候选 slug 字符串（不是最终 `Article.slug`，见下） |
 *
 * 即 `seo_template` 这一列的语义比「SEO」略宽——它承载 `bodyTemplate` 装不下的**部分**
 * 其余槽位（`metaKeywords`/`slug` 已经各有专列，不再塞进这个 JSON）。`title` / `body`
 * 两个槽位名逐字取自 `PUBLISH_REQUIRED_METADATA_FIELDS`，于是 P2-07 把渲染失败映射成
 * `required_metadata_missing.missingFields` 时不需要翻译表。
 *
 * ## `Article.body` 是 HTML 片段
 *
 * schema 只说 `body String @db.Text`，内容类型必须在这里定死，否则转义策略无从谈起：
 * `bodyTemplate` 是从运营在后台拼的区块（`contentTemplate`）编译出的 **HTML 片段**，
 * 插值进去的取值做 HTML 实体转义，消费方按可信 HTML 渲染。`title` / `metaTitle` /
 * `metaDescription` / `metaKeywords` / `slug` 是纯文本，不转义（它们进 Next metadata、
 * 文本节点或候选字符串，由渲染层/调用方自己处理编码）。
 *
 * ## `slug` 槽不是最终 slug
 *
 * 🔴 本模块依旧**不构造 URL、不生成 slug、不做发布判定**——这条纪律没有因为新增槽位
 * 而松动。`slugTemplate` 渲染出来的只是**候选** slug 字符串（`RenderedArticleDraft`
 * 里叫 `slugCandidate`，特意不叫 `slug`，防止被当成可以直接写库的终值）。归一
 * （大小写、非法字符）与去重后缀仍归 P2-03/P2-06 的 slug 服务；引擎这里只按 `text`
 * 上下文渲染出字符串，不做 URL 形态校验。
 */

import {
  ERR_TEMPLATE_OUTPUT_INVALID,
  TemplateRenderError,
  type TemplateErrorCode,
} from "./errors";
import { renderTemplateSlot } from "./render";
import type { NovelTemplateValues } from "./values";

/**
 * 本引擎能理解的模板结构版本，对应 `ArticleTemplate.schemaVersion`。
 *
 * 未来扩槽位/改变量语义时递增，并让 `narrowArticleTemplateSource` 认新版本。
 * 🔴 **未知版本一律 fail-closed 返回 `null`**，不做 best-effort 解析——拿旧引擎去渲染
 * 新结构的模板，产出的是没人能审的半成品。
 *
 * P2-02B：从 1 升到 2（`metaKeywords` / `slug` 两个槽位随 v2 生效）。**v1 不是非法**——
 * 现网已有的 `schemaVersion: 1` 行（如内置 `system-default-v1`）只是缺这两个可选槽位，
 * 不代表模板结构本身有问题。`narrowArticleTemplateSource` 因此显式接受 1 与 2 两个版本，
 * 见下方 `SUPPORTED_TEMPLATE_SCHEMA_VERSIONS`；只有落在这个集合之外的版本号才 fail-closed。
 */
export const TEMPLATE_SEO_SCHEMA_VERSION = 2;

/** `narrowArticleTemplateSource` 认识的全部 schemaVersion。集合之外一律 fail-closed。 */
const SUPPORTED_TEMPLATE_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([1, 2]);

/**
 * 六个渲染槽位。`title` / `body` 与 `PUBLISH_REQUIRED_METADATA_FIELDS` 同名。
 * `metaKeywords` / `slug` 是 P2-02B 新增的两个可选槽位，只在 schemaVersion 2 生效。
 */
export const ARTICLE_TEMPLATE_SLOTS = Object.freeze([
  "title",
  "body",
  "metaTitle",
  "metaDescription",
  "metaKeywords",
  "slug",
] as const);

export type ArticleTemplateSlot = (typeof ARTICLE_TEMPLATE_SLOTS)[number];

/**
 * 归一后的模板文本。`title` / `body` 必填，其余四个槽位可缺省——缺省即产物里没有
 * 对应的键，不是空串、不是 `null`。
 */
export type ArticleTemplateSource = {
  readonly title: string;
  readonly body: string;
  readonly metaTitle?: string;
  readonly metaDescription?: string;
  readonly metaKeywords?: string;
  readonly slug?: string;
};

/** 渲染出来的 SEO 元数据。 */
export type RenderedArticleSeoMetadata = {
  readonly metaTitle?: string;
  readonly metaDescription?: string;
  readonly metaKeywords?: string;
};

/**
 * 渲染产物。
 *
 * 🔴 这不是一行待写库的 `Article`：`slugCandidate` 不是最终 `Article.slug`（归一/去重
 * 仍归 P2-03/P2-06 的 slug 服务，故意不叫 `slug` 以免被当成终值直接落库）、没有
 * `status`、没有 `novelId`、不做唯一性检查、不落库。只是渲染槽位的纯渲染结果。
 */
export type RenderedArticleDraft = {
  readonly title: string;
  readonly body: string;
  readonly seoMetadata: RenderedArticleSeoMetadata;
  /** 写入 `Article.seoSchemaVersion`，让元数据快照自描述。 */
  readonly seoSchemaVersion: number;
  /** 候选 slug 字符串，来自 `slugTemplate`（仅 schemaVersion 2 且模板提供时存在）。 */
  readonly slugCandidate?: string;
};

export type RenderArticleContext = {
  readonly templateKey?: string;
  readonly novelId?: string;
};

/**
 * 目标列约束。只登记数据库真的会拒的那些，不发明 SEO 软策略。
 *
 * `Article.title` 是 `VarChar(500)`；`Article.body` 是 `Text`（无长度上限）；
 * 两个 meta 槽位落在 `seoMetadata` JsonB 里，同样没有列级上限。SEO 意义上的软上限
 * （metaTitle ~60 / metaDescription ~155）**本轮不实现**：截断是内容策略，
 * 静默截断更是 fail-open，留给 metadata 层显式决定。
 */
const SLOT_MAX_LENGTH: Partial<Record<ArticleTemplateSlot, number>> = Object.freeze({
  title: 500,
});

function optionalTemplateText(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  return value;
}

/**
 * 把 `ArticleTemplate` 的存储列归一成 `ArticleTemplateSource`。
 *
 * 本仓库没有 zod，沿用既有的手写 `narrowX(value: unknown): T | null` 形态
 * （见 `src/contracts/publish-gate.ts` 的 `narrowPublishIntent`）。任何形态不合的输入
 * 返回 `null`，由调用方按无效模板处理——**不抛异常、不猜、不 best-effort**。
 *
 * 拒绝的情形：schemaVersion 不在 `SUPPORTED_TEMPLATE_SCHEMA_VERSIONS` 里；`bodyTemplate`
 * 不是非空字符串；`seoTemplate` 不是普通对象；`title` 不是非空字符串；任一可选槽位
 * 存在但不是字符串。
 *
 * `slugTemplate` / `metaKeywordsTemplate` 只在 schemaVersion 2 才会被读取——v1 模板
 * 预期不提供这两个槽位，即便物理行里这两列（`String @default("")`）恒有值，v1 输入也
 * 完全不看它们，不会把默认空串误判成"提供了但为空"。
 *
 * 这两列的"是否提供"判定与 `seoTemplate` 里 `metaTitle`/`metaDescription` 的判定
 * 故意不同：后者是"JSON 对象里有没有这个 key"，前者因为物理列不可空、只能靠"非空白
 * 字符串"当作"已配置"的信号——列默认值 `''` 就是"模板作者没有配置这个槽位"，不是
 * "配置了一个空槽位"（空槽位在 `seoTemplate` 那条路径上是渲染期报错的，语义不同）。
 */
export function narrowArticleTemplateSource(input: unknown): ArticleTemplateSource | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as {
    schemaVersion?: unknown;
    bodyTemplate?: unknown;
    seoTemplate?: unknown;
    slugTemplate?: unknown;
    metaKeywordsTemplate?: unknown;
  };

  if (typeof record.schemaVersion !== "number" || !SUPPORTED_TEMPLATE_SCHEMA_VERSIONS.has(record.schemaVersion)) {
    return null;
  }
  const schemaVersion = record.schemaVersion;

  const bodyTemplate = record.bodyTemplate;
  if (typeof bodyTemplate !== "string" || bodyTemplate.trim() === "") return null;

  const seoTemplate = record.seoTemplate;
  if (typeof seoTemplate !== "object" || seoTemplate === null || Array.isArray(seoTemplate)) {
    return null;
  }
  const slots = seoTemplate as {
    title?: unknown;
    metaTitle?: unknown;
    metaDescription?: unknown;
  };

  const title = slots.title;
  if (typeof title !== "string" || title.trim() === "") return null;

  const metaTitle = optionalTemplateText(slots.metaTitle);
  if (metaTitle === null) return null;
  const metaDescription = optionalTemplateText(slots.metaDescription);
  if (metaDescription === null) return null;

  let metaKeywords: string | undefined;
  let slug: string | undefined;
  if (schemaVersion >= 2) {
    const metaKeywordsRaw = record.metaKeywordsTemplate;
    if (metaKeywordsRaw !== undefined) {
      if (typeof metaKeywordsRaw !== "string") return null;
      if (metaKeywordsRaw.trim() !== "") metaKeywords = metaKeywordsRaw;
    }
    const slugRaw = record.slugTemplate;
    if (slugRaw !== undefined) {
      if (typeof slugRaw !== "string") return null;
      if (slugRaw.trim() !== "") slug = slugRaw;
    }
  }

  return Object.freeze({
    title,
    body: bodyTemplate,
    ...(metaTitle === undefined ? {} : { metaTitle }),
    ...(metaDescription === undefined ? {} : { metaDescription }),
    ...(metaKeywords === undefined ? {} : { metaKeywords }),
    ...(slug === undefined ? {} : { slug }),
  });
}

function renderSlot(
  slot: ArticleTemplateSlot,
  template: string,
  values: NovelTemplateValues,
  context: RenderArticleContext,
): string {
  const rendered = renderTemplateSlot(template, values, {
    slot,
    // 只有正文是 HTML 片段：既要对插值做实体转义，也要过窄上下文合同。
    context: slot === "body" ? "html" : "text",
    ...(context.templateKey === undefined ? {} : { templateKey: context.templateKey }),
    ...(context.novelId === undefined ? {} : { novelId: context.novelId }),
  });

  const fail = (constraint: string, code: TemplateErrorCode = ERR_TEMPLATE_OUTPUT_INVALID) => {
    throw new TemplateRenderError(code, {
      slot,
      constraint,
      ...(context.templateKey === undefined ? {} : { templateKey: context.templateKey }),
      ...(context.novelId === undefined ? {} : { novelId: context.novelId }),
    });
  };

  // 与 `article` 表 published 行的 btrim(...) <> '' 同口径：纯空白就是空。
  if (rendered.trim() === "") fail("empty");

  const maxLength = SLOT_MAX_LENGTH[slot];
  if (maxLength !== undefined && rendered.length > maxLength) fail("too_long");

  return rendered;
}

/**
 * 渲染一篇文章的六个槽位。
 *
 * 纯函数：不读数据库、不发请求、不读环境变量、不取当前时间、不生成 slug、
 * 不做唯一性检查、不落库。相同 `source` + `values` 恒等输出。
 *
 * 任一槽位失败即整体抛错——不产出「标题好了正文没好」这种半成品。
 *
 * `slug` 槽按 `text` 上下文渲染（不是 `html`）——它和 `metaTitle`/`metaDescription`/
 * `metaKeywords` 一样是纯文本，走 `renderSlot` 内 `slot === "body" ? "html" : "text"`
 * 的既有判定，不需要为它单独分支。
 */
export function renderArticleDraft(
  source: ArticleTemplateSource,
  values: NovelTemplateValues,
  context: RenderArticleContext = {},
): RenderedArticleDraft {
  const title = renderSlot("title", source.title, values, context);
  const body = renderSlot("body", source.body, values, context);

  const metaTitle =
    source.metaTitle === undefined
      ? undefined
      : renderSlot("metaTitle", source.metaTitle, values, context);
  const metaDescription =
    source.metaDescription === undefined
      ? undefined
      : renderSlot("metaDescription", source.metaDescription, values, context);
  const metaKeywords =
    source.metaKeywords === undefined
      ? undefined
      : renderSlot("metaKeywords", source.metaKeywords, values, context);
  const slugCandidate =
    source.slug === undefined ? undefined : renderSlot("slug", source.slug, values, context);

  return Object.freeze({
    title,
    body,
    seoMetadata: Object.freeze({
      ...(metaTitle === undefined ? {} : { metaTitle }),
      ...(metaDescription === undefined ? {} : { metaDescription }),
      ...(metaKeywords === undefined ? {} : { metaKeywords }),
    }),
    seoSchemaVersion: TEMPLATE_SEO_SCHEMA_VERSION,
    ...(slugCandidate === undefined ? {} : { slugCandidate }),
  });
}
