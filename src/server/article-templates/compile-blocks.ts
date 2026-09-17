/**
 * 内容区块 → `bodyTemplate` HTML 编译器（P2-02B，CPS parity）。
 *
 * 后台不再直接接收一整段 `bodyTemplate` HTML 输入，而是接收结构化的区块数组
 * （`ArticleTemplate.contentTemplate`，与 CPS `src/lib/validators/template.ts` 的
 * `contentBlockSchema` 同形：`{ type, content }`，`type` 取五值之一），由这里编译成
 * 落库用的 `bodyTemplate` 文本，再交给 `@/lib/seo/template` 引擎的
 * `validateStoredArticleTemplate` 干跑一遍做最后的 fail-closed 校验。
 *
 * 🔴 **不照抄 CPS 的 `renderContentBlocks`**（`cps-admin/src/lib/template-engine.ts:232-258`，
 * 只读参考，未改动该仓库任何文件）。CPS 那个函数把区块渲染结果**未经转义**直接拼进
 * HTML（`<img src="${rendered}" alt="" />`），`rendered` 是变量替换后的自由文本——运营
 * 能在 image 区块的 `content` 里写 `x" onerror="alert(1)`，直接产出可执行的 HTML
 * 注入。CPS 的另一处问题是它把区块 `content`（未渲染前的模板文本）直接当 URL
 * 塞进 `src`/`href`，这里改成固定占位符（`{cover_url}` / `{promo_redirect_url}`），
 * 图片/CTA 的实际取值仍归引擎既有的窄上下文合同管，本模块不构造任何 URL。
 *
 * 本模块只做**字符串编译**，不做变量替换、不做条件消解——那是 `render.ts` 在真正
 * 渲染文章时的工作。编译产物里的 `{if x}` / `{endif}` / `{field}` 一律原样保留。
 */

import { escapeHtmlText } from "@/lib/seo/template";
import {
  ARTICLE_CONTENT_BLOCK_TYPES,
  isArticleContentBlock,
  isArticleContentBlockList,
  type ArticleContentBlock,
  type ArticleContentBlockType,
} from "@/lib/article-templates/content-blocks";

/**
 * 区块的形状定义与校验（`ARTICLE_CONTENT_BLOCK_TYPES` / `ArticleContentBlockType` /
 * `ArticleContentBlock` / `isArticleContentBlock` / `isArticleContentBlockList`）
 * 实际定义搬到了 `src/lib/article-templates/content-blocks.ts`（后台模板表单需要在
 * 浏览器端 import 它们渲染区块编辑器/还原既有 `contentTemplate`，留在本文件会被
 * `tests/ui/admin-secret-boundary.test.tsx` 的 client/server 边界扫描判违规——本文件
 * 住在 `src/server/` 下）。这里原样 re-export，`compileContentBlocks`（下方，真正的
 * 字符串编译逻辑，只在写路径用得到、不需要 client 可达）继续留在这个文件。
 */
export { ARTICLE_CONTENT_BLOCK_TYPES, isArticleContentBlock, isArticleContentBlockList };
export type { ArticleContentBlock, ArticleContentBlockType };

/**
 * 占位符 token：与 `render.ts` 的 `TOKEN_PATTERN` 同一词法（`{if x}` / `{endif}` /
 * `{field}`）。这里故意重新声明一份，而不是从引擎里把它导出——`compile-blocks.ts`
 * 活在 `src/lib/seo/template/` 的源码纯净扫描（`tests/ui/template-engine.test.ts`）
 * 边界**之外**，为了这一个几十字节的正则去扩大引擎的公开面并不划算；两处词法必须
 * 保持一致，任何一处的语法演进都要同步检查另一处。
 */
const PLACEHOLDER_TOKEN = /\{if\s+\w+\}|\{endif\}|\{\w+\}/g;

/**
 * 转义字面文本，但保留 `{if x}` / `{endif}` / `{field}` 占位符原样——它们是留给
 * 渲染期（`render.ts`）处理的语法，转义会把 `{novel_title}` 变成
 * `&#123;novel_title&#125;`，让渲染期再也认不出这是一个变量。
 *
 * 做法：按 token 位置切片，token 之间的字面片段各自转义，token 本身原样拼回。
 */
function escapeLiteralPreservingPlaceholders(text: string): string {
  let result = "";
  let cursor = 0;
  PLACEHOLDER_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER_TOKEN.exec(text)) !== null) {
    result += escapeHtmlText(text.slice(cursor, match.index));
    result += match[0];
    cursor = match.index + match[0].length;
  }
  result += escapeHtmlText(text.slice(cursor));
  return result;
}

/**
 * 编译单个区块。
 *
 * - `heading` / `paragraph`：区块内容是文本节点，转义字面文本、保留占位符；
 *   若内容整体就是一个条件块，条件会被提到标签外（见 `wrapWithHoistedConditional`）。
 * - `cta`：固定套壳成 `<a href="{promo_redirect_url}">…</a>`——`href` 永远是占位符
 *   本身（已在 `fields.ts` 登记 `a[href]` 绑定），锚文本走文本节点规则。
 * - `image`：固定输出 `{if cover_url}<img src="{cover_url}" alt="" />{endif}`
 *   （`fields.ts` 已登记 `img[src]` 绑定）；`content` 字段不参与编译——图片区块没有
 *   "文案"可言，写什么都不会出现在产物里，这是有意的（避免把任意文本塞进 `src`）。
 *
 *   🔴 **条件包裹是承重的，不是保守写法。** `cover_url` 在 `fields.ts:109` 是
 *   `required: false`（`Novel.coverUrl` 可空），裸引用会让 `analyzeTemplate` 报
 *   `unguardedOptionalFields`。更要命的是它**测不出来**：`validateStoredArticleTemplate`
 *   的干跑用的是恒有封面的样例值，所以带图片区块的模板能正常保存，却会在真正生成
 *   文章时对**每一本没有封面的小说**抛 `ERR_TEMPLATE_VAR_EMPTY`。包上 `{if}` 后，
 *   无封面的小说渲染出的是"没有这张图"，而不是一篇生成失败的文章。
 * - `divider`：固定输出 `<hr />`；`content` 同样不参与编译。
 */
/**
 * 整块条件外提。
 *
 * 区块模型（照搬 CPS 的 `{ type, content }`）没有"整块条件"这个概念，条件只能写在
 * `content` 里。于是 `{if total_chapter_count}Total: {total_chapter_count}{endif}`
 * 这种内容会编译成 `<p>{if …}…{endif}</p>`——标签在条件**外面**，条件不成立时渲染
 * 产物是一个空的 `<p></p>`，每一本缺该字段的小说都会带上几个空标签。
 *
 * 仓库既有的 `DEFAULT_ARTICLE_TEMPLATE.body`（`default-article-template.ts`）用的正是
 * 相反的写法——`{if total_chapter_count}<p>Total chapters: …</p>{endif}`，条件包着标签。
 * 这里把那个约定实现出来：当 `content` **整体**就是一个条件块时，把条件提到标签外。
 *
 * 🔴 只处理"整体就是一个条件块"这一种形态：必须以 `{if x}` 开头、以 `{endif}` 结尾，
 * 且全文只有一个 `{if` 和一个 `{endif}`。像 `{if a}A{endif}{if b}B{endif}` 或
 * `前缀{if a}A{endif}` 这样的内容一律**不外提**——外提会改变语义（把本该无条件输出的
 * 字面文本也吞进条件里）。
 */
const WHOLE_CONTENT_CONDITIONAL = /^\{if\s+(\w+)\}([\s\S]*)\{endif\}$/;

function wrapWithHoistedConditional(content: string, wrap: (inner: string) => string): string {
  const match = WHOLE_CONTENT_CONDITIONAL.exec(content.trim());
  const singleConditional =
    match !== null
    && (content.match(/\{if\s+\w+\}/g) ?? []).length === 1
    && (content.match(/\{endif\}/g) ?? []).length === 1;
  if (!singleConditional) return wrap(escapeLiteralPreservingPlaceholders(content));
  return `{if ${match[1]}}${wrap(escapeLiteralPreservingPlaceholders(match[2]))}{endif}`;
}

function compileBlock(block: ArticleContentBlock): string {
  switch (block.type) {
    case "heading":
      return wrapWithHoistedConditional(block.content, (inner) => `<h2>${inner}</h2>`);
    case "paragraph":
      return wrapWithHoistedConditional(block.content, (inner) => `<p>${inner}</p>`);
    case "cta":
      return wrapWithHoistedConditional(
        block.content,
        (inner) => `<a href="{promo_redirect_url}">${inner}</a>`,
      );
    case "image":
      return `{if cover_url}<img src="{cover_url}" alt="" />{endif}`;
    case "divider":
      return "<hr />";
  }
}

/**
 * 把区块数组编译成落库用的 `bodyTemplate` 字符串。
 *
 * 纯函数：不校验区块合法性（调用方必须先过 `isArticleContentBlockList`）、
 * 不做变量替换、不读数据库、不取当前时间。相同输入恒等输出。
 *
 * 产物仍需经过 `validateStoredArticleTemplate`（`article-templates/service.ts`）的
 * 干跑渲染——这是最后一道 fail-closed 闸，防的是"编译器本身写错了"这一类问题。
 */
export function compileContentBlocks(blocks: readonly ArticleContentBlock[]): string {
  return blocks.map(compileBlock).join("\n");
}
