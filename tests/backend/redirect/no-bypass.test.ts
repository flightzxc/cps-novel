/**
 * Static scan guarding `src/lib/redirect/public-redirect-code.ts`'s
 * single-entry-point contract (`src/lib/redirect/README.md`, `CLAUDE.md`
 * §3.2.1/§5 修正 6: "全项目唯一的公开短码生成入口. 禁止任何 Adapter、业务模块或
 * 前台自行生成短码"). Same design as `tests/backend/publish-gate/no-bypass.
 * test.ts` — a source-tree scan, not a type-level check, because the defect
 * class ("a second generator exists at all") is structural.
 *
 * 🔴 Known coverage, not a full-coverage guarantee — same caveat as the
 * publish-gate scan this is modeled on:
 *   - **Roots scanned**: `src/`, `worker/`, `scheduler/`, `scripts/`.
 *     `.ts`/`.tsx` only.
 *   - **What it catches**: (a) a second definition of a function literally
 *     named `createPublicRedirectCode` anywhere outside the canonical file;
 *     (b) a `.promoLink.create(`/`.promoLink.upsert(`/`.promoLink.
 *     createMany(` call whose arguments set `publicRedirectCode:` without
 *     the same source window mentioning `createPublicRedirectCode` (the one
 *     legitimate way to produce a value for that field).
 *   - **What it cannot see**: a value laundered through an intermediate
 *     variable/helper many lines away, or any other run-time obfuscation. A
 *     clean scan narrows the search space; it does not prove no bypass
 *     exists.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SCAN_ROOTS = ["src", "worker", "scheduler", "scripts"].map((dir) => path.resolve(process.cwd(), dir));
const ALLOWED_GENERATOR_FILE = path.resolve(process.cwd(), "src/lib/redirect/public-redirect-code.ts");
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

const GENERATOR_DEFINITION = /\bfunction\s+createPublicRedirectCode\s*\(/;

const PROMO_LINK_WRITE_CALL = /\.promoLink\.(create|upsert|createMany)\(/g;
const PROMO_LINK_WRITE_WINDOW = 800;
const SETS_PUBLIC_REDIRECT_CODE_KEY = /\bpublicRedirectCode\s*:/;
const REFERENCES_CANONICAL_GENERATOR = /createPublicRedirectCode\s*\(/;

function extractCallArgs(source: string, matchEnd: number): string {
  let depth = 1;
  let i = matchEnd;
  for (; i < source.length && depth > 0; i += 1) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") depth -= 1;
  }
  return source.slice(matchEnd, i);
}

function findBypassCandidates(source: string): string[] {
  const hits: string[] = [];
  if (GENERATOR_DEFINITION.test(source)) hits.push("defines a second createPublicRedirectCode function");
  for (const match of source.matchAll(PROMO_LINK_WRITE_CALL)) {
    const start = (match.index ?? 0) + match[0].length;
    const args = extractCallArgs(source, start);
    if (!SETS_PUBLIC_REDIRECT_CODE_KEY.test(args)) continue;
    const window = source.slice(Math.max(0, start - PROMO_LINK_WRITE_WINDOW), start + PROMO_LINK_WRITE_WINDOW);
    if (!REFERENCES_CANONICAL_GENERATOR.test(window)) {
      hits.push(`.promoLink.${match[1]}(...) sets publicRedirectCode without a nearby createPublicRedirectCode(...) call`);
    }
  }
  return hits;
}

describe("public redirect code single-entry-point regression", () => {
  it("no file outside src/lib/redirect/public-redirect-code.ts defines a second generator or writes publicRedirectCode without it", async () => {
    const allFiles = (await Promise.all(SCAN_ROOTS.map(collectSourceFiles))).flat();
    const violations: Array<{ file: string; hits: string[] }> = [];
    for (const file of allFiles) {
      if (file === ALLOWED_GENERATOR_FILE) continue;
      const source = await readFile(file, "utf8");
      const hits = findBypassCandidates(source);
      if (hits.length > 0) violations.push({ file: path.relative(process.cwd(), file), hits });
    }
    expect(violations).toEqual([]);
  });

  it("src/lib/redirect/public-redirect-code.ts is exactly the one place defining the generator", async () => {
    const source = await readFile(ALLOWED_GENERATOR_FILE, "utf8");
    expect(GENERATOR_DEFINITION.test(source)).toBe(true);
  });

  it("sanity: detects a hypothetical second generator definition", () => {
    const bypass = `
      export function createPublicRedirectCode() {
        return Math.random().toString(36).slice(2, 12);
      }
    `;
    expect(findBypassCandidates(bypass)).toEqual(["defines a second createPublicRedirectCode function"]);
  });

  it("sanity: detects a promoLink write that invents its own code instead of calling the generator", () => {
    const bypass = `
      await tx.promoLink.create({ data: { publicRedirectCode: randomUUID().slice(0, 10) } });
    `;
    expect(findBypassCandidates(bypass)).toEqual([
      ".promoLink.create(...) sets publicRedirectCode without a nearby createPublicRedirectCode(...) call",
    ]);
  });

  it("sanity: does not false-positive on the real handler shape (generator called nearby)", () => {
    const legit = `
      import { createPublicRedirectCode } from "../../src/lib/redirect";
      async function ensurePromoLinkRow(tx) {
        return tx.promoLink.upsert({
          where: { idempotencyKey: scope.idempotencyKey },
          create: { publicRedirectCode: createPublicRedirectCode(), idempotencyKey: scope.idempotencyKey },
          update: {},
        });
      }
    `;
    expect(findBypassCandidates(legit)).toEqual([]);
  });

  it("sanity: does not false-positive on a promoLink write that never touches publicRedirectCode", () => {
    const readOnlyShapedWrite = `
      await tx.promoLink.update({ where: { idempotencyKey }, data: { status: "fetched" } });
    `;
    expect(findBypassCandidates(readOnlyShapedWrite)).toEqual([]);
  });

  it("worker/handlers/promo-link-claim.ts is a clean caller of the canonical generator", async () => {
    const source = await readFile(path.resolve(process.cwd(), "worker/handlers/promo-link-claim.ts"), "utf8");
    expect(findBypassCandidates(source)).toEqual([]);
    expect(source).toContain("createPublicRedirectCode(");
  });
});
