import type {
  ChapterNovelRef,
  ChapterView,
  NovelCardView,
  NovelDetailView,
  PreviewChapterRef,
} from "@/features/public-ui/types";
import { isPublicRedirectCodeFormatValid } from "@/lib/redirect";
import { buildArticlePath } from "@/lib/slug/article-path";
import { buildChapterPath } from "@/lib/seo/chapter-path";

import { asSiteLocale, localeBadge } from "./locale-label";
import { splitChapterParagraphs } from "./paragraphs";

export type PublicNovelRecord = {
  id: string;
  businessId: string;
  title: string;
  description: string;
  coverUrl: string | null;
  locale: string;
  totalChapterCount: number;
};

export type PublicArticleRecord = {
  id: string;
  title: string;
  slug: string;
  locale: string;
  publicPageShortId: string;
  publishedAt: Date | null;
  summary?: string | null;
  novel: PublicNovelRecord;
};

/**
 * `promoLink` 的最小只读投影，只携带正式阅读 CTA 需要的公开跳转码。
 *
 * 🔴 只用于 detail / chapter：`PublicArticleRecord`（卡片与两者共用的基础形状）
 * 刻意不携带这个字段——`tests/backend/public/mappers.test.ts:41` 断言卡片 JSON
 * 不含 `webUrl|upstreamCode|author|readOnUpstreamHref`，这是防泄漏边界。
 */
export type PublicArticlePromoLink = { publicRedirectCode: string } | null;

/**
 * detail / chapter 专用输入形状：在基础字段之上多带一个 `promoLink`。
 *
 * 字段本身可选——`queries.ts` 的生产路径永远显式赋值（`{ publicRedirectCode }`
 * 或 `null`），可选只是为了不强迫每一处手写调用方（包括测试里手搭的最小夹具）
 * 都要多填一个字段；`buildReadOnUpstreamHref` 对「整个字段缺失」与「字段是
 * `null`」一视同仁，都按「码缺失」处理，返回 `undefined`。
 */
export type PublicArticleDetailRecord = PublicArticleRecord & {
  promoLink?: PublicArticlePromoLink;
  body?: string;
  seoMetadata?: unknown;
};

function seoText(value: unknown, key: "metaTitle" | "metaDescription"): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim() ? field.trim() : undefined;
}

export type PreviewChapterRecord = {
  canonicalChapterNumber: number;
  title: string | null;
};

export type ChapterRecord = PreviewChapterRecord & {
  body: string;
};

/**
 * 由公开跳转码构造 `/go/{code}` 路径。
 *
 * 🔴 这是**构造**，与 `src/lib/seo/template/render.ts` 里那条同名形态的正则
 * （`PUBLIC_REDIRECT_PATH`）职责相反——那里只做**校验**（引擎不拼 URL），这里
 * 才是 P1 共享契约里点名、但从未落地实现的 `buildGoPath`（`docs/p1/
 * P1_SHARED_CONTRACTS.md` §3：Owner = Claude）。全项目唯一的构造点，
 * 详情页与章节页共用。
 *
 * 格式守卫复用 `src/lib/redirect`（Codex 独占的唯一码生成真源）导出的
 * `isPublicRedirectCodeFormatValid`，不在这里重新定义字符集正则——那条正则
 * 的字母表随生成算法变化，重复一份就是第二处要跟着改的地方。
 *
 * 码缺失或格式非法时返回 `undefined`，调用方（`toNovelDetailView` /
 * `toChapterView`）把它原样交给视图模型的可选字段，UI 侧走既有的「不渲染」
 * 空态——不在这里假造占位链接。
 */
function buildReadOnUpstreamHref(
  promoLink: PublicArticlePromoLink | undefined,
): string | undefined {
  const code = promoLink?.publicRedirectCode;
  if (!code || !isPublicRedirectCodeFormatValid(code)) return undefined;
  return `/go/${code}`;
}

export function toNovelCardView(article: PublicArticleRecord): NovelCardView | null {
  const locale = asSiteLocale(article.locale);
  if (!locale) return null;

  return {
    id: article.novel.businessId,
    title: article.title,
    coverUrl: article.novel.coverUrl ?? undefined,
    tags: [],
    locale: localeBadge(locale),
    href: buildArticlePath({
      locale,
      slug: article.slug,
      shortId: article.publicPageShortId,
    }),
    summary: article.summary?.trim() || undefined,
  };
}

export function toPreviewChapterRefs(
  article: PublicArticleRecord,
  chapters: readonly PreviewChapterRecord[],
): PreviewChapterRef[] {
  const locale = asSiteLocale(article.locale);
  if (!locale) return [];

  return chapters.map((chapter) => ({
    number: chapter.canonicalChapterNumber,
    title: chapter.title?.trim() || `Chapter ${chapter.canonicalChapterNumber}`,
    href: buildChapterPath({
      locale,
      slug: article.slug,
      shortId: article.publicPageShortId,
      chapterNumber: chapter.canonicalChapterNumber,
    }),
  }));
}

export function toNovelDetailView(
  article: PublicArticleDetailRecord,
  previewChapters: readonly PreviewChapterRecord[],
): NovelDetailView | null {
  const locale = asSiteLocale(article.locale);
  if (!locale) return null;

  return {
    id: article.novel.businessId,
    title: article.title,
    coverUrl: article.novel.coverUrl ?? undefined,
    description: article.summary?.trim() || article.novel.description,
    contentBody: article.body?.trim() || undefined,
    seoTitle: seoText(article.seoMetadata, "metaTitle"),
    seoDescription: seoText(article.seoMetadata, "metaDescription"),
    locale: localeBadge(locale),
    totalChapterCount: article.novel.totalChapterCount,
    tags: [],
    previewChapters: toPreviewChapterRefs(article, previewChapters),
    readOnUpstreamHref: buildReadOnUpstreamHref(article.promoLink),
  };
}

export function toChapterView(
  article: PublicArticleDetailRecord,
  chapter: ChapterRecord,
  previewChapters: readonly PreviewChapterRecord[],
): ChapterView | null {
  const locale = asSiteLocale(article.locale);
  if (!locale) return null;

  const paragraphs = splitChapterParagraphs(chapter.body);
  if (paragraphs.length === 0) return null;

  const index = previewChapters.findIndex(
    (entry) => entry.canonicalChapterNumber === chapter.canonicalChapterNumber,
  );
  if (index < 0) return null;

  const previous = previewChapters[index - 1];
  const next = previewChapters[index + 1];
  const novelHref = buildArticlePath({
    locale,
    slug: article.slug,
    shortId: article.publicPageShortId,
  });
  const novel: ChapterNovelRef = {
    id: article.novel.businessId,
    title: article.title,
    href: novelHref,
    coverUrl: article.novel.coverUrl ?? undefined,
  };

  return {
    number: chapter.canonicalChapterNumber,
    title: chapter.title?.trim() || `Chapter ${chapter.canonicalChapterNumber}`,
    paragraphs,
    novel,
    previewPosition: { index: index + 1, total: previewChapters.length },
    previousHref: previous
      ? buildChapterPath({
          locale,
          slug: article.slug,
          shortId: article.publicPageShortId,
          chapterNumber: previous.canonicalChapterNumber,
        })
      : undefined,
    nextHref: next
      ? buildChapterPath({
          locale,
          slug: article.slug,
          shortId: article.publicPageShortId,
          chapterNumber: next.canonicalChapterNumber,
        })
      : undefined,
    readOnUpstreamHref: buildReadOnUpstreamHref(article.promoLink),
  };
}
