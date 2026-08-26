/**
 * `claimPromo` — the side-effecting "generate a promo asset" capability.
 *
 * 🔴 EVIDENCE GAP, not an implementation choice: `novel-v1-adapter-and-
 * workflow-v0.2.1.md` §2.3 records this capability's endpoint/method/body/
 * idempotency-rule/readback-path as all **未证 (unproven)**. Existence is
 * `BROWSER_OBSERVED + OWNER_CONFIRMED`; the API contract itself is
 * `UNPROVEN`. The doc's explicit prohibition: "不得根据 CPS 短剧的 getcode
 * 协议补写请求合同" (do not backfill a request contract from CPS's
 * short-drama `getcode` protocol) — CPS's `projectType=2` `getcode` call is
 * a *different, already-proven* capability for a *different* product line;
 * assuming novel reuses its wire shape would be exactly the invented-
 * contract mistake this file exists to refuse.
 *
 * This module therefore defines the capability as an **interface only**.
 * `createPromoLinkClaimAdapter()` below returns a production implementation
 * whose `claimPromo` unconditionally throws — it performs no `fetch`, opens
 * no connection, and guesses no URL. This is deliberate, not a placeholder
 * TODO: the real network implementation cannot be written until all four
 * unfreezing preconditions in the architecture doc are met —
 *
 *   1. W9 authorization (立项书 §十二, currently "暂不" — outside this
 *      module's authority to grant);
 *   2. an Owner-supervised controlled probe capturing one real, redacted
 *      request/response pair;
 *   3. a confirmed idempotency rule (does a repeat call re-consume upstream
 *      quota?);
 *   4. a confirmed write-then-read(back) path.
 *
 * Until then, `ChannelCapability.status` for this capability key stays
 * `registered_disabled` (nothing in this codebase ever flips it to
 * `enabled` — see `worker/handlers/promo-link-claim.ts`), so
 * `createPromoLinkClaimAdapter()`'s throwing stub is unreachable in normal
 * operation. It exists so that (a) the worker handler can be written and
 * tested against a real interface shape today via a fixture implementation
 * (`PromoLinkClaimAdapter`), and (b) if the capability gate is ever
 * manually misconfigured to `enabled` without also swapping in a real
 * adapter, the failure is loud and immediate rather than a silently
 * fabricated HTTP call.
 *
 * `readPromoAfterClaim` (the post-claim readback capability, also
 * `registered_disabled`, also `UNPROVEN` — doc §2.3) is intentionally not
 * modeled as a separate adapter method in this file. It only has meaning
 * once `claimPromo`'s contract exists; folding it into the same
 * `ClaimPromoResult` shape (a `success` result that already carries the
 * confirmed public link fields) avoids inventing a second unproven contract
 * ahead of the first one being unfrozen. When Owner unfreezes `claimPromo`,
 * whether `readPromoAfterClaim` needs its own method is a decision for that
 * work, not this one.
 */

export type PromoLinkClaimAdapterErrorCode =
  | "endpoint_not_evidenced"
  | "transport_error"
  | "request_timeout"
  | "upstream_http_error"
  | "malformed_payload";

/**
 * `ambiguous = true` marks outcomes where whether the upstream side effect
 * actually happened cannot be determined from this response alone (timeout,
 * transport failure, malformed success body). Those must route to
 * `claim_retry_blocked` → `manual_review_required`, never to an automatic
 * retry — `src/lib/tasks/side-effect-intent.ts`, CLAUDE.md §5 修正 4, and
 * this project's architecture doc §4.10 all name this the same non-
 * negotiable rule. `ambiguous = false` with `retryable = true` (e.g. a
 * classified HTTP 429/5xx *before* any upstream state change is possible)
 * may be retried by ordinary task-item semantics; `retryable = false` is a
 * confirmed, definitive failure.
 */
export class PromoLinkClaimAdapterError extends Error {
  constructor(
    readonly code: PromoLinkClaimAdapterErrorCode,
    readonly retryable: boolean,
    readonly ambiguous: boolean,
    readonly status: number | null = null,
  ) {
    super(`PromoLink claim failed: ${code}${status === null ? "" : ` (${status})`}`);
    this.name = "PromoLinkClaimAdapterError";
  }
}

/**
 * Request shape is parameterized the same way every other adapter in this
 * project is (constraint two of `novel-v1-adapter-and-workflow-v0.2.1.md`
 * §2.1): `projectType`/`agencyId`/`language` all come from `ChannelApp`/
 * `NovelSourceItem` configuration at the call site, never a module-level
 * constant. `offerType` is this project's own field
 * (`prisma/schema.prisma`'s `PromoLink.offerType`), not part of any
 * upstream contract.
 */
export interface ClaimPromoRequest {
  agencyId: string | number;
  seriesId: string | number;
  projectType: number;
  language: string | number;
  offerType: string;
}

export interface ClaimPromoResult {
  /** The channel's real promo code. Never log, audit, or otherwise surface this value outside the encrypted/DB boundary — see `worker/handlers/promo-link-claim.ts`'s `redactUpstreamCode`. */
  upstreamCode: string;
  webUrl: string | null;
  appUrl: string | null;
}

export interface PromoLinkClaimAdapter {
  claimPromo(request: ClaimPromoRequest, token: string, signal?: AbortSignal): Promise<ClaimPromoResult>;
}

/**
 * Production implementation. Always throws `endpoint_not_evidenced` —
 * see this file's header. `ambiguous: false` because this is a pre-flight
 * refusal, not an upstream call whose outcome is unknown: nothing was sent.
 */
export function createPromoLinkClaimAdapter(): PromoLinkClaimAdapter {
  return Object.freeze({
    async claimPromo(): Promise<ClaimPromoResult> {
      throw new PromoLinkClaimAdapterError("endpoint_not_evidenced", false, false);
    },
  });
}

/**
 * Dual-axis error classification (doc §2.3 `classifyError`:
 * `failureCategory` for audit, `retryable` for scheduling, kept
 * orthogonal). Operates only on `PromoLinkClaimAdapterError` — this project
 * has no evidenced upstream error vocabulary to classify beyond the
 * adapter's own transport-level codes (the doc's #21 "上游错误文案清洗后入库"
 * cannot be honored for a body that was never observed).
 */
export interface ClassifiedClaimFailure {
  failureCategory: PromoLinkClaimAdapterErrorCode;
  retryable: boolean;
  ambiguous: boolean;
}

export function classifyClaimPromoFailure(error: unknown): ClassifiedClaimFailure {
  if (error instanceof PromoLinkClaimAdapterError) {
    return { failureCategory: error.code, retryable: error.retryable, ambiguous: error.ambiguous };
  }
  // Any non-adapter throw (a programming error, an unexpected exception
  // type) is treated as the most conservative case: ambiguous, not
  // retryable automatically. This is intentionally fail-closed rather than
  // fail-open.
  return { failureCategory: "transport_error", retryable: false, ambiguous: true };
}
