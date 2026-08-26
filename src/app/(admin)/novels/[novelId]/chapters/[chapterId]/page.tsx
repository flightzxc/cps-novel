import Link from "next/link";
import { notFound } from "next/navigation";

import { projectAdminChapterDetail } from "@/contracts";
import { AdminTimeZoneNote } from "@/features/admin-ui/time-zone-note";
import { hasAdminCapability } from "@/lib/auth/capabilities";
import { getAdminChapterDetail } from "@/server/admin-content";

import { prisma } from "../../../../../api/admin/_lib/deps";
import { AdminShell } from "../../../../_components/admin-shell";
import { sessionView } from "../../../../_lib/page-guard";
import { ChapterContentViewer } from "../../../_components/chapter-content-viewer";
import {
  ChapterDetailPanel,
  ChapterSourcesPanel,
} from "../../../_components/chapter-detail-panel";
import { ContentCapabilityDenied } from "../../../_components/content-states";
import { notFoundIfMissingIdentifier } from "../../../_lib/content-errors";
import { requireContentPage } from "../../../_lib/content-page-guard";

export const dynamic = "force-dynamic";

/**
 * Chapter detail.
 *
 * Two grants are in play and they are checked separately. `content:view` gets
 * the metadata panels rendered here; `content:read` gets the body, which is not
 * rendered here at all — `ChapterContentViewer` fetches it from
 * `/api/admin/novels/chapters/content` on an explicit click, and that route
 * re-checks `content:read` server-side.
 *
 * The capability check below only decides whether to *offer* the viewer. An
 * operator with `content:view` alone sees the chapter's shape and a clear reason
 * they cannot read the text.
 */
export default async function ChapterDetailPage({
  params,
}: {
  params: Promise<{ novelId: string; chapterId: string }>;
}) {
  const { novelId, chapterId } = await params;
  const { context, granted } = await requireContentPage(
    "/novels/[novelId]/chapters/[chapterId]",
    "content:view",
  );

  if (!granted) {
    return (
      <AdminShell session={sessionView(context)} title="章节详情">
        <ContentCapabilityDenied capability="content:view" />
      </AdminShell>
    );
  }

  const record = await getAdminChapterDetail(prisma, novelId, chapterId).catch(
    notFoundIfMissingIdentifier,
  );
  if (!record) notFound();

  const chapter = projectAdminChapterDetail(record);
  const canReadBody = hasAdminCapability(context, "content:read");

  return (
    <AdminShell
      session={sessionView(context)}
      title={chapter.title ?? `第 ${chapter.canonicalChapterNumber} 章`}
      description={`${chapter.novelTitle} · ${chapter.novelBusinessId}`}
      actions={
        <Link
          href={`/novels/${chapter.novelId}`}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
        >
          返回书目
        </Link>
      }
    >
      <div className="space-y-6">
        <AdminTimeZoneNote />

        <div className="grid gap-6 lg:grid-cols-2">
          <ChapterDetailPanel chapter={chapter} />
          <ChapterSourcesPanel chapter={chapter} />
        </div>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-gray-900">章节正文</h2>
          {canReadBody ? (
            <ChapterContentViewer
              novelId={chapter.novelId}
              chapterId={chapter.chapterId}
              hasContent={chapter.hasContent}
            />
          ) : (
            <ContentCapabilityDenied capability="content:read" />
          )}
        </section>
      </div>
    </AdminShell>
  );
}
