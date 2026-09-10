/**
 * C-26 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-26):
 * "内容模式的维护点恰好两处，不多不少...这两处之外不允许有第三处写这个
 * 字段。建议同时加一条与'发布门禁旁路扫描'同形的静态扫描测试：扫遍源码禁止
 * 在这两个目录之外出现带 `contentMode:` 的文章写入". This test statically
 * scans for a third write site into `Article.contentMode` outside the two
 * authorized directories:
 *
 * - `src/server/articles/` — the manual-edit write path
 *   (`service.ts`'s `updateArticleContent`, always writes `"manual"`) and the
 *   template re-render write path (`regenerateCore`, both its N-7 CAS
 *   `updateMany` branch and its plain `update` branch, both write
 *   `"template"`).
 * - `src/server/content-creation/` — the article-creation insert (also
 *   writes `"template"`).
 *
 * Same structure and scope discipline as `tests/backend/publish-gate/
 * no-bypass.test.ts` (this file's header directly mirrors that one's) and
 * `tests/backend/slug/short-id-sole-source.test.ts`:
 *
 * - **Roots scanned**: `src/`, `worker/`, `scheduler/`, `scripts/`, `.ts`/
 *   `.tsx` only — same roots as both sibling scans, for the same reason
 *   (CLAUDE.md §3.2 assigns runtime/tooling business code to all four).
 * - **Signal — write-site scope**: any `.article.<create|createMany|
 *   createManyAndReturn|update|updateMany|updateManyAndReturn|upsert>(` call
 *   whose arguments contain a `contentMode:` key — literal
 *   (`contentMode: "manual"`) or a variable/expression — found outside the
 *   two authorized roots above. Scoped to `.article.` specifically (not a
 *   bare `.update(` sweep) so it does not false-positive on some unrelated
 *   model's own field that happens to be named `contentMode` (none exists
 *   today, but the scope discipline is the same one both sibling scans
 *   already apply for their own target field/column).
 * - **Signal — raw SQL**: `$executeRaw`/`$executeRawUnsafe` call sites
 *   (parenthesized or tagged-template form) are flagged if a fixed window of
 *   source after the call mentions `article` together with `content_mode`
 *   (the physical column name, since a raw statement is talking to
 *   PostgreSQL directly, not to a Prisma field) — same coarse,
 *   deliberately-over-inclusive shape as `no-bypass.test.ts`'s
 *   `MENTIONS_ARTICLE_OR_NOVEL_TABLE_AND_STATUS`, `$queryRaw`/
 *   `$queryRawUnsafe` excluded for the same reason (read path, not write).
 *
 * 🔴 Known coverage, not a full-coverage guarantee — same caveat both sibling
 * scans state explicitly: dynamically computed model/method names, a
 * raw-SQL write whose nearby source does not happen to mention both
 * `article` and `content_mode` within the scan window, or any other
 * run-time obfuscation sit outside what this source scan can see. This scan
 * *does* add a raw-SQL signal of its own, mirroring `no-bypass.test.ts`'s —
 * an earlier revision of this header claimed no raw-SQL precedent existed to
 * model one against; that was wrong. `no-bypass.test.ts`'s own
 * `$executeRaw`/`$executeRawUnsafe`-plus-nearby-status-mention detector *is*
 * that precedent: it too has no real matching Article-status raw-SQL write
 * anywhere in this repo (the one real `$executeRaw` write,
 * `worker/handlers/credential.ts`, is unrelated to `Article`) and is kept
 * anyway as defense-in-depth against a bypass that has not happened yet, not
 * as a detector for one that has. This scan follows the identical
 * reasoning for `content_mode`. A clean scan narrows the search space; it
 * does not prove no bypass exists.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SCAN_ROOTS = ["src", "worker", "scheduler", "scripts"].map((dir) => path.resolve(process.cwd(), dir));
const ALLOWED_WRITE_ROOTS = ["src/server/articles", "src/server/content-creation"].map((dir) =>
  path.resolve(process.cwd(), dir),
);
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

/** Balanced-paren extraction of the argument list following `matchEnd` (the index right after the call's opening `(`). Same helper shape as `no-bypass.test.ts`/`short-id-sole-source.test.ts`. */
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
const SETS_CONTENT_MODE_KEY = /\bcontentMode\s*:/;

// Raw SQL escape hatches that bypass the Prisma model delegate entirely —
// same two call forms `no-bypass.test.ts` scans for. `$queryRaw`/
// `$queryRawUnsafe` deliberately excluded — see module header.
const RAW_SQL_CALL = /\.(\$executeRawUnsafe|\$executeRaw)\b/g;
const RAW_SQL_WINDOW = 800;
const MENTIONS_ARTICLE_TABLE_AND_CONTENT_MODE =
  /(\barticle\b[\s\S]{0,200}\bcontent_mode\b)|(\bcontent_mode\b[\s\S]{0,200}\barticle\b)/i;

function findWriteSiteViolations(source: string): string[] {
  const hits: string[] = [];
  for (const match of source.matchAll(ARTICLE_WRITE_CALL)) {
    const args = extractCallArgs(source, (match.index ?? 0) + match[0].length);
    if (SETS_CONTENT_MODE_KEY.test(args)) {
      hits.push(`.article.${match[1]}(...) writes a contentMode key`);
    }
  }
  for (const match of source.matchAll(RAW_SQL_CALL)) {
    const start = (match.index ?? 0) + match[0].length;
    const window = source.slice(start, start + RAW_SQL_WINDOW);
    if (MENTIONS_ARTICLE_TABLE_AND_CONTENT_MODE.test(window)) {
      hits.push(`.${match[1]}(...) mentions article content_mode nearby (raw SQL)`);
    }
  }
  return hits;
}

function isUnderAnAllowedRoot(file: string): boolean {
  return ALLOWED_WRITE_ROOTS.some((root) => file.startsWith(root));
}

describe("Article.contentMode sole-maintenance-points regression (C-26)", () => {
  it("no write outside src/server/articles/ or src/server/content-creation/ sets Article.contentMode", async () => {
    const allFiles = (await Promise.all(SCAN_ROOTS.map(collectSourceFiles))).flat();
    const violations: Array<{ file: string; hits: string[] }> = [];
    for (const file of allFiles) {
      if (isUnderAnAllowedRoot(file)) continue;
      const source = await readFile(file, "utf8");
      const hits = findWriteSiteViolations(source);
      if (hits.length > 0) violations.push({ file: path.relative(process.cwd(), file), hits });
    }
    expect(violations).toEqual([]);
  });

  /**
   * The plan's own "变异测试" requirement: "新增的静态扫描测试自身要有变异
   * 测试（故意在扫描范围内插入一处写入，断言测试转红）". This is that
   * self-test — it does not touch real source, it proves the detector
   * function itself flags the exact shape of write it exists to catch, the
   * same way `no-bypass.test.ts`'s and `short-id-sole-source.test.ts`'s own
   * "sanity: detects..." tests do.
   */
  it("sanity (mutation guard): detects a literal contentMode write — the pattern this scan exists to catch", () => {
    const bypass = `
      export async function backfillContentMode(db, id) {
        return db.article.update({ where: { id }, data: { contentMode: "manual" } });
      }
    `;
    expect(findWriteSiteViolations(bypass)).toEqual([".article.update(...) writes a contentMode key"]);
  });

  it("sanity: detects a non-literal (variable) contentMode write too", () => {
    const variableWrite = `
      await tx.article.updateMany({ where: { id: { in: ids } }, data: { contentMode: nextMode } });
    `;
    expect(findWriteSiteViolations(variableWrite)).toEqual([".article.updateMany(...) writes a contentMode key"]);
  });

  it("sanity: detects create/upsert too, not just update/updateMany", () => {
    expect(
      findWriteSiteViolations('db.article.create({ data: { contentMode: "template" } })'),
    ).toEqual([".article.create(...) writes a contentMode key"]);
    expect(
      findWriteSiteViolations(
        'db.article.upsert({ where: { id }, create: { contentMode: "template" }, update: {} })',
      ),
    ).toEqual([".article.upsert(...) writes a contentMode key"]);
  });

  it("sanity: does not false-positive on a plain read/select", () => {
    const readOnly = `
      const rows = await db.article.findMany({ select: { id: true, contentMode: true } });
    `;
    expect(findWriteSiteViolations(readOnly)).toEqual([]);
  });

  it("sanity: does not false-positive on an unrelated model's write", () => {
    expect(findWriteSiteViolations('db.novel.update({ where: { id }, data: { businessId: x } });')).toEqual([]);
  });

  it("sanity: does not false-positive on a read-side where-clause filter (contentMode as a filter value, not a write)", () => {
    const readFilter = `
      const rows = await db.article.findMany({ where: { contentMode: input.contentMode } });
    `;
    expect(findWriteSiteViolations(readFilter)).toEqual([]);
  });

  /**
   * The raw-SQL signal added alongside this test's header correction (see
   * module header, "Signal — raw SQL"): a synthetic `UPDATE article SET
   * content_mode=...` outside the two allowed roots must be flagged, the
   * same way `no-bypass.test.ts`'s own raw-SQL sanity test proves its
   * detector catches the literal `UPDATE article SET status = 'published'`
   * shape.
   */
  it("sanity: detects raw SQL writing article content_mode, both call forms", () => {
    const executeRaw =
      "await tx.$executeRaw(Prisma.sql`UPDATE article SET content_mode = 'manual' WHERE id = ${id}::uuid`);";
    expect(findWriteSiteViolations(executeRaw)).toEqual([
      ".$executeRaw(...) mentions article content_mode nearby (raw SQL)",
    ]);

    const taggedTemplate = "await tx.$executeRawUnsafe`UPDATE article SET content_mode='template' WHERE id=${id}`;";
    expect(findWriteSiteViolations(taggedTemplate)).toEqual([
      ".$executeRawUnsafe(...) mentions article content_mode nearby (raw SQL)",
    ]);
  });

  it("sanity: does not false-positive on raw SQL for an unrelated table/column", () => {
    const unrelatedRawSql =
      "await tx.$executeRaw(Prisma.sql`UPDATE novel SET status = 'published' WHERE id = ${id}::uuid`);";
    expect(findWriteSiteViolations(unrelatedRawSql)).toEqual([]);
  });

  it("src/server/articles/service.ts is one of exactly the two places allowed to contain the write-site pattern", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src/server/articles/service.ts"), "utf8");
    expect(findWriteSiteViolations(source).length).toBeGreaterThan(0);
  });

  it("src/server/content-creation/service.ts is the other of exactly the two places allowed to contain the write-site pattern", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src/server/content-creation/service.ts"), "utf8");
    expect(findWriteSiteViolations(source).length).toBeGreaterThan(0);
  });
});
