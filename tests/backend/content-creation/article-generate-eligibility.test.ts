import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { listNovelsForArticleGenerate, loadPinnedNovelForArticleGenerate } from "@/server/content-creation/eligibility";

type SeedNovel = {
  id: string;
  title: string;
  locale: string;
  businessId: string;
  deletedAt: Date | null;
  updatedAt: Date;
  hasLiveArticle: boolean;
  hasSoftDeletedArticle?: boolean;
};

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function matchesWhere(novel: SeedNovel, where: Record<string, unknown>): boolean {
  if (where.deletedAt === null && novel.deletedAt !== null) return false;
  if (typeof where.locale === "string" && novel.locale !== where.locale) return false;
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
  return true;
}

function createDb(novels: SeedNovel[], promoCalls: unknown[] = []) {
  return {
    novel: {
      count: async ({ where }: { where: Record<string, unknown> }) =>
        novels.filter((novel) => matchesWhere(novel, where)).length,
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

  it("eligibleOnly keeps older books without a live article when paging past 200", async () => {
    const novels = seedLibrary(201, 3);
    const db = createDb(novels);
    const page = await listNovelsForArticleGenerate(db, { page: 1, pageSize: 80, eligibleOnly: true });
    expect(page.total).toBe(3);
    expect(page.rows.map((row) => row.title)).toEqual([
      "Older Eligible 3",
      "Older Eligible 2",
      "Older Eligible 1",
    ]);
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
    const page = await listNovelsForArticleGenerate(db, { search: "Novel", locale: "en", page: 1, pageSize: 80 });
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
