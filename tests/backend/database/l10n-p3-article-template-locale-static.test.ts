import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * L10N P3（`施工提示词_Sonnet_L10N_P3_模板locale非空化与15语模板资产_2026-09-10.md`
 * §1.A/§1.G，矩阵 #5）: static contract test for the `ArticleTemplate.locale`
 * non-null migration, same discipline as `c27-blog-article-foundation-static.test.ts`
 * — no database connection, only re-derives facts from `schema.prisma` and the
 * migration SQL text itself, so a future edit that silently drops the `NOT NULL`
 * or the default is caught even if nobody remembers to update a hardcoded
 * expectation elsewhere.
 */
const root = process.cwd();
const schemaPath = path.join(root, "prisma/schema.prisma");
const migrationPath = path.join(
  root,
  "prisma/migrations/20260912090000_l10n_article_template_locale_not_null/migration.sql",
);

const schema = readFileSync(schemaPath, "utf8");
const migration = readFileSync(migrationPath, "utf8");

describe("L10N P3 ArticleTemplate.locale non-null (static, no DB connection)", () => {
  it("declares ArticleTemplate.locale as a non-null scalar with a default of 'en' on the Prisma model — CPS parity 3a76877:prisma/schema.prisma:518", () => {
    expect(schema).toContain('locale                String    @default("en") @db.VarChar(16)');
    // Negative check: the pre-P3 nullable form must not still be present anywhere in the model.
    expect(schema).not.toMatch(/locale\s+String\?\s+@db\.VarChar\(16\)/);
  });

  it("migration backfills any pre-existing NULL rows to 'en' before locking the column NOT NULL", () => {
    const updateIndex = migration.indexOf('UPDATE "article_template" SET "locale" = \'en\' WHERE "locale" IS NULL');
    const notNullIndex = migration.indexOf('ALTER COLUMN "locale" SET NOT NULL');
    expect(updateIndex).toBeGreaterThanOrEqual(0);
    expect(notNullIndex).toBeGreaterThan(updateIndex);
  });

  it("migration sets both DEFAULT 'en' and NOT NULL on article_template.locale", () => {
    expect(migration).toContain("ALTER TABLE \"article_template\"");
    expect(migration).toContain('ALTER COLUMN "locale" SET DEFAULT \'en\'');
    expect(migration).toContain('ALTER COLUMN "locale" SET NOT NULL');
  });

  it("migration timestamp sorts after every migration directory that existed before it (no N-11-style timestamp inversion)", () => {
    // Pins this migration's position relative to every directory that
    // existed when it landed, not "is the newest migration in the repo
    // forever" — `20260912100000_carousel_serving_source_check_fix` legitimately
    // landed later and correctly sorts after it, the same way this migration
    // once landed after everything before it. A future migration sorting
    // after this one is expected and must not fail this guard; a *directory
    // that predates this one on disk* sorting after it would be the actual
    // N-11-style inversion this test guards against.
    const migrationsDir = path.join(root, "prisma/migrations");
    const dirNames = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const thisMigration = "20260912090000_l10n_article_template_locale_not_null";
    const priorMigrations = [
      "20260803090000_p1_initial_schema",
      "20260804090000_p1_08_credential_status_parity",
      "20260804140000_p1_08b_admin_auth_persistence",
      "20260816160000_p2_06_5_tagging_v3",
      "20260818120000_v020_foundation_shared",
      "20260906090000_p2_02b_article_template_cps_parity",
      "20260907090000_p3_generic_task_catalog_scan_indexes",
      "20260907091500_p3_drop_catalog_scan_task",
      "20260909090000_c24_article_axes",
      "20260910090000_c27_blog_article_foundation",
      "20260911090000_c30_novel_rebind_foundation",
    ];
    expect(dirNames).toContain(thisMigration);
    const thisIndex = dirNames.indexOf(thisMigration);
    for (const prior of priorMigrations) {
      expect(dirNames.indexOf(prior), `${prior} must sort before ${thisMigration}`).toBeLessThan(thisIndex);
    }
  });
});
