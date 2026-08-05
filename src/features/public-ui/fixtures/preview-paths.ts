/**
 * DEV_PREVIEW 路由的唯一 URL 构造入口。
 *
 * 🔴 这里构造的**不是**正式生产 URL。正式前台 URL 结构（尤其是语种段）仍是未决项
 * D-8，本轮不借阅读器任务顺带冻结它。这些地址只服务于 `src/app/dev-preview/**`
 * 下那组临时预览路由：整体 noindex/nofollow、不设 self-canonical、不进 sitemap、
 * 不进 IndexNow、不写入 `docs/p1/P1_SHARED_CONTRACTS.md` §3 的正式 URL 契约。
 *
 * 正式 URL 构造函数（`buildNovelPath` / `buildChapterPath` 等）将来住在
 * `src/lib/seo/`，与本文件无继承关系——D-8 定案后只替换路由层，阅读器组件不动。
 *
 * 为什么集中在这里：组件一律 route-agnostic，只接收调用方注入的 `href` 字符串
 * （见 `src/features/public-ui/README.md`）。地址一旦散落到组件或各页面里硬编码，
 * D-8 定案时就要满仓库找。本文件是 dev-preview 地址的唯一来源，
 * 页面与 fixtures 都从这里取。
 */

/** 章节预览路由的基段。动态段是章号。 */
export const DEV_PREVIEW_CHAPTER_BASE = "/dev-preview/chapter";

/** 详情预览路由。本轮没有动态段——详情页假数据只有一本。 */
export const DEV_PREVIEW_NOVEL_BASE = "/dev-preview/novel";

/** 章节预览地址。章号是路径的一部分，这样每章各自是独立路由。 */
export function devPreviewChapterPath(chapterNumber: number): string {
  return `${DEV_PREVIEW_CHAPTER_BASE}/${chapterNumber}`;
}

/** 详情预览地址。 */
export function devPreviewNovelPath(): string {
  return DEV_PREVIEW_NOVEL_BASE;
}

/**
 * 详情页里「立即试读」类入口指向的地址——恒为第 1 章。
 * 单独给个函数而不是让调用方各自写 `devPreviewChapterPath(1)`，
 * 是为了「从哪一章开始试读」这件事只有一处定义。
 */
export function devPreviewFirstChapterPath(): string {
  return devPreviewChapterPath(1);
}
