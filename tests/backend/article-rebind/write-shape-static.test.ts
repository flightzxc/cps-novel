/**
 * `src/server/article-rebind/service.ts`'s own header (🔴 "The write shape")
 * and `tests/backend/article-rebind/service.test.ts`'s "🔴 writes exactly
 * {novelId, promoLinkId}" test both pin `switchArticleNovel`'s conditional
 * `tx.article.updateMany({ where: {...}, data: {...} })` to exactly two
 * written fields — but that runtime test goes through `FakeRebindDb` (see
 * `./fake-db.ts`), which only records whatever the fake's own `updateMany`
 * implementation happens to read off the call's `data` object. A fake that
 * silently ignored (or silently tolerated) an extra key would let the
 * runtime test keep passing while the real Prisma call widened underneath
 * it — the CPS-parity write-shape guarantee 施工工单 §4A.6 exists for would
 * quietly stop holding.
 *
 * This is a second, independent guard against exactly that: a source scan
 * that parses the real call site in `service.ts` directly (not a mock's
 * behavior) and asserts on its literal `data`/`where` object keys. Same
 * "parse the migration/source text, don't trust a hand-copied literal"
 * discipline as `tests/backend/database/c24-article-axes-static.test.ts`'s
 * `parseCheckValues` and the balanced-paren call-argument extraction
 * `tests/backend/publish-gate/no-bypass.test.ts` /
 * `tests/backend/articles/content-mode-sole-write-paths.test.ts` both use —
 * narrower in scope than those two (this one targets one known call site in
 * one file, not a whole-repo bypass sweep), because the property being
 * pinned here is "this exact call's shape never drifts", not "no other call
 * site exists anywhere".
 *
 * 🔴 Known coverage, not a full-coverage guarantee: this only looks at the
 * one `.article.updateMany(` call site inside `switchArticleNovel`'s
 * `/** ... *\/` JSDoc-stripped source. A second `.article.updateMany(` call
 * added anywhere else in this file would make the "exactly one call" guard
 * below fail loudly (by design — see the first `it`), rather than silently
 * being ignored.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const servicePath = path.join(process.cwd(), "src/server/article-rebind/service.ts");
const source = readFileSync(servicePath, "utf8");

/** Strips `/** ... *\/`-style block comments (this file's own JSDoc header quotes the exact call shape as an example, which would otherwise double-count as a second call site). */
function stripBlockComments(text: string): string {
  return text.replace(/\/\*\*[\s\S]*?\*\//g, "");
}

/** Balanced-paren extraction of the argument list following `matchEnd` (the index right after the call's opening `(`) — same helper shape as `no-bypass.test.ts`/`content-mode-sole-write-paths.test.ts`. */
function extractCallArgs(text: string, matchEnd: number): string {
  let depth = 1;
  let i = matchEnd;
  for (; i < text.length && depth > 0; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") depth -= 1;
  }
  return text.slice(matchEnd, i);
}

/** Splits a flat (non-nested) `{ key: value, key2: value2 }` object-literal source string into its top-level key names, in source order. */
function extractObjectKeys(objectLiteral: string): string[] {
  const inner = objectLiteral.trim().replace(/^\{/, "").replace(/\}$/, "");
  return inner
    .split(",")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => segment.split(":")[0]!.trim());
}

/**
 * Finds the sole `.article.updateMany(` call in `text` (after stripping
 * block comments) and returns its `where`/`data` object-literal source
 * text verbatim. Throws — failing the test loudly — if there is not
 * exactly one such call, or if either object literal cannot be located.
 */
function findArticleUpdateManyWriteShape(text: string): { where: string; data: string } {
  const stripped = stripBlockComments(text);
  const calls = [...stripped.matchAll(/\.article\.updateMany\(/g)];
  if (calls.length !== 1) {
    throw new Error(
      `expected exactly one .article.updateMany( call site, found ${calls.length}`,
    );
  }
  const call = calls[0]!;
  const args = extractCallArgs(stripped, (call.index ?? 0) + call[0].length);
  const whereMatch = args.match(/where:\s*(\{[^{}]*\})/);
  const dataMatch = args.match(/data:\s*(\{[^{}]*\})/);
  if (!whereMatch || !dataMatch) {
    throw new Error("could not locate flat where:{...}/data:{...} object literals in the updateMany(...) call");
  }
  return { where: whereMatch[1]!, data: dataMatch[1]! };
}

/**
 * Review follow-up (复核_C30施工单2, 2026-09-09). The scan above pins the write
 * shape by reading `service.ts` ONLY. C-30B's批量 path reaches that same write
 * through `runRebindTransactionalWrite`, which is exactly right — but nothing
 * forced it to stay that way: `batch.ts` could grow its own
 * `tx.article.updateMany({...})` (or an `update`/`updateManyAndReturn`) and
 * every test in this file would stay green while the批量 path quietly stopped
 * sharing the single-article write shape — the "两套判定漂移" 施工工单 §4B.5
 * warns about, in its write-side form.
 *
 * So: assert structurally that the whole `src/server/article-rebind/`
 * directory has its Article writes in one file. `service.ts` owns the write;
 * every other module in the directory must have zero Article write call
 * sites of its own.
 */
describe("批量路径不得自建 Article 写入（写形状的唯一入口仍是 service.ts）", () => {
  const dir = path.join(process.cwd(), "src/server/article-rebind");
  const others = readdirSync(dir).filter((name) => name.endsWith(".ts") && name !== "service.ts");

  it("被扫描的兄弟模块集合非空（防止 glob 写错后测试空转变成永远绿）", () => {
    expect(others).toEqual(expect.arrayContaining(["batch.ts", "preview.ts", "guards.ts"]));
  });

  it.each(["batch.ts", "preview.ts", "guards.ts", "errors.ts", "index.ts", "batch-constants.ts"])(
    "%s 不含任何 .article.update / .article.updateMany / .article.create / .article.delete 调用",
    (name) => {
      const text = stripBlockComments(readFileSync(path.join(dir, name), "utf8"));
      const writes = [...text.matchAll(/\.article\.(updateMany|updateManyAndReturn|update|create|createMany|delete|deleteMany|upsert)\(/g)];
      expect(writes.map((match) => match[0])).toEqual([]);
    },
  );

  it("sanity (mutation guard): the same scan flags a synthetic Article write in a sibling module", () => {
    const synthetic = stripBlockComments(`
      const write = await tx.article.updateMany({ where: { id }, data: { novelId, promoLinkId } });
    `);
    const writes = [...synthetic.matchAll(/\.article\.(updateMany|updateManyAndReturn|update|create|createMany|delete|deleteMany|upsert)\(/g)];
    expect(writes.map((match) => match[0])).toEqual([".article.updateMany("]);
  });
});

describe("article-rebind write-shape pin (source-static, complements the runtime fake-db test)", () => {
  it("service.ts contains exactly one .article.updateMany( call site", () => {
    // Failing here (not just downstream) is the point: a second call site
    // means this test's own "the write" singular assumption no longer
    // holds, and that itself is worth surfacing before anything else.
    expect(() => findArticleUpdateManyWriteShape(source)).not.toThrow();
  });

  it("🔴 the updateMany(...) data object writes exactly {novelId, promoLinkId} — no other field", () => {
    const { data } = findArticleUpdateManyWriteShape(source);
    expect(extractObjectKeys(data).sort()).toEqual(["novelId", "promoLinkId"]);
  });

  it("the updateMany(...) where clause is the CAS condition keyed by both id and novelId", () => {
    const { where } = findArticleUpdateManyWriteShape(source);
    const keys = extractObjectKeys(where);
    expect(keys).toContain("id");
    expect(keys).toContain("novelId");
  });

  /**
   * The plan's own "变异测试" requirement, same as `content-mode-sole-
   * write-paths.test.ts`'s "sanity (mutation guard)" test: prove the
   * extractor itself would have caught the exact defect this file exists
   * to prevent (a third key silently added to the write), using synthetic
   * source text rather than mutating the real file as part of the suite.
   * (This was also verified by hand against the real file: temporarily
   * adding a third `status: "draft"` key to the live `data: {...}` in
   * `service.ts` turns the "writes exactly" test above red with the exact
   * diff `["novelId","promoLinkId"] !== ["novelId","promoLinkId","status"]`;
   * reverting restores green. See this round's delivery notes for the
   * pasted red/green output.)
   */
  it("sanity (mutation guard): the extractor flags a synthetic third data key", () => {
    const withThirdField = `
      const write = await tx.article.updateMany({
        where: { id: article.id, novelId: expectedOldNovelId },
        data: { novelId: targetNovel.id, promoLinkId: evaluation.resolvedPromoLinkId, status: "draft" },
      });
    `;
    const { data } = findArticleUpdateManyWriteShape(withThirdField);
    expect(extractObjectKeys(data)).toEqual(["novelId", "promoLinkId", "status"]);
    expect(extractObjectKeys(data).sort()).not.toEqual(["novelId", "promoLinkId"]);
  });

  it("sanity: the extractor throws when more than one .article.updateMany( call exists (ambiguous write shape)", () => {
    const twoCalls = `
      await tx.article.updateMany({ where: { id: a }, data: { novelId: b, promoLinkId: c } });
      await tx.article.updateMany({ where: { id: d }, data: { novelId: e, promoLinkId: f } });
    `;
    expect(() => findArticleUpdateManyWriteShape(twoCalls)).toThrow(/exactly one/);
  });

  it("sanity: block comments (this file's own JSDoc example) are not mistaken for a second call site", () => {
    const commentedExample = `
      /**
       * Example:
       *   tx.article.updateMany({
       *     where: { id: articleId, novelId: expectedOldNovelId },
       *     data:  { novelId: targetNovelId, promoLinkId: resolvedPromoLinkId },
       *   })
       */
      const write = await tx.article.updateMany({
        where: { id: article.id, novelId: expectedOldNovelId },
        data: { novelId: targetNovel.id, promoLinkId: evaluation.resolvedPromoLinkId },
      });
    `;
    const { data } = findArticleUpdateManyWriteShape(commentedExample);
    expect(extractObjectKeys(data).sort()).toEqual(["novelId", "promoLinkId"]);
  });
});
