import { capabilityBlockReason, findCapabilityState } from "@/features/admin-ui/capability-view";
import { MOBOREADER_CATALOG_LIMITS, resolveMoboreaderCatalogSafetyMaxPages } from "@/lib/tasks/moboreader";

import { AdminShell } from "../_components/admin-shell";
import { capabilityViews, sessionView } from "../_lib/page-guard";
import { ContentCapabilityDenied } from "../novels/_components/content-states";
import { ContentPagination } from "../novels/_components/content-pagination";
import { requireContentPage } from "../novels/_lib/content-page-guard";
import { CatalogScanTriggerForm } from "./_components/catalog-scan-trigger-form";
import { CatalogSyncClient } from "./_components/catalog-sync-client";
import { SourceItemFilters } from "./_components/source-item-filters";
import { readActiveChannelAppOptions } from "./_lib/read-channel-apps";
import { readSourceItemsPage } from "./_lib/read-source-items";

export const dynamic = "force-dynamic";

type SearchParams = {
  page?: string;
  status?: string;
  search?: string;
};

/**
 * `/catalog-sync` — the P0-S13 content-creation trigger entry.
 *
 * `createContentFromSourceItem` (`@/server/content-creation`) has existed
 * since P0-S4 with no caller under `src/app/**` at all — its own module
 * header says so. This page and `./_actions.ts` are that missing entry
 * point: browse `NovelSourceItem` rows, dry-run a creation plan, and (with
 * `content:publish`) apply it.
 *
 * Gated by `content:view`, the same read bar `/novels` uses — this screen is
 * read-heavy (a source-item list) with one write action nested inside a
 * dialog, not a write screen itself, so the page-level guard mirrors
 * `/novels` exactly rather than inventing a second convention.
 */
export default async function CatalogSyncPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const { context, granted } = await requireContentPage("/catalog-sync", "content:view");

  const capabilities = capabilityViews(context);
  const contentPublish = findCapabilityState(capabilities, "content:publish");
  const contentPublishBlockedReason = capabilityBlockReason("content:publish", contentPublish);

  const page = granted
    ? await readSourceItemsPage({ page: params.page, status: params.status, search: params.search })
    : null;
  const channelApps = granted ? await readActiveChannelAppOptions() : [];

  return (
    <AdminShell
      session={sessionView(context)}
      title="目录同步"
      description={
        page
          ? `共 ${page.total} 条来源条目，从中创建书目与文章草稿`
          : "浏览渠道来源条目，并从中创建书目与文章草稿。"
      }
    >
      <div className="space-y-6">
        {granted && page ? (
          <>
            <CatalogScanTriggerForm
              channelApps={channelApps}
              contentPublishGranted={contentPublishBlockedReason === null}
              contentPublishBlockedReason={contentPublishBlockedReason}
              maxPageSize={MOBOREADER_CATALOG_LIMITS.maxPageSize}
              safetyMaxPages={resolveMoboreaderCatalogSafetyMaxPages()}
            />
            <SourceItemFilters values={{ search: params.search, status: params.status }} />
            <CatalogSyncClient items={page.items} contentPublish={contentPublish} />
            <ContentPagination
              basePath="/catalog-sync"
              params={{ status: params.status, search: params.search }}
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
