/**
 * 适用文章类型枚举（P2-02B，CPS parity）。
 *
 * CPS parity（`cps-admin/src/lib/article-v2-contract.ts:183-201` 的
 * `APPLICABLE_ARTICLE_TYPE_OPTIONS`，只读参考）。CPS 的 `drama_article` 在这里改名
 * `novel_article`，其余四值逐字照搬：`any` 表示模板对全部文章类型可选中
 * （`selectActiveArticleTemplate`/`listActiveArticleTemplateOptions` 的过滤语义）。
 *
 * 🔴 **为什么住在 `src/lib/article-templates/` 而不是 `src/server/article-templates/`**：
 * 后台模板表单（`templates/_components/template-manager.tsx`，`"use client"`）需要在
 * 浏览器端渲染这份枚举的下拉选项。本仓库的 client/server 边界不是"看这份数据本身
 * 是否安全"，而是一条更粗、更好审计的规则——`tests/ui/admin-secret-boundary.test.tsx`
 * 的"keeps Client Components away from Prisma and server services"用纯文本正则
 * （`from ["']@\/(?:server|lib\/credentials)\//`）扫描**任何** `"use client"` 文件，
 * 命中 `@/server/...` 一律判违规，不区分是不是 type-only、也不看目标文件实际
 * import 了什么。放在 `src/lib/` 下能力所及的最小公分母目录，是唯一同时满足
 * "client 组件能读"和"这条边界扫描测试能过"的位置。
 * `src/server/article-templates/service.ts` 继续从这里 re-export 同一份常量，
 * 对现有调用方（`import { APPLICABLE_ARTICLE_TYPES } from "@/server/article-templates"`
 * 等）完全透明。
 */
export const APPLICABLE_ARTICLE_TYPES = [
  "novel_article",
  "blog_article",
  "listicle",
  "guide",
  "any",
] as const;

export type ApplicableArticleType = (typeof APPLICABLE_ARTICLE_TYPES)[number];
