import { describe, expect, it } from "vitest";

/**
 * C-27 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-27):
 * "tests/backend/：新 CHECK 的取值真值表（四种组合：小说+有书目 ✓、小说+无书目
 * ✗、博客+有书目 ✗、博客+无书目 ✓）". `c27-blog-article-foundation-static.test.ts`
 * already pins the exact SQL text of `article_novel_id_by_type_check`
 * verbatim; this file makes its four-combination truth table legible on its
 * own instead of buried inside a raw string, by re-implementing the same
 * boolean predicate in TypeScript and checking it against all four
 * combinations directly (a raw PostgreSQL boolean expression pinned only as
 * a string is easy to read past a sign error in — this table is the
 * eyeball-able version of the same claim).
 *
 * This is a pure-logic mirror, not a database test — no PostgreSQL
 * connection, no Prisma. The CHECK's actual enforcement on a real database
 * is what the deferred one-time PostgreSQL 16 container run
 * (docs/governance/database-governance.md §12's C-27 row) is for.
 */

/**
 * Mirrors `article_novel_id_by_type_check`'s predicate exactly:
 * `(article_type = 'novel_article' AND novel_id IS NOT NULL)
 *  OR (article_type <> 'novel_article' AND novel_id IS NULL)`
 * (`prisma/migrations/20260910090000_c27_blog_article_foundation/migration.sql`).
 * Returns `true` when the row satisfies the CHECK (INSERT/UPDATE allowed),
 * `false` when it violates it (PostgreSQL would reject with 23514).
 */
function satisfiesNovelIdByTypeCheck(articleType: string, novelId: string | null): boolean {
  return (
    (articleType === "novel_article" && novelId !== null)
    || (articleType !== "novel_article" && novelId === null)
  );
}

describe("C-27: article_novel_id_by_type_check truth table", () => {
  it("小说 + 有书目 → 满足（✓，today's only real row shape)", () => {
    expect(satisfiesNovelIdByTypeCheck("novel_article", "novel-1")).toBe(true);
  });

  it("小说 + 无书目 → 违反（✗ — exactly the regression step 3 of the migration exists to prevent)", () => {
    expect(satisfiesNovelIdByTypeCheck("novel_article", null)).toBe(false);
  });

  it("博客 + 有书目 → 违反（✗ — the 'half-hung' state C-27's own '明确不移植' section forbids)", () => {
    expect(satisfiesNovelIdByTypeCheck("blog_article", "novel-1")).toBe(false);
  });

  it("博客 + 无书目 → 满足（✓ — the shape C-28's creation service always writes)", () => {
    expect(satisfiesNovelIdByTypeCheck("blog_article", null)).toBe(true);
  });

  it("listicle/guide follow the same rule as blog_article (any non-novel_article type)", () => {
    expect(satisfiesNovelIdByTypeCheck("listicle", null)).toBe(true);
    expect(satisfiesNovelIdByTypeCheck("listicle", "novel-1")).toBe(false);
    expect(satisfiesNovelIdByTypeCheck("guide", null)).toBe(true);
    expect(satisfiesNovelIdByTypeCheck("guide", "novel-1")).toBe(false);
  });
});
