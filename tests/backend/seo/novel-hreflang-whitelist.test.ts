import { afterEach, describe, expect, it, vi } from "vitest";

import * as localeCanonical from "@/lib/locale/locale-canonical";
import { loadNovelHreflangSiblings } from "@/lib/seo/novel-hreflang";

/**
 * The real D-7 whitelist admits `en`; that case uses the unmocked module.
 * An empty whitelist remains valid and must avoid the DB entirely. Only
 * that case overrides the whitelist, and the spy is restored after it.
 */
afterEach(() => vi.restoreAllMocks());

describe("loadNovelHreflangSiblings · D-7 whitelist boundary", () => {
  it("queries the DB for en siblings instead of short-circuiting", async () => {
    expect(localeCanonical.listPublishableLocales()).toEqual(["en"]);

    const fixtureDb = { article: { findMany: vi.fn().mockResolvedValue([]) } };
    const siblings = await loadNovelHreflangSiblings(fixtureDb as never, "novel-1");

    expect(siblings).toEqual([]);
    expect(fixtureDb.article.findMany).toHaveBeenCalledTimes(1);
    const arg = fixtureDb.article.findMany.mock.calls[0]?.[0] as {
      where?: { AND?: Array<{ locale?: { in?: string[] } }> };
    };
    const extra = arg.where?.AND?.[1];
    expect(extra?.locale?.in).toEqual(["en"]);
  });

  it("returns no siblings without querying the DB when the whitelist is empty", async () => {
    vi.spyOn(localeCanonical, "listPublishableLocales").mockReturnValue([]);
    const fixtureDb = { article: { findMany: vi.fn().mockResolvedValue([]) } };

    expect(await loadNovelHreflangSiblings(fixtureDb as never, "novel-1")).toEqual([]);
    expect(fixtureDb.article.findMany).not.toHaveBeenCalled();
  });
});
