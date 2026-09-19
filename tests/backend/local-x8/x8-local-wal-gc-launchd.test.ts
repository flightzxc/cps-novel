import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// Opus review fixup 2026-09-18 (P2-12): scripts/x8-local-wal-gc-launchd.sh's
// `install` sub-command previously collapsed every kind of preflight
// failure into one "worktree_not_bound_to_stack" message, which is only
// actually true for one of them (the worktree-binding guard itself
// rejecting the binding). This suite is the shim-based ("formal entry
// point" stand-in) behavioural coverage for the fix: it never runs `install`
// against a real worktree/stack, and in particular never lets it reach
// `launchctl load` -- every scenario here is a preflight-classification
// case that must exit before render_plist/launchctl are ever reached, which
// this suite proves by asserting no plist file is written AND that a PATH-
// shimmed `launchctl` marker is never touched, not just by inference from
// the exit code.
const root = process.cwd();
const scriptPath = path.resolve(root, "scripts/x8-local-wal-gc-launchd.sh");

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

// A fake worktree whose scripts/x8-production-like.sh is a literal stub
// (same technique wal-gc-daily-apply.test.ts's makeWorktree() uses) --
// install_cmd's preflight call (`... wal-gc --json`) has no env-var
// override mechanism the way wal-gc-daily-apply.sh's run_step does, so the
// ONLY way to control what it sees is to make the entry point itself a
// canned script.
function makeFakeWorktree(entryPointBody: string, opts: { withPlistTemplate?: boolean } = {}): string {
  const dir = mkTestDir("launchd-worktree-");
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  const entry = path.join(dir, "scripts", "x8-production-like.sh");
  writeFileSync(entry, entryPointBody);
  chmodSync(entry, 0o755);
  // Opt-in: copy THIS repo's real plist template into the fake worktree, so
  // the fabricated worktree is one that `install` would actually carry all
  // the way through render_plist + launchctl if it were allowed to. Only the
  // Darwin-gate describe below needs that -- it is what turns "the gate
  // refused" into a load-bearing claim (without the template, deleting
  // require_darwin would merely swap the refusal reason for
  // `template_missing` and the plist/launchctl assertions would still pass).
  if (opts.withPlistTemplate) {
    const templateDir = path.join(dir, "infra", "local-x8", "launchd");
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(
      path.join(templateDir, "com.cpsnovel.x8.wal-gc-apply.plist.template"),
      readFileSync(
        path.resolve(root, "infra/local-x8/launchd/com.cpsnovel.x8.wal-gc-apply.plist.template"),
        "utf8",
      ),
    );
  }
  return dir;
}

// A fake $HOME (never the real one) plus a PATH-shimmed `launchctl` that
// touches a marker file if it is ever invoked -- belt and braces on top of
// "no plist file was written": even if a future refactor reordered
// render_plist/launchctl, this still catches `launchctl load` actually
// firing during one of these (expected-to-refuse) scenarios.
//
// `unameS` is what the PATH-shimmed `uname -s` reports, i.e. what
// require_darwin() (scripts/x8-local-wal-gc-launchd.sh:42-47) sees. It
// defaults to "Darwin" because require_darwin is the FIRST thing
// install_cmd does -- before require_entrypoint and before the preflight
// call (:89-91) -- so on a non-macOS host (the CI Linux runner) every
// scenario in this file would otherwise stop at `REFUSED reason=not_darwin`
// and never reach the preflight-classification / worktree_not_absolute
// behaviour it exists to cover. Unlike infra/local-x8/wal-gc-daily-apply.sh,
// this script has no X8_LOCAL_UNAME-style test-mode hook, so shimming the
// `uname` binary on PATH is the only way to control that input without
// touching the production script -- and it is the same PATH-shim mechanism
// this sandbox already used for `launchctl`. The gate itself keeps its own
// dedicated, host-independent coverage in its own describe below.
function makeSandbox(unameS = "Darwin"): { fakeHome: string; plistDest: string; env: NodeJS.ProcessEnv } {
  const fakeHome = mkTestDir("launchd-home-");
  mkdirSync(path.join(fakeHome, "Library", "LaunchAgents"), { recursive: true });
  const plistDest = path.join(fakeHome, "Library", "LaunchAgents", "com.cpsnovel.x8.wal-gc-apply.plist");

  const shimDir = mkTestDir("launchd-shim-bin-");
  const marker = path.join(shimDir, "launchctl.invoked");
  writeFileSync(
    path.join(shimDir, "launchctl"),
    `#!/usr/bin/env bash\ntouch "${marker}"\necho "shim: launchctl $*" >&2\nexit 0\n`,
  );
  chmodSync(path.join(shimDir, "launchctl"), 0o755);

  // The SUT only ever asks for `uname -s`; anything else falls through to
  // the real binary, so this shim can never silently change behaviour it
  // was not written to control.
  writeFileSync(
    path.join(shimDir, "uname"),
    `#!/usr/bin/env bash
if [[ "\${1:-}" == "-s" ]]; then
  printf '%s\\n' ${JSON.stringify(unameS)}
  exit 0
fi
for real in /usr/bin/uname /bin/uname; do
  [[ -x "$real" ]] && exec "$real" "$@"
done
printf '%s\\n' ${JSON.stringify(unameS)}
`,
  );
  chmodSync(path.join(shimDir, "uname"), 0o755);

  return {
    fakeHome,
    plistDest,
    env: {
      ...process.env,
      HOME: fakeHome,
      PATH: `${shimDir}:${process.env.PATH ?? ""}`,
      LAUNCHCTL_MARKER: marker,
    },
  };
}

function runInstall(worktree: string, env: NodeJS.ProcessEnv) {
  return spawnSync("bash", [scriptPath, "install", "--worktree", worktree], {
    // Runtime-dir isolation guard (tests/backend/runtime/runtime-dir-isolation-guard.test.ts,
    // 2026-09-19 hardening): `install`'s REAL isolation from the live
    // .tmp/x8-production-like is the `--worktree` argument above, which
    // always points at makeFakeWorktree()'s fabricated stub
    // scripts/x8-production-like.sh, never this repo's own root --
    // scripts/x8-local-wal-gc-launchd.sh's `install` path reads $WORKTREE
    // (a CLI flag), not X8_RUNTIME_DIR, so setting X8_RUNTIME_DIR here adds
    // no functional behavior. It exists only as defense-in-depth belt and
    // braces, satisfying the guard the same way every other X8/P1-12
    // isolation call site does.
    env: { ...env, X8_RUNTIME_DIR: mkTestDir("launchd-unused-x8-runtime-") },
    encoding: "utf8",
  });
}

describe("x8-local-wal-gc-launchd.sh install: three preflight-classification outcomes, none of them install anything", () => {
  it("wal-gc itself refuses (WAL_RETENTION=REFUSED) -> INSTALL_REFUSED reason=stack_refusing:<line>, plist not written, launchctl never invoked", () => {
    const worktree = makeFakeWorktree(
      "#!/usr/bin/env bash\necho \"WAL_RETENTION=REFUSED reason=stale_base_backup\"\nexit 65\n",
    );
    const { plistDest, env } = makeSandbox();

    const result = runInstall(worktree, env);

    expect(result.status).toBe(65);
    expect(result.stderr).toContain('LOCAL_WAL_GC_LAUNCHD=INSTALL_REFUSED reason="stack_refusing:WAL_RETENTION=REFUSED reason=stale_base_backup"');
    expect(result.stderr).not.toContain("worktree_not_bound_to_stack");
    expect(existsSync(plistDest)).toBe(false);
    expect(existsSync(env.LAUNCHCTL_MARKER as string)).toBe(false);
  });

  it("the worktree-binding guard itself rejects (ERROR: compose project ... different worktree) -> REFUSED reason=worktree_not_bound_to_stack, plist not written, launchctl never invoked", () => {
    const worktree = makeFakeWorktree(
      "#!/usr/bin/env bash\n" +
        "echo \"ERROR: compose project 'cps-novel-x8-local' is already running from a different worktree (/some/other/worktree) -- please run this command from that worktree, or 'down' the stack there first.\" >&2\n" +
        "exit 65\n",
    );
    const { plistDest, env } = makeSandbox();

    const result = runInstall(worktree, env);

    expect(result.status).toBe(65);
    expect(result.stderr).toContain("LOCAL_WAL_GC_LAUNCHD=REFUSED reason=worktree_not_bound_to_stack");
    expect(result.stderr).not.toContain("INSTALL_REFUSED");
    expect(result.stderr).toContain("ERROR: compose project");
    expect(existsSync(plistDest)).toBe(false);
    expect(existsSync(env.LAUNCHCTL_MARKER as string)).toBe(false);
  });

  it("an unclassified preflight failure (neither token) -> falls back to REFUSED reason=worktree_not_bound_to_stack, plist not written, launchctl never invoked", () => {
    const worktree = makeFakeWorktree(
      "#!/usr/bin/env bash\necho \"some unexpected failure with no recognizable token\" >&2\nexit 1\n",
    );
    const { plistDest, env } = makeSandbox();

    const result = runInstall(worktree, env);

    expect(result.status).toBe(65);
    expect(result.stderr).toContain("LOCAL_WAL_GC_LAUNCHD=REFUSED reason=worktree_not_bound_to_stack");
    expect(result.stderr).not.toContain("INSTALL_REFUSED");
    expect(existsSync(plistDest)).toBe(false);
    expect(existsSync(env.LAUNCHCTL_MARKER as string)).toBe(false);
  });
});

describe("x8-local-wal-gc-launchd.sh: --worktree must be absolute", () => {
  it("a relative --worktree -> REFUSED reason=worktree_not_absolute, before any preflight call, plist not written", () => {
    const { plistDest, env } = makeSandbox();

    const result = runInstall("relative/worktree/path", env);

    expect(result.status).toBe(65);
    expect(result.stderr).toContain("LOCAL_WAL_GC_LAUNCHD=REFUSED reason=worktree_not_absolute");
    expect(existsSync(plistDest)).toBe(false);
    expect(existsSync(env.LAUNCHCTL_MARKER as string)).toBe(false);
  });
});

// The Darwin-only gate is not merely a precondition the describes above
// have to get past -- it is a fail-closed contract in its own right, and
// until now nothing in this repo actually exercised it. This describe is
// the load-bearing coverage: it is the ONE place that drives the shimmed
// `uname -s` to a non-Darwin value, and it does so against a worktree that
// would OTHERWISE install successfully end to end (stub entry point exits 0
// so preflight passes, and the real plist template is present), so deleting
// or relaxing require_darwin does not just change a reason string here --
// it lets this scenario render the plist and call `launchctl load` for
// real, which the last three assertions catch.
describe("x8-local-wal-gc-launchd.sh: Darwin-only gate (require_darwin)", () => {
  it("a non-Darwin host -> REFUSED reason=not_darwin, before the preflight call, plist not written, launchctl never invoked", () => {
    const worktree = makeFakeWorktree(
      // Records its own invocation next to itself, so "the gate fired before
      // preflight" is asserted from evidence rather than inferred from the
      // reason string.
      '#!/usr/bin/env bash\ntouch "$(dirname "$0")/../preflight.invoked"\nexit 0\n',
      { withPlistTemplate: true },
    );
    const { plistDest, env } = makeSandbox("Linux");

    const result = runInstall(worktree, env);

    expect(result.status).toBe(65);
    expect(result.stderr).toContain("LOCAL_WAL_GC_LAUNCHD=REFUSED reason=not_darwin");
    expect(result.stdout).not.toContain("LOCAL_WAL_GC_LAUNCHD=INSTALLED");
    expect(existsSync(path.join(worktree, "preflight.invoked"))).toBe(false);
    expect(existsSync(plistDest)).toBe(false);
    expect(existsSync(env.LAUNCHCTL_MARKER as string)).toBe(false);
  });
});

describe("x8-local-wal-gc-launchd.sh: static contracts", () => {
  const content = readFileSync(scriptPath, "utf8");

  it("is syntactically valid bash", () => {
    const result = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
    expect(result.status).toBe(0);
  });

  it("render_plist writes to a temp file first, then renames it onto PLIST_DEST (atomic, never a direct redirect)", () => {
    expect(content).toMatch(/tmp_plist="\$\{PLIST_DEST\}[^"]*"/);
    expect(content).toMatch(/mv\s+"\$tmp_plist"\s+"\$PLIST_DEST"/);
    // The old direct-redirect form must be gone, not merely supplemented.
    expect(content).not.toMatch(/"\$template"\s*>"\$PLIST_DEST"/);
  });

  it("require_entrypoint rejects a non-absolute WORKTREE before checking the entry point file", () => {
    const fnMatch = content.match(/require_entrypoint\(\) \{[\s\S]*?\n\}/);
    expect(fnMatch).toBeTruthy();
    const body = fnMatch![0];
    const absoluteCheckIdx = body.indexOf("worktree_not_absolute");
    const entrypointCheckIdx = body.indexOf("worktree_missing_entrypoint");
    expect(absoluteCheckIdx).toBeGreaterThanOrEqual(0);
    expect(entrypointCheckIdx).toBeGreaterThan(absoluteCheckIdx);
  });
});
