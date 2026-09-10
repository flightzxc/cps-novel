import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CAROUSEL_SOURCES } from "@/domain/database-statuses";

const root = process.cwd();
const migrationPath = path.join(
  root,
  "prisma/migrations/20260912100000_carousel_serving_source_check_fix/migration.sql",
);
const baselineMigrationPath = path.join(
  root,
  "prisma/migrations/20260803090000_p1_initial_schema/migration.sql",
);
const servicePath = path.join(root, "src/server/home-carousel/service.ts");

const migration = readFileSync(migrationPath, "utf8");
const baselineMigration = readFileSync(baselineMigrationPath, "utf8");
const service = readFileSync(servicePath, "utf8");

/**
 * Extracts the value list of a `CHECK ("column" IN ('a', 'b', ...))` clause
 * from raw migration SQL text, in source order. Same approach as
 * `tests/backend/database/c24-article-axes-static.test.ts`'s
 * `parseCheckValues` — re-derived from the SQL itself, not a hand-copied
 * literal, so a future edit that silently drops/reorders/adds a value is
 * caught even if nobody remembers to update a hardcoded expectation here.
 */
function parseCheckValues(sql: string, column: string): string[] {
  const pattern = new RegExp(`CHECK \\("${column}" IN \\(([^)]+)\\)\\)`);
  const match = sql.match(pattern);
  if (!match) throw new Error(`No CHECK clause found for column "${column}" in migration SQL`);
  return match[1].split(",").map((value) => value.trim().replace(/^'|'$/g, ""));
}

/**
 * Every `source:` literal `computeHomeCarouselInTx` writes into the `merged`
 * array that feeds `homeCarouselServing.createMany` — extracted from the
 * source text itself (between the `merged` array declaration and the
 * `createMany` call it feeds), not hand-copied, so a future edit that adds a
 * new literal here is caught the same way `parseCheckValues` above catches
 * migration drift. This is the "the code only ever writes CAROUSEL_SOURCES
 * members" half of the schema-contract-drift fix
 * (`20260912100000_carousel_serving_source_check_fix`) — the CHECK-vs-constant
 * half is `parseCheckValues` above; this half additionally guards against
 * CAROUSEL_SOURCES and the CHECK drifting *together* to a value the code
 * never actually produces (which the CHECK-vs-constant check alone cannot
 * catch, since both sides would still agree).
 */
function servingSourceLiteralsWrittenByService(): string[] {
  const start = service.indexOf("const merged: Array<{");
  const end = service.indexOf("homeCarouselServing.createMany", start);
  if (start === -1 || end === -1) {
    throw new Error("Could not locate the `merged` array / homeCarouselServing.createMany region in service.ts — has computeHomeCarouselInTx been restructured?");
  }
  const region = service.slice(start, end);
  const literals = [...region.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
  return [...new Set(literals)];
}

describe("home_carousel_serving.source schema-contract-drift fix (static)", () => {
  it("keeps CAROUSEL_SOURCES as the CPS-aligned fine-grained value set, not the stale two-bucket one", () => {
    expect(CAROUSEL_SOURCES).toEqual(["manual", "new_novel", "recency"]);
  });

  it("parses the fix migration's CHECK clause and finds it identical to CAROUSEL_SOURCES (migration-consistency guard)", () => {
    expect(parseCheckValues(migration, "source")).toEqual([...CAROUSEL_SOURCES]);
  });

  it("drops and replaces the exact constraint name the baseline migration installed, so pg_constraint keeps one definition under one name", () => {
    expect(migration).toContain('ALTER TABLE "home_carousel_serving" DROP CONSTRAINT "home_carousel_serving_source_check"');
    expect(migration).toContain('ALTER TABLE "home_carousel_serving" ADD CONSTRAINT "home_carousel_serving_source_check"');
  });

  it("every source literal computeHomeCarouselInTx writes into home_carousel_serving is a CAROUSEL_SOURCES member (static write-site guard)", () => {
    const written = servingSourceLiteralsWrittenByService();
    expect(written.length).toBeGreaterThan(0);
    for (const value of written) {
      expect(CAROUSEL_SOURCES as readonly string[]).toContain(value);
    }
  });

  it("documents (does not re-fix) the baseline migration's now-superseded CHECK text — the DROP+ADD above is what actually governs the live constraint", () => {
    // The baseline migration file is immutable once applied (editing it would
    // change its checksum and desync `_prisma_migrations` on any stack that
    // already ran it — same discipline as the C-27/L10N-P3 changelog rows'
    // "migration files are not edited after the fact" precedent). Its text
    // therefore still shows the old, wrong value set; this is expected and
    // is exactly why a second migration exists.
    expect(parseCheckValues(baselineMigration, "source")).toEqual(["manual", "automatic"]);
  });
});
