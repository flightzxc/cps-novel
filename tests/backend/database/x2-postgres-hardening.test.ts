import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("X2 PostgreSQL hardening contracts", () => {
  it("freezes all three runtime role timeout budgets", () => {
    const sql = read("infra/postgres/roles.sql");
    const settings = {
      web_app: ["statement_timeout = '30s'", "lock_timeout = '5s'", "idle_in_transaction_session_timeout = '60s'"],
      worker_app: ["statement_timeout = '5min'", "lock_timeout = '15s'", "idle_in_transaction_session_timeout = '5min'"],
      scheduler_app: ["statement_timeout = '1min'", "lock_timeout = '5s'", "idle_in_transaction_session_timeout = '60s'"],
    } as const;

    for (const [role, roleSettings] of Object.entries(settings)) {
      for (const setting of roleSettings) {
        expect(sql).toContain(`ALTER ROLE ${role} SET ${setting};`);
      }
    }
  });

  it("ships the frozen cluster configuration including pg_stat_statements preload", () => {
    const config = read("infra/postgres/pitr/postgresql.conf.example");
    expect(config).toMatch(/^max_connections\s*=\s*100$/m);
    expect(config).toMatch(/^log_min_duration_statement\s*=\s*500ms$/m);
    expect(config).toMatch(/^shared_preload_libraries\s*=\s*'pg_stat_statements'$/m);
    expect(config).toMatch(/^compute_query_id\s*=\s*auto$/m);
    expect(config).toMatch(/^pg_stat_statements\.track\s*=\s*all$/m);
  });

  it("documents the restart and extension activation boundary without a production claim", () => {
    const runbook = read("docs/operations/POSTGRESQL_HARDENING_RUNBOOK.md");
    expect(runbook).toContain("不是现网加载证据");
    expect(runbook).toContain("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
    expect(runbook).toContain("shared_preload_libraries");
    expect(runbook).toContain("重启 PostgreSQL");
    expect(runbook).toContain("SELECT count(*) >= 0 AS pg_stat_statements_readable FROM pg_stat_statements");
    expect(runbook).toContain("X2 开闸");
  });

  it("keeps the disposable verification script syntactically valid and self-cleaning", () => {
    const scriptPath = resolve(root, "scripts/run-x2-postgres-hardening-verification.sh");
    execFileSync("bash", ["-n", scriptPath]);
    const script = read("scripts/run-x2-postgres-hardening-verification.sh");
    expect(script).toContain("postgres:16.14");
    expect(script).toContain("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
    expect(script).toContain("X2_PRODUCTION_STATUS=CONFIGURATION_CONTRACT_ONLY");
    expect(script).toContain("DISPOSABLE_DATABASE_CLEANED=");
  });
});
