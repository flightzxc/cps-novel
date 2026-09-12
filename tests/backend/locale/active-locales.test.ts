import { describe, expect, it, vi } from "vitest";

import { queryActiveLocales } from "@/lib/locale/active-locales";
import { SITE_LOCALES } from "@/lib/locale/locale-canonical";

/**
 * L10N P4 (矩阵 #9): `getActiveLocales()`'s un-cached core, `queryActiveLocales`,
 * against a fixture `db` — bypasses `unstable_cache` entirely (it depends on
 * Next.js request/build-time runtime machinery `vitest` does not provide),
 * per that function's own doc comment. Production wiring (the real `prisma`
 * singleton, `unstable_cache` tag/revalidate) is exercised structurally in
 * `active-locales.ts` itself (COPY/ADAPT parity with CPS) and by
 * `tests/backend/publication/revalidate.test.ts`'s `revalidateTag("active-locales")`
 * assertion (the invalidation half of this layer).
 */

function groupByRow(locale: string, count = 1) {
  return { locale, _count: { _all: count } };
}

function fixtureDb(rows: ReturnType<typeof groupByRow>[]) {
  return { article: { groupBy: vi.fn().mockResolvedValue(rows) } };
}

describe("queryActiveLocales — post-processing (SITE_LOCALES bounding, en-always-included, ordering)", () => {
  it("includes a locale the DB reports as having visible content", async () => {
    const db = fixtureDb([groupByRow("ru", 3)]);
    const active = await queryActiveLocales(db as never);
    expect(active).toContain("ru");
  });

  it("en is always included even when the DB reports zero en rows", async () => {
    const db = fixtureDb([groupByRow("ru", 1)]);
    const active = await queryActiveLocales(db as never);
    expect(active).toContain("en");
  });

  it("a locale the DB does not report (e.g. cs, no visible content) is excluded", async () => {
    const db = fixtureDb([groupByRow("ru", 1)]);
    const active = await queryActiveLocales(db as never);
    expect(active).not.toContain("cs");
  });

  it("bounds the result to SITE_LOCALES — a stray/unregistered locale value from the DB is dropped, not passed through", async () => {
    const db = fixtureDb([groupByRow("ru", 1), groupByRow("xx-not-a-real-locale", 5)]);
    const active = await queryActiveLocales(db as never);
    expect(active).toContain("ru");
    expect(active).not.toContain("xx-not-a-real-locale");
  });

  it("orders the result by SITE_LOCALES' own registry order, not DB return order", async () => {
    // groupBy returns them in a deliberately "wrong" order (ru before es before en).
    const db = fixtureDb([groupByRow("ru", 1), groupByRow("es", 1), groupByRow("en", 1)]);
    const active = await queryActiveLocales(db as never);
    const activeSiteLocaleOrder = SITE_LOCALES.filter((locale) => active.includes(locale));
    expect(active).toEqual(activeSiteLocaleOrder);
    // en (index 0 in SITE_LOCALES) sorts before es, which sorts before ru.
    expect(active.indexOf("en")).toBeLessThan(active.indexOf("es"));
    expect(active.indexOf("es")).toBeLessThan(active.indexOf("ru"));
  });

  it("zero DB rows still returns exactly [en] — never an empty array", async () => {
    const db = fixtureDb([]);
    const active = await queryActiveLocales(db as never);
    expect(active).toEqual(["en"]);
  });

  it("mutation guard: hardcoding the result to a fixed [\"en\"] constant (ignoring the DB) is exactly what this suite as a whole would need to catch — the 'ru visible -> contains ru' test above is the one that goes red", async () => {
    // This test exists only to name the mutation explicitly for the drill
    // (§H mutation ①): `getActiveLocales` reverted to a hardcoded `["en"]`.
    // The actual red comes from the "includes a locale the DB reports" test
    // above once queryActiveLocales stops reading `rows` at all.
    const db = fixtureDb([groupByRow("ru", 1)]);
    const active = await queryActiveLocales(db as never);
    expect(active).not.toEqual(["en"]);
  });
});

describe("queryActiveLocales — collectability where (matches sitemap.ts's activePublicArticleWhere, not a second visibility where)", () => {
  it("groups by locale, restricted to SITE_LOCALES, using the shared activePublicArticleWhere shape", async () => {
    const groupBy = vi.fn().mockResolvedValue([]);
    const db = { article: { groupBy } };
    await queryActiveLocales(db as never);

    expect(groupBy).toHaveBeenCalledTimes(1);
    const call = groupBy.mock.calls[0]![0] as {
      by: string[];
      where: { AND: Array<Record<string, unknown>> };
    };
    expect(call.by).toEqual(["locale"]);

    const serialized = JSON.stringify(call.where);
    // The base collectability fragment (PUBLIC_ARTICLE_RECORD, via
    // buildPublicArticleWhere) — published Novel/Article, promo fetched.
    expect(serialized).toContain('"status":"published"');
    expect(serialized).toContain('"novel":{"is":{"deletedAt":null,"status":"published"}}');
    // The locale scope is bounded to SITE_LOCALES, not a narrower/wider set.
    const localeClause = call.where.AND.find((clause) => "locale" in clause) as
      | { locale?: { in?: string[] } }
      | undefined;
    expect(localeClause?.locale?.in).toEqual([...SITE_LOCALES]);
  });

  it("mutation guard (§H ⑥): the promo-readiness condition (isPromoReady's DB-level superset — promoLink.status=fetched + non-blank webUrl/appUrl) must be present in the where; a where that omits it is exactly the 'second, weaker visibility where' the construction prompt forbids", async () => {
    const groupBy = vi.fn().mockResolvedValue([]);
    const db = { article: { groupBy } };
    await queryActiveLocales(db as never);

    const call = groupBy.mock.calls[0]![0] as { where: { AND: Array<Record<string, unknown>> } };
    const serialized = JSON.stringify(call.where);
    // PUBLIC_ARTICLE_RECORD's promoLink.status=fetched pre-filter...
    expect(serialized).toContain('"status":"fetched"');
    // ...plus the non-blank-URL superset activePublicArticleWhere adds on top.
    expect(serialized).toContain('"webUrl":{"not":""}');
    expect(serialized).toContain('"appUrl":{"not":""}');
  });
});
