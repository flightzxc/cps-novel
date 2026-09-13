/**
 * Article.promoLinkId write boundaries after decoupling:
 * 1. create-time bind in content-creation generate (and blog null)
 * 2. claim post-bind in promo-link-binding (does not overwrite a different bind)
 * 3. rebind two-field rewrite
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SCAN_ROOTS = ["src", "worker", "scheduler"].map((dir) => path.resolve(process.cwd(), dir));
const ALLOWED_WRITE_ROOTS = [
  path.resolve(process.cwd(), "src/server/content-creation"),
  path.resolve(process.cwd(), "src/server/article-rebind"),
  path.resolve(process.cwd(), "worker/handlers/promo-link-binding.ts"),
];
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
const SETS_PROMO_LINK_ID = /\bpromoLinkId\b/;

function findWriteSiteViolations(source: string): string[] {
  const hits: string[] = [];
  for (const match of source.matchAll(ARTICLE_WRITE_CALL)) {
    const args = extractCallArgs(source, (match.index ?? 0) + match[0].length);
    if (SETS_PROMO_LINK_ID.test(args)) {
      hits.push(`.article.${match[1]}(...) writes a promoLinkId key`);
    }
  }
  return hits;
}

function isAllowed(file: string): boolean {
  return ALLOWED_WRITE_ROOTS.some((root) => file === root || file.startsWith(`${root}${path.sep}`) || file.startsWith(root));
}

describe("Article.promoLinkId write boundaries", () => {
  it("only create-bind, claim post-bind, and rebind write Article.promoLinkId", async () => {
    const allFiles = (await Promise.all(SCAN_ROOTS.map(collectSourceFiles))).flat();
    const violations: Array<{ file: string; hits: string[] }> = [];
    for (const file of allFiles) {
      if (isAllowed(file)) continue;
      const source = await readFile(file, "utf8");
      const hits = findWriteSiteViolations(source);
      if (hits.length > 0) violations.push({ file: path.relative(process.cwd(), file), hits });
    }
    expect(violations).toEqual([]);
  });

  it("sanity: detects an unauthorized promoLinkId write", () => {
    expect(findWriteSiteViolations("db.article.update({ where: { id }, data: { promoLinkId: nextId } })")).toEqual([
      ".article.update(...) writes a promoLinkId key",
    ]);
  });

  it("authorized create-bind, claim post-bind, and rebind each contain a write", async () => {
    const generate = await readFile(path.resolve(process.cwd(), "src/server/content-creation/generate.ts"), "utf8");
    const claim = await readFile(path.resolve(process.cwd(), "worker/handlers/promo-link-binding.ts"), "utf8");
    const rebind = await readFile(path.resolve(process.cwd(), "src/server/article-rebind/service.ts"), "utf8");
    expect(findWriteSiteViolations(generate).length).toBeGreaterThan(0);
    expect(findWriteSiteViolations(claim).length).toBeGreaterThan(0);
    expect(findWriteSiteViolations(rebind).length).toBeGreaterThan(0);
  });
});
