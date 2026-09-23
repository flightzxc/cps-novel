/**
 * Keeps the cross-agent governance from rotting (2026-09-18).
 *
 * The arrangement: one workflow source of truth
 * (`docs/governance/AI_WORKFLOW.md`) and three per-agent bootstraps that point
 * at it — `CLAUDE.md` (Claude Code), `AGENTS.md` (Codex + generic) and
 * `.cursor/rules/repository-governance.mdc` (Cursor). The failure mode this
 * guards is specific and has already happened once in this repo with
 * `development-log.md`: a governance artefact that nobody's build touches
 * quietly stops describing reality. Three hand-maintained bootstraps are three
 * chances for exactly that, and the damage is worse — each agent would be
 * working from its own version of "the project rules".
 *
 * Runs in CI via the ordinary `npm test` (`.github/workflows/ci.yml`), so no
 * separate workflow has to be kept in sync either.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const WORKFLOW_PATH = "docs/governance/AI_WORKFLOW.md";

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

/**
 * Every file an agent reads automatically. `budgetLines` is the thin-adapter
 * guard: a bootstrap that starts absorbing rule text grows, and growth is the
 * cheapest reliable signal of that. `CLAUDE.md` has a larger budget because it
 * is not only a bootstrap — it is the architecture-facts source of truth in its
 * own right (see `AI_WORKFLOW.md`'s "两个真源" section).
 */
const ENTRYPOINTS = [
  { agent: "Claude Code", file: "CLAUDE.md", budgetLines: 400 },
  { agent: "Codex / generic", file: "AGENTS.md", budgetLines: 60 },
  { agent: "Cursor", file: ".cursor/rules/repository-governance.mdc", budgetLines: 40 },
] as const;

describe("cross-agent governance entrypoints", () => {
  it.each(ENTRYPOINTS)("$agent bootstrap ($file) exists and points at the one workflow source", ({ file }) => {
    const source = read(file);
    expect(source).toContain(WORKFLOW_PATH);
  });

  it.each(ENTRYPOINTS)("$agent bootstrap ($file) stays a thin adapter", ({ file, budgetLines }) => {
    const lines = read(file).split("\n").length;
    expect(
      lines,
      `${file} is ${lines} lines (budget ${budgetLines}). Bootstraps point at ${WORKFLOW_PATH}; they do not restate it.`,
    ).toBeLessThanOrEqual(budgetLines);
  });

  it("the workflow source names every bootstrap, so adding a fourth agent cannot be forgotten", () => {
    const workflow = read(WORKFLOW_PATH);
    for (const { file } of ENTRYPOINTS) {
      expect(workflow, `${WORKFLOW_PATH} must name ${file}`).toContain(file);
    }
  });

  it("the Cursor adapter is Always Apply — a rule Cursor only loads on request is not an entrypoint", () => {
    const source = read(".cursor/rules/repository-governance.mdc");
    expect(source.startsWith("---")).toBe(true);
    expect(source).toMatch(/^alwaysApply:\s*true\s*$/m);
  });

  /**
   * The Cursor adapter is the one the Owner called out explicitly as "薄适配层,
   * 禁止复制完整规则". These are the concrete rule details — if any appears
   * there, the adapter has started being a second rulebook.
   */
  it.each([
    "Agent:",
    "Reviewed-By-Agent:",
    "generate-changelog.mjs",
    "x8-production-like.sh",
  ])("the Cursor adapter does not restate rule detail (%s)", (detail) => {
    expect(read(".cursor/rules/repository-governance.mdc")).not.toContain(detail);
  });

  /**
   * `AGENTS.md` is allowed a short reminder list (a Codex session may not
   * follow a link before acting), but it must not be able to invent a rule the
   * source of truth does not have — that is how two versions of the rules are
   * born.
   */
  it.each([
    "Agent:",
    "Model:",
    "Reviewed-By-Agent:",
    "Reviewed-By-Model:",
    "generate-changelog.mjs",
    "development-log.md",
    "docs/adr/",
    "database-schema-dictionary.jsonl",
  ])("every rule AGENTS.md mentions (%s) also exists in the workflow source", (detail) => {
    const agents = read("AGENTS.md");
    if (!agents.includes(detail)) return; // not summarized there — nothing to keep in sync
    expect(read(WORKFLOW_PATH), `${WORKFLOW_PATH} must be the source for "${detail}"`).toContain(detail);
  });

  /**
   * Updated 2026-09-23 (Owner decision, v0.3.0): the log's pre-2026-09-07
   * per-commit style stays retired, but the file itself is no longer purely
   * historical -- it resumed for release-level entries only (one per formal
   * release), so the old "stays frozen" wording would now be false. This
   * checks the new policy is stated and still links back to the one workflow
   * source, which is the invariant this file actually guards.
   */
  it("the development log documents the v0.3.0 release-level policy and points at the workflow source", () => {
    const log = read("docs/governance/development-log.md");
    expect(log).toContain("发版级");
    expect(log).toContain("v0.3.0");
    expect(log).toContain("冻结"); // pre-2026-09-07 per-commit entries remain frozen/historical
    expect(log).toContain(WORKFLOW_PATH.split("/").pop());
  });

  it("the generated CHANGELOG declares that it is generated", () => {
    const changelog = read("CHANGELOG.md");
    expect(changelog).toContain("generate-changelog.mjs");
    expect(changelog).toContain("请勿手工编辑");
  });
});
