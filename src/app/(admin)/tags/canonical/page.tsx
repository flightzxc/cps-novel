import {
  projectAdminCanonicalTagList,
  type AdminCanonicalTagListView,
} from "@/contracts";
import { findCapabilityState } from "@/features/admin-ui/capability-view";
import { listAdminCanonicalTags } from "@/server/tagging/admin-service";

import { prisma } from "../../../api/admin/_lib/deps";
import { AdminShell } from "../../_components/admin-shell";
import { capabilityViews, sessionView } from "../../_lib/page-guard";
import { ContentCapabilityDenied } from "../../novels/_components/content-states";
import { ContentPagination } from "../../novels/_components/content-pagination";
import { requireContentPage } from "../../novels/_lib/content-page-guard";
import { TagNavTabs } from "../_components/tag-nav-tabs";
import { CanonicalTagFilters } from "./_components/canonical-tag-filters";
import { CanonicalTagsClient } from "./_components/canonical-tags-client";
import { ClassifierDiagnosticsPanel } from "./_components/classifier-diagnostics-panel";

export const dynamic = "force-dynamic";

type SearchParams = {
  page?: string;
  search?: string;
  active?: string;
};

/**
 * Canonical Tag dictionary — P2-06.5 Admin V1, package 1.
 *
 * Same shape as `/tags/page.tsx`: a Server Component reading straight through
 * `listAdminCanonicalTags` rather than fetching its own
 * `/api/admin/canonical-tags` route from the server, so this page and that
 * route can never disagree about what a hand-edited URL should show — they
 * share one service and one projection.
 *
 * `requireContentPage` is called with the literal `"/tags/canonical"` — not a
 * value built from `params` — because `tests/ui/admin-nav-parity.test.tsx`
 * compares this literal against the directory this file actually lives in.
 *
 * `page`/`search`/`active` are passed through to `listAdminCanonicalTags`
 * as the raw query strings, exactly like `GET /api/admin/canonical-tags`
 * does through `canonicalTagGetInput` — the service owns all normalization
 * (page-number parsing, search trimming, active-filter validation), so this
 * page does not duplicate that logic.
 */
export default async function CanonicalTagsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const { context, granted } = await requireContentPage("/tags/canonical", "content:view");

  let page: AdminCanonicalTagListView | null = null;
  if (granted) {
    const result = await listAdminCanonicalTags(prisma, {
      page: params.page,
      search: params.search,
      active: params.active,
    });
    page = projectAdminCanonicalTagList(result);
  }

  const tagManage = findCapabilityState(capabilityViews(context), "tag:manage");

  return (
    <AdminShell
      session={sessionView(context)}
      title="Canonical Tag"
      description={
        page
          ? `共 ${page.total} 个 Canonical Tag`
          : "维护标准化标签的启停状态、译名与别名；keyword 与体系授权只读，由冻结的 classifier 管理。"
      }
    >
      <div className="space-y-6">
        <TagNavTabs current="canonical" />
        {granted && page ? (
          <>
            <CanonicalTagFilters values={{ search: params.search, active: params.active }} />
            <CanonicalTagsClient items={page.items} tagManage={tagManage} />
            <ContentPagination
              basePath="/tags/canonical"
              params={params}
              page={page.page}
              totalPages={page.totalPages}
              total={page.total}
            />
            <ClassifierDiagnosticsPanel authority={page.authority} />
          </>
        ) : (
          <ContentCapabilityDenied capability="content:view" />
        )}
      </div>
    </AdminShell>
  );
}
