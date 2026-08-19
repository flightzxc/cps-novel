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
 * - **Signal 2 — algorithm duplication**: this module's exact alphabet
 *   string literal (`PUBLIC_PAGE_SHORT_ID_ALPHABET`) appearing anywhere
 *   outside `src/lib/slug/short-id.ts` itself — catches a copy-pasted
 *   reimplementation even if it never touches `.article.` directly (e.g. a
 *   helper file that only returns a candidate string).
 *
 * 🔴 Known coverage, not a full-coverage guarantee — same caveat
 * `no-bypass.test.ts` states explicitly: dynamically computed model/method
 * names, raw SQL string-built outside a scanned call's immediate arguments,
 * or a differently-shaped duplicate alphabet all sit outside what a source
 * scan can see. A clean scan narrows the search space; it does not prove no
 * second entry point exists by construction.
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

  it("no file other than src/lib/slug/short-id.ts redefines the short-id alphabet literal", async () => {
    const allFiles = (await Promise.all(SCAN_ROOTS.map(collectSourceFiles))).flat();
    const violations: string[] = [];
    for (const file of allFiles) {
      if (file === ALLOWED_ALPHABET_FILE) continue;
      const source = await readFile(file, "utf8");
      if (source.includes(PUBLIC_PAGE_SHORT_ID_ALPHABET)) {
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
});
