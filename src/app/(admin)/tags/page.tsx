import {
  projectAdminContentPage,
  projectAdminSourceLabel,
  type AdminContentPageView,
  type AdminSourceLabelView,
} from "@/contracts";
import { listAdminSourceLabels } from "@/server/admin-content";

import { prisma } from "../../api/admin/_lib/deps";
import { AdminShell } from "../_components/admin-shell";
import { sessionView } from "../_lib/page-guard";
import { ContentCapabilityDenied } from "../novels/_components/content-states";
import { ContentPagination } from "../novels/_components/content-pagination";
import { requireContentPage } from "../novels/_lib/content-page-guard";
import { TagFilters, type TagActivityFilter } from "./_components/tag-filters";
import { TagsTable } from "./_components/tags-table";

export const dynamic = "force-dynamic";

type SearchParams = {
  page?: string;
  search?: string;
  labelKind?: string;
  activity?: string;
};

/**
 * Source-label dictionary — read-only (P2-06).
 *
 * Same shape as `/novels/page.tsx`: a Server Component that reads through
 * `listAdminSourceLabels` directly rather than calling its own
 * `/api/admin/tags` route. That route exists for the browser (client-side
 * refetch, other consumers); this page and it share one service and one
 * projection, so a hand-edited URL and this screen can never show a different
 * field set for the same query.
 *
 * `requireContentPage` is called with the literal route template `"/tags"` —
 * not a value built from any request data — because
 * `tests/backend/admin-ui/page-registration.test.ts` (and the nav-parity
 * check alongside it) compares this literal against the directory this file
 * actually lives in.
 */
export default async function TagsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const { context, granted } = await requireContentPage("/tags", "content:view");

  let page: AdminContentPageView<AdminSourceLabelView> | null = null;
  if (granted) {
    const result = await listAdminSourceLabels(prisma, {
      page: params.page ? Number(params.page) : undefined,
      search: params.search,
      labelKind: params.labelKind as never,
      activity: params.activity as never,
    });
    page = projectAdminContentPage(result, projectAdminSourceLabel);
  }

  // Mirrors the `<select name="activity" defaultValue={... ?? "current"}>` in
  // `TagFilters` — the same fallback, so the empty-state copy in `TagsTable`
  // never disagrees with what the filter bar shows as selected.
  const activity: TagActivityFilter = (params.activity as TagActivityFilter | undefined) ?? "current";

  return (
    <AdminShell
      session={sessionView(context)}
      title="标签字典"
      description={
        page ? `共 ${page.total} 个来源标签` : "浏览渠道回传的原始标签，核对分类与展示名、追溯关联小说。"
      }
    >
      <div className="space-y-6">
        {granted && page ? (
          <>
            <TagFilters
              values={{ search: params.search, labelKind: params.labelKind, activity: params.activity }}
            />
            <TagsTable labels={page.items} activity={activity} />
            <ContentPagination
              basePath="/tags"
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
