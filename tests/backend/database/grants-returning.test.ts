import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const grants = readFileSync(resolve(root, "infra/postgres/grants.sql"), "utf8");
const schemaSource = readFileSync(resolve(root, "prisma/schema.prisma"), "utf8");

/**
 * Grants-RETURNING audit (X8 轮 2c 实证): `computeHomeCarouselInTx`
 * (`src/server/home-carousel/service.ts`, reached only via `worker/handlers/
 * home-carousel.ts`) failed in production with `permission denied for table
 * home_carousel_change_log` on its `homeCarouselChangeLog.create()` call.
 * Root cause: `infra/postgres/grants.sql` gave `worker_app` INSERT but no
 * SELECT on that table, and Prisma's `.create()`/`.update()`/`.upsert()`/
 * `.delete()` always compile to SQL carrying an implicit `RETURNING <every
 * scalar column of the model>` unless the call site passes its own narrower
 * `select` -- PostgreSQL checks SELECT privilege on every RETURNING column,
 * not just the columns the statement actually writes. A role with INSERT
 * but zero SELECT on the target table cannot execute a bare `.create()` at
 * all: the very first row fails and rolls back the whole transaction.
 *
 * This file is a general, self-updating guard against the same shape of
 * gap recurring anywhere in `worker_app`'s or `scheduler_app`'s real
 * (executed) Prisma write surface -- not a one-off pin on
 * `home_carousel_change_log`. It:
 *
 *   1. Parses `infra/postgres/grants.sql` into a per-role
 *      table -> {select, insert, update, delete} map (table-level and
 *      column-scoped GRANTs both count as "has SELECT" -- this guard only
 *      cares whether SELECT exists at all on the table, not which columns;
 *      a column-scoped SELECT that is missing just one RETURNING column is
 *      a real but separate risk this file does not attempt to catch).
 *   2. Walks the real import graph starting from every file under
 *      `worker/` (`worker_app`'s entrypoint set) -- not a hand-maintained
 *      file list -- resolving relative imports and the `@/*` -> `src/*`
 *      tsconfig alias, so a new file added to worker's call graph is
 *      picked up automatically. (`scheduler_app`'s write surface is
 *      covered separately below; see the "Scoped to worker_app only"
 *      paragraph.)
 *   3. Scans every reachable file for `<prismaAccessor>.create(` /
 *      `.update(` / `.upsert(` / `.delete(` / `.createManyAndReturn(` --
 *      `createMany`/`updateMany`/`deleteMany` are deliberately excluded:
 *      Prisma does not attach a RETURNING clause to those (the driver's
 *      `rowCount` answers `{count}` directly), so they carry none of this
 *      risk.
 *   4. Asserts every table any such call site's accessor maps to (via
 *      `prisma/schema.prisma`'s own `@@map`) has `select: true` for that
 *      role in the grants.sql parse from step 1.
 *
 * Distinguishes from the existing grants guards in this directory:
 * `active-locales-grants.test.ts` checks `scheduler_app`'s *column*-level
 * completeness for one specific read path (`queryActiveLocales`);
 * `carousel-grants.test.ts` pins the exact grant text for the home-carousel
 * feature's five tables. Neither one is about RETURNING, and neither
 * generalizes past the tables/roles it names. This file is the general
 * "write implies SELECT" invariant, computed fresh from the real code and
 * the real grants file every run.
 *
 * Scoped to `worker_app` only, deliberately: a plain file-level BFS (no
 * per-declaration slicing) is precise there -- every table it flags below
 * really is written by worker-reachable code, confirmed against the full
 * audit in this change's construction-order report, zero false positives.
 * The same file-level BFS over `scheduler/` produces one false positive
 * (`operation_audit`, via `src/server/home-carousel/service.ts`'s
 * `updateHomeCarouselConfig`/`upsertHomeCarouselManualSlot` -- web_app-only
 * functions that merely happen to share a file with the `getHomeCarouselConfig`
 * export `scheduler/index.ts` actually imports) because Prisma call sites in
 * a file scheduler reaches are not necessarily on a code path scheduler's
 * `main()` itself executes. Fixing that precisely needs per-declaration
 * import-name slicing (a full mini bundler's worth of work: default/
 * namespace imports, `export { x } from` re-export chains through barrel
 * files, `as` aliasing) that `active-locales-grants.test.ts` already built
 * and hand-verified for exactly this purpose on scheduler's *read* surface
 * (`SCHEDULER_PRISMA_SURFACE`). Duplicating that machinery here for the
 * write side would violate this task's own "not overlapping" instruction
 * for no new coverage: scheduler_app's actual write surface is `schedule_run`/
 * `cron_run`/`generic_task`/`generic_task_item` only (`src/lib/tasks/
 * scheduler.ts`, invoked from `scheduler/index.ts`'s `main()` via
 * `enqueueScheduledTask`/`runSchedulerOnce`), and grants.sql already
 * self-grants scheduler_app `SELECT, INSERT, UPDATE` on exactly those four
 * tables in one statement -- confirmed by manual audit (this change's
 * report), not by an automated scan here.
 */

// ---------------------------------------------------------------------------
// grants.sql parsing: role -> table -> which of SELECT/INSERT/UPDATE/DELETE
// ---------------------------------------------------------------------------

interface TableAccess {
  select: boolean;
  insert: boolean;
  update: boolean;
  delete: boolean;
}

function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

/** role -> table -> access. Handles both `GRANT <privs> ON TABLE <t1, t2, ...> TO <roles>;` and the column-scoped `GRANT <privs> (<cols>) ON <table> TO <roles>;` shape -- both span multiple lines in this file, so this operates on the whole (comment-stripped) document, not line-by-line. */
function parseGrantsByRole(sql: string): Map<string, Map<string, TableAccess>> {
  const clean = stripSqlComments(sql);
  const byRole = new Map<string, Map<string, TableAccess>>();

  function access(role: string, table: string): TableAccess {
    let roleMap = byRole.get(role);
    if (!roleMap) {
      roleMap = new Map();
      byRole.set(role, roleMap);
    }
    let entry = roleMap.get(table);
    if (!entry) {
      entry = { select: false, insert: false, update: false, delete: false };
      roleMap.set(table, entry);
    }
    return entry;
  }

  function apply(privilegesRaw: string, tables: string[], rolesRaw: string) {
    const privileges = privilegesRaw
      .split(",")
      .map((p) => p.trim().toUpperCase())
      .filter(Boolean);
    const roles = rolesRaw
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
    for (const role of roles) {
      for (const table of tables) {
        const entry = access(role, table);
        if (privileges.includes("SELECT")) entry.select = true;
        if (privileges.includes("INSERT")) entry.insert = true;
        if (privileges.includes("UPDATE")) entry.update = true;
        if (privileges.includes("DELETE")) entry.delete = true;
      }
    }
  }

  // Column-scoped: GRANT <privs> (<cols...>) ON <table> TO <roles>;
  const columnRe = /GRANT\s+([A-Za-z, ]+?)\s*\([^)]*\)\s+ON\s+(\w+)\s+TO\s+([\w, ]+?);/g;
  let match: RegExpExecArray | null;
  while ((match = columnRe.exec(clean))) {
    apply(match[1]!, [match[2]!], match[3]!);
  }

  // Table-level: GRANT <privs> ON TABLE <t1, t2, ...> TO <roles>;
  const tableRe = /GRANT\s+([A-Za-z, ]+?)\s+ON\s+TABLE\s+([\s\S]+?)\s+TO\s+([\w, ]+?);/g;
  while ((match = tableRe.exec(clean))) {
    const tables = match[2]!
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    apply(match[1]!, tables, match[3]!);
  }

  return byRole;
}

const grantsByRole = parseGrantsByRole(grants);

function hasSelect(role: string, table: string): boolean {
  return grantsByRole.get(role)?.get(table)?.select === true;
}
function hasAnyWrite(role: string, table: string): boolean {
  const entry = grantsByRole.get(role)?.get(table);
  return entry !== undefined && (entry.insert || entry.update || entry.delete);
}

// ---------------------------------------------------------------------------
// Prisma model accessor (camelCase) -> physical table name, from schema.prisma's own `@@map`.
// ---------------------------------------------------------------------------

function parseModelTableMap(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const modelRe = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  let match: RegExpExecArray | null;
  while ((match = modelRe.exec(source))) {
    const modelName = match[1]!;
    const body = match[2]!;
    const mapMatch = body.match(/@@map\("(\w+)"\)/);
    if (!mapMatch) continue;
    const accessor = modelName.charAt(0).toLowerCase() + modelName.slice(1);
    map.set(accessor, mapMatch[1]!);
  }
  return map;
}

const modelTableMap = parseModelTableMap(schemaSource);

// ---------------------------------------------------------------------------
// Import-graph reachability: which files does each process's entrypoint set
// actually pull in, following relative imports and the `@/*` -> `src/*` alias?
// ---------------------------------------------------------------------------

const RESOLUTION_SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

function resolveImport(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) {
    base = resolve(root, "src", spec.slice(2));
  } else if (spec.startsWith(".")) {
    base = resolve(dirname(fromFile), spec);
  } else {
    return null; // bare/npm/node: specifier -- external, not part of this process's own source
  }
  for (const suffix of RESOLUTION_SUFFIXES) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const IMPORT_SPEC_RE = /(?:from|import)\s+["']([^"']+)["']/g;

function listTsFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFilesRecursive(full));
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".test.tsx")) {
      out.push(full);
    }
  }
  return out;
}

/** BFS over the real import graph starting from every non-test file directly under `rootDirs`. Deliberately does not stop at package boundaries other than skipping non-relative/non-`@/` specifiers (npm packages, `node:*` builtins) -- anything this process's own source can reach is in scope. */
function reachableFiles(rootDirs: string[]): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [];
  for (const dir of rootDirs) queue.push(...listTsFilesRecursive(resolve(root, dir)));
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    let m: RegExpExecArray | null;
    IMPORT_SPEC_RE.lastIndex = 0;
    while ((m = IMPORT_SPEC_RE.exec(source))) {
      const resolved = resolveImport(file, m[1]!);
      if (resolved && !visited.has(resolved)) queue.push(resolved);
    }
  }
  return visited;
}

const WRITE_METHODS = "create|update|upsert|delete|createManyAndReturn";

/** Every table any reachable file writes via a bare `.create(`/`.update(`/`.upsert(`/`.delete(`/`.createManyAndReturn(` -- `updateMany`/`createMany`/`deleteMany` never match here (see header comment) because the method-name alternation requires `\s*\(` immediately after the literal method name, and `updateMany(`/`createMany(`/`deleteMany(` all have extra characters (`Many`) between the method name and `(`. */
function detectWriteTables(files: Set<string>): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const [accessor, table] of modelTableMap) {
      const re = new RegExp(`\\b${accessor}\\s*\\.\\s*(?:${WRITE_METHODS})\\s*\\(`);
      if (re.test(source)) {
        if (!result.has(table)) result.set(table, new Set());
        result.get(table)!.add(file);
      }
    }
  }
  return result;
}

const workerFiles = reachableFiles(["worker"]);
const workerWrites = detectWriteTables(workerFiles);

describe("grants.sql RETURNING invariant: any table a role writes via create/update/upsert/delete must carry SELECT for that role", () => {
  it("worker_app's real (imported) Prisma write surface is non-trivial -- sanity check that the import-graph walk actually found something", () => {
    // If this collapses to zero, the BFS/regex above broke silently
    // (e.g. a tsconfig alias change) and every assertion below would pass
    // vacuously. `promoLink`/`operationAudit` are long-standing worker
    // writes untouched by this fix, cheap to pin as a canary.
    expect(workerWrites.get("promo_link")?.size ?? 0).toBeGreaterThan(0);
    expect(workerWrites.get("operation_audit")?.size ?? 0).toBeGreaterThan(0);
  });

  it("worker_app has SELECT on every table its real code creates/updates/upserts/deletes", () => {
    for (const [table, evidence] of workerWrites) {
      expect(
        hasSelect("worker_app", table),
        `worker_app's reachable code calls create/update/upsert/delete on "${table}" (e.g. ${[...evidence][0]}) but infra/postgres/grants.sql grants worker_app no SELECT there -- Prisma's implicit RETURNING will fail with "permission denied for table ${table}" on the very first such call`,
      ).toBe(true);
    }
  });

  it("scheduler_app's own known write surface (schedule_run/cron_run/generic_task/generic_task_item, self-granted in one statement) has SELECT -- narrow, hand-verified pin; see header comment for why this file does not BFS-scan scheduler/ generically", () => {
    for (const table of ["schedule_run", "cron_run", "generic_task", "generic_task_item"]) {
      expect(hasAnyWrite("scheduler_app", table), `scheduler_app is expected to have INSERT/UPDATE on "${table}"`).toBe(true);
      expect(hasSelect("scheduler_app", table), `scheduler_app is expected to have SELECT on "${table}"`).toBe(true);
    }
  });

  it("locks in the X8-confirmed fix: worker_app now has SELECT alongside its existing INSERT/UPDATE on the seven tables the full-repo audit found (home_carousel_change_log, indexnow_outbox, indexnow_outbox_attempt, tracking_event, schedule_run, cron_run, article_template)", () => {
    for (const table of [
      "home_carousel_change_log",
      "indexnow_outbox",
      "indexnow_outbox_attempt",
      "tracking_event",
      "schedule_run",
      "cron_run",
      "article_template",
    ]) {
      expect(hasAnyWrite("worker_app", table), `worker_app is expected to already have INSERT/UPDATE on "${table}"`).toBe(true);
      expect(hasSelect("worker_app", table), `worker_app is expected to now have SELECT on "${table}"`).toBe(true);
    }
  });

  it("confirms the two currently-live worker_app call sites this fix unblocks are still detected by the scan (home_carousel_change_log via computeHomeCarouselInTx, indexnow_outbox/indexnow_outbox_attempt via the delivery handler)", () => {
    expect(workerWrites.has("home_carousel_change_log"), "expected computeHomeCarouselInTx's homeCarouselChangeLog.create() to be reachable from worker/").toBe(true);
    expect(workerWrites.has("indexnow_outbox"), "expected indexnow-delivery.ts's indexNowOutbox.update() to be reachable from worker/").toBe(true);
    expect(workerWrites.has("indexnow_outbox_attempt"), "expected indexnow-delivery.ts's indexNowOutboxAttempt.create() to be reachable from worker/").toBe(true);
  });
});
