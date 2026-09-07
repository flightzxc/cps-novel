import { findCapabilityState } from "@/features/admin-ui/capability-view";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";
import { AdminTimeZoneNote } from "@/features/admin-ui/time-zone-note";
import type { ErrorEnvelope } from "@/contracts";
import { listArticles, listDistinctArticleLocales, type ArticleListItem } from "@/server/articles";
import { listActiveArticleTemplateOptions } from "@/server/article-templates";
import { getSiteUrl } from "@/lib/seo/site-url";

import { prisma } from "../../api/admin/_lib/deps";
import { AdminShell } from "../_components/admin-shell";
import { capabilityViews, sessionView } from "../_lib/page-guard";
import { ContentCapabilityDenied, ContentErrorPanel } from "../novels/_components/content-states";
import { ContentPagination } from "../novels/_components/content-pagination";
import { requireContentPage } from "../novels/_lib/content-page-guard";
import { ArticleFilters, type ArticleFilterValues } from "./_components/article-filters";
import { ArticleList } from "./_components/article-list";
import { listArticleCategoryOptions } from "./_lib/category-options";
import { articleQueryErrorEnvelope } from "./_lib/query-errors";

export const dynamic = "force-dynamic";

/**
 * Public origin for this page's "公开页" links. Under RC-9 admin-host
 * isolation the console runs on `ADMIN_CANONICAL_ORIGIN`, which 404s every
 * public content path, so the link has to be absolute against `SITE_URL`
 * (see `./_components/article-list.tsx`'s `publicPageHref`). Resolved here
 * because `SITE_URL` is a server-only env var.
 *
 * Degrades to `null` instead of throwing when `SITE_URL` is unset/malformed —
 * same rationale as `../settings/page.tsx`'s `resolveIndexNowGuidance`: a
 * local/dev environment without `SITE_URL` is not this page's failure and must
 * not take the whole article list down.
 */
function resolvePublicOrigin(): string | null {
  try {
    return getSiteUrl();
  } catch {
    return null;
  }
}

/**
 * C-19 book-title banner (analysis doc §三 "书目筛选"): resolves the book
 * title for the "已按书目筛选：《书名》· 清除" banner, never a raw UUID —
 * unlike the novel list's `labelId` banner precedent
 * (`../novels/_components/novel-filters.tsx`), which never embeds the
 * label's own name at all, this filter's whole point is "which book", so the
 * banner needs the title.
 *
 * Deliberately independent of `listArticles`'s own `novelId` validation: a
 * malformed `novelId` still surfaces through the list's `invalid_identifier`
 * error panel exactly as before; this lookup only degrades the *banner text*
 * (falls back to the raw id) so a bad or since-deleted novelId cannot itself
 * crash the page.
 */
async function resolveNovelBannerTitle(novelId: string | undefined): Promise<string | null> {
  if (!novelId) return null;
  try {
    const novel = await prisma.novel.findFirst({ where: { id: novelId, deletedAt: null }, select: { title: true } });
    return novel?.title ?? null;
  } catch {
    return null;
  }
}

type SearchParams = {
  page?: string;
  locale?: string;
  status?: string;
  novelId?: string;
  templateId?: string;
  search?: string;
  canonicalTagId?: string;
};

/**
 * M7 ①: `locale`/`status`/`novelId`/`templateId` filters plus real pagination
 * (`listArticles`, `@/server/articles`), replacing the previous unfiltered
 * `take: 200` snapshot with no page count. Same query-string-driven,
 * inline-panel-on-bad-filter shape as `../novels/page.tsx` — see
 * `./_lib/query-errors.ts` for why this page's `AdminContentQueryError`
 * handling does not reuse `../novels/_lib/content-errors.ts`'s
 * `queryErrorEnvelope` unchanged.
 */
export default async function ArticlesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const { context, granted } = await requireContentPage("/articles", "content:view");
  const canWrite = findCapabilityState(capabilityViews(context), "content:publish") === "granted";
  const publicOrigin = resolvePublicOrigin();

  let rows: readonly ArticleListItem[] = [];
  let page = 1;
  let totalPages = 0;
  let total = 0;
  let listError: ErrorEnvelope | null = null;
  if (granted) {
    try {
      const result = await listArticles(prisma, {
        page: params.page ? Number(params.page) : undefined,
        locale: params.locale || undefined,
        status: params.status || undefined,
        novelId: params.novelId || undefined,
        templateId: params.templateId || undefined,
        search: params.search || undefined,
        canonicalTagId: params.canonicalTagId || undefined,
      });
      rows = result.items;
      page = result.page;
      totalPages = result.totalPages;
      total = result.total;
    } catch (error) {
      listError = articleQueryErrorEnvelope(error);
      if (!listError) throw error;
    }
  }

  // C-19: filter-bar option sources. Every read here is independent of the
  // list query above — a broken category taxonomy or a locale-distinct
  // query error must not blank the list itself, so none of these
  // participate in `listError`. Same "one `granted ? await … : []` per
  // source" shape as `../catalog-sync/page.tsx`'s `channels`/
  // `claimChannelApps`/`templateOptions`, not a `Promise.all` — a plain
  // array-literal fallback loses each promise's distinct element type once
  // it sits in the same conditional expression as `Promise.all(...)`.
  const locales = granted ? await listDistinctArticleLocales(prisma) : [];
  // Hardcoded "en", same as `../catalog-sync/page.tsx`'s own call to this
  // function — the site has effectively one populated locale today (see
  // `listDistinctArticleLocales`'s own header).
  const templateOptions = granted ? await listActiveArticleTemplateOptions(prisma, "en") : [];
  const categoryOptions = granted ? await listArticleCategoryOptions() : [];
  const novelTitle = granted ? await resolveNovelBannerTitle(params.novelId) : null;

  const filterValues: ArticleFilterValues = {
    search: params.search,
    locale: params.locale,
    status: params.status,
    novelId: params.novelId,
    templateId: params.templateId,
    canonicalTagId: params.canonicalTagId,
  };

  return (
    <AdminShell
      session={sessionView(context)}
      title="文章管理"
      description={granted ? `共 ${total} 篇；编辑文章正文与 SEO 元数据，或在 50 条/25 秒预算内批量再生成。` : "编辑文章正文与 SEO 元数据，或在 50 条/25 秒预算内批量再生成。"}
    >
      {granted ? (
        <div className="space-y-4">
          <ArticleFilters
            values={filterValues}
            novelTitle={novelTitle}
            locales={locales}
            categoryOptions={categoryOptions}
            templateOptions={templateOptions}
          />
          {listError ? (
            <ContentErrorPanel message={errorEnvelopeCopy(listError)} />
          ) : (
            <>
              {/* C-20: 创建时间 column needs one page-level UTC+8 declaration, same placement as `../novels/page.tsx`'s own `AdminTimeZoneNote`. */}
              <AdminTimeZoneNote />
              <ArticleList canWrite={canWrite} publicOrigin={publicOrigin} rows={rows} />
              <ContentPagination
                basePath="/articles"
                params={params}
                page={page}
                totalPages={totalPages}
                total={total}
              />
            </>
          )}
        </div>
      ) : (
        <ContentCapabilityDenied capability="content:view" />
      )}
    </AdminShell>
  );
}
