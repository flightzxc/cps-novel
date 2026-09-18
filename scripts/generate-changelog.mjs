#!/usr/bin/env node
/**
 * Generates `CHANGELOG.md` from git — never hand-written.
 *
 * Why generated: `docs/governance/development-log.md` was the hand-written
 * version of this and went eleven days / ten-plus substantive changes stale
 * before anyone noticed (see its own freeze banner). Commit messages, tags and
 * trailers are attached to the commits themselves, so this view cannot drift
 * from the code the way a maintained file can.
 *
 * Attribution reads the structured trailers `docs/governance/AI_WORKFLOW.md`
 * prescribes:
 *
 *     Agent: claude-code
 *     Model: Claude Opus 5
 *     Reviewed-By-Agent: claude-code
 *     Reviewed-By-Model: Fable 5.1
 *
 * `Co-Authored-By:` is still parsed so history written before that convention
 * (every commit up to 2026-09-18) keeps its attribution instead of silently
 * reading as anonymous.
 *
 *   node scripts/generate-changelog.mjs           # print to stdout
 *   node scripts/generate-changelog.mjs --write   # write CHANGELOG.md
 *   node scripts/generate-changelog.mjs --since <rev>
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Separators built from NUL, which `git log` can never emit inside a subject
 * or body — so a commit message containing newlines, pipes or the word
 * "RECORD" still parses correctly.
 */
const NUL = String.fromCharCode(0);
const RECORD = `${NUL}RECORD${NUL}`;
const FIELD = `${NUL}FIELD${NUL}`;
const TAB = String.fromCharCode(9);
/**
 * The same separators as git-side format placeholders. Node refuses to spawn a
 * process with a NUL inside an argv entry, so the separators have to reach git
 * as `%x00` and only become real NULs in its *output*.
 */
const RECORD_FMT = "%x00RECORD%x00";
const FIELD_FMT = "%x00FIELD%x00";

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** `sha -> [tag]`, so a commit can be rendered under the release it belongs to. */
function tagsBySha() {
  const map = new Map();
  const output = git(["tag", "--format=%(refname:short)%09%(objectname)%09%(*objectname)"]).trim();
  if (!output) return map;
  for (const line of output.split("\n")) {
    const [tag, objectName, peeled] = line.split(TAB);
    // An annotated tag's own object is the tag, not the commit; `*objectname`
    // is the peeled commit and must win when present.
    const sha = peeled || objectName;
    if (!sha) continue;
    const existing = map.get(sha) ?? [];
    existing.push(tag);
    map.set(sha, existing);
  }
  return map;
}

function parseTrailers(body) {
  const trailers = new Map();
  for (const raw of body.split("\n")) {
    const match = /^([A-Za-z][A-Za-z0-9-]*):\s*(.+?)\s*$/.exec(raw.trim());
    if (!match) continue;
    const key = match[1].toLowerCase();
    const existing = trailers.get(key) ?? [];
    existing.push(match[2]);
    trailers.set(key, existing);
  }
  return trailers;
}

/**
 * Structured trailers win; `Co-Authored-By` is the legacy fallback. Its value
 * is `Name <email>` — only the name is attribution, the address is noise here.
 */
function attribution(trailers) {
  const agent = trailers.get("agent")?.[0];
  const model = trailers.get("model")?.[0];
  if (agent || model) return [agent, model].filter(Boolean).join(" · ");
  const legacy = trailers.get("co-authored-by")?.[0];
  if (!legacy) return null;
  return legacy.replace(/\s*<[^>]*>\s*$/, "").trim() || null;
}

function reviewer(trailers) {
  const parts = [trailers.get("reviewed-by-agent")?.[0], trailers.get("reviewed-by-model")?.[0]];
  const present = parts.filter(Boolean);
  return present.length > 0 ? present.join(" · ") : null;
}

export function collectCommits(since) {
  const range = since ? [`${since}..HEAD`] : [];
  const format = ["%H", "%h", "%ad", "%s", "%b"].join(FIELD_FMT) + RECORD_FMT;
  const output = git(["log", "--date=short", `--pretty=format:${format}`, ...range]);
  return output
    .split(RECORD)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [sha, shortSha, date, subject, body = ""] = chunk.split(FIELD);
      const trailers = parseTrailers(body);
      return {
        sha,
        shortSha,
        date,
        subject,
        attribution: attribution(trailers),
        reviewer: reviewer(trailers),
      };
    });
}

export function render(commits, tagMap) {
  const lines = [
    "# CHANGELOG",
    "",
    "<!-- 本文件由 `node scripts/generate-changelog.mjs --write` 生成，请勿手工编辑。 -->",
    "<!-- 叙述性内容写进 commit message；Owner/架构决策写 docs/adr/。 -->",
    "",
    `生成时间：${new Date().toISOString().slice(0, 10)} · 共 ${commits.length} 个 commit`,
  ];
  let unattributed = 0;
  for (const commit of commits) {
    const tags = tagMap.get(commit.sha);
    if (tags && tags.length > 0) lines.push("", `## ${tags.join(" / ")}`, "");
    const suffix = [];
    if (commit.attribution) suffix.push(commit.attribution);
    else unattributed += 1;
    if (commit.reviewer) suffix.push(`reviewed: ${commit.reviewer}`);
    const tail = suffix.length > 0 ? `  — _${suffix.join(" · ")}_` : "";
    lines.push(`- \`${commit.shortSha}\` ${commit.date} ${commit.subject}${tail}`);
  }
  lines.push("", `<!-- 无署名 commit：${unattributed} -->`, "");
  return lines.join("\n");
}

function main() {
  const commits = collectCommits(option("--since"));
  const rendered = render(commits, tagsBySha());
  if (process.argv.includes("--write")) {
    const target = path.join(ROOT, "CHANGELOG.md");
    writeFileSync(target, rendered);
    process.stderr.write(`wrote ${path.relative(ROOT, target)} (${commits.length} commits)\n`);
    return;
  }
  process.stdout.write(rendered);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
