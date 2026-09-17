/**
 * 内容区块的形态定义与校验（P2-02B，CPS parity）。
 *
 * 与 CPS `src/lib/validators/template.ts` 的 `contentBlockSchema` 同形：
 * `{ type, content }`，`type` 五选一。这部分只是**形态**——不做字符串编译（那是
 * `src/server/article-templates/compile-blocks.ts` 的 `compileContentBlocks`），
 * 因此没有任何 HTML 转义/条件外提逻辑，零依赖。
 *
 * 🔴 **为什么单独拆出这个文件，而不是留在 `compile-blocks.ts` 里**：后台模板表单
 * （`templates/_components/*.tsx`，`"use client"`）需要在浏览器端用这份类型/校验
 * 函数渲染区块编辑器、还原既有模板的 `contentTemplate`。但
 * `tests/ui/admin-secret-boundary.test.tsx` 的"keeps Client Components away from
 * Prisma and server services"用纯文本正则扫描 client 组件，任何
 * `from "@/server/..."` 一律判违规——`compile-blocks.ts` 住在
 * `src/server/article-templates/` 下，client 组件不能直接 import 它。这个文件
 * 住在 `src/lib/` 下，是唯一同时满足"client 组件能读"和"边界扫描测试能过"的
 * 位置；`compile-blocks.ts` 继续从这里 re-export 同一套类型/函数，对现有调用方
 * （`service.ts` 等）完全透明。
 */

export const ARTICLE_CONTENT_BLOCK_TYPES = Object.freeze([
  "heading",
  "paragraph",
  "cta",
  "image",
  "divider",
] as const);

export type ArticleContentBlockType = (typeof ARTICLE_CONTENT_BLOCK_TYPES)[number];

const BLOCK_TYPE_SET: ReadonlySet<string> = new Set(ARTICLE_CONTENT_BLOCK_TYPES);

/** 一个内容区块。与 CPS `contentBlockSchema` 同形：`type` 五选一，`content` 任意字符串。 */
export type ArticleContentBlock = {
  readonly type: ArticleContentBlockType;
  readonly content: string;
};

/**
 * 该值是否是一个合法的内容区块。手写 `narrowX` 形态，与
 * `src/lib/seo/template/article.ts` 的 `narrowArticleTemplateSource` 同一纪律：
 * 形态不合一律 `false`，不做 best-effort 修正。
 */
export function isArticleContentBlock(value: unknown): value is ArticleContentBlock {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { type?: unknown; content?: unknown };
  return typeof record.type === "string" && BLOCK_TYPE_SET.has(record.type) && typeof record.content === "string";
}

/**
 * 区块数组是否合法：非空数组，且每一项都是合法区块。
 *
 * 对应 CPS `contentBlockSchema` 数组校验的 `.min(1, "至少添加一个内容区块")`——
 * 空数组编译不出任何正文，保存这种模板就是留雷。
 */
export function isArticleContentBlockList(value: unknown): value is readonly ArticleContentBlock[] {
  return Array.isArray(value) && value.length > 0 && value.every(isArticleContentBlock);
}
