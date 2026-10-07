/**
 * B-38 第二部分用例共用的**内存 db**：不是"忽略 `take` 直接返回全部行"的桩，而是遵守 `take` / 排序的
 * 最小实现——页面的列表窗口（`take = PUBLIC_LIST_CAP`）、推荐候选池（`take = RELATED_NOVELS_POOL_SIZE`）、
 * 标签投影（`$queryRaw`，按序号区间给书挂分类）、详情 / 章节 / 站点设置 / 主推位都有。它按种类数每一种查询
 * 发了几次（`counts`），供"一次渲染到底查了几次"的用例引用。
 *
 * 只适合"窗口、分类归属、去重"这类**形状**断言；真实约束、真实角色的版本在
 * `tests/integration/tasks/sitemap-category-cap-postgres.test.ts`。
 *
 * 约定：某语种序号 g 的书发布时间 = BASE + g 秒，所以该语种最新 240 本 = 序号 (N-239)..N。
 */
import type { PrismaClient } from "@prisma/client";

import { PUBLIC_LIST_CAP } from "@/lib/site/queries";
import { RELATED_NOVELS_POOL_SIZE } from "@/lib/site/related-novels";

export const WINDOW_KEY = "article.findMany[列表窗口 take=240]";
export const POOL_KEY = "article.findMany[推荐候选池 take=500]";
export const TAXONOMY_KEY = "$queryRaw[标签投影]";

const BASE = Date.parse("2026-01-01T00:00:00.000Z");

export type Category = {
  slug: string;
  sortOrder: number;
  /** 序号闭区间：序号落在任一区间里的书归这个分类。 */
  ordinals: ReadonlyArray<readonly [number, number]>;
  /** 只对这个语种的书生效；缺省 = 所有语种。 */
  locale?: string;
};

export function bookRow(ordinal: number, locale = "en") {
  const novelId = `novel-${locale}-${ordinal}`;
  return {
    id: `article-${locale}-${String(ordinal).padStart(4, "0")}`,
    novelId,
    title: `Book ${ordinal}`,
    slug: `book-${locale}-${ordinal}`,
    locale,
    // 短码全局唯一：en 保持 `s{序号}`（既有用例依赖），其它语种带语种码，免得不同语种同序号的书撞短码。
    publicPageShortId: locale === "en" ? `s${ordinal}` : `s${locale.toLowerCase().replace(/[^a-z0-9]/g, "")}${ordinal}`,
    publishedAt: new Date(BASE + ordinal * 1000),
    updatedAt: new Date(BASE + ordinal * 1000),
    summary: null as string | null,
    body: "",
    seoMetadata: null,
    status: "published",
    seoVisibility: "public",
    deletedAt: null as Date | null,
    novel: {
      id: novelId, businessId: `biz-${locale}-${ordinal}`, title: `Book ${ordinal}`, description: "Desc",
      coverUrl: `https://img.example/${locale}/${ordinal}.webp`, locale, totalChapterCount: 3, status: "published",
      deletedAt: null as Date | null,
    },
    promoLink: {
      status: "fetched", webUrl: `https://promo.example/${ordinal}`, appUrl: null as string | null,
      publicRedirectCode: "r0123456789abcdefghij", deletedAt: null as Date | null,
    },
  };
}

export type Row = ReturnType<typeof bookRow>;

export function books(count: number, locale = "en"): Row[] {
  return Array.from({ length: count }, (_, index) => bookRow(index + 1, locale));
}

/** 详情页路由段：`/novel/{slug}-p{shortId}`。 */
export function slugParamOf(ordinal: number, locale = "en") {
  const row = bookRow(ordinal, locale);
  return `${row.slug}-p${row.publicPageShortId}`;
}

function tagId(category: Category) {
  return `00000000-0000-4000-8000-${String(category.sortOrder).padStart(12, "0")}`;
}

const SITE_SETTING_ROW = {
  siteName: "Fixture", siteDescription: "", homeMetaTitle: "", homeMetaDescription: "", defaultOgImage: "",
  googleSearchConsoleVerification: "", footerCopyrightText: "", footerDisclaimerText: "", friendLinks: [],
  indexNowHost: "", indexNowKey: "", indexNowKeyLocation: "", ga4MeasurementId: null,
  yandexVerification: "", yandexMetricaId: null, updatedAt: new Date("2025-06-01T00:00:00.000Z"),
};

export function makeFakeDb(rows: readonly Row[], categories: readonly Category[]) {
  const counts: Record<string, number> = {};
  const bump = (key: string) => {
    counts[key] = (counts[key] ?? 0) + 1;
  };
  const ordinalOf = (row: Row) => Number(row.novelId.split("-").at(-1));
  const db = {
    article: {
      findFirst: async (args: { where: { AND: Array<Record<string, unknown>> } }) => {
        bump("article.findFirst");
        const extra = args.where.AND[1]!;
        const row = rows.find((candidate) =>
          "publicPageShortId" in extra ? candidate.publicPageShortId === extra.publicPageShortId : candidate.id === extra.id);
        return row ? structuredClone(row) : null;
      },
      findMany: async (args: { take?: number; where: { AND: Array<Record<string, unknown>> } }) => {
        const extra = args.where.AND[1]!;
        if ("novelId" in extra) {
          bump("article.findMany[hreflang siblings]");
          return rows.filter((row) => row.novelId === extra.novelId).map((row) => structuredClone(row));
        }
        bump(args.take === PUBLIC_LIST_CAP ? WINDOW_KEY
          : args.take === RELATED_NOVELS_POOL_SIZE ? POOL_KEY : "article.findMany[其它]");
        return rows
          .filter((row) => row.locale === extra.locale)
          .sort((a, b) => b.publishedAt.valueOf() - a.publishedAt.valueOf() || a.id.localeCompare(b.id))
          .slice(0, args.take)
          .map((row) => structuredClone(row));
      },
    },
    novelChapter: {
      findMany: async () => {
        bump("novelChapter.findMany");
        return [{ canonicalChapterNumber: 1, title: "Chapter 1" }];
      },
      findFirst: async () => {
        bump("novelChapter.findFirst");
        return { canonicalChapterNumber: 1, title: "Chapter 1", content: { body: "Paragraph one.\n\nParagraph two." } };
      },
    },
    homeCarouselServing: {
      findMany: async () => {
        bump("homeCarouselServing.findMany");
        return [];
      },
    },
    canonicalTag: {
      findFirst: async ({ where }: { where: { slug: string } }) => {
        bump("canonicalTag.findFirst");
        const category = categories.find((candidate) => candidate.slug === where.slug);
        return category
          ? { id: tagId(category), slug: category.slug, status: "active", sortOrder: category.sortOrder,
              updatedAt: new Date("2025-01-01T00:00:00.000Z"), translations: [] }
          : null;
      },
    },
    siteSetting: {
      findUnique: async () => {
        bump("siteSetting.findUnique");
        return structuredClone(SITE_SETTING_ROW);
      },
    },
    $queryRaw: async (query: { values?: unknown[] }) => {
      bump(TAXONOMY_KEY);
      const wanted = new Set((query.values ?? []).flat(Infinity) as unknown[]);
      return rows
        .filter((row) => wanted.has(row.novelId))
        .flatMap((row) => categories
          .filter((category) => (category.locale === undefined || category.locale === row.locale)
            && category.ordinals.some(([from, to]) => ordinalOf(row) >= from && ordinalOf(row) <= to))
          .map((category) => ({
            novel_id: row.novelId, id: tagId(category), slug: category.slug,
            requested_display_name: category.slug[0]!.toUpperCase() + category.slug.slice(1),
            en_display_name: null, zh_display_name: null, sort_order: category.sortOrder,
            updated_at: new Date("2025-01-01T00:00:00.000Z"),
          })));
    },
  };
  return { db: db as unknown as PrismaClient, counts };
}

export type FakeDb = ReturnType<typeof makeFakeDb>;
