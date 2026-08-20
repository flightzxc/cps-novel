/**
 * Promo-link claim chain constants. Deliberately a standalone file, not
 * folded into `moboreader.ts`'s `MOBOREADER_CATALOG_LIMITS` —
 * `claimPromo`/`readPromoAfterClaim` are a different capability class
 * (side-effecting/disabled vs. read-only/proven) with a different upstream
 * evidence state, and this task's task-instruction explicitly forbids
 * reusing the short-drama-derived MoboReader numbers here.
 *
 * 🔴 ALL numeric values below are PENDING OWNER CALIBRATION. Two different
 * kinds of "pending" are mixed in here and the comment on each constant
 * says which:
 *   - `ttlMs` and `readback.*` are *local safety-hygiene knobs*, independent
 *     of the unproven `claimPromo` wire contract — they bound how long a
 *     stale task is allowed to still attempt an upstream call and how many
 *     times a (currently unreachable) readback may be retried. Their
 *     defaults are not guesses: they are the architecture doc's own citation
 *     of CPS's shipped, production-tested values for the same local-safety
 *     question (`novel-v1-adapter-and-workflow-v0.2.1.md` — see per-field
 *     comments for exact line references). They still need Owner sign-off
 *     before this project treats them as final, but they are evidenced
 *     starting points, not invented numbers.
 *   - `maxBatchSize` has no such precedent to cite — it is a deliberately
 *     conservative placeholder pending real Owner input once operators have
 *     opinions about explicit-selection batch size for a side-effecting-
 *     adjacent capability.
 */

/** Capability-registry key. Matches the architecture doc's own capability name verbatim (`novel-v1-adapter-and-workflow-v0.2.1.md` §2.2/§2.3 `claimPromo` row) — not a project-invented rename. */
export const PROMO_LINK_CLAIM_CAPABILITY_KEY = "claimPromo";

export const PROMO_LINK_CLAIM_TASK_TYPE = "promo_link.claim.v1";
export const PROMO_LINK_CLAIM_TARGET_TYPE = "novel_source_item";

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
   * Bounded readback retry — only reachable once `claimPromo` itself is
   * unfrozen (see `src/lib/adapters/promo-link-claim.ts`). Defaults and caps
   * are the architecture doc's citation of CPS's shipped, bidirectionally-
   * clamped values for the same question
   * (`novel-v1-adapter-and-workflow-v0.2.1.md:191`, citing
   * `changdu-promo-claim.ts:271-299,305-325`) — "上游写入延迟量级未知，参数需
   * 实测后定" (upstream write-latency magnitude is unmeasured; needs
   * real-world measurement) is the doc's own words for why these remain
   * PENDING OWNER CALIBRATION even though they have a CPS precedent.
   */
  readback: Object.freeze({
    defaultAttempts: 1,
    maxAttempts: 5,
    defaultIntervalMs: 2_000,
    maxIntervalMs: 30_000,
  }),
});
