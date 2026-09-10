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

  it("migration timestamp sorts after every other migration directory (no N-11-style timestamp inversion)", () => {
    const migrationsDir = path.join(root, "prisma/migrations");
    const dirNames = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(dirNames[dirNames.length - 1]).toBe("20260912090000_l10n_article_template_locale_not_null");
  });
});
