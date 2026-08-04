/**
 * TEST_ONLY — NOT_PRODUCTION_PERSISTENCE.
 *
 * Deterministic adapters for exercising the Auth ports. Production code must
 * provide PostgreSQL-backed adapters after the approved schema change.
 */
import type {
  AdminIdentityStore,
  AuthUnitOfWork,
  CompleteTwoFactorChallengeTransactionResult,
  ConfirmTwoFactorSetupTransactionResult,
  LoginAttemptStore,
  RecoveryCodeStore,
  SessionStore,
  TwoFactorStore,
} from "@/lib/auth/ports";
import type {
  AdminIdentity,
  AdminSessionRecord,
  LoginAttemptRecord,
  RecoveryCodeRecord,
  TwoFactorChallenge,
  TwoFactorState,
} from "@/lib/auth/types";
import { validateAdminSession } from "@/lib/auth/session";

function cloneDate(value: Date | null): Date | null {
  return value ? new Date(value) : null;
}

function cloneIdentity(value: AdminIdentity): AdminIdentity {
  return { ...value };
}

function cloneSession(value: AdminSessionRecord): AdminSessionRecord {
  return {
    ...value,
    issuedAt: new Date(value.issuedAt),
    lastSeenAt: new Date(value.lastSeenAt),
    absoluteExpiresAt: new Date(value.absoluteExpiresAt),
    twoFactorCompletedAt: cloneDate(value.twoFactorCompletedAt),
    revokedAt: cloneDate(value.revokedAt),
  };
}

export class TestOnlyInMemoryAuthStores
  implements
    AdminIdentityStore,
    AuthUnitOfWork,
    SessionStore,
    TwoFactorStore,
    RecoveryCodeStore,
    LoginAttemptStore
{
  static readonly TEST_ONLY = true;
  static readonly NOT_PRODUCTION_PERSISTENCE = true;

  readonly identities = new Map<string, AdminIdentity>();
  readonly sessions = new Map<string, AdminSessionRecord>();
  readonly twoFactorStates = new Map<string, TwoFactorState>();
  readonly challenges = new Map<string, TwoFactorChallenge>();
  readonly recovery = new Map<string, RecoveryCodeRecord>();
  readonly attempts = new Map<string, LoginAttemptRecord>();
  failNextSetupTransactionAt: "enable" | "recovery" | "session_version" | null = null;
  failNextChallengeTransaction:
    | "challenge_unavailable"
    | "session_unavailable"
    | "recovery_code_unavailable"
    | null = null;
  failNextRecoveryTransactionAt:
    | "recovery_code"
    | "challenge"
    | "identity_session_version"
    | "bound_session_version"
    | "two_factor_completed"
    | null = null;

  async findById(identityId: string): Promise<AdminIdentity | null> {
    const value = this.identities.get(identityId);
    return value ? cloneIdentity(value) : null;
  }

  async findByNormalizedUsername(username: string) {
    const value = [...this.identities.values()].find((identity) => identity.username === username);
    return value ? { ...cloneIdentity(value), passwordHash: "scrypt$v1$1024$8$1$AA==$AA==" } : null;
  }

  async findByTokenHash(tokenHash: string): Promise<AdminSessionRecord | null> {
    const value = [...this.sessions.values()].find((session) => session.tokenHash === tokenHash);
    return value ? cloneSession(value) : null;
  }

  async create(session: AdminSessionRecord): Promise<void> {
    this.sessions.set(session.id, cloneSession(session));
  }

  async touchLastSeen(input: { sessionId: string; identityId: string; sessionVersion: number; seenAt: Date }): Promise<boolean> {
    const current = this.sessions.get(input.sessionId);
    if (!current || current.revokedAt) return false;
    current.lastSeenAt = new Date(Math.max(current.lastSeenAt.getTime(), input.seenAt.getTime()));
    return true;
  }

  async revoke(sessionId: string, revokedAt: Date): Promise<boolean> {
    const current = this.sessions.get(sessionId);
    if (!current || current.revokedAt) return false;
    current.revokedAt = new Date(revokedAt);
    return true;
  }

  async findByIdentityId(identityId: string): Promise<TwoFactorState | null> {
    const value = this.twoFactorStates.get(identityId);
    return value
      ? {
          ...value,
          confirmedAt: cloneDate(value.confirmedAt),
          pendingExpiresAt: cloneDate(value.pendingExpiresAt),
          recoveryCodesRotatedAt: cloneDate(value.recoveryCodesRotatedAt),
        }
      : null;
  }

  async savePendingSetup(identityId: string, encryptedSecret: string, expiresAt: Date): Promise<void> {
    const current = this.twoFactorStates.get(identityId) ?? {
      identityId,
      enabled: false,
      encryptedSecret: null,
      confirmedAt: null,
      pendingEncryptedSecret: null,
      pendingExpiresAt: null,
      recoveryCodesRotatedAt: null,
    };
    current.pendingEncryptedSecret = encryptedSecret;
    current.pendingExpiresAt = new Date(expiresAt);
    this.twoFactorStates.set(identityId, current);
  }

  async createChallenge(challenge: TwoFactorChallenge): Promise<void> {
    this.challenges.set(challenge.id, { ...challenge });
  }

  async findChallengeByTokenHash(tokenHash: string): Promise<TwoFactorChallenge | null> {
    const value = [...this.challenges.values()].find((challenge) => challenge.tokenHash === tokenHash);
    return value ? { ...value } : null;
  }

  async incrementChallengeAttempts(input: { challengeId: string; now: Date; maxAttempts: number }): Promise<boolean> {
    const current = this.challenges.get(input.challengeId);
    if (!current || current.consumedAt || current.expiresAt <= input.now || current.attemptCount >= input.maxAttempts) return false;
    current.attemptCount += 1;
    return true;
  }

  async listUnused(identityId: string): Promise<RecoveryCodeRecord[]> {
    return [...this.recovery.values()]
      .filter((record) => record.identityId === identityId && record.usedAt === null)
      .map((record) => ({ ...record }));
  }

  async find(identifierHash: string): Promise<LoginAttemptRecord | null> {
    const value = this.attempts.get(identifierHash);
    return value ? { ...value } : null;
  }

  async recordFailure(input: {
    identifierHash: string;
    now: Date;
    windowMs: number;
    maxFailures: number;
  }): Promise<LoginAttemptRecord> {
    const current = this.attempts.get(input.identifierHash);
    const windowActive = Boolean(
      current &&
        (current.lockedUntil?.getTime() ?? current.updatedAt.getTime() + input.windowMs) >
          input.now.getTime(),
    );
    const failureCount = windowActive ? current!.failureCount + 1 : 1;
    const record = {
      identifierHash: input.identifierHash,
      failureCount,
      lockedUntil:
        failureCount >= input.maxFailures
          ? new Date(input.now.getTime() + input.windowMs)
          : null,
      updatedAt: new Date(input.now),
    };
    this.attempts.set(input.identifierHash, record);
    return { ...record };
  }

  async clear(identifierHash: string): Promise<void> {
    this.attempts.delete(identifierHash);
  }

  async confirmTwoFactorSetup(input: {
    identityId: string;
    expectedSessionVersion: number;
    expectedPendingEncryptedSecret: string;
    confirmedAt: Date;
    recoveryCodes: ReadonlyArray<{ id: string; codeHash: string }>;
  }): Promise<ConfirmTwoFactorSetupTransactionResult> {
    const identity = this.identities.get(input.identityId);
    const state = this.twoFactorStates.get(input.identityId);
    if (
      !identity ||
      identity.sessionVersion !== input.expectedSessionVersion ||
      state?.pendingEncryptedSecret !== input.expectedPendingEncryptedSecret ||
      !state.pendingExpiresAt ||
      state.pendingExpiresAt.getTime() <= input.confirmedAt.getTime()
    ) {
      return { status: "conflict" };
    }
    if (this.failNextSetupTransactionAt) {
      this.failNextSetupTransactionAt = null;
      return { status: "conflict" };
    }

    const nextVersion = identity.sessionVersion + 1;
    const nextIdentity = { ...identity, sessionVersion: nextVersion, twoFactorEnabled: true };
    const nextState: TwoFactorState = {
      ...state,
      enabled: true,
      encryptedSecret: state.pendingEncryptedSecret,
      confirmedAt: new Date(input.confirmedAt),
      pendingEncryptedSecret: null,
      pendingExpiresAt: null,
      recoveryCodesRotatedAt: new Date(input.confirmedAt),
    };
    const nextRecovery = new Map(this.recovery);
    for (const [id, record] of nextRecovery) {
      if (record.identityId === input.identityId) nextRecovery.delete(id);
    }
    for (const code of input.recoveryCodes) {
      nextRecovery.set(code.id, {
        ...code,
        identityId: input.identityId,
        usedAt: null,
      });
    }

    this.identities.set(input.identityId, nextIdentity);
    this.twoFactorStates.set(input.identityId, nextState);
    this.recovery.clear();
    for (const [id, record] of nextRecovery) this.recovery.set(id, record);
    return { status: "committed", nextSessionVersion: nextVersion };
  }

  async completeTwoFactorChallenge(input: {
    challengeId: string;
    identityId: string;
    sessionId: string;
    completedAt: Date;
    recoveryCodeId: string | null;
  }): Promise<CompleteTwoFactorChallengeTransactionResult> {
    const challenge = this.challenges.get(input.challengeId);
    if (
      !challenge ||
      challenge.consumedAt ||
      challenge.expiresAt.getTime() <= input.completedAt.getTime() ||
      challenge.identityId !== input.identityId ||
      challenge.sessionId !== input.sessionId
    ) {
      return { status: "challenge_unavailable" };
    }
    const session = this.sessions.get(input.sessionId);
    const identity = this.identities.get(input.identityId);
    if (!session || !identity || session.identityId !== input.identityId) {
      return { status: "session_unavailable" };
    }
    try {
      validateAdminSession(session, identity, input.completedAt);
    } catch {
      return { status: "session_unavailable" };
    }
    const recoveryCode = input.recoveryCodeId
      ? this.recovery.get(input.recoveryCodeId)
      : null;
    if (
      input.recoveryCodeId &&
      (!recoveryCode || recoveryCode.usedAt || recoveryCode.identityId !== input.identityId)
    ) {
      return { status: "recovery_code_unavailable" };
    }
    if (this.failNextChallengeTransaction) {
      const status = this.failNextChallengeTransaction;
      this.failNextChallengeTransaction = null;
      return { status };
    }
    if (recoveryCode && this.failNextRecoveryTransactionAt) {
      this.failNextRecoveryTransactionAt = null;
      return { status: "recovery_code_unavailable" };
    }

    const nextVersion = recoveryCode ? identity.sessionVersion + 1 : identity.sessionVersion;
    const nextIdentity = recoveryCode
      ? { ...identity, sessionVersion: nextVersion }
      : identity;
    const nextSession = {
      ...session,
      sessionVersion: nextVersion,
      twoFactorCompletedAt: new Date(input.completedAt),
    };
    const nextChallenge = { ...challenge, consumedAt: new Date(input.completedAt) };
    const nextRecoveryCode = recoveryCode
      ? { ...recoveryCode, usedAt: new Date(input.completedAt) }
      : null;

    if (nextRecoveryCode) this.recovery.set(nextRecoveryCode.id, nextRecoveryCode);
    this.challenges.set(nextChallenge.id, nextChallenge);
    this.identities.set(nextIdentity.id, nextIdentity);
    this.sessions.set(nextSession.id, nextSession);
    return { status: "committed", sessionVersion: nextVersion };
  }
}
