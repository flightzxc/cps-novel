import { parseSourceCreatedPreset } from "@/domain/catalog-batch";
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
import { canonicalCatalogFilter, readSourceItemsPage, resolveSourceItemFilters } from "./_lib/read-source-items";

export const dynamic = "force-dynamic";

type SearchParams = {
  page?: string;
  status?: string;
  search?: string;
  sourceLocale?: string;
  promoLinkStatus?: string;
  /** 上架时间预设（天数，`7|30|90|180|365`）；换算成绝对日期只在下面做一次。 */
  sourceCreatedWithin?: string;
  /** 列表排序（`source_created_desc` = 上架时间新→旧）；只影响展示。 */
  sort?: string;
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

  // "近 N 天"预设在这里按北京时间的今天换算成绝对日期，**只算一次**，同一个结果
  // 同时交给列表查询与批次快照（canonicalFilter）——全选建批次时页面看到的集合与
  // worker 枚举的集合因此是同一个，不会因为跨零点而各算各的。
  const sourceCreatedPreset = parseSourceCreatedPreset(params.sourceCreatedWithin);
  const sourceCreatedWithin = sourceCreatedPreset ? String(sourceCreatedPreset) : undefined;
  const filters = resolveSourceItemFilters({
    page: params.page,
    status: params.status,
    search: params.search,
    sourceLocale: params.sourceLocale,
    promoLinkStatus: params.promoLinkStatus,
    sourceCreatedWithin,
    sort: params.sort,
    pageSize: params.pageSize,
  });
  const page = granted ? await readSourceItemsPage(filters) : null;
  const canonicalFilter = canonicalCatalogFilter(filters);
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
              values={{
                ...canonicalFilter,
                sourceCreatedWithin,
                sort: filters.sort,
                pageSize: String(page.pageSize),
              }}
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
              params={{ status: params.status, search: params.search, sourceLocale: params.sourceLocale, promoLinkStatus: params.promoLinkStatus, sourceCreatedWithin, sort: filters.sort, pageSize: String(page.pageSize) }}
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
