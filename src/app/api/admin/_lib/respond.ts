import { projectErrorEnvelope, type AdminErrorCode, type ErrorEnvelope } from "@/contracts";
import { isAdminAccessError } from "@/lib/auth/errors";
import type { CredentialContractCode } from "@/lib/credentials/contracts";
import { CredentialLifecycleError } from "@/lib/credentials/lifecycle";
import {
  CredentialReplacementIdempotencyConflictError,
  CredentialTaskNotFoundError,
} from "@/server/credentials/service";

/**
 * `CredentialLifecycleError` carries a stable code but no HTTP status, so the
 * status is decided here — once, in the only place that turns a server error
 * into a browser envelope.
 */
const CREDENTIAL_CODE_STATUS: Readonly<Record<CredentialContractCode, 401 | 403 | 404 | 409 | 429>> =
  Object.freeze({
    credential_validation_queued: 403,
    credential_missing: 404,
    credential_expired: 409,
    credential_fingerprint_conflict: 409,
    credential_validation_failed: 409,
    credential_capability_denied: 403,
    credential_ambiguous: 409,
    account_inactive: 409,
  });

/**
 * Map any thrown server error onto the frozen envelope.
 *
 * Anything unrecognised collapses to a generic 403 with no detail: an unexpected
 * `Error` may carry a driver message or a stack, and this boundary must never
 * become the thing that forwards it.
 */
export function toErrorEnvelope(error: unknown): ErrorEnvelope {
  if (error instanceof CredentialTaskNotFoundError) {
    return projectErrorEnvelope({ code: error.code, status: error.status });
  }
  if (error instanceof CredentialReplacementIdempotencyConflictError) {
    return projectErrorEnvelope({
      code: error.code,
      status: error.status,
      details: error.details,
    });
  }
  if (isAdminAccessError(error)) {
    return projectErrorEnvelope({
      code: error.code,
      status: error.status,
      details: error.details,
    });
  }
  if (error instanceof CredentialLifecycleError) {
    return projectErrorEnvelope({
      code: error.code,
      status: CREDENTIAL_CODE_STATUS[error.code],
    });
  }
  return projectErrorEnvelope({ code: "admin_capability_denied" as AdminErrorCode, status: 403 });
}

export function jsonOk<T>(data: T, status = 200): Response {
  return Response.json({ ok: true, data }, { status });
}

export function jsonError(error: unknown): Response {
  const envelope = toErrorEnvelope(error);
  return Response.json(envelope, { status: envelope.status });
}

export async function handle<T>(run: () => Promise<T>): Promise<Response> {
  try {
    return jsonOk(await run());
  } catch (error) {
    return jsonError(error);
  }
}
