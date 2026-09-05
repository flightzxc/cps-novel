/**
 * `ArticleTemplate` 写入契约的类型定义（P2-02B，CPS parity）。**纯类型，零运行时
 * 代码**——校验逻辑仍然只活在 `src/server/article-templates/service.ts` 的
 * `storage()`，这里只是把类型形状搬到一个 client 组件也能 import 的位置。
 *
 * 🔴 **为什么住在 `src/lib/` 而不是 `src/server/article-templates/service.ts`**：
 * 后台模板表单（`templates/_components/template-manager.tsx`，`"use client"`）要
 * 用 `ArticleTemplateWrite` 给提交给 server action 的对象做类型标注。
 * `tests/ui/admin-secret-boundary.test.tsx` 的边界扫描是纯文本正则
 * （`from ["']@\/(?:server|...)\//`），**不区分 `import` 是不是 `import type`**——
 * 哪怕类型在编译后完全被擦除、对浏览器 bundle 零字节影响，只要源码里出现
 * `from "@/server/..."` 字样就判违规。这个文件搬到 `src/lib/` 下，
 * `service.ts` 继续从这里 re-export 同名类型，对现有调用方完全透明。
 *
 * 相对旧版本的两处刻意破坏性变更（详见 `service.ts` 的 `storage()`）：
 *
 * - **`version` 已移除**：不再由调用方指定，`createArticleTemplate` 在同一事务内按
 *   `templateKey` 的 `max(version) + 1` 自动分配（无该 key 记录则为 1）。
 * - **`bodyTemplate` 已移除，改由 `contentTemplate` 派生**：正文不再接受调用方直传的
 *   HTML，而是通过 `compile-blocks.ts` 从结构化区块编译得到。
 */
export type ArticleTemplateStatus = "draft" | "active" | "inactive";

export type ArticleTemplateWrite = {
  readonly templateKey: string;
  readonly templateName: string;
  readonly locale?: string | null;
  readonly schemaVersion?: number;
  readonly status: ArticleTemplateStatus;
  /** 缺省时 `storage()` 落 `"novel_article"`。 */
  readonly applicableArticleType?: string;
  readonly titleTemplate: string;
  /**
   * 结构化内容区块数组（`{ type, content }[]`，五种 `type`，见
   * `src/lib/article-templates/content-blocks.ts`）。`unknown` 是有意的：合法性由
   * `storage()` 里的 `isArticleContentBlockList` 在运行期校验，不在类型层面假装
   * 已经验证过。
   */
  readonly contentTemplate: unknown;
  /** 候选 slug 模板文本，缺省或空串表示不提供这个可选槽位。 */
  readonly slugTemplate?: string;
  /** meta keywords 模板文本，缺省或空串表示不提供这个可选槽位。 */
  readonly metaKeywordsTemplate?: string;
  readonly metaTitleTemplate?: string;
  readonly metaDescriptionTemplate?: string;
};
