import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Static regression guard for the X8_RUNTIME_DIR isolation gap fixed
 * 2026-09-19 (Codex real-world finding: the 09-19 night runtime-suite run
 * reconciled the LIVE `.tmp/x8-production-like/secrets/backup.pgpass`
 * because a spawn call sourcing scripts/lib/x8-production-like-env.sh and
 * calling prepare_x8_environment() never set X8_RUNTIME_DIR -- see
 * tests/backend/runtime/_lib/x8-isolated-runtime.ts's own header for the
 * full mechanism). This is the primary line of defense: the global
 * fallback in tests/backend/runtime/_lib/x8-vitest-global-setup.ts and its
 * paired leak canary are a safety net, but THIS test is what should turn
 * red the moment a future spawn call site is added without isolation, in
 * the same PR that adds it -- before it ever gets a chance to run.
 *
 * Scans every tests/backend/**\/*.test.ts file (not just tests/backend/runtime/
 * -- the same gap can appear anywhere a test spawns
 * scripts/x8-production-like.sh or sources
 * scripts/lib/x8-production-like-env.sh directly, and the 2026-09-19 audit
 * that produced this fix found call sites in tests/backend/runtime/ only
 * after checking the rest of the tree too). For every
 * spawnSync(...)/execFileSync(...)/execSync(...)/spawn(...) call whose own
 * argument list contains one of the four trigger literals (comments
 * stripped first, so a call is never "cleared" by a stray comment mentioning
 * X8_RUNTIME_DIR/x8Env( without actually setting it, and never "flagged" by
 * a comment merely naming the launcher/env-lib path), this asserts the SAME
 * call also mentions X8_RUNTIME_DIR or uses x8Env( -- the two spellings
 * tests/backend/runtime/_lib/x8-isolated-runtime.ts's helper and every
 * hand-rolled `env: { ...process.env, X8_RUNTIME_DIR: ... }` call site both
 * satisfy.
 *
 * Deliberately call-scoped, not it()-block-scoped (contrast
 * tests/backend/local-x8/wal-gc-daily-apply.test.ts's own self-check, which
 * checks per it()-block): a block-level check would be fooled by two
 * unrelated spawns sharing one it() body, where only one of them actually
 * touches X8_RUNTIME_DIR -- exactly the shape the real 2026-09-19 bug had in
 * tests/backend/runtime/x8-production-like-contract.test.ts's compose-render
 * tests (one bash -c render spawn needing isolation, sitting right next to
 * an unrelated `node .../x8-validate-compose.mjs` spawn that does not).
 *
 * The call boundary is found by balancing parens with a plain, unweighted
 * counter from the opening "(" -- the same technique this repo's own
 * extractBraceBlock() (wal-gc-daily-apply.test.ts) already uses for braces --
 * which is safe here because every "(" inside a real call site (bash -c
 * script text, template-literal interpolations, prose in a trailing
 * comment) is itself balanced in valid source.
 */

const root = resolve(import.meta.dirname, "../../..");
const TESTS_BACKEND_ROOT = join(root, "tests", "backend");

const TRIGGER_LITERALS = [
  "x8-production-like.sh",
  "x8-production-like-env.sh",
  "prepare_x8_environment",
  "prepare_p1_12_local_environment",
];

const ISOLATION_MARKERS = ["X8_RUNTIME_DIR", "x8Env("];

const SPAWN_CALL_REGEX = /\b(?:spawnSync|execFileSync|execSync|spawn)\s*\(/g;

function listTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listTestFiles(full));
    } else if (st.isFile() && name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

// Strips block comments and whole-line `//` comments from a (typically
// small, already call-scoped) snippet -- used only for the trigger-literal /
// isolation-marker substring checks below, never for the paren-balance scan
// itself (see this file's own header comment on why raw source is safer for
// that).
function stripComments(source: string): string {
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutBlockComments
    .split("\n")
    .map((line) => (line.trim().startsWith("//") ? "" : line))
    .join("\n");
}

// Balances parens from the "(" at openParenIdx to the end of the call
// expression it opens.
function extractCall(source: string, openParenIdx: number): string {
  let depth = 0;
  for (let i = openParenIdx; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") {
      depth--;
      if (depth === 0) return source.slice(openParenIdx, i + 1);
    }
  }
  throw new Error(`unbalanced parens starting at index ${openParenIdx}`);
}

interface Violation {
  snippet: string;
}

function findViolations(rawSource: string): Violation[] {
  const violations: Violation[] = [];
  SPAWN_CALL_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SPAWN_CALL_REGEX.exec(rawSource)) !== null) {
    const openParenIdx = match.index + match[0].length - 1;
    let call: string;
    try {
      call = extractCall(rawSource, openParenIdx);
    } catch {
      // An unbalanced paren starting here means this "match" was not a real
      // call expression (almost certainly prose inside a comment or string
      // that happens to spell e.g. "spawn(" without being code) -- nothing
      // to scan.
      continue;
    }
    const stripped = stripComments(call);
    // `bash -n <script>` (or `execFileSync("bash", ["-n", ...])`) is a
    // syntax-only check -- it never sources the file or executes
    // prepare_x8_environment()/prepare_p1_12_local_environment(), so there is
    // no runtime directory to isolate. Same exemption
    // tests/backend/local-x8/wal-gc-daily-apply.test.ts's own self-check
    // already carves out for the identical shape.
    const isSyntaxCheckOnly = /^\(\s*["'`]bash["'`]\s*,\s*\[\s*["'`]-n["'`]/.test(stripped);
    if (isSyntaxCheckOnly) continue;
    const touchesX8 = TRIGGER_LITERALS.some((literal) => stripped.includes(literal));
    if (!touchesX8) continue;
    const isIsolated = ISOLATION_MARKERS.some((marker) => stripped.includes(marker));
    if (!isIsolated) {
      violations.push({ snippet: stripped.length > 400 ? `${stripped.slice(0, 400)}…` : stripped });
    }
  }
  return violations;
}

describe("runtime-dir isolation guard (2026-09-19)", () => {
  const files = listTestFiles(TESTS_BACKEND_ROOT);

  it("scanned at least one test file (guards against a vacuous pass)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((file) => [file.slice(root.length + 1), file] as const))(
    "%s: every spawn call touching x8-production-like.sh / x8-production-like-env.sh / prepare_x8_environment / prepare_p1_12_local_environment also sets X8_RUNTIME_DIR (or uses x8Env()) in the same call",
    (_relativePath, file) => {
      const violations = findViolations(readFileSync(file, "utf8"));
      expect(
        violations,
        violations.map((violation, index) => `violation ${index + 1}:\n${violation.snippet}`).join("\n---\n"),
      ).toEqual([]);
    },
  );
});
