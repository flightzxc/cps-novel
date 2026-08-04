import type { AdminAccessErrorCode } from "@/lib/auth/errors";
import type { CredentialContractCode } from "@/lib/credentials/contracts";

/**
 * Every stable code the browser is allowed to branch on.
 *
 * The frontend must switch on `code` and never parse a server message: the
 * envelope deliberately carries no free-text field for it to read.
 */
export type AdminErrorCode = AdminAccessErrorCode | CredentialContractCode;

/**
 * 409 carries idempotency conflicts: a mutation request id was replayed with a
 * different actor, account or payload. It must survive projection intact —
 * coercing it to 403 would read as a permission problem and send the operator
 * looking in the wrong place.
 */
export type AdminErrorStatus = 401 | 403 | 404 | 409 | 429;

/**
 * Machine-readable reasons that further qualify a code. Constrained to a frozen
 * set so the field can never become a channel for server-authored prose;
 * introducing a new reason is a deliberate contract change, not a string edit.
 *
 * Each value has a server counterpart that already emits it:
 * - `idempotency_conflict` — 409 from `CredentialReplacementIdempotencyConflictError`
 * - `idle_timeout` / `absolute_timeout` — 401 `jwt_expired` from
 *   `validateAdminSession`. The two are not interchangeable to an operator:
 *   idle expiry is recoverable by signing in again, while the absolute cap means
 *   the 24h session ceiling was reached and a fresh session is mandatory.
 */
export type ErrorEnvelopeReason =
  | "idempotency_conflict"
  | "idle_timeout"
  | "absolute_timeout";

/**
 * The only structured hints allowed alongside a code.
 *
 * All three are machine values, not prose: `capability` is an `AdminCapability`
 * literal, `retryAfterSeconds` is a decimal integer string, and `reason` is one
 * of {@link ErrorEnvelopeReason}. Anything the server puts in
 * `AdminAccessError.details` outside this whitelist is dropped by
 * {@link projectErrorEnvelope}.
 */
export type ErrorEnvelopeDetails = {
  readonly capability?: string;
  readonly retryAfterSeconds?: string;
  readonly reason?: ErrorEnvelopeReason;
};

export type ErrorEnvelope = {
  readonly ok: false;
  readonly status: AdminErrorStatus;
  readonly code: AdminErrorCode;
  readonly details?: ErrorEnvelopeDetails;
};

const ALLOWED_STATUSES: readonly AdminErrorStatus[] = [401, 403, 404, 409, 429];

const ALLOWED_REASONS: readonly ErrorEnvelopeReason[] = [
  "idempotency_conflict",
  "idle_timeout",
  "absolute_timeout",
];

function isAdminErrorStatus(value: unknown): value is AdminErrorStatus {
  return typeof value === "number" && ALLOWED_STATUSES.includes(value as AdminErrorStatus);
}

function isEnvelopeReason(value: unknown): value is ErrorEnvelopeReason {
  return typeof value === "string" && ALLOWED_REASONS.includes(value as ErrorEnvelopeReason);
}

function pickDetails(details: unknown): ErrorEnvelopeDetails | undefined {
  if (!details || typeof details !== "object") return undefined;
  const source = details as Record<string, unknown>;
  const picked: {
    capability?: string;
    retryAfterSeconds?: string;
    reason?: ErrorEnvelopeReason;
  } = {};
  if (typeof source.capability === "string") picked.capability = source.capability;
  if (typeof source.retryAfterSeconds === "string") {
    picked.retryAfterSeconds = source.retryAfterSeconds;
  }
  // Unknown reasons are dropped rather than forwarded: an unrecognised token
  // would reach the browser as an unhandled branch.
  if (isEnvelopeReason(source.reason)) picked.reason = source.reason;
  return picked.capability === undefined
    && picked.retryAfterSeconds === undefined
    && picked.reason === undefined
    ? undefined
    : Object.freeze(picked);
}

/**
 * Build the browser-facing envelope from a server error.
 *
 * Field-by-field on purpose: an `Error` carries `message`, `stack` and (for
 * Prisma) driver metadata, none of which may cross this boundary. Spreading the
 * source would leak all three.
 */
export function projectErrorEnvelope(input: {
  code: AdminErrorCode;
  status: unknown;
  details?: unknown;
}): ErrorEnvelope {
  const details = pickDetails(input.details);
  const envelope: {
    ok: false;
    status: AdminErrorStatus;
    code: AdminErrorCode;
    details?: ErrorEnvelopeDetails;
  } = {
    ok: false,
    status: isAdminErrorStatus(input.status) ? input.status : 403,
    code: input.code,
  };
  if (details) envelope.details = details;
  return Object.freeze(envelope);
}
