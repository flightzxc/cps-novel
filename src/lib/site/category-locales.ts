import type { Prisma, PrismaClient } from "@prisma/client";

import type { SiteLocale } from "@/lib/locale/locale-canonical";

import { getPublicCategoryPage } from "./category-queries";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * 分类页 hreflang 用：这个分类在哪些语种"确实有公开内容"——也就是
 * `/{locale}/category/{slug}` 真的会返回 200 的语种。
 *
 * 海阅的分类在某语种下没有已发布文章时是 404（`getPublicCategoryPage` 在
 * `cards.length === 0` 时返回 null，页面 `notFound()`），所以分类页此前对 15 个
 * 已登记语种盲枚举 hreflang，会把 404 地址（例如 en 下的 `/category/romance`）
 * 当成"该页面的其它语言版本"告诉搜索引擎。
 *
 * 判定**直接调用页面自己用的 `getPublicCategoryPage(…, 1)`**——"页面返回 200"
 * 的唯一定义——而不是另写第二份"分类下有没有书"的查询：可见性谓词、
 * `PUBLIC_LIST_CAP` 截断、标签成员规则（手工快照 / 映射 / 自动标签闸）都跟着
 * 页面走，不会漂移。代价是每个候选语种一次 `getPublicCategoryPage`，所以候选集
 * 由调用方传入已缩窄的集合（动态层 `getActiveLocales()` 去掉当前语种）；顺序
 * 串行执行，避免一次渲染同时占满连接池。
 *
 * 参照：CPS 的做法是分类页 hreflang 走静态语种表，因为 CPS 的分类页在任何语种
 * 都返回 200（空分类渲染空列表）；海阅"空分类即 404"是有意的（不发布薄页），
 * 所以这里必须过滤。海阅小说详情页的 hreflang 过滤同款思路见
 * `@/lib/seo/novel-hreflang`。
 */
export async function listCategoryPublicLocales(
  db: Db,
  slug: string,
  candidates: readonly SiteLocale[],
): Promise<SiteLocale[]> {
  const found: SiteLocale[] = [];
  for (const candidate of candidates) {
    if (await getPublicCategoryPage(db, candidate, slug, 1)) found.push(candidate);
  }
  return found;
}
