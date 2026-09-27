import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, beforeAll } from "vitest";

/**
 * 2026-09-27 (Owner-approved, single infra change): `/api/health/backup`
 * (`src/server/health/backup-status.ts`) has returned `{"backupStatus":
 * "failed", ...}` forever, regardless of real backup freshness. Root cause
 * (measured on the real host):
 *
 *   - `backup-loop.sh` writes `last-success.json` under `umask 077`, so the
 *     published file lands `root:root 0600`.
 *   - The host directory it lives in (`/opt/cps-novel/shared/backups`) is
 *     `deploy:deploy` (1000:1000) mode `0750`, bind-mounted `:ro` into `web`
 *     (which runs as `1001:1001`).
 *   - `web` had no supplementary group, so it could not even traverse into
 *     the directory (`other::---` on a 0750 dir) -- EACCES on stat, which
 *     `backup-status.ts` maps to `failed`.
 *
 * The fix has two parts, both required:
 *   1) `infra/preproduction/docker-compose.yml`'s `web` service gets
 *      `group_add: ["1000"]` -- grants traverse/list on the directory (via
 *      its owning group), nothing more. The mount stays `:ro`.
 *   2) `infra/preproduction/backup-loop.sh` `chmod 0644`s the status file's
 *      *temp* file before the publishing `mv` -- once web can traverse the
 *      directory, it still needs to actually read a root:root file, which
 *      only works if the file's `other` bits allow read (group bits don't
 *      apply: the file's owning group is root, not 1000).
 *
 * This file has two halves:
 *   (a) static/derived: the rendered compose config actually carries the
 *       fix (same `docker compose ... config --format json` rendering
 *       approach as the sibling
 *       tests/backend/runtime/preproduction-backup-timer-healthcheck.test.ts,
 *       so this test has no YAML-parsing dependency of its own);
 *   (b) behavioral: the REAL backup-loop.sh, run inside a real
 *       postgres:16.14 container with the real directory/file ownership and
 *       modes, proves a `web`-shaped process (uid 1001, gid 1001, with vs.
 *       without the `1000` supplementary group) can/cannot read the
 *       published status file -- a positive AND a negative control, so the
 *       test cannot pass vacuously (e.g. a world-readable status directory
 *       would make the negative control pass for the wrong reason).
 */

const root = process.cwd();
const composeFile = "infra/preproduction/docker-compose.yml";
const backupLoopFile = "infra/preproduction/backup-loop.sh";
const runbookFile = "docs/operations/PREPRODUCTION_DEPLOYMENT_RUNBOOK.md";

function both(r: { stdout: string | null; stderr: string | null }): string {
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

describe("web can read backup-timer's last-success.json (2026-09-27 group_add + chmod fix)", () => {
  describe("static/derived: rendered compose config", () => {
    let webConfig: {
      group_add?: string[];
      volumes?: Array<{ type: string; source?: string; target: string; read_only?: boolean }>;
    };
    let statusFilePath: string;
    let runbookDeployGid: string;

    beforeAll(async () => {
      const backupLoopSource = await readFile(path.join(root, backupLoopFile), "utf8");
      const statusFileMatch = backupLoopSource.match(/^status_file=(\S+)$/m);
      expect(statusFileMatch, "expected backup-loop.sh to declare status_file=<path>").not.toBeNull();
      statusFilePath = statusFileMatch![1];

      const runbook = await readFile(path.join(root, runbookFile), "utf8");
      // Derive the expected gid from the runbook's own fixed-identity text
      // ("deploy=1000:1000") rather than hard-coding the literal "1000"
      // twice in this repo -- if the runbook's identity assumption ever
      // changes, this test changes with it instead of silently checking a
      // now-stale number.
      const deployIdentityMatch = runbook.match(/deploy=(\d+):(\d+)/);
      expect(deployIdentityMatch, "expected the runbook to state a fixed deploy=<uid>:<gid> identity").not.toBeNull();
      expect(deployIdentityMatch![1]).toBe(deployIdentityMatch![2]);
      runbookDeployGid = deployIdentityMatch![1];

      const result = spawnSync("docker", [
        "compose", "--env-file", "infra/preproduction/preprod.env.example",
        "-f", "docker-compose.yml", "-f", composeFile, "config", "--format", "json",
      ], {
        cwd: root,
        encoding: "utf8",
        env: {
          NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME,
          GIT_COMMIT: "845ca02ac9351163dd69b0de328b2d8aad1e012f",
          CPS_NOVEL_APP_IMAGE: "cps-novel:backup-health-readable-test",
        },
      });
      expect(result.status, both(result)).toBe(0);
      const config = JSON.parse(result.stdout);
      webConfig = config.services.web;
    });

    it("grants web the runbook's fixed deploy gid as a supplementary group", () => {
      expect(webConfig.group_add, "expected web.group_add to be declared").toBeDefined();
      expect(webConfig.group_add).toContain(runbookDeployGid);
    });

    it("keeps the backups mount whose target is backup-loop.sh's status_file directory read-only", () => {
      const statusDir = path.posix.dirname(statusFilePath);
      const mount = (webConfig.volumes ?? []).find((v) => v.target === statusDir);
      expect(mount, `expected a web volume mount targeting ${statusDir}`).toBeDefined();
      expect(mount!.read_only, `expected the ${statusDir} mount to be read-only`).toBe(true);
    });
  });

  describe("behavioral: real backup-loop.sh, real ownership/modes, inside postgres:16.14", () => {
    const available = spawnSync("docker", ["image", "inspect", "postgres:16.14"], { encoding: "utf8" }).status === 0;

    describe.skipIf(!available)("", () => {
      it(
        "web (uid 1001, gid 1001 + group 1000) can read the published status file; without group 1000 it cannot",
        async () => {
          const backupLoopSource = await readFile(path.join(root, backupLoopFile), "utf8");
          const statusFileMatch = backupLoopSource.match(/^status_file=(\S+)$/m);
          expect(statusFileMatch).not.toBeNull();
          const statusFilePath = statusFileMatch![1];
          const backupsDir = path.posix.dirname(statusFilePath);

          // Single docker run, no bind mounts (avoids macOS Docker Desktop's
          // uid/gid remapping on bind-mounted files, which would make an
          // ownership-based test meaningless). The real script text comes in
          // over stdin (docker run -i) and is written to a file inside the
          // container -- not baked into the -c command string, so this always
          // exercises the exact bytes on disk, not a hand-copied duplicate.
          const setupScript = [
            "set -euo pipefail",
            "command -v setpriv >/dev/null 2>&1 || { echo SETPRIV_MISSING; exit 3; }",
            `mkdir -p '${backupsDir}'`,
            `chown 1000:1000 '${backupsDir}'`,
            `chmod 0750 '${backupsDir}'`,
            "mkdir -p /app/scripts/db",
            "for f in backup-logical backup-physical-base verify-physical-base wal-retention; do",
            "  printf '#!/usr/bin/env bash\\nexit 0\\n' > \"/app/scripts/db/$f.sh\"",
            "  chmod +x \"/app/scripts/db/$f.sh\"",
            "done",
            "cat > /opt/backup-loop.sh",
            "chmod +x /opt/backup-loop.sh",
            "export PREPROD_BACKUP_INTERVAL_SECONDS=3600",
            // Exactly one run_once() completes (interval >> the 10s budget,
            // so the loop never reaches its second iteration); `|| true`
            // absorbs the timeout's own SIGTERM-induced non-zero exit
            // without tripping this setup script's own `set -e`.
            "timeout 10 bash /opt/backup-loop.sh || true",
            `status='${statusFilePath}'`,
            "test -f \"$status\" || { echo STATUS_FILE_MISSING; exit 4; }",
            "echo \"RESULT_MODE=$(stat -c '%a' \"$status\")\"",
            "echo RESULT_POSITIVE_BEGIN",
            "setpriv --reuid 1001 --regid 1001 --groups 1000 cat \"$status\"",
            "echo RESULT_POSITIVE_END",
            "if setpriv --reuid 1001 --regid 1001 --clear-groups cat \"$status\" 2>/tmp/negative.err; then",
            "  echo RESULT_NEGATIVE=UNEXPECTED_SUCCESS",
            "else",
            "  echo RESULT_NEGATIVE=DENIED",
            "  cat /tmp/negative.err >&2",
            "fi",
          ].join("\n");

          const result = spawnSync(
            "docker",
            ["run", "--rm", "-i", "--entrypoint", "bash", "postgres:16.14", "-c", setupScript],
            { input: backupLoopSource, encoding: "utf8", timeout: 60_000 },
          );

          expect(result.stdout, both(result)).not.toContain("SETPRIV_MISSING");
          expect(result.stdout, both(result)).not.toContain("STATUS_FILE_MISSING");
          expect(result.stdout, both(result)).toContain("RESULT_MODE=644");

          const positiveStart = result.stdout.indexOf("RESULT_POSITIVE_BEGIN");
          const positiveEnd = result.stdout.indexOf("RESULT_POSITIVE_END");
          expect(positiveStart, both(result)).toBeGreaterThan(-1);
          expect(positiveEnd, both(result)).toBeGreaterThan(positiveStart);
          const positiveOutput = result.stdout.slice(positiveStart, positiveEnd);
          expect(positiveOutput, both(result)).toContain('"exitCode":0');

          // Negative control: without the supplementary group, the same uid
          // must be denied -- proves group_add is load-bearing, not that the
          // file/directory happen to be readable by anyone.
          expect(result.stdout, both(result)).toContain("RESULT_NEGATIVE=DENIED");
          expect(result.stdout, both(result)).not.toContain("RESULT_NEGATIVE=UNEXPECTED_SUCCESS");
          expect(result.stderr, both(result)).toContain("Permission denied");
        },
        30_000,
      );
    });
  });
});
