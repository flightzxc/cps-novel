/**
 * B-38 第二段真实库用例共用的夹具（不是用例文件，vitest 不会收集它）。
 *
 * 环境、角色、库名守卫全部沿用第一段（`../tagging/effective-tag-fixtures`）：
 *   B38_DATABASE_TEST=1 / B38_OWNER|WEB|WORKER|SCHEDULER|ANALYST_DATABASE_URL，库名必须以 `cps_novel_b38_` 开头。
 * 分类、上游标签、映射、小说与书目 / 标签状态的造法也复用第一段（`seedFoundation` / `seedRandomNovels`）；
 * 这里只补"文章 + 推广链接"那一层——列表等价用例要的各种不可见状态都在这一层。
 */
import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { buildPublicListArticleWhere, buildPublicListBlogArticleWhere } from "@/server/publication/visibility";
import { ARTICLE_CARD_SELECT, filterPromoReady } from "@/lib/site/article-card";

import {
  allNovelIds,
  mulberry32,
  seedRandomNovels,
  type Foundation,
} from "../tagging/effective-tag-fixtures";

export { allNovelIds, mulberry32 };

export const FIXTURE_SITES = ["en", "es", "ko"] as const;

type PromoShape = Readonly<{ status: string; webUrl: string | null; appUrl: string | null }>;

/** 推广链接的各种形状，覆盖 `isPromoReady` 的每个分支（含 JS 的 trim 与 PostgreSQL 默认 btrim 不同的字符）。 */
const PROMO_SHAPES: ReadonlyArray<readonly [weight: number, shape: PromoShape]> = [
  [52, { status: "fetched", webUrl: "https://promo.example/read", appUrl: null }],
  [6, { status: "fetched", webUrl: null, appUrl: "https://app.example/read" }],
  [4, { status: "fetched", webUrl: "", appUrl: "https://app.example/read" }],
  [4, { status: "fetched", webUrl: "  https://padded.example/read \t", appUrl: null }],
  [3, { status: "fetched", webUrl: "᠎", appUrl: null }], // U+180E：JS trim 不当它是空白 → 可用
  [4, { status: "pending", webUrl: null, appUrl: null }],
  [3, { status: "failed", webUrl: "https://promo.example/failed", appUrl: null }],
  [3, { status: "fetched", webUrl: "", appUrl: "" }],
  [3, { status: "fetched", webUrl: null, appUrl: null }],
  [3, { status: "fetched", webUrl: "   ", appUrl: null }],
  [3, { status: "fetched", webUrl: "　 ﻿", appUrl: "\t\n" }], // 全角空格 / 不换行空格 / BOM：JS trim 认，PostgreSQL 默认 btrim 不认
  [2, { status: "fetched", webUrl: " ", appUrl: " " }],
  [2, { status: "registered_disabled", webUrl: "https://promo.example/disabled", appUrl: null }],
];

function weighted<T>(random: () => number, table: ReadonlyArray<readonly [number, T]>): T {
  const total = table.reduce((sum, [weight]) => sum + weight, 0);
  let point = random() * total;
  for (const [weight, value] of table) {
    point -= weight;
    if (point < 0) return value;
  }
  return table[table.length - 1]![1];
}

const ARTICLE_STATUSES: ReadonlyArray<readonly [number, { status: string; deleted: boolean }]> = [
  [78, { status: "published", deleted: false }],
  [7, { status: "draft", deleted: false }],
  [5, { status: "unpublished", deleted: false }],
  [2, { status: "takedown", deleted: false }],
  [8, { status: "published", deleted: true }],
];

const SEO_VISIBILITIES: ReadonlyArray<readonly [number, string]> = [
  [82, "public"],
  [10, "seo_only"],
  [8, "hidden"],
];

const NOVEL_STATUSES: ReadonlyArray<readonly [number, string]> = [
  [86, "published"],
  [5, "unpublished"],
  [4, "draft"],
  [3, "ready"],
  [2, "takedown"],
];

/** 每个语种有文章的概率（en 几乎都有，其余语种的书少一些）。 */
const PRESENCE_BY_SITE: Readonly<Record<string, number>> = { en: 0.95, es: 0.5, ko: 0.3 };

/** 把发布时间落在很少几个整分钟上——制造大量并列，才能验证"同时间按编号升序"。 */
const BASE_TIME = Date.parse("2026-02-01T00:00:00.000Z");

export type ListScenario = Readonly<{
  novelIds: readonly string[];
  /** 每种文章状态 / 可见性 / 推广形状至少出现过的计数，供用例断言夹具不是空壳。 */
  stats: Readonly<Record<string, number>>;
}>;

/**
 * 列表等价用例的夹具：`novels` 本小说（第一段的随机批：书目 / 标签状态 / 映射 / 自动打标的各种交叉）
 * + 每本书在 en / es / ko 里按概率各有一篇文章，文章状态 / 可见性 / 推广链接形状 / 发布时间都是随机组合，
 * 小说本身也有未发布 / 草稿 / 撤回的。全部由 `seed` 决定，失败可复现。
 *
 * 写的是真源表（owner 直接写），所以调用方之后要对账一次归属表（`reconcileAllEffectiveTags`）。
 */
export async function seedListScenario(
  owner: PrismaClient,
  f: Foundation,
  options: { novels: number; seed: number },
): Promise<ListScenario> {
  await seedRandomNovels(owner, f, options.novels, options.seed);
  const novelIds = await allNovelIds(owner);
  const random = mulberry32(options.seed ^ 0x5bd1e995);

  const account = await owner.channelAccount.create({
    data: { channelId: f.channel, businessId: `b38-${randomUUID()}`, accountName: "b38 account", status: "active" },
  });

  const novelStatus = new Map<string, string>();
  const stats: Record<string, number> = {};
  const bump = (key: string) => { stats[key] = (stats[key] ?? 0) + 1; };

  const sourceItems: Array<Record<string, unknown>> = [];
  const promoLinks: Array<Record<string, unknown>> = [];
  const articles: Array<Record<string, unknown>> = [];

  for (const novelId of novelIds) {
    const status = weighted(random, NOVEL_STATUSES);
    novelStatus.set(novelId, status);
    bump(`novel:${status}`);

    for (const locale of FIXTURE_SITES) {
      if (random() >= (PRESENCE_BY_SITE[locale] ?? 0)) continue;
      const shape = weighted(random, PROMO_SHAPES);
      const article = weighted(random, ARTICLE_STATUSES);
      const seoVisibility = weighted(random, SEO_VISIBILITIES);
      const sourceItemId = randomUUID();
      const promoLinkId = randomUUID();
      sourceItems.push({
        id: sourceItemId, channelAppId: f.appActive, novelId, externalBookId: sourceItemId, sourceLocale: locale,
        sourceLanguageCode: `promo-${locale}`, rawLanguageScope: null, title: "b38 promo source", description: "",
        status: "linked", rawPayload: {},
      });
      promoLinks.push({
        id: promoLinkId, novelId, novelSourceItemId: sourceItemId, channelAppId: f.appActive, channelAccountId: account.id,
        offerType: "cps", publicRedirectCode: `r${promoLinkId.replaceAll("-", "").slice(0, 20)}`,
        idempotencyKey: `${promoLinkId.replaceAll("-", "")}${promoLinkId.replaceAll("-", "")}`,
        status: shape.status, webUrl: shape.webUrl, appUrl: shape.appUrl,
      });
      // 发布时间只取 0..29 个整分钟：每个整分钟下会有很多本并列。
      const publishedAt = article.status === "published" ? new Date(BASE_TIME + Math.floor(random() * 30) * 60_000) : null;
      articles.push({
        id: randomUUID(), novelId, promoLinkId, locale, slug: `b38-${locale}-${novelId.slice(0, 8)}`,
        publicPageShortId: randomUUID().replaceAll("-", "").slice(0, 16), title: `B38 article ${locale} ${novelId.slice(0, 8)}`,
        body: "Body", status: article.status, seoVisibility, publishedAt, deletedAt: article.deleted ? new Date() : null,
      });
      bump(`article:${article.status}${article.deleted ? ":deleted" : ""}`);
      bump(`seo:${seoVisibility}`);
      bump(`promo:${shape.status}:${shape.webUrl === null ? "null" : shape.webUrl.trim() === "" ? "blank" : "text"}`);
    }
  }

  const byStatus = new Map<string, string[]>();
  for (const [id, status] of novelStatus) {
    if (status === "published") continue;
    byStatus.set(status, [...(byStatus.get(status) ?? []), id]);
  }
  for (const [status, ids] of byStatus) await owner.novel.updateMany({ where: { id: { in: ids } }, data: { status } });
  await owner.novelSourceItem.createMany({ data: sourceItems as never });
  await owner.promoLink.createMany({ data: promoLinks as never });
  await owner.article.createMany({ data: articles as never });
  return { novelIds, stats };
}

/** 博客家族夹具：无小说、无推广链接；状态 / 可见性 / 类型 / 发布时间（含大量并列）随机组合。 */
export async function seedBlogScenario(
  owner: PrismaClient,
  options: { posts: number; seed: number; locales?: readonly string[] },
): Promise<Readonly<Record<string, number>>> {
  const random = mulberry32(options.seed);
  const locales = options.locales ?? FIXTURE_SITES;
  const types = ["blog_article", "listicle", "guide"] as const;
  const stats: Record<string, number> = {};
  const rows: Array<Record<string, unknown>> = [];
  for (let index = 0; index < options.posts; index += 1) {
    const article = weighted(random, ARTICLE_STATUSES);
    const seoVisibility = weighted(random, SEO_VISIBILITIES);
    const locale = locales[Math.floor(random() * locales.length)]!;
    const id = randomUUID();
    rows.push({
      id, novelId: null, promoLinkId: null, locale, slug: `b38-blog-${index}`, publicPageShortId: id.replaceAll("-", "").slice(0, 16),
      title: `B38 blog ${index}`, body: "Body", status: article.status, articleType: types[Math.floor(random() * types.length)],
      seoVisibility, publishedAt: article.status === "published" ? new Date(BASE_TIME + Math.floor(random() * 6) * 60_000) : null,
      deletedAt: article.deleted ? new Date() : null,
    });
    stats[`blog:${article.status}${article.deleted ? ":deleted" : ""}`] = (stats[`blog:${article.status}${article.deleted ? ":deleted" : ""}`] ?? 0) + 1;
    stats[`blogseo:${seoVisibility}`] = (stats[`blogseo:${seoVisibility}`] ?? 0) + 1;
  }
  await owner.article.createMany({ data: rows as never });
  return stats;
}

// ────────────────────────────────────────────────────────────────────────────
// 参照算法（"改造前逻辑去掉上限"）：Prisma findMany + buildPublicListArticleWhere + filterPromoReady
// ────────────────────────────────────────────────────────────────────────────

export type ReferenceCard = Readonly<{ articleId: string; novelId: string; businessId: string }>;

/** 某语种列表的参照：发布时间降序、编号升序，已去掉推广链接去空白后不可用的行，没有任何上限。 */
export async function referenceList(db: PrismaClient, locale: string, env: NodeJS.ProcessEnv): Promise<ReferenceCard[]> {
  const rows = await db.article.findMany({
    where: buildPublicListArticleWhere({ locale }, env),
    orderBy: [{ publishedAt: "desc" }, { id: "asc" }],
    select: ARTICLE_CARD_SELECT,
  });
  return filterPromoReady(rows).map((row) => ({ articleId: row.id, novelId: row.novel.id, businessId: row.novel.businessId }));
}

/** 博客列表的参照：不设上限的 findMany。返回文章 id 序列。 */
export async function referenceBlogList(db: PrismaClient, locale: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const rows = await db.article.findMany({
    where: buildPublicListBlogArticleWhere({ locale }, env),
    orderBy: [{ publishedAt: "desc" }, { id: "asc" }],
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

export function envFor(options: { autoTags?: boolean; seoVisibility?: boolean }): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    FEATURE_NOVEL_TAG_AUTO: options.autoTags ? "true" : "false",
    FEATURE_ARTICLE_SEO_VISIBILITY: options.seoVisibility ? "true" : "false",
  };
}

export const PAGE_SIZE = 20;

export function expectedTotalPages(total: number): number {
  return total === 0 ? 1 : Math.max(1, Math.ceil(total / PAGE_SIZE));
}
