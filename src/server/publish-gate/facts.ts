/**
 * Assembles a `PublishGateFacts` snapshot (see `evaluator.ts`) from the
 * database for one Article. Split out from the evaluator itself so the
 * evaluator stays a pure, DB-free classifier (`evaluator.test.ts` never
 * touches Prisma); this is the only file in `publish-gate/` that queries.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

import type { PublishGateFacts } from "./evaluator";

type FactsDb = PrismaClient | Prisma.TransactionClient;

export type LoadedArticle = {
  readonly id: string;
  readonly novelId: string;
  readonly locale: string;
  readonly slug: string;
  /**
   * `Article.publicPageShortId` — carried through purely so
   * `src/server/publish-gate/service.ts` can build the public path to
   * revalidate after a transition commits (`@/server/publication/revalidate`)
   * without a second query. Not read by the gate itself (`evaluator.ts`
   * never sees this value).
   */
  readonly publicPageShortId: string;
  readonly status: string;
  readonly publishedAt: Date | null;
};

export type PublishGateFactsResult = {
  readonly facts: PublishGateFacts;
  readonly article: LoadedArticle;
};

/**
 * Loads every fact `evaluatePublishGate` needs for `articleId`. Returns
 * `null` when the Article does not exist or is soft-deleted (mirroring
 * `visibility.ts`'s `PRIMARY_ARTICLE_RECORD`/`PRIMARY_NOVEL_RECORD`
 * `deletedAt: null` fragments — a caller reaching this function has no
 * legitimate reason to gate a deleted row).
 */
export async function loadPublishGateFacts(
  db: FactsDb,
  articleId: string,
): Promise<PublishGateFactsResult | null> {
  const article = await db.article.findFirst({
    where: { id: articleId, deletedAt: null },
    select: {
      id: true,
      novelId: true,
      locale: true,
      slug: true,
      publicPageShortId: true,
      status: true,
      title: true,
      body: true,
      publishedAt: true,
      novel: { select: { status: true, locale: true, deletedAt: true } },
      promoLink: { select: { status: true, webUrl: true, appUrl: true } },
    },
  });
  if (!article || article.novel.deletedAt !== null) return null;

  const [previewChapters, conflictingArticle] = await Promise.all([
    db.novelChapter.findMany({
      where: { novelId: article.novelId, deletedAt: null, status: "preview" },
      select: { content: { select: { body: true } } },
    }),
    // 🔴 Defense-in-depth, currently unreachable in V1 (merge-time review,
    // `scratchpad/reports/A-REVIEW.md` §2 信息项): this query looks for a
    // different, non-deleted Article already occupying this Article's own
    // `(locale, slug)` pair. `article_locale_slug_active_uidx`
    // (`prisma/migrations/20260803090000_p1_initial_schema/migration.sql:1287`
    // — `UNIQUE (locale, slug) WHERE deleted_at IS NULL`) is structurally
    // identical to this WHERE clause and applies unconditionally at every
    // write, not only at publish time, so the database can never contain the
    // row this query is looking for — `conflicting` is always `false` today.
    // Same posture `docs/p2/P2_01_PUBLISH_GATE_CONTRACT.md` §3 takes for
    // `public_redirect_code` (DB `NOT NULL + UNIQUE` makes that failure
    // state unreachable too) — the difference is `public_redirect_code`'s
    // reason code was removed from the frozen nine-element registry
    // entirely for being unreachable, while `page_identity_conflict` stays
    // registered; this query is kept, unlike that removal, because a future
    // slug-alias table or an edit path that reassigns `slug` post-creation
    // could reintroduce a reachable case the DB constraint alone would not
    // cover the same way. Do not delete this query on the assumption it is
    // dead — it is deliberately redundant with the DB constraint, not
    // superseded by it.
    db.article.findFirst({
      where: {
        id: { not: article.id },
        deletedAt: null,
        locale: article.locale,
        slug: article.slug,
      },
      select: { id: true },
    }),
  ]);

  const facts: PublishGateFacts = {
    novel: { status: article.novel.status, locale: article.novel.locale },
    article: {
      status: article.status,
      title: article.title,
      slug: article.slug,
      body: article.body,
    },
    promoLink: article.promoLink,
    preview: {
      hasPreviewChapter: previewChapters.length > 0,
      hasPreviewBody: previewChapters.some((chapter) => (chapter.content?.body ?? "").trim().length > 0),
    },
    pageIdentity: { conflicting: conflictingArticle !== null },
  };

  return {
    facts,
    article: {
      id: article.id,
      novelId: article.novelId,
      locale: article.locale,
      slug: article.slug,
      publicPageShortId: article.publicPageShortId,
      status: article.status,
      publishedAt: article.publishedAt,
    },
  };
}
