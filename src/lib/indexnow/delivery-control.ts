/**
 * IndexNow delivery control plane (B-41): the delivery breaker, the global
 * HTTP-429 wait, and the bisect record — all expressed as an append-only
 * **control event stream** on `operation_audit`, with zero migration.
 *
 * Shared by the minute sweep (`sweep.ts`), the batch delivery handler
 * (`worker/handlers/indexnow-delivery.ts`), the backfill apply stop
 * conditions and the `indexnow-status` / `indexnow-delivery-resume` commands.
 *
 * ## Why an event stream and not "derive it from attempt rows"
 *
 * A first design derived the breaker from `indexnow_outbox_attempt` rows
 * (`http_status IN (400,403,422)` since a watermark attempt id). Two things
 * make that unsound: (1) a resume could not be ordered against a failure that
 * was still being written back, and (2) a 429 wait borrowed a row's
 * `nextAttemptAt`, which any later row transition (cancel, re-claim) changes.
 * Events fix both: ordering is the event's `id`, the wait deadline lives in
 * the event itself.
 *
 * ## Streams (`operation_audit.entity_type = 'indexnow_delivery'`)
 *
 * | `entity_id`  | `action`                              | written by                      |
 * |--------------|----------------------------------------|---------------------------------|
 * | `breaker`    | `indexnow.delivery.breaker_trip`       | worker, write-back tx, 400/403/422 |
 * | `breaker`    | `indexnow.delivery.breaker_resume`     | `resumeIndexNowDelivery` (admin) |
 * | `rate_limit` | `indexnow.delivery.rate_limited`       | worker, write-back tx, 429       |
 * | `bisect`     | `indexnow.delivery.bisect`             | worker, after a bisect ends      |
 *
 * ## Derivation rules (answers to the four review questions)
 *
 * 1. *Is a trip already covered by a resume?* Within the `breaker` stream a
 *    resume event whose `id` is greater than the trip's `id` covers it.
 *    `created_at` is display-only: it is the transaction start time, not the
 *    commit order, so it must never be used to order events.
 * 2. *A new failure while resumed.* It writes a fresh trip event; its id is
 *    greater than the resume's, so the breaker is open again.
 * 3. *Several workers reading at once.* The state is a pure function of the
 *    committed events. A reader may see a slightly older state, but every
 *    action that matters (claiming a batch, resuming) takes
 *    `pg_advisory_xact_lock(50241, 1)` first and re-derives the state inside
 *    the lock, so no action is ever taken on a stale read. Writers of trip /
 *    rate_limited / resume events take the same lock, so within one stream
 *    event ids are commit-ordered.
 * 4. *Where does the 429 deadline come from?* From the event only:
 *    `waitUntil = database clock + max(Retry-After, 5 min)`, computed when the
 *    event is written. No outbox row's `nextAttemptAt` is consulted, so
 *    cancelling or re-claiming rows cannot move it.
 *
 * Breaker = "the highest-id event of the `breaker` stream is a trip".
 * Rate-limit wait = "the highest-id event of the `rate_limit` stream has
 * `waitUntil` > database now". Both come out of ONE SQL statement (one
 * snapshot, one clock).
 *
 * ## Query plan contract (production `operation_audit` ≈ 750k rows)
 *
 * Every stream is first selected with the fixed `entity_type`/`entity_id`
 * equality predicates, which is what makes the planner use
 * `operation_audit_entity_created_idx`; only then is the newest event picked
 * from that small set. Do NOT rewrite this as `ORDER BY id DESC LIMIT 1` over
 * the whole table with a filter: with an empty stream (the state right after
 * launch) the planner may walk the primary key backwards across the whole
 * table. Do NOT order by `created_at` either (see rule 1).
 * `tests/integration/tasks/indexnow-batch-postgres.test.ts` pins this with
 * `EXPLAIN (ANALYZE)` on 750k rows.
 *
 * Events written before this release do not exist: a 4xx attempt from the
 * v0.5.14 single-URL era has no trip event and therefore does not open the
 * breaker.
 */
import { randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";

import { toAbsoluteUrl } from "@/lib/seo/site-url";

import { INDEXNOW_RATE_LIMIT_FALLBACK_WAIT_MS } from "./delivery-primitives";
import { INDEXNOW_DELIVERY_TASK_TYPE, INDEXNOW_PROCESSING_STALE_MS } from "./outbox-contract";

type Db = PrismaClient | Prisma.TransactionClient;

export const INDEXNOW_CONTROL_ENTITY_TYPE = "indexnow_delivery";
export const INDEXNOW_CONTROL_STREAMS = Object.freeze({
  breaker: "breaker",
  rateLimit: "rate_limit",
  bisect: "bisect",
});
export const INDEXNOW_CONTROL_ACTIONS = Object.freeze({
  breakerTrip: "indexnow.delivery.breaker_trip",
  breakerResume: "indexnow.delivery.breaker_resume",
  rateLimited: "indexnow.delivery.rate_limited",
  bisect: "indexnow.delivery.bisect",
});
/**
 * Two-int advisory lock namespace for the control plane. Taken (transaction
 * scoped) by: the claim transaction (including bisect probes), the write-back
 * transaction when it writes a trip / rate_limited event, and the resume
 * transaction. In use elsewhere: 50210 (sitemap refresh), 50211 (scheduler
 * enqueue), 50212 (tag projection), 50330.
 */
export const INDEXNOW_CONTROL_ADVISORY_LOCK = Object.freeze({ namespace: 50_241, scope: 1 });

export const INDEXNOW_RESUME_REFUSAL_CODES = ["breaker_not_open", "in_flight_requests_present", "request_id_reused"] as const;
export type IndexNowResumeRefusalCode = (typeof INDEXNOW_RESUME_REFUSAL_CODES)[number];

export class IndexNowResumeRefusedError extends Error {
  readonly code: IndexNowResumeRefusalCode;
  constructor(code: IndexNowResumeRefusalCode) {
    super(code);
    this.name = "IndexNowResumeRefusedError";
    this.code = code;
  }
}

/**
 * Control-state read. Parameter-free on purpose (the stream names are
 * literals so the planner can use the entity index with constant
 * predicates) and exported as text so the real-database test can `EXPLAIN`
 * exactly what production runs. The marker comment lets the in-memory test
 * double recognise the statement.
 */
export const INDEXNOW_CONTROL_STATE_SQL = `/* indexnow:control-state */
WITH clock AS MATERIALIZED (
  SELECT clock_timestamp() AS db_now
),
breaker AS MATERIALIZED (
  SELECT id, action, actor_id, reason, before_snapshot, after_snapshot, created_at
  FROM operation_audit
  WHERE entity_type = 'indexnow_delivery' AND entity_id = 'breaker'
),
rate AS MATERIALIZED (
  SELECT id, after_snapshot, created_at
  FROM operation_audit
  WHERE entity_type = 'indexnow_delivery' AND entity_id = 'rate_limit'
),
bisect AS MATERIALIZED (
  SELECT id, after_snapshot, created_at
  FROM operation_audit
  WHERE entity_type = 'indexnow_delivery' AND entity_id = 'bisect'
)
SELECT
  clock.db_now AS db_now,
  last_breaker.id AS last_breaker_id,
  last_breaker.action AS last_breaker_action,
  last_resume.id AS last_resume_id,
  last_resume.actor_id AS last_resume_actor_id,
  last_resume.reason AS last_resume_reason,
  last_resume.created_at AS last_resume_created_at,
  last_resume.after_snapshot AS last_resume_after,
  first_trip.id AS first_trip_id,
  first_trip.after_snapshot AS first_trip_after,
  first_trip.created_at AS first_trip_created_at,
  (SELECT count(*) FROM breaker
    WHERE action = 'indexnow.delivery.breaker_trip' AND id > COALESCE(last_resume.id, 0))::int AS trip_events_since_resume,
  last_rate.id AS last_rate_id,
  last_rate.after_snapshot AS last_rate_after,
  CASE WHEN last_rate.id IS NULL THEN false
       ELSE COALESCE((last_rate.after_snapshot->>'waitUntil')::timestamptz > clock.db_now, false)
  END AS rate_waiting,
  last_bisect.id AS last_bisect_id,
  last_bisect.after_snapshot AS last_bisect_after,
  last_bisect.created_at AS last_bisect_created_at
FROM clock
LEFT JOIN LATERAL (SELECT * FROM breaker ORDER BY id DESC LIMIT 1) last_breaker ON true
LEFT JOIN LATERAL (
  SELECT * FROM breaker WHERE action = 'indexnow.delivery.breaker_resume' ORDER BY id DESC LIMIT 1
) last_resume ON true
LEFT JOIN LATERAL (
  SELECT * FROM breaker
  WHERE action = 'indexnow.delivery.breaker_trip' AND id > COALESCE(last_resume.id, 0)
  ORDER BY id ASC LIMIT 1
) first_trip ON true
LEFT JOIN LATERAL (SELECT * FROM rate ORDER BY id DESC LIMIT 1) last_rate ON true
LEFT JOIN LATERAL (SELECT * FROM bisect ORDER BY id DESC LIMIT 1) last_bisect ON true`;

export type IndexNowBreakerTrip = Readonly<{
  /** `operation_audit.id` of the earliest trip event after the last resume. */
  auditId: bigint;
  requestBatchId: string | null;
  httpStatus: number | null;
  urlCount: number | null;
  heldRetry: boolean;
  createdAt: Date;
}>;

export type IndexNowRateLimitState =
  | Readonly<{ waiting: false }>
  | Readonly<{ waiting: true; until: Date; requestBatchId: string | null; eventAuditId: bigint }>;

export type IndexNowBreakerState =
  | Readonly<{ open: false }>
  | Readonly<{
      open: true;
      /** The earliest trip event since the last resume ("what tripped it"). */
      trippedBy: IndexNowBreakerTrip;
      /** Number of trip events since the last resume. */
      breakerTripEvents: number;
      /** `operation_audit.id` of the newest trip event (the one a resume would cover). */
      latestTripAuditId: bigint;
    }>;

export type IndexNowDeliveryControlState = Readonly<{
  /** Database clock at the moment the state was read. */
  dbNow: Date;
  breaker: IndexNowBreakerState;
  /**
   * True when the batch that tripped the breaker was itself a held re-push
   * (the previous trip had been resumed and the same rows failed again).
   */
  repeatAfterResume: boolean;
  rateLimit: IndexNowRateLimitState;
  lastResume: Readonly<{
    auditId: bigint;
    actorId: string | null;
    reason: string | null;
    createdAt: Date;
    resumedTripAuditId: string | null;
  }> | null;
  lastBisect: Readonly<{ auditId: bigint; createdAt: Date; snapshot: Record<string, unknown> }> | null;
}>;

type ControlStateRow = {
  db_now: Date;
  last_breaker_id: bigint | null;
  last_breaker_action: string | null;
  last_resume_id: bigint | null;
  last_resume_actor_id: string | null;
  last_resume_reason: string | null;
  last_resume_created_at: Date | null;
  last_resume_after: unknown;
  first_trip_id: bigint | null;
  first_trip_after: unknown;
  first_trip_created_at: Date | null;
  trip_events_since_resume: number | null;
  last_rate_id: bigint | null;
  last_rate_after: unknown;
  rate_waiting: boolean | null;
  last_bisect_id: bigint | null;
  last_bisect_after: unknown;
  last_bisect_created_at: Date | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Reads the database clock. Every control decision uses this, never the worker's own clock. */
export async function readIndexNowDbNow(db: Db): Promise<Date> {
  const rows = await db.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT clock_timestamp() AS now`);
  return rows[0]!.now;
}

/** Takes the control-plane advisory lock (released at transaction end). Must run inside an interactive transaction. */
export async function lockIndexNowControl(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      ${INDEXNOW_CONTROL_ADVISORY_LOCK.namespace}::int,
      ${INDEXNOW_CONTROL_ADVISORY_LOCK.scope}::int
    )::text AS lock_result
  `);
}

/**
 * Derives breaker / 429-wait / last-resume / last-bisect from the control
 * event streams with ONE statement (one snapshot, one database clock).
 */
export async function getIndexNowDeliveryControlState(db: Db): Promise<IndexNowDeliveryControlState> {
  const rows = await db.$queryRawUnsafe<ControlStateRow[]>(INDEXNOW_CONTROL_STATE_SQL);
  const row = rows[0]!;

  const lastBreakerIsTrip = row.last_breaker_action === INDEXNOW_CONTROL_ACTIONS.breakerTrip;
  let breaker: IndexNowBreakerState = { open: false };
  let repeatAfterResume = false;
  if (lastBreakerIsTrip && row.first_trip_id !== null && row.last_breaker_id !== null) {
    const after = asRecord(row.first_trip_after);
    const trippedBy: IndexNowBreakerTrip = {
      auditId: BigInt(row.first_trip_id),
      requestBatchId: asStringOrNull(after.requestBatchId),
      httpStatus: asNumberOrNull(after.httpStatus),
      urlCount: asNumberOrNull(after.urlCount),
      heldRetry: after.heldRetry === true,
      createdAt: row.first_trip_created_at ?? row.db_now,
    };
    breaker = {
      open: true,
      trippedBy,
      breakerTripEvents: row.trip_events_since_resume ?? 1,
      latestTripAuditId: BigInt(row.last_breaker_id),
    };
    repeatAfterResume = trippedBy.heldRetry;
  }

  let rateLimit: IndexNowRateLimitState = { waiting: false };
  if (row.rate_waiting === true && row.last_rate_id !== null) {
    const after = asRecord(row.last_rate_after);
    const until = new Date(String(after.waitUntil));
    rateLimit = {
      waiting: true,
      until,
      requestBatchId: asStringOrNull(after.requestBatchId),
      eventAuditId: BigInt(row.last_rate_id),
    };
  }

  const lastResume =
    row.last_resume_id !== null
      ? {
          auditId: BigInt(row.last_resume_id),
          actorId: row.last_resume_actor_id,
          reason: row.last_resume_reason,
          createdAt: row.last_resume_created_at ?? row.db_now,
          resumedTripAuditId: asStringOrNull(asRecord(row.last_resume_after).resumedTripAuditId),
        }
      : null;

  const lastBisect =
    row.last_bisect_id !== null
      ? {
          auditId: BigInt(row.last_bisect_id),
          createdAt: row.last_bisect_created_at ?? row.db_now,
          snapshot: asRecord(row.last_bisect_after),
        }
      : null;

  return { dbNow: row.db_now, breaker, repeatAfterResume, rateLimit, lastResume, lastBisect };
}

// ---------------------------------------------------------------------------
// Event writers (worker side). Callers hold the control lock where required.
// ---------------------------------------------------------------------------

export type RecordBreakerTripInput = Readonly<{
  requestBatchId: string;
  httpStatus: number;
  urlCount: number;
  heldRetry: boolean;
  dbNow: Date;
  taskId: string;
}>;

/** Appends a `breaker_trip` event. Call inside the write-back transaction after taking {@link lockIndexNowControl}. */
export async function recordIndexNowBreakerTrip(tx: Prisma.TransactionClient, input: RecordBreakerTripInput): Promise<void> {
  await tx.operationAudit.create({
    data: {
      actorType: "worker",
      action: INDEXNOW_CONTROL_ACTIONS.breakerTrip,
      entityType: INDEXNOW_CONTROL_ENTITY_TYPE,
      entityId: INDEXNOW_CONTROL_STREAMS.breaker,
      taskType: INDEXNOW_DELIVERY_TASK_TYPE,
      taskId: input.taskId,
      reason: `http_${input.httpStatus}`,
      afterSnapshot: {
        requestBatchId: input.requestBatchId,
        httpStatus: input.httpStatus,
        urlCount: input.urlCount,
        heldRetry: input.heldRetry,
        dbNow: input.dbNow.toISOString(),
      },
    },
  });
}

export type RecordRateLimitedInput = Readonly<{
  requestBatchId: string;
  retryAfterMs: number;
  dbNow: Date;
  taskId: string;
}>;

/**
 * Appends a `rate_limited` event whose `waitUntil` is `dbNow + max(Retry-After,
 * 5 min)`. Returns the deadline. Call inside the write-back transaction after
 * taking {@link lockIndexNowControl}.
 */
export async function recordIndexNowRateLimited(tx: Prisma.TransactionClient, input: RecordRateLimitedInput): Promise<Date> {
  const waitMs = Math.max(input.retryAfterMs, INDEXNOW_RATE_LIMIT_FALLBACK_WAIT_MS);
  const waitUntil = new Date(input.dbNow.getTime() + waitMs);
  await tx.operationAudit.create({
    data: {
      actorType: "worker",
      action: INDEXNOW_CONTROL_ACTIONS.rateLimited,
      entityType: INDEXNOW_CONTROL_ENTITY_TYPE,
      entityId: INDEXNOW_CONTROL_STREAMS.rateLimit,
      taskType: INDEXNOW_DELIVERY_TASK_TYPE,
      taskId: input.taskId,
      reason: "http_429",
      afterSnapshot: {
        requestBatchId: input.requestBatchId,
        retryAfterMs: input.retryAfterMs,
        waitUntil: waitUntil.toISOString(),
        dbNow: input.dbNow.toISOString(),
      },
    },
  });
  return waitUntil;
}

// ---------------------------------------------------------------------------
// Resume (admin / CLI side)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESUME_REASON_MAX_LENGTH = 500;

export type ResumeIndexNowDeliveryInput = Readonly<{
  actorId: string;
  reason: string;
  requestId?: string;
}>;

export type ResumeIndexNowDeliveryResult = Readonly<{
  auditId: bigint;
  resumedTripAuditId: bigint;
  requestId: string;
}>;

/** Pure input validation, exported so the CLI can show a dry-run without a database. */
export function validateResumeInput(input: ResumeIndexNowDeliveryInput): { actorId: string; reason: string; requestId: string } {
  // `worker_app` cannot read `admin_identity`, so only the *shape* of the actor
  // id can be validated here; existence is the operator's responsibility.
  if (!UUID_RE.test(input.actorId)) throw new Error("actorId must be a UUID");
  const requestId = input.requestId ?? randomUUID();
  if (!UUID_RE.test(requestId)) throw new Error("requestId must be a UUID");
  const reason = input.reason.trim();
  if (reason.length === 0) throw new Error("reason must not be empty");
  if (reason.length > RESUME_REASON_MAX_LENGTH) throw new Error(`reason must be at most ${RESUME_REASON_MAX_LENGTH} characters`);
  return { actorId: input.actorId.toLowerCase(), reason, requestId: requestId.toLowerCase() };
}

/**
 * Closes the breaker by appending a `breaker_resume` event.
 *
 * Inside one transaction, under the control lock: refuses unless the newest
 * `breaker` event is a trip (`breaker_not_open`), and refuses while any
 * request is in flight (`in_flight_requests_present`: an attempt row in
 * `started` with `request_at` no older than 35 minutes). The in-flight rule
 * keeps a resume from landing between a request being sent and its response
 * being written back.
 */
export async function resumeIndexNowDelivery(
  db: PrismaClient,
  input: ResumeIndexNowDeliveryInput,
): Promise<ResumeIndexNowDeliveryResult> {
  const valid = validateResumeInput(input);
  return db.$transaction(
    async (tx) => {
      await lockIndexNowControl(tx);
      const state = await getIndexNowDeliveryControlState(tx);
      if (!state.breaker.open) throw new IndexNowResumeRefusedError("breaker_not_open");

      const inFlight = await tx.indexNowOutboxAttempt.count({
        where: {
          attemptState: "started",
          requestAt: { gte: new Date(state.dbNow.getTime() - INDEXNOW_PROCESSING_STALE_MS) },
        },
      });
      if (inFlight > 0) throw new IndexNowResumeRefusedError("in_flight_requests_present");

      const trip = state.breaker.trippedBy;
      try {
        const audit = await tx.operationAudit.create({
          data: {
            actorType: "admin",
            actorId: valid.actorId,
            action: INDEXNOW_CONTROL_ACTIONS.breakerResume,
            entityType: INDEXNOW_CONTROL_ENTITY_TYPE,
            entityId: INDEXNOW_CONTROL_STREAMS.breaker,
            requestId: valid.requestId,
            reason: valid.reason,
            beforeSnapshot: {
              resumedTripAuditId: state.breaker.latestTripAuditId.toString(),
              trippedByAuditId: trip.auditId.toString(),
              trip: {
                requestBatchId: trip.requestBatchId,
                httpStatus: trip.httpStatus,
                urlCount: trip.urlCount,
                heldRetry: trip.heldRetry,
              },
              breakerTripEvents: state.breaker.breakerTripEvents,
              repeatAfterResume: state.repeatAfterResume,
            },
            afterSnapshot: { resumedTripAuditId: state.breaker.latestTripAuditId.toString() },
          },
          select: { id: true },
        });
        return { auditId: audit.id, resumedTripAuditId: state.breaker.latestTripAuditId, requestId: valid.requestId };
      } catch (error) {
        // `operation_audit_admin_request_action_uidx`: one admin audit row per
        // (request_id, action). Replaying a request id is refused, not applied twice.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          throw new IndexNowResumeRefusedError("request_id_reused");
        }
        throw error;
      }
    },
    { timeout: 30_000 },
  );
}

// ---------------------------------------------------------------------------
// Read helpers for the status command and the batch listing
// ---------------------------------------------------------------------------

export type IndexNowRequestBatchRow = Readonly<{
  outboxId: string;
  articleId: string | null;
  locale: string;
  url: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  lastHttpStatus: number | null;
  lastErrorKind: string | null;
  /** HTTP status this row received in the requested batch. */
  batchHttpStatus: number | null;
}>;

/** Every outbox row that took part in one HTTP request (`request_batch_id`), ordered by `created_at, id`. */
export async function listIndexNowRequestBatch(db: Db, requestBatchId: string): Promise<IndexNowRequestBatchRow[]> {
  const rows = await db.indexNowOutbox.findMany({
    where: { attempts: { some: { requestBatchId } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      articleId: true,
      locale: true,
      url: true,
      status: true,
      attemptCount: true,
      maxAttempts: true,
      lastHttpStatus: true,
      lastErrorKind: true,
      attempts: { where: { requestBatchId }, select: { httpStatus: true } },
    },
  });
  return rows.map((row) => ({
    outboxId: row.id,
    articleId: row.articleId,
    locale: row.locale,
    url: row.url,
    status: row.status,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    lastHttpStatus: row.lastHttpStatus,
    lastErrorKind: row.lastErrorKind,
    batchHttpStatus: row.attempts[0]?.httpStatus ?? null,
  }));
}

/**
 * Compares the configured IndexNow `host` with the host of `SITE_URL`.
 * 422 "host does not match" is the most common IndexNow rejection; catching it
 * locally costs no request and trips no breaker. Uses the repo's single
 * `toAbsoluteUrl` for `SITE_URL` (throws `SiteUrlConfigurationError` when it
 * is unset — "no site URL configured" stays a loud failure).
 */
export function isIndexNowHostConsistent(config: Readonly<{ host: string }>): boolean {
  return new URL(toAbsoluteUrl("/")).hostname === config.host.trim().toLowerCase();
}

/** "verified" = latest accepted attempt was HTTP 200; "pending" = it was 202 (protocol accepted, key validation outstanding). */
export type IndexNowKeyValidation = "verified" | "pending" | "none";

export function deriveKeyValidation(lastAcceptedHttpStatus: number | null | undefined): IndexNowKeyValidation {
  if (lastAcceptedHttpStatus === 200) return "verified";
  if (lastAcceptedHttpStatus === 202) return "pending";
  return "none";
}
