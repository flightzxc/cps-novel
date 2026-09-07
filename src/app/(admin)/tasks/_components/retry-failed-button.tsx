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
 * Aligned with CPS `retry-failed-promo-button.tsx:48-56` (C-16): one
 * confirmation, no reason field. `reason` is not sent by this component; the
 * server still accepts an optional `reason` on the wire (`optionalBoundedText`
 * in the service), and the audit row is written with `reason: null`.
 */
export function RetryFailedButton({
  family,
  taskId,
  failedCount,
}: {
  family: TaskFamily;
  taskId: string;
  failedCount: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RetryFailedTaskResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setErrorMessage(null);
    const outcome = await adminFetch<RetryFailedTaskResult>("/api/admin/tasks/retry-failed", {
      method: "POST",
      body: { family, taskId },
    });
    setBusy(false);
    setOpen(false);
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
        onClick={() => setOpen(true)}
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
          <p>
            确认重试 {failedCount} 个失败项？已成功和已跳过的子项会保持不变。
            <br />
            如果这个任务还挂着未裁决的人工审查项，本次提交会被拒绝——需要先去下方&ldquo;人工审查区&rdquo;裁决。
          </p>
        }
        onCancel={() => {
          if (busy) return;
          setOpen(false);
        }}
        onConfirm={() => void submit()}
      />
    </div>
  );
}
