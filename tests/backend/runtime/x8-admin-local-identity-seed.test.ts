import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const envHelper = read("scripts/lib/x8-production-like-env.sh");
const launcher = read("scripts/x8-production-like.sh");

/**
 * RC-11 — `ADMIN_LOCAL_IDENTITY_SEED` render-only three-level verification.
 * New file (not an edit to the frozen `x8-production-like-contract.test.ts`,
 * same discipline that file's own docstring documents for RC-2b/RC-10): the
 * level table is the single source of truth, `x8_level_config()` reads it
 * without a second hard-coded copy, and the value is `allow` at Level UAT
 * only. Unlike `ADMIN_TWO_FACTOR_ENFORCEMENT`, this variable never reaches
 * `docker-compose.yml` (it only gates a one-off ops CLI, not the resident
 * `web` service), so there is no compose-config assertion to add here.
 */
const x8Levels = JSON.parse(read("scripts/lib/x8-levels.json")) as Record<
  string,
  { adminLocalIdentitySeed: string }
>;

describe("ADMIN_LOCAL_IDENTITY_SEED — X8 three-level render-only verification", () => {
  it("is 'allow' only at Level UAT; Level 0 and Level R render it empty (unset-equivalent)", () => {
    expect(x8Levels["0"].adminLocalIdentitySeed).toBe("");
    expect(x8Levels.uat.adminLocalIdentitySeed).toBe("allow");
    expect(x8Levels.r.adminLocalIdentitySeed).toBe("");
  });

  it("x8_level_config() reads the field from the same table, not a second hard-coded copy", () => {
    expect(envHelper).toContain("`ADMIN_LOCAL_IDENTITY_SEED=${entry.adminLocalIdentitySeed}`");
  });

  it("registers the three admin-* subcommands and gates admin-seed to Level UAT", () => {
    expect(launcher).toContain("admin-secret) shift;");
    expect(launcher).toContain("admin-seed) shift;");
    expect(launcher).toContain("admin-reset) shift;");
    const adminSeedBody = launcher.slice(launcher.indexOf("\nadmin_seed()"), launcher.indexOf("admin_reset()"));
    expect(adminSeedBody).toContain('[[ "$X8_LEVEL" == "uat" ]]');
    expect(adminSeedBody).toContain("ensure-local-admin-identities.ts");
  });

  it("passes secrets and DATABASE_URL via --env-from-file, never as a literal -e argv value", () => {
    const adminSeedBody = launcher.slice(launcher.indexOf("\nadmin_seed()"), launcher.indexOf("admin_reset()"));
    const adminResetBody = launcher.slice(launcher.indexOf("admin_reset()"), launcher.indexOf("accept_x8()"));
    for (const body of [adminSeedBody, adminResetBody]) {
      expect(body).toContain("--env-from-file");
      expect(body).not.toMatch(/-e X8_ADMIN(2)?_PASSWORD=/);
      expect(body).not.toMatch(/-e DATABASE_URL=/);
      expect(body).toContain("$P1_12_MIGRATION_DATABASE_URL");
    }
  });

  it("up_x8 auto-runs admin-seed at Level UAT only when both local secret files already exist, and never fails up itself when they are missing", () => {
    const upBody = launcher.slice(launcher.indexOf("\nup_x8()"), launcher.indexOf("\nverify_postgres()"));
    expect(upBody).toContain('if [[ "$X8_LEVEL" == "uat" ]]; then');
    expect(upBody).toContain("admin-password");
    expect(upBody).toContain("admin2-password");
    expect(upBody).toContain("admin_seed");
    expect(upBody).toContain("X8_ADMIN_SEED_SKIPPED");
  });

  it("admin-secret set reads the password silently (read -s) and never echoes it back", () => {
    const body = launcher.slice(launcher.indexOf("admin_secret_set()"), launcher.indexOf("\nadmin_seed()"));
    expect(body).toContain("read -r -s -p");
    expect(body).not.toMatch(/echo\s+"?\$password/);
    expect(body).toContain('chmod 600 "$temporary"');
  });

  it("ships valid shell", () => {
    execFileSync("bash", ["-n", resolve(root, "scripts/x8-production-like.sh")]);
    execFileSync("bash", ["-n", resolve(root, "scripts/lib/x8-production-like-env.sh")]);
  });

  const composeAvailable = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;

  it.skipIf(!composeAvailable)("ADMIN_LOCAL_IDENTITY_SEED never reaches the rendered web/worker/scheduler compose config", () => {
    for (const level of ["0", "uat", "r"]) {
      const result = spawnSync(
        "bash",
        [
          "-c",
          [
            `X8_LEVEL=${level} source scripts/lib/x8-production-like-env.sh`,
            "prepare_x8_environment",
            "docker compose -p \"$P1_12_COMPOSE_PROJECT\" -f docker-compose.yml -f infra/production-like/docker-compose.yml config --format json",
          ].join("; "),
        ],
        { cwd: root, encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      const config = JSON.parse(result.stdout) as { services: Record<string, { environment?: Record<string, unknown> }> };
      for (const service of ["web", "worker", "scheduler"]) {
        expect(config.services[service]?.environment?.ADMIN_LOCAL_IDENTITY_SEED).toBeUndefined();
      }
    }
  });
});
