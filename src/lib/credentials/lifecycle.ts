import type { ChannelAccountStatus, CredentialStatus } from "@/domain/database-statuses";

import type { CredentialContractCode, CredentialMetadata } from "./contracts";

export type CredentialValidationStatus = Exclude<CredentialStatus, "superseded">;

export class CredentialLifecycleError extends Error {
  readonly code: CredentialContractCode;

  constructor(code: CredentialContractCode, message: string) {
    super(message);
    this.name = "CredentialLifecycleError";
    this.code = code;
  }
}

export function requireActiveChannelAccount(status: ChannelAccountStatus): void {
  if (status !== "active") {
    throw new CredentialLifecycleError(
      "account_inactive",
      "The channel account is not active",
    );
  }
}

export function resolveSingleActiveCredential(
  accountStatus: ChannelAccountStatus,
  credentials: readonly CredentialMetadata[],
): CredentialMetadata {
  requireActiveChannelAccount(accountStatus);
  const active = credentials.filter((credential) => credential.status === "active");
  if (active.length === 0) {
    throw new CredentialLifecycleError("credential_missing", "No active credential exists");
  }
  if (active.length > 1) {
    throw new CredentialLifecycleError(
      "credential_ambiguous",
      "Multiple active credentials exist for the account and type",
    );
  }
  return active[0];
}

export function planCredentialReplacement(
  existingStatuses: readonly CredentialStatus[],
  insertedStatus: CredentialValidationStatus,
): { existingStatuses: CredentialStatus[]; insertedStatus: CredentialValidationStatus } {
  return {
    existingStatuses: existingStatuses.map((status) =>
      status === "active" ? "superseded" : status,
    ),
    insertedStatus,
  };
}

export function validateCredentialStatus(
  currentStatus: CredentialStatus,
  validationStatus: CredentialValidationStatus,
): CredentialValidationStatus {
  if (currentStatus === "superseded") {
    throw new CredentialLifecycleError(
      "credential_validation_failed",
      "A superseded credential cannot be reactivated by validation",
    );
  }
  return validationStatus;
}

export function supersedeCredentialStatus(currentStatus: CredentialStatus): "superseded" {
  if (currentStatus !== "active") {
    throw new CredentialLifecycleError(
      "credential_validation_failed",
      "Only an active credential can be explicitly superseded",
    );
  }
  return "superseded";
}

export function planChannelAccountStatusChange(input: {
  nextStatus: ChannelAccountStatus;
  credentialStatuses: readonly CredentialStatus[];
}): { accountStatus: ChannelAccountStatus; credentialStatuses: CredentialStatus[] } {
  return {
    accountStatus: input.nextStatus,
    credentialStatuses: [...input.credentialStatuses],
  };
}
