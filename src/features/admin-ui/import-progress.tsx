"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * C-6 (`施工工单_PhaseC_任务模型迁移与ImportProgress_2026-09-06.md`
 * §三/ImportProgress 移植): direct port of CPS's `ImportProgress`
 * (`src/components/import-progress.tsx` in the read-only CPS reference,
 * `/Users/chenweifeng/Documents/产品原型及文档/cps项目/cps-admin-v851-admin-host`).
 *
 * Only two adaptations from the reference, both spelled out in the work
 * order:
 * - `taskId` is a UUID string here, not a CPS-style autoincrement number
 *   (also flows through to `CurrentItem`/`items[].id`, which are UUID
 *   strings too — GenericTaskItem/ChannelSyncTaskItem have no numeric id).
 * - `currentItem` carries `targetType`/`targetId`/`message` instead of
 *   CPS's `dramaId`/`dramaName`/`templateId`/`templateName` — this app's
 *   task items address a page number or a NovelSourceItem, not a Drama —
 *   see `src/server/task-admin/progress.ts` for where `message` is built.
 *
 * Everything else (polling cadence, terminal detection, status badges, the
 * progress bar, the four-stat grid, the expandable failure list, the
 * pending-hint threshold) is unchanged from the reference on purpose — this
 * is a port, not a redesign.
 */

export interface ImportProgressProps {
  taskId: string;
  onTerminal?: () => void;
}

interface CurrentItem {
  targetType: string;
  targetId: string;
  status: "processing";
  message: string;
}

interface ProgressData {
  taskType?: string;
  status:
    | "pending"
    | "processing"
    | "completed"
    | "partial_failed"
    | "failed"
    | "paused"
    | "cancelled";
  total: number;
  success: number;
  failed: number;
  skip: number;
  processed?: number;
  percent?: number;
  createdAt?: string;
  updatedAt?: string;
  taskErrors?: string[];
  currentItem?: CurrentItem;
  items?: {
    id: string;
    status: "pending" | "processing" | "success" | "skipped" | "failed";
    errorMessage: string;
    createdAt: string;
  }[];
}

const STATUS_CONFIG: Record<
  string,
  { label: string; color: string; bg: string; border: string }
> = {
  pending: {
    label: "等待中",
    color: "text-amber-700",
    bg: "bg-amber-50",
    border: "border-amber-200",
  },
  processing: {
    label: "处理中",
    color: "text-blue-700",
    bg: "bg-blue-50",
    border: "border-blue-200",
  },
  completed: {
    label: "已完成",
    color: "text-green-700",
    bg: "bg-green-50",
    border: "border-green-200",
  },
  partial_failed: {
    label: "部分失败",
    color: "text-amber-700",
    bg: "bg-amber-50",
    border: "border-amber-200",
  },
  failed: {
    label: "失败",
    color: "text-red-700",
    bg: "bg-red-50",
    border: "border-red-200",
  },
  paused: {
    label: "已暂停",
    color: "text-amber-700",
    bg: "bg-amber-50",
    border: "border-amber-200",
  },
  cancelled: {
    label: "已中止",
    color: "text-orange-700",
    bg: "bg-orange-50",
    border: "border-orange-200",
  },
};

export function ImportProgress({ taskId, onTerminal }: ImportProgressProps) {
  const pendingHintAfterMs = 15000;
  const [progress, setProgress] = useState<ProgressData>({
    status: "pending",
    total: 0,
    success: 0,
    failed: 0,
    skip: 0,
    taskErrors: [],
  });
  const [showErrors, setShowErrors] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // Captured at each poll tick (never read via a direct `Date.now()` call in
  // the render body -- see `taskAgeMs` below) so the "still pending" hint's
  // age comparison stays a pure function of state.
  const [lastPolledAt, setLastPolledAt] = useState<number>(() => Date.now());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const terminalNotifiedRef = useRef(false);
  const onTerminalRef = useRef(onTerminal);

  useEffect(() => {
    onTerminalRef.current = onTerminal;
  }, [onTerminal]);

  const fetchProgress = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/tasks/progress?taskId=${encodeURIComponent(taskId)}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: ProgressData = await res.json();
      setProgress(data);
      setFetchError(null);
      setLastPolledAt(Date.now());

      // Stop polling when terminal state
      if (
        data.status === "completed" ||
        data.status === "partial_failed" ||
        data.status === "failed" ||
        data.status === "paused" ||
        data.status === "cancelled"
      ) {
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        if (!terminalNotifiedRef.current) {
          terminalNotifiedRef.current = true;
          onTerminalRef.current?.();
        }
      }
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "获取进度失败");
    }
  }, [taskId]);

  useEffect(() => {
    terminalNotifiedRef.current = false;
    // Initial fetch, deferred exactly like the recurring ones below --
    // `react-hooks/set-state-in-effect` treats a bare synchronous call in
    // the effect body differently from one handed to a timer, even though
    // `fetchProgress` itself is async either way; scheduling both through
    // a timer keeps this effect a subscription (start/stop timers), not a
    // direct state write, with no change in when the first fetch actually
    // fires (0ms vs. immediate is not observable here).
    const kickoff = setTimeout(fetchProgress, 0);
    // Poll every 2 seconds
    timerRef.current = setInterval(fetchProgress, 2000);
    return () => {
      clearTimeout(kickoff);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetchProgress]);

  const {
    status,
    total,
    success,
    failed,
    skip,
    createdAt,
    items = [],
    taskErrors = [],
    currentItem,
  } = progress;
  const processed = progress.processed ?? success + failed + skip;
  const percent = progress.percent ?? (total > 0 ? Math.round((processed / total) * 100) : 0);
  const statusCfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.pending;
  const itemErrors = items.flatMap((item, index) =>
    item.status === "failed"
      ? [{ row: index + 1, message: item.errorMessage || "任务失败" }]
      : [],
  );
  const taskAgeMs = createdAt ? lastPolledAt - new Date(createdAt).getTime() : 0;
  const showPendingHint =
    status === "pending" && processed === 0 && taskAgeMs >= pendingHintAfterMs;
  const pendingHint = "任务长时间未开始处理，请确认 worker 已启动并订阅了该任务类型。";
  const progressBarClass =
    status === "failed"
      ? "bg-red-500"
      : status === "completed"
        ? "bg-green-500"
        : status === "partial_failed"
          ? "bg-amber-500"
          : status === "paused"
            ? "bg-amber-500"
            : status === "cancelled"
              ? "bg-orange-500"
              : status === "processing"
                ? "bg-blue-500"
                : "bg-slate-300";

  return (
    <div className="space-y-5">
      {/* Status badge + task ID */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span
            className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${statusCfg.bg} ${statusCfg.color} ${statusCfg.border}`}
          >
            {status === "processing" && (
              <svg className="mr-1.5 h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
            )}
            {statusCfg.label}
          </span>
          <span className="text-sm text-gray-500" data-testid="import-progress-task-id">
            任务 #{taskId}
          </span>
        </div>
        <span className="text-sm font-semibold text-gray-700">{percent}%</span>
      </div>

      {/* Progress bar */}
      <div className="relative h-3 w-full overflow-hidden rounded-full bg-gray-100">
        <div
          className={`h-full rounded-full transition-all duration-500 ease-out ${progressBarClass}`}
          style={{ width: `${percent}%` }}
        />
        {status === "processing" && (
          <div className="absolute inset-0 overflow-hidden rounded-full">
            <div className="h-full animate-pulse rounded-full bg-white/20" style={{ width: `${percent}%` }} />
          </div>
        )}
      </div>

      {/* 当前处理项文案（仅处理中且存在 currentItem 时显示）*/}
      {status === "processing" && currentItem && (
        <div className="flex items-center gap-2 rounded-lg border border-blue-100 bg-blue-50 px-4 py-2.5 text-sm text-blue-700">
          <svg className="h-4 w-4 flex-shrink-0 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          <span>{currentItem.message}</span>
        </div>
      )}

      {/* Stats grid */}
      <div className="grid grid-cols-4 gap-3">
        <div className="rounded-xl border border-gray-200 bg-white p-3 text-center">
          <div className="text-2xl font-bold text-gray-800">{total}</div>
          <div className="mt-0.5 text-xs text-gray-500">总计</div>
        </div>
        <div className="rounded-xl border border-green-200 bg-green-50 p-3 text-center">
          <div className="text-2xl font-bold text-green-700">{success}</div>
          <div className="mt-0.5 text-xs text-green-600">成功</div>
        </div>
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-center">
          <div className="text-2xl font-bold text-red-700">{failed}</div>
          <div className="mt-0.5 text-xs text-red-600">失败</div>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-center">
          <div className="text-2xl font-bold text-amber-700">{skip}</div>
          <div className="mt-0.5 text-xs text-amber-600">跳过</div>
        </div>
      </div>

      {/* Fetch error */}
      {fetchError && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <svg className="h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          轮询出错：{fetchError}
        </div>
      )}

      {showPendingHint && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {pendingHint}
        </div>
      )}

      {/* Error list (expandable) */}
      {(taskErrors.length > 0 || itemErrors.length > 0) && (
        <div className="overflow-hidden rounded-xl border border-red-200 bg-white">
          <button
            type="button"
            onClick={() => setShowErrors(!showErrors)}
            className="flex w-full items-center justify-between px-5 py-3 text-sm font-medium text-red-700 transition-colors hover:bg-red-50"
          >
            <span className="flex items-center gap-2">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {taskErrors.length + itemErrors.length} 条失败记录
            </span>
            <svg
              className={`h-4 w-4 transition-transform duration-200 ${showErrors ? "rotate-180" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {showErrors && (
            <div className="max-h-64 divide-y divide-red-50 overflow-y-auto border-t border-red-100">
              {taskErrors.map((message, idx) => (
                <div key={`task-error-${idx}`} className="flex items-start gap-3 px-5 py-3 text-sm">
                  <span className="flex-shrink-0 rounded bg-red-100 px-2 py-0.5 font-mono text-xs text-red-600">
                    任务
                  </span>
                  <span className="text-gray-700">{message}</span>
                </div>
              ))}
              {itemErrors.map((err, idx) => (
                <div key={`item-error-${idx}`} className="flex items-start gap-3 px-5 py-3 text-sm">
                  <span className="flex-shrink-0 rounded bg-red-100 px-2 py-0.5 font-mono text-xs text-red-600">
                    第 {err.row} 项
                  </span>
                  <span className="text-gray-700">{err.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
