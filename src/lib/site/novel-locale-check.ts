import type { Prisma, PrismaClient } from "@prisma/client";

import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { loadNovelHreflangSiblings } from "@/lib/seo/novel-hreflang";
import { buildArticlePath, parseArticleSlugParam } from "@/lib/slug/article-path";
import { buildPublicArticleWhere } from "@/server/publication/visibility";

/**
 * 语言切换器的"这本书在目标语种有没有对应页面"查询。
 *
 * 移植自短剧站 v8.5.1 `src/app/api/drama-locale-check/route.ts:19-69` 与
 * `helpers.ts:5-31`（`3a76877`）：先用 URL 里的公开短码找到当前这篇已发布文章，
 * 再找同一部作品在目标语种的兄弟文章，命中才返回可直接跳转的路径。
 *
 * 与 CPS 的三处差别（都是海阅的数据形状决定的，不是另起炉灶）：
 * 1. 不需要 CPS 那条"没有短码时按 (slug, source 语种) 找源文章"的旁路——海阅每篇
 *    文章的路径恒带 `-p{shortId}` 后缀（`parseArticleSlugParam` 解析不出短码就
 *    直接判"没有对应"），所以接口也就不收 `source` 参数。
 * 2. CPS 用 `dramaId` 关联兄弟；海阅用 `novelId`，并且**直接复用**
 *    `loadNovelHreflangSiblings`（hreflang 已经在用的"这本书在哪些语种有公开
 *    页面"的唯一判定），不再另写第二份可见性 where。
 * 3. 返回的路径用 `buildArticlePath`（带目标语种前缀）——`/novel/` 路径的唯一
 *    构造入口，见 `src/lib/slug/README.md`。
 *
 * 只读、不写库、不需要任何新的数据库授权：读的是 Article/Novel/PromoLink，与
 * 详情页 hreflang 兄弟查询完全同一批表。
 */
export type NovelLocaleCheckResult =
  | { readonly hasMatch: false }
  | { readonly hasMatch: true; readonly path: string };

export async function checkNovelLocaleMatch(
  db: PrismaClient | Prisma.TransactionClient,
  input: { readonly slugParam: string; readonly target: SiteLocale },
): Promise<NovelLocaleCheckResult> {
  const parsed = parseArticleSlugParam(input.slugParam);
  if (!parsed) return { hasMatch: false };

  // 源文章必须本身是公开可见的（CPS 同款：源不是已发布公开页就不泄露"兄弟
  // 存在与否"）。`buildPublicArticleWhere` 是 hreflang/sitemap 共用的"可被收录"
  // 粗过滤，逐行的权威判定在下面 `loadNovelHreflangSiblings` 里。
  const source = await db.article.findFirst({
    where: buildPublicArticleWhere({ publicPageShortId: parsed.shortId }),
    select: { novelId: true },
  });
  if (!source?.novelId) return { hasMatch: false };

  const siblings = await loadNovelHreflangSiblings(db, source.novelId);
  const sibling = siblings.find((candidate) => candidate.locale === input.target);
  if (!sibling) return { hasMatch: false };

  return {
    hasMatch: true,
    path: buildArticlePath({
      locale: sibling.locale,
      slug: sibling.slug,
      shortId: sibling.publicPageShortId,
    }),
  };
}
