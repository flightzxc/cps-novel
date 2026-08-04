import { Prisma, type PrismaClient } from "@prisma/client";

import type {
  AdminIdentityStore, AuthUnitOfWork, CompleteTwoFactorChallengeTransactionResult,
  ConfirmTwoFactorSetupTransactionResult, LoginAttemptStore, RecoveryCodeStore,
  SessionStore, TwoFactorStore,
} from "./ports";
import type {
  AdminIdentity, AdminLoginIdentity, AdminSessionRecord, LoginAttemptRecord,
  RecoveryCodeRecord, TwoFactorChallenge, TwoFactorState,
} from "./types";

function identityView(row: {
  id: string; username: string; role: string; status: string; sessionVersion: number;
  twoFactor?: { enabled: boolean } | null;
}): AdminIdentity {
  return {
    id: row.id, username: row.username, role: row.role,
    status: row.status === "active" ? "active" : "disabled",
    sessionVersion: row.sessionVersion, twoFactorEnabled: row.twoFactor?.enabled === true,
  };
}

export class PostgreSQLAdminIdentityStore implements AdminIdentityStore {
  constructor(private readonly db: PrismaClient) {}
  async findById(identityId: string): Promise<AdminIdentity | null> {
    const row = await this.db.adminIdentity.findUnique({ where: { id: identityId }, include: { twoFactor: true } });
    return row ? identityView(row) : null;
  }
  async findByNormalizedUsername(username: string): Promise<AdminLoginIdentity | null> {
    const row = await this.db.adminIdentity.findUnique({ where: { username }, include: { twoFactor: true } });
    return row ? { ...identityView(row), passwordHash: row.passwordHash } : null;
  }
}

export class PostgreSQLSessionStore implements SessionStore {
  constructor(private readonly db: PrismaClient) {}
  async findByTokenHash(tokenHash: string): Promise<AdminSessionRecord | null> {
    return this.db.adminSession.findUnique({ where: { tokenHash } });
  }
  async create(session: AdminSessionRecord): Promise<void> {
    await this.db.adminSession.create({ data: session });
  }
  async touchLastSeen(input: { sessionId: string; identityId: string; sessionVersion: number; seenAt: Date }): Promise<boolean> {
    const count = await this.db.$executeRaw`
      UPDATE admin_session s SET last_seen_at = GREATEST(s.last_seen_at, ${input.seenAt})
      WHERE s.id = ${input.sessionId}::uuid AND s.identity_id = ${input.identityId}::uuid
        AND s.session_version = ${input.sessionVersion} AND s.revoked_at IS NULL
        AND s.absolute_expires_at > ${input.seenAt}
        AND EXISTS (SELECT 1 FROM admin_identity i WHERE i.id=s.identity_id AND i.status='active' AND i.session_version=s.session_version)
    `;
    return count === 1;
  }
  async revoke(sessionId: string, revokedAt: Date): Promise<boolean> {
    return (await this.db.adminSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt } })).count === 1;
  }
}

export class PostgreSQLTwoFactorStore implements TwoFactorStore {
  constructor(private readonly db: PrismaClient) {}
  async findByIdentityId(identityId: string): Promise<TwoFactorState | null> {
    const row = await this.db.adminTwoFactor.findUnique({ where: { identityId } });
    return row;
  }
  async savePendingSetup(identityId: string, encryptedSecret: string, expiresAt: Date): Promise<void> {
    await this.db.adminTwoFactor.upsert({
      where: { identityId },
      create: { identityId, pendingEncryptedSecret: encryptedSecret, pendingKeyVersion: 1, pendingExpiresAt: expiresAt },
      update: { pendingEncryptedSecret: encryptedSecret, pendingKeyVersion: 1, pendingExpiresAt: expiresAt },
    });
  }
  async createChallenge(challenge: TwoFactorChallenge): Promise<void> {
    await this.db.adminTwoFactorChallenge.create({ data: challenge });
  }
  async findChallengeByTokenHash(tokenHash: string): Promise<TwoFactorChallenge | null> {
    return this.db.adminTwoFactorChallenge.findUnique({ where: { tokenHash } });
  }
  async incrementChallengeAttempts(input: { challengeId: string; now: Date; maxAttempts: number }): Promise<boolean> {
    const count = await this.db.$executeRaw`
      UPDATE admin_two_factor_challenge SET attempt_count=attempt_count+1
      WHERE id=${input.challengeId}::uuid AND consumed_at IS NULL AND expires_at>${input.now}
        AND attempt_count<${input.maxAttempts}
    `;
    return count === 1;
  }
}

export class PostgreSQLRecoveryCodeStore implements RecoveryCodeStore {
  constructor(private readonly db: PrismaClient) {}
  async listUnused(identityId: string): Promise<RecoveryCodeRecord[]> {
    return this.db.adminRecoveryCode.findMany({ where: { identityId, usedAt: null }, orderBy: { createdAt: "asc" } });
  }
}

export class PostgreSQLLoginAttemptStore implements LoginAttemptStore {
  constructor(private readonly db: PrismaClient) {}
  async find(identifierHash: string): Promise<LoginAttemptRecord | null> {
    return this.db.adminLoginAttempt.findUnique({ where: { identifierHash } });
  }
  async recordFailure(input: { identifierHash: string; now: Date; windowMs: number; maxFailures: number }): Promise<LoginAttemptRecord> {
    const rows = await this.db.$queryRaw<LoginAttemptRecord[]>(Prisma.sql`
      INSERT INTO admin_login_attempt(identifier_hash,failure_count,locked_until,updated_at)
      VALUES (${input.identifierHash},1,NULL,${input.now})
      ON CONFLICT(identifier_hash) DO UPDATE SET
        failure_count=CASE WHEN admin_login_attempt.updated_at <= ${input.now} - (${input.windowMs} * interval '1 millisecond')
          OR (admin_login_attempt.locked_until IS NOT NULL AND admin_login_attempt.locked_until <= ${input.now})
          THEN 1 ELSE admin_login_attempt.failure_count+1 END,
        locked_until=CASE
          WHEN (CASE WHEN admin_login_attempt.updated_at <= ${input.now} - (${input.windowMs} * interval '1 millisecond')
            OR (admin_login_attempt.locked_until IS NOT NULL AND admin_login_attempt.locked_until <= ${input.now})
            THEN 1 ELSE admin_login_attempt.failure_count+1 END) >= ${input.maxFailures}
          THEN ${input.now} + (${input.windowMs} * interval '1 millisecond') ELSE NULL END,
        updated_at=${input.now}
      RETURNING identifier_hash AS "identifierHash", failure_count AS "failureCount", locked_until AS "lockedUntil", updated_at AS "updatedAt"
    `);
    return rows[0];
  }
  async clear(identifierHash: string): Promise<void> {
    await this.db.adminLoginAttempt.deleteMany({ where: { identifierHash } });
  }
}

export type AuthTransactionStage =
  | "setup_enabled" | "setup_recovery" | "setup_version"
  | "recovery_code" | "challenge_consumed" | "identity_session_version"
  | "bound_session_version" | "two_factor_completed";

/** The callback is for disposable-database rollback tests only; production construction omits it. */
export class PostgreSQLAuthUnitOfWork implements AuthUnitOfWork {
  constructor(private readonly db: PrismaClient, private readonly testOnlyAfterStage?: (stage: AuthTransactionStage) => void) {}
  private stage(stage: AuthTransactionStage) { this.testOnlyAfterStage?.(stage); }

  async confirmTwoFactorSetup(input: {
    identityId: string; expectedSessionVersion: number; expectedPendingEncryptedSecret: string;
    confirmedAt: Date; recoveryCodes: ReadonlyArray<{ id: string; codeHash: string }>;
  }): Promise<ConfirmTwoFactorSetupTransactionResult> {
    return this.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ session_version: number }>>`
        SELECT i.session_version FROM admin_identity i JOIN admin_two_factor f ON f.identity_id=i.id
        WHERE i.id=${input.identityId}::uuid AND i.status='active'
          AND i.session_version=${input.expectedSessionVersion}
          AND f.pending_encrypted_secret=${input.expectedPendingEncryptedSecret}
          AND f.pending_expires_at>${input.confirmedAt}
        FOR UPDATE OF i,f
      `;
      if (locked.length !== 1) return { status: "conflict" } as const;
      await tx.adminTwoFactor.update({ where: { identityId: input.identityId }, data: {
        enabled: true, encryptedSecret: input.expectedPendingEncryptedSecret, keyVersion: 1,
        confirmedAt: input.confirmedAt, pendingEncryptedSecret: null, pendingKeyVersion: null,
        pendingExpiresAt: null, recoveryCodesRotatedAt: input.confirmedAt,
      } });
      this.stage("setup_enabled");
      await tx.adminRecoveryCode.deleteMany({ where: { identityId: input.identityId } });
      await tx.adminRecoveryCode.createMany({ data: input.recoveryCodes.map((code) => ({ ...code, identityId: input.identityId })) });
      this.stage("setup_recovery");
      const identity = await tx.adminIdentity.update({ where: { id: input.identityId }, data: { sessionVersion: { increment: 1 } } });
      this.stage("setup_version");
      return { status: "committed", nextSessionVersion: identity.sessionVersion } as const;
    });
  }

  async completeTwoFactorChallenge(input: {
    challengeId: string; identityId: string; sessionId: string; completedAt: Date; recoveryCodeId: string | null;
  }): Promise<CompleteTwoFactorChallengeTransactionResult> {
    return this.db.$transaction(async (tx) => {
      const challenges = await tx.$queryRaw<Array<{ attempt_count: number }>>`
        SELECT attempt_count FROM admin_two_factor_challenge
        WHERE id=${input.challengeId}::uuid AND identity_id=${input.identityId}::uuid
          AND session_id=${input.sessionId}::uuid AND consumed_at IS NULL
          AND expires_at>${input.completedAt} AND attempt_count<5 FOR UPDATE
      `;
      if (challenges.length !== 1) return { status: "challenge_unavailable" } as const;
      const sessions = await tx.$queryRaw<Array<{ session_version: number }>>`
        SELECT s.session_version FROM admin_session s JOIN admin_identity i ON i.id=s.identity_id
        WHERE s.id=${input.sessionId}::uuid AND s.identity_id=${input.identityId}::uuid
          AND s.revoked_at IS NULL AND s.absolute_expires_at>${input.completedAt}
          AND s.session_version=i.session_version AND i.status='active' FOR UPDATE OF s,i
      `;
      if (sessions.length !== 1) return { status: "session_unavailable" } as const;
      let version = sessions[0].session_version;
      if (input.recoveryCodeId) {
        const used = await tx.adminRecoveryCode.updateMany({ where: { id: input.recoveryCodeId, identityId: input.identityId, usedAt: null }, data: { usedAt: input.completedAt } });
        if (used.count !== 1) return { status: "recovery_code_unavailable" } as const;
        this.stage("recovery_code");
      }
      await tx.adminTwoFactorChallenge.update({ where: { id: input.challengeId }, data: { consumedAt: input.completedAt } });
      this.stage("challenge_consumed");
      if (input.recoveryCodeId) {
        const identity = await tx.adminIdentity.update({ where: { id: input.identityId }, data: { sessionVersion: { increment: 1 } } });
        version = identity.sessionVersion;
        this.stage("identity_session_version");
        await tx.adminSession.update({ where: { id: input.sessionId }, data: { sessionVersion: version } });
        this.stage("bound_session_version");
      }
      await tx.adminSession.update({ where: { id: input.sessionId }, data: { twoFactorCompletedAt: input.completedAt } });
      if (input.recoveryCodeId) this.stage("two_factor_completed");
      return { status: "committed", sessionVersion: version } as const;
    });
  }
}
