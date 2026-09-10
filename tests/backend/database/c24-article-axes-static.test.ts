import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ARTICLE_CONTENT_MODES,
  ARTICLE_SEO_VISIBILITIES,
  ARTICLE_TYPES,
  DATABASE_STATUS_SEMANTICS,
} from "@/domain/database-statuses";
import { APPLICABLE_ARTICLE_TYPES } from "@/lib/article-templates/applicable-article-type";

const root = process.cwd();
const schemaPath = path.join(root, "prisma/schema.prisma");
const migrationPath = path.join(
  root,
  "prisma/migrations/20260909090000_c24_article_axes/migration.sql",
);

const schema = readFileSync(schemaPath, "utf8");
const migration = readFileSync(migrationPath, "utf8");

/**
 * Extracts the value list of a `CHECK ("column" IN ('a', 'b', ...))` clause
 * from raw migration SQL text, in source order. This is the "parse the
 * migration SQL" half of the C-24 contract test -- it does not trust a
 * hand-copied literal string, it re-derives the list from the SQL itself so
 * a future edit that silently drops or reorders a value is caught even if
 * nobody remembers to update a hardcoded expectation here.
 */
function parseCheckValues(sql: string, column: string): string[] {
  const pattern = new RegExp(`CHECK \\("${column}" IN \\(([^)]+)\\)\\)`);
  const match = sql.match(pattern);
  if (!match) {
    throw new Error(`No CHECK clause found for column "${column}" in migration SQL`);
  }
  return match[1]
    .split(",")
    .map((value) => value.trim().replace(/^'|'$/g, ""));
}

describe("C-24 article axes foundation (static, zero behavior change)", () => {
  it("keeps article_type as APPLICABLE_ARTICLE_TYPES minus 'any', with no drift between the two sources", () => {
    expect(ARTICLE_TYPES).toEqual(["novel_article", "blog_article", "listicle", "guide"]);
    expect(APPLICABLE_ARTICLE_TYPES).toContain("any");
    expect([...ARTICLE_TYPES]).toEqual(
      APPLICABLE_ARTICLE_TYPES.filter((value) => value !== "any"),
    );
  });

  it("keeps content_mode and seo_visibility as CPS parity value lists, copied verbatim", () => {
    expect(ARTICLE_CONTENT_MODES).toEqual(["manual", "template"]);
    expect(ARTICLE_SEO_VISIBILITIES).toEqual(["public", "seo_only", "hidden"]);
  });

  it("keeps DATABASE_STATUS_SEMANTICS in lockstep with all three constant sets", () => {
    expect(Object.keys(DATABASE_STATUS_SEMANTICS.article_type)).toEqual([...ARTICLE_TYPES]);
    expect(Object.keys(DATABASE_STATUS_SEMANTICS.content_mode)).toEqual([...ARTICLE_CONTENT_MODES]);
    expect(Object.keys(DATABASE_STATUS_SEMANTICS.seo_visibility)).toEqual([
      ...ARTICLE_SEO_VISIBILITIES,
    ]);
  });

  it("declares all three fields on the Prisma Article model with the zero-behavior-change defaults", () => {
    expect(schema).toContain(
      'articleType       String    @default("novel_article") @map("article_type") @db.VarChar(32)',
    );
    expect(schema).toContain(
      'contentMode       String    @default("template") @map("content_mode") @db.VarChar(32)',
    );
    expect(schema).toContain(
      'seoVisibility     String    @default("public") @map("seo_visibility") @db.VarChar(32)',
    );
  });

  it("declares the two new indexes CPS parity calls for (seoVisibility; articleType+locale+status+publishedAt)", () => {
    expect(schema).toContain(
      '@@index([seoVisibility], map: "article_seo_visibility_idx")',
    );
    expect(schema).toContain(
      '@@index([articleType, locale, status, publishedAt], map: "article_type_locale_status_published_idx")',
    );
  });

  it("migration adds the three columns as NOT NULL with the exact zero-behavior-change defaults", () => {
    expect(migration).toContain('ADD COLUMN "article_type" VARCHAR(32) NOT NULL DEFAULT \'novel_article\'');
    expect(migration).toContain('ADD COLUMN "content_mode" VARCHAR(32) NOT NULL DEFAULT \'template\'');
    expect(migration).toContain('ADD COLUMN "seo_visibility" VARCHAR(32) NOT NULL DEFAULT \'public\'');
  });

  it("parses the migration SQL's CHECK clauses and finds them identical to the TypeScript constant sets", () => {
    expect(parseCheckValues(migration, "article_type")).toEqual([...ARTICLE_TYPES]);
    expect(parseCheckValues(migration, "content_mode")).toEqual([...ARTICLE_CONTENT_MODES]);
    expect(parseCheckValues(migration, "seo_visibility")).toEqual([...ARTICLE_SEO_VISIBILITIES]);
  });

  it("creates both new indexes with the physical names the dictionary and schema.prisma expect", () => {
    expect(migration).toContain(
      'CREATE INDEX "article_seo_visibility_idx" ON "article"("seo_visibility")',
    );
    expect(migration).toContain(
      'CREATE INDEX "article_type_locale_status_published_idx" ON "article"("article_type", "locale", "status", "published_at")',
    );
  });

  it("does not touch novel_id, promo_link_id, or any published-row CHECK (that is C-27's job, not C-24's)", () => {
    expect(migration).not.toMatch(/novel_id/);
    expect(migration).not.toMatch(/promo_link_id/);
    expect(migration).not.toMatch(/article_published_/);
    expect(migration).not.toMatch(/DROP CONSTRAINT/);
  });

  it("carries the self-certifying zero-behavior-change guard", () => {
    expect(migration).toContain("c24_article_axes_guard");
    expect(migration).toMatch(/RAISE EXCEPTION/);
    expect(migration).toContain("ERRCODE = '23514'");
  });
});
