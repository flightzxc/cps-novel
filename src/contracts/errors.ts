import type { AdminAccessErrorCode } from "@/lib/auth/errors";
import type { CredentialContractCode } from "@/lib/credentials/contracts";

/**
 * Every stable code the browser is allowed to branch on.
 *
 * The frontend must switch on `code` and never parse a server message: the
 * envelope deliberately carries no free-text field for it to read.
 */
export type AdminErrorCode = AdminAccessErrorCode | CredentialContractCode;

export type AdminErrorStatus = 401 | 403 | 404 | 429;

/**
 * The only structured hints allowed alongside a code.
 *
 * Both are machine values, not prose: `capability` is an `AdminCapability`
 * literal and `retryAfterSeconds` is a decimal integer string. Anything the
 * server puts in `AdminAccessError.details` outside this whitelist is dropped
 * by {@link projectErrorEnvelope}.
 */
export type ErrorEnvelopeDetails = {
  readonly capability?: string;
  readonly retryAfterSeconds?: string;
};

export type ErrorEnvelope = {
  readonly ok: false;
  readonly status: AdminErrorStatus;
  readonly code: AdminErrorCode;
  readonly details?: ErrorEnvelopeDetails;
};

const ALLOWED_STATUSES: readonly AdminErrorStatus[] = [401, 403, 404, 429];

function isAdminErrorStatus(value: unknown): value is AdminErrorStatus {
  return typeof value === "number" && ALLOWED_STATUSES.includes(value as AdminErrorStatus);
}

function pickDetails(details: unknown): ErrorEnvelopeDetails | undefined {
  if (!details || typeof details !== "object") return undefined;
  const source = details as Record<string, unknown>;
  const picked: { capability?: string; retryAfterSeconds?: string } = {};
  if (typeof source.capability === "string") picked.capability = source.capability;
  if (typeof source.retryAfterSeconds === "string") {
    picked.retryAfterSeconds = source.retryAfterSeconds;
  }
  return picked.capability === undefined && picked.retryAfterSeconds === undefined
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
