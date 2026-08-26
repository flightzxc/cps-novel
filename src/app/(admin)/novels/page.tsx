import {
  projectAdminContentPage,
  projectAdminNovelListItem,
  type AdminContentPageView,
  type AdminNovelListItemView,
} from "@/contracts";
import { AdminTimeZoneNote } from "@/features/admin-ui/time-zone-note";
import { listAdminNovels } from "@/server/admin-content";

import { prisma } from "../../api/admin/_lib/deps";
import { AdminShell } from "../_components/admin-shell";
import { sessionView } from "../_lib/page-guard";
import { ContentCapabilityDenied } from "./_components/content-states";
import { ContentPagination } from "./_components/content-pagination";
import { NovelFilters } from "./_components/novel-filters";
import { NovelsTable } from "./_components/novels-table";
import { requireContentPage } from "./_lib/content-page-guard";

export const dynamic = "force-dynamic";

type SearchParams = {
  page?: string;
  search?: string;
  status?: string;
  locale?: string;
  /**
   * A `source_label.id`, reached by following "查看关联小说" from `/tags` (P2-06).
   * Exact match on a real dictionary row — there is deliberately no label
   * dropdown here and no matching by label text, so the only way to arrive at a
   * value is a row that actually exists.
   */
  labelId?: string;
};

/**
 * Novel list.
 *
 * Reads through `listAdminNovels` directly rather than calling its own HTTP
 * route: a server component fetching its own origin would add a round trip, a
 * second cookie hop and a second failure mode for no gain. The route exists for
 * the browser; both entry points share one service and one projection, so
 * neither can drift into showing a different set of fields.
 */
export default async function NovelsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const { context, granted } = await requireContentPage("/novels", "content:view");

  let page: AdminContentPageView<AdminNovelListItemView> | null = null;
  if (granted) {
    const result = await listAdminNovels(prisma, {
      page: params.page ? Number(params.page) : undefined,
      search: params.search,
      status: params.status as never,
      locale: params.locale,
      labelId: params.labelId,
    });
    page = projectAdminContentPage(result, projectAdminNovelListItem);
  }

  return (
    <AdminShell
      session={sessionView(context)}
      title="书目管理"
      description={
        page ? `共 ${page.total} 部书目` : "浏览已入库的书目、章节与试读落地情况。"
      }
    >
      <div className="space-y-6">
        {granted && page ? (
          <>
            <NovelFilters
              values={{
                search: params.search,
                status: params.status,
                locale: params.locale,
                labelId: params.labelId,
              }}
            />
            <div className="space-y-2">
              <AdminTimeZoneNote />
              <NovelsTable novels={page.items} />
            </div>
            <ContentPagination
              basePath="/novels"
              params={params}
              page={page.page}
              totalPages={page.totalPages}
              total={page.total}
            />
          </>
        ) : (
          <ContentCapabilityDenied capability="content:view" />
        )}
      </div>
    </AdminShell>
  );
}
