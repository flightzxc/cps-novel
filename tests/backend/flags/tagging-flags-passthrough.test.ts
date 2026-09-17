import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * PR6 fix (lane F) · X8 fact: `grep -i TAGGING docker-compose.yml
 * .env.example scripts/lib/x8-levels.json` was zero hits before this fix —
 * `FEATURE_P2_06_5_TAGGING` / `FEATURE_P2_06_5_TAG_ADMIN_WRITE` /
 * `FEATURE_NOVEL_TAG_AUTO` / `AUTO_WRITE_AUTHORIZED` (all four read by
 * `src/lib/flags/feature-flags.ts` via `process.env`, default arg) never
 * reached the `web`/`worker` containers no matter what an operator set,
 * because nothing in `docker-compose.yml` passed them through. This parses
 * `docker-compose.yml` directly (no Docker required) to assert the exact
 * passthrough line for each service, plus one Docker-gated end-to-end render
 * for the belt-and-suspenders case where the compose interpolation syntax
 * itself is wrong.
 */

const root = resolve(import.meta.dirname, "../../..");
const compose = readFileSync(resolve(root, "docker-compose.yml"), "utf8");

const TAGGING_FLAG_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
  FEATURE_P2_06_5_TAGGING: "false",
  FEATURE_P2_06_5_TAG_ADMIN_WRITE: "false",
  FEATURE_NOVEL_TAG_AUTO: "false",
  AUTO_WRITE_AUTHORIZED: "NO",
});

/**
 * Slices out one top-level service's `environment:` block from
 * `docker-compose.yml`'s raw text, so an assertion below can never
 * accidentally match a same-named var that belongs to a DIFFERENT service.
 * Relies on the file's existing two-space-per-level indentation: a service
 * block runs from `\n  <name>:\n` up to (not including) the next
 * two-space-indented `<name>:` line.
 */
function serviceBlock(serviceName: string): string {
  const marker = `\n  ${serviceName}:\n`;
  const start = compose.indexOf(marker);
  if (start === -1) throw new Error(`service "${serviceName}" not found in docker-compose.yml`);
  const rest = compose.slice(start + marker.length);
  const nextServiceHeader = rest.match(/\n {2}[a-zA-Z][\w-]*:\n/);
  return rest.slice(0, nextServiceHeader ? nextServiceHeader.index : undefined);
}

describe("PR6 lane F: docker-compose.yml passes the P2-06.5 tagging flags to web + worker only", () => {
  const webBlock = serviceBlock("web");
  const workerBlock = serviceBlock("worker");
  const schedulerBlock = serviceBlock("scheduler");

  it("passes all four flags to web with the exact fail-closed defaults", () => {
    for (const [flag, defaultValue] of Object.entries(TAGGING_FLAG_DEFAULTS)) {
      expect(webBlock, flag).toContain(`${flag}: \${${flag}:-${defaultValue}}`);
    }
  });

  it("passes all four flags to worker with the exact fail-closed defaults", () => {
    for (const [flag, defaultValue] of Object.entries(TAGGING_FLAG_DEFAULTS)) {
      expect(workerBlock, flag).toContain(`${flag}: \${${flag}:-${defaultValue}}`);
    }
  });

  it("does not pass any of the four flags to scheduler (it never reads them)", () => {
    for (const flag of Object.keys(TAGGING_FLAG_DEFAULTS)) {
      expect(schedulerBlock).not.toContain(flag);
    }
  });

  it("keeps FEATURE_NOVEL_TAG_AUTO / AUTO_WRITE_AUTHORIZED frozen at false/NO for every X8 level (ADR guard)", () => {
    const levels = JSON.parse(readFileSync(resolve(root, "scripts/lib/x8-levels.json"), "utf8")) as Record<
      string,
      { flags: Record<string, string> }
    >;
    for (const level of ["0", "uat", "r"]) {
      expect(levels[level].flags.FEATURE_NOVEL_TAG_AUTO, level).toBe("false");
      expect(levels[level].flags.AUTO_WRITE_AUTHORIZED, level).toBe("NO");
    }
  });

  it("opens FEATURE_P2_06_5_TAGGING / FEATURE_P2_06_5_TAG_ADMIN_WRITE at UAT/R but not Level 0", () => {
    const levels = JSON.parse(readFileSync(resolve(root, "scripts/lib/x8-levels.json"), "utf8")) as Record<
      string,
      { flags: Record<string, string> }
    >;
    expect(levels["0"].flags.FEATURE_P2_06_5_TAGGING).toBe("false");
    expect(levels["0"].flags.FEATURE_P2_06_5_TAG_ADMIN_WRITE).toBe("false");
    for (const level of ["uat", "r"]) {
      expect(levels[level].flags.FEATURE_P2_06_5_TAGGING, level).toBe("true");
      expect(levels[level].flags.FEATURE_P2_06_5_TAG_ADMIN_WRITE, level).toBe("true");
    }
  });

  it(".env.example documents all four flags with the ADR note on AUTO_WRITE_AUTHORIZED", () => {
    const envExample = readFileSync(resolve(root, ".env.example"), "utf8");
    for (const flag of Object.keys(TAGGING_FLAG_DEFAULTS)) {
      expect(envExample, flag).toContain(flag);
    }
    expect(envExample).toMatch(/AUTO_WRITE_AUTHORIZED[\s\S]{0,400}Owner[\s\S]{0,200}YES/);
  });

  const composeAvailable = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;

  /**
   * Belt-and-suspenders: renders the base `docker-compose.yml` alone (no X8
   * overlay, no X8_LEVEL sourcing — the actual production invocation shape)
   * with a clean, minimal environment that never sets any of the four
   * tagging vars, so this only passes if `docker-compose.yml`'s own
   * `${VAR:-default}` interpolation resolves the same defaults the text
   * assertions above pinned. This mutation is specifically why the previous
   * two tests exist as raw-text assertions rather than only this one: the
   * X8 harness (`scripts/lib/x8-production-like-env.sh`) always exports a
   * value for every key in `scripts/lib/x8-levels.json`'s `flags`, which
   * would silently mask a deleted compose-level default.
   */
  it.skipIf(!composeAvailable)("renders the exact default values with nothing overriding them", () => {
    const minimalEnv: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      PATH: process.env.PATH,
      CPS_NOVEL_APP_IMAGE: "dummy:latest",
      APP_VERSION: "0.0.0",
      GIT_COMMIT: "deadbeef",
      BUILD_DATE: "2026-09-06T00:00:00Z",
      NEXT_PUBLIC_BUILD_VERSION: "0.0.0",
      P1_12_WEB_DATABASE_URL: "postgres://x",
      SITE_URL: "https://example.test",
      TRACKING_HASH_SALT: "x",
      TZ: "UTC",
      TOTP_ENCRYPTION_KEY: "x",
      CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION: "v1",
      P1_12_WORKER_DATABASE_URL: "postgres://x",
      WORKER_TASK_ALLOWLIST: "catalog_scan",
      P1_12_SCHEDULER_DATABASE_URL: "postgres://x",
      P1_12_COMPOSE_PROJECT: "tagging-flags-passthrough-test",
      P1_12_POSTGRES_ADMIN_PASSWORD_FILE: "/dev/null",
      P1_12_MIGRATION_OWNER_PASSWORD_FILE: "/dev/null",
      P1_12_WEB_APP_PASSWORD_FILE: "/dev/null",
      P1_12_WORKER_APP_PASSWORD_FILE: "/dev/null",
      P1_12_SCHEDULER_APP_PASSWORD_FILE: "/dev/null",
      P1_12_ANALYST_RO_PASSWORD_FILE: "/dev/null",
      P1_12_BACKUP_ROLE_PASSWORD_FILE: "/dev/null",
      CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE: "/dev/null",
      CHANNEL_CREDENTIAL_FINGERPRINT_KEY_FILE: "/dev/null",
      // Deliberately NOT setting any of the four tagging flags -- that's
      // the entire point of this test.
    };
    const result = spawnSync("docker", ["compose", "-f", "docker-compose.yml", "config", "--format", "json"], {
      cwd: root,
      encoding: "utf8",
      env: minimalEnv,
    });
    expect(result.status, result.stderr).toBe(0);
    const rendered = JSON.parse(result.stdout) as {
      services: Record<string, { environment?: Record<string, string> }>;
    };
    for (const [flag, expected] of Object.entries(TAGGING_FLAG_DEFAULTS)) {
      expect(rendered.services.web.environment?.[flag], `web ${flag}`).toBe(expected);
      expect(rendered.services.worker.environment?.[flag], `worker ${flag}`).toBe(expected);
    }
    for (const flag of Object.keys(TAGGING_FLAG_DEFAULTS)) {
      expect(rendered.services.scheduler.environment?.[flag], `scheduler ${flag}`).toBeUndefined();
    }
  });
});
