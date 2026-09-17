-- C-24: Article three-axis foundation (article_type / content_mode / seo_visibility).
--
-- Adds the three CPS-parity axis columns `article` was missing so C-25 (SEO
-- visibility) and C-26 (type + content-mode filtering) have a place to land,
-- and so C-27's blog foundation can key its published-CHECK split on
-- article_type. This migration is schema-only and zero behavior change: as
-- of this migration, no query anywhere in this codebase reads any of these
-- three columns, so nothing observable changes. Backfill is not needed --
-- every existing row lands on the default that equals today's implicit
-- behavior for all of them (a novel-bound article rendered from its
-- template, publicly listable). The guard at the bottom certifies that.
--
-- Value-list provenance:
--   * article_type: CPS parity, copied from this repo's own existing machine
--     source `src/lib/article-templates/applicable-article-type.ts`
--     (`APPLICABLE_ARTICLE_TYPES`, P2-02B), with `any` dropped -- `any` only
--     means "this template applies to every article type"; it is not a value
--     an article itself can hold.
--   * content_mode / seo_visibility: no prior source of truth in this repo;
--     both value lists are copied verbatim from CPS's own
--     `src/lib/article-v2-contract.ts` (a CPS-repo-only path, not present in
--     this codebase), no CPS parity adaptation needed.

-- 1. New columns. Each is NOT NULL with a default equal to today's implicit
-- behavior for every existing row, so the ADD COLUMN itself is the backfill.
ALTER TABLE "article"
  ADD COLUMN "article_type" VARCHAR(32) NOT NULL DEFAULT 'novel_article',
  ADD COLUMN "content_mode" VARCHAR(32) NOT NULL DEFAULT 'template',
  ADD COLUMN "seo_visibility" VARCHAR(32) NOT NULL DEFAULT 'public';

-- 2. CHECK constraints for the three enumerations. Physical names follow this
-- schema's existing <table>_<column>_check convention (see article_status_check).
ALTER TABLE "article" ADD CONSTRAINT "article_article_type_check"
  CHECK ("article_type" IN ('novel_article', 'blog_article', 'listicle', 'guide'));
ALTER TABLE "article" ADD CONSTRAINT "article_content_mode_check"
  CHECK ("content_mode" IN ('manual', 'template'));
ALTER TABLE "article" ADD CONSTRAINT "article_seo_visibility_check"
  CHECK ("seo_visibility" IN ('public', 'seo_only', 'hidden'));

-- 3. Indexes for the filtering and blog-listing work this foundation
-- unlocks (CPS parity: a plain @@index([seoVisibility]) and a composite
-- covering type + locale + status + publishedAt).
CREATE INDEX "article_seo_visibility_idx" ON "article"("seo_visibility");
CREATE INDEX "article_type_locale_status_published_idx" ON "article"("article_type", "locale", "status", "published_at");

-- 4. Self-certifying guard. ADD COLUMN ... DEFAULT backfills every existing
-- row to that literal default within the same DDL statement, so this count
-- is mechanically guaranteed to be zero today. The guard exists so a future
-- edit to this file that reorders steps 1-3 or drops a DEFAULT clause fails
-- the migration loudly instead of silently changing an existing row's
-- observable behavior.
DO $c24_article_axes_guard$
DECLARE
    off_default_count BIGINT;
BEGIN
    SELECT count(*)
      INTO off_default_count
      FROM "article"
     WHERE "article_type" <> 'novel_article'
        OR "content_mode" <> 'template'
        OR "seo_visibility" <> 'public';

    IF off_default_count > 0 THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = format(
                'C-24 article axes migration blocked: found %s row(s) off the zero-behavior-change default; this migration must not change any existing row''s observable behavior',
                off_default_count
            );
    END IF;
END;
$c24_article_axes_guard$;
