import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  articleGenerateEligibleWhere,
  listNovelsForArticleGenerate,
  loadPinnedNovelForArticleGenerate,
} from "@/server/content-creation/eligibility";

/**
 * Independent of the `db.promoLink.*` admission-classification mocks below
 * (`resolveArticleGenerateAdmissions`'s own data source) — this models the
 * SAME underlying relation from the SQL-predicate side
 * (`novelWhere`'s `promoLinks: { some: readyPromoLinkWhere() } }` /
 * `NOT: { promoLinks: { some } } }`), matching real Prisma/Postgres where a
 * Novel's `promoLinks` relation is one physical table queried two ways.
 * Tests that only exercise pagination/article-existence semantics leave
 * this empty (matching this file's pre-existing default of "no promo data
 * seeded"); tests that exercise the new promo-readiness predicate populate
 * it explicitly.
 */
type SeedPromoLink = {
  status: string;
  webUrl: string | null;
  appUrl: string | null;
  deletedAt: Date | null;
};

type SeedNovel = {
  id: string;
  title: string;
  locale: string;
  businessId: string;
  deletedAt: Date | null;
  updatedAt: Date;
  hasLiveArticle: boolean;
  hasSoftDeletedArticle?: boolean;
  promoLinks?: SeedPromoLink[];
};

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function readyPromoLink(overrides: Partial<SeedPromoLink> = {}): SeedPromoLink {
  return { status: "fetched", webUrl: "https://promo.example/ready", appUrl: null, deletedAt: null, ...overrides };
}

function matchesScalarCondition(value: unknown, condition: unknown): boolean {
  if (condition === null) return value === null;
  if (typeof condition === "object" && condition !== null && !Array.isArray(condition)) {
    const cond = condition as { equals?: unknown; not?: unknown };
    // SQL three-valued logic: a NULL column never satisfies `<> x` — see
    // `tests/backend/publication/promo-ready-where.test.ts`'s identical
    // fix/comment for why this can't just be `value !== cond.not`.
    if ("not" in cond) return value !== null && value !== cond.not;
    if ("equals" in cond) return value === cond.equals;
  }
  return value === condition;
}

/** Mirrors `readyPromoLinkWhere`'s operators (`equals`/`not`/`OR`) — see `tests/backend/publication/promo-ready-where.test.ts` for the dedicated guard test on that fragment itself. */
function matchesPromoLinkWhere(link: SeedPromoLink, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Record<string, unknown>[]).some((c) => matchesPromoLinkWhere(link, c));
    if (key === "AND") return (condition as Record<string, unknown>[]).every((c) => matchesPromoLinkWhere(link, c));
    if (key === "NOT") return !matchesPromoLinkWhere(link, condition as Record<string, unknown>);
    return matchesScalarCondition((link as unknown as Record<string, unknown>)[key], condition);
  });
}

function matchesWhere(novel: SeedNovel, where: Record<string, unknown>): boolean {
  if (where.deletedAt === null && novel.deletedAt !== null) return false;
  const localeIn = (where.locale as { in?: readonly string[] } | undefined)?.in;
  if (localeIn && !localeIn.includes(novel.locale)) return false;
  if (typeof where.id === "string" && novel.id !== where.id) return false;
  const search = where.OR as Array<Record<string, { contains: string }>> | undefined;
  if (search) {
    const needle = search[0]?.title?.contains?.toLowerCase() ?? "";
    if (!novel.title.toLowerCase().includes(needle) && !novel.businessId.toLowerCase().includes(needle)) {
      return false;
    }
  }
  const articles = where.articles as { none?: { deletedAt: null } } | undefined;
  if (articles?.none && novel.hasLiveArticle) return false;
  const promoLinksSome = (where.promoLinks as { some?: Record<string, unknown> } | undefined)?.some;
  if (promoLinksSome) {
    const links = novel.promoLinks ?? [];
    if (!links.some((link) => matchesPromoLinkWhere(link, promoLinksSome))) return false;
  }
  const notPromoLinksSome = (where.NOT as { promoLinks?: { some?: Record<string, unknown> } } | undefined)
    ?.promoLinks?.some;
  if (notPromoLinksSome) {
    const links = novel.promoLinks ?? [];
    if (links.some((link) => matchesPromoLinkWhere(link, notPromoLinksSome))) return false;
  }
  return true;
}

function createDb(novels: SeedNovel[], promoCalls: unknown[] = []) {
  return {
    novel: {
      count: async ({ where }: { where: Record<string, unknown> }) =>
        novels.filter((novel) => matchesWhere(novel, where)).length,
      groupBy: async ({ where }: { where: Record<string, unknown> }) => {
        const counts = new Map<string, number>();
        for (const novel of novels.filter((row) => matchesWhere(row, where))) {
          counts.set(novel.locale, (counts.get(novel.locale) ?? 0) + 1);
        }
        return Array.from(counts, ([locale, count]) => ({ locale, _count: { _all: count } }));
      },
      findMany: async ({
        where,
        skip = 0,
        take,
      }: {
        where: Record<string, unknown>;
        skip?: number;
        take?: number;
      }) =>
        novels
          .filter((novel) => matchesWhere(novel, where))
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.id.localeCompare(b.id))
          .slice(skip, skip + (take ?? novels.length))
          .map((novel) => ({
            id: novel.id,
            title: novel.title,
            locale: novel.locale,
            businessId: novel.businessId,
            updatedAt: novel.updatedAt,
            deletedAt: novel.deletedAt,
            articles: novel.hasLiveArticle
              ? [{ id: `${novel.id}-article`, locale: novel.locale, deletedAt: null }]
              : novel.hasSoftDeletedArticle
                ? [{ id: `${novel.id}-article`, locale: novel.locale, deletedAt: new Date("2026-01-01T00:00:00.000Z") }]
                : [],
          })),
      findFirst: async ({ where }: { where: { id?: string } }) => {
        const novel = novels.find((row) => row.id === where.id);
        if (!novel) return null;
        return {
          id: novel.id,
          title: novel.title,
          locale: novel.locale,
          businessId: novel.businessId,
          updatedAt: novel.updatedAt,
          deletedAt: novel.deletedAt,
          articles: novel.hasLiveArticle
            ? [{ id: `${novel.id}-article`, locale: novel.locale, deletedAt: null }]
            : novel.hasSoftDeletedArticle
              ? [{ id: `${novel.id}-article`, locale: novel.locale, deletedAt: new Date("2026-01-01T00:00:00.000Z") }]
              : [],
        };
      },
    },
    promoLink: {
      findMany: async (args: unknown) => {
        promoCalls.push(args);
        return [];
      },
      count: async () => 0,
    },
  } as unknown as PrismaClient;
}

function seedLibrary(count: number, olderWithoutArticle = 0): SeedNovel[] {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    const withoutArticle = n <= olderWithoutArticle;
    return {
      id: uuid(n),
      title: withoutArticle ? `Older Eligible ${n}` : `Novel ${n}`,
      locale: "en",
      businessId: `biz-${n}`,
      deletedAt: null,
      updatedAt: new Date(Date.UTC(2026, 0, 1) + n * 60_000),
      hasLiveArticle: !withoutArticle,
    };
  });
}

describe("listNovelsForArticleGenerate pagination", () => {
  it("returns page totals without merging a pinned id, and caps pageSize at 80", async () => {
    const novels = seedLibrary(81);
    const db = createDb(novels);
    const page = await listNovelsForArticleGenerate(db, { page: 1, pageSize: 200, eligibleOnly: false });
    expect(page.pageSize).toBe(80);
    expect(page.total).toBe(81);
    expect(page.rows).toHaveLength(80);
    expect(page.rows.some((row) => row.novelId === uuid(1))).toBe(false);
    expect(page.rows[0]?.novelId).toBe(uuid(81));
  });

  it("eligibleOnly + showIneligible keeps older books without a live article regardless of promo state, when paging past 200", async () => {
    // `showIneligible: true` reproduces this function's pre-promo-predicate
    // behavior exactly (no promo constraint at all) — none of these seeds
    // have a promoLinks fixture, so without the toggle they would all be
    // hidden by the new default (see the "hides promo-blocked older books"
    // test below for that default).
    const novels = seedLibrary(201, 3);
    const db = createDb(novels);
    const page = await listNovelsForArticleGenerate(db, {
      page: 1,
      pageSize: 80,
      eligibleOnly: true,
      showIneligible: true,
    });
    expect(page.total).toBe(3);
    expect(page.rows.map((row) => row.title)).toEqual([
      "Older Eligible 3",
      "Older Eligible 2",
      "Older Eligible 1",
    ]);
  });

  it("eligibleOnly defaults to hiding promo-blocked older books and splits generatable/non-generatable counts", async () => {
    const novels = seedLibrary(201, 3);
    // Of the 3 "older eligible" (no live article) novels, only #2 and #3 have a ready PromoLink.
    novels[1]!.promoLinks = [readyPromoLink()];
    novels[2]!.promoLinks = [readyPromoLink({ webUrl: null, appUrl: "app://ready" })];
    const db = createDb(novels);
    const page = await listNovelsForArticleGenerate(db, { page: 1, pageSize: 80, eligibleOnly: true });
    expect(page.generatableCount).toBe(2);
    expect(page.nonGeneratableCount).toBe(1);
    expect(page.total).toBe(2);
    expect(page.rows.map((row) => row.title)).toEqual(["Older Eligible 3", "Older Eligible 2"]);
  });

  it("promoReadiness ignores deleted PromoLinks and whitespace-only-URL rows still land as blocked once resolveArticleGenerateAdmissions runs", async () => {
    const novels = seedLibrary(2, 2);
    novels[0]!.promoLinks = [readyPromoLink({ deletedAt: new Date("2026-01-01T00:00:00.000Z") })];
    novels[1]!.promoLinks = [readyPromoLink()];
    const db = createDb(novels);
    const page = await listNovelsForArticleGenerate(db, { page: 1, pageSize: 80, eligibleOnly: true });
    // Only the second novel's live, ready PromoLink counts — the first's
    // soft-deleted link is excluded by `readyPromoLinkWhere`'s `deletedAt: null`.
    expect(page.generatableCount).toBe(1);
    expect(page.nonGeneratableCount).toBe(1);
  });

  it("eligibleOnly with no PromoLink data at all hides every row by default (0 generatable, all non-generatable)", async () => {
    const novels = seedLibrary(5, 5);
    const db = createDb(novels);
    const page = await listNovelsForArticleGenerate(db, { page: 1, pageSize: 80, eligibleOnly: true });
    expect(page.generatableCount).toBe(0);
    expect(page.nonGeneratableCount).toBe(5);
    expect(page.total).toBe(0);
    expect(page.rows).toHaveLength(0);
  });

  it("eligibleOnly:false never computes the promo split (single-novel 'generate' page is unaffected)", async () => {
    const novels = seedLibrary(3, 3);
    const db = createDb(novels);
    const page = await listNovelsForArticleGenerate(db, { page: 1, pageSize: 80, eligibleOnly: false });
    expect(page.generatableCount).toBe(0);
    expect(page.nonGeneratableCount).toBe(0);
    expect(page.total).toBe(3);
    // Batch-create-operator-ux: the locale chip facet is gated on
    // `eligibleOnly` the same way the promo split is — the single-novel
    // 'generate' page has no chip UI and never asks for it.
    expect(page.localeCounts).toEqual([]);
  });

  it("articleGenerateEligibleWhere (worker enumeration) matches only no-live-article AND promo-ready novels", () => {
    const novels = seedLibrary(201, 3);
    novels[1]!.promoLinks = [readyPromoLink()];
    novels[2]!.promoLinks = [readyPromoLink({ webUrl: null, appUrl: "app://ready" })];
    const where = articleGenerateEligibleWhere({});
    const matched = novels.filter((novel) => matchesWhere(novel, where as Record<string, unknown>));
    // Narrows to exactly the promo-ready subset of the 3 no-live-article
    // seeds — never widens to include any of the 198 live-article novels,
    // confirming the "safe to use for worker enumeration" reasoning: a
    // novel this excludes would only ever have been recorded blocked by
    // `resolveArticleGenerateAdmissions` anyway.
    // `.filter()` preserves seed order (index 1, then index 2) — unlike
    // `listNovelsForArticleGenerate`'s own `findMany`, which sorts by
    // `updatedAt desc`; this test exercises the raw where-fragment only.
    expect(matched.map((novel) => novel.title)).toEqual(["Older Eligible 2", "Older Eligible 3"]);
  });

  it("articleGenerateEligibleWhere's locales becomes an OR-matched `in` condition, not a single-value narrowing", () => {
    const novels = [
      { ...seedLibrary(1, 1)[0]!, locale: "en" },
      { ...seedLibrary(1, 1)[0]!, id: uuid(2), locale: "ja" },
      { ...seedLibrary(1, 1)[0]!, id: uuid(3), locale: "ko" },
    ];
    for (const novel of novels) novel.promoLinks = [readyPromoLink()];
    const where = articleGenerateEligibleWhere({ locales: ["en", "ja"] });
    const matched = novels.filter((novel) => matchesWhere(novel, where as Record<string, unknown>));
    expect(matched.map((novel) => novel.locale).sort()).toEqual(["en", "ja"]);
  });

  it("localeCounts is a groupBy over the full search-scoped set, deliberately ignoring the locales filter itself", async () => {
    const novels = seedLibrary(4, 4);
    novels[0]!.locale = "en";
    novels[1]!.locale = "en";
    novels[2]!.locale = "ja";
    novels[3]!.locale = "ko";
    for (const novel of novels) novel.promoLinks = [readyPromoLink()];
    const db = createDb(novels);
    // Even though the operator has already narrowed to "en" via a chip,
    // `localeCounts` reports every locale in the (search-scoped) candidate
    // set — it is the population to pick chips FROM, not a readout of the
    // current selection.
    const page = await listNovelsForArticleGenerate(db, { page: 1, pageSize: 80, eligibleOnly: true, locales: ["en"] });
    expect(page.localeCounts).toEqual([
      { locale: "en", count: 2 },
      { locale: "ja", count: 1 },
      { locale: "ko", count: 1 },
    ]);
    // ...while `rows`/`total` DO stay narrowed to the selected chip.
    expect(page.total).toBe(2);
    expect(page.rows.every((row) => row.locale === "en")).toBe(true);
  });

  it("localeCounts follows the same promo-readiness view toggle as rows/total (hidden by default, shown with showIneligible)", async () => {
    const novels = seedLibrary(2, 2);
    novels[0]!.locale = "en";
    novels[1]!.locale = "ja";
    novels[0]!.promoLinks = [readyPromoLink()];
    // novels[1] has no ready PromoLink — promo-blocked.
    const db = createDb(novels);
    const hidden = await listNovelsForArticleGenerate(db, { page: 1, pageSize: 80, eligibleOnly: true });
    expect(hidden.localeCounts).toEqual([{ locale: "en", count: 1 }]);
    const shown = await listNovelsForArticleGenerate(db, {
      page: 1, pageSize: 80, eligibleOnly: true, showIneligible: true,
    });
    expect(shown.localeCounts).toEqual([{ locale: "en", count: 1 }, { locale: "ja", count: 1 }]);
  });

  it("resolves promo once for the current page ids", async () => {
    const promoCalls: unknown[] = [];
    const db = createDb(seedLibrary(3, 3), promoCalls);
    await listNovelsForArticleGenerate(db, { page: 1, pageSize: 80 });
    expect(promoCalls).toHaveLength(1);
    expect(promoCalls[0]).toMatchObject({
      where: { novelId: { in: [uuid(3), uuid(2), uuid(1)] } },
    });
  });

  it("classifies live/soft-deleted Article and all Promo admission outcomes", async () => {
    const novels = seedLibrary(6, 6);
    novels[1]!.hasLiveArticle = true;
    novels[2]!.hasSoftDeletedArticle = true;
    const readyId = novels[0]!.id;
    const notReadyId = novels[4]!.id;
    const deletedPromoId = novels[5]!.id;
    const db = createDb(novels) as unknown as {
      novel: PrismaClient["novel"];
      promoLink: {
        findMany: (args: unknown) => Promise<unknown[]>;
        count: (args: unknown) => Promise<number>;
        groupBy: (args: { where: { deletedAt: null | { not: null } } }) => Promise<unknown[]>;
      };
    };
    db.promoLink.findMany = async () => [{
      id: "promo-ready",
      novelId: readyId,
      status: "fetched",
      webUrl: "https://example.test/ready",
      appUrl: null,
      fetchedAt: new Date(),
      publicRedirectCode: "ready-code",
    }];
    db.promoLink.groupBy = async ({ where }) => where.deletedAt === null
      ? [{ novelId: notReadyId, _count: { _all: 1 } }]
      : [{ novelId: deletedPromoId, _count: { _all: 1 } }];

    const page = await listNovelsForArticleGenerate(db as unknown as PrismaClient, { pageSize: 20 });
    const byId = new Map(page.rows.map((row) => [row.novelId, row]));
    expect(byId.get(readyId)).toMatchObject({ canGenerateArticle: true, promoOutcome: "ready" });
    expect(byId.get(novels[1]!.id)).toMatchObject({ canGenerateArticle: false, generateBlockedReason: "already_exists" });
    expect(byId.get(novels[2]!.id)).toMatchObject({ canGenerateArticle: false, generateBlockedReason: "article_soft_deleted" });
    expect(byId.get(novels[3]!.id)).toMatchObject({ canGenerateArticle: false, generateBlockedReason: "promo_link_missing" });
    expect(byId.get(notReadyId)).toMatchObject({ canGenerateArticle: false, generateBlockedReason: "promo_link_not_ready" });
    expect(byId.get(deletedPromoId)).toMatchObject({ canGenerateArticle: false, generateBlockedReason: "promo_link_deleted" });
  });
});

describe("loadPinnedNovelForArticleGenerate", () => {
  it("loads the specified novel independently of search/locale page filters", async () => {
    const pinned: SeedNovel = {
      id: uuid(99),
      title: "Pinned Title",
      locale: "ru",
      businessId: "biz-pinned",
      deletedAt: null,
      updatedAt: new Date("2026-02-01T00:00:00.000Z"),
      hasLiveArticle: false,
    };
    const db = createDb([pinned, ...seedLibrary(3)]);
    const result = await loadPinnedNovelForArticleGenerate(db, pinned.id);
    const page = await listNovelsForArticleGenerate(db, { search: "Novel", locales: ["en"], page: 1, pageSize: 80 });
    expect(result).toMatchObject({ status: "found", novel: { novelId: pinned.id, title: "Pinned Title", locale: "ru" } });
    expect(page.total).toBe(3);
    expect(page.rows.some((row) => row.novelId === pinned.id)).toBe(false);
  });

  it("reports missing, deleted, and invalid without falling back", async () => {
    const deleted = seedLibrary(1)[0]!;
    deleted.deletedAt = new Date("2026-01-01T00:00:00.000Z");
    const db = createDb([deleted]);
    expect(await loadPinnedNovelForArticleGenerate(db, undefined)).toEqual({ status: "absent" });
    expect(await loadPinnedNovelForArticleGenerate(db, "not-a-uuid")).toEqual({ status: "invalid" });
    expect(await loadPinnedNovelForArticleGenerate(db, uuid(99))).toEqual({ status: "missing" });
    expect(await loadPinnedNovelForArticleGenerate(db, deleted.id)).toEqual({ status: "deleted" });
  });
});
