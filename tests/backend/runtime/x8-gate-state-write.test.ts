import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");

/**
 * 2026-09-06 patch (third round), High finding: write_x8_gate_state()
 * (scripts/lib/x8-production-like-env.sh) is a bare three-step
 * `printf ... >"$temporary"; chmod 600 "$temporary"; mv "$temporary"
 * "$X8_GATE_STATE_FILE"`, and EVERY call site invokes it as the left
 * operand of `||` (`case ... esac || state_write_status=$?` in
 * gate_catalog_write(), scripts/x8-production-like.sh) so it can capture a
 * non-zero return without aborting the caller under `set -e`. Bash's
 * documented `-e` inertness for "part of any command executed in a && or
 * || list except the command following the final && or ||" propagates into
 * a called function's ENTIRE body for as long as that call is being made --
 * confirmed empirically below. That means none of the three steps inside
 * write_x8_gate_state() can rely on `set -e` to stop execution on failure:
 * if the FIRST step (writing the new content) fails but the directory
 * itself is otherwise writable, execution used to fall through anyway --
 * `chmod` succeeding on the untouched (empty or stale) temp file, then `mv`
 * renaming that corrupted temp file onto the real state file and
 * SUCCEEDING, returning 0. Every caller believes the write succeeded; the
 * persisted gate state is silently replaced with garbage.
 *
 * This is deliberately NOT the same shape as the existing "group 2" test in
 * x8-gate-catalog.test.ts, which chmod's the ENTIRE runtime directory
 * read-only -- that makes both the temp-file CREATE and the final `mv`
 * (also a directory operation) fail together, so it never exercises "step
 * one fails, but the rename itself could have succeeded". Here the
 * temporary file is pre-created (predicting its exact name via `$$`, which
 * is stable for the lifetime of this single `bash -c` process) with no
 * write permission for its owner, so the directory stays fully writable
 * (the rename would succeed) while only the content-write step is denied.
 */
describe("write_x8_gate_state() -- content-write failure must not silently promote a corrupted temp file", () => {
  let runtimeDir: string;

  afterEach(() => {
    if (runtimeDir) {
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  const run = (script: string) =>
    spawnSync("bash", ["-c", script], { cwd: root, encoding: "utf8", env: { ...process.env, X8_RUNTIME_DIR: runtimeDir } });

  it("a failed content write is reported (non-zero return), leaves the real state file untouched, and removes the temp file", () => {
    runtimeDir = mkdtempSync(join(tmpdir(), "x8-gate-state-write-"));
    const stateFile = join(runtimeDir, "catalog-gate.state");

    const script = `
      set -euo pipefail
      source scripts/lib/x8-production-like-env.sh
      printf 'closed\\n' >"$X8_GATE_STATE_FILE"
      temporary="\${X8_GATE_STATE_FILE}.tmp.$$"
      printf 'GARBAGE-FROM-A-STALE-OR-INTERRUPTED-WRITE\\n' >"$temporary"
      chmod 400 "$temporary"
      status=0
      write_x8_gate_state apply || status=$?
      echo "STATUS=$status"
      echo "TEMP_EXISTS=$(test -e "$temporary" && echo yes || echo no)"
    `;
    const result = run(script);

    // The pre-created temp file's content-write step (the `printf ...
    // >"$temporary"` inside write_x8_gate_state) fails with EACCES -- bash
    // itself reports this on stderr; this is the failure being modeled, not
    // a test-harness error.
    expect(result.stderr).toMatch(/[Pp]ermission denied/);

    const stdout = result.stdout;
    const status = /STATUS=(-?\d+)/.exec(stdout)?.[1];
    const tempExists = /TEMP_EXISTS=(yes|no)/.exec(stdout)?.[1];

    // The bug this test guards against: the OLD write_x8_gate_state() let
    // `chmod`/`mv` run anyway after the failed `printf`, `mv` then
    // succeeded (renaming the untouched, garbage-content temp file onto the
    // real state file), and the function returned the `mv` exit status --
    // 0 -- silently reporting success. The fix must surface this as a
    // non-zero return.
    expect(status, `stdout:\n${stdout}\nstderr:\n${result.stderr}`).not.toBe("0");
    expect(status).not.toBeUndefined();

    // The real state file must still hold its ORIGINAL content -- never
    // overwritten with the failed write's garbage/stale temp-file content.
    expect(readFileSync(stateFile, "utf8").trim()).toBe("closed");

    // The temp file must not be left behind (either promoted over the real
    // file, which the assertion above already rules out, or orphaned next
    // to it).
    expect(tempExists).toBe("no");
  });
});
