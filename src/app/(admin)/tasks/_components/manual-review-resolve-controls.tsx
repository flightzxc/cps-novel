"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { buttonClassName } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { adminFetch } from "@/features/admin-ui/admin-fetch";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";

import {
  MANUAL_REVIEW_UNBLOCKS_RETRY_NOTE,
  MANUAL_REVIEW_WARNING,
  manualReviewResolutionCopy,
  nextActionCopy,
  type ManualReviewResolution,
} from "../_lib/manual-review-copy";

type ManualReviewResolutionResult = {
  readonly intentId: string;
  readonly resolution: ManualReviewResolution;
  readonly status: "confirmed" | "failed";
  readonly resolvedAt: string;
  readonly automaticReconciliation: false;
  readonly nextActions: readonly string[];
  readonly wrote: boolean;
  readonly auditId: string;
};

/**
 * The two-outcome verdict for one `SideEffectIntent.status =
 * "manual_review_required"` row — `POST
 * /api/admin/tasks/manual-reviews/resolve`.
 *
 * Deliberately two separate buttons rather than one control with a select:
 * this is the highest-consequence action in the task center (P0's
 * `CLAUDE.md` §5 修正 4 — an operator asserting external truth the system
 * cannot verify), and a select defaults to *some* value even when nobody
 * chose one. Two buttons force an explicit choice every time.
 */
export function ManualReviewResolveControls({ intentId }: { intentId: string }) {
  const router = useRouter();
  const [pendingResolution, setPendingResolution] = useState<ManualReviewResolution | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [result, setResult] = useState<ManualReviewResolutionResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function submit(resolution: ManualReviewResolution) {
    const trimmed = reason.trim();
    if (!trimmed) {
      setReasonError("请填写裁决依据后再提交（会写入审计记录）。");
      return;
    }
    setReasonError(null);
    setBusy(true);
    setErrorMessage(null);
    const outcome = await adminFetch<ManualReviewResolutionResult>(
      "/api/admin/tasks/manual-reviews/resolve",
      { method: "POST", body: { intentId, resolution, reason: trimmed } },
    );
    setBusy(false);
    if (!outcome.ok) {
      setErrorMessage(errorEnvelopeCopy(outcome.envelope));
      setResult(null);
      return;
    }
    setPendingResolution(null);
    setReason("");
    setResult(outcome.data);
    setErrorMessage(null);
    router.refresh();
  }

  if (result) {
    return (
      <div
        role="status"
        data-testid={`manual-review-resolved-${intentId}`}
        className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
      >
        <p className="font-medium">
          已裁决为「{manualReviewResolutionCopy(result.resolution).label}」
          {result.wrote === false && "（重复提交，展示的是首次裁决的结果）"}
        </p>
        <p className="text-xs text-emerald-700">系统不会自动触发对账或重试。后续步骤：</p>
        <ul className="list-disc space-y-0.5 pl-4 text-xs text-emerald-700">
          {result.nextActions.map((action) => (
            <li key={action}>{nextActionCopy(action)}</li>
          ))}
        </ul>
      </div>
    );
  }

  const copy = pendingResolution ? manualReviewResolutionCopy(pendingResolution) : null;

  return (
    <div className="space-y-2">
      {errorMessage && (
        <p role="alert" data-testid={`manual-review-error-${intentId}`} className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {errorMessage}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={buttonClassName("danger")}
          onClick={() => {
            setReasonError(null);
            setPendingResolution("effect_confirmed");
          }}
          data-testid={`manual-review-confirm-effect-${intentId}`}
        >
          确认副作用已发生
        </button>
        <button
          type="button"
          className={buttonClassName("secondary")}
          onClick={() => {
            setReasonError(null);
            setPendingResolution("no_effect_confirmed");
          }}
          data-testid={`manual-review-confirm-no-effect-${intentId}`}
        >
          确认未发生
        </button>
      </div>

      <ConfirmDialog
        open={pendingResolution !== null}
        pending={busy}
        title={copy?.label ?? ""}
        confirmLabel={copy?.confirmLabel ?? "确认"}
        confirmVariant="danger"
        body={
          <>
            <p data-testid={`manual-review-warning-${intentId}`} className="font-medium text-red-800">
              {MANUAL_REVIEW_WARNING}
            </p>
            {copy && <p>{copy.warning}</p>}
            <p className="text-xs text-gray-500">{MANUAL_REVIEW_UNBLOCKS_RETRY_NOTE}</p>
            <label className="block">
              <span className="mb-1 block text-xs text-gray-500">裁决依据（必填，写入审计）</span>
              <input
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                  if (reasonError) setReasonError(null);
                }}
                aria-invalid={reasonError !== null}
                data-testid={`manual-review-reason-input-${intentId}`}
                className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                placeholder="例如：已登录渠道后台核实，推广码确已生成"
              />
            </label>
            {reasonError && (
              <p role="alert" data-testid={`manual-review-reason-error-${intentId}`} className="text-xs text-red-700">
                {reasonError}
              </p>
            )}
          </>
        }
        onCancel={() => {
          if (busy) return;
          setPendingResolution(null);
          setReason("");
          setReasonError(null);
        }}
        onConfirm={() => {
          if (pendingResolution) void submit(pendingResolution);
        }}
      />
    </div>
  );
}
