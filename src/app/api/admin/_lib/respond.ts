import { projectErrorEnvelope, type AdminErrorCode, type ErrorEnvelope } from "@/contracts";
import { isAdminAccessError } from "@/lib/auth/errors";
import type { CredentialContractCode } from "@/lib/credentials/contracts";
import { CredentialLifecycleError } from "@/lib/credentials/lifecycle";
import { AdminContentQueryError } from "@/server/admin-content";
import {
  CredentialReplacementIdempotencyConflictError,
  CredentialTaskNotFoundError,
} from "@/server/credentials/service";
import {
  SiteSettingMutationConflictError,
  SiteSettingNotSeededError,
  SiteSettingValidationError,
} from "@/server/site-settings/service";

/**
 * A well-formed identifier that resolves to nothing live.
 *
 * Distinct from `AdminContentQueryError("invalid_identifier")`, which is a
 * malformed id: one tells the operator to fix the link, the other tells them the
 * novel is gone or soft-deleted. Collapsing both to one code would erase that.
 */
export class AdminContentNotFoundError extends Error {
  readonly code = "admin_content_not_found" as const;
  readonly status = 404 as const;

  constructor(entity: "novel" | "chapter") {
    super(`Admin content ${entity} not found`);
    this.name = "AdminContentNotFoundError";
  }
}

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
  if (error instanceof AdminContentNotFoundError) {
    return projectErrorEnvelope({ code: error.code, status: error.status });
  }
  if (error instanceof AdminContentQueryError) {
    // `invalid_read_context` is the one code here that is never the caller's
    // fault — it means this route wired the audit context wrong. Reporting it as
    // a 400 would send an operator off to edit a URL that is already correct.
    return error.code === "invalid_read_context"
      ? projectErrorEnvelope({ code: "admin_service_authorization_required", status: 403 })
      : projectErrorEnvelope({ code: error.code, status: 400 });
  }
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
  if (
    error instanceof SiteSettingValidationError
    || error instanceof SiteSettingMutationConflictError
    || error instanceof SiteSettingNotSeededError
  ) {
    return projectErrorEnvelope({
      code: error.code,
      status: error.status,
      details: error instanceof SiteSettingMutationConflictError ? error.details : undefined,
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
