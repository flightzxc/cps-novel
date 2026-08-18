/**
 * The bypass regression this round exists to prevent. `P2-07-12-移植审计-
 * 2026-08-12/P2-07.md`'s headline finding: CPS has three write paths that
 * flip `Article.status` straight to `published` via `.update`/`.updateMany`
 * with zero checks (`changeArticleStatus`/`changeArticlesStatus`/
 * `changeArticlesStatusByFilter`), plus a cron job that does the same. This
 * test statically scans the whole `src/` tree (outside
 * `src/server/publish-gate/` itself, which is the one place this write is
 * allowed — see that module's header) for any Prisma
 * `.update`/`.updateMany`/`.create` call whose argument literally sets
 * `status: "published"`. Finding one here means a second, ungated path into
 * `published` was added and this whole round's Hard Gate work has a hole in
 * it — same failure class as CPS's, reintroduced.
 *
 * This is a source scan, not a type-level or runtime check, because the
 * defect it guards against is structural (a *second write site exists at
 * all*), which only a full-tree scan can see — same rationale as
 * `tests/ui/admin-content-registry.test.ts`'s route-file scan and
 * `publish-gate-contract.test.ts`'s stripSource scanners.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SRC_ROOT = path.resolve(process.cwd(), "src");
const ALLOWED_ROOT = path.resolve(process.cwd(), "src/server/publish-gate");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
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

/** Balanced-paren extraction of the argument list following `matchEnd` (the index right after the call's opening `(`). */
function extractCallArgs(source: string, matchEnd: number): string {
  let depth = 1;
  let i = matchEnd;
  for (; i < source.length && depth > 0; i += 1) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") depth -= 1;
  }
  return source.slice(matchEnd, i);
}

const WRITE_CALL = /\.(update|updateMany|create)\(/g;
const SETS_PUBLISHED_STATUS = /status\s*:\s*["']published["']/;

function findBypassCandidates(source: string): string[] {
  const hits: string[] = [];
  for (const match of source.matchAll(WRITE_CALL)) {
    const args = extractCallArgs(source, (match.index ?? 0) + match[0].length);
    if (SETS_PUBLISHED_STATUS.test(args)) {
      hits.push(`.${match[1]}(...) sets status: "published"`);
    }
  }
  return hits;
}

describe("publish bypass regression", () => {
  it("no write call outside src/server/publish-gate/ sets status to \"published\"", async () => {
    const files = await collectSourceFiles(SRC_ROOT);
    const violations: Array<{ file: string; hits: string[] }> = [];
    for (const file of files) {
      if (file.startsWith(ALLOWED_ROOT)) continue;
      const source = await readFile(file, "utf8");
      const hits = findBypassCandidates(source);
      if (hits.length > 0) {
        violations.push({ file: path.relative(process.cwd(), file), hits });
      }
    }
    expect(violations).toEqual([]);
  });

  it("sanity: the scanner actually detects the CPS-style bypass pattern it exists to catch", () => {
    const cpsStyleBypass = `
      export async function changeArticleStatus(id: string, status: string) {
        return prisma.article.update({ where: { id }, data: { status: "published" } });
      }
    `;
    expect(findBypassCandidates(cpsStyleBypass)).toEqual([
      '.update(...) sets status: "published"',
    ]);
  });

  it("sanity: the scanner does not flag a plain read-filter (status is not a write target there)", () => {
    const readFilter = `
      export const PUBLIC_ARTICLE_RECORD = { status: "published" } satisfies Prisma.ArticleWhereInput;
      const rows = await db.article.findMany({ where: PUBLIC_ARTICLE_RECORD });
    `;
    expect(findBypassCandidates(readFilter)).toEqual([]);
  });

  it("src/server/publish-gate/service.ts is exactly the one place allowed to contain this pattern", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "src/server/publish-gate/service.ts"),
      "utf8",
    );
    expect(findBypassCandidates(source).length).toBeGreaterThan(0);
  });
});
