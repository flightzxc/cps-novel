import Link from "next/link";
import { notFound } from "next/navigation";

import { buttonClassName } from "@/components/ui/button";
import { taskStatusLabel } from "@/features/admin-ui/content-view";
import { formatDateTime } from "@/features/admin-ui/datetime";
import { AdminTimeZoneNote } from "@/features/admin-ui/time-zone-note";
import type { TaskFamily } from "@/lib/tasks";
import {
  getAdminTaskDetail,
  listAdminTaskItems,
  TaskAdminError,
  type TaskDetailDto,
} from "@/server/task-admin";
import type { AdminAuthContext } from "@/lib/auth/types";

import { prisma } from "../../../api/admin/_lib/deps";
import { AdminShell } from "../../_components/admin-shell";
import { ContentCapabilityDenied } from "../../novels/_components/content-states";
import { requireContentPage } from "../../novels/_lib/content-page-guard";
import { sessionView } from "../../_lib/page-guard";
import { RetryFailedButton } from "../_components/retry-failed-button";
import {
  isRetryableTaskStatus,
  isTerminalTaskStatus,
  shouldDropSkippedFilterForTaskType,
  taskFamilyLabel,
} from "../_lib/task-copy";
import { TaskConfigSummary } from "./_components/task-config-summary";
import { TaskDetailProgress } from "./_components/task-detail-progress";
import { TaskItemsSection, type TaskDetailItemRow } from "./_components/task-items-section";

export const dynamic = "force-dynamic";

type SearchParams = { family?: string; status?: string; page?: string };

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function isTaskFamily(value: string | undefined): value is TaskFamily {
  return value === "generic" || value === "channel_sync";
}

/**
 * Probes `generic` then `channel_sync` (same order `getAdminTaskProgress`
 * already uses in `src/server/task-admin/progress.ts` — both families'
 * ids are server-generated UUIDs from independent sequences, so trying one
 * table and falling back to the other is a correct, never-ambiguous lookup).
 * An `?family=` hint just tries that family first, so a link straight off
 * `/tasks`'s table skips the wasted first query; it is never required for
 * the page to resolve — a bare `/tasks/<id>` still works.
 */
async function resolveTaskDetail(
  context: AdminAuthContext,
  taskId: string,
  familyHint: string | undefined,
): Promise<TaskDetailDto | null> {
  const defaultOrder: readonly TaskFamily[] = ["generic", "channel_sync"];
  const order: readonly TaskFamily[] = isTaskFamily(familyHint)
    ? [familyHint, ...defaultOrder.filter((family) => family !== familyHint)]
    : defaultOrder;
  for (const family of order) {
    try {
      return await getAdminTaskDetail(prisma, context, { family, taskId });
    } catch (error) {
      if (error instanceof TaskAdminError
        && (error.code === "task_admin_not_found" || error.code === "task_admin_invalid_request")) {
        continue;
      }
      throw error;
    }
  }
  return null;
}

/**
 * C-9 (`施工工单_C9_任务详情独立路由对齐CPS_2026-09-07.md`): `/tasks/<taskId>`,
 * a CPS-parity independent route replacing the old same-page detail panel
 * (`_components/task-detail-panel.tsx`, removed) — full-page navigation
 * instead of a panel appended below a long list the operator could easily
 * miss. Reads through `@/server/task-admin` directly, the same "one
 * service, one projection, no extra HTTP round trip" discipline `/tasks`
 * and `/novels` already document.
 */
export default async function TaskDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id: taskId } = await params;
  const query = await searchParams;
  const { context, granted } = await requireContentPage("/tasks/[id]", "task:manage");

  if (!granted) {
    return (
      <AdminShell session={sessionView(context)} title="任务详情">
        <ContentCapabilityDenied capability="task:manage" />
      </AdminShell>
    );
  }

  const detail = await resolveTaskDetail(context, taskId, nonEmpty(query.family));
  if (!detail) notFound();

  const rawStatus = nonEmpty(query.status);
  const dropSkipped = shouldDropSkippedFilterForTaskType(detail.taskType, rawStatus);
  const itemStatus = dropSkipped ? undefined : rawStatus;
  const page = Math.max(1, Number(query.page) || 1);

  const [items, channelAccount] = await Promise.all([
    listAdminTaskItems(prisma, context, {
      family: detail.family,
      taskId: detail.taskId,
      status: itemStatus,
      page,
    }),
    detail.channelAccountId
      ? prisma.channelAccount.findUnique({
          where: { id: detail.channelAccountId },
          select: { id: true, businessId: true, accountName: true },
        })
      : Promise.resolve(null),
  ]);

  const isTerminal = isTerminalTaskStatus(detail.status);
  const processed = detail.successCount + detail.failedCount + detail.skippedCount;
  const percent = detail.totalCount > 0 ? Math.round((processed / detail.totalCount) * 100) : 0;
  const isCatalogScan = detail.taskType === "catalog_scan";
  const countUnit = isCatalogScan ? "页" : "";

  const itemRows: readonly TaskDetailItemRow[] = items.items;

  return (
    <AdminShell
      session={sessionView(context)}
      title={`任务详情 · ${detail.taskType}`}
      actions={
        <Link href="/tasks" className={buttonClassName("secondary")}>
          返回列表
        </Link>
      }
    >
      <div className="space-y-6">
        {/* 面包屑 */}
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Link href="/tasks" className="hover:text-blue-600">
            任务中心
          </Link>
          <span>/</span>
          <span className="text-gray-600">任务详情 #{detail.taskId}</span>
        </div>

        {/* 标题 + 状态徽标 + 账号标签 */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-lg font-bold text-gray-900">
                {taskFamilyLabel(detail.family)} · {detail.taskType}
              </h1>
              <span
                className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-800"
                data-testid="task-detail-status-badge"
              >
                {taskStatusLabel(detail.status)}
              </span>
            </div>
            <p className="mt-1 font-mono text-xs text-gray-500">{detail.taskId}</p>
            <p className="mt-1 text-xs text-gray-500">
              创建于 {formatDateTime(detail.createdAt)}
              {detail.updatedAt && detail.updatedAt !== detail.createdAt && (
                <>，更新于 {formatDateTime(detail.updatedAt)}</>
              )}
            </p>
            {detail.channelAccountId && (
              <p className="mt-1 text-xs text-blue-600" data-testid="task-detail-account-label">
                账号：
                {channelAccount
                  ? `${channelAccount.accountName}（Business ID: ${channelAccount.businessId}）`
                  : `#${detail.channelAccountId}（账号已不存在或已被删除）`}
              </p>
            )}
          </div>
          {isRetryableTaskStatus(detail.status) && (
            <RetryFailedButton family={detail.family} taskId={detail.taskId} />
          )}
        </div>

        {/* 汇总卡片 */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <p className="text-xs text-gray-400">总计{countUnit ? `（${countUnit}）` : ""}</p>
            <p className="mt-1 text-2xl font-bold text-gray-900">{detail.totalCount}</p>
          </div>
          <div className="rounded-xl border border-green-100 bg-green-50/50 p-4 shadow-sm">
            <p className="text-xs text-green-600">成功{countUnit ? `（${countUnit}）` : ""}</p>
            <p className="mt-1 text-2xl font-bold text-green-700">{detail.successCount}</p>
          </div>
          <div className="rounded-xl border border-yellow-100 bg-yellow-50/50 p-4 shadow-sm">
            <p className="text-xs text-yellow-600">跳过{countUnit ? `（${countUnit}）` : ""}</p>
            <p className="mt-1 text-2xl font-bold text-yellow-700">{detail.skippedCount}</p>
          </div>
          <div className="rounded-xl border border-red-100 bg-red-50/50 p-4 shadow-sm">
            <p className="text-xs text-red-600">失败{countUnit ? `（${countUnit}）` : ""}</p>
            <p className="mt-1 text-2xl font-bold text-red-700">{detail.failedCount}</p>
          </div>
          <div className="rounded-xl border border-blue-100 bg-blue-50/50 p-4 shadow-sm">
            <p className="text-xs text-blue-600">完成度</p>
            <p className="mt-1 text-2xl font-bold text-blue-700">{percent}%</p>
          </div>
        </div>

        {/* 非终态时的实时进度轮询（Phase C 移植的 ImportProgress） */}
        {!isTerminal && (
          <div className="rounded-xl border border-blue-100 bg-white p-5 shadow-sm">
            <p className="mb-4 text-sm font-medium text-gray-700">实时进度</p>
            <TaskDetailProgress taskId={detail.taskId} />
          </div>
        )}

        {/* 总进度条（终态时展示最终结果） */}
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium text-gray-700">任务进度</p>
            <p className="text-xs text-gray-400">
              {processed} / {detail.totalCount}
            </p>
          </div>
          <div className="h-3 overflow-hidden rounded-full bg-gray-100">
            <div className="flex h-full">
              {detail.totalCount > 0 && detail.successCount > 0 && (
                <div
                  className="h-full bg-green-500 transition-all"
                  style={{ width: `${(detail.successCount / detail.totalCount) * 100}%` }}
                />
              )}
              {detail.totalCount > 0 && detail.skippedCount > 0 && (
                <div
                  className="h-full bg-yellow-400 transition-all"
                  style={{ width: `${(detail.skippedCount / detail.totalCount) * 100}%` }}
                />
              )}
              {detail.totalCount > 0 && detail.failedCount > 0 && (
                <div
                  className="h-full bg-red-400 transition-all"
                  style={{ width: `${(detail.failedCount / detail.totalCount) * 100}%` }}
                />
              )}
            </div>
          </div>
        </div>

        {/* 任务配置摘要 + 目录扫描审计 */}
        <TaskConfigSummary
          mode={detail.mode}
          catalogScanConfig={detail.catalogScanConfig}
          catalogScanAudit={detail.catalogScanAudit}
          stopReason={detail.stopReason}
          originStopReason={detail.originStopReason}
        />

        <AdminTimeZoneNote />

        {/* 子项表：状态页签 + 分页 */}
        <TaskItemsSection
          taskId={detail.taskId}
          familyHint={detail.family}
          taskType={detail.taskType}
          items={itemRows}
          statusValue={rawStatus}
          page={items.page ?? page}
          total={items.total ?? 0}
          totalPages={items.totalPages ?? 1}
        />
      </div>
    </AdminShell>
  );
}
