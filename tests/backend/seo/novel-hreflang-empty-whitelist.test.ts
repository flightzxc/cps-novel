import { describe, expect, it, vi } from "vitest";

import { listPublishableLocales } from "@/lib/locale/locale-canonical";
import { loadNovelHreflangSiblings } from "@/lib/seo/novel-hreflang";

/**
 * Real (unmocked) D-7 whitelist state, matching
 * `static-sitemap.test.ts`'s "fails closed through the refresh chain while
 * D-7 keeps the publishable locale list empty" — the same fail-closed
 * invariant, this time for the hreflang layer instead of sitemap
 * generation.
 */
describe("loadNovelHreflangSiblings · empty publish whitelist (today's real state)", () => {
  it("short-circuits to an empty sibling list without touching the DB", async () => {
    expect(listPublishableLocales()).toEqual([]);

    const fixtureDb = { article: { findMany: vi.fn() } };
    const siblings = await loadNovelHreflangSiblings(fixtureDb as never, "novel-1");

    expect(siblings).toEqual([]);
    expect(fixtureDb.article.findMany).not.toHaveBeenCalled();
  });
});
