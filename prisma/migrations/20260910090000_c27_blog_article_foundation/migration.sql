-- C-27: Blog data foundation (novel_id nullable + published-CHECK forked by
-- article_type).
--
-- Business narrative (规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md
-- §三/C-27): blog articles do not belong to any Novel. This repo's Article
-- table today hardcodes "belongs to a Novel" as a database-level axiom in
-- three places -- novel_id NOT NULL, published requires a PromoLink, and the
-- PromoLink must belong to the same Novel. This migration narrows the first
-- two of those from "true for every Article" to "true for novel_article"
-- specifically, and -- this is the load-bearing half, not a side effect --
-- adds back a new CHECK that keeps novel_article's own protection exactly as
-- strong as it was before this migration. Net effect: relax + re-strengthen,
-- not just relax.
--
-- 1. `article.novel_id` -> nullable. Blog/listicle/guide Articles carry NULL
--    here; novel_article Articles are still required to have one (enforced
--    by the new CHECK in step 3, not by NOT NULL anymore).
-- 2. `article_published_promo_link_check` -> forked by article_type: a
--    published novel_article still requires a PromoLink (unchanged
--    protection); a published blog/listicle/guide Article does not (it has
--    no PromoLink to require -- PromoLink belongs to a Novel).
-- 3. New CHECK `article_novel_id_by_type_check`: novel_article rows must
--    have a non-null novel_id; every other article_type must have a null
--    novel_id. This is the "re-strengthen" half -- without it, step 1 alone
--    would let a novel_article publish with no Novel at all (a structural
--    regression, not a new capability).
--
-- Deliberately NOT touched, and why (see plan §一 structural facts + §三/
-- C-27's own "明确不移植" section):
--   * `article_novel_locale_key` (UNIQUE(novel_id, locale)) -- PostgreSQL's
--     default NULL-distinct semantics already let unlimited novel_id-NULL
--     blog rows coexist per locale; this is the CORRECT behavior for a
--     blog's slug-namespaced-by-locale-not-by-novel model. Do not add
--     `NULLS NOT DISTINCT` here -- that would silently cap the site to one
--     blog article per locale, ever. See
--     docs/governance/database-governance.md §5 item 21.
--   * `article_promo_link_novel_fkey` (composite FK on
--     (promo_link_id, novel_id) -> promo_link(id, novel_id)) -- PostgreSQL's
--     default MATCH SIMPLE means the FK is not checked at all when either
--     column is NULL, so a blog row (both NULL) is trivially FK-legal with
--     zero schema change. `docs/governance/database-governance.md`'s P1-05B
--     note already forbids rewriting this as MATCH FULL; this migration is
--     the second time that note pays for itself.
--   * `article_locale_slug_active_uidx` (UNIQUE(locale, slug) WHERE
--     deleted_at IS NULL) -- does not reference novel_id at all, so
--     novel_id's nullability cannot affect it; blog and novel_article rows
--     already share one slug namespace per locale, which is the intended,
--     stricter-than-CPS behavior this repo already had before C-27.
--
-- Existing-row impact: none. Every row in this table today is
-- article_type='novel_article' with novel_id set (C-24's own migration
-- guard already certified this repo has zero rows off that shape at the
-- three-axis level; this migration's own guard at the bottom re-certifies
-- it for novel_id specifically, since that is the column this migration
-- actually loosens).

-- 1. novel_id: NOT NULL -> nullable. No data change -- every existing row
-- keeps its current (non-null) value; only future blog/listicle/guide rows
-- can now supply NULL here.
ALTER TABLE "article" ALTER COLUMN "novel_id" DROP NOT NULL;

-- 2. Fork the published-promo-link CHECK by article_type. DROP + re-ADD
-- under the same physical name, same convention C-24's header cites for
-- `article_template_status_check`'s earlier same-named DROP+ADD fix
-- (docs/governance/database-governance.md §4).
ALTER TABLE "article" DROP CONSTRAINT "article_published_promo_link_check";
ALTER TABLE "article" ADD CONSTRAINT "article_published_promo_link_check"
  CHECK ("status" <> 'published' OR "article_type" <> 'novel_article' OR "promo_link_id" IS NOT NULL);

-- 3. New CHECK: novel_id presence must match article_type exactly --
-- non-null for novel_article, null for everything else. This is what keeps
-- novel_article's "must belong to a Novel" invariant exactly as strong as
-- the NOT NULL constraint step 1 just removed.
ALTER TABLE "article" ADD CONSTRAINT "article_novel_id_by_type_check"
  CHECK (
    ("article_type" = 'novel_article' AND "novel_id" IS NOT NULL)
    OR ("article_type" <> 'novel_article' AND "novel_id" IS NULL)
  );

-- 4. Self-certifying guard. Every existing row must already satisfy the new
-- CHECK from step 3 (article_type='novel_article' with novel_id set) --
-- this DDL does not backfill anything, so if this count is ever non-zero the
-- migration itself would already have failed at step 3's CHECK validation;
-- this guard exists so a future edit to this file that reorders steps or
-- drops the CHECK fails loudly instead of silently shipping a novel_article
-- row that could publish without ever having had a Novel.
DO $c27_blog_article_foundation_guard$
DECLARE
    non_novel_article_with_novel_count BIGINT;
BEGIN
    SELECT count(*)
      INTO non_novel_article_with_novel_count
      FROM "article"
     WHERE "article_type" = 'novel_article'
       AND "novel_id" IS NULL;

    IF non_novel_article_with_novel_count > 0 THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = format(
                'C-27 blog article foundation migration blocked: found %s novel_article row(s) with a NULL novel_id; this migration must not weaken novel_article''s own "must belong to a Novel" invariant',
                non_novel_article_with_novel_count
            );
    END IF;
END;
$c27_blog_article_foundation_guard$;
