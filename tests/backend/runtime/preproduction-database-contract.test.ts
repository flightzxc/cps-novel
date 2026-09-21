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
const stripComments = (source: string) =>
  source
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

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

  it("defines verify_database_privileges() with the exact heredoc delimiter the disposable-Postgres harness extracts", async () => {
    const source = await text("scripts/preproduction/database.sh");
    expect(source).toContain("<<'DATABASE_PRIVILEGE_CHECK_SQL'");
    expect(source).toMatch(/^DATABASE_PRIVILEGE_CHECK_SQL$/m);
    // scripts/run-preprod-db-contract-verification.sh's extraction anchor --
    // keep these in sync if the heredoc invocation line's shape ever changes.
    expect(source).toContain("-d cps_novel <<'DATABASE_PRIVILEGE_CHECK_SQL'");
  });

  it("asserts every privilege infra/postgres/grants.sql actually grants (positive and negative)", async () => {
    const source = await text("scripts/preproduction/database.sh");
    const grants = await text("infra/postgres/grants.sql");

    // Positive assertions the SQL must contain (see the block comment above
    // verify_database_privileges() in database.sh for the grants.sql line
    // numbers backing each one).
    expect(source).toContain("reason=role_has_zero_table_privileges");
    expect(source).toContain("reason=backup_role_missing_table_select");
    expect(source).toContain("reason=backup_role_missing_sequence_select");
    expect(source).toContain("reason=web_app_missing_admin_auth_privilege");
    expect(source).toContain("reason=web_app_missing_delete");
    expect(source).toContain("reason=web_app_missing_operation_audit_privilege");
    expect(source).toContain("reason=web_app_missing_sequence_usage");
    expect(source).toContain("reason=migration_owner_missing_schema_create");
    // Negative assertions.
    expect(source).toContain("reason=web_app_unexpected_operation_audit_update");
    expect(source).toContain("reason=web_app_unexpected_operation_audit_delete");
    expect(source).toContain("reason=unexpected_admin_auth_select");

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
