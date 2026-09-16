import Link from "next/link";

import { isArticleGenerateBatchTaskType } from "@/domain/article-generation";
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
import { TaskControlButtons } from "../_components/task-control-buttons";
import {
  isRetryableTaskStatus,
  isTerminalTaskStatus,
  articleAdmissionBlockedReasons,
  catalogBatchBlockedReasons,
  catalogBatchPhaseLabel,
  shouldDropSkippedFilterForTaskType,
  taskControlKindLabel,
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
  /**
   * C-12 (`施工工单_C12_目录任务计量口径改为本_2026-09-07.md`): once the
   * task's book counts are derivable, the summary cards and the static
   * progress bar below switch to "本" (book) units — `detail.totalCount`/
   * `successCount`/`failedCount`/`percent` above stay exactly as they were
   * (page-denominated, Phase C's frozen task shape) and are still what
   * renders when `bookCounts` is undefined — "before catalogObservedTotal is
   * known, fall back to the current page-based display" (work order §二).
   */
  const bookCounts = detail.bookCounts;

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
                className={
                  detail.taskControl
                    ? `inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        detail.taskControl.kind === "system_hold"
                          ? "bg-red-100 text-red-800"
                          : "bg-amber-100 text-amber-800"
                      }`
                    : "inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-800"
                }
                data-testid="task-detail-status-badge"
              >
                {detail.taskControl ? taskControlKindLabel(detail.taskControl.kind) : taskStatusLabel(detail.status)}
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
            {/*
              X10 task control: distinguishes 人工暂停/人工中止 (who/when,
              from an admin identity id + timestamp) from 系统保护停止 (the
              failure-class reason code) — never rendered for a `disabled`
              row from any of this codebase's three pre-existing, unrelated
              reasons (legacy out-of-band, feature-flag-off-at-creation,
              catalog-batch double-gate), since `detail.taskControl` is
              absent for all three.
            */}
            {detail.taskControl && (
              <p className="mt-1 text-xs text-gray-600" data-testid="task-control-detail">
                {detail.taskControl.source === "manual" ? (
                  <>
                    操作人：{detail.taskControl.actorId ?? "未知"} · 时间：{formatDateTime(detail.taskControl.at)}
                    {detail.taskControl.reason && <>· 原因：{detail.taskControl.reason}</>}
                  </>
                ) : (
                  <>
                    系统于 {formatDateTime(detail.taskControl.at)} 自动停止
                    {detail.taskControl.reasonCode && <>，原因：{detail.taskControl.reasonCode}（批次级系统性故障，非个别子项问题）</>}
                  </>
                )}
                {typeof detail.taskControl.terminatedPendingItemCount === "number" && (
                  <>（已将 {detail.taskControl.terminatedPendingItemCount} 个待处理子项标记为跳过）</>
                )}
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-2">
            <TaskControlButtons
              family={detail.family}
              taskId={detail.taskId}
              status={detail.status}
            />
            {isRetryableTaskStatus(detail.status) && !detail.catalogBatch && detail.failedCount > 0 && (
              <RetryFailedButton family={detail.family} taskId={detail.taskId} failedCount={detail.failedCount} />
            )}
          </div>
        </div>

        {/* 汇总卡片 */}
        {detail.articleAdmission && (
          <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 shadow-sm" data-testid="article-admission-summary">
            <h2 className="font-medium text-amber-950">Article 生成准入</h2>
            <p className="mt-1 text-sm text-amber-900">
              已选 {detail.articleAdmission.selectedCount.toLocaleString("zh-CN")} 条；
              已提交 {detail.articleAdmission.submittedCount.toLocaleString("zh-CN")} 条；
              准入阻断 {detail.articleAdmission.blockedCount.toLocaleString("zh-CN")} 条。
            </p>
            {articleAdmissionBlockedReasons(detail.articleAdmission.blockedReasonCounts).map((reason) => (
              <span key={reason} className="mr-3 mt-1 inline-block text-sm text-amber-900">{reason}</span>
            ))}
          </section>
        )}
        {detail.catalogBatch && (
          <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <h2 className="font-medium text-gray-900">批量任务进度</h2>
            <p className="mt-1 text-sm text-gray-600">
              阶段：{catalogBatchPhaseLabel(detail.catalogBatch.phase)}。
              {!isArticleGenerateBatchTaskType(detail.taskType) && <>
                已提交 {detail.catalogBatch.submittedCount?.toLocaleString("zh-CN") ?? "正在统计"} 条；
                已纳入 {detail.catalogBatch.alreadyLinkedCount?.toLocaleString("zh-CN") ?? "—"} 条；
                状态不符合／未找到 {detail.catalogBatch.ineligibleCount?.toLocaleString("zh-CN") ?? "正在统计"} 条。
              </>}
            </p>
            {(detail.catalogBatch.blockedCount ?? 0) > 0 && (
              <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900" data-testid="catalog-batch-blocked-explanation">
                部分条目未提交（{detail.catalogBatch.blockedCount} 条）。
                {catalogBatchBlockedReasons(detail.catalogBatch.blockedReasonCounts).map((reason) => (
                  <span key={reason} className="ml-2">{reason}</span>
                ))}
              </div>
            )}
            {(detail.catalogBatch.childTasks?.length ?? 0) > 0 && (
              <ul className="mt-3 space-y-2 text-sm" data-testid="catalog-batch-child-tasks">
                {detail.catalogBatch.childTasks?.map((child) => (
                  <li key={child.taskId} className="flex items-center justify-between rounded border border-gray-100 px-3 py-2">
                    <span>{child.taskType} · {taskStatusLabel(child.status)}</span>
                    <Link href={`/tasks/${child.taskId}?family=generic`} className="text-blue-700 underline">查看子任务</Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        {bookCounts ? (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <p className="text-xs text-gray-400">总计（本）</p>
              <p className="mt-1 text-2xl font-bold text-gray-900">{bookCounts.upstreamTotal.toLocaleString("zh-CN")}</p>
            </div>
            <div className="rounded-xl border border-green-100 bg-green-50/50 p-4 shadow-sm">
              <p className="text-xs text-green-600">成功（本）</p>
              <p className="mt-1 text-2xl font-bold text-green-700">{bookCounts.fetched.toLocaleString("zh-CN")}</p>
            </div>
            <div className="rounded-xl border border-red-100 bg-red-50/50 p-4 shadow-sm">
              <p className="text-xs text-red-600">失败（本）</p>
              <p className="mt-1 text-2xl font-bold text-red-700">{bookCounts.failedBooks.toLocaleString("zh-CN")}</p>
            </div>
            <div className="rounded-xl border border-blue-100 bg-blue-50/50 p-4 shadow-sm">
              <p className="text-xs text-blue-600">完成度</p>
              <p className="mt-1 text-2xl font-bold text-blue-700">{bookCounts.percent}%</p>
            </div>
          </div>
        ) : (
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
        )}

        {/* 非终态时的实时进度轮询（Phase C 移植的 ImportProgress） */}
        {!isTerminal && (
          <div className="rounded-xl border border-blue-100 bg-white p-5 shadow-sm">
            <p className="mb-4 text-sm font-medium text-gray-700">实时进度</p>
        <TaskDetailProgress taskId={detail.taskId} materializing={detail.catalogBatch?.phase === "materializing" || detail.catalogBatch?.phase === "queued"} />
          </div>
        )}

        {/* 总进度条（终态时展示最终结果） */}
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium text-gray-700">任务进度</p>
            <p className="text-xs text-gray-400">
              {bookCounts
                ? `${(bookCounts.fetched + bookCounts.failedBooks).toLocaleString("zh-CN")} / ${bookCounts.upstreamTotal.toLocaleString("zh-CN")} 本`
                : `${processed} / ${detail.totalCount}`}
            </p>
          </div>
          <div className="h-3 overflow-hidden rounded-full bg-gray-100">
            <div className="flex h-full">
              {bookCounts ? (
                <>
                  {bookCounts.upstreamTotal > 0 && bookCounts.fetched > 0 && (
                    <div
                      className="h-full bg-green-500 transition-all"
                      style={{ width: `${(bookCounts.fetched / bookCounts.upstreamTotal) * 100}%` }}
                    />
                  )}
                  {bookCounts.upstreamTotal > 0 && bookCounts.failedBooks > 0 && (
                    <div
                      className="h-full bg-red-400 transition-all"
                      style={{ width: `${(bookCounts.failedBooks / bookCounts.upstreamTotal) * 100}%` }}
                    />
                  )}
                </>
              ) : (
                <>
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
                </>
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
