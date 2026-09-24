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

/**
 * RC-4 (per-endpoint rate gate, 阶段 4-A): the breakdown a gate's `wait()`
 * may resolve with, so an adapter's `upstream_call` observation event can
 * report `endpointGateWaitMs` / `hostGateWaitMs` / `remainingBeforeDispatch`
 * without the adapter needing to know which kind of gate it was handed.
 * The legacy single-queue gate (`createMoboreaderRateGate`) reports its
 * entire wait as `endpointGateWaitMs` with `hostGateWaitMs: 0` and
 * `remainingBeforeDispatch: null` (it has no per-endpoint or adaptive
 * concept); `createMoboreaderPerEndpointRateGate` reports the real split.
 */
export interface MoboreaderRateGateWaitInfo {
  /** Wait attributable to this endpoint's own FIFO spacing (interval,
   * remaining-quota floor pause, 429 cooldown). */
  endpointGateWaitMs: number;
  /** Wait attributable to the host-level minimum gap between ANY two
   * dispatches, regardless of endpoint (design §5.1's "主机级防突发间隔").
   * `0` for a gate that doesn't enforce one. */
  hostGateWaitMs: number;
  /** This endpoint's locally-tracked `x-ratelimit-remaining` shadow
   * immediately before this dispatch was allowed to proceed (captured
   * before any floor-pause bookkeeping resets it). `null` when never
   * observed, or the gate doesn't track it. */
  remainingBeforeDispatch: number | null;
}

export interface MoboreaderRateGateObserveInfo {
  httpStatus: number;
  /**
   * Allowlisted response headers exactly as
   * `extractGatewayObservationHeaders` produced them for the very same
   * dispatch this `observe()` call reports on — never re-read from a raw
   * `Headers` object here, so the redaction boundary
   * (`./upstream-observation.ts`) has exactly one place, not two.
   */
  gatewayHeaders: Readonly<Record<string, string>>;
}

export interface MoboreaderRateGate {
  /** Resolves once it is this caller's turn to dispatch — i.e. once at
   * least `minIntervalMs` has passed since the previous caller's
   * `wait()` resolved. Concurrent callers queue in call order.
   *
   * RC-4: `endpoint` is optional so every pre-existing caller/test that
   * calls `wait()` with no argument keeps working unmodified; a gate that
   * doesn't distinguish endpoints (`createMoboreaderRateGate`) simply
   * ignores it. The resolved value is also optional-shaped (`void` is a
   * valid resolution) for the same reason — nothing pre-existing reads
   * it. */
  wait(endpoint?: string): Promise<MoboreaderRateGateWaitInfo | void>;
  /**
   * RC-4: optional feedback hook so a per-endpoint gate can adapt to the
   * upstream gateway's own rate-limit headers (see
   * `createMoboreaderPerEndpointRateGate`). Absent on gates that don't
   * support it (the legacy single-queue gate, the no-op gate) — callers
   * must invoke this via `?.()`, never assume it exists.
   */
  observe?(endpoint: string, info: MoboreaderRateGateObserveInfo): void;
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

  function wait(_endpoint?: string): Promise<MoboreaderRateGateWaitInfo> {
    // `_endpoint` is intentionally unused: this gate is the pre-RC-4
    // single-queue door and makes no per-endpoint distinction — see the
    // interface doc comment on `MoboreaderRateGate.wait`.
    const ticket = queueTail.then(async (): Promise<MoboreaderRateGateWaitInfo> => {
      const currentMs = now();
      const earliestMs = lastDispatchAt === null ? currentMs : lastDispatchAt + minIntervalMs;
      const waitMs = Math.max(0, earliestMs - currentMs);
      if (waitMs > 0) await sleep(waitMs);
      lastDispatchAt = now();
      return { endpointGateWaitMs: waitMs, hostGateWaitMs: 0, remainingBeforeDispatch: null };
    });
    // A rejected ticket (a broken `sleep`/`now` injection) must not wedge
    // every later caller behind a permanently-rejected queue tail. Unlike
    // the pre-RC-4 `.catch(() => {})`, this must not forward `ticket`'s
    // resolved value (now an object, not `undefined`) onto `queueTail`,
    // which is typed `Promise<void>` and only ever used to chain — hence
    // `.then(() => undefined, () => undefined)` instead of `.catch`.
    queueTail = ticket.then(() => undefined, () => undefined);
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

// ── RC-4: per-endpoint rate gate (阶段 4-A, 设计 §5) ─────────────────────
//
// Everything above this point is the pre-RC-4 single shared queue,
// unmodified in behavior. This section adds an *opt-in* alternative: one
// FIFO queue per upstream endpoint (today just `getlistpc`/`getcode`; every
// other endpoint keeps sharing the legacy single interval), plus a
// host-level minimum gap between ANY two dispatches, plus an adaptive
// per-endpoint pause once the gateway's own `x-ratelimit-remaining` shadow
// drops to a configured floor. Switch default is OFF; off means the
// process-wide singleton below is built exactly as it always was (see
// `buildProductionMoboreaderRateGate`) — see design §5.6/§9.1 item 1 for
// the "byte-identical when disabled" requirement this exists to satisfy.

/** The only two endpoints this design tunes individually — the upstream
 * gateway's `x-ratelimit-limit: 60` is observed (design §三) only on
 * these two paths. Every other endpoint (`getbydataid`/`getchapterinfo`)
 * keeps sharing `defaultIntervalMs` (the legacy single interval), unchanged
 * — their gateway limits have never been observed (design §5.3). */
export const MOBOREADER_RATE_GATE_TRACKED_ENDPOINTS = Object.freeze(["getlistpc", "getcode"] as const);
export type MoboreaderTrackedRateGateEndpoint = (typeof MOBOREADER_RATE_GATE_TRACKED_ENDPOINTS)[number];

function isTrackedRateGateEndpoint(endpoint: string): endpoint is MoboreaderTrackedRateGateEndpoint {
  return (MOBOREADER_RATE_GATE_TRACKED_ENDPOINTS as readonly string[]).includes(endpoint);
}

/** Structured events for `rate_gate.*` observability (design §7.1). Each
 * variant carries only numbers/short strings — never a header value beyond
 * what's already allowlisted by `extractGatewayObservationHeaders`, and
 * never a request/response body. */
export type MoboreaderRateGateEvent =
  | { type: "floor_pause"; endpoint: string; remaining: number; floor: number; waitMs: number }
  | { type: "cooldown"; endpoint: string; status: number; waitMs: number }
  | { type: "headers_missing"; endpoint: string };

export type OnMoboreaderRateGateEvent = (event: MoboreaderRateGateEvent) => void;

/** Default for `createMoboreaderPerEndpointRateGate`, so constructing it
 * directly in a test (as every unit test in
 * `tests/backend/adapters/moboreader-per-endpoint-rate-gate.test.ts` does)
 * emits nothing unless the test explicitly asks for events. Only the
 * production singleton below wires a real sink. */
export const NOOP_MOBOREADER_RATE_GATE_EVENT: OnMoboreaderRateGateEvent = () => {};

interface EndpointShadowState {
  lastDispatchAt: number | null;
  /** Last observed `x-ratelimit-remaining` for this endpoint, or `null` if
   * never observed (or the last observation didn't carry it). */
  remaining: number | null;
  /** Absolute ms epoch this endpoint's rate-limit window is believed to
   * reset at, derived from `x-ratelimit-reset` — best-effort (see
   * `observe`'s doc comment on why this is deliberately conservative). */
  windowResetAt: number | null;
  /** When `remaining` first dropped to/below the floor, for the "distance
   * to 60s from first observed low-remaining" fallback (design §5.2.1). */
  floorHitAt: number | null;
  /** Absolute ms epoch a 429 cooldown lasts until, or `null`. */
  cooldownUntil: number | null;
  lastCooldownStatus: number | null;
}

function freshEndpointShadowState(): EndpointShadowState {
  return {
    lastDispatchAt: null,
    remaining: null,
    windowResetAt: null,
    floorHitAt: null,
    cooldownUntil: null,
    lastCooldownStatus: null,
  };
}

export interface CreateMoboreaderPerEndpointRateGateOptions {
  /** Per-endpoint minimum spacing for the two tracked endpoints. */
  endpointIntervalMs: Readonly<Record<MoboreaderTrackedRateGateEndpoint, number>>;
  /** Interval for every other (untracked) endpoint — the legacy
   * single-interval semantics, unchanged. */
  defaultIntervalMs: number;
  /** Minimum spacing between ANY two dispatches, regardless of endpoint
   * (design §5.1's "主机级防突发间隔"). */
  hostMinGapMs: number;
  /** Remaining-quota floor per tracked endpoint; once the shadow
   * `remaining` count is at or below this, the endpoint pauses until the
   * window is believed to have reset. */
  remainingFloor: Readonly<Record<MoboreaderTrackedRateGateEndpoint, number>>;
  /** Ceiling on any single floor-pause or 429-cooldown wait (design §5.2
   * item 1 / §5.4's "429 冷却 / 窗口重置上限"). */
  rateWindowMaxWaitMs: number;
  /** Injected clock, for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Injected sleep, for tests — must actually advance whatever clock
   * `now` reads (same requirement as `createMoboreaderRateGate`). */
  sleep?: (milliseconds: number) => Promise<void>;
  onEvent?: OnMoboreaderRateGateEvent;
}

/**
 * RC-4 per-endpoint rate gate (design §5.1–§5.3). A single global FIFO
 * mutex (not one queue per endpoint) serializes every `wait()` call
 * regardless of endpoint — this is deliberate, not an accidental
 * bottleneck: the worker process dispatches MoboReader requests strictly
 * serially today (design §5.3: catalog scan and promo-link claim never run
 * concurrently), so a single mutex costs nothing in practice while making
 * the host-level gap trivially correct (no race between two independent
 * per-endpoint queues each computing "is 250ms since the last dispatch,
 * from ANY endpoint, satisfied?" against a value the other might be
 * updating at the same instant).
 *
 * Each turn computes an "earliest allowed" instant for the requesting
 * endpoint (its own interval, extended by any active floor-pause or 429
 * cooldown) and a separate "earliest allowed" instant for the host gap
 * (shared across all endpoints), then waits for whichever is later. Both
 * of these only ever push the instant later — never earlier — matching
 * design §5.4's "两层都是只减速不加速".
 */
export function createMoboreaderPerEndpointRateGate(
  options: CreateMoboreaderPerEndpointRateGateOptions,
): MoboreaderRateGate {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const onEvent = options.onEvent ?? NOOP_MOBOREADER_RATE_GATE_EVENT;
  const endpointStates = new Map<string, EndpointShadowState>();
  let lastAnyDispatchAt: number | null = null;
  // Single global FIFO mutex — see doc comment above for why this is
  // deliberate rather than per-endpoint.
  let queueTail: Promise<void> = Promise.resolve();

  function stateFor(endpoint: string): EndpointShadowState {
    let state = endpointStates.get(endpoint);
    if (!state) {
      state = freshEndpointShadowState();
      endpointStates.set(endpoint, state);
    }
    return state;
  }

  function intervalFor(endpoint: string): number {
    return isTrackedRateGateEndpoint(endpoint) ? options.endpointIntervalMs[endpoint] : options.defaultIntervalMs;
  }

  function floorFor(endpoint: string): number | null {
    return isTrackedRateGateEndpoint(endpoint) ? options.remainingFloor[endpoint] : null;
  }

  function wait(endpointInput?: string): Promise<MoboreaderRateGateWaitInfo> {
    const endpoint = endpointInput ?? "__untracked__";
    const ticket = queueTail.then(async (): Promise<MoboreaderRateGateWaitInfo> => {
      const state = stateFor(endpoint);
      const remainingSnapshot = state.remaining;
      const intervalMs = intervalFor(endpoint);
      const floor = floorFor(endpoint);
      const currentMs = now();

      let endpointEarliestMs = state.lastDispatchAt === null ? currentMs : state.lastDispatchAt + intervalMs;

      // 429 cooldown: extend this endpoint's earliest-allowed instant
      // (never shortens it — `Math.max`).
      if (state.cooldownUntil !== null) {
        endpointEarliestMs = Math.max(endpointEarliestMs, state.cooldownUntil);
      }

      // Remaining-quota floor pause (design §5.2 item 1): only engages
      // once we've actually *observed* a remaining count at/under the
      // floor — never fabricated from silence (§5.2 item 5).
      let floorPauseActive = false;
      if (floor !== null && remainingSnapshot !== null && remainingSnapshot <= floor) {
        floorPauseActive = true;
        const hitAt = state.floorHitAt ?? currentMs;
        const hardCapAt = hitAt + options.rateWindowMaxWaitMs;
        const resetAt = state.windowResetAt !== null ? Math.min(state.windowResetAt, hardCapAt) : hardCapAt;
        endpointEarliestMs = Math.max(endpointEarliestMs, resetAt);
      }

      const hostEarliestMs = lastAnyDispatchAt === null ? currentMs : lastAnyDispatchAt + options.hostMinGapMs;

      const endpointWaitMs = Math.max(0, endpointEarliestMs - currentMs);
      const hostWaitMs = Math.max(0, hostEarliestMs - currentMs);
      const totalWaitMs = Math.max(endpointWaitMs, hostWaitMs);

      if (floorPauseActive && endpointWaitMs > 0) {
        onEvent({
          type: "floor_pause",
          endpoint,
          remaining: remainingSnapshot as number,
          floor: floor as number,
          waitMs: endpointWaitMs,
        });
      }

      if (totalWaitMs > 0) await sleep(totalWaitMs);

      const dispatchAt = now();
      state.lastDispatchAt = dispatchAt;
      lastAnyDispatchAt = dispatchAt;
      // Once we've waited out our own floor-pause estimate, clear it —
      // otherwise a conservative (or wrong) estimate could re-trigger
      // forever with no new information. The next `observe()` call
      // supplies fresh truth; until then this endpoint is treated as
      // "unknown", never as "known-fine" (§5.2 item 5: silence never
      // accelerates).
      if (floorPauseActive) {
        state.remaining = null;
        state.windowResetAt = null;
        state.floorHitAt = null;
      }
      if (state.cooldownUntil !== null && dispatchAt >= state.cooldownUntil) {
        state.cooldownUntil = null;
      }

      return {
        endpointGateWaitMs: endpointWaitMs,
        hostGateWaitMs: hostWaitMs,
        remainingBeforeDispatch: remainingSnapshot,
      };
    });
    queueTail = ticket.then(() => undefined, () => undefined);
    return ticket;
  }

  const REMAINING_HEADER = "x-ratelimit-remaining";
  const RESET_HEADER = "x-ratelimit-reset";
  const RETRY_AFTER_HEADER = "retry-after";

  function parseNonNegativeIntegerHeader(raw: string | undefined): number | null {
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  function observe(endpoint: string, info: MoboreaderRateGateObserveInfo): void {
    const state = stateFor(endpoint);
    const floor = floorFor(endpoint);
    const parsedRemaining = parseNonNegativeIntegerHeader(info.gatewayHeaders[REMAINING_HEADER]);

    if (parsedRemaining === null) {
      // §5.2 item 5: missing/unparsable header = "no information" — never
      // treated as either "plenty of quota" or "out of quota". Only worth
      // an event for endpoints this gate actually adapts on.
      if (floor !== null) onEvent({ type: "headers_missing", endpoint });
    } else {
      const wasAboveFloorOrUnknown = floor === null || state.remaining === null || state.remaining > floor;
      state.remaining = parsedRemaining;
      if (floor !== null) {
        if (parsedRemaining <= floor) {
          if (wasAboveFloorOrUnknown) state.floorHitAt = now();
        } else {
          // Recovered above the floor — clear stale reset bookkeeping so a
          // later dip starts its own fresh 60s ceiling instead of reusing
          // a stale `floorHitAt`.
          state.floorHitAt = null;
          state.windowResetAt = null;
        }
      }
    }

    // `x-ratelimit-reset`'s exact semantics (relative seconds vs.
    // something else) are, per design §5.2, meant to be pinned by a
    // read-only analysis of real `upstream_call` logs before/alongside
    // rollout — not by this port. Interpreted here as "seconds remaining
    // in the current window" (the common Kong convention, and consistent
    // with design §5.2's "随每次请求后移" observation), but the
    // `rateWindowMaxWaitMs` cap in `wait()` above bounds the damage of a
    // wrong interpretation to "waits up to 60s longer than strictly
    // necessary" — never less, never a crash.
    const parsedResetSeconds = parseNonNegativeIntegerHeader(info.gatewayHeaders[RESET_HEADER]);
    if (parsedResetSeconds !== null) {
      state.windowResetAt = now() + parsedResetSeconds * 1_000;
    }

    if (info.httpStatus === 429) {
      const parsedRetryAfterMs = parseRetryAfter(
        info.gatewayHeaders[RETRY_AFTER_HEADER] ?? null,
        now(),
        options.rateWindowMaxWaitMs,
      );
      const waitMs = parsedRetryAfterMs ?? options.rateWindowMaxWaitMs;
      state.cooldownUntil = now() + waitMs;
      state.lastCooldownStatus = info.httpStatus;
      onEvent({ type: "cooldown", endpoint, status: info.httpStatus, waitMs });
    }
  }

  return { wait, observe };
}

/**
 * Total switch for RC-4's per-endpoint gate (design §5.4/§十三). Strict
 * `=== "true"` — any other value (including case variants, `"1"`, or
 * unset) is `false` — same convention as `isPromoClaimLifecycleEnabled`
 * (`src/lib/tasks/promo-claim-lifecycle.ts`) and this repo's feature-flag
 * module: code defaults closed, and a typo in the env value never
 * silently *enables* new behavior. `scripts/preproduction/lib.sh`'s
 * preflight gate is independently stricter (rejects anything other than
 * exactly `true`/`false`/unset) so a typo is caught at deploy time instead
 * of silently resolving to "disabled" here.
 */
export function isMoboreaderPerEndpointRateGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENV.enabled] === "true";
}

export const MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENV = Object.freeze({
  enabled: "MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENABLED",
  intervalGetlistpc: "MOBOREADER_UPSTREAM_MIN_REQUEST_INTERVAL_MS__GETLISTPC",
  intervalGetcode: "MOBOREADER_UPSTREAM_MIN_REQUEST_INTERVAL_MS__GETCODE",
  hostMinGapMs: "MOBOREADER_UPSTREAM_HOST_MIN_GAP_MS",
  remainingFloorGetlistpc: "MOBOREADER_UPSTREAM_REMAINING_FLOOR__GETLISTPC",
  remainingFloorGetcode: "MOBOREADER_UPSTREAM_REMAINING_FLOOR__GETCODE",
  rateWindowMaxWaitMs: "MOBOREADER_UPSTREAM_RATE_WINDOW_MAX_WAIT_MS",
});

export const MOBOREADER_PER_ENDPOINT_RATE_GATE_DEFAULTS = Object.freeze({
  /** design §5.4/E2: recommended per-endpoint interval once the switch is
   * on. This is a hardcoded default for when the specific
   * `__GETLISTPC`/`__GETCODE` variable is unset — it does *not* fall back
   * to `MOBOREADER_UPSTREAM_MIN_REQUEST_INTERVAL_MS` (that variable is
   * `defaultIntervalMs`, used only by untracked endpoints; see this
   * file's module doc / the task report for the rollout note about
   * setting both explicitly to 1500 for the first 24h). */
  intervalMs: 1_200,
  hostMinGapMs: 250,
  remainingFloorGetlistpc: 8,
  remainingFloorGetcode: 12,
  rateWindowMaxWaitMs: 60_000,
});

/**
 * Domain safety floor for a per-endpoint interval once the switch is on
 * (design §5.6: "每个接口的间隔必须 ≥ 1,000 ms ... 防止手误把间隔配成
 * 120"). Enforced here (fails the whole handler closed at construction —
 * consistent with this file's existing "fail fast on invalid config"
 * convention for `resolveMoboreaderUpstreamRateLimitConfig`) *and*,
 * independently, by `scripts/preproduction/lib.sh`'s preflight gate before
 * a deploy ever reaches this code — two layers, same number, so a
 * misconfigured value can never reach production even if some future
 * caller constructs the gate without going through preflight.
 */
export const MOBOREADER_PER_ENDPOINT_INTERVAL_FLOOR_MS = 1_000;

export interface MoboreaderPerEndpointRateGateConfig {
  readonly enabled: boolean;
  readonly endpointIntervalMs: Readonly<Record<MoboreaderTrackedRateGateEndpoint, number>>;
  readonly defaultIntervalMs: number;
  readonly hostMinGapMs: number;
  readonly remainingFloor: Readonly<Record<MoboreaderTrackedRateGateEndpoint, number>>;
  readonly rateWindowMaxWaitMs: number;
}

function perEndpointIntervalConfig(env: NodeJS.ProcessEnv, key: string, code: string): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return MOBOREADER_PER_ENDPOINT_RATE_GATE_DEFAULTS.intervalMs;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < MOBOREADER_PER_ENDPOINT_INTERVAL_FLOOR_MS) {
    throw new MoboreaderRateLimitConfigError(code);
  }
  return parsed;
}

function nonNegativeIntegerConfig(env: NodeJS.ProcessEnv, key: string, fallback: number, code: string): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new MoboreaderRateLimitConfigError(code);
  return parsed;
}

function positiveIntegerConfig(env: NodeJS.ProcessEnv, key: string, fallback: number, code: string): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new MoboreaderRateLimitConfigError(code);
  return parsed;
}

/**
 * Resolves RC-4's per-endpoint config with optional env overrides. Called
 * once by production wiring (this module's own singleton below) and by
 * `scripts/preproduction/lib.sh`'s preflight gate's TS-parity double-run
 * tests; adapters themselves never read `process.env` directly (unchanged
 * convention).
 */
export function resolveMoboreaderPerEndpointRateGateConfig(
  env: NodeJS.ProcessEnv = process.env,
): Readonly<MoboreaderPerEndpointRateGateConfig> {
  const ENV = MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENV;
  const D = MOBOREADER_PER_ENDPOINT_RATE_GATE_DEFAULTS;
  const getlistpc = perEndpointIntervalConfig(env, ENV.intervalGetlistpc, "per_endpoint_interval_getlistpc_invalid");
  const getcode = perEndpointIntervalConfig(env, ENV.intervalGetcode, "per_endpoint_interval_getcode_invalid");
  const hostMinGapMs = nonNegativeIntegerConfig(env, ENV.hostMinGapMs, D.hostMinGapMs, "per_endpoint_host_min_gap_invalid");
  const remainingFloorGetlistpc = nonNegativeIntegerConfig(
    env, ENV.remainingFloorGetlistpc, D.remainingFloorGetlistpc, "per_endpoint_remaining_floor_getlistpc_invalid",
  );
  const remainingFloorGetcode = nonNegativeIntegerConfig(
    env, ENV.remainingFloorGetcode, D.remainingFloorGetcode, "per_endpoint_remaining_floor_getcode_invalid",
  );
  const rateWindowMaxWaitMs = positiveIntegerConfig(
    env, ENV.rateWindowMaxWaitMs, D.rateWindowMaxWaitMs, "per_endpoint_rate_window_max_wait_invalid",
  );
  // Untracked endpoints (getbydataid/getchapterinfo) keep the legacy
  // shared interval, unchanged — design §5.3: their gateway limits were
  // never observed and are out of this design's tuning scope.
  const defaultIntervalMs = resolveMoboreaderUpstreamRateLimitConfig(env).minRequestIntervalMs;
  return Object.freeze({
    enabled: isMoboreaderPerEndpointRateGateEnabled(env),
    endpointIntervalMs: Object.freeze({ getlistpc, getcode }),
    defaultIntervalMs,
    hostMinGapMs,
    remainingFloor: Object.freeze({ getlistpc: remainingFloorGetlistpc, getcode: remainingFloorGetcode }),
    rateWindowMaxWaitMs,
  });
}

/**
 * Production-only JSON console sink for `rate_gate.*` events (design
 * §7.1), colocated here (rather than in `worker/observability/
 * upstream-call-log.ts`) specifically so the module-load singleton below
 * can wire it in without this shared/framework-agnostic `src/lib/adapters`
 * module importing anything from `worker/*` — no other file in `src/lib`
 * does, and this file's existing singleton (`resolvedSingletonMinIntervalMs`)
 * already reads `process.env` directly for the same "self-contained
 * production wiring" reason. Never throws — a logging failure must never
 * surface as a rate-gate failure.
 */
function defaultMoboreaderRateGateEventSink(event: MoboreaderRateGateEvent): void {
  try {
    const { type, ...rest } = event;
    console.log(JSON.stringify({ schemaVersion: 1, event: `rate_gate.${type}`, ...rest }));
  } catch {
    // Deliberately silent — see doc comment above.
  }
}

function buildProductionMoboreaderRateGate(): MoboreaderRateGate {
  const env = process.env;
  if (!isMoboreaderPerEndpointRateGateEnabled(env)) {
    // Switch off: construct the exact same single shared gate as before
    // RC-4 — byte-identical behavior (design §9.1 item 1).
    return createMoboreaderRateGate({ minIntervalMs: resolvedSingletonMinIntervalMs() });
  }
  try {
    const config = resolveMoboreaderPerEndpointRateGateConfig(env);
    return createMoboreaderPerEndpointRateGate({
      endpointIntervalMs: config.endpointIntervalMs,
      defaultIntervalMs: config.defaultIntervalMs,
      hostMinGapMs: config.hostMinGapMs,
      remainingFloor: config.remainingFloor,
      rateWindowMaxWaitMs: config.rateWindowMaxWaitMs,
      onEvent: defaultMoboreaderRateGateEventSink,
    });
  } catch {
    // The module-load singleton must never crash process startup on a
    // malformed env value (mirrors `resolvedSingletonMinIntervalMs`
    // above) — but note this means a config typo with the switch ON
    // silently falls back to the *legacy shared gate*, not to per-endpoint
    // defaults. `resolveMoboreaderPerEndpointRateGateConfig` and
    // `scripts/preproduction/lib.sh`'s preflight gate both still fail
    // fast for operator-facing validation before a bad value ever reaches
    // this fallback.
    return createMoboreaderRateGate({ minIntervalMs: resolvedSingletonMinIntervalMs() });
  }
}

/**
 * Shared process-wide gate. One instance for the whole worker process —
 * every production call site imports this same binding so catalog scan,
 * Preview refresh, and promo-link claim/readback all pace against one
 * shared clock, regardless of which task family issued the request.
 *
 * RC-4: which *kind* of gate this is (legacy single-queue vs. per-endpoint)
 * is decided once here, at module load, from
 * `MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENABLED` — see
 * `buildProductionMoboreaderRateGate`. The three production construction
 * sites (`worker/handlers/moboreader.ts` ×2, `worker/handlers/
 * promo-link-claim.ts` ×1) are unchanged: they still just inject this same
 * binding.
 */
export const moboreaderUpstreamRateGate: MoboreaderRateGate = buildProductionMoboreaderRateGate();
