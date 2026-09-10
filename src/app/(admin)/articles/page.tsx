import Link from "next/link";

import { findCapabilityState } from "@/features/admin-ui/capability-view";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";
import { AdminTimeZoneNote } from "@/features/admin-ui/time-zone-note";
import type { ErrorEnvelope } from "@/contracts";
import { isArticleBlogEnabled, isArticleNovelRebindEnabled } from "@/lib/flags";
import { listArticles, listDistinctArticleLocales, type ArticleListItem } from "@/server/articles";
import { listActiveArticleTemplateOptionsForLocales } from "@/server/article-templates";
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
  /** C-25: `Article.seoVisibility` exact-match filter. */
  seoVisibility?: string;
  /** C-26: `Article.articleType` exact-match filter. */
  articleType?: string;
  /** C-26: `Article.contentMode` exact-match filter. */
  contentMode?: string;
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
  // C-30B (施工工单_C30_换小说_移植CPS换租客_2026-09-08.md §4B.4): "在 /articles
  // 列表页抬头加入口按钮，仅在总闸开启且具备 content:batch-rebind 时渲染".
  const canBatchRebind =
    isArticleNovelRebindEnabled(process.env) && findCapabilityState(capabilityViews(context), "content:batch-rebind") === "granted";
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
        seoVisibility: params.seoVisibility || undefined,
        articleType: params.articleType || undefined,
        contentMode: params.contentMode || undefined,
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
  /**
   * L10N P5 (矩阵 #13): was a single hardcoded
   * `listActiveArticleTemplateOptions(prisma, "en")` call — the "模板"
   * filter dropdown only ever offered `en` templates regardless of which
   * locale(s) the listed articles actually have. This is a list-level
   * filter (not a single article's own picker — there is no per-article
   * template dropdown on this page, see `../catalog-sync/page.tsx`'s and
   * `create-content-dialog.tsx`'s comments for that one), so "该文章
   * locale" here means: every locale any row on the CURRENT view could
   * need. When the operator has already narrowed the list to one locale
   * via the `locale` filter (`params.locale`), that is the only locale
   * relevant — narrow the query to it so `ru`'s template options don't
   * clutter an `en`-only view. Unfiltered, fall back to every distinct
   * locale actually present among articles (`locales`, already fetched
   * above), same single-round-trip shape
   * `listActiveArticleTemplateOptionsForLocales` gives `../catalog-sync/
   * page.tsx` (P2 复核 C5-a).
   */
  const templateLocales = params.locale ? [params.locale] : locales;
  const templateOptions = granted && templateLocales.length > 0
    ? await listActiveArticleTemplateOptionsForLocales(prisma, templateLocales)
    : [];
  const categoryOptions = granted ? await listArticleCategoryOptions() : [];
  const novelTitle = granted ? await resolveNovelBannerTitle(params.novelId) : null;

  const filterValues: ArticleFilterValues = {
    search: params.search,
    locale: params.locale,
    status: params.status,
    novelId: params.novelId,
    templateId: params.templateId,
    canonicalTagId: params.canonicalTagId,
    seoVisibility: params.seoVisibility,
    articleType: params.articleType,
    contentMode: params.contentMode,
  };

  return (
    <AdminShell
      session={sessionView(context)}
      title="文章管理"
      // C-22 (`分析_文章管理Parity缺口_2026-09-08.md` §六, item #1, PORT):
      // CPS's exact header wording (`cps-admin-v851-admin-host`'s
      // `src/app/(admin)/articles/page.tsx:62-66`) is "管理所有生成的文章，共
      // N 篇" — nothing else. The "50 条/25 秒预算" note that used to be
      // appended here now lives next to the "批量再生成" button it actually
      // describes (`./_components/article-list.tsx`), not in the header.
      description={granted ? `管理所有生成的文章，共 ${total} 篇` : undefined}
      actions={
        <div className="flex gap-2">
          {/*
            C-28 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md`
            §三/C-28): "新建博客" — CPS wording/position ADAPTed
            (`cps-admin-v851-admin-host`'s
            `src/app/(admin)/articles/page.tsx`: first button in this same
            actions row, emerald fill, → `/articles/new-blog`). Gated by
            `FEATURE_ARTICLE_BLOG` at the render level (not just the
            `/articles/new-blog` page's own 404 kill switch) — "关闭时抬头
            按钮不渲染" is this flag's own registered behavior
            (`docs/governance/feature-flag-registry.md`), so a disabled
            capability leaves no dangling link to a page that would 404.
          */}
          {isArticleBlogEnabled(process.env) && (
            <Link
              href="/articles/new-blog"
              data-testid="articles-new-blog-entry"
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
            >
              新建博客
            </Link>
          )}
          {/*
            C-22 (item #3/#4, ADAPT): CPS's header carries "生成文章"/"批量
            生成" entry buttons that open a drama+template picker on this same
            page. cps-novel has no such picker here — a text-strong-bound
            Article is created by "从渠道来源条目建书目并顺带建落地页", whose
            only entry point is `/catalog-sync` (`../catalog-sync/page.tsx`).
            Both buttons point at that one route (there is no distinct
            single-vs-batch sub-route to split them across — batch creation
            is a dialog on the same page, see that page's own `_components/
            batch-create-content-dialog.tsx`), matching the doc's "均指向目录
            同步" instruction literally rather than inventing a query-param
            mode this page does not read.
          */}
          <Link
            href="/catalog-sync"
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            新建文章
          </Link>
          <Link
            href="/catalog-sync"
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            批量新建
          </Link>
          {/*
            C-30B (施工工单_C30_换小说_移植CPS换租客_2026-09-08.md §4B.4):
            "在 /articles 列表页抬头加入口按钮，仅在总闸开启且具备
            content:batch-rebind 时渲染" — same render-level double-gate
            (flag + capability) shape as the "新建博客" button above.
          */}
          {canBatchRebind && (
            <Link
              href="/articles/batch-novel-rebind"
              data-testid="articles-batch-novel-rebind-entry"
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
            >
              批量换小说
            </Link>
          )}
        </div>
      }
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
