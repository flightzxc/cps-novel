import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("public wiring source boundaries", () => {
  it("reuses the adminPrisma global key and does not import admin deps or cookies", async () => {
    const source = stripComments(
      await readFile(path.resolve(process.cwd(), "src/app/_lib/public-deps.ts"), "utf8"),
    );
    expect(source).toContain("adminPrisma");
    expect(source).not.toMatch(/from ["']@\/app\/api\/admin\/_lib\/deps["']/);
    expect(source).not.toContain("next/headers");
    expect(source).not.toMatch(/\bcookies\s*\(/);
  });

  it("home carousel service reads serving and preserves the public field boundary", async () => {
    const source = stripComments(
      await readFile(path.resolve(process.cwd(), "src/lib/site/home-carousel-service.ts"), "utf8"),
    );
    expect(source).toContain("homeCarouselServing.findMany");
    // C-25 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-25):
    // the carousel is a list surface, so both call sites here now use the
    // stricter `buildPublicListArticleWhere` fragment (excludes both `hidden`
    // and `seo_only`), not `buildPublicArticleWhere`'s collectability
    // fragment — see `@/server/publication/visibility.ts`'s header and this
    // file's own `../home-carousel/queries.test.ts` C-25 where-shape test.
    expect(source).toContain("buildPublicListArticleWhere");
    expect(source).not.toMatch(/upstreamCode|rawPayload|raw_payload/);
    // PR6 fix B-1/B-2: `heroImageUrl` has no DB column (see the module's own
    // doc comment) — this file must never select/alias/assign it, only
    // leave it unset via toNovelDetailView. A source-scan for the field name
    // is the cheapest guard against a future "just read novel.heroImageUrl"
    // shortcut landing here.
    expect(source).not.toMatch(/heroImageUrl/);
    // Behavioral coverage for "service reverted to a bare `return []`" lives in
    // tests/backend/home-carousel/queries.test.ts (positive-path assertions
    // against a fake db fail immediately if the function stops reading
    // serving/recency data at all).
  });
});
