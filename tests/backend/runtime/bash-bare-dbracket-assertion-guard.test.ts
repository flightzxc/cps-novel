import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Static regression guard for the macOS bash 3.2.57 "bare `[[ ]]` doesn't
 * trip `set -e`" defect found during the B-16 runner-lint round (2026-09-27).
 *
 * macOS ships a stock `/bin/bash` frozen at 3.2.57 (GPLv3 licensing means
 * Apple never upgrades it). That version has a real, reproducible bug:
 * `set -e` does NOT abort a script when a bare `[[ ... ]]` standalone
 * statement evaluates false -- `[ ]`, `test`, `false`, and every ordinary
 * external command correctly abort the script under `set -e`; only the
 * bash-builtin `[[ ]]` keyword, used as a whole statement by itself, does
 * not. Minimal reproduction (verified on this machine):
 *   bash -c 'set -e; [[ a == b ]]; echo should-not-print'   # prints it anyway
 * Six restore-parity assertions in run-p1-06-postgres-verification.sh were
 * written this way and had silently never enforced anything since they were
 * added -- discovered only when B-16's mutation test (deliberately breaking
 * the expected value) still produced a PASS. This guard prevents the same
 * silent-no-op shape from being reintroduced anywhere else in scripts/ or
 * infra/, and this round's sweep already fixed every pre-existing instance
 * (see run-x2/x6/p1-08b/p1-12/p1-13/verify-nginx-matrix/x8-production-like/
 * backup-loop -- commit history for the full list).
 *
 * ── What counts as a violation ──────────────────────────────────────────
 * A physical line whose trimmed content:
 *   - starts with `[[ ` (the *entire* statement is a double-bracket test --
 *     `if [[ ... ]]; then`, `while [[ ... ]]; do`, etc. do NOT start with
 *     `[[`, so they are never flagged), AND
 *   - closes `]]` on that SAME line, with nothing after it except an
 *     optional trailing `#` comment (so `[[ ... ]] || { ... }`,
 *     `[[ ... ]] && action`, and multi-line/continued `[[ ... ]]` statements
 *     are never flagged -- those are either already guarded or are outside
 *     this simple line-scoped detector's contract, exactly as agreed for
 *     this round), AND
 *   - does not carry the `# bare-dbracket-ok: function return` exemption
 *     comment, which marks the two known, legitimate uses of a bare
 *     `[[ ]]` as a function's own return value (scripts/preproduction/lib.sh
 *     and infra/production-like/alerts/alert-lib.sh) -- that pattern is
 *     correct because the CALLER checks the function's exit status via
 *     `if fn; then`/`fn && ...`, never via implicit `set -e` propagation
 *     out of the bare `[[ ]]` itself, so the 3.2 bug does not apply to it.
 *
 * Fix shape: `if ! [[ ... ]]; then echo "reason" >&2; exit 1; fi`, or
 * `[[ ... ]] || { echo "reason" >&2; exit 1; }` -- same condition, made to
 * actually enforce.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const SCAN_DIRS = ["scripts", "infra"];
const EXEMPTION_MARKER = "bare-dbracket-ok: function return";
// Must start the trimmed line with `[[`, close `]]` on the same line, and
// have nothing after it but an optional `#`-comment.
const BARE_DBRACKET_LINE = /^\[\[\s.*\]\]\s*(#.*)?$/;

function collectShellFiles(dir: string): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      results.push(...collectShellFiles(full));
    } else if (info.isFile() && entry.endsWith(".sh")) {
      results.push(full);
    }
  }
  return results;
}

function findBareDoubleBracketLines(source: string): number[] {
  const violations: number[] = [];
  source.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (!BARE_DBRACKET_LINE.test(trimmed)) return;
    // `.*` is greedy, so `BARE_DBRACKET_LINE` alone would also match a
    // *chained* line like `[[ A ]] && [[ B ]]` (two separate bracket tests
    // joined by `&&`/`||` -- an intentional, already-safe pattern the
    // coordinator explicitly carved out, e.g. nginx_is_running() in
    // scripts/x8-production-like.sh) by spanning from the first `[[` to the
    // last `]]`. A genuine single bare assertion -- even one with `&&`/`||`
    // *inside* its own brackets, like
    // `[[ "$a" -gt 0 && "$a" == "$b" ]]` -- has exactly one `[[` and one
    // `]]` in the whole line; a chained/compound line has two or more of
    // each. Require exactly one of each to tell them apart.
    const openCount = (trimmed.match(/\[\[/g) ?? []).length;
    const closeCount = (trimmed.match(/\]\]/g) ?? []).length;
    if (openCount !== 1 || closeCount !== 1) return;
    if (trimmed.includes(EXEMPTION_MARKER)) return;
    violations.push(index + 1);
  });
  return violations;
}

describe("bash 3.2 裸 [[ ]] 断言静态守卫", () => {
  it("scripts/ 与 infra/ 下的 *.sh 不能有单独成行、依赖 set -e 才生效的裸 [[ ]] 断言", () => {
    const files = SCAN_DIRS.flatMap((dir) => collectShellFiles(join(ROOT, dir)));
    expect(files.length).toBeGreaterThan(10);

    const problems: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const line of findBareDoubleBracketLines(source)) {
        problems.push(`${relative(ROOT, file)}:${line}`);
      }
    }

    expect(
      problems,
      [
        "以下位置是单独成行的裸 `[[ ... ]]` 断言——在 macOS 系统 bash 3.2.57 下",
        "set -e 不会因为它判假而中止脚本，断言形同虚设（[ ]/test/false 都正常，",
        "只有 [[ ]] 不会）。改成 `if ! [[ ... ]]; then echo 原因 >&2; exit 1; fi`",
        "或者 `[[ ... ]] || { echo 原因 >&2; exit 1; }`；如果这一行本来就是函数体",
        "最后一行、故意用来做函数返回值，就在行尾加注释",
        "`# bare-dbracket-ok: function return`。",
        "",
        ...problems,
      ].join("\n"),
    ).toEqual([]);
  });

  // 探测器本身的正确性——用合成样例钉死"哪些该抓、哪些不该抓"，避免以后
  // 有人"优化"正则时把误判率改坏了都没人发现。行号见下面每行的注释。
  it("探测规则本身：抓裸断言，放过 if/while、||/&&、跨行、豁免注释、链式 [[ ]]", () => {
    const sample = [
      '[[ "$a" == "$b" ]]', // 1: 裸断言 -- 抓
      'if [[ "$a" == "$b" ]]; then', // 2: if 条件 -- 放过
      'while [[ $# -gt 0 ]]; do', // 3: while 条件 -- 放过
      '[[ "$a" == "$b" ]] || { echo bad; exit 1; }', // 4: 已用 || 短路 -- 放过
      '[[ "$a" == "$b" ]] && do_thing', // 5: 有意的 && 条件写法 -- 放过
      '[[ -n "$x" ]] && [[ "$x" == "y" ]]', // 6: 两个 [[ ]] 链在一起（函数返回值那类写法）-- 放过
      '[[ "$a" == "$b" ]] # bare-dbracket-ok: function return', // 7: 有豁免注释 -- 放过
      '[[ "$a" \\', // 8: 续行开头，本行没闭合 -- 放过
      '  == "$b" ]]', // 9: 续行结尾，本行不是以 [[ 开头 -- 放过
      '  [[ "$nested" == "indented" && "$other" == "z" ]]', // 10: 缩进的裸断言，内部有 && 但只有一对 [[ ]] -- 抓
    ].join("\n");
    expect(findBareDoubleBracketLines(sample)).toEqual([1, 10]);
  });
});
