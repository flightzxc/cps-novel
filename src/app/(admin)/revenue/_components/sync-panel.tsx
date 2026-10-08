import Link from "next/link";

import type { RevenueDashboardView } from "@/server/revenue";

import { isStalePendingTask, shortTaskId } from "../_lib/active-task";
import { activeTaskStatusLabel, WORKER_CLAIM_WARNING, WORKER_CLAIM_WARNING_DETAIL } from "../_lib/copy";
import { REVENUE_SYNC_DEFAULT_DAYS, trailingRange } from "../_lib/dates";
import { SyncForm } from "./sync-form";

/**
 * 「发起同步」面板（server 组件）：说明 + 活跃任务状态 + 表单。
 *
 * 活跃任务（pending / processing）存在时，表单按钮禁用，并把那条任务摆出来（链到任务中心）。
 * 若它是 `pending` 且创建超过 10 分钟——这是"没有 worker 认领"唯一的可见信号：
 * 任务类型漏配进主通道 `WORKER_TASK_ALLOWLIST` 时不会有任何告警，只会一直排队并挡住后续所有入队。
 * 所以这里必须明说，而不是让按钮静默地一直点不动。
 *
 * 判定放在这个 server 组件里（`nowMs` 由页面传入，同一次渲染内一致，也避免 client 水合时间漂移）。
 */
export function SyncPanel({
  account,
  activeTask,
  today,
  nowMs,
}: {
  account: RevenueDashboardView["account"];
  activeTask: RevenueDashboardView["activeTask"];
  today: string;
  nowMs: number;
}) {
  const defaults = trailingRange(today, REVENUE_SYNC_DEFAULT_DAYS);
  const stale = activeTask ? isStalePendingTask(activeTask, nowMs) : false;

  return (
    <section
      aria-labelledby="revenue-sync-heading"
      data-testid="revenue-sync-panel"
      className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
    >
      <h2 id="revenue-sync-heading" className="text-sm font-semibold text-gray-900">
        发起同步
      </h2>
      <p className="mt-1 text-xs text-gray-500">
        只能手动触发，由主 worker 执行；只会向上游发起只读查询。使用「渠道账户」页里启用中的达人凭证（每周需要续期）。
        上游会回补最近几天的数据，建议每次至少同步最近 {REVENUE_SYNC_DEFAULT_DAYS} 天。
      </p>

      {activeTask && (
        <div className="mt-3 space-y-2" data-testid="revenue-active-task">
          <p className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
            已有同步任务{activeTaskStatusLabel(activeTask.status)}（
            <Link href={`/tasks/${activeTask.id}`} title={activeTask.id} className="font-mono font-medium underline">
              任务 #{shortTaskId(activeTask.id)}
            </Link>
            ），完成前不能再发起新的同步。
          </p>
          {stale && (
            <div
              role="alert"
              data-testid="revenue-worker-claim-warning"
              className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
            >
              <p className="font-medium">{WORKER_CLAIM_WARNING}</p>
              <p className="mt-1 text-xs">{WORKER_CLAIM_WARNING_DETAIL}</p>
            </div>
          )}
        </div>
      )}

      {!account && (
        <p
          role="status"
          data-testid="revenue-sync-no-account"
          className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          没有唯一可用的海阅渠道账号，暂时不能发起同步。
        </p>
      )}

      <div className="mt-3">
        <SyncForm
          today={today}
          defaultBegin={defaults.dateFrom}
          defaultEnd={defaults.dateTo}
          blocked={Boolean(activeTask) || !account}
        />
      </div>
    </section>
  );
}
