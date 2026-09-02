"use client";

import { useEffect, useRef, useState } from "react";

import { buttonClassName } from "@/components/ui/button";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";

import { enqueuePromoLinkClaimAction } from "../_actions";
import type { ClaimChannelAppOption } from "../_lib/read-channel-apps";
import type { SourceItemRow } from "../_lib/read-source-items";
import {
  PROMO_LINK_CLAIM_ALLOWLIST_NOTE,
  PROMO_LINK_CLAIM_APPLY_IRREVERSIBLE_WARNING,
  PROMO_LINK_CLAIM_NEXT_STEPS_NOTE,
  describePromoLinkClaimOutcome,
  hasSkipReasons,
  promoLinkClaimFlagChecklist,
  promoLinkClaimStatusQuery,
  skipReasonLabel,
  type OutcomeTone,
  type PromoLinkClaimOutcome,
} from "../_lib/promo-claim-copy";

/**
 * "领取推广链接" confirm dialog on `/catalog-sync` (RC-1).
 *
 * Opened from `CatalogSyncClient`'s selection toolbar with the operator's
 * *already-made* explicit row selection — this dialog never offers a "select
 * everything matching the current filter" shortcut, matching CPS
 * v8.3.6's `submitChangduPromoClaim` hard rule (only display, no filter
 * input exists to submit in the first place).
 *
 * Every {@link PromoLinkClaimOutcome} outcome renders through
 * `describePromoLinkClaimOutcome`, same exhaustiveness discipline as
 * `CreateContentDialog` / `CatalogScanTriggerForm`.
 */

type Stage =
  | { readonly kind: "form" }
  | { readonly kind: "submitting" }
  | { readonly kind: "result"; readonly result: PromoLinkClaimOutcome }
  | { readonly kind: "invalid_input"; readonly code: string }
  | { readonly kind: "access_denied"; readonly message: string };

const TONE_STYLE: Readonly<Record<OutcomeTone, string>> = Object.freeze({
  success: "border-emerald-200 bg-emerald-50 text-emerald-900",
  info: "border-blue-200 bg-blue-50 text-blue-900",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
  danger: "border-red-200 bg-red-50 text-red-900",
});

/**
 * Codes `PromoLinkClaimTaskInputError` (`@/lib/tasks/promo-link-claim`) and
 * the action's own pre-checks can actually surface here. `request_token_
 * required` / `actor_required` / `request_id_required` / `mode_invalid` /
 * `novel_source_item_id_required` / `offer_type_required` /
 * `novel_source_item_id_invalid` stay in the fallback branch — this dialog
 * never supplies those fields itself (the action fills them server-side, and
 * ids come straight off already-loaded `SourceItemRow`s), so seeing one
 * would mean an internal bug, not a bad form entry.
 */
const INVALID_INPUT_COPY: Readonly<Record<string, string>> = Object.freeze({
  channel_account_required: "请选择渠道账户",
  channel_app_required: "请选择渠道应用",
  items_required: "请至少勾选一条来源条目",
  batch_size_exceeded: "所选来源条目数超过单次上限，请分批提交",
  active_channel_binding_required:
    "所选渠道应用与渠道账户当前不是有效的启用绑定（可能刚被停用），请刷新页面后重试",
});

function inputInvalidMessage(code: string): string {
  return INVALID_INPUT_COPY[code] ?? `输入无效（${code}），请刷新页面后重试`;
}

function SkipReasonList({ counts }: { counts: Readonly<Record<string, number>> }) {
  if (!hasSkipReasons(counts)) return null;
  return (
    <ul className="mt-2 space-y-1 text-xs text-gray-600">
      {Object.entries(counts).map(([reason, count]) => (
        <li key={reason} data-testid={`promo-claim-skip-${reason}`}>
          {skipReasonLabel(reason)}：{count} 条
        </li>
      ))}
    </ul>
  );
}

function FlagChecklist({ flags }: { flags: Extract<PromoLinkClaimOutcome, { outcome: "enqueued_disabled" }>["flags"] }) {
  return (
    <ul className="mt-2 space-y-1 text-xs">
      {promoLinkClaimFlagChecklist(flags).map((row) => (
        <li key={row.envName} data-testid={`promo-claim-flag-row-${row.envName}`} className="flex items-start gap-1.5">
          <span
            className={`mt-0.5 inline-flex shrink-0 rounded px-1.5 py-0.5 font-mono font-medium ${
              row.on ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"
            }`}
          >
            {row.on ? "已开启" : "未开启"}
          </span>
          <span>
            <code>{row.envName}</code> — {row.note}
          </span>
        </li>
      ))}
      <li className="mt-1 text-gray-500">{PROMO_LINK_CLAIM_ALLOWLIST_NOTE}</li>
    </ul>
  );
}

function NextStepsNote({ taskId }: { taskId: string }) {
  return (
    <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
      <p>{PROMO_LINK_CLAIM_NEXT_STEPS_NOTE}</p>
      <pre className="mt-1.5 overflow-x-auto rounded bg-gray-900 px-2 py-1.5 text-[11px] text-gray-100">
        {promoLinkClaimStatusQuery(taskId)}
      </pre>
    </div>
  );
}

function ResultPanel({ result }: { result: PromoLinkClaimOutcome }) {
  const copy = describePromoLinkClaimOutcome(result);
  return (
    <div
      role={copy.tone === "danger" ? "alert" : "status"}
      data-testid={`promo-claim-outcome-${result.outcome}`}
      className={`rounded-lg border px-3 py-2 text-sm ${TONE_STYLE[copy.tone]}`}
    >
      <p className="font-medium">{copy.title}</p>
      <p className="mt-1">{copy.body}</p>
      {(result.outcome === "enqueued" || result.outcome === "enqueued_disabled" || result.outcome === "no_eligible_sources") && (
        <SkipReasonList counts={result.skipReasonCounts} />
      )}
      {result.outcome === "enqueued_disabled" && <FlagChecklist flags={result.flags} />}
      {(result.outcome === "enqueued" || result.outcome === "enqueued_disabled" || result.outcome === "duplicate" || result.outcome === "active_conflict") && (
        <NextStepsNote taskId={result.taskId} />
      )}
    </div>
  );
}

export function PromoLinkClaimDialog({
  selectedItems,
  channelApps,
  maxBatchSize,
  promoClaimGranted,
  promoClaimBlockedReason,
  onClose,
  onSubmitted,
}: {
  selectedItems: readonly SourceItemRow[];
  channelApps: readonly ClaimChannelAppOption[];
  maxBatchSize: number;
  promoClaimGranted: boolean;
  promoClaimBlockedReason: string | null;
  onClose: () => void;
  /** Called once a submission succeeds (any outcome) so the parent can clear the row selection. */
  onSubmitted: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [stage, setStage] = useState<Stage>({ kind: "form" });
  const [mode, setMode] = useState<"dry_run" | "apply">("dry_run");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  /**
   * `selectedItems` / `channelApps` are the operator's already-made row
   * selection, fixed for this dialog's whole lifetime — the parent only ever
   * mounts a fresh `PromoLinkClaimDialog` instance per open (see
   * `CatalogSyncClient`'s `{claimDialogOpen && <PromoLinkClaimDialog .../>}`),
   * never re-renders one with a different selection underneath it. So
   * `singleChannelApp` needs no memoization and the account picker's default
   * needs no effect to "re-seed" — a lazy `useState` initializer, computed
   * once at mount, is the whole story.
   */
  const distinctChannelAppIds = Array.from(new Set(selectedItems.map((item) => item.channelAppId)));
  const singleChannelApp = distinctChannelAppIds.length === 1
    ? (channelApps.find((app) => app.id === distinctChannelAppIds[0]) ?? null)
    : null;
  const crossChannelApp = distinctChannelAppIds.length > 1;

  const [channelAccountId, setChannelAccountId] = useState(
    () => singleChannelApp?.channelAccounts[0]?.id ?? "",
  );

  const isFormStage = stage.kind === "form";
  const isSubmitting = stage.kind === "submitting";
  const overLimit = selectedItems.length > maxBatchSize;
  const applyBlocked = mode === "apply" && !promoClaimGranted;
  const capabilityDisabled = singleChannelApp !== null && !singleChannelApp.claimCapabilityEnabled;
  const canSubmit =
    isFormStage
    && !crossChannelApp
    && singleChannelApp !== null
    && !capabilityDisabled
    && !overLimit
    && channelAccountId !== ""
    && !applyBlocked;

  async function onSubmit() {
    if (!singleChannelApp) return;
    setStage({ kind: "submitting" });
    const result = await enqueuePromoLinkClaimAction({
      channelAccountId,
      channelAppId: singleChannelApp.id,
      novelSourceItemIds: selectedItems.map((item) => item.id),
      mode,
      requestId: crypto.randomUUID(),
    });
    if (!result.ok) {
      setStage(
        result.kind === "invalid_input"
          ? { kind: "invalid_input", code: result.code }
          : { kind: "access_denied", message: errorEnvelopeCopy(result.envelope) },
      );
      return;
    }
    setStage({ kind: "result", result: result.data });
    onSubmitted();
  }

  const showForm = isFormStage || isSubmitting || stage.kind === "invalid_input" || stage.kind === "access_denied";

  return (
    <dialog
      ref={dialogRef}
      onCancel={(event) => {
        event.preventDefault();
        if (!isSubmitting) onClose();
      }}
      className="w-full max-w-lg rounded-xl border border-gray-200 p-0 text-gray-900 shadow-xl backdrop:bg-gray-900/40"
    >
      <div className="space-y-4 p-5">
        <h2 className="text-base font-semibold">领取推广链接</h2>

        <p className="text-sm text-gray-600" data-testid="promo-claim-selection-count">
          已选择 <span className="font-medium text-gray-900">{selectedItems.length}</span> 条来源条目
          （单次上限 {maxBatchSize} 条）
        </p>

        {overLimit && (
          <p role="alert" className={`rounded-lg border px-3 py-2 text-sm ${TONE_STYLE.danger}`}>
            所选数量超过单次上限 {maxBatchSize} 条，请取消部分勾选后再提交。
          </p>
        )}

        {crossChannelApp && (
          <p role="alert" className={`rounded-lg border px-3 py-2 text-sm ${TONE_STYLE.danger}`} data-testid="promo-claim-cross-channel-app">
            已选来源条目分属不同的渠道应用，领取任务只能针对单一渠道应用发起。请每次只勾选同一渠道应用下的条目。
          </p>
        )}

        {!crossChannelApp && !singleChannelApp && selectedItems.length > 0 && (
          <p role="alert" className={`rounded-lg border px-3 py-2 text-sm ${TONE_STYLE.danger}`}>
            所选来源条目所属的渠道应用当前不可用（可能已停用），请刷新页面后重试。
          </p>
        )}

        {showForm && singleChannelApp && !crossChannelApp && (
          <div className="space-y-3">
            <p className="text-xs text-gray-500">
              渠道应用：{singleChannelApp.channelName}（{singleChannelApp.channelCode}） ·{" "}
              {singleChannelApp.sourceAppName}
            </p>

            {capabilityDisabled ? (
              <p className={`rounded-lg border px-3 py-2 text-sm ${TONE_STYLE.warning}`} data-testid="promo-claim-capability-disabled-precheck">
                该渠道应用的 claimPromo 能力位当前不是 enabled，未经 Owner 解冻，无法在此发起领取。
              </p>
            ) : (
              <>
                <label className="block text-sm">
                  <span className="mb-1 block text-gray-600">渠道账户</span>
                  <select
                    value={channelAccountId}
                    onChange={(event) => setChannelAccountId(event.target.value)}
                    aria-label="渠道账户"
                    disabled={singleChannelApp.channelAccounts.length === 0}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:bg-gray-50 disabled:text-gray-400"
                  >
                    {singleChannelApp.channelAccounts.length === 0 && (
                      <option value="">（该渠道下没有启用中的账户）</option>
                    )}
                    {singleChannelApp.channelAccounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.accountName}（{account.businessId}）
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block text-sm">
                  <span className="mb-1 block text-gray-600">模式</span>
                  <select
                    value={mode}
                    onChange={(event) => setMode(event.target.value as "dry_run" | "apply")}
                    aria-label="模式"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  >
                    <option value="dry_run">dry_run（试运行，不会调用 claimPromo）</option>
                    <option value="apply">apply（正式领取，需要 promo:claim）</option>
                  </select>
                </label>

                {mode === "apply" && (
                  <p
                    role="alert"
                    data-testid="promo-claim-apply-irreversible-warning"
                    className={`rounded-lg border px-3 py-2 text-sm ${TONE_STYLE.warning}`}
                  >
                    {PROMO_LINK_CLAIM_APPLY_IRREVERSIBLE_WARNING}
                  </p>
                )}

                {applyBlocked && promoClaimBlockedReason && (
                  <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    {promoClaimBlockedReason}
                    <span className="ml-1 text-amber-700">请切换回 dry_run，或联系管理员授予该能力位。</span>
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {stage.kind === "invalid_input" && (
          <p role="alert" className={`rounded-lg border px-3 py-2 text-sm ${TONE_STYLE.danger}`}>
            {inputInvalidMessage(stage.code)}
          </p>
        )}
        {stage.kind === "access_denied" && (
          <p role="alert" className={`rounded-lg border px-3 py-2 text-sm ${TONE_STYLE.danger}`}>
            {stage.message}
          </p>
        )}
        {stage.kind === "result" && <ResultPanel result={stage.result} />}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={isSubmitting}
            onClick={onClose}
            className={buttonClassName("secondary")}
          >
            {stage.kind === "result" ? "关闭" : "取消"}
          </button>
          {showForm && (
            <button
              type="button"
              disabled={!canSubmit || isSubmitting}
              onClick={onSubmit}
              className={buttonClassName(mode === "apply" ? "danger" : "primary")}
            >
              {isSubmitting ? "提交中…" : mode === "apply" ? "确认领取（apply）" : "确认领取（dry_run）"}
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
}
