import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Anti-regression guard for P0-S7a's "本单最关键项": the Novel/Article
 * detail hreflang layer must never fall back to the same-path blind
 * enumeration (`seo-utils.ts#buildHreflangAlternates`), because a detail
 * page's path varies per locale (slug + short id) — blindly enumerating
 * `listPublishableLocales()` there (let alone the full `SITE_LOCALES`
 * registry) would point hreflang at URLs with no guarantee of existing.
 *
 * Two independent nets, deliberately redundant:
 * 1. Static source scan (this file) — `seo-templates/novel.ts` must not
 *    import `buildHreflangAlternates` at all. If it did, nothing else in
 *    this file's other checks would catch a future call site sneaking it
 *    back in through a different import path.
 * 2. Type-level: `NovelSeoData.hreflangAlternates` is a REQUIRED field (see
 *    `seo-templates/novel.ts`), so any caller that forgets to supply
 *    DB-verified alternates fails to compile — see
 *    `tests/ui/public-routes.test.tsx`'s "never blindly enumerates the full
 *    registry when there is no published sibling" test for the
 *    behavioural counterpart (mocked DB, zero siblings, asserts the output
 *    contains only the current locale + x-default, not all 15 registered
 *    locales).
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const NOVEL_TEMPLATE_PATH = "src/lib/seo/seo-templates/novel.ts";

/**
 * Same comment-stripping convention as `site-url-single-source.test.ts` /
 * `locale-canonical.test.ts`: lines whose trimmed form starts with `//`,
 * `*`, or `/*` don't count, so an explanatory comment mentioning the banned
 * identifier by name (as this very file's neighbour, `seo-templates/
 * novel.ts`, does in its `hreflangAlternates` doc comment) doesn't trip the
 * guard. Only live code counts.
 */
function nonCommentSource(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*"));
    })
    .join("\n");
}

describe("novel hreflang · anti-regression (P0-S7a)", () => {
  it("seo-templates/novel.ts never imports the same-path blind-enumeration builder", () => {
    const source = nonCommentSource(resolve(repoRoot, NOVEL_TEMPLATE_PATH));
    expect(source).not.toMatch(/buildHreflangAlternates/);
  });

  it("NovelSeoData declares hreflangAlternates as a required (non-optional) field", () => {
    const source = readFileSync(resolve(repoRoot, NOVEL_TEMPLATE_PATH), "utf8");
    // A required field is `name: Type;` — an optional one would be `name?: Type;`.
    // This regex specifically rejects the `?:` form.
    expect(source).toMatch(/hreflangAlternates:\s*Record<string,\s*string>;/);
    expect(source).not.toMatch(/hreflangAlternates\?:/);
  });
});
