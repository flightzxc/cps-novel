import { readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const text = (relative: string) => readFile(path.join(root, relative), "utf8");

// database.sh's own comments legitimately spell out "-U migration_owner" and
// "x8_restore_grants_for_running_release" BY NAME, in prose, precisely to
// explain why the real code does neither (this work order explicitly asked
// for both explanations). A plain substring search over the whole file
// would therefore always find them and could never fail even if someone
// later added a real (non-commented) second invocation. Strip comment-only
// lines first so these assertions check the executable shape, not prose.
//
// Strips BOTH shell "#" comments (used outside the DO $$ heredoc) AND SQL
// "--" comments (used inside it, e.g. the prose above
// verify_database_privileges()'s enumeration loops). Review MAJOR-4a: the
// PRIVILEGE_CHECK_FAILED reason= tokens asserted later in this file used to
// be checked against the RAW file text, so a mutation that deletes a whole
// enumeration loop (has_table_privilege calls, RAISE EXCEPTION, all of it)
// while leaving behind a "--" comment that merely names the same reason
// string still passed 12/12 -- the reviewer reproduced this. Stripping both
// comment styles before matching closes that gap; blank lines are also
// dropped since nothing downstream depends on them.
const stripComments = (source: string) =>
  source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith("#") && !trimmed.startsWith("--");
    })
    .join("\n");

// Review MAJOR-4a, part 2: stripping comments defeats a mutation that
// leaves the reason string ONLY inside a comment, but a bare
// `executable.toContain("reason=X")` on the comment-stripped text would
// still pass if someone kept the literal reason token in some inert,
// unreachable spot (a stray string, a different RAISE branch, ...) without
// the real guarding construct. This targets the actual SQL: it requires (a)
// a real, non-commented `RAISE EXCEPTION ... reason=<reason>` line, AND (b)
// the specific has_table_privilege/has_sequence_privilege/has_schema_privilege
// call (and, for the enumeration checks, the FOR/FOREACH loop header) that
// must immediately guard it, within a bounded window of the lines
// immediately preceding that RAISE EXCEPTION in the comment-stripped
// verify_database_privileges() body. 12 lines is generous headroom: the
// largest real gap between a guard's opening construct and its RAISE
// EXCEPTION in the current source is 9 lines (role_has_zero_table_privileges
// and web_app_missing_admin_auth_privilege).
const assertReasonBackedBySql = (
  executableLines: string[],
  reason: string,
  constructs: RegExp[],
  label: string,
) => {
  const raiseIdx = executableLines.findIndex(
    (line) => line.includes("RAISE EXCEPTION") && line.includes(`reason=${reason}`),
  );
  expect(
    raiseIdx,
    `expected a non-commented "RAISE EXCEPTION ... reason=${reason}" line in verify_database_privileges()`,
  ).toBeGreaterThanOrEqual(0);
  const windowStart = Math.max(0, raiseIdx - 12);
  const block = executableLines.slice(windowStart, raiseIdx + 1).join("\n");
  for (const construct of constructs) {
    expect(
      block,
      `expected ${label} to guard reason=${reason}; searched (comment-stripped):\n${block}`,
    ).toMatch(construct);
  }
};

/**
 * docs/governance/database-governance.md:433 requires infra/postgres/
 * grants.sql to be replayed after every migration. The mature X8 path
 * (scripts/x8-production-like.sh prepare_database(), X8_DB_PREP_STEP=grants)
 * already did this; scripts/preproduction/database.sh's migrate-approved
 * case never did, leaving every runtime role at zero table privileges the
 * moment a migration ran (measured on the real host: web_app and
 * backup_role each had SELECT on 0 of 54 tables). This suite is a static
 * contract over database.sh's text -- it proves the fix's SHAPE (ordering,
 * flags, role, no silent auto-recovery); the real behavioral proof against
 * a live PostgreSQL 16.14 is scripts/run-preprod-db-contract-verification.sh,
 * not this file (a green string match here is not evidence the SQL actually
 * works -- see that script's own header comment).
 */
describe("preproduction database.sh: grants replay contract (migrate-approved)", () => {
  it("replays grants.sql AFTER prisma migrate deploy succeeds and BEFORE the case ends", async () => {
    const source = await text("scripts/preproduction/database.sh");
    const caseStart = source.indexOf("migrate-approved)");
    expect(caseStart).toBeGreaterThan(0);
    const caseEnd = source.indexOf("\n  *) usage ;;", caseStart);
    expect(caseEnd).toBeGreaterThan(caseStart);
    const caseBody = source.slice(caseStart, caseEnd);

    const migrateIndex = caseBody.indexOf("prisma migrate deploy");
    expect(migrateIndex).toBeGreaterThan(0);
    // Task 1 explicitly keeps `echo "DATABASE_MIGRATION=PASS"` where it
    // already was -- immediately after migrate deploy succeeds, BEFORE the
    // grants replay -- rather than moving it after the new step. The grants
    // replay itself must still land after migrate deploy and before the
    // case closes (`;;`).
    const migrationPassIndex = caseBody.indexOf('echo "DATABASE_MIGRATION=PASS"');
    expect(migrationPassIndex).toBeGreaterThan(migrateIndex);

    const grantsInvocationIndex = caseBody.indexOf("psql --no-psqlrc -v ON_ERROR_STOP=1 --single-transaction");
    expect(grantsInvocationIndex, `no grants replay invocation found in migrate-approved case:\n${caseBody}`).toBeGreaterThan(migrationPassIndex);

    const grantsSqlPathIndex = caseBody.indexOf("infra/postgres/grants.sql", grantsInvocationIndex);
    expect(grantsSqlPathIndex).toBeGreaterThan(grantsInvocationIndex);

    const caseCloseIndex = caseBody.lastIndexOf(";;");
    expect(caseCloseIndex, `no closing ";;" found for the migrate-approved case:\n${caseBody}`).toBeGreaterThan(grantsSqlPathIndex);

    // DATABASE_GRANTS=PASS must be printed on the success path, after the
    // real invocation, still inside the case.
    const grantsPassIndex = caseBody.indexOf('echo "DATABASE_GRANTS=PASS"', grantsSqlPathIndex);
    expect(grantsPassIndex).toBeGreaterThan(grantsSqlPathIndex);
    expect(grantsPassIndex).toBeLessThan(caseCloseIndex);
  });

  it("the real grants invocation carries --single-transaction and -v ON_ERROR_STOP=1", async () => {
    const source = await text("scripts/preproduction/database.sh");
    const caseStart = source.indexOf("migrate-approved)");
    const grantsLineStart = source.indexOf("if ! preprod_compose exec -T postgres psql", caseStart);
    expect(grantsLineStart, "expected the real (non-echoed) grants replay invocation").toBeGreaterThan(caseStart);
    const grantsInvocation = source.slice(grantsLineStart, source.indexOf("grants.sql", grantsLineStart) + "grants.sql".length);
    expect(grantsInvocation).toContain("--single-transaction");
    expect(grantsInvocation).toContain("-v ON_ERROR_STOP=1");
  });

  it("the real grants invocation uses -U postgres -d cps_novel, never -U migration_owner", async () => {
    const source = await text("scripts/preproduction/database.sh");
    const caseStart = source.indexOf("migrate-approved)");
    const grantsLineStart = source.indexOf("if ! preprod_compose exec -T postgres psql", caseStart);
    const grantsInvocation = source.slice(grantsLineStart, source.indexOf("grants.sql", grantsLineStart) + "grants.sql".length);
    expect(grantsInvocation).toContain("-U postgres -d cps_novel");
    // database.sh's own comment legitimately spells out "-U migration_owner"
    // in prose to explain why the real invocation does NOT use it -- check
    // the executable (non-comment) shape only, so this stays a real
    // assertion rather than one that could never fail.
    expect(stripComments(source)).not.toContain("-U migration_owner");
  });

  it("never auto-replays grants a second time on the failure path (single, documented, manual recovery only)", async () => {
    const source = await text("scripts/preproduction/database.sh");
    // The only REAL (executed) invocation of the grants-replay psql command
    // anywhere in the file must be the single line inside the `if ! ...;
    // then` guard. The failure branch's recovery text also spells out the
    // same command for an operator to copy-paste, but that text lives
    // inside an `echo "..."` argument, so it can never match a pattern
    // anchored to the START of a line with `preprod_compose exec` (the
    // echoed line instead starts with `echo "DATABASE_GRANTS_RECOVERY_COMMAND=`).
    // Revert self-check: duplicating the real invocation into the failure
    // branch (i.e. actually re-running it, not just printing it) would add
    // a second line matching this pattern and turn this assertion red.
    const realInvocationLines = source.match(/^\s*(if ! )?preprod_compose exec -T postgres psql --no-psqlrc -v ON_ERROR_STOP=1 --single-transaction/gm) ?? [];
    expect(realInvocationLines, `expected exactly one real grants-replay invocation; matched lines: ${JSON.stringify(realInvocationLines)}`).toHaveLength(1);

    // The failure branch prints a REFUSED line and a recovery command, and
    // explicitly documents (in a comment) that a second replay must not
    // happen because --single-transaction already rolled back atomically.
    expect(source).toContain("DATABASE_GRANTS=REFUSED reason=grants_replay_failed");
    expect(source).toContain("DATABASE_GRANTS_RECOVERY_COMMAND=");
    expect(source).toMatch(/single-transaction means PostgreSQL has ALREADY rolled this failed/);
  });

  it("does NOT port x8_restore_grants_for_running_release (release.sh already stops services before migrating)", async () => {
    const source = await text("scripts/preproduction/database.sh");
    // The identifier legitimately appears in an explanatory comment (this
    // work order explicitly asked for one) -- what must NOT exist is a real
    // definition or call. Strip comments first.
    expect(stripComments(source)).not.toContain("x8_restore_grants_for_running_release");
    expect(source).toMatch(/Deliberately NOT porting x8_restore_grants_for_running_release/);
  });
});

describe("preproduction database.sh: DATABASE_PRIVILEGE_CHECK contract (persistent-check)", () => {
  it("persistent-check calls the privilege check and emits DATABASE_PRIVILEGE_CHECK before DATABASE_PERSISTENT_CHECK=PASS", async () => {
    const source = await text("scripts/preproduction/database.sh");
    const caseStart = source.indexOf("persistent-check)");
    expect(caseStart).toBeGreaterThan(0);
    const caseEnd = source.indexOf("\n  migrate-approved)", caseStart);
    expect(caseEnd).toBeGreaterThan(caseStart);
    const caseBody = source.slice(caseStart, caseEnd);

    const callIndex = caseBody.indexOf("verify_database_privileges");
    expect(callIndex, `expected persistent-check to call verify_database_privileges():\n${caseBody}`).toBeGreaterThan(0);

    const failEmitIndex = caseBody.indexOf("DATABASE_PRIVILEGE_CHECK=FAIL");
    expect(failEmitIndex).toBeGreaterThan(callIndex);
    const passEmitIndex = caseBody.indexOf('echo "DATABASE_PRIVILEGE_CHECK=PASS"');
    expect(passEmitIndex).toBeGreaterThan(callIndex);

    const persistentPassIndex = caseBody.lastIndexOf('echo "DATABASE_PERSISTENT_CHECK=PASS"');
    expect(persistentPassIndex, "DATABASE_PERSISTENT_CHECK=PASS must remain the case's final success line").toBeGreaterThan(passEmitIndex);
  });

  it("routes every persistent-check FAIL/REFUSED line to stderr and every PASS line to stdout", async () => {
    // verify-release.sh calls this subcommand as
    // `database.sh persistent-check >/dev/null` (lib.sh documents the same
    // rule for the app-runtime gate: "拒绝走 stderr、PASS 走 stdout"). A
    // FAIL/REFUSED line left on stdout is silently swallowed by that
    // redirect -- a real failure during `release.sh deploy` would then
    // surface to the operator as a bare non-zero exit code with no reason
    // at all. Scoped to the persistent-check case specifically: that is the
    // only subcommand any caller in this repo pipes to >/dev/null today
    // (release.sh's own `migrate-approved` call, and `fresh-init`, are not
    // redirected by anyone, so their REFUSED lines are not part of this
    // defect and are out of scope here).
    //
    // Structural, not a hardcoded list: scans every `echo "DATABASE_...="`
    // emit site in the case body via regex, so a future failure branch
    // added without `>&2` trips this even if no one remembers to update
    // this test by hand.
    const source = await text("scripts/preproduction/database.sh");
    const caseStart = source.indexOf("persistent-check)");
    const caseEnd = source.indexOf("\n  migrate-approved)", caseStart);
    const caseBody = source.slice(caseStart, caseEnd);

    const lines = caseBody.split("\n");
    const emitPattern = /echo "(DATABASE_[A-Z_]+)=(FAIL|REFUSED|PASS)\b[^"]*"/;
    let failOrRefusedCount = 0;
    let passCount = 0;
    for (const line of lines) {
      const match = line.match(emitPattern);
      if (!match) continue;
      const [, marker, kind] = match;
      if (kind === "FAIL" || kind === "REFUSED") {
        failOrRefusedCount += 1;
        expect(line, `${marker}=${kind} line must redirect to stderr (>&2): ${line.trim()}`).toContain(">&2");
      } else {
        passCount += 1;
        expect(line, `${marker}=PASS line must stay on stdout (no >&2): ${line.trim()}`).not.toContain(">&2");
      }
    }
    // Sanity: this scan must actually find the known emit sites, or the
    // pattern itself has drifted and the assertions above are vacuously
    // true. 9 FAIL/REFUSED sites: volume_missing, postgres_not_running,
    // role_auth, DATABASE_PRIVILEGE_CHECK=FAIL, DATABASE_PERSISTENT_CHECK=
    // FAIL reason=privilege_check, and the runtime replication-subnet
    // containment check's four (network_missing x2 -- network absent, and
    // network present but reporting no subnet -- hba_rule_missing,
    // subnet_not_contained). 3 PASS sites: DATABASE_PRIVILEGE_CHECK,
    // DATABASE_REPLICATION_SUBNET_CHECK, and DATABASE_PERSISTENT_CHECK.
    expect(failOrRefusedCount, "expected to find every known FAIL/REFUSED emit site in persistent-check").toBe(9);
    expect(passCount, "expected to find every known PASS emit site in persistent-check").toBe(3);
  });

  it("defines verify_database_privileges() with the exact heredoc delimiter the disposable-Postgres harness extracts", async () => {
    const source = await text("scripts/preproduction/database.sh");
    expect(source).toContain("<<'DATABASE_PRIVILEGE_CHECK_SQL'");
    expect(source).toMatch(/^DATABASE_PRIVILEGE_CHECK_SQL$/m);
    // scripts/run-preprod-db-contract-verification.sh's extraction anchor --
    // keep these in sync if the heredoc invocation line's shape ever changes.
    expect(source).toContain("-d cps_novel <<'DATABASE_PRIVILEGE_CHECK_SQL'");
  });

  it("asserts every privilege infra/postgres/grants.sql actually grants (positive and negative), backed by the real SQL construct behind each reason", async () => {
    const source = await text("scripts/preproduction/database.sh");
    const grants = await text("infra/postgres/grants.sql");
    const executableLines = stripComments(source).split("\n");

    // Positive assertions: each reason= token must be backed by its real
    // RAISE EXCEPTION plus the specific has_*_privilege construct guarding
    // it (see the block comment above verify_database_privileges() in
    // database.sh for the grants.sql line numbers backing each one).
    assertReasonBackedBySql(
      executableLines,
      "role_has_zero_table_privileges",
      [
        /FOREACH role_name IN ARRAY ARRAY\['web_app','worker_app','scheduler_app','analyst_ro','backup_role'\] LOOP/,
        /has_table_privilege\(/,
        /'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'/,
      ],
      "the 5-role zero-table-privileges FOREACH + has_table_privilege(...) call",
    );
    assertReasonBackedBySql(
      executableLines,
      "backup_role_missing_table_select",
      [
        /FOR table_name IN SELECT format\('%I\.%I', schemaname, tablename\) FROM pg_tables WHERE schemaname = 'public' LOOP/,
        /has_table_privilege\('backup_role', table_name, 'SELECT'\)/,
      ],
      "the backup_role table-enumeration loop",
    );
    assertReasonBackedBySql(
      executableLines,
      "backup_role_missing_sequence_select",
      [
        /FOR table_name IN SELECT format\('%I\.%I', schemaname, sequencename\) FROM pg_sequences WHERE schemaname = 'public' LOOP/,
        /has_sequence_privilege\('backup_role', table_name, 'SELECT'\)/,
      ],
      "the backup_role sequence-enumeration loop",
    );
    assertReasonBackedBySql(
      executableLines,
      "web_app_missing_admin_auth_privilege",
      [
        /'admin_identity','admin_session','admin_two_factor',/,
        /'admin_two_factor_challenge','admin_recovery_code','admin_login_attempt'/,
        /has_table_privilege\('web_app', format\('public\.%I', table_name\), 'SELECT'\)/,
        /has_table_privilege\('web_app', format\('public\.%I', table_name\), 'INSERT'\)/,
        /has_table_privilege\('web_app', format\('public\.%I', table_name\), 'UPDATE'\)/,
      ],
      "the web_app admin-auth SELECT+INSERT+UPDATE FOREACH",
    );
    assertReasonBackedBySql(
      executableLines,
      "web_app_missing_delete",
      [
        /FOREACH table_name IN ARRAY ARRAY\['admin_recovery_code','admin_login_attempt'\] LOOP/,
        /has_table_privilege\('web_app', format\('public\.%I', table_name\), 'DELETE'\)/,
      ],
      "the web_app DELETE-on-two-tables FOREACH",
    );
    assertReasonBackedBySql(
      executableLines,
      "web_app_missing_operation_audit_privilege",
      [
        /has_table_privilege\('web_app', 'public\.operation_audit', 'SELECT'\)/,
        /has_table_privilege\('web_app', 'public\.operation_audit', 'INSERT'\)/,
      ],
      "the operation_audit SELECT+INSERT check",
    );
    assertReasonBackedBySql(
      executableLines,
      "web_app_missing_sequence_usage",
      [
        /FOR table_name IN SELECT format\('%I\.%I', schemaname, sequencename\) FROM pg_sequences WHERE schemaname = 'public' LOOP/,
        /has_sequence_privilege\('web_app', table_name, 'USAGE'\)/,
      ],
      "the web_app sequence USAGE loop",
    );
    assertReasonBackedBySql(
      executableLines,
      "migration_owner_missing_schema_create",
      [/has_schema_privilege\('migration_owner', 'public', 'CREATE'\)/],
      "the migration_owner schema CREATE check",
    );
    // Negative assertions.
    assertReasonBackedBySql(
      executableLines,
      "web_app_unexpected_operation_audit_update",
      [/IF has_table_privilege\('web_app', 'public\.operation_audit', 'UPDATE'\) THEN/],
      "the operation_audit UPDATE negative check",
    );
    assertReasonBackedBySql(
      executableLines,
      "web_app_unexpected_operation_audit_delete",
      [/IF has_table_privilege\('web_app', 'public\.operation_audit', 'DELETE'\) THEN/],
      "the operation_audit DELETE negative check",
    );
    assertReasonBackedBySql(
      executableLines,
      "unexpected_admin_auth_select",
      [
        /FOREACH role_name IN ARRAY ARRAY\['worker_app','scheduler_app','analyst_ro'\] LOOP/,
        /has_table_privilege\(role_name, 'public\.admin_two_factor', 'SELECT'\)/,
        /has_table_privilege\(role_name, 'public\.admin_recovery_code', 'SELECT'\)/,
        /has_table_privilege\(role_name, 'public\.admin_two_factor_challenge', 'SELECT'\)/,
      ],
      "the worker/scheduler/analyst negative admin-auth SELECT FOREACH",
    );

    // Cross-check against the real grants.sql text so this suite fails
    // loudly if grants.sql's shape ever stops matching what database.sh
    // assumes, rather than silently testing stale expectations.
    expect(grants).toContain("GRANT SELECT ON ALL TABLES IN SCHEMA public TO backup_role;");
    expect(grants).toContain("GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO backup_role;");
    expect(grants).toContain(
      "GRANT SELECT ON TABLE admin_identity, admin_session, admin_two_factor,\n  admin_two_factor_challenge, admin_recovery_code, admin_login_attempt TO web_app;",
    );
    expect(grants).toContain("GRANT DELETE ON TABLE admin_recovery_code, admin_login_attempt TO web_app;");
    expect(grants).toContain("GRANT INSERT ON TABLE operation_audit TO web_app;");
    expect(grants).not.toMatch(/GRANT UPDATE[^;]*operation_audit[^;]*TO web_app/);
    expect(grants).not.toMatch(/GRANT DELETE[^;]*operation_audit[^;]*TO web_app/);
    expect(grants).toContain("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO web_app, worker_app, scheduler_app;");
    expect(grants).toContain("GRANT USAGE, CREATE ON SCHEMA public TO migration_owner;");
    // The three sensitive Admin-auth tables never appear in any GRANT other
    // than the one TO web_app block above. Split into SQL statements (on
    // ";") rather than raw lines -- the real GRANT wraps across two lines
    // (grants.sql:102-103), so a per-line check would misfire on a line
    // that names the table but not yet "web_app", which appears only on the
    // continuation line of the very same statement.
    const statements = grants.split(";");
    for (const table of ["admin_two_factor", "admin_recovery_code", "admin_two_factor_challenge"]) {
      const grantStatements = statements.filter((statement) => statement.includes("GRANT") && statement.includes(table));
      expect(grantStatements.length, `expected at least one GRANT statement touching ${table}`).toBeGreaterThan(0);
      for (const statement of grantStatements) {
        expect(statement, `unexpected extra grant touching ${table}: ${statement.trim()}`).toContain("web_app");
      }
    }
  });
});

/**
 * Cross-lane regression guard (2026-09-21 integration). The database lane
 * moved every FAIL/REFUSED reason line in database.sh's persistent-check
 * case from stdout to stderr -- scripts/preproduction/verify-release.sh:108
 * calls `database.sh persistent-check >/dev/null`, and lib.sh's own comment
 * on preprod_assert_app_runtime_immutable documents the exact same trap
 * ("拒绝走 stderr、PASS 走 stdout") for the sibling app-runtime gate. That
 * move was correct. But a PRE-EXISTING test in a DIFFERENT lane's file
 * (tests/backend/runtime/preproduction-deployment-contract.test.ts, "fails
 * the persistent path when the stable volume is absent") still asserted the
 * reason against `result.stdout`, and because each lane only ran its own
 * test file during development, the mismatch was never observed until
 * integration.
 *
 * This guard generalizes that fix into a structural regression check
 * instead of a one-off assertion patch: it reads database.sh's OWN case
 * bodies to discover, for itself, which subcommands' FAIL/REFUSED lines are
 * ALL already on stderr (today: persistent-check only -- fresh-init's
 * REFUSED lines deliberately stay on stdout, since no caller redirects that
 * subcommand's stdout; migrate-approved is a genuine MIX -- its
 * approval_required REFUSED line is un-redirected stdout by design, while
 * its grants_replay_failed REFUSED line already went to stderr before this
 * change -- and is therefore correctly left unguarded rather than guessed
 * at per-reason), then scans every tests/backend/runtime/*.test.ts file for
 * a spawnSync(...) invocation of database.sh with one of those subcommands,
 * followed by a `result.stdout).toContain("<reason>")`-shaped assertion
 * naming one of that subcommand's own stderr-only reasons. It is
 * deliberately NOT a hardcoded allowlist of today's known cases -- a future
 * subcommand added to database.sh with an all-stderr FAIL/REFUSED contract,
 * paired with a test anywhere in tests/backend/runtime/ that gets its
 * stream wrong for it, trips this without anyone updating this file by
 * hand.
 *
 * Pragmatic scope, by design: a line-window scan over spawnSync(...) call
 * TEXT, not a real JS/TS parser. It only recognizes the one call shape
 * every real spawnSync invocation of database.sh in this repo currently
 * uses -- `spawnSync("bash", [path.join(root,
 * "scripts/preproduction/database.sh"), "<subcommand>"], ...)` -- and only
 * looks for `.stdout).toContain("...")` in the text between that call and
 * the next spawnSync-of-database.sh / the next `it(` / a fixed character
 * cap, whichever comes first. "invocationsFound" below is a vacuous-pass
 * guard: if the call shape this scanner recognizes ever stops matching
 * anything real (e.g. every call site gets refactored through a shared
 * helper), that count drops to 0 and the sanity test fails loudly instead
 * of this guard silently checking nothing forever.
 */

const RUNTIME_DIR = path.join(root, "tests", "backend", "runtime");
const SELF_FILE = path.join(RUNTIME_DIR, "preproduction-database-contract.test.ts");

interface FailLine {
  content: string;
  toStderr: boolean;
}

// For every `<label>)` case in database.sh's `case "${1:-}" in ... esac`,
// collects every `echo "...=FAIL..."` / `echo "...=REFUSED..."` line in
// that case's body, and whether it redirects to stderr (`>&2` immediately
// after the closing quote, before the next `;`/newline -- database.sh's own
// style throughout every case). A label is "guarded" (returned in the map)
// only when EVERY one of its FAIL/REFUSED lines already goes to stderr --
// a label with a genuine mix (migrate-approved today) is deliberately left
// out rather than guessing which of its reasons are which.
function parseDatabaseShGuardedReasons(source: string): Map<string, Set<string>> {
  const labelRe = /^ {2}([a-zA-Z0-9_-]+)\)\s*$/gm;
  const labels: { name: string; index: number; bodyStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = labelRe.exec(source)) !== null) {
    labels.push({ name: m[1], index: m.index, bodyStart: m.index + m[0].length });
  }
  const guarded = new Map<string, Set<string>>();
  for (let i = 0; i < labels.length; i++) {
    const body = source.slice(labels[i].bodyStart, i + 1 < labels.length ? labels[i + 1].index : source.length);
    const echoRe = /echo\s+"((?:[^"\\]|\\.)*)"([^\n;]*)/g;
    const failLines: FailLine[] = [];
    let em: RegExpExecArray | null;
    while ((em = echoRe.exec(body)) !== null) {
      const content = em[1];
      if (/=(FAIL|REFUSED)\b/.test(content)) failLines.push({ content, toStderr: em[2].includes(">&2") });
    }
    if (failLines.length > 0 && failLines.every((f) => f.toStderr)) {
      const reasons = new Set<string>();
      for (const f of failLines) {
        const rm = f.content.match(/reason=([A-Za-z0-9_]+)/);
        if (rm) reasons.add(rm[1]);
      }
      guarded.set(labels[i].name, reasons);
    }
  }
  return guarded;
}

function listRuntimeTestFiles(): string[] {
  return readdirSync(RUNTIME_DIR)
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => path.join(RUNTIME_DIR, name))
    .filter((file) => file !== SELF_FILE);
}

interface StreamViolation {
  file: string;
  line: number;
  subcommand: string;
  reason: string;
  snippet: string;
}

function scanForWrongStreamAssertions(guardedReasons: Map<string, Set<string>>): {
  invocationsFound: number;
  violations: StreamViolation[];
} {
  // Matches the ONE call shape every real spawnSync-of-database.sh call in
  // this repo uses: `...database.sh"), "<subcommand>"...` (see this file's
  // header comment above on scope).
  const invokeRe = /database\.sh['"`]\s*\)\s*,\s*['"`]([a-zA-Z0-9_-]+)['"`]/g;
  let invocationsFound = 0;
  const violations: StreamViolation[] = [];
  for (const file of listRuntimeTestFiles()) {
    const raw = readFileSync(file, "utf8");
    invokeRe.lastIndex = 0;
    const matches: { index: number; subcommand: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = invokeRe.exec(raw)) !== null) matches.push({ index: m.index, subcommand: m[1] });
    invocationsFound += matches.length;

    for (let i = 0; i < matches.length; i++) {
      const { index, subcommand } = matches[i];
      const reasons = guardedReasons.get(subcommand);
      if (!reasons || reasons.size === 0) continue; // this subcommand's reasons are not (yet) an all-stderr contract.

      const nextInvokeIndex = i + 1 < matches.length ? matches[i + 1].index : raw.length;
      const nextItMatch = /\n\s*it(?:\.\w+)?\(/.exec(raw.slice(index + 1));
      const nextItIndex = nextItMatch ? index + 1 + nextItMatch.index : raw.length;
      const blockEnd = Math.min(nextInvokeIndex, nextItIndex, index + 4000, raw.length);
      const block = raw.slice(index, blockEnd);

      const stdoutAssertRe = /\.stdout\)\.toContain\(\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1\s*\)/g;
      let am: RegExpExecArray | null;
      while ((am = stdoutAssertRe.exec(block)) !== null) {
        const asserted = am[2];
        const hit = Array.from(reasons).find((r) => asserted.includes(r) || r.includes(asserted));
        if (!hit) continue;
        violations.push({
          file: file.slice(root.length + 1),
          line: raw.slice(0, index + am.index).split("\n").length,
          subcommand,
          reason: hit,
          snippet: am[0],
        });
      }
    }
  }
  return { invocationsFound, violations };
}

describe("preproduction database.sh: cross-file stdout/stderr stream guard (structural)", () => {
  it("classifies database.sh's own case labels by stream, as a floor against silent parser drift", async () => {
    const source = await text("scripts/preproduction/database.sh");
    const guarded = parseDatabaseShGuardedReasons(source);
    // Today's known shape: persistent-check is the only fully-stderr
    // FAIL/REFUSED contract. fresh-init stays fully on stdout (no caller
    // redirects it). migrate-approved is a genuine mix (approval_required
    // on stdout by design, grants_replay_failed already on stderr) and is
    // therefore correctly NOT guarded -- guessing per-reason here would risk
    // a false positive against approval_required, which must stay on stdout.
    expect(Array.from(guarded.keys())).toEqual(["persistent-check"]);
    expect(Array.from(guarded.get("persistent-check") ?? [])).toEqual(
      expect.arrayContaining([
        "volume_missing",
        "postgres_not_running",
        "role_auth",
        "privilege_check",
        "network_missing",
        "hba_rule_missing",
        "subnet_not_contained",
      ]),
    );
    expect(guarded.get("persistent-check")?.size).toBe(7);
  });

  it("scanned at least one real database.sh spawnSync call (guards against a vacuous pass)", async () => {
    const source = await text("scripts/preproduction/database.sh");
    const { invocationsFound } = scanForWrongStreamAssertions(parseDatabaseShGuardedReasons(source));
    expect(invocationsFound).toBeGreaterThan(0);
  });

  it("no test in tests/backend/runtime/*.test.ts asserts an all-stderr database.sh reason against result.stdout", async () => {
    const source = await text("scripts/preproduction/database.sh");
    const { violations } = scanForWrongStreamAssertions(parseDatabaseShGuardedReasons(source));
    expect(
      violations,
      violations
        .map(
          (v) =>
            `${v.file}:${v.line} asserts "${v.reason}" (a stderr-only database.sh ${v.subcommand} reason) ` +
            `against result.stdout instead of result.stderr -- ${v.snippet}`,
        )
        .join("\n"),
    ).toEqual([]);
  });
});
