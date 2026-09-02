import Link from "next/link";

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
 * This stays a read-only screen by design — claim *execution* is still owned
 * by the dual-gated worker path, not this page, and nothing here calls
 * `createPromoLinkClaimTask` or writes anything. What changed with RC-1 is
 * where a *new* claim gets triggered from: `/catalog-sync`'s "领取推广链接"
 * launcher (`enqueuePromoLinkClaimAction`,
 * `../catalog-sync/_actions.ts`) — explicit multi-select only, CPS v8.3.6
 * parity for `submitChangduPromoClaim`. This page is where the *result* of
 * that (and of the always-on existing-promo read path) shows up, once the
 * worker has processed it. The banner below and the two actionable controls
 * — the cross-link into `/tasks`'s manual-review section for
 * `claim_manual_review_required` rows, and the new jump to `/catalog-sync`
 * to start a claim — are what an operator standing on this page needs next;
 * neither one performs a write from here.
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
          <p className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600" data-testid="promo-links-claim-launcher-note">
            本页只读——发起新的推广链接领取请前往{" "}
            <Link href="/catalog-sync" className="font-medium text-blue-700 hover:underline">
              目录同步
            </Link>
            ，勾选来源条目后点击「领取推广链接」；领取结果会体现在下方列表，任务进度见{" "}
            <Link href="/tasks" className="font-medium text-blue-700 hover:underline">
              任务中心
            </Link>
            。
          </p>
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
