import { AdminTimeZoneNote } from "@/features/admin-ui/time-zone-note";
import { defaultRevenueRange, loadRevenueDashboard, type RevenueDashboardView } from "@/server/revenue";

import { prisma } from "../../api/admin/_lib/deps";
import { AdminShell } from "../_components/admin-shell";
import { sessionView } from "../_lib/page-guard";
import { ContentCapabilityDenied } from "../novels/_components/content-states";
import { requireContentPage } from "../novels/_lib/content-page-guard";
import { BatchTable } from "./_components/batch-table";
import { DailyTable } from "./_components/daily-table";
import { MethodologyNote } from "./_components/methodology-note";
import { RangeFilter } from "./_components/range-filter";
import { SummaryCards } from "./_components/summary-cards";
import { SyncOverview } from "./_components/sync-overview";
import { SyncPanel } from "./_components/sync-panel";
import { resolveRevenueRange, type RevenueRangeParams } from "./_lib/range";

export const dynamic = "force-dynamic";

/**
 * `/revenue` — 海阅账号级小说收益看板（只读视图 + 手动同步入口）。
 *
 * 取数走 server component 直接调 `loadRevenueDashboard`（`@/server/revenue`），不新增任何
 * `/api/admin/**` 路由；写入只有一个 server action（`./_actions.ts`，`admin.revenue.sync.enqueue`）。
 *
 * 能力位 `revenue:view`（要求 2FA，默认无人拥有）。页面级 guard 只是体验层——没有授权时渲染
 * 「缺少能力位」面板，**并且不发起任何查询**；数据与写入的真正闸门在服务与 action 里。
 *
 * 区间：`?from=&to=`（YYYY-MM-DD，北京时间）。读服务对非法区间会抛错，所以先在
 * `./_lib/range.ts` 校验，非法一律回落默认区间（最近 30 天）并把原因提示出来。
 */
export default async function RevenuePage({
  searchParams,
}: {
  searchParams: Promise<RevenueRangeParams>;
}) {
  const params = await searchParams;
  const { context, granted } = await requireContentPage("/revenue", "revenue:view");
  const session = sessionView(context);

  if (!granted) {
    return (
      <AdminShell
        session={session}
        title="数据看板"
        description="海阅网文账号级每日汇总：激活用户、新用户、分成收入（US$）。"
      >
        <ContentCapabilityDenied capability="revenue:view" />
      </AdminShell>
    );
  }

  const now = new Date();
  const fallback = defaultRevenueRange(now);
  // `defaultRevenueRange` 的结束日就是北京时间今天；同一个"今天"贯穿整页（区间校验 / 快捷项 / 同步表单）。
  const today = fallback.dateTo;
  const range = resolveRevenueRange(params, today, fallback);

  const view: RevenueDashboardView = await loadRevenueDashboard(prisma, {
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
  });

  return (
    <AdminShell
      session={session}
      title="数据看板"
      description={`${view.range.dateFrom} ~ ${view.range.dateTo}，共 ${view.range.dayCount} 天（北京时间）`}
    >
      <div className="space-y-6">
        <MethodologyNote />
        <AdminTimeZoneNote />

        {range.fallbackNotice && (
          <p
            role="status"
            data-testid="revenue-range-fallback-notice"
            className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          >
            {range.fallbackNotice}
          </p>
        )}

        <SyncOverview view={view} nowMs={now.getTime()} />
        <SyncPanel account={view.account} activeTask={view.activeTask} today={today} nowMs={now.getTime()} />

        <RangeFilter
          key={`${view.range.dateFrom}_${view.range.dateTo}`}
          dateFrom={view.range.dateFrom}
          dateTo={view.range.dateTo}
          today={today}
        />
        <SummaryCards summary={view.summary} />
        <DailyTable days={view.days} />
        <BatchTable batches={view.batches} />
      </div>
    </AdminShell>
  );
}
