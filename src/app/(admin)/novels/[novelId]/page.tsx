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
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";
import { getAdminNovelDetail, listAdminNovelChapters } from "@/server/admin-content";

import { prisma } from "../../../api/admin/_lib/deps";
import { AdminShell } from "../../_components/admin-shell";
import { sessionView } from "../../_lib/page-guard";
import { ChaptersTable } from "../_components/chapters-table";
import { ContentPagination } from "../_components/content-pagination";
import { ContentCapabilityDenied, ContentErrorPanel } from "../_components/content-states";
import { notFoundIfMissingIdentifier, queryErrorEnvelope } from "../_lib/content-errors";
import {
  NovelIdentityPanel,
  NovelPreviewPanel,
  NovelSourcesPanel,
  NovelSyncPanel,
} from "../_components/novel-detail-panels";
import { requireContentPage } from "../_lib/content-page-guard";

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

  return (
    <AdminShell
      session={sessionView(context)}
      title={novel.title}
      description={`业务 ID ${novel.businessId}`}
      actions={
        <Link
          href="/novels"
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
        >
          返回列表
        </Link>
      }
    >
      <div className="space-y-6">
        <div className="grid gap-6 lg:grid-cols-2">
          <NovelIdentityPanel novel={novel} />
          <div className="space-y-6">
            <NovelPreviewPanel novel={novel} />
            <NovelSyncPanel novel={novel} />
          </div>
        </div>

        <NovelSourcesPanel novel={novel} />

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
