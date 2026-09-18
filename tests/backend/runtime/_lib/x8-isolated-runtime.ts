import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll } from "vitest";

/**
 * Test isolation gap fixed 2026-09-19 (Codex real-world finding, 09-19 night
 * runtime-suite run): scripts/lib/x8-production-like-env.sh:6-19 derives
 * X8_SECRET_DIR / X8_TLS_DIR / X8_NGINX_RUNTIME_DIR / X8_BACKUP_DIR /
 * X8_BASE_BACKUP_DIR / X8_EVIDENCE_DIR / X8_GATE_STATE_FILE /
 * X8_BACKUP_PGPASS_FILE / the release-identity files entirely from
 * X8_RUNTIME_DIR (defaulting to "$X8_PROJECT_ROOT/.tmp/x8-production-like"
 * when unset) -- passing any of those derived variables directly has no
 * effect, only X8_RUNTIME_DIR itself does. A test that spawns
 * scripts/x8-production-like.sh (or sources
 * scripts/lib/x8-production-like-env.sh directly) and calls
 * prepare_x8_environment() / prepare_p1_12_local_environment() /
 * prepare_x8_gate_environment() without an explicit X8_RUNTIME_DIR silently
 * inherits that default -- which, in a worktree bound to a live X8 stack, IS
 * the live runtime directory: prepare_x8_environment() mkdir's into it,
 * write_secret_once()'s into it, and x8_reconcile_backup_pgpass() rewrites
 * its backup.pgpass on every single call, unconditionally (see that
 * function's own header comment in x8-production-like-env.sh). That is
 * exactly what happened to the live stack's backup.pgpass during the
 * 2026-09-19 runtime-suite run this fix responds to.
 *
 * Every helper below always points X8_RUNTIME_DIR at a throwaway mkdtemp
 * directory -- never this worktree's own .tmp/x8-production-like -- and
 * registers it for cleanup in the IMPORTING test file's own afterAll (module
 * state, and therefore `createdDirs`, is fresh per test file under vitest's
 * default per-file isolation).
 */

const createdDirs: string[] = [];

afterAll(() => {
  for (const dir of createdDirs.splice(0, createdDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A fresh, empty, throwaway directory -- never the repo's own
 * .tmp/x8-production-like -- registered for cleanup in this test file's own
 * afterAll.
 */
export function makeIsolatedRuntimeDir(prefix = "x8-test-runtime-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

/**
 * `{ ...process.env, X8_RUNTIME_DIR: <fresh temp dir>, ...extra }` -- the
 * env object every spawnSync/execFileSync/spawn call site that sources
 * scripts/lib/x8-production-like-env.sh (directly, or via
 * scripts/x8-production-like.sh) must pass, so it can never fall through to
 * this worktree's own runtime directory. Pass an explicit `runtimeDir` (from
 * a prior makeIsolatedRuntimeDir() call) when several spawns in the same
 * test need to share one runtime directory; otherwise each call gets its
 * own fresh, unshared one.
 */
export function x8Env(
  extra: NodeJS.ProcessEnv = {},
  runtimeDir: string = makeIsolatedRuntimeDir(),
): NodeJS.ProcessEnv {
  return { ...process.env, X8_RUNTIME_DIR: runtimeDir, ...extra };
}
