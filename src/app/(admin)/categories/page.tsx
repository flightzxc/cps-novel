/**
 * `/categories` is the operator-facing CanonicalTag taxonomy entry. It reuses
 * tagging-v3's service, contracts, editor and mappings API; `/tags` remains
 * the raw SourceLabel dictionary. This is the Novel adaptation of CPS v8.3.6
 * category management and intentionally does not introduce Category tables.
 */
import Link from "next/link";

import { projectAdminCanonicalTagList, type AdminCanonicalTagListView } from "@/contracts";
import { findCapabilityState } from "@/features/admin-ui/capability-view";
import { listAdminCanonicalTags } from "@/server/tagging/admin-service";

import { prisma } from "../../api/admin/_lib/deps";
import { AdminShell } from "../_components/admin-shell";
import { capabilityViews, sessionView } from "../_lib/page-guard";
import { ContentCapabilityDenied } from "../novels/_components/content-states";
import { ContentPagination } from "../novels/_components/content-pagination";
import { requireContentPage } from "../novels/_lib/content-page-guard";
import { CanonicalTagFilters } from "../tags/canonical/_components/canonical-tag-filters";
import { CanonicalTagsClient } from "../tags/canonical/_components/canonical-tags-client";
import { ClassifierDiagnosticsPanel } from "../tags/canonical/_components/classifier-diagnostics-panel";

export const dynamic = "force-dynamic";

type SearchParams = { page?: string; search?: string; active?: string };

export default async function CategoriesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const { context, granted } = await requireContentPage("/categories", "content:view");
  let page: AdminCanonicalTagListView | null = null;
  if (granted) {
    page = projectAdminCanonicalTagList(await listAdminCanonicalTags(prisma, params));
  }
  const tagManage = findCapabilityState(capabilityViews(context), "tag:manage");

  return (
    <AdminShell
      session={sessionView(context)}
      title="分类管理"
      description={page ? `共 ${page.total} 个 Canonical Tag` : "维护公开分类；来源标签字典仍位于 /tags。"}
      actions={<Link href="/tags/mappings" className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm">来源映射</Link>}
    >
      <div className="space-y-6">
        {granted && page ? <>
          <CanonicalTagFilters values={{ search: params.search, active: params.active }} />
          <CanonicalTagsClient items={page.items} tagManage={tagManage} />
          <ContentPagination basePath="/categories" params={params} page={page.page} totalPages={page.totalPages} total={page.total} />
          <ClassifierDiagnosticsPanel authority={page.authority} />
        </> : <ContentCapabilityDenied capability="content:view" />}
      </div>
    </AdminShell>
  );
}
