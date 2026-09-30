/**
 * 文章创建时"渲染 + 取值"的唯一入口（TKD 对齐 CPS，Owner 2026-09-30，第五块）。
 *
 * `generateArticleFromNovel`（`generate.ts`）创建一篇小说文章时，把哪些 Novel 字段喂给模板、
 * 怎么算试读章数、跳转地址怎么拼，都写在这里；**模板 SEO 字段回写工具**
 * （`src/server/article-templates/tkd-repair.ts`）要给存量文章重算 `metaTitle`/`metaDescription`，
 * 必须走同一个函数、同一套取值——照 CPS `article-generation.ts` 头注释的纪律："Repair tooling must
 * call this helper instead of reimplementing template fallback rules"。CPS 把这套装配复制了
 * 四份、四份的兜底链各不相同，同一部剧在单条路径和批量路径产出不同的 meta；这里只有这一处，
 * 而且没有任何兜底：模板没写的槽位，产物里就没有那个键（见 `src/lib/seo/template/article.ts` 头注释）。
 *
 * 注意与"重新生成"（`src/server/articles/service.ts` 的 `regenerateCore`）的区别：那条路径按同样的
 * 取值渲染后**连正文、页面标题一起覆盖**并把文章打回 template 模式，回写工具只写 SEO 标题与描述
 * 两个键，二者不是一回事。`regenerateCore` 里目前还有一份自己的取值装配（跳转地址用同一个
 * `promoRedirectUrlFor` 等价拼法），本轮不动它（不在范围内，且它有自己的并发/审计语义）。
 */
import {
  buildNovelTemplateValues,
  renderArticleDraft,
  type ArticleTemplateSource,
  type RenderedArticleDraft,
} from "@/lib/seo/template";

import { promoRedirectUrlFor } from "./promo";

/**
 * 试读章节数：`status = preview` 且未删除、正文已物化的章节数（口径对应
 * `NovelPreviewPolicy.materializedChapterCount`）。与 `generate.ts` 创建文章时用的是同一条查询。
 * `novelChapter` 缺失（个别测试替身）时按 0 处理，与创建路径一致。
 */
export async function countPreviewChapters(
  db: { novelChapter?: { count: (args: unknown) => Promise<number> } },
  novelId: string,
): Promise<number> {
  if (!db.novelChapter) return 0;
  return db.novelChapter.count({
    where: { novelId, status: "preview", deletedAt: null, content: { isNot: null } },
  });
}

export type NovelArticleRenderInput = {
  readonly source: ArticleTemplateSource;
  readonly templateKey: string;
  readonly novel: {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly coverUrl: string | null;
    readonly totalChapterCount: number;
  };
  readonly previewChapterCount: number;
  /** 文章绑定的推广链接的公开跳转码；没有绑定时不传（`promo_redirect_url` 为空，模板里必须用 `{if}` 包裹）。 */
  readonly promoPublicRedirectCode?: string | null;
};

export function renderNovelArticleDraft(input: NovelArticleRenderInput): RenderedArticleDraft {
  return renderArticleDraft(
    input.source,
    buildNovelTemplateValues({
      title: input.novel.title,
      description: input.novel.description,
      coverUrl: input.novel.coverUrl,
      totalChapterCount: input.novel.totalChapterCount,
      previewChapterCount: input.previewChapterCount,
      promoRedirectUrl: input.promoPublicRedirectCode ? promoRedirectUrlFor(input.promoPublicRedirectCode) : undefined,
    }),
    { templateKey: input.templateKey, novelId: input.novel.id },
  );
}
