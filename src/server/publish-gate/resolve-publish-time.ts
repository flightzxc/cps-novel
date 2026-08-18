/**
 * Ported near-verbatim from CPS `src/lib/article-publish-time.ts` (26 lines,
 * COPY_AS_IS per `P2-07-12-移植审计-2026-08-12/P2-07.md` §依赖闭包 A — ~90%
 * retained, zero imports, zero CPS-specific field names). Registered in
 * `docs/governance/port-registry.md`.
 *
 * Pure function, no Prisma dependency: given the status this write is moving
 * an Article *to* and whatever publish-time value the caller already has
 * (submitted explicitly, or already stored), decides what `Article.publishedAt`
 * should become. The only behavior is "first time reaching `published` with no
 * explicit time defaults to `now`; every other case preserves whatever time
 * was already resolved" — this is what makes `publishedAt` sticky across
 * repeated writes (a re-save of an already-published Article does not reset
 * its publish timestamp), which `src/server/publish-gate/service.ts` relies on
 * to decide `firstPublish` (see that module's header).
 */

export type ArticlePublishStatus = string | null | undefined;

export interface ResolveArticlePublishTimeInput {
  status: ArticlePublishStatus;
  submittedPublishTime?: string | Date | null;
  existingPublishTime?: Date | string | null;
  now?: Date;
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

export function resolveArticlePublishTimeForWrite({
  status,
  submittedPublishTime,
  existingPublishTime,
  now = new Date(),
}: ResolveArticlePublishTimeInput): Date | null {
  const resolved = toDate(submittedPublishTime) ?? toDate(existingPublishTime);
  if (status === "published" && !resolved) {
    return now;
  }
  return resolved;
}
