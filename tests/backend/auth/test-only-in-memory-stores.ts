/**
 * TEST_ONLY — NOT_PRODUCTION_PERSISTENCE.
 *
 * Deterministic adapters for exercising the Auth ports. Production code must
 * provide PostgreSQL-backed adapters after the approved schema change.
 */
import type {
  AdminIdentityStore,
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

  async findById(identityId: string): Promise<AdminIdentity | null> {
    const value = this.identities.get(identityId);
    return value ? cloneIdentity(value) : null;
  }

  async advanceSessionVersion(identityId: string, expectedVersion: number): Promise<number | null> {
    const current = this.identities.get(identityId);
    if (!current || current.sessionVersion !== expectedVersion) return null;
    current.sessionVersion += 1;
    current.twoFactorEnabled = true;
    return current.sessionVersion;
  }

  async findByTokenHash(tokenHash: string): Promise<AdminSessionRecord | null> {
    const value = [...this.sessions.values()].find((session) => session.tokenHash === tokenHash);
    return value ? cloneSession(value) : null;
  }

  async touchLastSeen(sessionId: string, seenAt: Date): Promise<boolean> {
    const current = this.sessions.get(sessionId);
    if (!current || current.revokedAt) return false;
    current.lastSeenAt = new Date(seenAt);
    return true;
  }

  async markTwoFactorCompleted(sessionId: string, completedAt: Date): Promise<boolean> {
    const current = this.sessions.get(sessionId);
    if (!current || current.revokedAt) return false;
    current.twoFactorCompletedAt = new Date(completedAt);
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

  async enableFromPending(identityId: string, confirmedAt: Date): Promise<boolean> {
    const current = this.twoFactorStates.get(identityId);
    if (!current?.pendingEncryptedSecret) return false;
    current.enabled = true;
    current.encryptedSecret = current.pendingEncryptedSecret;
    current.confirmedAt = new Date(confirmedAt);
    current.pendingEncryptedSecret = null;
    current.pendingExpiresAt = null;
    return true;
  }

  async createChallenge(challenge: TwoFactorChallenge): Promise<void> {
    this.challenges.set(challenge.id, { ...challenge });
  }

  async findChallengeByTokenHash(tokenHash: string): Promise<TwoFactorChallenge | null> {
    const value = [...this.challenges.values()].find((challenge) => challenge.tokenHash === tokenHash);
    return value ? { ...value } : null;
  }

  async incrementChallengeAttempts(challengeId: string): Promise<void> {
    const current = this.challenges.get(challengeId);
    if (current) current.attemptCount += 1;
  }

  async consumeChallenge(challengeId: string, consumedAt: Date): Promise<boolean> {
    const current = this.challenges.get(challengeId);
    if (!current || current.consumedAt) return false;
    current.consumedAt = new Date(consumedAt);
    return true;
  }

  async replaceForIdentity(
    identityId: string,
    codes: ReadonlyArray<{ id: string; codeHash: string }>,
    rotatedAt: Date,
  ): Promise<void> {
    for (const [id, record] of this.recovery) {
      if (record.identityId === identityId) this.recovery.delete(id);
    }
    for (const code of codes) {
      this.recovery.set(code.id, { ...code, identityId, usedAt: null });
    }
    const state = this.twoFactorStates.get(identityId);
    if (state) state.recoveryCodesRotatedAt = new Date(rotatedAt);
  }

  async listUnused(identityId: string): Promise<RecoveryCodeRecord[]> {
    return [...this.recovery.values()]
      .filter((record) => record.identityId === identityId && record.usedAt === null)
      .map((record) => ({ ...record }));
  }

  async consumeIfUnused(codeId: string, usedAt: Date): Promise<boolean> {
    const current = this.recovery.get(codeId);
    if (!current || current.usedAt) return false;
    current.usedAt = new Date(usedAt);
    return true;
  }

  async find(identifierHash: string): Promise<LoginAttemptRecord | null> {
    const value = this.attempts.get(identifierHash);
    return value ? { ...value } : null;
  }

  async put(record: LoginAttemptRecord): Promise<void> {
    this.attempts.set(record.identifierHash, { ...record });
  }

  async deleteMany(identifierHashes: readonly string[]): Promise<void> {
    for (const identifier of identifierHashes) this.attempts.delete(identifier);
  }
}
