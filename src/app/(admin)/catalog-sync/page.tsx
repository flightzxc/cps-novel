import { capabilityBlockReason, findCapabilityState } from "@/features/admin-ui/capability-view";
import { AdminTimeZoneNote } from "@/features/admin-ui/time-zone-note";
import { isNovelCatalogSyncEnabled } from "@/lib/flags";
import { resolveMoboreaderCatalogSafetyMaxPages } from "@/lib/tasks/moboreader";
import { AdminShell } from "../_components/admin-shell";
import { capabilityViews, sessionView } from "../_lib/page-guard";
import { ContentCapabilityDenied } from "../novels/_components/content-states";
import { ContentPagination } from "../novels/_components/content-pagination";
import { requireContentPage } from "../novels/_lib/content-page-guard";
import { CatalogScanTriggerForm } from "./_components/catalog-scan-trigger-form";
import { CatalogSyncClient } from "./_components/catalog-sync-client";
import { SourceItemFilters } from "./_components/source-item-filters";
import { readActiveChannelScanOptions } from "./_lib/read-channel-apps";
import { canonicalCatalogFilter, readSourceItemsPage } from "./_lib/read-source-items";

export const dynamic = "force-dynamic";

type SearchParams = {
  page?: string;
  status?: string;
  search?: string;
  sourceLocale?: string;
  pageSize?: string;
};

/**
 * `/catalog-sync` — the P0-S13 content-creation trigger entry.
 *
 * This page and `./_actions.ts` browse `NovelSourceItem` rows and enqueue
 * Novel-only materialize (`纳入书目`). They must not select templates or
 * create Articles.
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
  const promoClaim = findCapabilityState(capabilities, "promo:claim");
  const promoClaimBlockedReason = capabilityBlockReason("promo:claim", promoClaim);

  const page = granted
    ? await readSourceItemsPage({
        page: params.page,
        status: params.status,
        search: params.search,
        sourceLocale: params.sourceLocale,
        pageSize: params.pageSize,
      })
    : null;
  const canonicalFilter = canonicalCatalogFilter(params);
  const channels = granted ? await readActiveChannelScanOptions() : [];

  return (
    <AdminShell
      session={sessionView(context)}
      title="目录同步"
      description={
        page
          ? `共 ${page.total} 条来源条目，从中纳入书目`
          : "浏览渠道来源条目，并从中纳入书目。"
      }
    >
      <div className="space-y-6">
        {granted && page ? (
          <>
            <CatalogScanTriggerForm
              channels={channels}
              contentPublishGranted={contentPublishBlockedReason === null}
              contentPublishBlockedReason={contentPublishBlockedReason}
              safetyMaxPages={resolveMoboreaderCatalogSafetyMaxPages()}
            />
            <SourceItemFilters
              values={{ ...canonicalFilter, pageSize: String(page.pageSize) }}
            />
            <div className="space-y-2">
              <AdminTimeZoneNote />
              <CatalogSyncClient
                key={JSON.stringify(canonicalFilter)}
                items={page.items}
                catalogGate={{ featureEnabled: isNovelCatalogSyncEnabled() }}
                contentPublish={contentPublish}
                promoClaimGranted={promoClaimBlockedReason === null}
                promoClaimBlockedReason={promoClaimBlockedReason}
                filter={canonicalFilter}
                total={page.total}
              />
            </div>
            <ContentPagination
              basePath="/catalog-sync"
              params={{ status: params.status, search: params.search, sourceLocale: params.sourceLocale, pageSize: String(page.pageSize) }}
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
