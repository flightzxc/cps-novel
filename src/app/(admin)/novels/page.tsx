import {
  projectAdminContentPage,
  projectAdminNovelListItem,
  type AdminContentPageView,
  type AdminNovelListItemView,
} from "@/contracts";
import { findCapabilityState } from "@/features/admin-ui/capability-view";
import { AdminTimeZoneNote } from "@/features/admin-ui/time-zone-note";
import { listAdminNovels } from "@/server/admin-content";

import { prisma } from "../../api/admin/_lib/deps";
import { AdminShell } from "../_components/admin-shell";
import { capabilityViews, sessionView } from "../_lib/page-guard";
import { blankParamToUndefined } from "../_lib/search-params";
import { ContentCapabilityDenied } from "./_components/content-states";
import { ContentPagination } from "./_components/content-pagination";
import { NovelFilters } from "./_components/novel-filters";
import { NovelsBatchPublish } from "./_components/novels-batch-publish";
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

  // 筛选栏的"全部状态""全部语种"提交的是 `status=` / `locale=`（存在但为空），语义
  // 是"不过滤"。服务层对非空未登记值是严格拒绝的，所以空白值必须在这里还原成
  // `undefined`；同一份规范化结果同时喂给列表查询和筛选栏回显，两者不会各说各话。
  // `?status=foo` 这类非空非法值不在此放行，仍由服务层拒绝。
  const filters = {
    search: blankParamToUndefined(params.search),
    status: blankParamToUndefined(params.status),
    locale: blankParamToUndefined(params.locale),
    labelId: blankParamToUndefined(params.labelId),
  };

  let page: AdminContentPageView<AdminNovelListItemView> | null = null;
  if (granted) {
    const result = await listAdminNovels(prisma, {
      page: params.page ? Number(params.page) : undefined,
      search: filters.search,
      status: filters.status as never,
      locale: filters.locale,
      labelId: filters.labelId,
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
            <NovelFilters values={filters} />
            <div className="space-y-2">
              <AdminTimeZoneNote />
              <NovelsBatchPublish
                novels={page.items}
                canPublish={findCapabilityState(capabilityViews(context), "content:publish")}
              />
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
