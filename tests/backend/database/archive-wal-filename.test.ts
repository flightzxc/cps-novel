import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// Every mkdtempSync call in this file is routed through this helper so the
// per-test temp directory is always removed afterward, instead of leaking
// one archive-wal-{legal,illegal,conflict,idempotent}-* directory per test
// run into the OS tmp dir.
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

// This is a rehearsal-driven regression test: the WAL retention rehearsal
// (2026-09-16) found the original archive_command whitelist rejected two
// file shapes PostgreSQL itself feeds it (pg_basebackup's "*.backup" backup
// history file and timeline "*.history" files), wedging the archiver behind
// a permanently-failing WAL. See scripts/db/archive-wal.sh's own comment.
// Every case here spawns the real script (never a reimplementation of its
// regex) so a future edit to the whitelist is caught here first.
const root = process.cwd();
const scriptPath = path.resolve(root, "scripts/db/archive-wal.sh");

function runArchive(archiveDir: string, sourcePath: string, walFilename: string) {
  return spawnSync("bash", [scriptPath, sourcePath, walFilename], {
    env: { ...process.env, P1_06_WAL_ARCHIVE_DIR: archiveDir },
    encoding: "utf8",
  });
}

function makeSource(dir: string, name: string, content: string): string {
  const sourcePath = path.join(dir, name);
  writeFileSync(sourcePath, content);
  return sourcePath;
}

describe("archive-wal.sh filename whitelist", () => {
  const legalNames = [
    "00000001000000430000006B",
    "00000001000000430000006C.partial",
    "00000001000000430000006D.gz",
    "000000010000003A00000007.00000028.backup",
    "00000002.history",
  ];

  it.each(legalNames)("accepts %s and archives the file", (walFilename) => {
    const work = mkTestDir("archive-wal-legal-");
    const archiveDir = path.join(work, "archive");
    mkdirSync(archiveDir, { recursive: true });
    const sourcePath = makeSource(work, "src", `payload for ${walFilename}`);

    const result = runArchive(archiveDir, sourcePath, walFilename);

    expect(result.status).toBe(0);
    const destination = path.join(archiveDir, walFilename);
    expect(readFileSync(destination, "utf8")).toBe(`payload for ${walFilename}`);
  });

  const illegalNames = [
    "foo",
    "0000000100000043",
    "../x",
    "00000001000000430000006B.GZ",
    "00000002.HISTORY",
  ];

  it.each(illegalNames)("rejects %s with exit 65", (walFilename) => {
    const work = mkTestDir("archive-wal-illegal-");
    const archiveDir = path.join(work, "archive");
    mkdirSync(archiveDir, { recursive: true });
    const sourcePath = makeSource(work, "src", "payload");

    const result = runArchive(archiveDir, sourcePath, walFilename);

    expect(result.status).toBe(65);
  });

  it("refuses to overwrite a same-named file with different content (exit 73)", () => {
    const work = mkTestDir("archive-wal-conflict-");
    const archiveDir = path.join(work, "archive");
    mkdirSync(archiveDir, { recursive: true });
    const walFilename = "00000001000000430000006B";

    const first = runArchive(archiveDir, makeSource(work, "src-a", "content A"), walFilename);
    expect(first.status).toBe(0);

    const second = runArchive(archiveDir, makeSource(work, "src-b", "content B"), walFilename);
    expect(second.status).toBe(73);
    // The original file must survive the refused overwrite untouched.
    expect(readFileSync(path.join(archiveDir, walFilename), "utf8")).toBe("content A");
  });

  it("is idempotent for a same-named file with identical content (exit 0)", () => {
    const work = mkTestDir("archive-wal-idempotent-");
    const archiveDir = path.join(work, "archive");
    mkdirSync(archiveDir, { recursive: true });
    const walFilename = "00000001000000430000006B";

    const first = runArchive(archiveDir, makeSource(work, "src-a", "same content"), walFilename);
    expect(first.status).toBe(0);

    const second = runArchive(archiveDir, makeSource(work, "src-b", "same content"), walFilename);
    expect(second.status).toBe(0);
    expect(readFileSync(path.join(archiveDir, walFilename), "utf8")).toBe("same content");
  });
});
