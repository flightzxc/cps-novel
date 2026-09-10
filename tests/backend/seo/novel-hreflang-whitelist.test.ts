import { describe, expect, it, vi } from "vitest";

import { SITE_LOCALES } from "@/lib/locale/locale-canonical";
import { loadNovelHreflangSiblings } from "@/lib/seo/novel-hreflang";

/**
 * L10N P4: `loadNovelHreflangSiblings`'s `locale in` filter used to
 * intersect with the D-7 publish whitelist (`listPublishableLocales()`,
 * `{en}`) — that whitelist was deleted this round (矩阵 #9). The query now
 * always restricts to the full, always-non-empty `SITE_LOCALES` registry
 * (the static layer), so there is no more "empty whitelist -> skip the DB
 * entirely" short-circuit to test — see `docs/governance/port-registry.md`'s
 * P4 section, §2.B: "novel-hreflang.ts sibling 查询的 locale in 改
 * SITE_LOCALES". The row-level visibility recheck (`isVisibleSibling`) is
 * unchanged and untested here (see `tests/backend/seo/novel-hreflang.test.ts`
 * for that coverage).
 */
describe("loadNovelHreflangSiblings · SITE_LOCALES boundary (L10N P4)", () => {
  it("queries the DB with locale.in set to the full SITE_LOCALES registry, not a narrower whitelist", async () => {
    const fixtureDb = { article: { findMany: vi.fn().mockResolvedValue([]) } };
    const siblings = await loadNovelHreflangSiblings(fixtureDb as never, "novel-1");

    expect(siblings).toEqual([]);
    expect(fixtureDb.article.findMany).toHaveBeenCalledTimes(1);
    const arg = fixtureDb.article.findMany.mock.calls[0]?.[0] as {
      where?: { AND?: Array<{ locale?: { in?: string[] } }> };
    };
    const extra = arg.where?.AND?.[1];
    expect(extra?.locale?.in).toEqual([...SITE_LOCALES]);
    expect(extra?.locale?.in?.length).toBe(15);
  });

  it("mutation guard: never skips the DB — SITE_LOCALES is never empty, unlike the deleted whitelist", async () => {
    expect(SITE_LOCALES.length).toBeGreaterThan(0);
    const fixtureDb = { article: { findMany: vi.fn().mockResolvedValue([]) } };
    await loadNovelHreflangSiblings(fixtureDb as never, "novel-1");
    expect(fixtureDb.article.findMany).toHaveBeenCalledTimes(1);
  });
});
