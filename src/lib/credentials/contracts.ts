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
  code: CredentialContractCode | null;
  credentialId: string;
  status: CredentialStatus;
  fingerprintPrefix: string | null;
  expiresAt: string | null;
  lastValidatedAt: string | null;
};

export const CREDENTIAL_TASK_TYPES = Object.freeze({
  validate: "credential.validate.v1",
  supersede: "credential.supersede.v1",
  replaceGated: "credential.replace.v1",
} as const);

export interface CredentialSecretIntakePort {
  /** Worker-only one-time consumption. No production adapter exists before Owner approval. */
  consume(intakeId: string): Promise<{ secret: string } | null>;
}

export const CREDENTIAL_EXECUTION_STATUS = "PARTIAL_SECRET_INGRESS_GATED" as const;
export const CREDENTIAL_SCHEDULER_EXECUTION_ALLOWED = false as const;
