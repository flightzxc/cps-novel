/**
 * Novel.create sole write path after Novel/Article decoupling.
 * Production writes of `novel.create` / `createMany` / `upsert` may only
 * live under `src/server/content-creation/` (the materialize service).
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SCAN_ROOTS = ["src", "worker", "scheduler"].map((dir) => path.resolve(process.cwd(), dir));
const ALLOWED_WRITE_ROOT = path.resolve(process.cwd(), "src/server/content-creation");
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

const NOVEL_WRITE_CALL = /\.novel\.(create|createMany|createManyAndReturn|upsert)\(/g;

function findWriteSiteViolations(source: string): string[] {
  const hits: string[] = [];
  for (const match of source.matchAll(NOVEL_WRITE_CALL)) {
    hits.push(`.novel.${match[1]}(...)`);
    void extractCallArgs(source, (match.index ?? 0) + match[0].length);
  }
  return hits;
}

describe("Novel.create sole write path", () => {
  it("no production write outside src/server/content-creation/ creates a Novel", async () => {
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

  it("sanity: detects a novel.create outside the allowlist", () => {
    expect(findWriteSiteViolations("db.novel.create({ data: { title } })")).toEqual([".novel.create(...)"]);
  });

  it("src/server/content-creation/service.ts is the authorized materialize write", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src/server/content-creation/service.ts"), "utf8");
    expect(findWriteSiteViolations(source).length).toBeGreaterThan(0);
  });
});
