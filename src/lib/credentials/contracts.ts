export type CredentialContractCode =
  | "credential_validation_queued"
  | "credential_missing"
  | "credential_expired"
  | "credential_fingerprint_conflict"
  | "credential_validation_failed"
  | "credential_capability_denied";

export type CredentialOperation =
  | "create_account"
  | "replace_secret"
  | "validate"
  | "disable"
  | "enable"
  | "supersede";

export type CredentialMetadata = {
  credentialId: string;
  channelAccountId: string;
  credentialType: string;
  fingerprintPrefix: string;
  status: "active" | "disabled" | "superseded" | "expired";
  expiresAt: string | null;
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
