"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { buttonClassName } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { adminFetch } from "@/features/admin-ui/admin-fetch";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";

type ControlAction = "pause" | "resume" | "abort" | "reapprove";

type ControlResult = {
  readonly batchId: string;
  readonly status: string;
  readonly wrote: boolean;
  readonly auditId: string;
};

const ENDPOINTS: Readonly<Record<ControlAction, string>> = Object.freeze({
  pause: "/api/admin/tasks/promo-claim-batch/pause",
  resume: "/api/admin/tasks/promo-claim-batch/resume",
  abort: "/api/admin/tasks/promo-claim-batch/abort",
  reapprove: "/api/admin/tasks/promo-claim-batch/reapprove",
});

const DIALOG_COPY: Readonly<Record<ControlAction, { title: string; confirmLabel: string; body: string }>> = Object.freeze({
  pause: {
    title: "暂停批次",
    confirmLabel: "确认暂停",
    body: "确认暂停整个批次？当前已放行的分片会跟着暂停（正在处理的条目正常跑完，其余待处理条目原样保留，不会跳过）；仍在排队、尚未放行的分片不受影响，本身也不会被 scheduler 选中放行。可随时恢复。",
  },
  resume: {
    title: "恢复批次",
    confirmLabel: "确认恢复",
    body: "确认恢复整个批次？被暂停的已放行分片不会直接继续执行，而是交还给 scheduler 重新走一遍准入 / 凭据 / 安全检查后再放行（重新计算 90 分钟窗口）。",
  },
  abort: {
    title: "中止批次",
    confirmLabel: "确认中止",
    body: "确认中止整个批次？此操作不可恢复：所有未完成的分片（含仍在排队、从未放行过的）都会终止；正在处理的条目会正常跑完，其余待处理条目会被标记为已跳过；不会触发任何新的领取调用。已成功/已失败的条目历史不受影响。",
  },
  reapprove: {
    title: "重新批准批次",
    confirmLabel: "确认重新批准",
    body: "该批次的批准已过期，且从未放行过任何分片。确认重新批准后，会以当前时刻重新计算批准有效期，批次恢复正常，等待 scheduler 按准入 / 凭据检查放行第一个分片。",
  },
});

/**
 * 阶段2 第4步（施工任务 3.1/3.3）：生命周期批次专用的批次级暂停/恢复/中止/
 * 重新批准控制——与通用的 `TaskControlButtons`（单任务）完全独立，接的是
 * `/api/admin/tasks/promo-claim-batch/*` 四个批次级端点，级联到分片。
 *
 * 可点性判定用 `parentRawStatus`（批次自身未经派生的原始 status 列值），
 * 不是页面上展示用的派生状态——理由同 `TaskDetailDto.parentRawStatus` 自己
 * 的 doc comment：批次自己的枚举条目处理完后原始状态很快变终态（通常是
 * completed），即使分片仍在跑，用派生状态判断可点性会出现"按钮显示可点，
 * 点了却 409"。
 */
export function PromoClaimBatchControlButtons({
  taskId,
  parentRawStatus,
  holdReasonCode,
}: {
  taskId: string;
  parentRawStatus: string;
  holdReasonCode?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<ControlAction | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const held = parentRawStatus === "paused" || parentRawStatus === "cancelled" || parentRawStatus === "disabled";
  const canPause = !held;
  const canResume = parentRawStatus === "paused";
  const canAbort = parentRawStatus !== "cancelled";
  // 服务端会用 firstReleasedAt 再次权威校验；这里只是让"重新批准"按钮只在
  // 看起来对的时候出现——不做"强制放行"，不绕过 D4。
  const canReapprove = parentRawStatus === "disabled" && holdReasonCode === "approval_expired";

  if (!canPause && !canResume && !canAbort && !canReapprove) return null;

  function openDialog(action: ControlAction) {
    setErrorMessage(null);
    setReason("");
    setOpen(action);
  }

  async function submit(action: ControlAction) {
    setBusy(true);
    setErrorMessage(null);
    const body: Record<string, unknown> = { taskId };
    if (action === "pause" || action === "abort") body.reason = reason.trim() === "" ? undefined : reason.trim();
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
        {canReapprove && (
          <button
            type="button"
            onClick={() => openDialog("reapprove")}
            className={buttonClassName("primary")}
            data-testid="promo-claim-batch-reapprove-open"
          >
            重新批准
          </button>
        )}
        {canPause && (
          <button
            type="button"
            onClick={() => openDialog("pause")}
            className={buttonClassName("secondary")}
            data-testid="promo-claim-batch-pause-open"
          >
            暂停批次
          </button>
        )}
        {canResume && (
          <button
            type="button"
            onClick={() => openDialog("resume")}
            className={buttonClassName("secondary")}
            data-testid="promo-claim-batch-resume-open"
          >
            恢复批次
          </button>
        )}
        {canAbort && (
          <button
            type="button"
            onClick={() => openDialog("abort")}
            className={buttonClassName("danger")}
            data-testid="promo-claim-batch-abort-open"
          >
            中止批次
          </button>
        )}
      </div>

      {errorMessage && !open && (
        <p role="alert" data-testid="promo-claim-batch-control-error" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {errorMessage}
        </p>
      )}

      {(["pause", "resume", "abort", "reapprove"] as const).map((action) => (
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
              {(action === "pause" || action === "abort") && (
                <textarea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="操作原因（可选，会写入审计记录）"
                  rows={2}
                  maxLength={2000}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  data-testid={`promo-claim-batch-${action}-reason`}
                />
              )}
              {errorMessage && (
                <p role="alert" data-testid="promo-claim-batch-control-dialog-error" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
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
