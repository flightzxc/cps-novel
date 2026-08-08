/**
 * 模板变量白名单登记表（P2-02）。
 *
 * 形态照搬 CPS `src/lib/template-engine.ts:13-35` 的 `WILDCARD_FIELDS`——一个
 * `as const` 数组，每项带 `key` / `label` / `description`，同一份数组既是渲染期的
 * 判定依据，也是后台变量面板的取值来源，白名单与 UI 面板因此不可能漂移。
 * CPS 那 18 个键全是短剧字段，本表整表重写为小说字段，并加了两列：
 *
 * - `kind`——`url` 类字段在渲染期额外校验 scheme（CPS 没有这层，它把 `coverUrl`
 *   直接拼进 `<img src="…">`）；
 * - `required`——对应数据库列是否非空。可空字段被裸引用时 `analyzeTemplate` 会报
 *   `unguardedOptionalFields`，把「某些小说渲染期才炸」提前成保存期就能看见的问题。
 *
 * 搬运登记见 `docs/governance/port-registry.md`。
 *
 * ## 🔴 不登记清单（不是漏写，是纪律）
 *
 * `author` / `country` / `completion_status` 由 `src/lib/seo/README.md` 点名不登记：
 * 上游分销接口不返回这三项，登记了就会有人去引用。`rating` / `views` /
 * `release_date` / `same_author` / `full_catalog` / `full_book_progress` /
 * `split_ratio` / `upstream_code` 由 `src/features/public-ui/types.ts` 顶部的字段
 * 禁令与 `docs/p1/P1_10_VISUAL_DIRECTION.md` §9 点名禁止出现在前台。章节正文
 * （`NovelChapterContent.body`）是渠道版权试读正文，与 `Article.body` 是两件事。
 *
 * 另外两项是本轮实读 schema 后**主动删掉**的候选，理由见 `docs/p2/P2_02_TEMPLATE_ENGINE.md`：
 *
 * - `site_tags`——`prisma/schema.prisma` 里根本没有站点标签表（全库搜 `tag` 零命中）。
 *   唯一存在的标签数据是 `SourceLabel` / `NovelSourceItemLabel`，即**原始上游来源
 *   标签**，而「原始来源标签不得直接进前台」是硬纪律。登记它只有两种下场：造一个
 *   谁也填不了的变量，或者把 `externalLabelValue` 引进 SEO 正文。
 * - `novel_locale`——`ArticleTemplate.locale` 已经按语种切分模板，模板文本自己就是
 *   那个语种；把裸 locale 码插进正文既不是可用文案，也会成为语种串在内容里的第二处
 *   物化点，蹭到 `CLAUDE.md` §3.2.1 的语种唯一真源纪律。
 *
 * 不登记的后果是**模板作者根本写不出 `{author}`**——渲染期直接拒绝，而不是渲染成
 * 空字符串一路流到线上变成「作者：」这种残缺文案。
 */

/**
 * 字段取值的校验口径。**逐字段独立**，不共用一条 URL 规则：
 *
 * - `text`——不做形态校验，只要求非空；
 * - `absolute_url`——必须是干净的 `http(s)://…` 绝对地址（站外资源，如 CDN 封面图）；
 * - `redirect_path`——必须是站内公开跳转入口 `/go/<public_redirect_code>` 的形态。
 */
export type TemplateFieldKind = "text" | "absolute_url" | "redirect_path";

export type TemplateFieldDefinition = {
  readonly key: string;
  readonly kind: TemplateFieldKind;
  /**
   * 对应数据来源是否恒有值。`false` 表示该字段可能缺失，模板里必须用
   * `{if key}…{endif}` 包裹后再引用，否则缺该值的小说会在渲染期失败。
   */
  readonly required: boolean;
  /**
   * 该字段被批准出现在正文 HTML 的哪一个**带引号属性值**里（小写、精确匹配）。
   *
   * 未登记（`undefined`）= 该字段只能出现在 HTML 文本节点。登记了也只放行这一个属性，
   * 且变量必须**独占整个属性值**——见 `html.ts` 的窄上下文合同。
   *
   * 🔴 **不预建**：`alt` / `title` 一类的文本属性要等有真实模板证据再逐个补入。
   */
  readonly htmlAttribute?: string;
  /** 后台变量面板展示名。 */
  readonly label: string;
  /** 后台变量面板说明文案。 */
  readonly description: string;
};

/**
 * 已登记的模板变量。**新增一项等于扩大公开面，必须先有依据**：该字段要么已在
 * `src/features/public-ui/types.ts` 的用户端视图模型里，要么在
 * `docs/p1/P1_10_VISUAL_DIRECTION.md` §9 的「只允许出现的字段」清单里，
 * 且必须能指到一列真实存在的数据来源。
 *
 * 🔴 只有 `novel_description` 是实质散文。**一篇 SEO 文章的正文实质来自运营手写在
 * `ArticleTemplate.bodyTemplate` 里的静态文案，引擎是插值器，不是内容生成器。**
 */
export const REGISTERED_TEMPLATE_FIELDS = [
  {
    key: "novel_title",
    kind: "text",
    required: true,
    label: "书名",
    description: "小说标题（Novel.title，非空列）",
  },
  {
    key: "novel_description",
    kind: "text",
    required: true,
    label: "简介",
    description: "小说简介（Novel.description，非空列）",
  },
  {
    key: "cover_url",
    kind: "absolute_url",
    required: false,
    htmlAttribute: "src",
    label: "封面图",
    description: "封面图地址（Novel.coverUrl 可空）——引用前请用条件块包裹",
  },
  {
    key: "total_chapter_count",
    kind: "text",
    required: false,
    label: "总章数",
    description: "客观标量（默认 0 表示未知）；绝不据此生成任何章节行",
  },
  {
    key: "preview_chapter_count",
    kind: "text",
    required: false,
    label: "可试读章数",
    description: "实际已物化的试读章节数量，由调用方传入，不是总章数",
  },
  {
    key: "promo_redirect_url",
    kind: "redirect_path",
    required: true,
    htmlAttribute: "href",
    label: "正式阅读地址",
    description: "站内公开跳转入口 /go/<公开跳转码>，由调用方解析好传入；引擎自己不构造任何 URL",
  },
] as const satisfies readonly TemplateFieldDefinition[];

/** 已登记字段的键联合类型。模板里能写出来的变量名就这些。 */
export type TemplateFieldKey = (typeof REGISTERED_TEMPLATE_FIELDS)[number]["key"];

/** 已登记字段键的有序列表，顺序与登记表一致。 */
export const TEMPLATE_FIELD_KEYS: readonly TemplateFieldKey[] = Object.freeze(
  REGISTERED_TEMPLATE_FIELDS.map((field) => field.key),
);

/**
 * 键 → 定义的索引。
 *
 * 🔴 用 `Map` 而不是普通对象查表是承重的：模板变量名匹配 `\w+`，因此 `constructor`
 * `__proto__` `toString` 都能写进模板。在普通对象上做 `index[name]` 会取到原型链上的
 * 函数并把 `[object Function]` 渲染进正文；`Map` 没有原型链这条路。
 */
const FIELD_INDEX: ReadonlyMap<string, TemplateFieldDefinition> = new Map(
  REGISTERED_TEMPLATE_FIELDS.map((field) => [field.key, field] as const),
);

/** 该名字是否是已登记字段。未登记一律 `false`——不做大小写折叠、不做近似匹配。 */
export function isRegisteredTemplateField(key: unknown): key is TemplateFieldKey {
  return typeof key === "string" && FIELD_INDEX.has(key);
}

/** 取字段定义；未登记返回 `null`，由调用方 fail-closed 处理。 */
export function getTemplateField(key: unknown): TemplateFieldDefinition | null {
  return typeof key === "string" ? (FIELD_INDEX.get(key) ?? null) : null;
}
