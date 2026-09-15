/**
 * Promo-link claim chain constants. Deliberately a standalone file, not
 * folded into `moboreader.ts`'s `MOBOREADER_CATALOG_LIMITS` —
 * `claimPromo`/`readPromoAfterClaim` are a different capability class
 * (side-effecting/disabled vs. read-only/proven) with a different upstream
 * evidence state, and this task's task-instruction explicitly forbids
 * reusing the short-drama-derived MoboReader numbers here.
 *
 * `ttlMs` remains PENDING OWNER CALIBRATION; the comment
 * on each says why. `readback.*` is a local safety-hygiene policy independent
 * of the unproven `claimPromo` idempotency contract. Its deployment defaults
 * were Owner-frozen on 2026-09-02 to match CPS v8.3.6: three read-only
 * attempts at a 2000ms interval, while preserving the existing clamps.
 * Selection size is intentionally not capped here. Fifty is only an internal
 * database chunk size and is never an operator-facing limit.
 */

/** Capability-registry key. Matches the architecture doc's own capability name verbatim (`novel-v1-adapter-and-workflow-v0.2.1.md` §2.2/§2.3 `claimPromo` row) — not a project-invented rename. */
export const PROMO_LINK_CLAIM_CAPABILITY_KEY = "claimPromo";

export const PROMO_LINK_CLAIM_TASK_TYPE = "promo_link.claim.v1";
export const PROMO_LINK_CLAIM_TARGET_TYPE = "novel_source_item";

export const PROMO_LINK_CLAIM_READBACK_ENV = Object.freeze({
  attempts: "PROMO_LINK_CLAIM_READBACK_ATTEMPTS",
  intervalMs: "PROMO_LINK_CLAIM_READBACK_INTERVAL_MS",
});

export const PROMO_LINK_CLAIM_LIMITS = Object.freeze({
  /**
   * Task TTL: a stale task must not fire the (currently disabled) upstream
   * call once picked back up by a worker. 6 hours is the architecture doc's
   * own citation of CPS's shipped value for the exact same question
   * (`novel-v1-adapter-and-workflow-v0.2.1.md:279`, citing
   * `changdu-promo-claim-limits.ts:3`) — inherited as a starting point, not
   * invented. PENDING OWNER CALIBRATION.
   */
  ttlMs: 6 * 60 * 60 * 1_000,
  /** Internal database read/write chunk; never an operator selection cap. */
  chunkSize: 50,
  /**
   * Bounded readback retry for pre-read, post-claim confirmation, and
   * readback-only recovery. The 3-attempt/2000ms deployment defaults are
   * Owner-approved CPS v8.3.6 parity; the bidirectional clamps retain the
   * architecture doc's cited CPS safety shape
   * (`novel-v1-adapter-and-workflow-v0.2.1.md:191`, citing
   * `changdu-promo-claim.ts:271-299,305-325`) — "上游写入延迟量级未知，参数需
   * 实测后定" (upstream write-latency magnitude is unmeasured; needs
   * real-world measurement) remains the operational reason to keep these
   * bounded and configurable.
   */
  readback: Object.freeze({
    defaultAttempts: 3,
    maxAttempts: 5,
    defaultIntervalMs: 2_000,
    maxIntervalMs: 30_000,
  }),
  /**
   * Batch-level circuit breaker (2026-09-14 incident: a 79,217-item batch
   * burned ~44k items to `credential_validation_failed` in ~18 minutes
   * because nothing ever stopped it). Tripped only by the deterministic/
   * systemic failure classes in `worker/handlers/promo-link-claim-circuit-
   * breaker.ts` (currently: the five `resolveClaimCredentialReadiness`
   * codes) — never by a transient/per-row class, and never by a handful of
   * genuinely bad individual rows, both by construction: those codes are
   * account-level facts (the whole task shares one `channelAccountId`), so
   * they either apply to literally every item in the task or none of them —
   * they can never be "a few scattered bad rows" the way a per-item data
   * problem can.
   *
   * 3, matching this same file's `readback.defaultAttempts` (one consistent
   * "n=3" cardinality across this pipeline's safety knobs), is deliberately
   * more than 1: `resolveClaimCredentialReadiness` reads
   * `channel_account_credential` live, and `addOrReplaceCredential`
   * (`src/server/credentials/service.ts`) mutates that same table across
   * several statements during a credential replace/rotation — an item
   * finalizing mid-rotation could see a transient `credential_ambiguous`/
   * `credential_missing` read purely from that race, not from a genuinely
   * broken credential. Requiring 3 *consecutive* deterministic-class
   * failures (checked against the most recently finalized sibling items of
   * the same task, not a per-worker-process in-memory counter — multiple
   * worker replicas process one task concurrently) absorbs that one-off
   * race while still halting a systemically broken batch within single
   * digits of items instead of tens of thousands.
   */
  breakerConsecutiveFailureThreshold: 3,
});

export interface PromoLinkClaimReadbackPolicy {
  attempts: number;
  intervalMs: number;
}

export class PromoLinkClaimReadbackConfigError extends Error {
  constructor(readonly variable: string) {
    super(`${variable} must be an integer`);
    this.name = "PromoLinkClaimReadbackConfigError";
  }
}

function clampedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  variable: string,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new PromoLinkClaimReadbackConfigError(variable);
  return Math.min(maximum, Math.max(minimum, parsed));
}

/**
 * Runtime policy for read-only getlistpc recovery. Values are clamped in
 * both directions to the existing CPS-derived safety bounds. This policy
 * never controls task attempts or getcode dispatches.
 */
export function resolvePromoLinkClaimReadbackPolicy(
  env: NodeJS.ProcessEnv = process.env,
): Readonly<PromoLinkClaimReadbackPolicy> {
  const limits = PROMO_LINK_CLAIM_LIMITS.readback;
  return Object.freeze({
    attempts: clampedInteger(
      env[PROMO_LINK_CLAIM_READBACK_ENV.attempts],
      limits.defaultAttempts,
      1,
      limits.maxAttempts,
      PROMO_LINK_CLAIM_READBACK_ENV.attempts,
    ),
    intervalMs: clampedInteger(
      env[PROMO_LINK_CLAIM_READBACK_ENV.intervalMs],
      limits.defaultIntervalMs,
      0,
      limits.maxIntervalMs,
      PROMO_LINK_CLAIM_READBACK_ENV.intervalMs,
    ),
  });
}
