/**
 * Promo-link claim chain constants. Deliberately a standalone file, not
 * folded into `moboreader.ts`'s `MOBOREADER_CATALOG_LIMITS` —
 * `claimPromo`/`readPromoAfterClaim` are a different capability class
 * (side-effecting/disabled vs. read-only/proven) with a different upstream
 * evidence state, and this task's task-instruction explicitly forbids
 * reusing the short-drama-derived MoboReader numbers here.
 *
 * `ttlMs` and `maxBatchSize` remain PENDING OWNER CALIBRATION; the comment
 * on each says why. `readback.*` is a local safety-hygiene policy independent
 * of the unproven `claimPromo` idempotency contract. Its deployment defaults
 * were Owner-frozen on 2026-09-02 to match CPS v8.3.6: three read-only
 * attempts at a 2000ms interval, while preserving the existing clamps.
 * `maxBatchSize` has no precedent to cite — it is a deliberately
 *     conservative placeholder pending real Owner input once operators have
 *     opinions about explicit-selection batch size for a side-effecting-
 *     adjacent capability.
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
  /**
   * Explicit-selection batch cap ("拒绝按筛选全量、只接受显式区间" — doc §4,
   * item 15: callers must pass an explicit id list, never a filter
   * descriptor; this cap only bounds that list's length). No CPS citation
   * for this exact number — deliberately conservative because most items
   * routed through this chain will, in practice, resolve via the
   * always-enabled "already-existing promo" pre-read (§3.9) rather than the
   * disabled `claimPromo` path, so a small cap costs little throughput
   * today. PENDING OWNER CALIBRATION, not inherited from any source.
   */
  maxBatchSize: 50,
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
