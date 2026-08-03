import type {
  AdminIdentity,
  AdminSessionRecord,
  LoginAttemptRecord,
  RecoveryCodeRecord,
  TwoFactorChallenge,
  TwoFactorState,
} from "./types";

export interface AdminIdentityStore {
  findById(identityId: string): Promise<AdminIdentity | null>;
  advanceSessionVersion(identityId: string, expectedVersion: number): Promise<number | null>;
}

export interface SessionStore {
  findByTokenHash(tokenHash: string): Promise<AdminSessionRecord | null>;
  touchLastSeen(sessionId: string, seenAt: Date): Promise<boolean>;
  markTwoFactorCompleted(sessionId: string, completedAt: Date): Promise<boolean>;
}

export interface TwoFactorStore {
  findByIdentityId(identityId: string): Promise<TwoFactorState | null>;
  savePendingSetup(identityId: string, encryptedSecret: string, expiresAt: Date): Promise<void>;
  enableFromPending(identityId: string, confirmedAt: Date): Promise<boolean>;
  createChallenge(challenge: TwoFactorChallenge): Promise<void>;
  findChallengeByTokenHash(tokenHash: string): Promise<TwoFactorChallenge | null>;
  incrementChallengeAttempts(challengeId: string): Promise<void>;
  consumeChallenge(challengeId: string, consumedAt: Date): Promise<boolean>;
}

export interface RecoveryCodeStore {
  replaceForIdentity(
    identityId: string,
    codes: ReadonlyArray<{ id: string; codeHash: string }>,
    rotatedAt: Date,
  ): Promise<void>;
  listUnused(identityId: string): Promise<RecoveryCodeRecord[]>;
  consumeIfUnused(codeId: string, usedAt: Date): Promise<boolean>;
}

export interface LoginAttemptStore {
  find(identifierHash: string): Promise<LoginAttemptRecord | null>;
  put(record: LoginAttemptRecord): Promise<void>;
  deleteMany(identifierHashes: readonly string[]): Promise<void>;
}

export type AdminRateLimitDecision = {
  allowed: boolean;
  retryAfterSeconds?: number;
};

export interface AdminRateLimitPort {
  consume(input: {
    scope: string;
    subject: string;
    requestId: string;
    now: Date;
  }): Promise<AdminRateLimitDecision>;
}
