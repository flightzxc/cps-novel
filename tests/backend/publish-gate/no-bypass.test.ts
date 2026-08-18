/**
 * The bypass regression this round exists to prevent. `P2-07-12-移植审计-
 * 2026-08-12/P2-07.md`'s headline finding: CPS has three write paths that
 * flip `Article.status` straight to `published` via `.update`/`.updateMany`
 * with zero checks (`changeArticleStatus`/`changeArticlesStatus`/
 * `changeArticlesStatusByFilter`), plus a cron job that does the same. This
 * test statically scans for a second write site into `Article.status`/
 * `Novel.status` outside `src/server/publish-gate/` (the one place this
 * write is allowed — see that module's header). Finding one here means a
 * second, ungated path into `published` was (re)introduced — same failure
 * class as CPS's.
 *
 * This is a source scan, not a type-level or runtime check, because the
 * defect it guards against is structural (a *second write site exists at
 * all*), which only a full-tree scan can see — same rationale as
 * `tests/ui/admin-content-registry.test.ts`'s route-file scan and
 * `publish-gate-contract.test.ts`'s stripSource scanners.
 *
 * 🔴 Known coverage, not a full-coverage guarantee (per `scratchpad/reports/
 * A-REVIEW.md` 必改 3 — an earlier revision's header comment overclaimed
 * this, "fails the build if one appears" as if unconditionally true; the
 * accurate scope is below):
 *
 * - **Roots scanned**: `src/`, `worker/`, `scheduler/`, `scripts/` — every
 *   directory CLAUDE.md §3.2 assigns runtime/tooling business code to
 *   (`worker/`/`scheduler/` matter most: CPS's `instrumentation.ts` cron
 *   bypass lived in exactly that kind of location, not under `src/`).
 *   `.ts`/`.tsx` files only.
 * - **Model-delegate writes**: `.article.<verb>(`/`.novel.<verb>(` for
 *   `update`/`updateMany`/`updateManyAndReturn`/`create`/`createMany`/
 *   `createManyAndReturn`/`upsert`, flagged if the call's arguments contain
 *   a `status:` key **at all** — literal (`status: "published"`) or a
 *   variable/expression (`status: nextStatus`, this module's own legitimate
 *   pattern in `applyNovelRightsTransition`). Scoped to the `article`/`novel`
 *   Prisma delegates specifically (not a bare `.update(` sweep) so it does
 *   not false-positive on unrelated models' status columns (ChannelAccount,
 *   PromoLink, GenericTask, NovelChapter, ...).
 * - **Raw SQL**: `$executeRaw`/`$executeRawUnsafe` call sites (parenthesized
 *   or tagged-template form) are flagged if a fixed window of source after
 *   the call mentions an `article`/`novel` word boundary together with
 *   `status` — coarse and deliberately over-inclusive rather than parsing
 *   SQL. Deliberately excludes `$queryRaw`/`$queryRawUnsafe`: those return
 *   rows (Prisma's read path — `$executeRaw*` returns an affected-row count,
 *   the write path) and this codebase's actual usage confirms the split
 *   (`src/server/admin-content/service.ts` uses `$queryRaw` exclusively for
 *   SELECTs that legitimately mention `article`/`novel` status columns as a
 *   read filter; `worker/handlers/credential.ts` uses `$executeRaw` for its
 *   one real write). Flagging `$queryRaw` too would false-positive on every
 *   admin list/detail query in this codebase, permanently drowning the
 *   signal this test exists to carry.
 * - **What it cannot see**: dynamically computed model/method names
 *   (`db[modelName][method](...)`), string-built SQL assembled outside the
 *   raw-SQL call's immediate arguments, or any other run-time obfuscation. A
 *   clean scan narrows the search space; it does not prove no bypass exists.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SCAN_ROOTS = ["src", "worker", "scheduler", "scripts"].map((dir) => path.resolve(process.cwd(), dir));
const ALLOWED_ROOT = path.resolve(process.cwd(), "src/server/publish-gate");
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

// Prisma model-delegate write calls, scoped to `article`/`novel` specifically
// — the two models this module's single-write-path claim is about. A bare
// `.update(`/`.create(` sweep would flag every other model's legitimate
// status write (ChannelAccount, PromoLink, GenericTask, NovelChapter, ...)
// as noise.
const MODEL_WRITE_CALL = /\.(article|novel)\.(update|updateMany|updateManyAndReturn|create|createMany|createManyAndReturn|upsert)\(/g;
// Any `status:` key in the call's arguments — literal OR a variable/
// expression. A variable write (`status: nextStatus`) is exactly this
// module's own legitimate pattern (`applyNovelRightsTransition`'s
// `updateMany`), so this only matters as a violation outside
// `src/server/publish-gate/`.
const SETS_STATUS_KEY = /\bstatus\s*:/;

// Raw SQL escape hatches that bypass the Prisma model delegate entirely —
// both call forms: `.$executeRaw(Prisma.sql\`...\`)` and the tagged-template
// form `.$executeRawUnsafe<T>\`...\`` (note the optional generic type
// argument before the backtick, which is why this is a coarse fixed-length
// window rather than a balanced-delimiter extraction). `$queryRaw*`
// deliberately excluded — see module header.
const RAW_SQL_CALL = /\.(\$executeRawUnsafe|\$executeRaw)\b/g;
const RAW_SQL_WINDOW = 800;
const MENTIONS_ARTICLE_OR_NOVEL_TABLE_AND_STATUS =
  /(\b(article|novel)\b[\s\S]{0,200}\bstatus\b)|(\bstatus\b[\s\S]{0,200}\b(article|novel)\b)/i;

function findBypassCandidates(source: string): string[] {
  const hits: string[] = [];
  for (const match of source.matchAll(MODEL_WRITE_CALL)) {
    const args = extractCallArgs(source, (match.index ?? 0) + match[0].length);
    if (SETS_STATUS_KEY.test(args)) {
      hits.push(`.${match[1]}.${match[2]}(...) writes a status key`);
    }
  }
  for (const match of source.matchAll(RAW_SQL_CALL)) {
    const start = (match.index ?? 0) + match[0].length;
    const window = source.slice(start, start + RAW_SQL_WINDOW);
    if (MENTIONS_ARTICLE_OR_NOVEL_TABLE_AND_STATUS.test(window)) {
      hits.push(`.${match[1]}(...) mentions an article/novel status nearby (raw SQL)`);
    }
  }
  return hits;
}

describe("publish bypass regression", () => {
  it("no write outside src/server/publish-gate/ touches Article.status or Novel.status", async () => {
    const allFiles = (await Promise.all(SCAN_ROOTS.map(collectSourceFiles))).flat();
    const violations: Array<{ file: string; hits: string[] }> = [];
    for (const file of allFiles) {
      if (file.startsWith(ALLOWED_ROOT)) continue;
      const source = await readFile(file, "utf8");
      const hits = findBypassCandidates(source);
      if (hits.length > 0) {
        violations.push({ file: path.relative(process.cwd(), file), hits });
      }
    }
    expect(violations).toEqual([]);
  });

  it("sanity: detects the CPS-style bypass pattern it exists to catch (literal status)", () => {
    const cpsStyleBypass = `
      export async function changeArticleStatus(id: string, status: string) {
        return prisma.article.update({ where: { id }, data: { status: "published" } });
      }
    `;
    expect(findBypassCandidates(cpsStyleBypass)).toEqual([".article.update(...) writes a status key"]);
  });

  it("sanity: detects a non-literal status write too (the blind spot this round closed)", () => {
    // Exactly this module's own shape at `service.ts`'s
    // `applyNovelRightsTransition` — a violation anywhere else.
    const variableStatusWrite = `
      await tx.article.updateMany({ where: { id: { in: affectedArticleIds } }, data: { status: nextStatus } });
    `;
    expect(findBypassCandidates(variableStatusWrite)).toEqual([".article.updateMany(...) writes a status key"]);
  });

  it("sanity: detects upsert/createMany, not just update/updateMany/create", () => {
    expect(findBypassCandidates('db.novel.upsert({ where: { id }, create: { status: "published" }, update: {} })'))
      .toEqual([".novel.upsert(...) writes a status key"]);
    expect(findBypassCandidates('db.article.createMany({ data: [{ status: "published" }] })')).toEqual([
      ".article.createMany(...) writes a status key",
    ]);
  });

  it("sanity: detects raw SQL writing article/novel status, both call forms", () => {
    const executeRaw = "await tx.$executeRaw(Prisma.sql`UPDATE article SET status = 'published' WHERE id = ${id}::uuid`);";
    expect(findBypassCandidates(executeRaw)).toEqual([".$executeRaw(...) mentions an article/novel status nearby (raw SQL)"]);

    const taggedTemplate = "await tx.$executeRawUnsafe`UPDATE novel SET status='published' WHERE id=${id}`;";
    expect(findBypassCandidates(taggedTemplate)).toEqual([
      ".$executeRawUnsafe(...) mentions an article/novel status nearby (raw SQL)",
    ]);
  });

  it("sanity: does not false-positive on a plain read-filter", () => {
    const readFilter = `
      export const PUBLIC_ARTICLE_RECORD = { status: "published" } satisfies Prisma.ArticleWhereInput;
      const rows = await db.article.findMany({ where: PUBLIC_ARTICLE_RECORD });
    `;
    expect(findBypassCandidates(readFilter)).toEqual([]);
  });

  it("sanity: does not false-positive on an unrelated model's status write (only article/novel are in scope)", () => {
    const unrelatedModel = `
      await tx.channelAccount.update({ where: { id }, data: { status: input.nextStatus } });
      await tx.novelChapter.updateMany({ where: { id: { in: ids } }, data: { status: "withdrawn" } });
    `;
    expect(findBypassCandidates(unrelatedModel)).toEqual([]);
  });

  it("src/server/publish-gate/service.ts is exactly the one place allowed to contain this pattern", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src/server/publish-gate/service.ts"), "utf8");
    expect(findBypassCandidates(source).length).toBeGreaterThan(0);
  });
});
