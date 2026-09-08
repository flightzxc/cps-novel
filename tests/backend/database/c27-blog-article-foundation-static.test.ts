import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * C-27 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-27):
 * static contract test for the blog data foundation migration, same
 * discipline as `c24-article-axes-static.test.ts` this file directly follows
 * on from ("that is C-27's job, not C-24's"). No database connection: this
 * only re-derives facts from `schema.prisma` and the migration SQL text
 * itself, so a future edit that silently drops or reorders a clause is
 * caught even if nobody remembers to update a hardcoded expectation here.
 */
const root = process.cwd();
const schemaPath = path.join(root, "prisma/schema.prisma");
const migrationPath = path.join(
  root,
  "prisma/migrations/20260910090000_c27_blog_article_foundation/migration.sql",
);

const schema = readFileSync(schemaPath, "utf8");
const migration = readFileSync(migrationPath, "utf8");

const FORKED_PROMO_LINK_CHECK =
  "CHECK (\"status\" <> 'published' OR \"article_type\" <> 'novel_article' OR \"promo_link_id\" IS NOT NULL)";

const NOVEL_ID_BY_TYPE_CHECK_BODY =
  "(\"article_type\" = 'novel_article' AND \"novel_id\" IS NOT NULL)\n    OR (\"article_type\" <> 'novel_article' AND \"novel_id\" IS NULL)";

describe("C-27 blog article foundation (static, no DB connection)", () => {
  it("declares Article.novelId as an optional scalar on the Prisma model", () => {
    expect(schema).toContain('novelId           String?   @map("novel_id") @db.Uuid');
  });

  it("declares the novel relation as optional (Novel?), matching the nullable FK column", () => {
    expect(schema).toContain(
      "novel              Novel?                      @relation(fields: [novelId], references: [id], onDelete: Restrict)",
    );
  });

  it("does not touch novel_id's unique/index membership (article_novel_locale_key) or the composite FK — both stay structurally correct for NULL novel_id without any schema change", () => {
    expect(schema).toContain('@@unique([novelId, locale], map: "article_novel_locale_key")');
    expect(schema).toContain(
      'promoLink          PromoLink?                  @relation("ArticlePromoLinkByNovel", fields: [promoLinkId, novelId], references: [id, novelId], onDelete: Restrict, map: "article_promo_link_novel_fkey")',
    );
  });

  it("migration drops NOT NULL on novel_id with zero data change (no UPDATE, no backfill)", () => {
    expect(migration).toContain('ALTER TABLE "article" ALTER COLUMN "novel_id" DROP NOT NULL');
    expect(migration).not.toMatch(/UPDATE\s+"article"/i);
  });

  it("forks article_published_promo_link_check by article_type via DROP + re-ADD under the same name", () => {
    expect(migration).toContain('DROP CONSTRAINT "article_published_promo_link_check"');
    expect(migration).toContain('ADD CONSTRAINT "article_published_promo_link_check"');
    expect(migration).toContain(FORKED_PROMO_LINK_CHECK);
  });

  it("adds article_novel_id_by_type_check with the exact re-strengthening predicate", () => {
    expect(migration).toContain('ADD CONSTRAINT "article_novel_id_by_type_check"');
    expect(migration).toContain(NOVEL_ID_BY_TYPE_CHECK_BODY);
  });

  it("never issues DDL against article_novel_locale_key, article_promo_link_novel_fkey, or article_locale_slug_active_uidx — the plan's explicit 'unchanged' list (the migration's own header prose names them only to explain why, which this test must not false-positive on)", () => {
    for (const objectName of [
      "article_novel_locale_key",
      "article_promo_link_novel_fkey",
      "article_locale_slug_active_uidx",
    ]) {
      const ddlPattern = new RegExp(
        `(DROP|CREATE|ALTER)[^\\n]*"${objectName}"`,
      );
      expect(migration).not.toMatch(ddlPattern);
    }
    // The migration's own header prose explains why NULLS NOT DISTINCT and
    // MATCH FULL must not be added (both phrases legitimately appear in that
    // prose as things NOT to do) — asserted structurally instead: no DDL
    // statement anywhere in the file contains either keyword pair at all,
    // not even inside a comment-adjacent ALTER/CREATE line.
    expect(migration).not.toMatch(/ALTER[^;]*NULLS NOT DISTINCT/is);
    expect(migration).not.toMatch(/(CREATE|ALTER)[^;]*MATCH FULL/is);
  });

  it("does not touch the three C-24 axis columns or their CHECKs/indexes — this migration only touches novel_id and the promo-link CHECK", () => {
    expect(migration).not.toMatch(/ADD COLUMN "article_type"/);
    expect(migration).not.toMatch(/ADD COLUMN "content_mode"/);
    expect(migration).not.toMatch(/ADD COLUMN "seo_visibility"/);
    expect(migration).not.toMatch(/article_article_type_check/);
    expect(migration).not.toMatch(/article_content_mode_check/);
    expect(migration).not.toMatch(/article_seo_visibility_check/);
  });

  it("carries a self-certifying guard asserting zero existing novel_article rows have a NULL novel_id", () => {
    expect(migration).toContain("c27_blog_article_foundation_guard");
    expect(migration).toMatch(/RAISE EXCEPTION/);
    expect(migration).toContain("ERRCODE = '23514'");
    expect(migration).toMatch(/"article_type" = 'novel_article'\s*\n\s*AND "novel_id" IS NULL/);
  });
});
