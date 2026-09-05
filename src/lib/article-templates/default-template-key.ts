/**
 * 内置默认模板的 `templateKey` 字面量。拆成独立叶子文件的唯一原因：后台模板表单
 * （`templates/_components/template-manager.tsx`，`"use client"`）需要在浏览器端
 * 判断"正在编辑的是不是这条内置种子模板"（用于提示"保存会把正文替换成按区块
 * 重新编译的版本"），但 `tests/ui/admin-secret-boundary.test.tsx` 的边界扫描禁止
 * 任何 `"use client"` 文件出现 `from "@/server/..."`。真正的
 * `DEFAULT_ARTICLE_TEMPLATE`（含渲染用的 `ArticleTemplateSource`）留在
 * `src/server/content-creation/default-article-template.ts`，只有这一个字符串
 * 常量搬到这里；该文件继续 re-export 同一个值，对现有调用方完全透明。
 */
export const DEFAULT_ARTICLE_TEMPLATE_KEY = "system-default-v1";
