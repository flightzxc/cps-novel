/**
 * B-38 第二部分用例共用的**内存 db**：把数据库分页后的公开读路径整条跑通，而不连真实库。
 *
 * 它不是"忽略 SQL 直接返回全部行"的桩，而是按 SQL 的**结构**分派、按**绑定值**求值的最小实现：
 *   - 列表页编号 / 列表总数（`public-list.ts`：`ORDER BY a.published_at DESC` / `count(*)::int AS total`）：
 *     按语种、（可选）分类、`listed` 过滤，发布时间新→旧、同时间编号升序，LIMIT / OFFSET；
 *   - 每语种每分类本数矩阵与每语种列表可见总数（`GROUP BY a.locale …`）；
 *   - 卡片标签（读归属表的 `novel_effective_tag` 查询）与页脚 / 导航的分类名（`canonical_tag` 查询）；
 *   - 按编号补全卡片（`article.findMany({ where: { id: { in } } })`）、推荐候选池（`take = RELATED_NOVELS_POOL_SIZE`）、
 *     详情 / 章节 / 站点设置 / 主推位；
 * 并按种类数每一种查询发了几次（`counts`），供"一次渲染到底查了几次"的用例引用。
 *
 * 只适合"形状"断言（查询次数、数据怎样流过各层、页面渲染）。**筛选语义本身**（可见性、归属、排序、并列、开关组合、
 * 极端页码）由真实库用例证明：`tests/integration/site/*-postgres.test.ts`——这里的筛选只是为了让数据流得动，
 * 与真实 SQL 的等价关系不在这个文件里证明。
 *
 * 约定：某语种序号 g 的书发布时间 = BASE + g 秒；`listed: false` 的书表示"不进列表"（真实世界里是 seo_only /
 * 推广链接不可用 / 文章草稿…），它的详情页仍可达，但列表、作品数、矩阵都看不到它。
 */
import type { PrismaClient } from "@prisma/client";

import { SITE_LOCALES } from "@/lib/locale/locale-canonical";
import { RELATED_NOVELS_POOL_SIZE } from "@/lib/site/related-novels";

export const MATRIX_KEY = "$queryRaw[每语种每分类本数矩阵]";
export const TOTALS_KEY = "$queryRaw[每语种列表可见总数]";
export const PAGE_IDS_KEY = "$queryRaw[列表页编号]";
export const PAGE_COUNT_KEY = "$queryRaw[列表总数]";
export const TAXONOMY_KEY = "$queryRaw[卡片标签（读归属表）]";
export const CATEGORY_NAMES_KEY = "$queryRaw[分类名]";
export const HYDRATE_KEY = "article.findMany[按编号补全卡片]";
export const POOL_KEY = "article.findMany[推荐候选池 take=500]";

const BASE = Date.parse("2026-01-01T00:00:00.000Z");
const isRegisteredSite = (value: unknown): value is string => typeof value === "string" && (SITE_LOCALES as readonly string[]).includes(value);

export type Category = {
  slug: string;
  sortOrder: number;
  /** 序号闭区间：序号落在任一区间里的书归这个分类。 */
  ordinals: ReadonlyArray<readonly [number, number]>;
  /** 只对这个语种的书生效；缺省 = 所有语种。 */
  locale?: string;
  /**
   * v0.5.15：运营在后台勾选的"是否在首页题材导航显示"（`canonical_tag.is_homepage_visible`）。
   * 缺省 = true（上线默认）。同一个 slug 的多条声明里任何一条写了 false 就算 false。
   */
  homepageVisible?: boolean;
};

export function bookRow(ordinal: number, locale = "en", listed = true) {
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
    /** 夹具专用：false = 不进列表（详情页仍可达）。 */
    listed,
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

/** `count` 本书；`unlistedUpTo` 之内（含）的序号不进列表。 */
export function books(count: number, locale = "en", unlistedUpTo = 0): Row[] {
  return Array.from({ length: count }, (_, index) => bookRow(index + 1, locale, index + 1 > unlistedUpTo));
}

/** 详情页路由段：`/novel/{slug}-p{shortId}`。 */
export function slugParamOf(ordinal: number, locale = "en") {
  const row = bookRow(ordinal, locale);
  return `${row.slug}-p${row.publicPageShortId}`;
}

function ordinalOf(row: Row) {
  return Number(row.novelId.split("-").at(-1));
}

/** 一个分类 = 一个 slug：同一个 slug 的多条 `Category`（按语种分别声明）共用一个分类编号与排序。 */
function tagIdOf(slug: string, categories: readonly Category[]) {
  const index = [...new Set(categories.map((category) => category.slug))].indexOf(slug);
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

function sortOrderOf(slug: string, categories: readonly Category[]) {
  return Math.min(...categories.filter((category) => category.slug === slug).map((category) => category.sortOrder));
}

const SITE_SETTING_ROW = {
  siteName: "Fixture", siteDescription: "", homeMetaTitle: "", homeMetaDescription: "", defaultOgImage: "",
  googleSearchConsoleVerification: "", footerCopyrightText: "", footerDisclaimerText: "", friendLinks: [],
  indexNowHost: "", indexNowKey: "", indexNowKeyLocation: "", ga4MeasurementId: null,
  yandexVerification: "", yandexMetricaId: null, siteSearchEnabled: false, updatedAt: new Date("2025-06-01T00:00:00.000Z"),
};

type SqlLike = { text?: string; sql?: string; strings?: readonly string[]; values?: readonly unknown[] };

function sqlText(query: SqlLike): string {
  return query.text ?? query.sql ?? (query.strings ?? []).join("?");
}

export function classifyPublicListQuery(query: SqlLike):
  "matrix" | "totals" | "page-ids" | "page-count" | "taxonomy" | "category-names" | "other" {
  const text = sqlText(query).replace(/\s+/g, " ");
  if (text.includes("GROUP BY a.locale, m.canonical_tag_id")) return "matrix";
  if (text.includes("GROUP BY a.locale")) return "totals";
  if (text.includes("ORDER BY a.published_at DESC")) return "page-ids";
  if (text.includes("count(*)::int AS total")) return "page-count";
  if (text.includes("FROM novel_effective_tag m JOIN canonical_tag ct")) return "taxonomy";
  if (text.includes("FROM canonical_tag ct LEFT JOIN canonical_tag_translation")) return "category-names";
  return "other";
}

export function makeFakeDb(rows: readonly Row[], categories: readonly Category[]) {
  const counts: Record<string, number> = {};
  const bump = (key: string) => {
    counts[key] = (counts[key] ?? 0) + 1;
  };
  const slugs = [...new Set(categories.map((category) => category.slug))];
  const tagIds = new Map(slugs.map((slug) => [slug, tagIdOf(slug, categories)] as const));
  const slugOfTagId = new Map([...tagIds].map(([slug, id]) => [id, slug] as const));

  const memberSlugs = (row: Row): string[] =>
    slugs.filter((slug) => categories.some((category) => category.slug === slug
      && (category.locale === undefined || category.locale === row.locale)
      && category.ordinals.some(([from, to]) => ordinalOf(row) >= from && ordinalOf(row) <= to)));
  const byRank = (left: string, right: string) =>
    sortOrderOf(left, categories) - sortOrderOf(right, categories) || left.localeCompare(right, "en");

  const listedRows = (locale: string) => rows
    .filter((row) => row.locale === locale && row.listed)
    .sort((a, b) => b.publishedAt.valueOf() - a.publishedAt.valueOf() || a.id.localeCompare(b.id));

  const localesIn = (values: readonly unknown[]) => values.filter(isRegisteredSite);

  const tagRow = (slug: string, locale: string) => ({
    id: tagIds.get(slug)!, slug,
    requested_display_name: slug[0]!.toUpperCase() + slug.slice(1),
    en_display_name: null, zh_display_name: null, sort_order: sortOrderOf(slug, categories),
    updated_at: new Date("2025-01-01T00:00:00.000Z"), locale,
    is_homepage_visible: !categories.some((category) => category.slug === slug && category.homepageVisible === false),
  });

  const db = {
    article: {
      findFirst: async (args: { where: { AND: Array<Record<string, unknown>> } }) => {
        bump("article.findFirst");
        const extra = args.where.AND[1]!;
        const row = rows.find((candidate) =>
          "publicPageShortId" in extra ? candidate.publicPageShortId === extra.publicPageShortId : candidate.id === extra.id);
        return row ? structuredClone(row) : null;
      },
      findMany: async (args: { take?: number; where: { id?: { in: string[] }; AND?: Array<Record<string, unknown>> } }) => {
        if (args.where.id?.in) {
          bump(HYDRATE_KEY);
          const wanted = new Set(args.where.id.in);
          return rows.filter((row) => wanted.has(row.id)).map((row) => structuredClone(row));
        }
        const extra = args.where.AND![1]!;
        if ("novelId" in extra) {
          bump("article.findMany[hreflang siblings]");
          return rows.filter((row) => row.novelId === extra.novelId).map((row) => structuredClone(row));
        }
        bump(args.take === RELATED_NOVELS_POOL_SIZE ? POOL_KEY : "article.findMany[其它]");
        return listedRows(extra.locale as string).slice(0, args.take).map((row) => structuredClone(row));
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
        return tagIds.has(where.slug)
          ? { id: tagIds.get(where.slug)!, slug: where.slug, status: "active", sortOrder: sortOrderOf(where.slug, categories),
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
    $queryRaw: async (query: SqlLike) => {
      const values = query.values ?? [];
      switch (classifyPublicListQuery(query)) {
        case "matrix": {
          bump(MATRIX_KEY);
          const locales = new Set(localesIn(values));
          const tally = new Map<string, number>();
          for (const row of rows) {
            if (!row.listed || !locales.has(row.locale)) continue;
            for (const slug of memberSlugs(row)) tally.set(`${row.locale}|${slug}`, (tally.get(`${row.locale}|${slug}`) ?? 0) + 1);
          }
          return [...tally].map(([key, n]) => {
            const [locale, slug] = key.split("|") as [string, string];
            return { locale, canonical_tag_id: tagIds.get(slug)!, slug, n };
          });
        }
        case "totals": {
          bump(TOTALS_KEY);
          const locales = new Set(localesIn(values));
          const tally = new Map<string, number>();
          for (const row of rows) if (row.listed && locales.has(row.locale)) tally.set(row.locale, (tally.get(row.locale) ?? 0) + 1);
          return [...tally].map(([locale, n]) => ({ locale, n }));
        }
        case "page-ids":
        case "page-count": {
          const kind = classifyPublicListQuery(query);
          bump(kind === "page-ids" ? PAGE_IDS_KEY : PAGE_COUNT_KEY);
          const locale = localesIn(values)[0]!;
          const tagId = values.find((value): value is string => typeof value === "string" && slugOfTagId.has(value));
          const slug = tagId ? slugOfTagId.get(tagId) : undefined;
          const matching = listedRows(locale).filter((row) => !slug || memberSlugs(row).includes(slug));
          if (kind === "page-count") return [{ total: matching.length }];
          const numbers = values.filter((value): value is number => typeof value === "number");
          const [limit, offset] = numbers.slice(-2) as [number, number];
          return matching.slice(offset, offset + limit).map((row) => ({ id: row.id }));
        }
        case "taxonomy": {
          bump(TAXONOMY_KEY);
          const wanted = new Set(values.flat(Infinity) as unknown[]);
          const locale = localesIn(values)[0] ?? "en";
          return rows
            .filter((row) => wanted.has(row.novelId))
            .flatMap((row) => memberSlugs(row).sort(byRank).map((slug) => ({ novel_id: row.novelId, ...tagRow(slug, locale) })));
        }
        case "category-names": {
          bump(CATEGORY_NAMES_KEY);
          const wanted = new Set(values.flat(Infinity) as unknown[]);
          const locale = localesIn(values)[0] ?? "en";
          return [...wanted].filter((id): id is string => typeof id === "string" && slugOfTagId.has(id))
            .map((id) => tagRow(slugOfTagId.get(id)!, locale));
        }
        default:
          bump("$queryRaw[其它]");
          return [];
      }
    },
  };
  return { db: db as unknown as PrismaClient, counts };
}

export type FakeDb = ReturnType<typeof makeFakeDb>;
