import {
  listAdminTasks,
  listManualReviews,
} from "@/server/task-admin";

import { prisma } from "../../api/admin/_lib/deps";
import { AdminShell } from "../_components/admin-shell";
import { ContentCapabilityDenied } from "../novels/_components/content-states";
import { requireContentPage } from "../novels/_lib/content-page-guard";
import { sessionView } from "../_lib/page-guard";
import { ManualReviewSection } from "./_components/manual-review-section";
import { TaskFilters } from "./_components/task-filters";
import { TasksTable } from "./_components/tasks-table";
import { LIST_LIMIT_NOTE } from "./_lib/task-copy";

export const dynamic = "force-dynamic";

type SearchParams = {
  family?: string;
  status?: string;
  limit?: string;
  reviewLimit?: string;
};

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

/**
 * 任务运维中心 (PR-C5) — the read side for X9's task-admin API.
 *
 * Reads through `@/server/task-admin` directly, the same "one service, one
 * projection, no extra round trip" rationale `/novels` and `/tags` already
 * document — the `/api/admin/tasks/**` HTTP routes exist for the browser's
 * own client-side calls (the retry mutation below), not for this render.
 *
 * C-9 (`施工工单_C9_任务详情独立路由对齐CPS_2026-09-07.md`): task detail moved
 * off this page onto its own route, `/tasks/<taskId>` — CPS parity, full-page
 * navigation instead of a same-page panel appended below a long list an
 * operator could scroll past without noticing. This page's own URL state is
 * now only ever this list's filters (`family`/`status`/`limit`); the old
 * `taskId`/`taskFamily`/`itemStatus`/`itemLimit` state (and the
 * `baseSearch` plumbing that carried it into the panel) moved with the
 * panel onto the new route's own `?status=`/`?page=`.
 */
export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const { context, granted } = await requireContentPage("/tasks", "task:manage");

  let tasks: Awaited<ReturnType<typeof listAdminTasks>> | null = null;
  let manualReviews: Awaited<ReturnType<typeof listManualReviews>> | null = null;

  if (granted) {
    tasks = await listAdminTasks(prisma, context, {
      family: nonEmpty(params.family),
      status: nonEmpty(params.status),
      limit: nonEmpty(params.limit),
    });

    manualReviews = await listManualReviews(prisma, context, { limit: nonEmpty(params.reviewLimit) });
  }

  return (
    <AdminShell
      session={sessionView(context)}
      title="任务中心"
      description={
        tasks
          ? `最近 ${tasks.items.length} / 上限 ${tasks.limit} 条任务`
          : "统一查看 channel_sync / generic 两类任务，重试失败项，裁决待人工审查的副作用意图。"
      }
    >
      {granted ? (
        <div className="space-y-6">
          <TaskFilters values={{ family: params.family, status: params.status, limit: params.limit }} />
          <p className="text-xs text-gray-500">{LIST_LIMIT_NOTE}</p>
          {tasks && <TasksTable tasks={tasks.items} />}

          {manualReviews && <ManualReviewSection reviews={manualReviews.items} />}
        </div>
      ) : (
        <ContentCapabilityDenied capability="task:manage" />
      )}
    </AdminShell>
  );
}
