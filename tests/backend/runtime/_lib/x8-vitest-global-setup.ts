import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Global fallback + leak canary for the X8_RUNTIME_DIR isolation gap fixed
 * 2026-09-19 (see tests/backend/runtime/_lib/x8-isolated-runtime.ts's own
 * header for the full mechanism). Registered as this "node" vitest
 * project's globalSetup (vitest.config.ts) so it brackets the ENTIRE
 * `tests/backend/**` + `tests/integration/**` run exactly once, in the main
 * process, before any worker starts and after every worker has finished --
 * unlike `setupFiles`, which would re-run per test file.
 *
 * Two independent jobs:
 *
 *   1. Fallback default: if the ambient environment does not already carry
 *      X8_RUNTIME_DIR (an operator's shell may legitimately set one), export
 *      a fresh mkdtemp directory for the whole run before any test file's
 *      spawnSync/execFileSync/spawn call can inherit `process.env` -- a
 *      last-resort net under the per-call-site isolation every individual
 *      test in tests/backend/runtime/**, tests/backend/database/**, etc.
 *      already does explicitly (this should rarely, ideally never, be the
 *      thing that actually saves a call site -- the static guard in
 *      runtime-dir-isolation-guard.test.ts is the primary defense).
 *
 *   2. Leak canary: records whether this repo's own
 *      `.tmp/x8-production-like` directory (and, if present,
 *      `secrets/backup.pgpass`'s inode + mtime -- the file the 09-19 incident
 *      this fix responds to actually rewrote) exists and its mtime BEFORE
 *      the run, then compares again AFTER every test file has finished. Any
 *      difference throws, which fails the whole `vitest run` -- the same
 *      severity as a failed assertion, because a passing test suite that
 *      silently mutated the live runtime directory is not actually green.
 *      This check is read-only: it never creates, deletes, or otherwise
 *      provisions `.tmp/x8-production-like` itself.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// tests/backend/runtime/_lib -> repo root (four levels up).
const REPO_ROOT = resolve(HERE, "../../../..");
const LIVE_RUNTIME_DIR = join(REPO_ROOT, ".tmp", "x8-production-like");
const LIVE_BACKUP_PGPASS = join(LIVE_RUNTIME_DIR, "secrets", "backup.pgpass");

interface Snapshot {
  runtimeDirExists: boolean;
  runtimeDirMtimeMs: number | null;
  pgpassExists: boolean;
  pgpassIno: number | null;
  pgpassMtimeMs: number | null;
}

function snapshotLiveRuntimeDir(): Snapshot {
  let runtimeDirExists = false;
  let runtimeDirMtimeMs: number | null = null;
  try {
    const stat = statSync(LIVE_RUNTIME_DIR);
    runtimeDirExists = true;
    runtimeDirMtimeMs = stat.mtimeMs;
  } catch {
    // Does not exist -- the expected state in a fresh worktree, and the
    // canary's own baseline in that case.
  }

  let pgpassExists = false;
  let pgpassIno: number | null = null;
  let pgpassMtimeMs: number | null = null;
  try {
    const stat = statSync(LIVE_BACKUP_PGPASS);
    pgpassExists = true;
    pgpassIno = stat.ino;
    pgpassMtimeMs = stat.mtimeMs;
  } catch {
    // Does not exist -- fine.
  }

  return { runtimeDirExists, runtimeDirMtimeMs, pgpassExists, pgpassIno, pgpassMtimeMs };
}

let canaryBefore: Snapshot | undefined;
let injectedRuntimeDir: string | undefined;

export async function setup(): Promise<void> {
  canaryBefore = snapshotLiveRuntimeDir();

  if (!process.env.X8_RUNTIME_DIR) {
    injectedRuntimeDir = mkdtempSync(join(tmpdir(), "x8-vitest-runtime-"));
    process.env.X8_RUNTIME_DIR = injectedRuntimeDir;
  }
}

export async function teardown(): Promise<void> {
  if (injectedRuntimeDir) {
    rmSync(injectedRuntimeDir, { recursive: true, force: true });
    if (process.env.X8_RUNTIME_DIR === injectedRuntimeDir) {
      delete process.env.X8_RUNTIME_DIR;
    }
    injectedRuntimeDir = undefined;
  }

  const before = canaryBefore;
  canaryBefore = undefined;
  if (!before) return; // setup() never ran (an earlier globalSetup failed) -- nothing to compare.

  const after = snapshotLiveRuntimeDir();
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(
      `X8_RUNTIME_LEAK: tests touched ${LIVE_RUNTIME_DIR} -- before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    );
  }
}
