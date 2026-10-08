import type { Prisma, PrismaClient } from "@prisma/client";

import type { SiteLocale } from "@/lib/locale/locale-canonical";

import { getPublicCategoryCounts, localesWithCategory } from "./public-list";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * 分类页 hreflang 用：这个分类在哪些语种"确实有公开内容"——也就是
 * `/{locale}/category/{slug}` 真的会返回 200 的语种。
 *
 * 海阅的分类在某语种下没有已发布文章时是 404（`getPublicCategoryPage` 在总数为 0 时返回 null，
 * 页面 `notFound()`），所以分类页此前对 15 个已登记语种盲枚举 hreflang，会把 404 地址（例如 en 下的
 * `/category/romance`）当成"该页面的其它语言版本"告诉搜索引擎。
 *
 * B-38（v0.5.13）：判定直接读**每语种每分类本数矩阵**（`public-list.ts`，60 秒进程内缓存），该分类本数 > 0 的
 * 语种 ∩ 调用方给的候选语种——矩阵与页面用同一段列表可见性 / 分类归属 SQL，所以与"页面返回 200"恒等
 * （真实库用例 `tests/integration/site/consistency-invariants-postgres.test.ts` 钉死）。此前这里对每个候选语种
 * 调一次页面查询（第 1 页要额外查十几个语种），现在一次矩阵读取、零额外语种探测。结果最多晚 60 秒（方案决定 2）。
 *
 * 返回顺序 = 候选语种的顺序。参照：CPS 的做法是分类页 hreflang 走静态语种表，因为 CPS 的分类页在任何语种
 * 都返回 200（空分类渲染空列表）；海阅"空分类即 404"是有意的（不发布薄页），所以这里必须过滤。海阅小说详情页的
 * hreflang 过滤同款思路见 `@/lib/seo/novel-hreflang`。
 */
export async function listCategoryPublicLocales(
  db: Db,
  slug: string,
  candidates: readonly SiteLocale[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<SiteLocale[]> {
  const normalizedSlug = slug.trim().toLowerCase();
  if (!normalizedSlug || normalizedSlug.length > 160 || candidates.length === 0) return [];
  const withBooks = localesWithCategory(await getPublicCategoryCounts(db, env), normalizedSlug);
  return candidates.filter((candidate) => withBooks.has(candidate));
}
