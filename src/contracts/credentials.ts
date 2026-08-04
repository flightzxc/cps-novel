import { CREDENTIAL_STATUSES, type CredentialStatus } from "@/domain/database-statuses";
import type { CredentialContractCode, CredentialOperation } from "@/lib/credentials/contracts";

import type { AdminCapabilityState } from "./admin-session";

/**
 * Only `fingerprintPrefix` crosses the boundary — never the full HMAC
 * fingerprint, the ciphertext, or the key version.
 */
export type CredentialMetadataView = {
  readonly credentialId: string;
  readonly channelAccountId: string;
  readonly credentialType: string;
  readonly status: CredentialStatus;
  readonly expiresAt: string | null;
  readonly lastValidatedAt: string | null;
  readonly fingerprintPrefix: string;
};

/**
 * Whether an operation may be offered at all. This is the *entry* axis and is
 * orthogonal to {@link CredentialTaskState}, which is the *lifecycle* axis of an
 * operation already accepted.
 *
 * `unavailable_pending_owner_gate` exists so P1-09B can render add/replace as
 * explicitly not-yet-enabled instead of letting an operator submit and receive a
 * vague server error: the Secret Ingress protocol is unapproved, so those
 * entries are not in the production registry and would 404.
 */
export type CredentialOperationAvailabilityState =
  | "supported"
  | "unavailable_pending_owner_gate"
  | "unavailable_capability_denied"
  | "unavailable_two_factor_required";

export type CredentialOperationAvailability = {
  readonly operation: CredentialOperation;
  readonly state: CredentialOperationAvailabilityState;
};

/** Frozen until the Owner approves a Secret Ingress protocol. */
export const CREDENTIAL_OWNER_GATED_OPERATIONS: readonly CredentialOperation[] = Object.freeze([
  "add_or_replace_credential",
]);

export const CREDENTIAL_SUPPORTED_OPERATIONS: readonly CredentialOperation[] = Object.freeze([
  "create_account",
  "disable_account",
  "enable_account",
  "validate_credential",
  "supersede_credential",
]);

export type CredentialQueuedResultView = {
  readonly code: "credential_validation_queued";
  readonly state: "queued";
  readonly taskId: string;
  readonly credentialId: string;
  readonly channelAccountId: string;
  readonly enqueuedAt: string;
  readonly mutationRequestId: string;
};

export type CredentialRedactedValidationResultView = {
  /** `null` means the operation succeeded with no advisory code. */
  readonly code: CredentialContractCode | null;
  readonly credentialId: string;
  readonly status: CredentialStatus;
  readonly expiresAt: string | null;
  readonly lastValidatedAt: string | null;
  readonly fingerprintPrefix: string | null;
};

export type CredentialTaskState =
  | "queued"
  | "running"
  | "completed"
  | "completed_with_errors"
  | "failed"
  | "disabled"
  | "unknown";

export type CredentialTaskStatusView = {
  readonly taskId: string;
  readonly state: CredentialTaskState;
  readonly result: CredentialRedactedValidationResultView | null;
  /**
   * Set when the task failed a precondition rather than completing with an
   * advisory code — `account_inactive`, `credential_missing`,
   * `credential_ambiguous`, or `credential_validation_failed` for a
   * non-active row. Sourced from the persisted, already-sanitized
   * `generic_task_item.error.code`; the accompanying message is dropped here.
   */
  readonly failureCode: CredentialContractCode | null;
};

const CREDENTIAL_CONTRACT_CODES: readonly CredentialContractCode[] = Object.freeze([
  "credential_validation_queued",
  "credential_missing",
  "credential_expired",
  "credential_fingerprint_conflict",
  "credential_validation_failed",
  "credential_capability_denied",
  "credential_ambiguous",
  "account_inactive",
]);

const TASK_STATE_BY_DOMAIN_STATUS: Readonly<Record<string, CredentialTaskState>> = Object.freeze({
  pending: "queued",
  processing: "running",
  completed: "completed",
  completed_with_errors: "completed_with_errors",
  failed: "failed",
  disabled: "disabled",
});

function isContractCode(value: unknown): value is CredentialContractCode {
  return typeof value === "string" && CREDENTIAL_CONTRACT_CODES.includes(value as CredentialContractCode);
}

function narrowStatus(value: unknown): CredentialStatus {
  return CREDENTIAL_STATUSES.includes(value as CredentialStatus)
    ? (value as CredentialStatus)
    : "invalid";
}

function isoOrNull(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  if (value instanceof Date) return value.toISOString();
  return null;
}

export function projectCredentialMetadata(input: {
  credentialId: string;
  channelAccountId: string;
  credentialType: string;
  status: string;
  expiresAt: string | Date | null;
  lastValidatedAt: string | Date | null;
  fingerprintPrefix: string;
}): CredentialMetadataView {
  return Object.freeze({
    credentialId: input.credentialId,
    channelAccountId: input.channelAccountId,
    credentialType: input.credentialType,
    status: narrowStatus(input.status),
    expiresAt: isoOrNull(input.expiresAt),
    lastValidatedAt: isoOrNull(input.lastValidatedAt),
    fingerprintPrefix: input.fingerprintPrefix,
  });
}

/**
 * The Owner gate outranks capability: add/replace stays
 * `unavailable_pending_owner_gate` even for an operator who holds
 * `credential:manage`, because the backing route is not registered at all.
 */
export function projectCredentialOperationAvailability(input: {
  credentialManage: AdminCapabilityState;
}): readonly CredentialOperationAvailability[] {
  const fromCapability: CredentialOperationAvailabilityState =
    input.credentialManage === "granted"
      ? "supported"
      : input.credentialManage === "two_factor_required"
        ? "unavailable_two_factor_required"
        : "unavailable_capability_denied";

  const entries: CredentialOperationAvailability[] = [
    ...CREDENTIAL_SUPPORTED_OPERATIONS.map((operation) =>
      Object.freeze({ operation, state: fromCapability }),
    ),
    ...CREDENTIAL_OWNER_GATED_OPERATIONS.map((operation) =>
      Object.freeze({
        operation,
        state: "unavailable_pending_owner_gate" as const,
      }),
    ),
  ];
  return Object.freeze(entries);
}

export function projectCredentialQueuedResult(input: {
  taskId: string;
  credentialId: string;
  channelAccountId: string;
  enqueuedAt: string | Date;
  mutationRequestId: string;
}): CredentialQueuedResultView {
  return Object.freeze({
    code: "credential_validation_queued" as const,
    state: "queued" as const,
    taskId: input.taskId,
    credentialId: input.credentialId,
    channelAccountId: input.channelAccountId,
    enqueuedAt: isoOrNull(input.enqueuedAt) ?? new Date(0).toISOString(),
    mutationRequestId: input.mutationRequestId,
  });
}

/**
 * Parse rather than trust: `result` and `error` arrive as `jsonb`, so an extra
 * key written by a future Worker revision would ride along if this spread the
 * object. Every field is picked and re-validated; unknown codes collapse to
 * `null` instead of reaching the browser as an unhandled branch.
 */
export function projectCredentialTaskStatus(input: {
  taskId: string;
  status: string;
  result?: unknown;
  error?: unknown;
}): CredentialTaskStatusView {
  const rawResult = input.result && typeof input.result === "object"
    ? (input.result as Record<string, unknown>)
    : null;

  const result: CredentialRedactedValidationResultView | null =
    rawResult && typeof rawResult.credentialId === "string"
      ? Object.freeze({
          code: isContractCode(rawResult.code) ? rawResult.code : null,
          credentialId: rawResult.credentialId,
          status: narrowStatus(rawResult.status),
          expiresAt: isoOrNull(rawResult.expiresAt),
          lastValidatedAt: isoOrNull(rawResult.lastValidatedAt),
          fingerprintPrefix:
            typeof rawResult.fingerprintPrefix === "string" ? rawResult.fingerprintPrefix : null,
        })
      : null;

  const rawError = input.error && typeof input.error === "object"
    ? (input.error as Record<string, unknown>)
    : null;

  return Object.freeze({
    taskId: input.taskId,
    state: TASK_STATE_BY_DOMAIN_STATUS[input.status] ?? "unknown",
    result,
    failureCode: rawError && isContractCode(rawError.code) ? rawError.code : null,
  });
}
