/**
 * MoboReader upstream request-pacing discipline (RC-3).
 *
 * Ported from CPS 短剧 v8.3.6 `src/lib/adapters/changdu-rate-limit.ts`
 * (`git -C cps-admin show v8.3.6:src/lib/adapters/changdu-rate-limit.ts`),
 * renamed `CHANGDU_*` → `MOBOREADER_*`. Semantics and default numeric
 * values are unchanged from that source; see
 * `docs/governance/port-registry.md` for the exact line-range citation.
 *
 * ── Why this exists (CPS's incident, same upstream host) ──────────────
 * CPS's 2026-08-26 v8.3.0 release stalled here: MoboReels page 61
 * (pageSize=20, 1,200 cumulative rows) hit a stable HTTP 429. `pageSize=20,
 * 60 pages × 20 = 1,200` lines up exactly with the stop point, which means
 * the upstream limits by **request count** (~60/window), not by row count.
 * This adapter's host, `kocserver-cn.cdreader.com`
 * (see `src/lib/adapters/moboreader.ts:1`), is the same host CPS's
 * `changdu.ts` calls — so the same request-count ceiling applies here.
 *
 * The pre-fix CPS code walked pages back-to-back with zero delay, treated
 * 429 like any other error (threw immediately, no Retry-After, no
 * backoff/jitter, no retry), and a rerun always restarted from page 1 —
 * so it reliably re-hit the same wall. The fix ported here has three
 * independent parts:
 *   1. inter-request pacing (`createMoboreaderRateGate` — this file's
 *      module-level throttle door, wrapping every dispatch to this host);
 *   2. bounded retry with Retry-After / backoff+jitter for 429/503
 *      specifically (`computeRetryDelayMs`, `parseRetryAfter`,
 *      `canAffordRetry`, `MoboreaderRateLimitedError`);
 *   3. a caller-side resume-from-page contract, which MoboReader already
 *      has for free — `catalog_scan_task_item` is one row per page, so a
 *      `MoboreaderRateLimitedError`'s `pageIndex` is exactly the item a
 *      follow-up task needs to resume from. No new recovery machinery.
 *
 * ── Two-layer timeout, deliberately kept separate ──────────────────────
 * CPS's first hotfix (v8.3.1) shared one 15s timeout between a single HTTP
 * attempt *and* the retry-wait loop, so `Retry-After: 16` timed itself out
 * before it could finish waiting — the fix was broken in the exact case it
 * targeted. The contract here is the same as CPS's corrected version: each
 * HTTP attempt gets its own fresh timeout (unchanged, still 15_000ms — see
 * `MOBOREADER_DEFAULT_TIMEOUT_MS` in `./moboreader.ts`), and the retry
 * sequence as a whole is bounded separately by
 * `MOBOREADER_RATE_LIMIT_TOTAL_BUDGET_MS`. The two must never share a
 * clock. Callers integrating this module must build each HTTP attempt's
 * timeout independently of `canAffordRetry`'s budget check.
 */

// ── Rate-limit retry constants (defaults identical to CPS's CHANGDU_* values) ──

/** Minimum spacing between two requests to the upstream host. 60/window
 * observed; 1100ms ≈ 55/minute, ~8% margin under the threshold. */
export const MOBOREADER_MIN_REQUEST_INTERVAL_MS = 1_100;

/** Max retries for 429/503 specifically. Beyond this, the caller resumes
 * from `MoboreaderRateLimitedError.pageIndex`. */
export const MOBOREADER_MAX_RATE_LIMIT_RETRIES = 4;

/** Backoff base: attempt n waits BASE × 2^(n-1) plus jitter. */
export const MOBOREADER_BACKOFF_BASE_MS = 2_000;

/** Backoff ceiling — beyond this, failing the task and letting the
 * operator retry a fresh window is better than waiting longer. */
export const MOBOREADER_BACKOFF_CAP_MS = 60_000;

/** Trust ceiling for an upstream-supplied Retry-After. Longer than this,
 * fail instead of trusting it. */
export const MOBOREADER_RETRY_AFTER_CAP_MS = 120_000;

/**
 * Total budget for *all* retries of one logical request, kept separate
 * from the per-attempt HTTP timeout (see file header). 90s leaves enough
 * headroom under typical task/lease watchdogs for a page to fail cleanly
 * with its page number rather than trip a watchdog mid-wait.
 */
export const MOBOREADER_RATE_LIMIT_TOTAL_BUDGET_MS = 90_000;

/** Statuses that get backoff+retry under this policy. Every other status
 * keeps its immediate-failure semantics. */
export const MOBOREADER_RATE_LIMITED_STATUSES = new Set([429, 503]);

// ── Env overrides ───────────────────────────────────────────────────────
//
// CPS's own changdu-rate-limit.ts hardcodes these (no env layer). This
// port adds optional overrides, consistent with this repo's existing
// `resolveMoboreaderPreviewRuntimeConfig` pattern
// (`src/lib/tasks/moboreader.ts`) — defaults must equal the CPS values
// above; an invalid override fails fast rather than silently falling back.

export const MOBOREADER_UPSTREAM_RATE_LIMIT_ENV = Object.freeze({
  minRequestIntervalMs: "MOBOREADER_UPSTREAM_MIN_REQUEST_INTERVAL_MS",
  maxRateLimitRetries: "MOBOREADER_UPSTREAM_MAX_RATE_LIMIT_RETRIES",
  backoffBaseMs: "MOBOREADER_UPSTREAM_BACKOFF_BASE_MS",
  backoffCapMs: "MOBOREADER_UPSTREAM_BACKOFF_CAP_MS",
  retryAfterCapMs: "MOBOREADER_UPSTREAM_RETRY_AFTER_CAP_MS",
  totalBudgetMs: "MOBOREADER_UPSTREAM_RATE_LIMIT_BUDGET_MS",
});

export class MoboreaderRateLimitConfigError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MoboreaderRateLimitConfigError";
  }
}

export interface MoboreaderUpstreamRateLimitConfig {
  minRequestIntervalMs: number;
  maxRateLimitRetries: number;
  backoffBaseMs: number;
  backoffCapMs: number;
  retryAfterCapMs: number;
  totalBudgetMs: number;
}

function configuredPositiveInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  code: string,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new MoboreaderRateLimitConfigError(code);
  return parsed;
}

/** Resolves this module's constants with optional env overrides. Called
 * once by production wiring (worker handler construction); adapters
 * themselves never read `process.env` directly. */
export function resolveMoboreaderUpstreamRateLimitConfig(
  env: NodeJS.ProcessEnv = process.env,
): MoboreaderUpstreamRateLimitConfig {
  return Object.freeze({
    minRequestIntervalMs: configuredPositiveInteger(
      env, MOBOREADER_UPSTREAM_RATE_LIMIT_ENV.minRequestIntervalMs,
      MOBOREADER_MIN_REQUEST_INTERVAL_MS, "upstream_min_request_interval_invalid",
    ),
    maxRateLimitRetries: configuredPositiveInteger(
      env, MOBOREADER_UPSTREAM_RATE_LIMIT_ENV.maxRateLimitRetries,
      MOBOREADER_MAX_RATE_LIMIT_RETRIES, "upstream_max_rate_limit_retries_invalid",
    ),
    backoffBaseMs: configuredPositiveInteger(
      env, MOBOREADER_UPSTREAM_RATE_LIMIT_ENV.backoffBaseMs,
      MOBOREADER_BACKOFF_BASE_MS, "upstream_backoff_base_invalid",
    ),
    backoffCapMs: configuredPositiveInteger(
      env, MOBOREADER_UPSTREAM_RATE_LIMIT_ENV.backoffCapMs,
      MOBOREADER_BACKOFF_CAP_MS, "upstream_backoff_cap_invalid",
    ),
    retryAfterCapMs: configuredPositiveInteger(
      env, MOBOREADER_UPSTREAM_RATE_LIMIT_ENV.retryAfterCapMs,
      MOBOREADER_RETRY_AFTER_CAP_MS, "upstream_retry_after_cap_invalid",
    ),
    totalBudgetMs: configuredPositiveInteger(
      env, MOBOREADER_UPSTREAM_RATE_LIMIT_ENV.totalBudgetMs,
      MOBOREADER_RATE_LIMIT_TOTAL_BUDGET_MS, "upstream_rate_limit_budget_invalid",
    ),
  });
}

// ── Retry-After parsing ─────────────────────────────────────────────────

/**
 * Parses `Retry-After` per RFC 9110: either delta-seconds (`"120"`) or an
 * HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`).
 *
 * The HTTP-date branch must check for a letter *before* calling
 * `Date.parse` — `Date.parse("-5")` returns a valid (year-interpreted)
 * timestamp for input that is actually just a malformed delta-seconds
 * value. Without the shape guard, `Retry-After: -5` would parse as a date
 * far in the past, produce a negative delta, get clamped to 0, and the
 * caller would retry *immediately* — the one behavior a rate-limit
 * response must never trigger. An HTTP-date always contains a letter
 * (month/weekday/timezone name); delta-seconds never does.
 *
 * @param now Injected (not `Date.now()`) so callers can pin it in tests.
 */
export function parseRetryAfter(
  headerValue: string | null | undefined,
  now: number,
  capMs: number = MOBOREADER_RETRY_AFTER_CAP_MS,
): number | null {
  if (typeof headerValue !== "string") return null;
  const raw = headerValue.trim();
  if (raw.length === 0) return null;

  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return Math.min(seconds * 1_000, capMs);
  }

  if (!/[A-Za-z]/.test(raw)) return null;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  const delta = at - now;
  if (delta <= 0) return 0;
  return Math.min(delta, capMs);
}

// ── Backoff + jitter ─────────────────────────────────────────────────────

/**
 * Delay before the next retry. An upstream-supplied Retry-After is
 * authoritative (plus a little jitter so concurrent callers don't all
 * wake at the same instant); otherwise exponential backoff with full
 * jitter (`[cap/2, cap]`) — needed because a fixed backoff would land
 * every retrying caller back on the rate-limit window at the same moment.
 *
 * @param random Injected (not `Math.random()`) so callers can pin it in
 *   tests.
 */
export function computeRetryDelayMs(input: {
  attempt: number;
  retryAfterMs: number | null;
  random: () => number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
}): number {
  if (input.retryAfterMs !== null) {
    const jitter = Math.floor(input.retryAfterMs * 0.1 * input.random());
    return input.retryAfterMs + jitter;
  }
  const base = input.backoffBaseMs ?? MOBOREADER_BACKOFF_BASE_MS;
  const cap = input.backoffCapMs ?? MOBOREADER_BACKOFF_CAP_MS;
  const exponential = base * 2 ** Math.max(0, input.attempt - 1);
  const capped = Math.min(exponential, cap);
  return Math.floor(capped / 2 + (capped / 2) * input.random());
}

/**
 * Whether the next retry still fits inside the total budget. Checked
 * *before* sleeping — sleeping first and failing afterward would waste
 * exactly the time this check exists to save.
 */
export function canAffordRetry(input: {
  elapsedMs: number;
  delayMs: number;
  budgetMs?: number;
}): boolean {
  const budget = input.budgetMs ?? MOBOREADER_RATE_LIMIT_TOTAL_BUDGET_MS;
  return input.elapsedMs + input.delayMs <= budget;
}

// ── Exhaustion error ─────────────────────────────────────────────────────

export type MoboreaderRateLimitGiveUpReason =
  /** Retry count exhausted. */
  | "max_attempts"
  /** Under the attempt ceiling, but the next wait would exceed the budget. */
  | "budget_exhausted";

export class MoboreaderRateLimitedError extends Error {
  readonly status: number;
  /** Upstream-requested wait; `null` if none was supplied. */
  readonly retryAfterMs: number | null;
  /** The page this request was for, so the caller can resume a follow-up
   * scan from here. `null` for non-paginated endpoints (material/chapter
   * reads, claim readback). */
  readonly pageIndex: number | null;
  /** Which MoboReader endpoint this was (`MOBOREADER_READ_ENDPOINTS.*`). */
  readonly endpoint: string;
  /** Retries actually performed before giving up. */
  readonly attempts: number;
  /** Wall-clock time spent retrying this one logical request. */
  readonly elapsedMs: number;
  readonly reason: MoboreaderRateLimitGiveUpReason;

  constructor(input: {
    status: number;
    retryAfterMs: number | null;
    pageIndex: number | null;
    endpoint: string;
    attempts: number;
    elapsedMs: number;
    reason: MoboreaderRateLimitGiveUpReason;
  }) {
    super(
      `MoboReader upstream rate limited: HTTP ${input.status} on ${input.endpoint}` +
        ` (retried ${input.attempts} time(s), ` +
        `${input.reason === "budget_exhausted" ? "retry budget exhausted" : "max rate-limit retries exhausted"}` +
        `${input.retryAfterMs !== null ? `, upstream requested ${input.retryAfterMs}ms` : ""}` +
        `${input.pageIndex !== null ? `, stopped at page ${input.pageIndex}` : ""}` +
        `, elapsed ${input.elapsedMs}ms)`,
    );
    this.name = "MoboreaderRateLimitedError";
    this.status = input.status;
    this.retryAfterMs = input.retryAfterMs;
    this.pageIndex = input.pageIndex;
    this.endpoint = input.endpoint;
    this.attempts = input.attempts;
    this.elapsedMs = input.elapsedMs;
    this.reason = input.reason;
  }
}

// ── Process-wide throttle door ───────────────────────────────────────────
//
// CPS enforces its per-page 1100ms gap with a single `await sleep(...)` in
// its serial page loop (`worker/handlers/changdu-source-sync.ts:690`),
// which is enough because that loop is the only caller. MoboReader's
// upstream is called from three independent worker code paths — catalog
// scan, Preview refresh, and promo-link claim/readback — that can be
// in flight at once (`MOBOREADER_PREVIEW_CONCURRENCY` reserves room for
// >1 concurrent Preview items even though nothing drives concurrent
// item claims yet — see `docs/governance/port-registry.md`), so the gap
// must be enforced by one shared, mutex-ordered gate instead of a
// per-loop `sleep`.

export interface MoboreaderRateGate {
  /** Resolves once it is this caller's turn to dispatch — i.e. once at
   * least `minIntervalMs` has passed since the previous caller's
   * `wait()` resolved. Concurrent callers queue in call order. */
  wait(): Promise<void>;
}

export interface CreateMoboreaderRateGateOptions {
  minIntervalMs?: number;
  /** Injected clock, for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Injected sleep, for tests — must actually advance whatever clock
   * `now` reads, or the gate cannot be meaningfully tested (see
   * `tests/backend/adapters/moboreader-rate-limit.test.ts`). Defaults to
   * a real `setTimeout`. */
  sleep?: (milliseconds: number) => Promise<void>;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createMoboreaderRateGate(
  options: CreateMoboreaderRateGateOptions = {},
): MoboreaderRateGate {
  const minIntervalMs = options.minIntervalMs ?? MOBOREADER_MIN_REQUEST_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  let lastDispatchAt: number | null = null;
  // FIFO mutex: without this, two concurrent `wait()` calls would each
  // independently read the same `lastDispatchAt`, compute the same
  // "earliest allowed" instant, and both dispatch at once — exactly the
  // race the gate exists to prevent. Chaining onto `queueTail` forces the
  // second caller's computation to happen only after the first caller's
  // wait (and dispatch-time bookkeeping) has fully completed.
  let queueTail: Promise<void> = Promise.resolve();

  function wait(): Promise<void> {
    const ticket = queueTail.then(async () => {
      const currentMs = now();
      const earliestMs = lastDispatchAt === null ? currentMs : lastDispatchAt + minIntervalMs;
      const waitMs = Math.max(0, earliestMs - currentMs);
      if (waitMs > 0) await sleep(waitMs);
      lastDispatchAt = now();
    });
    // A rejected ticket (a broken `sleep`/`now` injection) must not wedge
    // every later caller behind a permanently-rejected queue tail.
    queueTail = ticket.catch(() => {});
    return ticket;
  }

  return { wait };
}

/** Always-ready gate. Default for both adapter factories so constructing
 * them with no options (as every existing unit test does) adds zero
 * latency and makes zero extra calls — only production wiring
 * (`worker/handlers/moboreader.ts`, `worker/handlers/promo-link-claim.ts`)
 * passes the real `moboreaderUpstreamRateGate` below. */
export const NOOP_MOBOREADER_RATE_GATE: MoboreaderRateGate = Object.freeze({
  wait: () => Promise.resolve(),
});

function resolvedSingletonMinIntervalMs(): number {
  try {
    return resolveMoboreaderUpstreamRateLimitConfig(process.env).minRequestIntervalMs;
  } catch {
    // The module-load singleton must never crash process startup on a
    // malformed env value; explicit `resolveMoboreaderUpstreamRateLimitConfig`
    // call sites still fail fast for operator-facing validation.
    return MOBOREADER_MIN_REQUEST_INTERVAL_MS;
  }
}

/**
 * Shared process-wide gate. One instance for the whole worker process —
 * every production call site imports this same binding so catalog scan,
 * Preview refresh, and promo-link claim/readback all pace against one
 * shared clock, regardless of which task family issued the request.
 */
export const moboreaderUpstreamRateGate: MoboreaderRateGate = createMoboreaderRateGate({
  minIntervalMs: resolvedSingletonMinIntervalMs(),
});
