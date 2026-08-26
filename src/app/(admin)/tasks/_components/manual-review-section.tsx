import { AdminTimeZoneNote, formatAdminTimestamp } from "@/features/admin-ui/admin-time-zone-note";

import { MANUAL_REVIEW_EMPTY_STATE } from "../_lib/manual-review-copy";
import { ManualReviewResolveControls } from "./manual-review-resolve-controls";

export type ManualReviewRow = {
  readonly intentId: string;
  readonly operationType: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly taskItemType: string | null;
  readonly taskItemId: string | null;
  readonly channelAccountId: string | null;
  readonly channelAppId: string | null;
  readonly promoLinkId: string | null;
  readonly committedAt: string;
  readonly createdAt: string;
};

function IdentityField({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-gray-400">{label}</dt>
      <dd className="font-mono text-xs text-gray-700">{value}</dd>
    </div>
  );
}

/**
 * 人工审查区 — this task's stated purpose (审计 A12: "写侧纪律良好、读侧为零"的最终解).
 *
 * Every intent listed here is `SideEffectIntent.status =
 * "manual_review_required"`: a side effect (currently only
 * `promo_link.claim_promo`) whose outcome the system could not confirm and
 * has therefore refused to retry automatically. This is the only place that
 * queue is visible to an operator at all before this PR.
 */
export function ManualReviewSection({ reviews }: { reviews: readonly ManualReviewRow[] }) {
  return (
    <section aria-labelledby="manual-review-heading" className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="manual-review-heading" className="text-sm font-semibold text-gray-900">
          人工审查区 · 待裁决副作用意图（{reviews.length}）
        </h2>
        <AdminTimeZoneNote />
      </div>

      {reviews.length === 0 ? (
        <div
          data-testid="manual-review-empty-state"
          className="rounded-xl border border-gray-200 bg-white px-6 py-10 text-center shadow-sm"
        >
          <p className="text-gray-400">{MANUAL_REVIEW_EMPTY_STATE}</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {reviews.map((review) => (
            <li
              key={review.intentId}
              data-testid={`manual-review-row-${review.intentId}`}
              className="space-y-3 rounded-xl border border-amber-200 bg-amber-50/40 p-4 shadow-sm"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium text-gray-900">{review.operationType}</p>
                <p className="text-xs text-gray-500">
                  提交于 {formatAdminTimestamp(review.committedAt)} · 创建于 {formatAdminTimestamp(review.createdAt)}
                </p>
              </div>
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <IdentityField label="target_type" value={review.targetType} />
                <IdentityField label="target_id" value={review.targetId} />
                <IdentityField label="task_item_type" value={review.taskItemType} />
                <IdentityField label="task_item_id" value={review.taskItemId} />
                <IdentityField label="channel_account_id" value={review.channelAccountId} />
                <IdentityField label="channel_app_id" value={review.channelAppId} />
                <IdentityField label="promo_link_id" value={review.promoLinkId} />
              </dl>
              <ManualReviewResolveControls intentId={review.intentId} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
