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
 * gap recurring anywhere in `worker_app`'s, `web_app`'s, or `scheduler_app`'s
 * real (executed) Prisma write surface -- not a one-off pin on
 * `home_carousel_change_log`. It:
 *
 *   1. Parses `infra/postgres/grants.sql` into a per-role
 *      table -> {select, insert, update, delete} map (table-level and
 *      column-scoped GRANTs both count as "has SELECT" -- this guard only
 *      cares whether SELECT exists at all on the table, not which columns;
 *      a column-scoped SELECT that is missing just one RETURNING column is
 *      a real but separate risk this file does not attempt to catch).
 *   2. Walks the real import graph starting from every file under
 *      `worker/` (`worker_app`'s entrypoint set) -- and, in the second
 *      `describe` block below, from every file under `src/app/(admin)/`
 *      and `src/app/api/admin/` (`web_app`'s Server Action / route entrypoint
 *      set, i.e. everything Next.js can reach for the admin surface) -- not
 *      a hand-maintained file list -- resolving relative imports and the
 *      `@/*` -> `src/*` tsconfig alias, so a new file added to either call
 *      graph is picked up automatically. (`scheduler_app`'s write surface is
 *      covered separately below; see the "Scoped to worker_app and web_app,
 *      not scheduler_app" paragraph.)
 *   3. Scans every reachable file for `<prismaAccessor>.create(` /
 *      `.update(` / `.upsert(` / `.delete(` / `.createManyAndReturn(` --
 *      `createMany`/`updateMany`/`deleteMany` are deliberately excluded:
 *      Prisma does not attach a RETURNING clause to those (the driver's
 *      `rowCount` answers `{count}` directly), so they carry none of this
 *      risk.
 *   4. Asserts every table any such call site's accessor maps to (via
 *      `prisma/schema.prisma`'s own `@@map`) has `select: true` for that
 *      role in the grants.sql parse from step 1. For `web_app` the second
 *      `describe` block also asserts `hasAnyWrite` (INSERT/UPDATE/DELETE --
 *      whichever the role already needs, matching the `hasAnyWrite` helper
 *      the `scheduler_app` narrow pin below already established) is `true`,
 *      not just SELECT -- `web_app`'s write surface was largely ungranted
 *      before this file's own follow-up fix (`home_carousel_change_log` had
 *      SELECT but no INSERT; the three `article_novel_rebind_*` tables had
 *      neither), so checking SELECT alone would have passed vacuously on
 *      exactly the gaps this change closes.
 *
 * Distinguishes from the existing grants guards in this directory:
 * `active-locales-grants.test.ts` checks `scheduler_app`'s *column*-level
 * completeness for one specific read path (`queryActiveLocales`);
 * `carousel-grants.test.ts` pins the exact grant text for the home-carousel
 * feature's five tables. Neither one is about RETURNING, and neither
 * generalizes past the tables/roles it names. This file is the general
 * "write implies (SELECT, and for web_app also the matching write grant)"
 * invariant, computed fresh from the real code and the real grants file
 * every run.
 *
 * Scoped to `worker_app` and `web_app`, not `scheduler_app`, deliberately: a
 * plain file-level BFS (no per-declaration slicing) is precise for the first
 * two -- every table either flags below really is written by that role's
 * reachable code -- but each has exactly one documented false positive from
 * the same underlying limitation (a shared file pulls in a Prisma call site
 * that belongs to a *different* process's function, not the scanning
 * process's own):
 *   - `worker_app` via `scheduler/`: `operation_audit`, via
 *     `src/server/home-carousel/service.ts`'s `updateHomeCarouselConfig`/
 *     `upsertHomeCarouselManualSlot` -- web_app-only functions that merely
 *     happen to share a file with the `getHomeCarouselConfig` export
 *     `scheduler/index.ts` actually imports. (This is why `scheduler_app`
 *     itself is not BFS-scanned at all below -- see the next paragraph.)
 *   - `web_app` via `src/app/(admin)/home-carousel/`: `home_carousel_auto_batch`
 *     (and, for the same reason, `home_carousel_auto_candidate`/
 *     `home_carousel_serving`, except those two are never flagged in the
 *     first place because their only writes are `createMany`/`deleteMany`,
 *     outside this file's scanned method set), via
 *     `src/server/home-carousel/service.ts`'s `computeHomeCarouselInTx` --
 *     reachable ONLY from `worker/handlers/home-carousel.ts`'s
 *     `createHomeCarouselHandler`, never from any `web_app`-callable export
 *     in the same file (confirmed: `grep -rl computeHomeCarouselInTx src/
 *     worker/ scheduler/` returns only `service.ts`'s own definition and
 *     `worker/handlers/home-carousel.ts`'s call site). See
 *     `WEB_APP_WRITE_EXEMPTIONS` below for the registered, reasoned
 *     exemption (explicit per this task's own instruction not to silently
 *     skip a false positive).
 * Fixing either precisely needs per-declaration import-name slicing (a full
 * mini bundler's worth of work: default/namespace imports, `export { x }
 * from` re-export chains through barrel files, `as` aliasing) that
 * `active-locales-grants.test.ts` already built and hand-verified for
 * exactly this purpose on scheduler's *read* surface
 * (`SCHEDULER_PRISMA_SURFACE`). Duplicating that machinery here would
 * violate this task's own "not overlapping" instruction for no new
 * coverage: `scheduler_app`'s actual write surface is `schedule_run`/
 * `cron_run`/`generic_task`/`generic_task_item` only (`src/lib/tasks/
 * scheduler.ts`, invoked from `scheduler/index.ts`'s `main()` via
 * `enqueueScheduledTask`/`runSchedulerOnce`), and grants.sql already
 * self-grants scheduler_app `SELECT, INSERT, UPDATE` on exactly those four
 * tables in one statement -- confirmed by manual audit (this change's
 * report), not by an automated scan here. `article_novel_rebind_batch_item`
 * gets the same narrow-pin treatment for a different reason: every write to
 * it in this repo is `createMany`/`updateMany` (never bare `create`/
 * `update`), which this file's BFS deliberately never flags (see point 3
 * above) -- so it needs a hand-verified pin, not because a shared-file BFS
 * false positive needs suppressing, but because the BFS's own method scope
 * has nothing to say about it either way.
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

// ---------------------------------------------------------------------------
// web_app coverage (grants-returning follow-up, X8 轮 2c 后续): same BFS +
// scan machinery as worker_app above, rooted at web_app's own entrypoint set
// instead of worker/'s.
// ---------------------------------------------------------------------------

/**
 * `src/app/(admin)/**` (Server Actions and pages under the admin route
 * group) and `src/app/api/admin/**` (admin API routes, including
 * `_lib/deps.ts`'s shared `prisma` client every action above imports) are
 * together `web_app`'s complete reachable-from-a-request entrypoint set for
 * the admin surface -- there is no third directory a Next.js admin request
 * can start from. Both root dirs are walked by the same `reachableFiles`
 * BFS `workerFiles` above uses; nothing about the BFS itself is web_app-
 * specific.
 */
const webAppFiles = reachableFiles(["src/app/(admin)", "src/app/api/admin"]);
const webAppWrites = detectWriteTables(webAppFiles);

/**
 * Registered, reasoned exemptions for tables the BFS above flags as
 * "web_app-reachable write" that are not actually written by web_app --
 * per this task's own instruction, false positives are declared here with
 * a reason, never silently filtered out inline. Each entry is checked
 * against the live scan below (not just declared and forgotten): the test
 * suite asserts the table really is present in `webAppWrites` (so a
 * stale/no-longer-applicable exemption would itself go red) and that
 * `web_app` truly holds no write grant on it (so the exemption cannot mask
 * a real, since-introduced gap).
 */
const WEB_APP_WRITE_EXEMPTIONS: ReadonlyArray<{ readonly table: string; readonly reason: string }> = [
  {
    table: "home_carousel_auto_batch",
    reason:
      "src/server/home-carousel/service.ts is imported by web_app's src/app/(admin)/home-carousel/_actions.ts " +
      "(for updateHomeCarouselConfig/upsertHomeCarouselManualSlot/deleteHomeCarouselManualSlot/enqueueHomeCarouselCompute), " +
      "but the file's only .update() call on home_carousel_auto_batch (its .create() became .createMany() in the X8 轮 2d ⑥ " +
      "fix -- createMany is outside this file's WRITE_METHODS scan, see the header comment -- so only .update() is still " +
      "detected here at all) lives inside computeHomeCarouselInTx (service.ts, a worker-only function), reachable ONLY " +
      "from worker/handlers/home-carousel.ts's createHomeCarouselHandler. No web_app-callable export in this file ever " +
      "calls computeHomeCarouselInTx -- confirmed by `grep -rl computeHomeCarouselInTx src/ worker/ scheduler/`, which " +
      "returns only service.ts's own definition and worker/handlers/home-carousel.ts's call site. web_app correctly " +
      "holds no INSERT/UPDATE grant on this table (grants.sql's home_carousel_auto_batch INSERT/UPDATE is worker_app-only); " +
      "this is a file-level-BFS false positive, the same class of gap as the operation_audit/scheduler_app false positive " +
      "documented in this file's header comment.",
  },
];
const webAppExemptTables = new Set(WEB_APP_WRITE_EXEMPTIONS.map((e) => e.table));

describe("grants.sql RETURNING invariant, web_app entrypoints (src/app/(admin)/** + src/app/api/admin/**)", () => {
  it("web_app's real (imported) Prisma write surface is non-trivial -- sanity check that the import-graph walk actually found something", () => {
    // Same canary shape as the worker_app sanity check above: `article` and
    // `generic_task` are long-standing, unrelated-to-this-fix web_app
    // writes (article CRUD, task-admin enqueueing), cheap to pin so a
    // silently-broken BFS/regex (e.g. a tsconfig alias change, or the
    // `(admin)` route-group directory getting renamed) can't make every
    // assertion below pass vacuously.
    expect(webAppWrites.get("article")?.size ?? 0).toBeGreaterThan(0);
    expect(webAppWrites.get("generic_task")?.size ?? 0).toBeGreaterThan(0);
  });

  it("web_app has both SELECT and its matching INSERT/UPDATE/DELETE grant on every non-exempt table its real code creates/updates/upserts/deletes", () => {
    for (const [table, evidence] of webAppWrites) {
      if (webAppExemptTables.has(table)) continue;
      expect(
        hasSelect("web_app", table),
        `web_app's reachable code calls create/update/upsert/delete on "${table}" (e.g. ${[...evidence][0]}) but infra/postgres/grants.sql grants web_app no SELECT there -- Prisma's implicit RETURNING will fail with "permission denied for table ${table}" on the very first such call`,
      ).toBe(true);
      expect(
        hasAnyWrite("web_app", table),
        `web_app's reachable code calls create/update/upsert/delete on "${table}" (e.g. ${[...evidence][0]}) but infra/postgres/grants.sql grants web_app no INSERT/UPDATE/DELETE there at all -- the write itself, not just its RETURNING clause, will fail with "permission denied for table ${table}"`,
      ).toBe(true);
    }
  });

  it("every declared web_app write exemption is a live, correctly-reasoned false positive -- not stale, and not masking a real gap", () => {
    for (const { table, reason } of WEB_APP_WRITE_EXEMPTIONS) {
      expect(webAppWrites.has(table), `exemption for "${table}" is declared but the BFS no longer flags it at all -- the exemption is stale and should be removed (reason on file: ${reason})`).toBe(true);
      expect(hasAnyWrite("web_app", table), `exemption for "${table}" assumes web_app has no write grant there, but grants.sql now grants one -- either the exemption is obsolete (promote it to a real assertion) or this is a genuine new gap (reason on file: ${reason})`).toBe(false);
    }
  });

  it("locks in this follow-up's two fixes: web_app now has INSERT on home_carousel_change_log, and SELECT+INSERT+UPDATE+DELETE (per-table, matching the real call graph) on the three article_novel_rebind_* tables", () => {
    expect(hasSelect("web_app", "home_carousel_change_log"), "web_app already had SELECT on home_carousel_change_log before this follow-up").toBe(true);
    expect(hasAnyWrite("web_app", "home_carousel_change_log"), "web_app is expected to now have INSERT on home_carousel_change_log").toBe(true);

    for (const table of ["article_novel_rebind_preview", "article_novel_rebind_batch"]) {
      expect(hasSelect("web_app", table), `web_app is expected to now have SELECT on ${table}`).toBe(true);
      expect(hasAnyWrite("web_app", table), `web_app is expected to now have a write grant on ${table}`).toBe(true);
    }
    // article_novel_rebind_preview: create() + deleteMany() only, no update().
    expect(grantsByRole.get("web_app")?.get("article_novel_rebind_preview")?.insert).toBe(true);
    expect(grantsByRole.get("web_app")?.get("article_novel_rebind_preview")?.delete).toBe(true);
    expect(grantsByRole.get("web_app")?.get("article_novel_rebind_preview")?.update).toBe(false);
    // article_novel_rebind_batch: create() + updateMany() only, no delete().
    expect(grantsByRole.get("web_app")?.get("article_novel_rebind_batch")?.insert).toBe(true);
    expect(grantsByRole.get("web_app")?.get("article_novel_rebind_batch")?.update).toBe(true);
    expect(grantsByRole.get("web_app")?.get("article_novel_rebind_batch")?.delete).toBe(false);
  });

  it("confirms the live call sites this follow-up unblocks are still detected by the scan (home_carousel_change_log via upsertHomeCarouselManualSlot/deleteHomeCarouselManualSlot, article_novel_rebind_preview via buildRebindBatchPreview, article_novel_rebind_batch via submitRebindBatch)", () => {
    expect(webAppWrites.has("home_carousel_change_log"), "expected upsertHomeCarouselManualSlot's/deleteHomeCarouselManualSlot's homeCarouselChangeLog.create() to be reachable from src/app/(admin)/").toBe(true);
    expect(webAppWrites.has("article_novel_rebind_preview"), "expected buildRebindBatchPreview's articleNovelRebindPreview.create() to be reachable from src/app/(admin)/").toBe(true);
    expect(webAppWrites.has("article_novel_rebind_batch"), "expected submitRebindBatch's articleNovelRebindBatch.create() to be reachable from src/app/(admin)/").toBe(true);
  });

  it("article_novel_rebind_batch_item: narrow, hand-verified pin -- every write to it (createMany/updateMany only, batch.ts:237,319,351,374,391) is outside this file's BFS-scanned method set (see header comment), so it needs the same treatment as scheduler_app's known write surface above, not a BFS assertion", () => {
    expect(hasSelect("web_app", "article_novel_rebind_batch_item"), "web_app is expected to have SELECT on article_novel_rebind_batch_item").toBe(true);
    expect(grantsByRole.get("web_app")?.get("article_novel_rebind_batch_item")?.insert, "web_app is expected to have INSERT on article_novel_rebind_batch_item (createMany at batch.ts:237)").toBe(true);
    expect(grantsByRole.get("web_app")?.get("article_novel_rebind_batch_item")?.update, "web_app is expected to have UPDATE on article_novel_rebind_batch_item (updateMany at batch.ts:319,351,374,391)").toBe(true);
    expect(grantsByRole.get("web_app")?.get("article_novel_rebind_batch_item")?.delete, "article_novel_rebind_batch_item has no delete call site anywhere in this repo -- web_app should not have DELETE here").toBe(false);
  });

  it("web_app's analyst_ro-parity SELECT convention holds for the three article_novel_rebind_* tables, matching every other web_app-owned business table in this file", () => {
    for (const table of ["article_novel_rebind_preview", "article_novel_rebind_batch", "article_novel_rebind_batch_item"]) {
      expect(hasSelect("analyst_ro", table), `analyst_ro is expected to have SELECT on ${table}, matching web_app's SELECT there`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// X8 轮 2d ⑦ follow-up: per-method precision, web_app only. `hasAnyWrite`
// above is deliberately coarse (true if the role holds ANY of INSERT/UPDATE/
// DELETE on the table) -- which is exactly why it did NOT catch the pre-fix
// `updateHomeCarouselConfig`'s `tx.siteSetting.upsert(...)`: web_app holds
// column-scoped UPDATE (not INSERT) on `site_setting`
// (`infra/postgres/grants.sql`'s "SiteSetting boundary" block --
// INSERT/DELETE are `migration_owner`-only there by design), so
// `hasAnyWrite("web_app", "site_setting")` was, and still is, `true` --
// `upsert` compiles to `INSERT ... ON CONFLICT (id) DO UPDATE`, which
// PostgreSQL rejects for lack of INSERT privilege even though the statement
// almost always resolves as an UPDATE. X8 reproduced `permission denied for
// table site_setting` against the real role. This block re-scans web_app's
// write surface at per-method granularity -- a bare `.create(`/`.upsert(`
// call site requires INSERT specifically, `.update(` requires UPDATE
// specifically, `.delete(` requires DELETE specifically -- matching what
// Postgres itself checks for each statement shape, not just "some write
// privilege exists somewhere on this table". Every existing assertion above
// (including `hasAnyWrite`'s own tests) is unchanged; this is a narrower,
// additional invariant layered on the same `webAppFiles` BFS and the same
// `WEB_APP_WRITE_EXEMPTIONS` registry, not a replacement.
// ---------------------------------------------------------------------------

type WebAppWriteMethod = "create" | "update" | "upsert" | "delete";

/** `upsert`/`create` need INSERT (Postgres's `ON CONFLICT` clause is still an INSERT statement at heart); `update` needs UPDATE; `delete` needs DELETE. */
const REQUIRED_GRANT_FOR_METHOD: Record<WebAppWriteMethod, keyof TableAccess> = {
  create: "insert",
  upsert: "insert",
  update: "update",
  delete: "delete",
};

/**
 * Same accessor/table map and same `\b<accessor>\s*\.\s*<method>\s*\(`
 * boundary discipline `detectWriteTables` above documents (so
 * `siteSetting.update(` is found while `siteSetting.updateMany(` is not),
 * but keyed by (table, method) instead of just table -- this is what lets
 * the assertion below require the *specific* privilege each method shape
 * actually needs, instead of `hasAnyWrite`'s "some write privilege" check.
 */
function detectWriteMethodsByTable(files: Set<string>): Map<string, Map<WebAppWriteMethod, Set<string>>> {
  const result = new Map<string, Map<WebAppWriteMethod, Set<string>>>();
  const methods: WebAppWriteMethod[] = ["create", "update", "upsert", "delete"];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const [accessor, table] of modelTableMap) {
      for (const method of methods) {
        const re = new RegExp(`\\b${accessor}\\s*\\.\\s*${method}\\s*\\(`);
        if (!re.test(source)) continue;
        if (!result.has(table)) result.set(table, new Map());
        const byMethod = result.get(table)!;
        if (!byMethod.has(method)) byMethod.set(method, new Set());
        byMethod.get(method)!.add(file);
      }
    }
  }
  return result;
}

const webAppWriteMethods = detectWriteMethodsByTable(webAppFiles);

/**
 * Method-scoped false positives -- separate from `WEB_APP_WRITE_EXEMPTIONS`
 * above (which asserts the *table* has no write grant at all: not true here,
 * `side_effect_intent` legitimately carries a column-scoped web_app UPDATE
 * grant, so it doesn't belong in that list — reusing it would make the
 * "hasAnyWrite must be false" check in that list's own verification test
 * fail for a table that correctly has a grant, just not the INSERT this one
 * unreachable-from-web_app method would need).
 */
const WEB_APP_METHOD_EXEMPTIONS: ReadonlyArray<{ readonly table: string; readonly method: WebAppWriteMethod; readonly reason: string }> = [
  {
    table: "side_effect_intent",
    method: "create",
    reason:
      "src/server/home-carousel/service.ts imports `@/lib/tasks` (the barrel src/lib/tasks/index.ts, for " +
      "enqueueScheduledTask/ScheduleDefinition/ScheduledTaskInput/TaskHandlerRegistry) and that barrel " +
      "`export * from`s every sibling module, side-effect-intent.ts included -- so this file's whole-file-reachability " +
      "BFS (not per-export slicing; see header comment) treats sideEffectIntent.create() (prepareSideEffectIntent, " +
      "side-effect-intent.ts:64) as web_app-reachable even though no web_app-callable export anywhere under " +
      "src/app/(admin)/** or src/app/api/admin/** ever calls prepareSideEffectIntent -- confirmed by " +
      "`grep -rl prepareSideEffectIntent src/ worker/`, which returns only side-effect-intent.ts's own definition, " +
      "its barrel re-export (src/lib/tasks/index.ts), and worker/handlers/promo-link-claim.ts's real call site. " +
      "web_app correctly holds no INSERT on side_effect_intent (X9 Task Admin, database-governance.md §12: " +
      "'Web 仅获得 side_effect_intent(status,response_shape,confirmed_at) 列级 UPDATE' -- creation is worker-only, via " +
      "prepareSideEffectIntent inside worker/handlers/promo-link-claim.ts); this is the same shared-file BFS false " +
      "positive class as the home_carousel_auto_batch/operation_audit exemptions above, just reached through a barrel " +
      "export instead of a directly shared file. Unrelated to this task's own ⑥/⑦ fix -- surfaced only because this " +
      "block's per-method precision is strictly narrower than `hasAnyWrite` above (side_effect_intent's existing " +
      "column-scoped UPDATE already satisfied hasAnyWrite, masking this gap from the coarser check).",
  },
];
const webAppMethodExempt = new Set(WEB_APP_METHOD_EXEMPTIONS.map((e) => `${e.table}::${e.method}`));

describe("grants.sql per-method invariant (web_app): create/upsert need INSERT, update needs UPDATE, delete needs DELETE -- catches a wrong-verb call site hasAnyWrite cannot (X8 轮 2d ⑦)", () => {
  it("site_setting regression pin: web_app holds UPDATE but not INSERT there -- the exact grant shape that let the pre-fix siteSetting.upsert() reach production undetected by hasAnyWrite alone", () => {
    expect(grantsByRole.get("web_app")?.get("site_setting")?.update).toBe(true);
    expect(grantsByRole.get("web_app")?.get("site_setting")?.insert).toBe(false);
  });

  it("web_app's real code holds the exact grant each write method it calls actually needs, for every (table, method) pair the BFS finds (excluding the same table-level exemptions registered above, plus the method-scoped exemptions registered just below)", () => {
    for (const [table, byMethod] of webAppWriteMethods) {
      if (webAppExemptTables.has(table)) continue;
      for (const [method, evidence] of byMethod) {
        if (webAppMethodExempt.has(`${table}::${method}`)) continue;
        const requiredPriv = REQUIRED_GRANT_FOR_METHOD[method];
        const entry = grantsByRole.get("web_app")?.get(table);
        expect(
          entry?.[requiredPriv] === true,
          `web_app's reachable code calls .${method}( on "${table}" (e.g. ${[...evidence][0]}) but infra/postgres/grants.sql grants web_app no ${requiredPriv.toUpperCase()} there -- PostgreSQL will reject this exact statement shape with "permission denied for table ${table}" even though hasAnyWrite() may report some other write privilege exists`,
        ).toBe(true);
      }
    }
  });

  it("every declared method-scoped exemption is live and not masking a real gap: the (table, method) pair is still detected, and web_app still holds no matching grant for it", () => {
    for (const { table, method, reason } of WEB_APP_METHOD_EXEMPTIONS) {
      expect(webAppWriteMethods.get(table)?.has(method), `exemption for "${table}"::"${method}" is declared but the BFS no longer flags it at all -- the exemption is stale and should be removed (reason on file: ${reason})`).toBe(true);
      const requiredPriv = REQUIRED_GRANT_FOR_METHOD[method];
      expect(grantsByRole.get("web_app")?.get(table)?.[requiredPriv] === true, `exemption for "${table}"::"${method}" assumes web_app has no ${requiredPriv.toUpperCase()} there, but grants.sql now grants one -- either the exemption is obsolete (promote it to a real assertion) or this is a genuine new gap (reason on file: ${reason})`).toBe(false);
    }
  });

  it("confirms updateHomeCarouselConfig's fixed call site is still detected as .update( (not .upsert() any more) against site_setting", () => {
    expect(webAppWriteMethods.get("site_setting")?.has("update"), "expected updateHomeCarouselConfig's tx.siteSetting.update(...) to be reachable from src/app/(admin)/").toBe(true);
    expect(webAppWriteMethods.get("site_setting")?.has("upsert"), "site_setting should have no remaining .upsert( call site anywhere in web_app's reachable code").toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Owner-approved 窄范围修复 lane (2026-09-11, "施工工单_Withdraw-UI-Guard-与-
// Takedown-Grants"): statement-level bulk-method invariant, both processes.
// `createMany`/`updateMany`/`deleteMany` are exactly the three method names
// `WRITE_METHODS`/`detectWriteTables` above and `REQUIRED_GRANT_FOR_METHOD`/
// `detectWriteMethodsByTable` just above this block both deliberately never
// match (their regexes require the bare method name immediately followed by
// `\s*\(`, and `createMany(`/`updateMany(`/`deleteMany(` all have the extra
// "Many" text in between) -- because none of the three carry an implicit
// RETURNING clause (the driver's `rowCount` answers `{count}` directly, see
// this file's header comment), so neither guard above's SELECT/verb-specific
// privilege check has anything to say about them. That is a real, separate
// risk layer PostgreSQL still enforces: the base UPDATE/INSERT/DELETE
// *statement* privilege, independent of RETURNING.
//
// `applyNovelRightsTransition`'s takedown branch
// (`src/server/publish-gate/service.ts:763-786`), inside the same
// `$transaction` that flips Novel/Article status, chunks every
// non-withdrawn `NovelChapter` and per chunk runs
// `tx.novelChapterContent.deleteMany({ where: { novelChapterId: { in:
// idChunk } } })` followed by `tx.novelChapter.updateMany({ where: { id: {
// in: idChunk } }, data: { status: "withdrawn" } })` -- reached only via
// `web`'s `takedownNovelAction -> takedownNovel -> applyNovelRightsTransition`
// (`grep -rn "takedownNovel|applyNovelRightsTransition" src worker scheduler`
// returns zero worker/scheduler references), i.e. `web_app`'s shared
// PrismaClient. `web_app` had SELECT on both tables but no UPDATE on
// `novel_chapter` and no DELETE on `novel_chapter_content` (the latter was
// `worker_app`-only) -- Owner-reported UI symptom was a permanently
// "处理中" withdraw dialog; the underlying backend symptom, confirmed
// read-only against X8 uat before the `infra/postgres/grants.sql` fix
// above, was `42501 permission denied for table novel_chapter` on the first
// chunk of any takedown of a published Novel with chapters. This block is
// the general, self-updating guard against the same shape recurring
// anywhere in either process's real bulk-write surface -- not a one-off pin
// on these two tables (the mutation this block is built to catch, per this
// lane's own work order, is exactly "add a `.deleteMany(` in web-reachable
// code against a table with no DELETE grant").
// ---------------------------------------------------------------------------

type BulkWriteMethod = "createMany" | "updateMany" | "deleteMany";

/** `createMany` needs INSERT, `updateMany` needs UPDATE, `deleteMany` needs DELETE -- the base statement privilege each compiles to, independent of any RETURNING clause (none of the three ever carry one). */
const REQUIRED_GRANT_FOR_BULK_METHOD: Record<BulkWriteMethod, keyof TableAccess> = {
  createMany: "insert",
  updateMany: "update",
  deleteMany: "delete",
};

/**
 * Same accessor/table map and file set as `detectWriteMethodsByTable` above,
 * but scanning for the three bulk method names that function's own regex
 * (and `detectWriteTables`'s) structurally excludes -- see this block's
 * header comment for why. Deliberately its own function rather than a
 * parameterized reuse of `detectWriteMethodsByTable`: that function's
 * `WebAppWriteMethod` type and this one's `BulkWriteMethod` type are
 * disjoint on purpose (a `.create(` and a `.createMany(` are different SQL
 * shapes requiring the same privilege for different reasons -- INSERT
 * either way, but one carries RETURNING and one does not), and keeping the
 * two scans separate keeps each one's regex simple and easy to audit against
 * its own header comment.
 */
function detectBulkWriteMethodsByTable(files: Set<string>): Map<string, Map<BulkWriteMethod, Set<string>>> {
  const result = new Map<string, Map<BulkWriteMethod, Set<string>>>();
  const methods: BulkWriteMethod[] = ["createMany", "updateMany", "deleteMany"];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const [accessor, table] of modelTableMap) {
      for (const method of methods) {
        const re = new RegExp(`\\b${accessor}\\s*\\.\\s*${method}\\s*\\(`);
        if (!re.test(source)) continue;
        if (!result.has(table)) result.set(table, new Map());
        const byMethod = result.get(table)!;
        if (!byMethod.has(method)) byMethod.set(method, new Set());
        byMethod.get(method)!.add(file);
      }
    }
  }
  return result;
}

// Reuses `workerFiles`/`webAppFiles` (the same BFS results the two guards
// above already computed) -- both processes, per this lane's own work order
// ("按既有 BFS import 图对 worker_app 与 web_app 两进程判定").
const workerBulkWriteMethods = detectBulkWriteMethodsByTable(workerFiles);
const webAppBulkWriteMethods = detectBulkWriteMethodsByTable(webAppFiles);

/**
 * Registered false positives -- the bulk-method scan's own version of
 * `WEB_APP_WRITE_EXEMPTIONS`/`WEB_APP_METHOD_EXEMPTIONS` above, same
 * "declare with a reason, verify it stays live" discipline, but keyed by
 * (table, bulkMethod) because a table can be a false positive for one bulk
 * method and a genuine hit for another (not the case for any entry below
 * today, but the shape should not assume otherwise). All four entries here
 * share one root cause already established by `WEB_APP_WRITE_EXEMPTIONS`'s
 * `home_carousel_auto_batch` entry above: every one of these bulk calls
 * lives inside `computeHomeCarouselInTx` (`src/server/home-carousel/
 * service.ts:81-199`), reachable ONLY from `worker/handlers/
 * home-carousel.ts`'s `createHomeCarouselHandler` -- independently
 * re-verified for this lane (not assumed from the earlier exemption):
 * `grep -rl computeHomeCarouselInTx src/ worker/ scheduler/` returns three
 * files -- `service.ts` (its own definition), `worker/handlers/
 * home-carousel.ts` (the one real call site), and `src/domain/
 * database-statuses.ts` (mentions the function only in doc-comment prose at
 * lines 94 and 349, confirmed by `grep -n computeHomeCarouselInTx
 * src/domain/database-statuses.ts` -- neither line calls it). That last file
 * is exactly why `home_carousel_serving`/`home_carousel_auto_candidate` are
 * flagged as web_app-reachable at all: it is walked by the same BFS (it is
 * `@/domain/database-statuses`, imported by web_app-reachable files) and
 * its prose happens to name the two tables' bulk methods in passing.
 */
const WEB_APP_BULK_METHOD_EXEMPTIONS: ReadonlyArray<{ readonly table: string; readonly method: BulkWriteMethod; readonly reason: string }> = [
  {
    table: "home_carousel_serving",
    method: "createMany",
    reason:
      "tx.homeCarouselServing.createMany(...) (service.ts:193) lives inside computeHomeCarouselInTx, worker-only " +
      "reachable (see this block's header comment for the independently-reverified grep). web_app correctly holds no " +
      "INSERT on home_carousel_serving (grants.sql grants it worker_app-only INSERT/UPDATE and, separately, DELETE).",
  },
  {
    table: "home_carousel_serving",
    method: "deleteMany",
    reason:
      "tx.homeCarouselServing.deleteMany(...) (service.ts:192) -- same computeHomeCarouselInTx call, same table, " +
      "same reasoning as the createMany entry directly above.",
  },
  {
    table: "home_carousel_auto_batch",
    method: "createMany",
    reason:
      "tx.homeCarouselAutoBatch.createMany(...) (service.ts:136) -- same computeHomeCarouselInTx root cause as this " +
      "table's existing WEB_APP_WRITE_EXEMPTIONS entry above (that entry's own text notes the table's `.create()` " +
      "call became `.createMany()` in an earlier round, which is exactly why this block's bulk-specific scan flags " +
      "it again under a different method name than that entry covers).",
  },
  {
    table: "home_carousel_auto_candidate",
    method: "createMany",
    reason:
      "tx.homeCarouselAutoCandidate.createMany(...) (service.ts:186) -- same computeHomeCarouselInTx call, same " +
      "root cause as the three entries above; this table has no other write call site anywhere in this repo.",
  },
];
const webAppBulkMethodExempt = new Set(WEB_APP_BULK_METHOD_EXEMPTIONS.map((e) => `${e.table}::${e.method}`));

/**
 * `worker_app`'s own false-positive registry for this block -- first needed
 * here; the two RETURNING-era `worker_app` guards above (`describe` block at
 * the top of this file) had zero false positives at the time they were
 * written, so no such list existed for that role before this lane.
 */
const WORKER_APP_BULK_METHOD_EXEMPTIONS: ReadonlyArray<{ readonly table: string; readonly method: BulkWriteMethod; readonly reason: string }> = [
  {
    table: "site_setting",
    method: "updateMany",
    reason:
      "worker/handlers/indexnow-delivery.ts imports only getIndexNowDeliveryConfig and isIndexNowConfigured from " +
      "src/server/site-settings/service.ts (grep -n \"site-settings/service\" worker/handlers/indexnow-delivery.ts " +
      "confirms exactly those two named imports, nothing else) -- never updateAdminSiteSetting, whose own " +
      "tx.siteSetting.updateMany(...) (service.ts:605) is this table's only bulk write call site in the whole repo. " +
      "grep -rn updateAdminSiteSetting src confirms its only caller is src/app/api/admin/site-settings/route.ts " +
      "(web_app). Same shared-file BFS false-positive class as this file's other exemptions above -- a file-level " +
      "walk cannot see that worker only imports two of this file's many exports.",
  },
];
const workerBulkMethodExempt = new Set(WORKER_APP_BULK_METHOD_EXEMPTIONS.map((e) => `${e.table}::${e.method}`));

/**
 * Genuine, independently-verified, OUT-OF-SCOPE gaps this block's
 * construction newly surfaced -- deliberately NOT filed as false positives
 * above (the call sites really are worker_app-reachable and grants.sql
 * really grants nothing matching; masking that as a "false positive" would
 * misrepresent a real risk as verified-safe). Both predate and are
 * unrelated to this lane's own novel-takedown fix, and this lane's own
 * Owner-approved scope is explicit ("仅收 confirmWithdraw/
 * runRightsTransition ... 以及已实证的 takedown grants 与 *Many 守卫；不要扩成
 * 全局 stale Server Action 基础设施改造") -- fixing either would need its own
 * column-level verification and read-only repro against a real gap this
 * lane did not set out to find. Reported via spawn_task instead of being
 * silently left for a future scan to rediscover from scratch; each entry's
 * liveness is still self-checked below (same discipline as the false-
 * positive registries) so this list cannot silently mask a fix that already
 * landed, nor quietly expand to cover an unrelated new gap under the same
 * excuse.
 */
const WORKER_APP_BULK_METHOD_KNOWN_GAPS: ReadonlyArray<{ readonly table: string; readonly method: BulkWriteMethod; readonly reason: string }> = [
  {
    table: "novel_canonical_tag",
    method: "deleteMany",
    reason:
      "worker/handlers/novel-tag-backfill.ts imports replaceAutoTagSnapshotInTransaction " +
      "(src/server/tagging/service.ts), whose own tx.novelCanonicalTag.deleteMany({ where: { novelId, " +
      "source: \"auto\" } }) (service.ts:425) worker_app has never held DELETE for -- only INSERT/UPDATE " +
      "(grants.sql's worker_app INSERT,UPDATE list) and SELECT. web_app's own two deleteMany call sites on this " +
      "table (service.ts:302,352, source:\"manual\", inside replaceManualTagSnapshot/exitManualTagMode) are " +
      "unaffected -- web_app already holds table-level DELETE there. Pre-existing, unrelated to novel takedown.",
  },
  {
    table: "indexnow_outbox_attempt",
    method: "updateMany",
    reason:
      "worker/handlers/indexnow-delivery.ts's own indexNowOutboxAttempt.updateMany(...) (line 210) -- worker_app " +
      "has only ever held INSERT on this table (grants.sql's worker_app INSERT-only list; the X8 轮 2c RETURNING " +
      "audit documented in this file's header comment and database-governance.md only added SELECT alongside it, " +
      "never checked this separate bulk-method statement-privilege layer because that guard did not exist yet). " +
      "Pre-existing, unrelated to novel takedown.",
  },
];
const workerBulkKnownGaps = new Set(WORKER_APP_BULK_METHOD_KNOWN_GAPS.map((e) => `${e.table}::${e.method}`));

describe("grants.sql bulk-method invariant (createMany/updateMany/deleteMany, worker_app + web_app): no implicit RETURNING, but PostgreSQL still enforces the base INSERT/UPDATE/DELETE statement privilege", () => {
  it("both processes' real (imported) bulk-write surface is non-trivial -- sanity check that the scan actually found something, on top of the non-bulk canaries above", () => {
    // novel_chapter::updateMany (worker, via src/lib/preview/changdu-materialization.ts)
    // and article_novel_rebind_batch::updateMany (web_app, via
    // src/server/article-rebind/batch.ts) are long-standing, already-granted
    // writes untouched by this lane -- cheap canaries so a silently-broken
    // scan (e.g. a tsconfig alias change) can't make every assertion below
    // pass vacuously.
    expect(workerBulkWriteMethods.get("novel_chapter")?.get("updateMany")?.size ?? 0).toBeGreaterThan(0);
    expect(webAppBulkWriteMethods.get("article_novel_rebind_batch")?.get("updateMany")?.size ?? 0).toBeGreaterThan(0);
  });

  it("worker_app holds the exact grant every non-exempt, non-deferred (table, bulkMethod) pair its real code calls actually needs", () => {
    for (const [table, byMethod] of workerBulkWriteMethods) {
      for (const [method, evidence] of byMethod) {
        const key = `${table}::${method}`;
        if (workerBulkMethodExempt.has(key) || workerBulkKnownGaps.has(key)) continue;
        const requiredPriv = REQUIRED_GRANT_FOR_BULK_METHOD[method];
        const entry = grantsByRole.get("worker_app")?.get(table);
        expect(
          entry?.[requiredPriv] === true,
          `worker_app's reachable code calls .${method}( on "${table}" (e.g. ${[...evidence][0]}) but infra/postgres/grants.sql grants worker_app no ${requiredPriv.toUpperCase()} there -- PostgreSQL will reject this exact statement with "permission denied for table ${table}" even though it carries no RETURNING clause`,
        ).toBe(true);
      }
    }
  });

  it("web_app holds the exact grant every non-exempt, non-deferred (table, bulkMethod) pair its real code calls actually needs", () => {
    for (const [table, byMethod] of webAppBulkWriteMethods) {
      for (const [method, evidence] of byMethod) {
        const key = `${table}::${method}`;
        if (webAppBulkMethodExempt.has(key)) continue;
        const requiredPriv = REQUIRED_GRANT_FOR_BULK_METHOD[method];
        const entry = grantsByRole.get("web_app")?.get(table);
        expect(
          entry?.[requiredPriv] === true,
          `web_app's reachable code calls .${method}( on "${table}" (e.g. ${[...evidence][0]}) but infra/postgres/grants.sql grants web_app no ${requiredPriv.toUpperCase()} there -- PostgreSQL will reject this exact statement with "permission denied for table ${table}" even though it carries no RETURNING clause`,
        ).toBe(true);
      }
    }
  });

  it("locks in this lane's own fix: web_app now holds column-scoped UPDATE(status, updated_at) on novel_chapter and table-level DELETE on novel_chapter_content, and nothing broader", () => {
    expect(grantsByRole.get("web_app")?.get("novel_chapter")?.update, "web_app is expected to now have UPDATE on novel_chapter").toBe(true);
    expect(grantsByRole.get("web_app")?.get("novel_chapter")?.insert, "web_app should not have INSERT on novel_chapter -- chapters are worker-materialized, takedown never creates one").toBe(false);
    expect(grantsByRole.get("web_app")?.get("novel_chapter")?.delete, "web_app should not have DELETE on novel_chapter -- takedown withdraws the row via UPDATE, it never deletes it").toBe(false);
    expect(grants).toMatch(/GRANT UPDATE \(status, updated_at\) ON novel_chapter TO web_app;/);

    expect(grantsByRole.get("web_app")?.get("novel_chapter_content")?.delete, "web_app is expected to now have DELETE on novel_chapter_content").toBe(true);
    expect(grantsByRole.get("web_app")?.get("novel_chapter_content")?.insert, "web_app should not have INSERT on novel_chapter_content -- content is worker-materialized, takedown never creates one").toBe(false);
    expect(grantsByRole.get("web_app")?.get("novel_chapter_content")?.update, "web_app should not have UPDATE on novel_chapter_content -- takedown only deletes rows, it never edits body/metadata in place").toBe(false);
    expect(grants).toMatch(/GRANT DELETE ON TABLE novel_chapter_content TO web_app;/);

    // worker_app's pre-existing DELETE on novel_chapter_content (PR6 lane E)
    // must stay untouched by this lane.
    expect(grantsByRole.get("worker_app")?.get("novel_chapter_content")?.delete, "this lane must not touch worker_app's existing DELETE on novel_chapter_content").toBe(true);
  });

  it("confirms applyNovelRightsTransition's takedown call sites are still detected by the scan (novel_chapter::updateMany and novel_chapter_content::deleteMany, both via src/server/publish-gate/service.ts, web_app-reachable)", () => {
    expect(webAppBulkWriteMethods.get("novel_chapter")?.has("updateMany"), "expected applyNovelRightsTransition's tx.novelChapter.updateMany(...) to be reachable from src/app/(admin)/ + src/app/api/admin/").toBe(true);
    expect(webAppBulkWriteMethods.get("novel_chapter_content")?.has("deleteMany"), "expected applyNovelRightsTransition's tx.novelChapterContent.deleteMany(...) to be reachable from src/app/(admin)/ + src/app/api/admin/").toBe(true);
  });

  it("every declared web_app bulk-method exemption is live and not masking a real gap", () => {
    for (const { table, method, reason } of WEB_APP_BULK_METHOD_EXEMPTIONS) {
      expect(webAppBulkWriteMethods.get(table)?.has(method), `exemption for "${table}"::"${method}" is declared but the scan no longer flags it -- stale, should be removed (reason on file: ${reason})`).toBe(true);
      const requiredPriv = REQUIRED_GRANT_FOR_BULK_METHOD[method];
      expect(grantsByRole.get("web_app")?.get(table)?.[requiredPriv] === true, `exemption for "${table}"::"${method}" assumes web_app has no ${requiredPriv.toUpperCase()} there, but grants.sql now grants one -- either promote it to a real assertion or this is a genuine new gap (reason on file: ${reason})`).toBe(false);
    }
  });

  it("every declared worker_app bulk-method exemption is live and not masking a real gap", () => {
    for (const { table, method, reason } of WORKER_APP_BULK_METHOD_EXEMPTIONS) {
      expect(workerBulkWriteMethods.get(table)?.has(method), `exemption for "${table}"::"${method}" is declared but the scan no longer flags it -- stale, should be removed (reason on file: ${reason})`).toBe(true);
      const requiredPriv = REQUIRED_GRANT_FOR_BULK_METHOD[method];
      expect(grantsByRole.get("worker_app")?.get(table)?.[requiredPriv] === true, `exemption for "${table}"::"${method}" assumes worker_app has no ${requiredPriv.toUpperCase()} there, but grants.sql now grants one -- either promote it to a real assertion or this is a genuine new gap (reason on file: ${reason})`).toBe(false);
    }
  });

  it("every declared worker_app deferred (out-of-scope, spawn_task-tracked) gap is still live -- not stale (already fixed elsewhere) and not silently widened", () => {
    for (const { table, method, reason } of WORKER_APP_BULK_METHOD_KNOWN_GAPS) {
      expect(workerBulkWriteMethods.get(table)?.has(method), `deferred gap for "${table}"::"${method}" is declared but the scan no longer flags it -- either already fixed (remove this entry) or the scan regressed (reason on file: ${reason})`).toBe(true);
      const requiredPriv = REQUIRED_GRANT_FOR_BULK_METHOD[method];
      expect(grantsByRole.get("worker_app")?.get(table)?.[requiredPriv] === true, `deferred gap for "${table}"::"${method}" is declared unresolved, but grants.sql now grants ${requiredPriv.toUpperCase()} there -- this entry is stale, remove it and let the main loop assert it directly (reason on file: ${reason})`).toBe(false);
    }
  });
});
