import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { JsonLd } from "@/app/_components/json-ld";
import { prisma } from "@/app/_lib/public-deps";
import { loadActiveLocales, loadChrome } from "@/app/_lib/public-load";
import { toNextMetadata } from "@/app/_lib/seo-metadata";
import { CollectionScreen } from "@/features/public-ui/collection/CollectionScreen";
import { Pagination } from "@/features/public-ui/collection/Pagination";
import { SITE_LOCALES, type SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";
import { pageSuffixFor } from "@/lib/seo/page-suffix";
import { generateSeoMeta } from "@/lib/seo/seo-meta-generator";
import { localePrefix } from "@/lib/slug/article-path";
import { getPublicCategoryPage } from "@/lib/site/category-queries";
import { listCategoryPublicLocales } from "@/lib/site/category-locales";

/**
 * Category page shared body (WO-1 §6.1): extracted verbatim out of
 * `src/app/category/[slug]/page.tsx`, `PUBLIC_SITE_LOCALE` swapped for the
 * `locale` parameter. Two literal substitutions land here per WO-1 §6.4
 * (byte-identical English output): the bare `"Not found"` becomes
 * `t("meta.notFound")`, and `"No published novels in this category."`
 * becomes `t("collection.categoryEmpty")` (a new key — deliberately NOT
 * reusing `collection.genreEmpty`, a different existing sentence, see that
 * key's comment in `en.ts`). No other line's semantics changed.
 */

export type CategoryRouteParams = { slug: string };
export type CategorySearchParams = { page?: string | string[] };

function pageNumber(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === "") return 1;
  return /^[1-9]\d*$/.test(raw) ? Number(raw) : null;
}

async function load(locale: SiteLocale, slug: string, rawPage: string | string[] | undefined) {
  const page = pageNumber(rawPage);
  if (!page) return null;
  const activeLocales = await loadActiveLocales();
  const [category, chrome] = await Promise.all([
    getPublicCategoryPage(prisma, locale, slug, page),
    loadChrome(locale, undefined, undefined, activeLocales),
  ]);
  return category ? { category, activeLocales, ...chrome } : null;
}

function seoFor(
  locale: SiteLocale,
  loaded: NonNullable<Awaited<ReturnType<typeof load>>>,
  hreflangLocales: readonly SiteLocale[],
) {
  const t = getPublicT(locale);
  const name = loaded.category.category.name;
  return generateSeoMeta({
    entity: "category",
    locale,
    pageNumber: loaded.category.page,
    data: {
      name,
      slug: loaded.category.category.slug,
      description: loaded.category.category.description,
      // TKD 对齐 CPS（Owner 2026-09-30，照 CPS 分类页）：标题 = 分类名 + 第 2 页起的本地化
      // 翻页后缀；描述 = 分类描述 || 固定的本地化兜底句。品牌后缀由根布局模板加。
      descriptionFallback: t("meta.categoryDescriptionFallback", { name }),
      pageSuffix: pageSuffixFor(loaded.category.page, t),
      siteName: loaded.settings.siteName,
      defaultOgImage: loaded.settings.defaultOgImage || loaded.category.novels[0]?.coverUrl,
      hreflangLocales,
    },
  });
}

/**
 * 2026-09-30：hreflang 只列这个分类**确实有公开内容**（页面返回 200）的语种，
 * 不再对 15 个已登记语种盲枚举——海阅的空分类是 404，盲枚举会把 404 地址当作
 * "其它语言版本"。当前语种恒在（自引用）；其它语种从动态层活跃语种里逐个用
 * 页面自己的查询确认。只有 `generateMetadata` 需要它（`alternates` 只出现在
 * 元数据里），页面本体不重复这份开销。
 */
async function hreflangLocalesFor(
  locale: SiteLocale,
  loaded: NonNullable<Awaited<ReturnType<typeof load>>>,
): Promise<SiteLocale[]> {
  const others = await listCategoryPublicLocales(
    prisma,
    loaded.category.category.slug,
    loaded.activeLocales.filter((candidate) => candidate !== locale),
  );
  return SITE_LOCALES.filter((candidate) => candidate === locale || others.includes(candidate));
}

export async function buildCategoryMetadata(
  locale: SiteLocale,
  params: Promise<CategoryRouteParams>,
  searchParams: Promise<CategorySearchParams>,
): Promise<Metadata> {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const loaded = await load(locale, slug, query.page);
  if (!loaded) {
    return { title: getPublicT(locale)("meta.notFound"), robots: { index: false, follow: false } };
  }
  return toNextMetadata(seoFor(locale, loaded, await hreflangLocalesFor(locale, loaded)));
}

export async function CategoryBody({
  locale,
  params,
  searchParams,
}: {
  locale: SiteLocale;
  params: Promise<CategoryRouteParams>;
  searchParams: Promise<CategorySearchParams>;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const loaded = await load(locale, slug, query.page);
  if (!loaded) notFound();
  const t = getPublicT(locale);
  // 页面本体只读 `seo.other`（JSON-LD），不读 `alternates`——hreflang 只在
  // `generateMetadata` 里算，这里传自引用即可，不重复查其它语种。
  const seo = seoFor(locale, loaded, [locale]);
  return <>
    {seo.other ? <JsonLd json={seo.other["application/ld+json"]} /> : null}
    <CollectionScreen
      locale={locale}
      chrome={loaded.chrome}
      title={loaded.category.category.name}
      description={loaded.category.category.description ?? undefined}
      novels={loaded.category.novels}
      emptyMessage={t("collection.categoryEmpty")}
    />
    <Pagination
      locale={locale}
      currentPage={loaded.category.page}
      totalPages={loaded.category.totalPages}
      basePath={`${localePrefix(locale)}/category/${loaded.category.category.slug}`}
    />
  </>;
}
