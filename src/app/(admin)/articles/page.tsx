import { findCapabilityState } from "@/features/admin-ui/capability-view";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";
import type { ErrorEnvelope } from "@/contracts";
import { listArticles, type ArticleListItem } from "@/server/articles";

import { prisma } from "../../api/admin/_lib/deps";
import { AdminShell } from "../_components/admin-shell";
import { capabilityViews, sessionView } from "../_lib/page-guard";
import { ContentCapabilityDenied, ContentErrorPanel } from "../novels/_components/content-states";
import { ContentPagination } from "../novels/_components/content-pagination";
import { requireContentPage } from "../novels/_lib/content-page-guard";
import { ArticleFilters, type ArticleFilterValues } from "./_components/article-filters";
import { ArticleList } from "./_components/article-list";
import { articleQueryErrorEnvelope } from "./_lib/query-errors";

export const dynamic = "force-dynamic";

type SearchParams = {
  page?: string;
  locale?: string;
  status?: string;
  novelId?: string;
  templateId?: string;
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

  const filterValues: ArticleFilterValues = {
    locale: params.locale,
    status: params.status,
    novelId: params.novelId,
    templateId: params.templateId,
  };

  return (
    <AdminShell
      session={sessionView(context)}
      title="文章管理"
      description={granted ? `共 ${total} 篇；编辑文章正文与 SEO 元数据，或在 50 条/25 秒预算内批量再生成。` : "编辑文章正文与 SEO 元数据，或在 50 条/25 秒预算内批量再生成。"}
    >
      {granted ? (
        <div className="space-y-4">
          <ArticleFilters values={filterValues} />
          {listError ? (
            <ContentErrorPanel message={errorEnvelopeCopy(listError)} />
          ) : (
            <>
              <ArticleList canWrite={canWrite} rows={rows} />
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
