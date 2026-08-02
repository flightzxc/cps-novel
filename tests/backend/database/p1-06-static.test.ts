import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("P1-06 database operations static contracts", () => {
  it("defines exactly the five approved roles without embedded passwords", () => {
    const sql = read("infra/postgres/roles.sql");
    for (const role of ["migration_owner", "web_app", "worker_app", "analyst_ro", "backup_role"]) {
      expect(sql).toContain(`'${role}'`);
      expect(sql).toMatch(new RegExp(`ALTER ROLE ${role} WITH`));
    }
    expect(sql).toContain("ALTER ROLE analyst_ro SET statement_timeout = '30s'");
    expect(sql).toContain("ALTER ROLE analyst_ro SET default_transaction_read_only = 'on'");
    expect(sql).toMatch(/ALTER ROLE backup_role WITH[\s\S]*REPLICATION/);
    expect(sql).not.toMatch(/PASSWORD\s+['"][^'"]+/i);
    expect(sql).not.toContain("scheduler_app");
  });

  it("revokes public DDL and uses column grants for restricted data", () => {
    const sql = read("infra/postgres/grants.sql");
    expect(sql).toContain("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    expect(sql).toContain("REVOKE CREATE, TEMPORARY ON DATABASE");
    expect(sql).toContain("GRANT SELECT (\n  id, channel_account_id, credential_type");
    expect(sql).not.toMatch(/GRANT SELECT ON TABLE channel_account_credential TO (?:web_app|analyst_ro)/);
    expect(sql).toContain("GRANT SELECT ON ALL TABLES IN SCHEMA public TO worker_app, backup_role");
    expect(sql).toContain("GRANT INSERT ON TABLE operation_audit TO web_app");
    expect(sql).toContain("credential_change_log, operation_audit, indexnow_outbox_attempt");
    expect(sql).not.toMatch(/GRANT (?:UPDATE|DELETE)[^;]*operation_audit/s);
  });

  it("keeps backup and restore interfaces fail-closed", () => {
    const backup = read("scripts/db/backup-logical.sh");
    const restore = read("scripts/db/restore-logical.sh");
    expect(backup).toContain('PGUSER:-}" == "backup_role"');
    expect(backup).toContain("--format=custom");
    expect(backup).toContain("--no-acl");
    expect(backup).toContain("pg_restore --list");
    expect(restore).toContain("P1_06_ALLOW_DISPOSABLE_RESTORE");
    expect(restore).toContain("cps_novel_restore_*");
    expect(restore).toContain("--single-transaction");
    expect(restore).toContain("infra/postgres/grants.sql");
  });

  it("ships syntactically valid shell scripts and does not claim production PITR", () => {
    const scripts = [
      "scripts/db/backup-logical.sh",
      "scripts/db/restore-logical.sh",
      "scripts/db/backup-physical-base.sh",
      "scripts/db/archive-wal.sh",
      "scripts/db/restore-pitr.sh",
      "scripts/run-p1-06-postgres-verification.sh",
    ];
    for (const script of scripts) {
      execFileSync("bash", ["-n", resolve(root, script)]);
    }
    const runbook = read("docs/p1/P1_06_PITR_RUNBOOK.md");
    expect(runbook).toContain("不代表已建立生产级 PITR");
    expect(runbook).toContain("RPO 不超过 15 分钟");
    expect(runbook).toContain("RTO 不超过 4 小时");
  });

  it("preserves the 825-record dictionary", () => {
    const records = read("docs/governance/database-schema-dictionary.jsonl").trim().split("\n");
    expect(records).toHaveLength(825);
    expect(new Set(records.map((line) => JSON.parse(line).stable_key)).size).toBe(825);
  });
});
