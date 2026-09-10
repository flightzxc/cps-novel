import { capabilityBlockReason, findCapabilityState } from "@/features/admin-ui/capability-view";
import { AdminTimeZoneNote } from "@/features/admin-ui/time-zone-note";
import { isNovelCatalogSyncEnabled } from "@/lib/flags";
import { resolveMoboreaderCatalogSafetyMaxPages } from "@/lib/tasks/moboreader";
import { PROMO_LINK_CLAIM_LIMITS } from "@/lib/tasks/promo-link-claim-limits";
import { CONTENT_CREATION_BATCH_MAX_SELECTION } from "@/server/content-creation/batch";
import { listActiveArticleTemplateOptionsForLocales } from "@/server/article-templates";
import { prisma } from "../../api/admin/_lib/deps";

import { AdminShell } from "../_components/admin-shell";
import { capabilityViews, sessionView } from "../_lib/page-guard";
import { ContentCapabilityDenied } from "../novels/_components/content-states";
import { ContentPagination } from "../novels/_components/content-pagination";
import { requireContentPage } from "../novels/_lib/content-page-guard";
import { CatalogScanTriggerForm } from "./_components/catalog-scan-trigger-form";
import { CatalogSyncClient } from "./_components/catalog-sync-client";
import { SourceItemFilters } from "./_components/source-item-filters";
import { readActiveChannelScanOptions, readClaimEligibleChannelAppOptions } from "./_lib/read-channel-apps";
import { readSourceItemsPage } from "./_lib/read-source-items";

export const dynamic = "force-dynamic";

type SearchParams = {
  page?: string;
  status?: string;
  search?: string;
  sourceLocale?: string;
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
  const promoClaim = findCapabilityState(capabilities, "promo:claim");
  const promoClaimBlockedReason = capabilityBlockReason("promo:claim", promoClaim);

  const page = granted
    ? await readSourceItemsPage({
        page: params.page,
        status: params.status,
        search: params.search,
        sourceLocale: params.sourceLocale,
      })
    : null;
  const channels = granted ? await readActiveChannelScanOptions() : [];
  const claimChannelApps = granted ? await readClaimEligibleChannelAppOptions() : [];
  /**
   * L10N P2 (matrix #13's dialog-scoped part, P2 段): was a single
   * hardcoded `listActiveArticleTemplateOptions(prisma, "en")` call — every
   * row's create-content dialog offered the same `en`-only template list
   * regardless of that row's own derived locale. Content creation no longer
   * writes a hardcoded `"en"` locale at all (`src/server/content-creation/
   * service.ts` derives it from `NovelSourceItem.sourceLocale`), so the
   * template picker must not stay pinned to one locale either.
   *
   * L10N P5 (P2 复核 C5-a): the P2 round fixed the *locale* but did it with
   * N separate `listActiveArticleTemplateOptions(prisma, locale)` queries
   * (one per distinct `sourceLocale` on the page) flattened client-side —
   * collapsed here into the single `locale: { in: sourceLocalesOnPage }`
   * query `listActiveArticleTemplateOptionsForLocales` runs
   * (`article-templates/service.ts`, own doc comment on why its `distinct`
   * is `["templateKey", "locale"]` and not just `["templateKey"]`). Same
   * flat array shape `CatalogSyncClient`/`CreateContentDialog`/
   * `BatchCreateContentDialog` already accept — no prop-shape change
   * ripples through those components; `CreateContentDialog` (see its own
   * doc comment) is what actually narrows this down to the one locale a
   * given row's dialog needs, this fetch only has to make sure every
   * locale any row on the page could need is present at all.
   */
  const sourceLocalesOnPage = granted
    ? Array.from(new Set(page?.items.map((item) => item.sourceLocale).filter((locale): locale is string => locale !== null) ?? []))
    : [];
  const templateOptions = granted && sourceLocalesOnPage.length > 0
    ? await listActiveArticleTemplateOptionsForLocales(prisma, sourceLocalesOnPage)
    : [];

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
              channels={channels}
              contentPublishGranted={contentPublishBlockedReason === null}
              contentPublishBlockedReason={contentPublishBlockedReason}
              safetyMaxPages={resolveMoboreaderCatalogSafetyMaxPages()}
            />
            <SourceItemFilters
              values={{ search: params.search, status: params.status, sourceLocale: params.sourceLocale }}
            />
            <div className="space-y-2">
              <AdminTimeZoneNote />
              <CatalogSyncClient
                items={page.items}
                catalogGate={{ featureEnabled: isNovelCatalogSyncEnabled() }}
                contentPublish={contentPublish}
                claimChannelApps={claimChannelApps}
                promoClaimMaxBatchSize={PROMO_LINK_CLAIM_LIMITS.maxBatchSize}
                promoClaimGranted={promoClaimBlockedReason === null}
                promoClaimBlockedReason={promoClaimBlockedReason}
                contentCreationBatchMaxSize={CONTENT_CREATION_BATCH_MAX_SELECTION}
                templateOptions={templateOptions}
              />
            </div>
            <ContentPagination
              basePath="/catalog-sync"
              params={{ status: params.status, search: params.search, sourceLocale: params.sourceLocale }}
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
