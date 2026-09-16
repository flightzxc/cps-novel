"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { buttonClassName } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { TaskFamily } from "@/lib/tasks";
import { adminFetch } from "@/features/admin-ui/admin-fetch";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";

import type { TaskControlSummary } from "../_lib/task-copy";

type ControlAction = "pause" | "resume" | "abort";

type ControlResult = {
  readonly family: TaskFamily;
  readonly taskId: string;
  readonly status: string;
  readonly wrote: boolean;
  readonly auditId: string;
};

const ENDPOINTS: Readonly<Record<ControlAction, string>> = Object.freeze({
  pause: "/api/admin/tasks/pause",
  resume: "/api/admin/tasks/resume",
  abort: "/api/admin/tasks/abort",
});

const DIALOG_COPY: Readonly<Record<ControlAction, { title: string; confirmLabel: string; body: string }>> = Object.freeze({
  pause: {
    title: "暂停任务",
    confirmLabel: "确认暂停",
    body: "确认暂停该任务？Worker 将停止领取新的子项，当前正在处理的子项会正常跑完，其余待处理子项原样保留（不会被跳过），可随时恢复。",
  },
  resume: {
    title: "恢复任务",
    confirmLabel: "确认恢复",
    body: "确认恢复该任务？系统会先重新校验前置条件（例如渠道凭据是否仍然可用），通过后任务会从剩余待处理子项继续执行。",
  },
  abort: {
    title: "中止任务",
    confirmLabel: "确认中止",
    body: "确认中止该任务？此操作不可恢复：Worker 将停止领取新的子项，当前正在处理的子项会正常跑完，其余待处理子项会被标记为已跳过。已成功/已失败的子项历史不受影响、不会被改写。",
  },
});

/**
 * Ported from CPS `src/components/task-control-buttons.tsx` (v8.5.1) — same
 * three actions, same confirm-then-mutate shape as this file's own
 * `RetryFailedButton`. Two differences from CPS's version:
 *
 *  1. Abort here is a real terminal action with its own confirm copy that
 *     says still-pending items are terminated (`skipped`), not merely
 *     "cannot be undone" — CPS's cancel route never actually terminates
 *     them, which is exactly the gap that left 95,860 rows orphaned here.
 *  2. Resume's confirm copy calls out the precondition recheck explicitly,
 *     since it can refuse with `task_admin_precondition_failed` — a
 *     concept CPS's own resume route does not have.
 */
export function TaskControlButtons({
  family,
  taskId,
  status,
  taskControl,
}: {
  family: TaskFamily;
  taskId: string;
  status: string;
  taskControl?: TaskControlSummary;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<ControlAction | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isActive = status === "pending" || status === "processing";
  const isPausedByUs = status === "disabled" && taskControl?.kind === "paused";
  const canPause = isActive;
  const canResume = isPausedByUs;
  const canAbort = isActive || isPausedByUs;

  if (!canPause && !canResume && !canAbort) return null;

  function openDialog(action: ControlAction) {
    setErrorMessage(null);
    setReason("");
    setOpen(action);
  }

  async function submit(action: ControlAction) {
    setBusy(true);
    setErrorMessage(null);
    const body: Record<string, unknown> = { family, taskId };
    if (action !== "resume") body.reason = reason.trim() === "" ? undefined : reason.trim();
    const outcome = await adminFetch<ControlResult>(ENDPOINTS[action], { method: "POST", body });
    setBusy(false);
    if (!outcome.ok) {
      setErrorMessage(errorEnvelopeCopy(outcome.envelope));
      return;
    }
    setOpen(null);
    router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        {canPause && (
          <button
            type="button"
            onClick={() => openDialog("pause")}
            className={buttonClassName("secondary")}
            data-testid="task-pause-open"
          >
            暂停
          </button>
        )}
        {canResume && (
          <button
            type="button"
            onClick={() => openDialog("resume")}
            className={buttonClassName("secondary")}
            data-testid="task-resume-open"
          >
            恢复
          </button>
        )}
        {canAbort && (
          <button
            type="button"
            onClick={() => openDialog("abort")}
            className={buttonClassName("danger")}
            data-testid="task-abort-open"
          >
            中止
          </button>
        )}
      </div>

      {errorMessage && !open && (
        <p role="alert" data-testid="task-control-error" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {errorMessage}
        </p>
      )}

      {(["pause", "resume", "abort"] as const).map((action) => (
        <ConfirmDialog
          key={action}
          open={open === action}
          pending={busy}
          title={DIALOG_COPY[action].title}
          confirmLabel={DIALOG_COPY[action].confirmLabel}
          confirmVariant={action === "abort" ? "danger" : "secondary"}
          body={
            <div className="space-y-3">
              <p>{DIALOG_COPY[action].body}</p>
              {action !== "resume" && (
                <textarea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="操作原因（可选，会写入审计记录）"
                  rows={2}
                  maxLength={2000}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  data-testid={`task-${action}-reason`}
                />
              )}
              {errorMessage && (
                <p role="alert" data-testid="task-control-dialog-error" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                  {errorMessage}
                </p>
              )}
            </div>
          }
          onCancel={() => {
            if (busy) return;
            setOpen(null);
            setErrorMessage(null);
          }}
          onConfirm={() => void submit(action)}
        />
      ))}
    </div>
  );
}
