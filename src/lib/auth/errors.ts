export type AdminAccessErrorCode =
  | "jwt_missing"
  | "jwt_invalid"
  | "jwt_expired"
  | "admin_capability_denied"
  | "admin_two_factor_setup_required"
  | "admin_two_factor_required"
  | "admin_route_not_registered"
  | "admin_action_not_registered"
  | "admin_origin_denied"
  | "admin_mutation_request_id_invalid"
  | "admin_rate_limited"
  // B-39: admin login human verification (Cloudflare Turnstile). Both are
  // refusals that happen after the lockout check and before any credential
  // work, so neither is ever recorded as a failed login attempt.
  | "admin_human_verification_failed"
  | "admin_human_verification_unavailable"
  | "admin_service_authorization_required"
  | "two_factor_failed"
  | "two_factor_expired"
  | "two_factor_locked";

export class AdminAccessError extends Error {
  readonly code: AdminAccessErrorCode;
  readonly status: 401 | 403 | 404 | 429;
  readonly details: Readonly<Record<string, string>>;

  constructor(
    code: AdminAccessErrorCode,
    status: 401 | 403 | 404 | 429,
    message: string,
    details: Record<string, string> = {},
  ) {
    super(message);
    this.name = "AdminAccessError";
    this.code = code;
    this.status = status;
    this.details = Object.freeze({ ...details });
  }
}

export function isAdminAccessError(error: unknown): error is AdminAccessError {
  return error instanceof AdminAccessError;
}
