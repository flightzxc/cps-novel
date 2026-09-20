import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Static regression guard for the X8_RUNTIME_DIR isolation gap fixed
 * 2026-09-19 (Codex real-world finding: the 09-19 night runtime-suite run
 * reconciled the LIVE `.tmp/x8-production-like/secrets/backup.pgpass`
 * because a spawn call sourcing scripts/lib/x8-production-like-env.sh and
 * calling prepare_x8_environment() never set X8_RUNTIME_DIR -- see
 * tests/backend/runtime/_lib/x8-isolated-runtime.ts's own header for the
 * full mechanism), HARDENED 2026-09-19 (Opus review round two) after a
 * follow-up audit found the original version of this guard only ever
 * "considered" 6 of the ~89 real spawn/exec call sites across the tree it
 * scans (measured directly against this repo, HEAD 8bbd25d): it required
 * the trigger literal (e.g. "x8-production-like.sh") to appear inside the
 * SAME spawn call's own argument list, but almost every real call site
 * instead resolves its script path through a `const launcher =
 * resolve(root, "scripts/x8-production-like.sh")`-style variable defined
 * elsewhere in the file (see e.g. tests/backend/runtime/x8-gate-catalog.test.ts's
 * `runGate()`/`runStatus()` helpers) -- so the literal never appeared inside
 * the call text the old version inspected, and the call was silently never
 * checked at all (not even counted as "considered"). This version fixes
 * that gap by moving to FILE-scoped detection (below), while adding an
 * explicit, commented exemption whitelist for the handful of call shapes
 * that genuinely need no isolation (also below) so the stricter scan does
 * not just trade false negatives for false positives.
 *
 * ── Coverage semantics (file-scoped, not call-scoped) ──────────────────
 * If a test file mentions ANY of TRIGGER_LITERALS below, anywhere in its
 * source, outside a `//`/`/* *\/` comment (comments are stripped for this
 * check only -- NOT string/template-literal content, since the 2026-09-19
 * incident's own bug shape is a trigger literal embedded directly in a
 * `bash -c` script string, and the mutation drill in this file's own
 * sibling test proves a case exactly like that must still be caught), then
 * EVERY spawnSync(...)/execFileSync(...)/execSync(...)/spawn(...) call in
 * that file is "considered" and must satisfy one of:
 *   (a) it is covered by one of the five named EXEMPTIONS below, or
 *   (b) its own call text (comments stripped) mentions an accepted
 *       isolation marker for the trigger category that call (or, if the
 *       call itself carries no trigger literal, the file) matched, or
 *   (c) its `env:` value is a bare identifier (or object-shorthand `env`)
 *       whose nearest PRECEDING `const`/`let` declaration in the same file
 *       mentions an accepted marker -- e.g.
 *       `const isolatedEnv = x8Env(); ...; env: isolatedEnv` (this is the
 *       exact shape Opus's C3 finding flagged as a false-positive risk in
 *       the original call-scoped design: the marker is one hop away via a
 *       variable, not inline).
 * "Nearest preceding" is resolved by SOURCE POSITION, not by name alone,
 * so two different `it()` blocks in the same file that both declare
 * `const env = ...` (a common shape in this suite) each resolve to their
 * own local declaration, never each other's.
 *
 * ── Two trigger categories, two different accepted markers ─────────────
 * scripts/lib/x8-production-like-env.sh forwards `X8_RUNTIME_DIR` into
 * `P1_12_RUNTIME_DIR` (`export P1_12_RUNTIME_DIR="$X8_RUNTIME_DIR"`,
 * scripts/lib/x8-production-like-env.sh:46-48) immediately before sourcing
 * scripts/lib/p1-12-local-env.sh -- but a call that sources
 * scripts/lib/p1-12-local-env.sh DIRECTLY (skipping that forwarding line
 * entirely) never gets that translation, so X8_RUNTIME_DIR alone does
 * nothing for it; only P1_12_RUNTIME_DIR (read directly by
 * scripts/lib/p1-12-local-env.sh:6) does. X8_MARKERS/P1_12_MARKERS below
 * are therefore two separate accepted-marker sets, and a call/file is
 * classified into whichever TRIGGER_CATEGORY its own matched literal(s)
 * belong to (x8-production-like wins on a tie -- a call that references
 * both is already covered by X8_RUNTIME_DIR forwarding).
 *
 * ── tests/backend/local-x8/** is a deliberately separate family ────────
 * infra/local-x8/wal-gc-daily-apply.sh and scripts/x8-local-wal-gc-launchd.sh
 * both mention "x8-production-like.sh" in real (non-comment) code -- they
 * invoke the formal entry point as a subprocess -- but neither one reads
 * X8_RUNTIME_DIR or sources scripts/lib/x8-production-like-env.sh; instead
 * each derives its own copy of the live-directory-equivalent path from
 * X8_LOCAL_WORKTREE / a `--worktree` CLI flag (verified directly against
 * both scripts' source: infra/local-x8/wal-gc-daily-apply.sh:176,200,221 and
 * scripts/x8-local-wal-gc-launchd.sh:60,101). LOCAL_X8_MARKERS below is the
 * accepted-marker set for files under tests/backend/local-x8/ -- ADDITIONAL
 * to, not instead of, X8_MARKERS, since a local-x8 call is free to also set
 * X8_RUNTIME_DIR defensively. tests/backend/local-x8/wal-gc-daily-apply.test.ts
 * additionally carries its own dedicated static self-check (its own
 * "self-check" describe block, further down in that file) that this guard
 * deliberately does not duplicate.
 *
 * ── Why file-scoped, not call-scoped, changes what "structure" means ───
 * Extracting a call's own boundaries (matching parens) and a preceding
 * variable declaration's boundaries (matching brackets, then a top-level
 * `;`) both need to walk the source without being confused by parens/
 * braces/semicolons that appear inside comments, strings, template
 * literals, or regex literals -- the ORIGINAL guard did not mask any of
 * those before scanning, which is exactly why it silently `continue`d on
 * an "unparseable" call (NIT-5): tests/backend/local-x8/wal-gc-daily-apply.test.ts's
 * OWN self-check test NAME contains the literal text "spawnSync(" as prose
 * (not code), which the old naive scan matched as a candidate call site and
 * then failed to paren-balance (it isn't real code). maskForStructure()
 * below fixes the PARSER instead of tolerating the failure: it blanks out
 * comments, string/template literal bodies, and regex literals (keeping
 * newlines, so line numbers stay correct) before any regex/paren-balance
 * scan runs, so a prose match like that one never becomes a "spawn call"
 * candidate in the first place. Content inspection (trigger literals,
 * markers) always re-reads the ORIGINAL unmasked source for the same index
 * range, since that content is exactly what a mutation like "a spawn call
 * whose -c script directly sources p1-12-local-env.sh" needs this guard to
 * still see.
 *
 * ── "Primary line of defense" ───────────────────────────────────────────
 * This is the primary STATIC check: it runs in the same `vitest run` as
 * every test it scans, in the SAME PR that would add an unisolated spawn
 * call, before that call ever executes. It is not the only check --
 * tests/backend/runtime/_lib/x8-vitest-global-setup.ts's global fallback +
 * leak canary is a runtime safety net underneath it (catches anything this
 * guard's necessarily-heuristic parsing misses), and
 * tests/backend/local-x8/wal-gc-daily-apply.test.ts's own self-check covers
 * that one file's X8_LOCAL_RUNTIME_DIR contract in more targeted detail
 * than this file's generic marker vocabulary can express. All three
 * together are the actual defense-in-depth; no single one is a complete
 * guarantee on its own, which is why this comment no longer calls this
 * file uniquely "the" primary line of defense as a totalizing claim.
 */

const root = resolve(import.meta.dirname, "../../..");

// P2-2: the "node" vitest project's own collection roots (vitest.config.ts,
// `test.projects[1].test.include`) -- hardcoded here rather than imported
// (vitest.config.ts has no exported constant for it, only an inline array
// inside `defineConfig`) and cross-checked textually against that file
// below so the two can never silently drift apart.
const VITEST_CONFIG_PATH = join(root, "vitest.config.ts");
const SCAN_ROOT_GLOBS = ["tests/backend/**/*.test.ts", "tests/integration/**/*.test.ts"];
const SCAN_ROOTS = [join(root, "tests", "backend"), join(root, "tests", "integration")];

const X8_TRIGGER_LITERALS = [
  "x8-production-like.sh",
  "x8-production-like-env.sh",
  "prepare_x8_environment",
  "x8_export_static_topology",
];
const P1_12_TRIGGER_LITERALS = ["p1-12-local-env.sh", "prepare_p1_12_local_environment"];
const ALL_TRIGGER_LITERALS = [...X8_TRIGGER_LITERALS, ...P1_12_TRIGGER_LITERALS];

const X8_MARKERS = ["X8_RUNTIME_DIR", "x8Env("];
const P1_12_MARKERS = ["P1_12_RUNTIME_DIR"];
const LOCAL_X8_MARKERS = ["X8_LOCAL_RUNTIME_DIR", "X8_LOCAL_WORKTREE"];
const LOCAL_X8_DIR_PREFIX = join(root, "tests", "backend", "local-x8") + sep;

// The three scripts this guard's trigger literals name directly -- never
// "standalone" no matter what their own content says, since they ARE the
// thing the isolation marker exists to isolate.
const CORE_TRIGGER_SCRIPTS = new Set([
  join(root, "scripts", "x8-production-like.sh"),
  join(root, "scripts", "lib", "x8-production-like-env.sh"),
  join(root, "scripts", "lib", "p1-12-local-env.sh"),
]);

function listTestFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const name of entries) {
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

// Strips block comments and whole-line `//` comments -- used for the
// file/call-level trigger-literal and isolation-marker substring checks
// (never for the structural masking maskForStructure() does, and never
// applied to a target .sh file's content, which uses stripShellComments()
// instead -- JS comment syntax does not apply there).
function stripJsComments(source: string): string {
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutBlockComments
    .split("\n")
    .map((line) => (line.trim().startsWith("//") ? "" : line))
    .join("\n");
}

// Shell `#` comments are line-based; a `#` inside a quoted string is not a
// comment. This is a light per-line heuristic (no backslash-escape
// handling inside quotes) -- good enough for "does this trigger literal
// appear as real code in this .sh file", not a full shell parser.
function stripShellComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      let inSingle = false;
      let inDouble = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === "'" && !inDouble) inSingle = !inSingle;
        else if (c === '"' && !inSingle) inDouble = !inDouble;
        else if (c === "#" && !inSingle && !inDouble) return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

// Blanks out (to same-length spaces, preserving newlines so line numbers
// stay valid) `//` and `/* */` comments, `'...'`/`"..."` strings, template
// literals, and regex literals, WITHOUT touching real code structure
// outside them. Used only to find call/declaration BOUNDARIES safely (see
// this file's own header comment); content inspection always re-reads the
// original unmasked source for the same index range afterwards.
//
// Regex-literal detection uses the standard "what could precede a regex"
// heuristic (previous significant char is an operator/punctuator, or the
// previous word is a keyword like `return`/`typeof`/`case`) -- this repo's
// own `.toMatch(/.../)`/`.match(/.../)` call sites, several of which embed
// a literal `"` inside the pattern (e.g. `/echo\s+"?\$password/` in
// x8-admin-local-identity-seed.test.ts), are exactly why this exists: an
// earlier draft of this function had no regex-literal handling, so it
// mistook that embedded `"` for the start of a string literal and
// mis-masked everything from there to the next `"` anywhere later in the
// file, corrupting real call sites downstream of it.
function maskForStructure(source: string): string {
  const out = source.split("");
  const n = source.length;
  const isRegexContext = (idx: number): boolean => {
    let k = idx - 1;
    while (k >= 0 && /\s/.test(source[k])) k--;
    if (k < 0) return true;
    const c = source[k];
    if ("([{,;:=!&|?+~%^<>*-".includes(c)) return true;
    const wordEnd = k + 1;
    let wordStart = wordEnd;
    while (wordStart > 0 && /[A-Za-z0-9_$]/.test(source[wordStart - 1])) wordStart--;
    const word = source.slice(wordStart, wordEnd);
    return ["return", "typeof", "case", "in", "of", "new", "instanceof", "delete", "void", "do", "else", "yield", "await"].includes(
      word,
    );
  };
  let i = 0;
  while (i < n) {
    const c = source[i];
    const c2 = source[i + 1];
    if (c === "/" && c2 === "/") {
      let j = i;
      while (j < n && source[j] !== "\n") {
        out[j] = " ";
        j++;
      }
      i = j;
      continue;
    }
    if (c === "/" && c2 === "*") {
      let j = i;
      while (j < n && !(source[j] === "*" && source[j + 1] === "/")) {
        if (source[j] !== "\n") out[j] = " ";
        j++;
      }
      if (j < n) {
        out[j] = " ";
        out[j + 1] = " ";
        j += 2;
      }
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      out[i] = " ";
      while (j < n && source[j] !== quote) {
        if (source[j] === "\\") {
          if (source[j] !== "\n") out[j] = " ";
          j++;
          if (j < n && source[j] !== "\n") out[j] = " ";
          j++;
          continue;
        }
        if (source[j] !== "\n") out[j] = " ";
        j++;
      }
      if (j < n) {
        out[j] = " ";
        j++;
      }
      i = j;
      continue;
    }
    if (c === "`") {
      // Masks the entire template span, INCLUDING `${...}` interpolations
      // (no nested-backtick-in-interpolation handling) -- deliberately
      // simple: nothing in this repo's test suite spawns a process, or
      // declares an isolation-relevant variable, from inside a template
      // interpolation, only from plain statements outside any template.
      let j = i + 1;
      out[i] = " ";
      while (j < n && source[j] !== "`") {
        if (source[j] === "\\") {
          if (source[j] !== "\n") out[j] = " ";
          j++;
          if (j < n && source[j] !== "\n") out[j] = " ";
          j++;
          continue;
        }
        if (source[j] !== "\n") out[j] = " ";
        j++;
      }
      if (j < n) {
        out[j] = " ";
        j++;
      }
      i = j;
      continue;
    }
    if (c === "/" && c2 !== "/" && c2 !== "*" && isRegexContext(i)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && source[j] !== "\n") {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === "[") {
          inClass = true;
          j++;
          continue;
        }
        if (source[j] === "]") {
          inClass = false;
          j++;
          continue;
        }
        if (source[j] === "/" && !inClass) {
          closed = true;
          j++;
          break;
        }
        j++;
      }
      if (closed) {
        while (j < n && /[a-zA-Z]/.test(source[j])) j++;
        for (let k = i; k < j; k++) {
          if (source[k] !== "\n") out[k] = " ";
        }
        i = j;
        continue;
      }
      // No closing "/" before end-of-line -- not a real regex literal
      // (division or a stray slash); fall through and advance one char.
    }
    i++;
  }
  return out.join("");
}

const SPAWN_CALL_REGEX = /\b(?:spawnSync|execFileSync|execSync|spawn)\s*\(/g;

function findMatchingClose(masked: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < masked.length; i++) {
    if (masked[i] === "(") depth++;
    else if (masked[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface Declaration {
  name: string;
  start: number;
  text: string;
}

// Every `const NAME = EXPR;` / `let NAME = EXPR;` in the file (TS type
// annotations between NAME and `=` are skipped), scanned over the
// structure-masked source so a `;`/bracket inside a string or template
// literal in EXPR can never be mistaken for the statement's own end.
function collectDeclarations(raw: string, masked: string): Declaration[] {
  const decls: Declaration[] = [];
  const re = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;{]*)?=(?!=)\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const name = m[1];
    const exprStart = m.index + m[0].length;
    let depth = 0;
    let end = -1;
    for (let i = exprStart; i < masked.length; i++) {
      const c = masked[i];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (c === ";" && depth <= 0) {
        end = i;
        break;
      }
    }
    if (end === -1) continue;
    decls.push({ name, start: m.index, text: raw.slice(exprStart, end) });
  }
  return decls;
}

// The LAST declaration of `name` whose own position is before `beforeIdx`
// -- "nearest preceding by source position", so two different it() blocks
// that both declare `const env = ...` each resolve to their own local one
// (see this file's header comment).
function nearestDecl(decls: Declaration[], name: string, beforeIdx: number): Declaration | null {
  let best: Declaration | null = null;
  for (const d of decls) {
    if (d.name === name && d.start < beforeIdx) {
      if (!best || d.start > best.start) best = d;
    }
  }
  return best;
}

// `copyFileSync(SRC, DEST)` provenance (DEST identifier -> SRC identifier)
// -- lets resolveScriptPath() see through
// tests/backend/database/wal-gc-x8.test.ts's `wrapperCopy` pattern (a
// tmpdir copy of scripts/db/wal-gc-x8.sh, made so a stub wal-retention.sh
// can sit next to it) back to the real repo file it was copied from.
function collectCopyProvenance(masked: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /\bcopyFileSync\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*[,)]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) map.set(m[2], m[1]);
  return map;
}

const LITERAL_PATH_RE = /(?:path\.)?(?:resolve|join)\s*\(\s*root\s*,\s*["'`]([^"'`]+)["'`]\s*\)/;

function resolveExprToPath(
  exprText: string,
  decls: Declaration[],
  copyProv: Map<string, string>,
  beforeIdx: number,
  depth = 0,
): string | null {
  if (depth > 5) return null;
  const trimmed = exprText.trim();
  const litMatch = trimmed.match(LITERAL_PATH_RE);
  if (litMatch) return join(root, litMatch[1]);
  const idMatch = trimmed.match(/^([A-Za-z_$][\w$]*)$/);
  if (idMatch) return resolveIdentifierToPath(idMatch[1], decls, copyProv, beforeIdx, depth + 1);
  return null;
}

function resolveIdentifierToPath(
  name: string,
  decls: Declaration[],
  copyProv: Map<string, string>,
  beforeIdx: number,
  depth = 0,
): string | null {
  if (depth > 5) return null;
  const decl = nearestDecl(decls, name, beforeIdx);
  if (decl) {
    const resolved = resolveExprToPath(decl.text, decls, copyProv, decl.start, depth + 1);
    if (resolved) return resolved;
  }
  if (copyProv.has(name)) {
    return resolveIdentifierToPath(copyProv.get(name) as string, decls, copyProv, beforeIdx, depth + 1);
  }
  return null;
}

// The first element of the args array in `"interpreter", [FIRST, ...], {...}`.
function extractFirstArrayElement(argsStripped: string): string | null {
  const head = argsStripped.match(/^\s*["'`][^"'`]*["'`]\s*,\s*\[\s*/);
  if (!head) return null;
  const start = head[0].length;
  let depth = 0;
  for (let i = start; i < argsStripped.length; i++) {
    const c = argsStripped[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return argsStripped.slice(start, i).trim();
      depth--;
    } else if (c === "," && depth === 0) {
      return argsStripped.slice(start, i).trim();
    }
  }
  return null;
}

const standaloneCache = new Map<string, boolean>();

// True if the on-disk script at `path` never itself mentions any of the six
// trigger literals outside a comment -- i.e. it genuinely cannot reach
// prepare_x8_environment()/prepare_p1_12_local_environment(), so no caller
// of it needs an isolation marker no matter what env it passes. Comment
// syntax is chosen by extension (`#` for .sh, `//`/`/* */` for everything
// else this guard resolves a script path to, i.e. .mjs).
function isStandaloneScript(path: string): boolean | null {
  if (!existsSync(path)) return null;
  const cached = standaloneCache.get(path);
  if (cached !== undefined) return cached;
  const raw = readFileSync(path, "utf8");
  const stripped = path.endsWith(".sh") ? stripShellComments(raw) : stripJsComments(raw);
  const ok = !ALL_TRIGGER_LITERALS.some((l) => stripped.includes(l));
  standaloneCache.set(path, ok);
  return ok;
}

interface Violation {
  file: string;
  line: number;
  snippet: string;
}

interface ScanResult {
  considered: number;
  exempt: Record<string, number>;
  unparsed: { file: string; line: number }[];
  violationsByFile: Map<string, Violation[]>;
  elapsedMs: number;
}

function categoriesOf(text: string): Set<"x8" | "p1_12"> {
  const cats = new Set<"x8" | "p1_12">();
  if (X8_TRIGGER_LITERALS.some((l) => text.includes(l))) cats.add("x8");
  if (P1_12_TRIGGER_LITERALS.some((l) => text.includes(l))) cats.add("p1_12");
  return cats;
}

function runScan(): ScanResult {
  const startedAt = Date.now();
  const files: string[] = [];
  for (const r of SCAN_ROOTS) files.push(...listTestFiles(r));

  let considered = 0;
  const exempt: Record<string, number> = {};
  const unparsed: { file: string; line: number }[] = [];
  const violationsByFile = new Map<string, Violation[]>();
  for (const f of files) violationsByFile.set(f, []);

  const bump = (label: string) => {
    exempt[label] = (exempt[label] ?? 0) + 1;
  };

  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    const fileCats = categoriesOf(stripJsComments(raw));
    if (fileCats.size === 0) continue; // file never touches X8/P1-12 -- nothing to check.

    const masked = maskForStructure(raw);
    const decls = collectDeclarations(raw, masked);
    const copyProv = collectCopyProvenance(masked);
    const isLocalX8 = file.startsWith(LOCAL_X8_DIR_PREFIX);

    SPAWN_CALL_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SPAWN_CALL_REGEX.exec(masked)) !== null) {
      const openParenIdx = match.index + match[0].length - 1;
      const closeParenIdx = findMatchingClose(masked, openParenIdx);
      const line = raw.slice(0, match.index).split("\n").length;
      if (closeParenIdx === -1) {
        // NIT-5: fixed by maskForStructure() masking comments/strings/regex
        // literals before this scan ever runs (see this file's header) --
        // this branch should be unreachable on real code. It is kept, and
        // counted rather than silently skipped, specifically so a genuine
        // future parser gap fails loudly (the aggregate coverage test below
        // asserts `unparsed.length === 0`) instead of quietly vanishing the
        // way the pre-2026-09-19-hardening version did.
        unparsed.push({ file, line });
        continue;
      }
      considered++;

      const callRawFull = raw.slice(match.index, closeParenIdx + 1);
      const callStripped = stripJsComments(callRawFull);
      const callCats = categoriesOf(callStripped);
      const effectiveCats = callCats.size > 0 ? callCats : fileCats;

      const argsText = raw.slice(openParenIdx + 1, closeParenIdx);
      const argsStripped = stripJsComments(argsText);

      // ── EXEMPTION 1: `bash -n <script>` / `bash -c 'bash -n ...'` ──────
      // A syntax-only check -- it never sources the file or calls
      // prepare_x8_environment()/prepare_p1_12_local_environment(), so
      // there is no runtime directory to isolate.
      if (/^\s*["'`]bash["'`]\s*,\s*\[\s*["'`]-n["'`]/.test(argsStripped)) {
        bump("bash -n");
        continue;
      }
      if (
        /^\s*["'`]bash["'`]\s*,\s*\[\s*["'`]-c["'`]\s*,\s*["'`][\s;]*(?:bash -n \S+[\s;]*)+["'`]/.test(argsStripped)
      ) {
        bump("bash -c 'bash -n ...'");
        continue;
      }

      // ── EXEMPTION 2: `docker compose version` capability probe ────────
      // Never reads docker-compose.yml and takes no path derived from
      // X8_RUNTIME_DIR/P1_12_RUNTIME_DIR -- it only answers "is docker
      // compose installed", ahead of a real (isolated) config/up call.
      if (/^\s*["'`]docker["'`]\s*,\s*\[\s*["'`]compose["'`]\s*,\s*["'`]version["'`]/.test(argsStripped)) {
        bump("docker compose version");
        continue;
      }

      // ── direct / variable-hop isolation marker ─────────────────────────
      let requiredMarkers = effectiveCats.has("x8") ? X8_MARKERS : P1_12_MARKERS;
      if (isLocalX8) requiredMarkers = [...requiredMarkers, ...LOCAL_X8_MARKERS];
      let isolated = requiredMarkers.some((mk) => callStripped.includes(mk));
      if (!isolated) {
        const maskedCall = masked.slice(match.index, closeParenIdx + 1);
        const envRe = /(?<!\.)\benv\b\s*(:)?/g;
        const idents: string[] = [];
        let em: RegExpExecArray | null;
        while ((em = envRe.exec(maskedCall)) !== null) {
          const absPos = match.index + em.index;
          if (em[1] === ":") {
            const exprStart = absPos + em[0].length;
            let depth = 0;
            let end = closeParenIdx;
            for (let i = exprStart; i <= closeParenIdx; i++) {
              const c = masked[i];
              if (c === "(" || c === "[" || c === "{") depth++;
              else if (c === ")" || c === "]" || c === "}") {
                if (depth === 0) {
                  end = i;
                  break;
                }
                depth--;
              } else if (c === "," && depth === 0) {
                end = i;
                break;
              }
            }
            const exprRaw = raw.slice(exprStart, end);
            if (requiredMarkers.some((mk) => stripJsComments(exprRaw).includes(mk))) {
              isolated = true;
              break;
            }
            for (const id of exprRaw.match(/\b[A-Za-z_$][\w$]*\b/g) ?? []) idents.push(id);
          } else {
            idents.push("env"); // object-shorthand `{ env }`
          }
        }
        if (!isolated) {
          for (const id of idents) {
            const decl = nearestDecl(decls, id, match.index);
            if (decl && requiredMarkers.some((mk) => stripJsComments(decl.text).includes(mk))) {
              isolated = true;
              break;
            }
          }
        }
      }
      if (isolated) continue;

      // ── EXEMPTION 3: `docker compose config` ───────────────────────────
      // A pure, read-only render of docker-compose.yml -- `config` never
      // creates, starts, or writes anything (unlike `up`/`create`), so it
      // cannot touch a runtime directory regardless of which env values
      // reach it. Both real call sites in this repo pass a fully explicit
      // env object (never a bare `process.env` spread) anyway:
      // tests/backend/runtime/p1-12-compose-contract.test.ts's `runConfig`
      // helper takes its env as a function PARAMETER (so this guard's
      // variable-hop resolution cannot see into its caller), and
      // tests/backend/flags/tagging-flags-passthrough.test.ts's
      // `minimalEnv` (that file does not currently trigger this guard at
      // all -- its only mention of x8-production-like-env.sh is inside a
      // comment -- but would hit this same exemption if it ever did).
      if (/^\s*["'`]docker["'`][\s\S]*?["'`]compose["'`][\s\S]*?["'`]config["'`]/.test(argsStripped)) {
        bump("docker compose config");
        continue;
      }

      // ── EXEMPTION 4/5: standalone script target (incl. a tmpdir copy) ──
      // The call's own script-path argument resolves (through at most a
      // few hops of `const NAME = ...` / `copyFileSync(SRC, DEST)`
      // indirection) to a real, on-disk, non-core script whose own content
      // never mentions any trigger literal outside a comment -- verified
      // directly against that file's current content (isStandaloneScript()),
      // not just its path, so this can never be fooled by a script that
      // happens to live under e.g. scripts/db/ but was edited to source
      // the env lib after all. Confirmed instances as of this hardening:
      // scripts/db/wal-gc-x8.sh (tests/backend/database/wal-gc-x8.test.ts,
      // including its `wrapperCopy` tmpdir copy, resolved via
      // copyFileSync() provenance), infra/production-like/backup-timer.sh
      // (tests/backend/database/backup-timer-static.test.ts), and
      // scripts/acceptance/x8-validate-compose.mjs
      // (tests/backend/runtime/x8-production-like-contract.test.ts). This
      // deliberately does NOT cover infra/local-x8/wal-gc-daily-apply.sh or
      // scripts/x8-local-wal-gc-launchd.sh -- both DO reference
      // "x8-production-like.sh" in real code (see this file's header) --
      // those are handled by LOCAL_X8_MARKERS above instead.
      const firstEl = extractFirstArrayElement(argsStripped);
      if (firstEl) {
        const resolved = resolveExprToPath(firstEl, decls, copyProv, match.index);
        if (resolved && !CORE_TRIGGER_SCRIPTS.has(resolved) && (resolved.endsWith(".sh") || resolved.endsWith(".mjs"))) {
          if (isStandaloneScript(resolved)) {
            bump(`standalone script: ${resolved.slice(root.length + 1)}`);
            continue;
          }
        }
      }

      const rel = file.slice(root.length + 1);
      violationsByFile.get(file)?.push({
        file: rel,
        line,
        snippet: callStripped.replace(/\s+/g, " ").trim().slice(0, 300),
      });
    }
  }

  return { considered, exempt, unparsed, violationsByFile, elapsedMs: Date.now() - startedAt };
}

const SCAN = runScan();

describe("runtime-dir isolation guard (2026-09-19, hardened to file scope)", () => {
  const files = Array.from(SCAN.violationsByFile.keys());

  it("scanned at least one test file (guards against a vacuous pass)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("SCAN_ROOTS matches vitest.config.ts's own node-project `include` globs (P2-2)", () => {
    const configSource = readFileSync(VITEST_CONFIG_PATH, "utf8");
    for (const glob of SCAN_ROOT_GLOBS) {
      expect(configSource, `vitest.config.ts should still list "${glob}"`).toContain(`"${glob}"`);
    }
  });

  it.each(files.map((file) => [file.slice(root.length + 1), file] as const))(
    "%s: every spawn/exec call in this file (once the file mentions an X8/P1-12 trigger literal anywhere) is isolated or exempt",
    (_relativePath, file) => {
      const violations = SCAN.violationsByFile.get(file) ?? [];
      expect(
        violations,
        violations
          .map((v, index) => `violation ${index + 1} [${v.file}:${v.line}]:\n${v.snippet}`)
          .join("\n---\n"),
      ).toEqual([]);
    },
  );

  it("every matched spawn/exec call site has balanced, parseable structure (NIT-5: no silent skip)", () => {
    expect(
      SCAN.unparsed,
      SCAN.unparsed.map((u) => `${u.file.slice(root.length + 1)}:${u.line}`).join(", "),
    ).toEqual([]);
  });

  it("file-scoped coverage considers far more spawn calls than the old call-scoped design (baseline: 6 of 89 measured on HEAD 8bbd25d before this hardening)", () => {
    const total = SCAN.considered + Object.values(SCAN.exempt).reduce((a, b) => a + b, 0);
    const message = [
      `considered=${SCAN.considered}`,
      `exempt=${JSON.stringify(SCAN.exempt)}`,
      `violations=${Array.from(SCAN.violationsByFile.values()).reduce((a, v) => a + v.length, 0)}`,
      `unparsed=${SCAN.unparsed.length}`,
      `totalSpawnCallsAcrossTriggeringFiles=${total}`,
      `elapsedMs=${SCAN.elapsedMs}`,
    ].join(" ");
    // "Considered" here counts every spawn call in a file that mentions a
    // trigger literal anywhere (this guard's new unit of coverage) -- NOT
    // every spawn call that itself carries the literal inline (the old
    // unit, which measured 6/89 on this same tree before this hardening).
    expect(SCAN.considered, message).toBeGreaterThan(40);
  });
});
