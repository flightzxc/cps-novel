import {
  projectAdminSourceLabelMappingList,
  type AdminSourceLabelMappingListView,
} from "@/contracts";
import { findCapabilityState } from "@/features/admin-ui/capability-view";
import { listAdminSourceLabelMappings } from "@/server/tagging/admin-service";

import { prisma } from "../../../api/admin/_lib/deps";
import { AdminShell } from "../../_components/admin-shell";
import { capabilityViews, sessionView } from "../../_lib/page-guard";
import { ContentCapabilityDenied } from "../../novels/_components/content-states";
import { ContentPagination } from "../../novels/_components/content-pagination";
import { requireContentPage } from "../../novels/_lib/content-page-guard";
import { TaggingDisabledPanel, TaggingWriteDisabledNotice } from "../_components/tagging-disabled-panel";
import { TagNavTabs } from "../_components/tag-nav-tabs";
import { readTaggingFlagState } from "../_lib/tagging-flag-checklist";
import { MappingFilters } from "./_components/mapping-filters";
import { MappingsClient } from "./_components/mappings-client";

export const dynamic = "force-dynamic";

type SearchParams = {
  page?: string;
  search?: string;
  active?: string;
  channelAppId?: string;
  canonicalTagId?: string;
  rawLanguageScope?: string;
  rawToken?: string;
};

/**
 * Source Label Mapping management — P2-06.5 Admin V1, package 2.
 *
 * Same shape as `/tags/page.tsx` and `/tags/canonical/page.tsx`: a Server
 * Component reading straight through `listAdminSourceLabelMappings` rather
 * than fetching its own `/api/admin/tag-mappings` route from the server, so
 * this page and that route can never disagree about what a hand-edited URL
 * should show — they share one service and one projection.
 *
 * `requireContentPage` is called with the literal `"/tags/mappings"` — not a
 * value built from `params` — because `tests/ui/admin-nav-parity.test.tsx`
 * greps this literal and compares it against the directory this file
 * actually lives in.
 *
 * All seven query params are passed through as raw strings, exactly like
 * `GET /api/admin/tag-mappings` does through `sourceLabelMappingGetInput` —
 * the service owns all normalisation (page-number parsing, `search`
 * trimming, `active` validation, and — the one that matters most on this
 * screen — *not* trimming or normalising `rawLanguageScope` / `rawToken`).
 * This page does not duplicate any of that, and in particular never touches
 * the two exact-identity fields itself.
 *
 * PR6 fix (lane F): `listAdminSourceLabelMappings` throws
 * `TaggingAdminError("tagging_disabled", 403)` the instant
 * `FEATURE_P2_06_5_TAGGING` is off (`requireTaggingRead`); this page now
 * checks `readTaggingFlagState()` before calling the service at all and
 * renders `TaggingDisabledPanel` in its place, instead of letting the throw
 * reach the segment's error boundary.
 */
export default async function TagMappingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const { context, granted } = await requireContentPage("/tags/mappings", "content:view");
  const taggingFlags = readTaggingFlagState();

  let page: AdminSourceLabelMappingListView | null = null;
  if (granted && taggingFlags.readEnabled) {
    const result = await listAdminSourceLabelMappings(prisma, {
      page: params.page,
      search: params.search,
      active: params.active,
      channelAppId: params.channelAppId,
      canonicalTagId: params.canonicalTagId,
      rawLanguageScope: params.rawLanguageScope,
      rawToken: params.rawToken,
    });
    page = projectAdminSourceLabelMappingList(result);
  }

  const tagManage = findCapabilityState(capabilityViews(context), "tag:manage");

  return (
    <AdminShell
      session={sessionView(context)}
      title="来源映射"
      description={
        page
          ? `共 ${page.total} 条来源标签 → Canonical Tag 映射`
          : "管理渠道原始标签（rawToken）到 Canonical Tag 的精确映射边。"
      }
    >
      <div className="space-y-6">
        <TagNavTabs current="mappings" />
        {!granted ? (
          <ContentCapabilityDenied capability="content:view" />
        ) : !taggingFlags.readEnabled ? (
          <TaggingDisabledPanel state={taggingFlags} />
        ) : page ? (
          <>
            {!taggingFlags.writeEnabled && <TaggingWriteDisabledNotice />}
            <MappingFilters
              values={{
                search: params.search,
                active: params.active,
                rawLanguageScope: params.rawLanguageScope,
                rawToken: params.rawToken,
                canonicalTagId: params.canonicalTagId,
              }}
            />
            <MappingsClient
              items={page.items}
              tagManage={tagManage}
              writeFlagEnabled={taggingFlags.writeEnabled}
              prefillCanonicalTagId={params.canonicalTagId}
            />
            <ContentPagination
              basePath="/tags/mappings"
              params={params}
              page={page.page}
              totalPages={page.totalPages}
              total={page.total}
            />
          </>
        ) : null}
      </div>
    </AdminShell>
  );
}
