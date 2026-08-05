/**
 * 用户端视图模型。
 *
 * 🔴 这些类型是字段边界的第一道防线：**页面上能出现什么，取决于这里有什么字段。**
 * 下面刻意不存在的字段，是分销接口不提供的东西——它们在上游官网上存在，与我们无关。
 *
 * 禁止新增（且禁止以「将来可能有」为由预留）：
 *   author / rating / views / completionStatus / country / chapterReleaseDate /
 *   sameAuthorBooks / fullBookProgress / fullChapterCatalog /
 *   splitRatio / upstreamCode / 应用下载模块 / 用户体系 / 评论 / 收藏
 *
 * 这条禁令针对的是**上游字段**——分销接口不返回、只在上游官网上存在的东西。
 * 它不禁止我方自己产出的运营资产（例如 heroImageUrl 的横版主视觉），
 * 那类字段的来源是我方对象存储，不是渠道接口，判断标准见各字段注释。
 *
 * 口径见 docs/p1/P1_10_VISUAL_DIRECTION.md 第九节。
 */

/** 站点标签。只有明确允许公开的站点标签才能进前台，原始来源标签不得直接展示。 */
export interface SiteTag {
  /** 标签在站内的稳定标识 */
  slug: string;
  /** 展示名 */
  label: string;
  /** 聚合页地址。URL 结构尚未冻结，因此由调用方注入，组件不自行拼装。 */
  href?: string;
}

/** 语种展示信息。展示名由调用方给出，组件不内嵌任何语种映射表。 */
export interface LocaleBadge {
  /** 站点 locale 码 */
  code: string;
  /** 展示名 */
  label: string;
}

/** 卡片视图：首页与聚合页共用同一种卡片，不做第二套形态。 */
export interface NovelCardView {
  id: string;
  title: string;
  /** 封面地址。缺失时组件渲染占位块，不隐藏卡片。 */
  coverUrl?: string;
  /** 允许公开的站点标签，可为空数组——为空时卡片不渲染标签区。 */
  tags: SiteTag[];
  /** 语种。设计需要时展示。 */
  locale?: LocaleBadge;
  /** 详情页地址，由路由层注入。 */
  href: string;
}

/** 详情页里的一条可试读章节。只来自上游实际返回的章节，绝不由总章数推导。 */
export interface PreviewChapterRef {
  /** 章号 */
  number: number;
  /** 章名 */
  title: string;
  /** 章节页地址，由路由层注入。 */
  href: string;
}

/** 详情页视图 */
export interface NovelDetailView {
  id: string;
  title: string;
  coverUrl?: string;
  /**
   * 16:9 横版主视觉，用于首页通栏 Hero。
   *
   * 🔴 **这不是上游字段**——分销接口不返回主视觉图。它是我方运营上传的物料，
   * 存在对象存储里（架构文档 §2.1 / §2.2 已把「运营上传物」列为其既有职责）。
   * 不要去渠道接口里找这个字段。
   *
   * 缺失时首页回落到封面编排版（FeaturedNovel），不做拉伸、不做模糊铺底。
   */
  heroImageUrl?: string;
  description: string;
  locale: LocaleBadge;
  /** 总章数。客观标量，可展示；🔴 绝不据此生成任何章节行。 */
  totalChapterCount: number;
  /** 允许公开的站点标签，可为空——为空时整个标签区块消失。 */
  tags: SiteTag[];
  /** 实际可试读章节。长度可能远小于总章数，这是事实，不做补偿。 */
  previewChapters: PreviewChapterRef[];
  /** 经我方公开跳转码构造的正式阅读地址。缺失时该按钮不渲染。 */
  readOnUpstreamHref?: string;
}

/** 当前试读范围，形如「试读 1 / 3」。分母是实际可试读章数，不是总章数。 */
export interface PreviewPosition {
  index: number;
  total: number;
}

/** 章节页所属小说的最小信息，用于轻量归属条 */
export interface ChapterNovelRef {
  /**
   * 稳定的不透明标识，用于把阅读位置按 `novel + chapter` 粒度分键存储。
   *
   * 🔴 **永远不渲染**：它不是给用户看的内容，只是本地存储的键的一部分。
   * 与 `NovelCardView.id` / `NovelDetailView.id` 是同一个东西、同一套语义
   * （将来对应 `Novel.businessId`），所以沿用 `id` 这个名字而不另起一个——
   * 同一个概念在同一个文件里不该有两种叫法。
   *
   * 不承载任何上游元信息，因此不触碰本文件顶部的字段禁令：它是**当下就需要**
   * 的功能字段，不是「将来可能有」的预留位。
   *
   * 不能用书名代替：书名会改，改了之后读者的阅读位置就全丢了。
   */
  id: string;
  title: string;
  href: string;
  coverUrl?: string;
}

/** 章节页视图 */
export interface ChapterView {
  number: number;
  title: string;
  /** 正文按段落切好后传入。组件不做任何解析或富文本渲染。 */
  paragraphs: string[];
  novel: ChapterNovelRef;
  previewPosition: PreviewPosition;
  previousHref?: string;
  nextHref?: string;
  /** 章末的正式阅读入口，同样来自公开跳转码。 */
  readOnUpstreamHref?: string;
}

/** 内容不可阅读时的两种状态 */
export type UnavailableReason = "unpublished" | "takedown";

/** 导航项。href 由路由层注入，组件不自行决定任何永久路由。 */
export interface NavItem {
  label: string;
  href: string;
  current?: boolean;
}
