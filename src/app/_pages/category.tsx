import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { JsonLd } from "@/app/_components/json-ld";
import { prisma } from "@/app/_lib/public-deps";
import { loadActiveLocales, loadCategoryPage, loadChrome } from "@/app/_lib/public-load";
import { toNextMetadata } from "@/app/_lib/seo-metadata";
import { CollectionScreen } from "@/features/public-ui/collection/CollectionScreen";
import { Pagination } from "@/features/public-ui/collection/Pagination";
import { SITE_LOCALES, type SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";
import { pageSuffixFor } from "@/lib/seo/page-suffix";
import { generateSeoMeta } from "@/lib/seo/seo-meta-generator";
import { localePrefix } from "@/lib/slug/article-path";
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
    loadCategoryPage(locale, slug, page),
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
  // 2026-10-08 运营反馈（Owner 确认范围含 H1/标题/分享标题/面包屑）：分类名后面带上 "Novels"
  // （各语种按自己的词序，见 `collection.categoryHeading`）。传给模板的 `name` 因此是
  // 标题形式；模板里 title/og/twitter/CollectionPage name/面包屑第 2 项/分享图 alt 都用它。
  const heading = t("collection.categoryHeading", { name });
  return generateSeoMeta({
    entity: "category",
    locale,
    pageNumber: loaded.category.page,
    data: {
      name: heading,
      slug: loaded.category.category.slug,
      description: loaded.category.category.description,
      // TKD 对齐 CPS（Owner 2026-09-30，照 CPS 分类页）：标题 = 分类名（现为标题形式，含
      // Novels）+ 第 2 页起的本地化翻页后缀；描述 = 分类描述 || 固定的本地化兜底句。品牌后缀
      // 由根布局模板加。
      // 兜底句仍用**纯分类名**算：句子本身已经带 novels，用标题形式会变成
      // "Discover Female Audience Novels novels…"。
      descriptionFallback: t("meta.categoryDescriptionFallback", { name }),
      pageSuffix: pageSuffixFor(loaded.category.page, t),
      siteName: loaded.settings.siteName,
      defaultOgImage: loaded.settings.defaultOgImage.trim() || null,
      // 站点默认图缺失时的兜底；分开传，模板才能判断最终分享图是默认图还是书封（B-37）。
      fallbackCoverUrl: loaded.category.novels[0]?.coverUrl ?? null,
      hreflangLocales,
    },
  });
}

/**
 * 2026-09-30：hreflang 只列这个分类**确实有公开内容**（页面返回 200）的语种，
 * 不再对 15 个已登记语种盲枚举——海阅的空分类是 404，盲枚举会把 404 地址当作
 * "其它语言版本"。当前语种恒在（自引用）；其它语种从动态层活跃语种里，用每语种每分类本数矩阵
 * （B-38：一次读取，不再逐语种查库；最多晚 60 秒）确认。只有 `generateMetadata` 需要它（`alternates`
 * 只出现在元数据里），页面本体不重复这份开销。
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
  // PN-08（2026-10-07）：第 2 页起模板不输出任何跨语种 hreflang（`alternates.languages`
  // 为 `{}`，见 `seo-templates/category.ts`），所以第 2 页起不查"该分类在其它语种是否有内容"。
  // 第 1 页照常判定（读矩阵），hreflang 输出不变。
  const hreflangLocales =
    loaded.category.page >= 2 ? [locale] : await hreflangLocalesFor(locale, loaded);
  return toNextMetadata(seoFor(locale, loaded, hreflangLocales));
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
  // H1 与 `<title>`/面包屑同一个标题形式（运营 2026-10-08）；浏览页的 `CollectionScreen`
  // 用法不受影响（它仍用 `collection.categoryTitle`）。
  const heading = t("collection.categoryHeading", { name: loaded.category.category.name });
  return <>
    {seo.other ? <JsonLd json={seo.other["application/ld+json"]} /> : null}
    <CollectionScreen
      locale={locale}
      chrome={loaded.chrome}
      title={heading}
      description={loaded.category.category.description ?? undefined}
      novels={loaded.category.novels}
      // 标题下的作品数 = 这个分类分页能翻到的总本数（与分页、站点地图、404 判定同一份列表，
      // 见 `CollectionScreen` 文件头注释），不是当前页本数。
      totalCount={loaded.category.totalCount}
      emptyMessage={t("collection.categoryEmpty")}
      // PN-06：分页条进作品网格之后、页脚之前（原先写在整个页面壳之外，DOM 里落在页脚后面）。
      pagination={
        <Pagination
          locale={locale}
          currentPage={loaded.category.page}
          totalPages={loaded.category.totalPages}
          basePath={`${localePrefix(locale)}/category/${loaded.category.category.slug}`}
        />
      }
    />
  </>;
}
