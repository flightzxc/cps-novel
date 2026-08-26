import {
  getAdminTaskDetail,
  listAdminTasks,
  listAdminTaskItems,
  listManualReviews,
} from "@/server/task-admin";
import type { TaskFamily } from "@/lib/tasks";

import { prisma } from "../../api/admin/_lib/deps";
import { AdminShell } from "../_components/admin-shell";
import { ContentCapabilityDenied } from "../novels/_components/content-states";
import { requireContentPage } from "../novels/_lib/content-page-guard";
import { sessionView } from "../_lib/page-guard";
import { ManualReviewSection } from "./_components/manual-review-section";
import { TaskDetailPanel } from "./_components/task-detail-panel";
import { TaskFilters } from "./_components/task-filters";
import { TasksTable } from "./_components/tasks-table";
import { LIST_LIMIT_NOTE, TASK_FAMILIES } from "./_lib/task-copy";

export const dynamic = "force-dynamic";

type SearchParams = {
  family?: string;
  status?: string;
  limit?: string;
  taskId?: string;
  taskFamily?: string;
  itemStatus?: string;
  itemLimit?: string;
  reviewLimit?: string;
};

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function isTaskFamily(value: string | undefined): value is TaskFamily {
  return value !== undefined && (TASK_FAMILIES as readonly string[]).includes(value);
}

/**
 * 任务运维中心 (PR-C5) — the read side for X9's task-admin API.
 *
 * Reads through `@/server/task-admin` directly, the same "one service, one
 * projection, no extra round trip" rationale `/novels` and `/tags` already
 * document — the `/api/admin/tasks/**` HTTP routes exist for the browser's
 * own client-side calls (the two mutations below), not for this render.
 *
 * All list/detail/item state lives in the URL (`family`, `status`, `limit`,
 * `taskId` + `taskFamily`, `itemStatus`, `itemLimit`) so a link to a specific
 * task's detail view is shareable and survives a refresh — same discipline
 * as `/novels?labelId=…` and `/tags`'s filters.
 */
export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const { context, granted } = await requireContentPage("/tasks", "task:manage");

  let tasks: Awaited<ReturnType<typeof listAdminTasks>> | null = null;
  let detail: Awaited<ReturnType<typeof getAdminTaskDetail>> | null = null;
  let items: Awaited<ReturnType<typeof listAdminTaskItems>> | null = null;
  let manualReviews: Awaited<ReturnType<typeof listManualReviews>> | null = null;

  const selectedTaskId = nonEmpty(params.taskId);
  const selectedFamily = nonEmpty(params.taskFamily);
  const rawItemStatus = nonEmpty(params.itemStatus);
  // `catalog_scan` items have no `skipped` status — the service rejects that
  // exact combination as `task_admin_invalid_request`. Rather than crash the
  // whole page to the error boundary over a stale/hand-edited URL, this
  // silently drops the filter; `TaskDetailPanel` renders the same fact back
  // to the operator so the drop is not silent to *them*.
  const itemStatus =
    selectedFamily === "catalog_scan" && rawItemStatus === "skipped" ? undefined : rawItemStatus;

  if (granted) {
    tasks = await listAdminTasks(prisma, context, {
      family: nonEmpty(params.family),
      status: nonEmpty(params.status),
      limit: nonEmpty(params.limit),
    });

    if (selectedTaskId && isTaskFamily(selectedFamily)) {
      detail = await getAdminTaskDetail(prisma, context, { family: selectedFamily, taskId: selectedTaskId });
      items = await listAdminTaskItems(prisma, context, {
        family: selectedFamily,
        taskId: selectedTaskId,
        status: itemStatus,
        limit: nonEmpty(params.itemLimit),
      });
    }

    manualReviews = await listManualReviews(prisma, context, { limit: nonEmpty(params.reviewLimit) });
  }

  const baseSearch = new URLSearchParams();
  if (params.family) baseSearch.set("family", params.family);
  if (params.status) baseSearch.set("status", params.status);
  if (params.limit) baseSearch.set("limit", params.limit);
  if (selectedTaskId) baseSearch.set("taskId", selectedTaskId);
  if (selectedFamily) baseSearch.set("taskFamily", selectedFamily);
  if (rawItemStatus) baseSearch.set("itemStatus", rawItemStatus);
  if (params.itemLimit) baseSearch.set("itemLimit", params.itemLimit);

  return (
    <AdminShell
      session={sessionView(context)}
      title="任务中心"
      description={
        tasks
          ? `最近 ${tasks.items.length} / 上限 ${tasks.limit} 条任务`
          : "统一查看 catalog_scan / channel_sync / generic 三类任务，重试失败项，裁决待人工审查的副作用意图。"
      }
    >
      {granted ? (
        <div className="space-y-6">
          <TaskFilters values={{ family: params.family, status: params.status, limit: params.limit }} />
          <p className="text-xs text-gray-500">{LIST_LIMIT_NOTE}</p>
          {tasks && (
            <TasksTable tasks={tasks.items} baseSearch={baseSearch} selectedTaskId={selectedTaskId} />
          )}

          {detail && items && (
            <TaskDetailPanel
              detail={detail}
              items={items.items}
              itemStatusValue={rawItemStatus}
              itemLimitValue={params.itemLimit}
              baseSearch={baseSearch}
            />
          )}

          {manualReviews && <ManualReviewSection reviews={manualReviews.items} />}
        </div>
      ) : (
        <ContentCapabilityDenied capability="task:manage" />
      )}
    </AdminShell>
  );
}
