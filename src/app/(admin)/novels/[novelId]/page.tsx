import Link from "next/link";
import { notFound } from "next/navigation";

import {
  projectAdminChapterListItem,
  projectAdminContentPage,
  projectAdminNovelDetail,
  type AdminChapterListItemView,
  type AdminContentPageView,
  type ErrorEnvelope,
} from "@/contracts";
import { findCapabilityState } from "@/features/admin-ui/capability-view";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";
import { AdminTimeZoneNote } from "@/features/admin-ui/time-zone-note";
import { getAdminNovelDetail, listAdminNovelChapters } from "@/server/admin-content";

import { prisma } from "../../../api/admin/_lib/deps";
import { AdminShell } from "../../_components/admin-shell";
import { capabilityViews, sessionView } from "../../_lib/page-guard";
import { ChaptersTable } from "../_components/chapters-table";
import { ContentPagination } from "../_components/content-pagination";
import { ContentCapabilityDenied, ContentErrorPanel } from "../_components/content-states";
import { notFoundIfMissingIdentifier, queryErrorEnvelope } from "../_lib/content-errors";
import {
  NovelIdentityPanel,
  NovelLabelsPanel,
  NovelPreviewPanel,
  NovelSourcesPanel,
  NovelSyncPanel,
} from "../_components/novel-detail-panels";
import { PublishLifecyclePanel } from "../_components/publish-lifecycle-panel";
import { NovelTagsPanel } from "../_components/novel-tags-panel";
import { requireContentPage } from "../_lib/content-page-guard";
import { readPrimaryArticleForNovel } from "../_lib/read-primary-article";

export const dynamic = "force-dynamic";

/**
 * Novel detail plus its chapter list.
 *
 * Both live on one screen because they answer one question — "is this book
 * complete and are its previews right?" — and splitting them would make an
 * operator navigate to compare the policy count against the chapters that
 * actually landed.
 *
 * A malformed id makes the kernel throw `invalid_identifier`; an id that matches
 * no live row returns null. Both end at `notFound()`: the distinction matters in
 * an API envelope, but on a page the operator has one thing to do either way.
 */
export default async function NovelDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ novelId: string }>;
  searchParams: Promise<{ page?: string; status?: string }>;
}) {
  const { novelId } = await params;
  const query = await searchParams;
  const { context, granted } = await requireContentPage("/novels/[novelId]", "content:view");

  if (!granted) {
    return (
      <AdminShell session={sessionView(context)} title="书目详情">
        <ContentCapabilityDenied capability="content:view" />
      </AdminShell>
    );
  }

  const detail = await getAdminNovelDetail(prisma, novelId).catch(notFoundIfMissingIdentifier);
  if (!detail) notFound();

  // Article lookup for the publish/rights-transition controls below — see
  // `../_lib/read-primary-article.ts`'s header for why this is a page-local
  // read rather than a `src/server/admin-content` addition.
  const primaryArticle = await readPrimaryArticleForNovel(novelId);
  const capabilities = capabilityViews(context);

  // Chapter paging is driven by the query string, so its failures split two
  // ways: a bad `?page=` is the operator's typo and stays inline, anything else
  // is a real fault and goes to the error boundary.
  let chapters: AdminContentPageView<AdminChapterListItemView> | null = null;
  let chapterError: ErrorEnvelope | null = null;
  try {
    chapters = projectAdminContentPage(
      await listAdminNovelChapters(prisma, {
        novelId,
        page: query.page ? Number(query.page) : undefined,
        status: query.status as never,
      }),
      projectAdminChapterListItem,
    );
  } catch (error) {
    chapterError = queryErrorEnvelope(error);
    if (!chapterError) throw error;
  }
  const novel = projectAdminNovelDetail(detail);
  const tagManageCapability = findCapabilityState(capabilityViews(context), "tag:manage");

  return (
    <AdminShell
      session={sessionView(context)}
      title={novel.title}
      description={`业务 ID ${novel.businessId}`}
      actions={
        <div className="flex gap-2">
          {/*
            C-19 (`分析_文章管理Parity缺口_2026-09-08.md` §三 "书目筛选"): the
            only entry point into `/articles?novelId=…` — that filter is
            deliberately not a picker (see `ArticleFilters`'s own header), so
            without this link an operator would have no way to reach a
            book's article short of typing its UUID by hand. Placed on the
            detail page, not the list row: `novels-table.tsx` already has a
            test (`每行只提供查看入口，不提供任何写操作控件`) pinning exactly
            one "查看" link per row, and the analysis doc's "书目列表/详情"
            phrasing only requires the entry point exist somewhere, not both.
          */}
          <Link
            href={`/articles?novelId=${novel.novelId}`}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            查看该书目的文章
          </Link>
          <Link
            href="/novels"
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            返回列表
          </Link>
        </div>
      }
    >
      <div className="space-y-6">
        <AdminTimeZoneNote />

        <div className="grid gap-6 lg:grid-cols-2">
          <NovelIdentityPanel novel={novel} />
          <div className="space-y-6">
            <NovelPreviewPanel novel={novel} />
            <NovelSyncPanel novel={novel} />
          </div>
        </div>

        <PublishLifecyclePanel
          novelId={novel.novelId}
          novelStatus={novel.status}
          article={primaryArticle}
          canPublish={findCapabilityState(capabilities, "content:publish")}
          canTakedown={findCapabilityState(capabilities, "content:takedown")}
        />

        <NovelSourcesPanel novel={novel} />

        {/* Labels reach a novel only through its source items, so this panel sits
            directly under the upstream-sources panel rather than with the
            identity fields — it describes what the channel said, not what we own. */}
        <NovelLabelsPanel novel={novel} />

        {/* What we finally decided, versus what the channel said above — same
            reading order as `NovelSourcesPanel` → `NovelLabelsPanel`, one
            level more resolved. */}
        <NovelTagsPanel novelId={novel.novelId} locale={novel.locale} capability={tagManageCapability} />

        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-gray-900">
            章节列表
            {chapters && <span className="ml-2 font-normal text-gray-500">共 {chapters.total} 章</span>}
          </h2>
          {chapters ? (
            <>
              <ChaptersTable novelId={novel.novelId} chapters={chapters.items} />
              <ContentPagination
                basePath={`/novels/${novel.novelId}`}
                params={query}
                page={chapters.page}
                totalPages={chapters.totalPages}
                total={chapters.total}
              />
            </>
          ) : (
            <ContentErrorPanel message={errorEnvelopeCopy(chapterError!)} />
          )}
        </section>
      </div>
    </AdminShell>
  );
}
