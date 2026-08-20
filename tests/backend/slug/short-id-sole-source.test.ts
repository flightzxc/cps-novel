/**
 * `src/lib/slug/README.md`: "🔴 全项目唯一的公开短码生成入口" for
 * `Article.publicPageShortId` (page identity — distinct from and never to be
 * confused with `src/lib/redirect/`'s `public_redirect_code`). This test
 * statically scans for a second generation site, in the same spirit and
 * with the same scope discipline as
 * `tests/backend/publish-gate/no-bypass.test.ts` (whose header this test's
 * structure directly mirrors):
 *
 * - **Roots scanned**: `src/`, `worker/`, `scheduler/`, `scripts/`, `.ts`/
 *   `.tsx` only — same roots as `no-bypass.test.ts`, for the same reason
 *   (CLAUDE.md §3.2 assigns runtime/tooling business code to all four).
 * - **Signal 1 — write-site scope**: any `.article.<create|createMany|
 *   createManyAndReturn|update|updateMany|updateManyAndReturn|upsert>(` call
 *   whose arguments contain a `publicPageShortId:` key, found outside
 *   `src/server/content-creation/` (the one authorized call site). Scoped to
 *   `.article.` specifically — a bare `.update(` sweep would false-positive
 *   on every other model's legitimate field writes.
 * - **Signal 2 — algorithm duplication targeting *this* column**: a file
 *   (other than `src/lib/slug/short-id.ts` itself) that contains BOTH (a)
 *   this module's exact alphabet string literal
 *   (`PUBLIC_PAGE_SHORT_ID_ALPHABET`'s value) AND (b) a textual reference to
 *   this field's own name (`publicPageShortId` or its `@map`-ed column
 *   `public_page_short_id`). Catches a copy-pasted reimplementation even if
 *   it never touches `.article.` directly (e.g. a helper file that only
 *   returns a candidate string) — as long as the duplicate, like any real
 *   attempt to feed `Article.publicPageShortId`, actually names its target
 *   somewhere (a write-site key, a function/variable name, a doc comment).
 *
 *   🔴 P0-S10 (2026-08-20) narrowed this from "alphabet literal alone" after
 *   it false-positived on `src/lib/redirect/public-redirect-code.ts`. That
 *   file is a *second, independently legitimate* generator per CLAUDE.md
 *   §3.2.1/§5 修正 6 — different target column (`publicRedirectCode` /
 *   `public_redirect_code`, not `publicPageShortId`), different Owner
 *   (Codex, under `src/lib/redirect/`, guarded by its own
 *   `tests/backend/redirect/no-bypass.test.ts`), different length (10 vs 8).
 *   It shares this generator's alphabet only because both were `ADAPT`-ed
 *   from the same CPS source (`docs/governance/port-registry.md`) — sharing
 *   a 36-character lowercase-alphanumeric charset is not evidence of
 *   duplication on its own; CLAUDE.md's own text sanctions exactly this. The
 *   semantic boundary this signal now enforces is narrower but still real:
 *   "nobody else reimplements *this specific field's* short-id algorithm",
 *   not "nobody else ever uses this character set for anything". A
 *   hypothetical bypass — someone copy-pasting this module's alphabet into a
 *   new helper intended to feed `Article.publicPageShortId` — would still be
 *   caught, because writing such a helper without ever naming its own target
 *   column anywhere in the file would be unusual to the point of being its
 *   own code-review red flag, and any realistic version of it (a write-site
 *   key, a `generatePublicPageShortId`-shaped name, a doc comment) still
 *   trips this signal.
 *
 * 🔴 Known coverage, not a full-coverage guarantee — same caveat
 * `no-bypass.test.ts` states explicitly: dynamically computed model/method
 * names, raw SQL string-built outside a scanned call's immediate arguments,
 * a differently-shaped duplicate alphabet, or a duplicate that never
 * textually names `publicPageShortId`/`public_page_short_id` anywhere in the
 * file all sit outside what this source scan can see. A clean scan narrows
 * the search space; it does not prove no second entry point exists by
 * construction.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PUBLIC_PAGE_SHORT_ID_ALPHABET } from "@/lib/slug/short-id";

const SCAN_ROOTS = ["src", "worker", "scheduler", "scripts"].map((dir) => path.resolve(process.cwd(), dir));
const ALLOWED_WRITE_ROOT = path.resolve(process.cwd(), "src/server/content-creation");
const ALLOWED_ALPHABET_FILE = path.resolve(process.cwd(), "src/lib/slug/short-id.ts");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectSourceFiles(target);
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) return [];
      return [target];
    }),
  );
  return nested.flat();
}

/** Balanced-paren extraction of the argument list following `matchEnd` (the index right after the call's opening `(`). Same helper shape as `no-bypass.test.ts`. */
function extractCallArgs(source: string, matchEnd: number): string {
  let depth = 1;
  let i = matchEnd;
  for (; i < source.length && depth > 0; i += 1) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") depth -= 1;
  }
  return source.slice(matchEnd, i);
}

const ARTICLE_WRITE_CALL = /\.article\.(update|updateMany|updateManyAndReturn|create|createMany|createManyAndReturn|upsert)\(/g;
const SETS_SHORT_ID_KEY = /\bpublicPageShortId\s*:/;

function findWriteSiteViolations(source: string): string[] {
  const hits: string[] = [];
  for (const match of source.matchAll(ARTICLE_WRITE_CALL)) {
    const args = extractCallArgs(source, (match.index ?? 0) + match[0].length);
    if (SETS_SHORT_ID_KEY.test(args)) {
      hits.push(`.article.${match[1]}(...) writes a publicPageShortId key`);
    }
  }
  return hits;
}

/**
 * Strips comments before Signal 2's target-column check runs, so that prose
 * merely *discussing* `publicPageShortId` (e.g. `public-redirect-code.ts`'s
 * own header, which contrasts itself against "CPS's `publicPageShortId`" to
 * document why it is a *different* field) does not count as code targeting
 * it. Only code-shaped occurrences — an object key, a property access, an
 * identifier — should trip this signal.
 *
 * Deliberately simple (regex, not a real tokenizer/parser), matching the
 * fidelity of every other check in this file: block comments are removed
 * outright, and a `//` is only treated as a line comment when preceded by
 * whitespace (or line start) — `://` inside a string like `"https://..."` is
 * immediately preceded by `:`, not whitespace, so it survives untouched.
 * This is a heuristic, not a guarantee — see the module header's "known
 * coverage" caveat.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

/**
 * References this field's own name in actual code — either the Prisma model
 * field (`publicPageShortId`) or its `@map`-ed column (`public_page_short_id`).
 * This is the "targets the same column" half of Signal 2: a file sharing the
 * alphabet literal without ever naming this field in code is presumed to be
 * an independent generator for a *different* target (see module header)
 * rather than a duplicate of this one.
 */
const TARGETS_SHORT_ID_COLUMN_RE = /\bpublicPageShortId\b|\bpublic_page_short_id\b/;

/** Signal 2: alphabet literal anywhere in the file + a code-level (non-comment) reference to this field's own name. See module header for why the alphabet literal alone is not sufficient. */
function reimplementsShortIdGenerator(source: string): boolean {
  if (!source.includes(PUBLIC_PAGE_SHORT_ID_ALPHABET)) return false;
  return TARGETS_SHORT_ID_COLUMN_RE.test(stripComments(source));
}

describe("Article.publicPageShortId sole-generation-entry-point regression", () => {
  it("no write outside src/server/content-creation/ sets Article.publicPageShortId", async () => {
    const allFiles = (await Promise.all(SCAN_ROOTS.map(collectSourceFiles))).flat();
    const violations: Array<{ file: string; hits: string[] }> = [];
    for (const file of allFiles) {
      if (file.startsWith(ALLOWED_WRITE_ROOT)) continue;
      const source = await readFile(file, "utf8");
      const hits = findWriteSiteViolations(source);
      if (hits.length > 0) violations.push({ file: path.relative(process.cwd(), file), hits });
    }
    expect(violations).toEqual([]);
  });

  it("no file other than src/lib/slug/short-id.ts reimplements this generator (alphabet literal + publicPageShortId target)", async () => {
    const allFiles = (await Promise.all(SCAN_ROOTS.map(collectSourceFiles))).flat();
    const violations: string[] = [];
    for (const file of allFiles) {
      if (file === ALLOWED_ALPHABET_FILE) continue;
      const source = await readFile(file, "utf8");
      if (reimplementsShortIdGenerator(source)) {
        violations.push(path.relative(process.cwd(), file));
      }
    }
    expect(violations).toEqual([]);
  });

  it("sanity: detects the pattern it exists to catch", () => {
    const bypass = `
      export async function backfillShortId(db, id) {
        return db.article.update({ where: { id }, data: { publicPageShortId: "abcd1234" } });
      }
    `;
    expect(findWriteSiteViolations(bypass)).toEqual([".article.update(...) writes a publicPageShortId key"]);
  });

  it("sanity: detects create/upsert too, not just update", () => {
    expect(
      findWriteSiteViolations('db.article.create({ data: { publicPageShortId: generatePublicPageShortIdCandidate() } })'),
    ).toEqual([".article.create(...) writes a publicPageShortId key"]);
    expect(
      findWriteSiteViolations(
        'db.article.upsert({ where: { id }, create: { publicPageShortId: x }, update: {} })',
      ),
    ).toEqual([".article.upsert(...) writes a publicPageShortId key"]);
  });

  it("sanity: does not false-positive on a plain read/select", () => {
    const readOnly = `
      const rows = await db.article.findMany({ select: { id: true, publicPageShortId: true } });
    `;
    expect(findWriteSiteViolations(readOnly)).toEqual([]);
  });

  it("sanity: does not false-positive on an unrelated model's write", () => {
    expect(findWriteSiteViolations('db.novel.update({ where: { id }, data: { businessId: x } });')).toEqual([]);
  });

  it("src/server/content-creation/service.ts is exactly the one place allowed to contain the write-site pattern", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src/server/content-creation/service.ts"), "utf8");
    expect(findWriteSiteViolations(source).length).toBeGreaterThan(0);
  });

  it("sanity (Signal 2): detects a copy-pasted duplicate that reuses the alphabet and names this field as its target", () => {
    const duplicate = `
      const ALPHABET = "${PUBLIC_PAGE_SHORT_ID_ALPHABET}";
      export function backfillCandidate() {
        return { publicPageShortId: ALPHABET[0] };
      }
    `;
    expect(reimplementsShortIdGenerator(duplicate)).toBe(true);
  });

  it("sanity (Signal 2): does not treat a mere comment mentioning the field as targeting it (the exact false-positive shape that motivated the comment strip)", () => {
    const commentOnly = `
      const ALPHABET = "${PUBLIC_PAGE_SHORT_ID_ALPHABET}";
      // unlike CPS's \`publicPageShortId\`, this generator targets a
      // completely different field.
      export function createUnrelatedCode() {
        return ALPHABET[0];
      }
    `;
    expect(reimplementsShortIdGenerator(commentOnly)).toBe(false);
  });

  it("sanity (Signal 2): does NOT false-positive on a sibling generator that shares the alphabet but targets a different column (src/lib/redirect/public-redirect-code.ts)", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "src/lib/redirect/public-redirect-code.ts"),
      "utf8",
    );
    // Sanity precondition: this sibling file really does share the alphabet
    // literal — otherwise this test would pass for the wrong reason.
    expect(source.includes(PUBLIC_PAGE_SHORT_ID_ALPHABET)).toBe(true);
    expect(reimplementsShortIdGenerator(source)).toBe(false);
  });

  it("sanity (Signal 2): does not false-positive on a file that names this field without sharing the alphabet", () => {
    const unrelated = `
      export function selectPublicPageShortId(article) {
        return article.publicPageShortId;
      }
    `;
    expect(reimplementsShortIdGenerator(unrelated)).toBe(false);
  });

  it("src/lib/redirect/public-redirect-code.ts (the legitimate sibling generator) trips no signal in this scan", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "src/lib/redirect/public-redirect-code.ts"),
      "utf8",
    );
    expect(findWriteSiteViolations(source)).toEqual([]);
    expect(reimplementsShortIdGenerator(source)).toBe(false);
  });
});
