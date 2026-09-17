import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// Gate 5 review fix (P1-3/P1-4): infra/postgres/init-roles.sh appends a
// pg_hba.conf replication rule for backup_role during initdb (once, on a
// brand-new PGDATA). Two bugs fixed here: (1) a pg_hba.conf whose last line
// lacked a trailing newline would get the new rule glued onto the end of
// that line, producing a syntactically broken file; (2) the rule is now
// scoped to $X8_RUNTIME_SUBNET instead of always the hard-coded default.
// The append logic itself lives in infra/postgres/hba-replication-rule.sh,
// split out specifically so it can be exercised here without a live
// psql/PGDATA -- init-roles.sh's other statements all depend on both.
const root = process.cwd();
const scriptPath = path.resolve(root, "infra/postgres/hba-replication-rule.sh");
const scriptSource = readFileSync(scriptPath, "utf8");

const createdDirs: string[] = [];
function mkTestDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0, createdDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runAppend(hbaFile: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    "bash",
    ["-c", 'source "$1"; x8_append_hba_replication_rule "$2"', "_", scriptPath, hbaFile],
    { env: { ...process.env, ...env }, encoding: "utf8" },
  );
}

describe("hba-replication-rule.sh: static contracts", () => {
  it("is syntactically valid bash", () => {
    execFileSync("bash", ["-n", scriptPath]);
  });

  it("constructs the rule shape from X8_RUNTIME_SUBNET with the documented default, scoped to backup_role/replication only", () => {
    expect(scriptSource).toMatch(
      /hba_rule="host replication backup_role \$\{X8_RUNTIME_SUBNET:-172\.18\.0\.0\/16\} scram-sha-256"/,
    );
    expect(scriptSource).not.toMatch(/replication all /);
    expect(scriptSource).not.toMatch(/\ball all\b/);
  });

  it("guards against a missing trailing newline before appending", () => {
    expect(scriptSource).toContain('[ -z "$(tail -c1 "$hba_file")" ] || echo >>"$hba_file"');
  });
});

describe("hba-replication-rule.sh: x8_append_hba_replication_rule() behaviour", () => {
  it("appends the rule on its own line even when the file has no trailing newline", () => {
    const dir = mkTestDir("hba-rule-no-trailing-nl-");
    const hbaFile = path.join(dir, "pg_hba.conf");
    writeFileSync(hbaFile, "local all all trust"); // deliberately no trailing newline

    const result = runAppend(hbaFile);
    expect(result.status, result.stderr).toBe(0);
    const content = readFileSync(hbaFile, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    expect(lines).toEqual([
      "local all all trust",
      "host replication backup_role 172.18.0.0/16 scram-sha-256",
    ]);
  });

  it("does not disturb a file that already ends with a newline", () => {
    const dir = mkTestDir("hba-rule-trailing-nl-");
    const hbaFile = path.join(dir, "pg_hba.conf");
    writeFileSync(hbaFile, "local all all trust\n# a comment\n");

    const result = runAppend(hbaFile);
    expect(result.status, result.stderr).toBe(0);
    const content = readFileSync(hbaFile, "utf8");
    expect(content).toBe(
      "local all all trust\n# a comment\nhost replication backup_role 172.18.0.0/16 scram-sha-256\n",
    );
  });

  it("is idempotent: running twice appends exactly one rule line", () => {
    const dir = mkTestDir("hba-rule-idempotent-");
    const hbaFile = path.join(dir, "pg_hba.conf");
    writeFileSync(hbaFile, "local all all trust\n");

    expect(runAppend(hbaFile).status).toBe(0);
    expect(runAppend(hbaFile).status).toBe(0);
    const content = readFileSync(hbaFile, "utf8");
    const ruleLines = content
      .split("\n")
      .filter((l) => l === "host replication backup_role 172.18.0.0/16 scram-sha-256");
    expect(ruleLines).toHaveLength(1);
  });

  it("respects X8_RUNTIME_SUBNET when set", () => {
    const dir = mkTestDir("hba-rule-subnet-");
    const hbaFile = path.join(dir, "pg_hba.conf");
    writeFileSync(hbaFile, "local all all trust\n");

    const result = runAppend(hbaFile, { X8_RUNTIME_SUBNET: "10.99.0.0/16" });
    expect(result.status, result.stderr).toBe(0);
    const content = readFileSync(hbaFile, "utf8");
    expect(content).toContain("host replication backup_role 10.99.0.0/16 scram-sha-256");
    expect(content).not.toContain("172.18.0.0/16");
  });

  it("is a no-op (not an error) when the pg_hba.conf file does not exist yet", () => {
    const dir = mkTestDir("hba-rule-missing-file-");
    const hbaFile = path.join(dir, "pg_hba.conf");

    const result = runAppend(hbaFile);
    expect(result.status, result.stderr).toBe(0);
  });

  it("never emits an unscoped replication or all/all rule for any subnet input", () => {
    const dir = mkTestDir("hba-rule-scope-check-");
    const hbaFile = path.join(dir, "pg_hba.conf");
    writeFileSync(hbaFile, "local all all trust\n");
    mkdirSync(dir, { recursive: true });

    runAppend(hbaFile, { X8_RUNTIME_SUBNET: "10.0.0.0/8" });
    const content = readFileSync(hbaFile, "utf8");
    const ruleLine = content.split("\n").find((l) => l.startsWith("host replication"));
    expect(ruleLine).toMatch(/^host replication backup_role \d+\.\d+\.\d+\.\d+\/\d+ scram-sha-256$/);
  });
});
