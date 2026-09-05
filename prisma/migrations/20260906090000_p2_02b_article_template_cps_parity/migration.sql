-- P2-02B: ArticleTemplate CPS parity.
--
-- Adds the five columns CPS's `ArticleTemplate` has and this schema was missing
-- (template_name / applicable_article_type / content_template / slug_template /
-- meta_keywords_template), and fixes a real pre-existing defect in the status CHECK
-- (see step 2).

-- 1. New columns.
ALTER TABLE "article_template"
  ADD COLUMN "template_name" VARCHAR(191),
  ADD COLUMN "applicable_article_type" VARCHAR(32) NOT NULL DEFAULT 'novel_article',
  ADD COLUMN "content_template" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "slug_template" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "meta_keywords_template" TEXT NOT NULL DEFAULT '';

-- template_name has no meaningful generic default (it is operator-facing display text,
-- distinct from the machine key), so existing rows are backfilled from template_key before
-- the column is locked to NOT NULL.
UPDATE "article_template" SET "template_name" = "template_key" WHERE "template_name" IS NULL;
ALTER TABLE "article_template" ALTER COLUMN "template_name" SET NOT NULL;

-- 2. Fix article_template_status_check.
--
-- The initial migration (20260803090000_p1_initial_schema/migration.sql:1244) installed
-- CHECK ("status" IN ('draft', 'active', 'retired')), but the application layer
-- (src/server/article-templates/service.ts: ArticleTemplateStatus, setArticleTemplateStatus,
-- softDeleteArticleTemplate) has always written 'inactive', never 'retired'. No later
-- migration ever corrected the CHECK. On a real PostgreSQL database this means every
-- deactivate/soft-delete write to article_template would fail with 23514
-- check_violation — this has been a latent production defect independent of this task's
-- new columns. Backfill any pre-existing 'retired' rows first, then swap the CHECK to the
-- value the application actually uses.
UPDATE "article_template" SET "status" = 'inactive' WHERE "status" = 'retired';

ALTER TABLE "article_template" DROP CONSTRAINT "article_template_status_check";
ALTER TABLE "article_template" ADD CONSTRAINT "article_template_status_check"
  CHECK ("status" IN ('draft', 'active', 'inactive'));

-- 3. New CHECK for applicable_article_type (novel_article added as a straight terminology
-- swap of CPS's drama_article; the rest of the enum matches CPS exactly).
ALTER TABLE "article_template" ADD CONSTRAINT "article_template_applicable_article_type_check"
  CHECK ("applicable_article_type" IN ('novel_article', 'blog_article', 'listicle', 'guide', 'any'));

-- article_template_versions_check (version > 0 AND schema_version > 0) is untouched by
-- this migration.
