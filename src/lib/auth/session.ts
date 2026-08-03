import { createHash } from "node:crypto";

import { AdminAccessError } from "./errors";
import type { AdminIdentityStore, SessionStore } from "./ports";
import type { AdminAuthContext, AdminIdentity, AdminSessionRecord } from "./types";

export const ADMIN_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const ADMIN_ABSOLUTE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const ADMIN_SESSION_TOUCH_INTERVAL_MS = 15 * 60 * 1000;

export function hashAdminSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function expired(reason: "idle_timeout" | "absolute_timeout"): never {
  throw new AdminAccessError("jwt_expired", 401, "Admin session expired", { reason });
}

export function validateAdminSession(
  session: AdminSessionRecord,
  identity: AdminIdentity,
  now = new Date(),
): AdminAuthContext {
  const nowMs = now.getTime();
  const issuedAt = session.issuedAt.getTime();
  const lastSeenAt = session.lastSeenAt.getTime();
  const absoluteExpiresAt = session.absoluteExpiresAt.getTime();

  if (
    !session.id ||
    !session.tokenHash ||
    session.identityId !== identity.id ||
    identity.status !== "active" ||
    session.revokedAt !== null ||
    session.sessionVersion !== identity.sessionVersion ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(lastSeenAt) ||
    !Number.isFinite(absoluteExpiresAt) ||
    issuedAt > nowMs ||
    lastSeenAt < issuedAt ||
    absoluteExpiresAt > issuedAt + ADMIN_ABSOLUTE_TIMEOUT_MS
  ) {
    throw new AdminAccessError("jwt_invalid", 401, "Invalid admin session");
  }

  if (absoluteExpiresAt <= nowMs || nowMs - issuedAt >= ADMIN_ABSOLUTE_TIMEOUT_MS) {
    expired("absolute_timeout");
  }
  if (nowMs - lastSeenAt >= ADMIN_IDLE_TIMEOUT_MS) {
    expired("idle_timeout");
  }

  const completedAt = session.twoFactorCompletedAt?.getTime() ?? Number.NaN;
  const twoFactorCompleted =
    identity.twoFactorEnabled &&
    Number.isFinite(completedAt) &&
    completedAt >= issuedAt &&
    completedAt <= nowMs;

  return { identity, session, twoFactorCompleted };
}

export async function requireAdminSession(
  token: string | null | undefined,
  dependencies: {
    identities: AdminIdentityStore;
    sessions: SessionStore;
    now?: Date;
  },
): Promise<AdminAuthContext> {
  if (!token?.trim()) {
    throw new AdminAccessError("jwt_missing", 401, "Admin session is required");
  }

  const tokenHash = hashAdminSessionToken(token.trim());
  const session = await dependencies.sessions.findByTokenHash(tokenHash);
  if (!session) {
    throw new AdminAccessError("jwt_invalid", 401, "Invalid admin session");
  }

  const identity = await dependencies.identities.findById(session.identityId);
  if (!identity) {
    throw new AdminAccessError("jwt_invalid", 401, "Invalid admin session");
  }

  const now = dependencies.now ?? new Date();
  const context = validateAdminSession(session, identity, now);
  if (now.getTime() - session.lastSeenAt.getTime() >= ADMIN_SESSION_TOUCH_INTERVAL_MS) {
    if (!(await dependencies.sessions.touchLastSeen(session.id, now))) {
      throw new AdminAccessError("jwt_invalid", 401, "Invalid admin session");
    }
  }
  return context;
}
