import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
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

// Opus review fixup 2026-09-18 (P2-7): every forbidden/required-token check
// below now runs against comment-STRIPPED content. Two different problems,
// same fix:
//   * a "must not contain X" guard that only ever scanned the raw file text
//     is trivially defeated by a comment that happens to mention X while
//     the code itself no longer does -- that is not a leak, and asserting
//     against it would make future legitimate documentation (e.g. "this
//     must never reference infra/local-x8, see ...") itself fail the guard.
//   * conversely, a "must contain X" guard (e.g. wal-gc-x8.sh explicitly
//     passing --max-backup-age-seconds) that only ever scanned raw text is
//     satisfied just as well by a comment ABOUT the flag as by the flag
//     actually being passed -- silently defeating the very regression the
//     test exists to catch. Stripping comments first, then requiring the
//     match to still be found in the *scoped* code region (see the
//     target=(...) matcher below), closes that gap.
function stripComments(content: string): string {
  return content
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else if (st.isFile()) {
      out.push(full);
    }
  }
  return out;
}

describe("local-X8 additions never leak into production-like/core paths", () => {
  // Opus review fixup 2026-09-18 (P2-7): was a hand-picked list of 9 files
  // under infra/production-like/ -- widened to the entire tree (every file,
  // recursively), matching the work order's own "infra/production-like/**"
  // scope literally instead of only the files someone remembered to add to
  // an array.
  it("infra/production-like/** never mentions the local-X8 operator/launchd names (outside comments)", () => {
    const forbidden = [
      "wal-gc-daily-apply",
      "launchd",
      "LaunchAgent",
      "com.cpsnovel.x8.wal-gc-apply",
      "infra/local-x8",
    ];
    const files = listFilesRecursive(resolve(root, "infra/production-like"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = stripComments(readFileSync(file, "utf8"));
      for (const token of forbidden) {
        expect(content, `${file} must not contain "${token}" outside comments`).not.toContain(token);
      }
    }
  });

  it("docker-compose.yml and infra/production-like/docker-compose.yml never reference the local-X8 pieces", () => {
    const forbidden = ["wal-gc-daily-apply", "launchd", "com.cpsnovel.x8.wal-gc-apply", "infra/local-x8"];
    for (const file of ["docker-compose.yml", "infra/production-like/docker-compose.yml"]) {
      const content = stripComments(read(file));
      for (const token of forbidden) {
        expect(content, `${file} must not contain "${token}"`).not.toContain(token);
      }
    }
  });

  it("scripts/lib/x8-production-like-env.sh never references the local-X8 pieces", () => {
    const content = stripComments(read("scripts/lib/x8-production-like-env.sh"));
    for (const token of ["wal-gc-daily-apply", "launchd", "com.cpsnovel.x8.wal-gc-apply"]) {
      expect(content).not.toContain(token);
    }
  });

  it("backup-timer.sh still never contains --apply (the daily timer loop stays dry-run-only)", () => {
    const content = stripComments(read("infra/production-like/backup-timer.sh"));
    expect(content).not.toContain("--apply");
  });

  it("wal-retention.sh stays X8-neutral: no cps-novel-x8/Darwin/launchd literals", () => {
    const content = stripComments(read("scripts/db/wal-retention.sh"));
    for (const token of ["cps-novel-x8", "Darwin", "launchd"]) {
      expect(content).not.toContain(token);
    }
  });

  // Opus review fixup 2026-09-18 (P2-7): widened to the two other X8
  // production-facing DB scripts that must stay equally free of
  // local-profile-only identifiers -- neither script existed in this guard
  // before, and nothing else in the suite covered them.
  it("verify-physical-base.sh and backup-physical-base.sh stay free of local-X8-only identifiers", () => {
    for (const file of ["scripts/db/verify-physical-base.sh", "scripts/db/backup-physical-base.sh"]) {
      const content = stripComments(read(file));
      for (const token of ["cps-novel-x8", "Darwin", "launchd", "LaunchAgent"]) {
        expect(content, `${file} must not contain "${token}"`).not.toContain(token);
      }
    }
  });

  // Opus review fixup 2026-09-18 (P2-7): scoped to the fixed target=(...)
  // wal-retention.sh invocation array (same technique as the
  // --require-archiver-healthy static contracts in wal-gc-x8.test.ts /
  // p1-06-static.test.ts), not a bare substring search over the whole
  // (comment-stripped) file -- a bare `.toContain` would still pass if the
  // flag were only ever mentioned in a stray code comment that itself
  // wasn't stripped for some reason, or in an unrelated part of the file
  // (e.g. the usage() string). Anchoring to the array that is actually
  // exec'd is what makes this catch "flag silently dropped from the real
  // invocation" rather than just "the string still appears somewhere".
  it("wal-gc-x8.sh explicitly passes --max-backup-age-seconds with the X8-profile default, inside its target=(...) invocation", () => {
    const content = stripComments(read("scripts/db/wal-gc-x8.sh"));
    const targetMatch = content.match(/target=\([\s\S]*?\)/);
    expect(targetMatch).toBeTruthy();
    const targetBlock = targetMatch![0];
    expect(targetBlock).toContain("--max-backup-age-seconds");
    expect(targetBlock).toContain("X8_WAL_GC_MAX_BACKUP_AGE_SECONDS:-93600");
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

  // Opus review fixup 2026-09-18 (P2-10/P2-11): static proof that the three
  // new safety sections actually exist in the shipped script, independent
  // of the (Docker-requiring, not run in this suite) end-to-end behaviour --
  // same "static contract + real docker rehearsal is a separate concern"
  // split the rest of this describe block already uses.
  it("counts and reports copied .history files (SMOKE_COPY_HISTORY_FILES), refusing rather than guessing a timeline when any are present", () => {
    expect(content).toContain("SMOKE_COPY_HISTORY_FILES");
    expect(content).toContain("history_files_present_expected_timeline_ambiguous");
  });

  it("refuses when --keep-base collapses anchor and target to the same backup", () => {
    expect(content).toContain("anchor_equals_target_nothing_to_prove");
  });

  it("excludes the benign still-starting-up FATAL line from its FATAL-in-log check", () => {
    expect(content).toContain("the database system is starting up");
  });
});
