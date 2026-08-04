import { randomBytes, randomUUID } from "node:crypto";

import { AdminAccessError } from "./errors";
import { clearFailedLogins, getLoginRateLimitStatus, normalizeAdminUsername, recordFailedLogin } from "./login-attempts";
import { verifyAdminPassword } from "./password";
import type { AdminIdentityStore, LoginAttemptStore, SessionStore } from "./ports";
import { ADMIN_ABSOLUTE_TIMEOUT_MS, hashAdminSessionToken } from "./session";
import type { AdminAuthContext, AdminSessionRecord } from "./types";

export async function authenticateAdminLogin(input: {
  username: string;
  password: string;
  ip: string;
  identities: AdminIdentityStore;
  sessions: SessionStore;
  attempts: LoginAttemptStore;
  now?: Date;
}): Promise<{ token: string; context: AdminAuthContext }> {
  const now = input.now ?? new Date();
  const limit = await getLoginRateLimitStatus(input.attempts, input.username, input.ip, now);
  if (limit.locked) {
    throw new AdminAccessError("admin_rate_limited", 429, "Admin login is locked", {
      retryAfterSeconds: String(Math.max(1, Math.ceil(limit.remainingMs / 1000))),
    });
  }
  const username = normalizeAdminUsername(input.username);
  const identity = await input.identities.findByNormalizedUsername(username);
  if (!identity || identity.status !== "active" || !verifyAdminPassword(input.password, identity.passwordHash)) {
    await recordFailedLogin(input.attempts, username, input.ip, now);
    throw new AdminAccessError("jwt_invalid", 401, "Invalid admin credentials");
  }
  await clearFailedLogins(input.attempts, username);
  const token = randomBytes(32).toString("base64url");
  const session: AdminSessionRecord = {
    id: randomUUID(), tokenHash: hashAdminSessionToken(token), identityId: identity.id,
    sessionVersion: identity.sessionVersion, issuedAt: now, lastSeenAt: now,
    absoluteExpiresAt: new Date(now.getTime() + ADMIN_ABSOLUTE_TIMEOUT_MS),
    twoFactorCompletedAt: null, revokedAt: null,
  };
  await input.sessions.create(session);
  const publicIdentity = {
    id: identity.id,
    username: identity.username,
    role: identity.role,
    status: identity.status,
    sessionVersion: identity.sessionVersion,
    twoFactorEnabled: identity.twoFactorEnabled,
  };
  return { token, context: { identity: publicIdentity, session, twoFactorCompleted: false } };
}

export async function revokeAdminSession(
  sessions: SessionStore,
  sessionId: string,
  now = new Date(),
): Promise<boolean> {
  return sessions.revoke(sessionId, now);
}
