import type {
  AdminIdentity,
  AdminLoginIdentity,
  AdminSessionRecord,
  LoginAttemptRecord,
  RecoveryCodeRecord,
  TwoFactorChallenge,
  TwoFactorState,
} from "./types";

export interface AdminIdentityStore {
  findById(identityId: string): Promise<AdminIdentity | null>;
  findByNormalizedUsername(username: string): Promise<AdminLoginIdentity | null>;
}

export interface SessionStore {
  findByTokenHash(tokenHash: string): Promise<AdminSessionRecord | null>;
  create(session: AdminSessionRecord): Promise<void>;
  touchLastSeen(input: {
    sessionId: string;
    identityId: string;
    sessionVersion: number;
    seenAt: Date;
  }): Promise<boolean>;
  revoke(sessionId: string, revokedAt: Date): Promise<boolean>;
}

export interface TwoFactorStore {
  findByIdentityId(identityId: string): Promise<TwoFactorState | null>;
  savePendingSetup(identityId: string, encryptedSecret: string, expiresAt: Date): Promise<void>;
  createChallenge(challenge: TwoFactorChallenge): Promise<void>;
  findChallengeByTokenHash(tokenHash: string): Promise<TwoFactorChallenge | null>;
  incrementChallengeAttempts(input: {
    challengeId: string;
    now: Date;
    maxAttempts: number;
  }): Promise<boolean>;
}

export interface RecoveryCodeStore {
  listUnused(identityId: string): Promise<RecoveryCodeRecord[]>;
}

export interface LoginAttemptStore {
  find(identifierHash: string): Promise<LoginAttemptRecord | null>;
  recordFailure(input: {
    identifierHash: string;
    now: Date;
    windowMs: number;
    maxFailures: number;
  }): Promise<LoginAttemptRecord>;
  clear(identifierHash: string): Promise<void>;
}

export type ConfirmTwoFactorSetupTransactionResult =
  | { status: "committed"; nextSessionVersion: number }
  | { status: "conflict" };

export type CompleteTwoFactorChallengeTransactionResult =
  | { status: "committed"; sessionVersion: number }
  | {
      status:
        | "challenge_unavailable"
        | "session_unavailable"
        | "recovery_code_unavailable";
    };

export interface AuthUnitOfWork {
  confirmTwoFactorSetup(input: {
    identityId: string;
    expectedSessionVersion: number;
    expectedPendingEncryptedSecret: string;
    confirmedAt: Date;
    recoveryCodes: ReadonlyArray<{ id: string; codeHash: string }>;
  }): Promise<ConfirmTwoFactorSetupTransactionResult>;
  completeTwoFactorChallenge(input: {
    challengeId: string;
    identityId: string;
    sessionId: string;
    completedAt: Date;
    recoveryCodeId: string | null;
  }): Promise<CompleteTwoFactorChallengeTransactionResult>;
}

export type AdminRateLimitDecision = {
  allowed: boolean;
  retryAfterSeconds?: number;
};

export interface AdminRateLimitPort {
  /** Optional defense in depth. P1 mutation security relies on request-id idempotency and task deduplication. */
  consume(input: {
    scope: string;
    subject: string;
    requestId: string;
    now: Date;
  }): Promise<AdminRateLimitDecision>;
}
