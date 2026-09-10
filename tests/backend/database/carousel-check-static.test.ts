import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CAROUSEL_BATCH_STATUSES, CAROUSEL_SOURCES } from "@/domain/database-statuses";

/**
 * Static "migration allowed values == domain constant == write-site
 * literals" guard for all four `home_carousel_*` tables
 * (`home_carousel_manual_slot`, `home_carousel_auto_batch`,
 * `home_carousel_auto_candidate`, `home_carousel_serving`) — generalized
 * from the file's original scope (`home_carousel_serving.source` only,
 * the `20260912100000_carousel_serving_source_check_fix` fix) to also cover
 * the carousel batch-status schema-contract-drift fix
 * (`home_carousel_auto_batch.status`, sibling bug, same root cause: a
 * hand-typed write-site literal that was never a CHECK member) plus a
 * completeness inventory of every CHECK constraint on all four tables, so a
 * *third* instance of this exact class of bug on any of these tables' other
 * CHECK-governed columns fails this file instead of reaching production.
 */
const root = process.cwd();
const fixMigrationPath = path.join(
  root,
  "prisma/migrations/20260912100000_carousel_serving_source_check_fix/migration.sql",
);
const baselineMigrationPath = path.join(
  root,
  "prisma/migrations/20260803090000_p1_initial_schema/migration.sql",
);
const servicePath = path.join(root, "src/server/home-carousel/service.ts");
const workerHandlerPath = path.join(root, "worker/handlers/home-carousel.ts");

const fixMigration = readFileSync(fixMigrationPath, "utf8");
const baselineMigration = readFileSync(baselineMigrationPath, "utf8");
const service = readFileSync(servicePath, "utf8");
const workerHandler = readFileSync(workerHandlerPath, "utf8");

/**
 * Extracts the value list of a `CONSTRAINT "name" CHECK ("column" IN ('a',
 * 'b', ...))` clause from raw migration SQL text, keyed by the constraint's
 * own name rather than its column name. `20260803090000_p1_initial_schema`
 * declares a `..._status_check` CHECK on well over a dozen tables (`channel`,
 * `novel`, `generic_task`, ... — `home_carousel_auto_batch` is just one of
 * them) and a `source_app_status_check` alongside `channel_status_check`
 * both start with the exact same `CHECK ("status" IN (...))` text — a
 * column-keyed parser (this file's original `parseCheckValues`, matching
 * only the *first* occurrence of the column name) would silently grab the
 * wrong table's value list the moment more than one CHECK on that column
 * name exists in the file, which is exactly the baseline migration's actual
 * shape for `"status"`. Keying by the constraint's own name (globally
 * unique by definition — `pg_constraint` enforces it) sidesteps that trap
 * entirely. Same approach in spirit as
 * `tests/backend/database/c24-article-axes-static.test.ts`'s
 * `parseCheckValues` (re-derived from the SQL itself, not hand-copied), one
 * level more precise.
 */
function parseCheckValuesByConstraint(sql: string, constraintName: string): string[] {
  const pattern = new RegExp(`CONSTRAINT "${constraintName}" CHECK \\("[a-z_]+" IN \\(([^)]+)\\)\\)`);
  const match = sql.match(pattern);
  if (!match) throw new Error(`No named CHECK constraint "${constraintName}" found in migration SQL`);
  return match[1].split(",").map((value) => value.trim().replace(/^'|'$/g, ""));
}

/** All `ALTER TABLE "<table>" ADD CONSTRAINT "<name>" CHECK` constraint names declared against one table, in source order, across one migration file. */
function checkConstraintNamesForTable(sql: string, table: string): string[] {
  const pattern = new RegExp(`ALTER TABLE "${table}" ADD CONSTRAINT "([a-z0-9_]+)" CHECK`, "g");
  return [...sql.matchAll(pattern)].map((match) => match[1]);
}

/**
 * Every `source:` literal `computeHomeCarouselInTx` writes into the `merged`
 * array that feeds `homeCarouselServing.createMany` — extracted from the
 * source text itself (between the `merged` array declaration and the
 * `createMany` call it feeds), not hand-copied, so a future edit that adds a
 * new literal here is caught the same way `parseCheckValuesByConstraint`
 * above catches migration drift. This is the "the code only ever writes
 * CAROUSEL_SOURCES members" half of the schema-contract-drift fix
 * (`20260912100000_carousel_serving_source_check_fix`) — the CHECK-vs-constant
 * half is `parseCheckValuesByConstraint` above; this half additionally
 * guards against CAROUSEL_SOURCES and the CHECK drifting *together* to a
 * value the code never actually produces (which the CHECK-vs-constant check
 * alone cannot catch, since both sides would still agree).
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

/**
 * Every `source:` literal written into `homeCarouselAutoCandidate.createMany`'s
 * row shape, extracted from the single statement's own text (from the call
 * to its terminating `;`). `home_carousel_auto_candidate.source` has no
 * CHECK constraint in either migration (confirmed by the completeness
 * inventory test below — `checkConstraintNamesForTable` finds only
 * `carousel_candidate_rank_check` on this table) — `CAROUSEL_SOURCES`
 * governs it only as a documented application-level convention (see that
 * constant's doc comment in `database-statuses.ts`: "as a subset ... which
 * never writes `manual`"). This is therefore the *only* guard standing
 * between a future edit and a candidate row whose `source` silently stops
 * matching what `home_carousel_serving.source`'s own (CHECK-backed) values
 * mean — there is no database-level backstop for this column at all.
 */
function candidateSourceLiteralsWrittenByService(): string[] {
  const start = service.indexOf("homeCarouselAutoCandidate.createMany(");
  const end = service.indexOf(";", start);
  if (start === -1 || end === -1) {
    throw new Error("Could not locate the homeCarouselAutoCandidate.createMany(...) statement in service.ts — has computeHomeCarouselInTx been restructured?");
  }
  const region = service.slice(start, end);
  const literals = [...region.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
  return [...new Set(literals)];
}

/**
 * Every `status:` literal written at the two `home_carousel_auto_batch`
 * write sites (`homeCarouselAutoBatch.create`'s initial `"pending"`,
 * `homeCarouselAutoBatch.update`'s terminal write), each extracted from its
 * own statement's text (from the call to its terminating `;`) rather than a
 * whole-file scan — `service.ts` writes several *other* `status:` fields
 * that have nothing to do with this table (the candidate/return-value
 * `status: "success" as const` at the end of this same function, the
 * `article`/`novel` publication-status filters, `genericTask`'s task
 * status) which a whole-file regex would also (wrongly) sweep in.
 */
function autoBatchStatusLiteralsWrittenByService(): string[] {
  const literals: string[] = [];
  for (const marker of ["homeCarouselAutoBatch.create(", "homeCarouselAutoBatch.update("]) {
    const start = service.indexOf(marker);
    const end = service.indexOf(";", start);
    if (start === -1 || end === -1) {
      throw new Error(`Could not locate a complete "${marker}...;" statement in service.ts — has computeHomeCarouselInTx been restructured?`);
    }
    const region = service.slice(start, end);
    const match = region.match(/status:\s*"([a-z_]+)"/);
    if (!match) throw new Error(`Could not find a status: string literal inside the ${marker}...) call in service.ts`);
    literals.push(match[1]);
  }
  return [...new Set(literals)];
}

const HOME_CAROUSEL_TABLES = [
  "home_carousel_manual_slot",
  "home_carousel_auto_batch",
  "home_carousel_auto_candidate",
  "home_carousel_serving",
] as const;

describe("home_carousel_serving.source schema-contract-drift fix (static)", () => {
  it("keeps CAROUSEL_SOURCES as the CPS-aligned fine-grained value set, not the stale two-bucket one", () => {
    expect(CAROUSEL_SOURCES).toEqual(["manual", "new_novel", "recency"]);
  });

  it("parses the fix migration's CHECK clause and finds it identical to CAROUSEL_SOURCES (migration-consistency guard)", () => {
    expect(parseCheckValuesByConstraint(fixMigration, "home_carousel_serving_source_check")).toEqual([...CAROUSEL_SOURCES]);
  });

  it("drops and replaces the exact constraint name the baseline migration installed, so pg_constraint keeps one definition under one name", () => {
    expect(fixMigration).toContain('ALTER TABLE "home_carousel_serving" DROP CONSTRAINT "home_carousel_serving_source_check"');
    expect(fixMigration).toContain('ALTER TABLE "home_carousel_serving" ADD CONSTRAINT "home_carousel_serving_source_check"');
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
    expect(parseCheckValuesByConstraint(baselineMigration, "home_carousel_serving_source_check")).toEqual(["manual", "automatic"]);
  });

  it("carousel_serving_position_check (position > 0) is still present in the baseline migration", () => {
    expect(baselineMigration).toContain('ALTER TABLE "home_carousel_serving" ADD CONSTRAINT "carousel_serving_position_check" CHECK ("position" > 0);');
  });
});

describe("home_carousel_auto_batch.status schema-contract-drift fix (static)", () => {
  it("keeps CAROUSEL_BATCH_STATUSES as the P1-frozen four-state set", () => {
    expect(CAROUSEL_BATCH_STATUSES).toEqual(["pending", "processing", "completed", "failed"]);
  });

  it("parses the baseline migration's home_carousel_auto_batch_status_check CHECK clause and finds it identical to CAROUSEL_BATCH_STATUSES (migration-consistency guard)", () => {
    // Unlike home_carousel_serving.source, this CHECK has never been
    // touched by a fix migration — the P1 CHECK was always correct
    // (pending/processing/completed/failed); the bug was
    // computeHomeCarouselInTx writing a value ("success") outside it, not
    // the CHECK itself being wrong. So there is only the baseline migration
    // to parse here, no DROP+ADD pair.
    expect(parseCheckValuesByConstraint(baselineMigration, "home_carousel_auto_batch_status_check")).toEqual([...CAROUSEL_BATCH_STATUSES]);
  });

  it("every status literal computeHomeCarouselInTx writes into home_carousel_auto_batch is a CAROUSEL_BATCH_STATUSES member (static write-site guard)", () => {
    const written = autoBatchStatusLiteralsWrittenByService();
    expect(written).toEqual(["pending", "completed"]);
    for (const value of written) {
      expect(CAROUSEL_BATCH_STATUSES as readonly string[]).toContain(value);
    }
  });

  it("regression pin: 'success' — the exact stale literal the pre-fix code wrote — is not, and has never been, a CAROUSEL_BATCH_STATUSES member", () => {
    expect(CAROUSEL_BATCH_STATUSES as readonly string[]).not.toContain("success");
  });
});

describe("home_carousel_auto_candidate.source write-site guard (static, no database CHECK backs this column)", () => {
  it("home_carousel_auto_candidate has no CHECK constraint on its source column in either migration (documents why this guard exists at all)", () => {
    const names = [
      ...checkConstraintNamesForTable(baselineMigration, "home_carousel_auto_candidate"),
      ...checkConstraintNamesForTable(fixMigration, "home_carousel_auto_candidate"),
    ];
    expect(names).toEqual(["carousel_candidate_rank_check"]);
    expect(names.some((name) => name.includes("source"))).toBe(false);
  });

  it("every source literal computeHomeCarouselInTx writes into home_carousel_auto_candidate is a CAROUSEL_SOURCES member and never 'manual'", () => {
    const written = candidateSourceLiteralsWrittenByService();
    expect(written.length).toBeGreaterThan(0);
    for (const value of written) {
      expect(CAROUSEL_SOURCES as readonly string[]).toContain(value);
    }
    // CAROUSEL_SOURCES doc comment: candidate rows are auto-generated only
    // — "manual" is a home_carousel_serving-only value, assembled from
    // home_carousel_manual_slot directly, never routed through the
    // candidate table.
    expect(written).not.toContain("manual");
  });
});

describe("all four home_carousel_* tables' CHECK constraints are fully inventoried (completeness guard — catches a third drift instance)", () => {
  it("baseline + fix migrations declare exactly these named CHECK constraints per table", () => {
    const expected: Record<(typeof HOME_CAROUSEL_TABLES)[number], string[]> = {
      home_carousel_manual_slot: ["carousel_manual_position_check", "carousel_manual_window_check"],
      home_carousel_auto_batch: ["home_carousel_auto_batch_status_check"],
      home_carousel_auto_candidate: ["carousel_candidate_rank_check"],
      home_carousel_serving: ["home_carousel_serving_source_check", "carousel_serving_position_check"],
    };
    for (const table of HOME_CAROUSEL_TABLES) {
      const names = new Set([
        ...checkConstraintNamesForTable(baselineMigration, table),
        ...checkConstraintNamesForTable(fixMigration, table),
      ]);
      expect([...names].sort(), `CHECK constraints on "${table}"`).toEqual([...expected[table]].sort());
    }
  });

  it("worker/handlers/home-carousel.ts never writes to any of the four home_carousel_* tables directly — it only delegates to computeHomeCarouselInTx's protectedWrite closure. If this ever changes, the write-site literal guards above (scoped to service.ts only) must be extended to scan this file too", () => {
    for (const delegate of ["homeCarouselManualSlot", "homeCarouselAutoBatch", "homeCarouselAutoCandidate", "homeCarouselServing"]) {
      expect(workerHandler).not.toContain(`${delegate}.`);
    }
  });
});
