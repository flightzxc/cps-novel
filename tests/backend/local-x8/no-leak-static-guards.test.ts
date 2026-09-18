import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// Local-X8 auto-apply work order 2026-09-18: proves the local-only pieces
// (infra/local-x8/**, scripts/x8-local-wal-gc-launchd.sh,
// scripts/db/pitr-smoke-local.sh) never leak into the paths a real
// production/rehearsal deployment would actually pick up, and that the
// pre-existing production invariants they must never touch (backup-timer.sh
// staying apply-free, wal-retention.sh staying X8-neutral) still hold after
// this work order's edits.
const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("local-X8 additions never leak into production-like/core paths", () => {
  it("infra/production-like/** never mentions the local-X8 operator/launchd names", () => {
    const forbidden = ["wal-gc-daily-apply", "launchd", "com.cpsnovel.x8.wal-gc-apply"];
    const files = [
      "infra/production-like/backup-timer.sh",
      "infra/production-like/docker-compose.yml",
      "infra/production-like/postgres-entrypoint.sh",
      "infra/production-like/alerts/check-wal-archive.sh",
      "infra/production-like/alerts/check-backup-freshness.sh",
      "infra/production-like/alerts/alert-lib.sh",
      "infra/production-like/alerts/run-all.sh",
      "infra/production-like/alerts/drill.sh",
      "infra/production-like/alerts/check-worker-locks.sh",
    ];
    for (const file of files) {
      const content = read(file);
      for (const token of forbidden) {
        expect(content, `${file} must not contain "${token}"`).not.toContain(token);
      }
    }
  });

  it("docker-compose.yml and infra/production-like/docker-compose.yml never reference the local-X8 pieces", () => {
    const forbidden = ["wal-gc-daily-apply", "launchd", "com.cpsnovel.x8.wal-gc-apply", "infra/local-x8"];
    for (const file of ["docker-compose.yml", "infra/production-like/docker-compose.yml"]) {
      const content = read(file);
      for (const token of forbidden) {
        expect(content, `${file} must not contain "${token}"`).not.toContain(token);
      }
    }
  });

  it("scripts/lib/x8-production-like-env.sh never references the local-X8 pieces", () => {
    const content = read("scripts/lib/x8-production-like-env.sh");
    for (const token of ["wal-gc-daily-apply", "launchd", "com.cpsnovel.x8.wal-gc-apply"]) {
      expect(content).not.toContain(token);
    }
  });

  it("backup-timer.sh still never contains --apply (the daily timer loop stays dry-run-only)", () => {
    const content = read("infra/production-like/backup-timer.sh");
    expect(content).not.toContain("--apply");
  });

  it("wal-retention.sh stays X8-neutral: no cps-novel-x8/Darwin/launchd literals", () => {
    const content = read("scripts/db/wal-retention.sh");
    for (const token of ["cps-novel-x8", "Darwin", "launchd"]) {
      expect(content).not.toContain(token);
    }
  });

  it("wal-gc-x8.sh explicitly passes --max-backup-age-seconds with the X8-profile default", () => {
    const content = read("scripts/db/wal-gc-x8.sh");
    expect(content).toContain("--max-backup-age-seconds");
    expect(content).toContain("X8_WAL_GC_MAX_BACKUP_AGE_SECONDS:-93600");
  });
});

describe("local-X8 scripts are syntactically valid bash", () => {
  it("bash -n passes for every new script", () => {
    for (const script of [
      "infra/local-x8/wal-gc-daily-apply.sh",
      "scripts/x8-local-wal-gc-launchd.sh",
      "scripts/db/pitr-smoke-local.sh",
      "scripts/db/wal-gc-x8.sh",
    ]) {
      execFileSync("bash", ["-n", resolve(root, script)]);
    }
  });
});

describe("pitr-smoke-local.sh: static safety contracts", () => {
  const content = read("scripts/db/pitr-smoke-local.sh");

  it("never contains --apply", () => {
    expect(content).not.toContain("--apply");
  });

  it("declares recovery_target_timeline (promotion off an earlier timeline than the archive's newest)", () => {
    expect(content).toContain("recovery_target_timeline");
  });

  it("the only cps_novel_x8-shaped mount reference is read-only (:ro), if any appears at all", () => {
    const mountLike = content.match(/cps_novel_x8[^ ]*:\/[^ ]*/g) ?? [];
    for (const m of mountLike) {
      expect(m.endsWith(":ro")).toBe(true);
    }
  });

  it("the live archive-source volume is only ever mounted with :ro", () => {
    const archiveMounts = content.match(/-v\s+"\$\{ARCHIVE_SOURCE\}:[^"]*"/g) ?? [];
    expect(archiveMounts.length).toBeGreaterThan(0);
    for (const m of archiveMounts) {
      expect(m.endsWith(':ro"')).toBe(true);
    }
    // And it must never be mounted any other way (rw, or without a mode at all).
    expect(content).not.toMatch(/-v\s+"\$\{ARCHIVE_SOURCE\}:[^"]*:rw"/);
  });

  it("every docker resource name is prefixed wal-retention-rig-", () => {
    const names = ["RIG_CONTAINER", "COPY_CONTAINER", "RIG_ARCHIVE_VOLUME"];
    for (const name of names) {
      const match = content.match(new RegExp(`${name}="([^"]*)"`));
      expect(match).toBeTruthy();
    }
    expect(content).toContain('RIG_PREFIX="wal-retention-rig-smoke"');
  });

  it("--pull never and --network none are used on every docker run", () => {
    const runLines = content.split("\n").filter((l) => /docker run/.test(l));
    expect(runLines.length).toBeGreaterThan(0);
    for (const line of runLines) {
      expect(line).toContain("--pull never");
      expect(line).toContain("--network none");
    }
  });
});
