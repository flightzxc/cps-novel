"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { buttonClassName } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { TaskFamily } from "@/lib/tasks";
import { adminFetch } from "@/features/admin-ui/admin-fetch";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";

type RetryFailedTaskResult = {
  readonly family: TaskFamily;
  readonly taskId: string;
  readonly status: "pending";
  readonly retriedItemCount: number;
  readonly totalCount: number;
  readonly successCount: number;
  readonly failedCount: number;
  readonly skippedCount: number;
  readonly wrote: boolean;
  readonly auditId: string;
};

/**
 * "重试失败项" — `POST /api/admin/tasks/retry-failed`.
 *
 * Only ever rendered by the caller when the task's own status is `failed` or
 * `completed_with_errors` (`isRetryableTaskStatus`, `_lib/task-copy.ts`) —
 * anything else is a guaranteed `task_admin_state_conflict` from the server,
 * so this component does not re-derive that gate, it trusts the caller the
 * same way `PublishLifecyclePanel` trusts its own visibility booleans.
 *
 * `reason` is required (`boundedText` in the service rejects an empty
 * string as `task_admin_invalid_request`) and is written into
 * `OperationAudit.reason` — same discipline as the publish/withdraw/takedown
 * confirm dialogs.
 */
export function RetryFailedButton({ family, taskId }: { family: TaskFamily; taskId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [result, setResult] = useState<RetryFailedTaskResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function submit() {
    const trimmed = reason.trim();
    if (!trimmed) {
      setReasonError("请填写重试原因后再提交（会写入审计记录）。");
      return;
    }
    setReasonError(null);
    setBusy(true);
    setErrorMessage(null);
    const outcome = await adminFetch<RetryFailedTaskResult>("/api/admin/tasks/retry-failed", {
      method: "POST",
      body: { family, taskId, reason: trimmed },
    });
    setBusy(false);
    setOpen(false);
    setReason("");
    if (!outcome.ok) {
      setErrorMessage(errorEnvelopeCopy(outcome.envelope));
      setResult(null);
      return;
    }
    setResult(outcome.data);
    setErrorMessage(null);
    router.refresh();
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => {
          setReasonError(null);
          setOpen(true);
        }}
        className={buttonClassName("secondary")}
        data-testid="retry-failed-open"
      >
        重试失败项
      </button>

      {errorMessage && (
        <p role="alert" data-testid="retry-failed-error" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {errorMessage}
        </p>
      )}

      {result && (
        <p
          role="status"
          data-testid="retry-failed-result"
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          已将 {result.retriedItemCount} 个失败子项重置为 pending，任务状态回到 pending，等待下一轮调度重试。
          {result.wrote === false && "（这是对同一请求标识的重复提交，本次未再次写入，返回的是首次执行的结果。）"}
        </p>
      )}

      <ConfirmDialog
        open={open}
        pending={busy}
        title="重试失败项"
        confirmLabel="确认重试"
        confirmVariant="secondary"
        body={
          <>
            <p>
              只会把当前处于 failed 的子项重置为 pending 并重新计数；已成功或已跳过的子项不受影响。
              如果这个任务还挂着未裁决的人工审查项，本次提交会被拒绝——需要先去下方&ldquo;人工审查区&rdquo;裁决。
            </p>
            <label className="block">
              <span className="mb-1 block text-xs text-gray-500">重试原因（必填，写入审计）</span>
              <input
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                  if (reasonError) setReasonError(null);
                }}
                aria-invalid={reasonError !== null}
                data-testid="retry-failed-reason-input"
                className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                placeholder="例如：上游临时抖动已恢复，重试确认"
              />
            </label>
            {reasonError && (
              <p role="alert" data-testid="retry-failed-reason-error" className="text-xs text-red-700">
                {reasonError}
              </p>
            )}
          </>
        }
        onCancel={() => {
          if (busy) return;
          setOpen(false);
          setReason("");
          setReasonError(null);
        }}
        onConfirm={() => void submit()}
      />
    </div>
  );
}
