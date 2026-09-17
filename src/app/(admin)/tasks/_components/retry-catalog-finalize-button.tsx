"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { buttonClassName } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { adminFetch } from "@/features/admin-ui/admin-fetch";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";

type RetryCatalogFinalizeResult = {
  readonly family: "generic";
  readonly taskId: string;
  readonly status: "pending";
  readonly generation: number;
  readonly wrote: boolean;
  readonly auditId: string;
};

export function RetryCatalogFinalizeButton({ taskId }: { taskId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setErrorMessage(null);
    const outcome = await adminFetch<RetryCatalogFinalizeResult>("/api/admin/tasks/retry-catalog-finalize", {
      method: "POST",
      body: { taskId },
    });
    setBusy(false);
    setOpen(false);
    if (!outcome.ok) {
      setErrorMessage(errorEnvelopeCopy(outcome.envelope));
      setMessage(null);
      return;
    }
    setMessage(`目录收尾已重新排队（第 ${outcome.data.generation} 代），等待 Worker 执行。`);
    router.refresh();
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={buttonClassName("secondary")}
        data-testid="retry-catalog-finalize-open"
      >
        重新执行目录收尾
      </button>
      {errorMessage && <p role="alert" className="text-sm text-red-700">{errorMessage}</p>}
      {message && <p role="status" className="text-sm text-emerald-700">{message}</p>}
      <ConfirmDialog
        open={open}
        pending={busy}
        title="重新执行目录收尾"
        confirmLabel="确认重新收尾"
        confirmVariant="secondary"
        body={<p>页面扫描结果和 EOF 证据会保留；系统将以新一代任务重新汇总并构建 Preview。</p>}
        onCancel={() => { if (!busy) setOpen(false); }}
        onConfirm={() => void submit()}
      />
    </div>
  );
}
