import { prisma } from "@/app/api/admin/_lib/deps";
import type { ArticleStatus } from "@/domain/database-statuses";

/**
 * Read side for the publish/rights-transition controls on `/novels` and
 * `/novels/[novelId]` (PR-C3).
 *
 * `src/server/publish-gate`'s write path (`applyPublishTransition` /
 * `publishArticleAsAdmin` / `publishArticlesBatchAsAdmin`) is keyed by
 * `Article.id`, but P2-04's read kernel (`src/server/admin-content`,
 * `AdminNovelDetailView`/`AdminNovelListItemView`) never exposes an Article
 * at all — that kernel was a content-management read slice, built before any
 * write path existed to need one. Adding an Article read to
 * `src/server/admin-content` is Codex's territory (`src/server/**`), out of
 * this task's write scope; this follows the exact precedent
 * `../../catalog-sync/_lib/read-channel-apps.ts` already set for the same
 * situation (itself following `channel-accounts/page.tsx`'s `readRows`): a
 * page-local Prisma read straight off the shared client
 * (`@/app/api/admin/_lib/deps`), scoped to exactly the columns these
 * controls need. Nothing here writes.
 *
 * `docs/p2/P2_01_PUBLISH_GATE_CONTRACT.md` and `publish-gate/service.ts`'s
 * own header both note today's V1 invariant this read leans on: exactly one
 * Article per Novel (`SITE_LOCALES` has one member, and
 * `article_novel_locale_key` is a `(novelId, locale)` unique constraint) —
 * "publish the page" and "publish the work" are the same admin action. A
 * future multi-locale world would need this read (and the buttons built on
 * it) to become per-Article instead of per-Novel; nothing here assumes that
 * can never happen, it just is not what V1 has.
 */

export type PrimaryArticleRef = {
  readonly articleId: string;
  readonly locale: string;
  readonly slug: string;
  readonly status: ArticleStatus;
};

export async function readPrimaryArticleForNovel(novelId: string): Promise<PrimaryArticleRef | null> {
  const article = await prisma.article.findFirst({
    where: { novelId, deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, locale: true, slug: true, status: true },
  });
  if (!article) return null;
  return {
    articleId: article.id,
    locale: article.locale,
    slug: article.slug,
    status: article.status as ArticleStatus,
  };
}

/**
 * Batch form for the `/novels` list's selection toolbar. Returns a map keyed
 * by `novelId` rather than an array so a caller resolving a list of selected
 * Novel ids never has to re-derive the join itself.
 */
export async function readPrimaryArticlesForNovels(
  novelIds: readonly string[],
): Promise<ReadonlyMap<string, PrimaryArticleRef>> {
  if (novelIds.length === 0) return new Map();
  const articles = await prisma.article.findMany({
    where: { novelId: { in: [...novelIds] }, deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, novelId: true, locale: true, slug: true, status: true },
  });
  const byNovelId = new Map<string, PrimaryArticleRef>();
  for (const article of articles) {
    // C-27: `Article.novelId` is nullable at the type level (blog articles),
    // but the `where: { novelId: { in: [...novelIds] } }` clause above can
    // only ever match rows whose `novelId` is one of the caller-supplied,
    // non-null ids — a null `novelId` row is structurally excluded from this
    // result set. This guard makes that provable to the type checker without
    // a `!` assertion; it is not expected to ever actually skip a row.
    if (article.novelId === null) continue;
    // Today there is exactly one live Article per Novel (see module header);
    // `orderBy: createdAt asc` plus first-write-wins here means a future
    // regression of that invariant fails safe (picks the oldest row) instead
    // of silently overwriting with an arbitrary later one.
    if (!byNovelId.has(article.novelId)) {
      byNovelId.set(article.novelId, {
        articleId: article.id,
        locale: article.locale,
        slug: article.slug,
        status: article.status as ArticleStatus,
      });
    }
  }
  return byNovelId;
}
