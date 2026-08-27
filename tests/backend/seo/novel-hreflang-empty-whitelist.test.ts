import { describe, expect, it, vi } from "vitest";

import { listPublishableLocales } from "@/lib/locale/locale-canonical";
import { loadNovelHreflangSiblings } from "@/lib/seo/novel-hreflang";

/**
 * Real (unmocked) D-7 whitelist state. U6 admitted `en`; the empty-list
 * short-circuit in `loadNovelHreflangSiblings` no longer fires, so this
 * layer must query the DB restricted to the publishable set.
 */
describe("loadNovelHreflangSiblings · D-7 whitelist is {en}", () => {
  it("queries the DB for en siblings instead of short-circuiting", async () => {
    expect(listPublishableLocales()).toEqual(["en"]);

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
});
