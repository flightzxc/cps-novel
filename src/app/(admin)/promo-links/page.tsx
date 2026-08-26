import { listAdminPromoLinks } from "@/server/task-admin";
import { AdminTimeZoneNote } from "@/features/admin-ui/time-zone-note";

import { prisma } from "../../api/admin/_lib/deps";
import { AdminShell } from "../_components/admin-shell";
import { sessionView } from "../_lib/page-guard";
import { ContentCapabilityDenied } from "../novels/_components/content-states";
import { requireContentPage } from "../novels/_lib/content-page-guard";
import { PromoLinkFilters } from "./_components/promo-link-filters";
import { PromoLinksTable } from "./_components/promo-links-table";
import { PROMO_LINKS_LIST_LIMIT_NOTE } from "./_lib/promo-link-copy";

export const dynamic = "force-dynamic";

type SearchParams = {
  status?: string;
  novelId?: string;
  limit?: string;
};

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

/**
 * 推广链接状态页 (PR-C5).
 *
 * Reads through `listAdminPromoLinks` (`@/server/task-admin`) directly, same
 * rationale as `/tasks`, `/novels`, `/tags`: the `/api/admin/promo-links`
 * route exists for browser-side callers, this server render shares the same
 * service and projection instead of hairpinning through its own origin.
 *
 * This is a read-only screen by design — X9's contract exposes no mutation
 * for `PromoLink` rows (`claimPromo` itself stays `registered_disabled`,
 * see `src/lib/adapters/promo-link-claim.ts`'s header). The one actionable
 * control here is a cross-link into `/tasks`'s manual-review section for
 * `claim_manual_review_required` rows — that queue is where the actual
 * decision gets made, not here.
 */
export default async function PromoLinksPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const { context, granted } = await requireContentPage("/promo-links", "task:manage");

  const result = granted
    ? await listAdminPromoLinks(prisma, context, {
        status: nonEmpty(params.status),
        novelId: nonEmpty(params.novelId),
        limit: nonEmpty(params.limit),
      })
    : null;

  return (
    <AdminShell
      session={sessionView(context)}
      title="推广链接"
      description={result ? `最近 ${result.items.length} / 上限 ${result.limit} 条` : "查看各渠道推广链接的获取状态与失败原因。"}
    >
      {granted && result ? (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <PromoLinkFilters values={{ status: params.status, novelId: params.novelId, limit: params.limit }} />
            <AdminTimeZoneNote />
          </div>
          <p className="text-xs text-gray-500">{PROMO_LINKS_LIST_LIMIT_NOTE}</p>
          <PromoLinksTable links={result.items} />
        </div>
      ) : (
        <ContentCapabilityDenied capability="task:manage" />
      )}
    </AdminShell>
  );
}
