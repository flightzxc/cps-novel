import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DATABASE_STATUS_SEMANTICS,
  REBIND_BATCH_STATUSES,
  REBIND_ERROR_KINDS,
  REBIND_ITEM_STATUSES,
} from "@/domain/database-statuses";

const root = process.cwd();
const migrationPath = path.join(
  root,
  "prisma/migrations/20260911090000_c30_novel_rebind_foundation/migration.sql",
);
const migration = readFileSync(migrationPath, "utf8");

/**
 * Extracts the value list of a `CHECK (...)` clause from raw migration SQL
 * text, keyed by the constraint's own physical name (not by column name).
 * Same "re-derive from the SQL itself, don't trust a hand-copied literal"
 * discipline as `c24-article-axes-static.test.ts`'s `parseCheckValues` --
 * this migration keys by constraint name rather than column name because,
 * unlike C-24's `article_type`/`content_mode`/`seo_visibility` (three
 * distinct column names, each appearing once), this migration has a
 * `"status"` CHECK on *two different tables*
 * (`article_novel_rebind_batch_status_check` and
 * `article_novel_rebind_batch_item_status_check`) -- a column-name-keyed
 * lookup would silently grab whichever one happens to match first. Handles
 * the nullable form too (`error_kind`'s `CHECK ("error_kind" IS NULL OR
 * "error_kind" IN (...))`) since the `IN (...)` list is what is compared
 * either way.
 */
function parseCheckValuesByConstraintName(sql: string, constraintName: string): string[] {
  const constraintPattern = new RegExp(
    `ADD CONSTRAINT "${constraintName}"\\s*\\n\\s*CHECK \\(([\\s\\S]*?)\\);`,
  );
  const constraintMatch = sql.match(constraintPattern);
  if (!constraintMatch) {
    throw new Error(`No ADD CONSTRAINT "${constraintName}" ... CHECK (...) found in migration SQL`);
  }
  const inListMatch = constraintMatch[1].match(/IN \(([^)]+)\)/);
  if (!inListMatch) {
    throw new Error(`Constraint "${constraintName}"'s CHECK body has no IN (...) value list: ${constraintMatch[1]}`);
  }
  return inListMatch[1]
    .split(",")
    .map((value) => value.trim().replace(/^'|'$/g, ""));
}

describe("C-30A novel-rebind CHECK constraints (static, migration SQL <-> TypeScript source of truth)", () => {
  it("keeps the three TypeScript status/error-kind constant sets exactly as the construction order fixed them", () => {
    expect(REBIND_BATCH_STATUSES).toEqual(["ready", "processing", "completed", "partial", "failed"]);
    expect(REBIND_ITEM_STATUSES).toEqual(["pending", "processing", "applied", "skipped", "failed"]);
    expect(REBIND_ERROR_KINDS).toEqual([
      "drift",
      "not_found",
      "blocked",
      "ineligible",
      "fence_lost",
      "unknown",
    ]);
  });

  it("keeps DATABASE_STATUS_SEMANTICS in lockstep with all three constant sets", () => {
    expect(Object.keys(DATABASE_STATUS_SEMANTICS.article_novel_rebind_batch)).toEqual([
      ...REBIND_BATCH_STATUSES,
    ]);
    expect(Object.keys(DATABASE_STATUS_SEMANTICS.article_novel_rebind_batch_item)).toEqual([
      ...REBIND_ITEM_STATUSES,
    ]);
    expect(Object.keys(DATABASE_STATUS_SEMANTICS.article_novel_rebind_batch_item_error_kind)).toEqual([
      ...REBIND_ERROR_KINDS,
    ]);
  });

  it("parses the migration SQL's three CHECK clauses and finds them identical to the TypeScript constant sets", () => {
    expect(
      parseCheckValuesByConstraintName(migration, "article_novel_rebind_batch_status_check"),
    ).toEqual([...REBIND_BATCH_STATUSES]);
    expect(
      parseCheckValuesByConstraintName(migration, "article_novel_rebind_batch_item_status_check"),
    ).toEqual([...REBIND_ITEM_STATUSES]);
    expect(
      parseCheckValuesByConstraintName(migration, "article_novel_rebind_batch_item_error_kind_check"),
    ).toEqual([...REBIND_ERROR_KINDS]);
  });

  it("the error_kind CHECK is nullable (IS NULL OR ...), the other two are not", () => {
    expect(migration).toMatch(
      /CHECK \("error_kind" IS NULL OR "error_kind" IN \([^)]+\)\)/,
    );
    expect(migration).not.toMatch(/CHECK \("status" IS NULL OR/);
  });

  /**
   * The plan's own "变异测试" requirement, same shape as `c24-article-axes-
   * static.test.ts`'s implicit guarantee (a hand exercise, not permanent
   * test code -- flipping the real migration SQL is destructive to leave
   * wired into the suite). Verified by hand against the real file: changing
   * `article_novel_rebind_batch_item_error_kind_check`'s SQL value list from
   * `'unknown'` to `'unclassified'` turns the "parses the migration SQL's
   * three CHECK clauses" test above red with
   * `[...,'fence_lost','unclassified'] !== [...,'fence_lost','unknown']`;
   * reverting restores green. See this round's delivery notes for the
   * pasted red/green output.
   */
  it("sanity (mutation guard): the parser itself flags a changed CHECK value list", () => {
    const mutatedSql = migration.replace(
      `ALTER TABLE "article_novel_rebind_batch_item" ADD CONSTRAINT "article_novel_rebind_batch_item_error_kind_check"\n  CHECK ("error_kind" IS NULL OR "error_kind" IN ('drift', 'not_found', 'blocked', 'ineligible', 'fence_lost', 'unknown'));`,
      `ALTER TABLE "article_novel_rebind_batch_item" ADD CONSTRAINT "article_novel_rebind_batch_item_error_kind_check"\n  CHECK ("error_kind" IS NULL OR "error_kind" IN ('drift', 'not_found', 'blocked', 'ineligible', 'fence_lost', 'unclassified'));`,
    );
    // Guard against the replace silently no-op'ing if the SQL text ever
    // reflows (whitespace/line-break changes) without this test being
    // updated to match.
    expect(mutatedSql).not.toBe(migration);
    expect(
      parseCheckValuesByConstraintName(mutatedSql, "article_novel_rebind_batch_item_error_kind_check"),
    ).not.toEqual([...REBIND_ERROR_KINDS]);
  });
});
