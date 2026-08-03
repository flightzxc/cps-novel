import type { CredentialStatus } from "@/domain/database-statuses";

export type CredentialContractCode =
  | "credential_validation_queued"
  | "credential_missing"
  | "credential_expired"
  | "credential_fingerprint_conflict"
  | "credential_validation_failed"
  | "credential_capability_denied"
  | "credential_ambiguous"
  | "account_inactive";

export type CredentialOperation =
  | "create_account"
  | "disable_account"
  | "enable_account"
  | "add_or_replace_credential"
  | "validate_credential"
  | "supersede_credential";

export type CredentialMetadata = {
  credentialId: string;
  channelAccountId: string;
  credentialType: string;
  fingerprintPrefix: string;
  status: CredentialStatus;
  expiresAt: string | null;
  lastValidatedAt: string | null;
};

export type CredentialQueuedResult = {
  code: "credential_validation_queued";
  state: "queued";
  taskId: string;
  credentialId: string;
  channelAccountId: string;
  enqueuedAt: string;
  mutationRequestId: string;
};

export type CredentialWorkerEnqueueRequest = {
  executionTarget: "worker";
  operation: CredentialOperation;
  credentialId?: string;
  channelAccountId: string;
  actorIdentityId: string;
  mutationRequestId: string;
};

export type CredentialRedactedResult = {
  success: boolean;
  code: CredentialContractCode;
  credentialId: string | null;
  fingerprintPrefix: string | null;
  expiresAt: string | null;
  message: string;
};

export const CREDENTIAL_EXECUTION_STATUS = "NOT_IMPLEMENTED" as const;
export const CREDENTIAL_SCHEDULER_EXECUTION_ALLOWED = false as const;
