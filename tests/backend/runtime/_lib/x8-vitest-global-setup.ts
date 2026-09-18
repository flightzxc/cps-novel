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
 *      runtime-dir-isolation-guard.test.ts is the primary STATIC check,
 *      catching a missing marker before any test ever runs; this fallback
 *      and the leak canary below are the runtime safety net underneath it,
 *      not a replacement for it).
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
 *
 * P2-3 (2026-09-19 hardening, runtime-dir-isolation-guard.test.ts's own
 * P1-12-direct-source trigger category): the canary ALSO watches this
 * repo's own `.tmp/p1-12-runtime` directory (existence + mtime only -- it
 * carries no single file as consistently written as backup.pgpass, so
 * unlike LIVE_RUNTIME_DIR there is no second per-file check here) for the
 * same reason -- a spawn that sources scripts/lib/p1-12-local-env.sh
 * DIRECTLY (skipping scripts/lib/x8-production-like-env.sh's own
 * `export P1_12_RUNTIME_DIR="$X8_RUNTIME_DIR"` forwarding line) reads
 * P1_12_RUNTIME_DIR, not X8_RUNTIME_DIR, and defaults to
 * `$P1_12_PROJECT_ROOT/.tmp/p1-12-runtime` when that is unset
 * (scripts/lib/p1-12-local-env.sh:1-6) -- so setting only X8_RUNTIME_DIR
 * (this file's own fallback above, or a call site's own explicit override)
 * does nothing to protect THAT directory. This canary is the safety net
 * under runtime-dir-isolation-guard.test.ts's P1_12_RUNTIME_DIR-specific
 * marker requirement for that trigger category, exactly as
 * LIVE_RUNTIME_DIR's canary backs its X8_RUNTIME_DIR requirement.
 *
 * Caveat shared by both halves of this canary, not just the P1-12 half:
 * under `vitest --watch`, teardown() only runs when the watch process
 * itself exits, so a leak from one run in a long-lived watch session is
 * only ever detected (and only fails the process) at that final exit, not
 * after the specific run that caused it -- `vitest run` (CI, and this
 * repo's own test scripts) does not have this gap, since setup()/teardown()
 * bracket that one run exactly.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// tests/backend/runtime/_lib -> repo root (four levels up).
const REPO_ROOT = resolve(HERE, "../../../..");
const LIVE_RUNTIME_DIR = join(REPO_ROOT, ".tmp", "x8-production-like");
const LIVE_BACKUP_PGPASS = join(LIVE_RUNTIME_DIR, "secrets", "backup.pgpass");
const LIVE_P1_12_RUNTIME_DIR = join(REPO_ROOT, ".tmp", "p1-12-runtime");

interface Snapshot {
  runtimeDirExists: boolean;
  runtimeDirMtimeMs: number | null;
  pgpassExists: boolean;
  pgpassIno: number | null;
  pgpassMtimeMs: number | null;
  // P2-3: LIVE_P1_12_RUNTIME_DIR's own existence/mtime -- see this file's
  // header comment for why this needs a second, independent watch from
  // LIVE_RUNTIME_DIR's.
  p1_12RuntimeDirExists: boolean;
  p1_12RuntimeDirMtimeMs: number | null;
}

function statOrNull(path: string): { exists: boolean; mtimeMs: number | null; ino: number | null } {
  try {
    const stat = statSync(path);
    return { exists: true, mtimeMs: stat.mtimeMs, ino: stat.ino };
  } catch {
    // Does not exist -- the expected state in a fresh worktree, and the
    // canary's own baseline in that case.
    return { exists: false, mtimeMs: null, ino: null };
  }
}

function snapshotLiveRuntimeDir(): Snapshot {
  const runtimeDir = statOrNull(LIVE_RUNTIME_DIR);
  const pgpass = statOrNull(LIVE_BACKUP_PGPASS);
  const p1_12RuntimeDir = statOrNull(LIVE_P1_12_RUNTIME_DIR);

  return {
    runtimeDirExists: runtimeDir.exists,
    runtimeDirMtimeMs: runtimeDir.mtimeMs,
    pgpassExists: pgpass.exists,
    pgpassIno: pgpass.ino,
    pgpassMtimeMs: pgpass.mtimeMs,
    p1_12RuntimeDirExists: p1_12RuntimeDir.exists,
    p1_12RuntimeDirMtimeMs: p1_12RuntimeDir.mtimeMs,
  };
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
    // Belt and braces: empirically (vitest 3.2.7, verified by hand while
    // building this canary), a globalSetup teardown that only throws does
    // NOT turn the CLI's own process exit code non-zero -- the error is
    // printed prominently as a "Startup Error", but `vitest run` still
    // exits 0, which would make this canary invisible to any CI step that
    // only checks the exit code. process.exitCode is a plain Node.js
    // mechanism that survives regardless of how vitest's internal teardown
    // promise chain handles the throw below, since globalSetup/teardown run
    // in the SAME process as the CLI itself, never a worker.
    process.exitCode = 1;
    throw new Error(
      `X8_RUNTIME_LEAK: tests touched ${LIVE_RUNTIME_DIR} and/or ${LIVE_P1_12_RUNTIME_DIR} -- before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    );
  }
}
