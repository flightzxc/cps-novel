import { describe, expect, it } from "vitest";

import {
  ADMIN_ABSOLUTE_TIMEOUT_MS,
  ADMIN_IDLE_TIMEOUT_MS,
  ADMIN_SESSION_TOUCH_INTERVAL_MS,
  hashAdminSessionToken,
  requireAdminSession,
} from "@/lib/auth/session";
import {
  hasAdminCapability,
  requireHighRiskAdminCapability,
  type AdminCapability,
} from "@/lib/auth/capabilities";
import { AdminAccessError } from "@/lib/auth/errors";
import type { AdminIdentity, AdminSessionRecord } from "@/lib/auth/types";

import { TestOnlyInMemoryAuthStores } from "./test-only-in-memory-stores";

const NOW = new Date("2026-08-03T12:00:00.000Z");
const TOKEN = "opaque-session-token";

function fixture(options: {
  role?: string;
  twoFactorEnabled?: boolean;
  twoFactorCompletedAt?: Date | null;
  lastSeenAt?: Date;
  issuedAt?: Date;
  absoluteExpiresAt?: Date;
  revokedAt?: Date | null;
  identityVersion?: number;
  sessionVersion?: number;
} = {}) {
  const stores = new TestOnlyInMemoryAuthStores();
  const identity: AdminIdentity = {
    id: "admin-1",
    username: "admin",
    role: options.role ?? "super_admin",
    status: "active",
    sessionVersion: options.identityVersion ?? 3,
    twoFactorEnabled: options.twoFactorEnabled ?? true,
  };
  const issuedAt = options.issuedAt ?? new Date(NOW.getTime() - 60 * 60 * 1000);
  const session: AdminSessionRecord = {
    id: "session-1",
    tokenHash: hashAdminSessionToken(TOKEN),
    identityId: identity.id,
    sessionVersion: options.sessionVersion ?? 3,
    issuedAt,
    lastSeenAt: options.lastSeenAt ?? new Date(NOW.getTime() - 5 * 60 * 1000),
    absoluteExpiresAt:
      options.absoluteExpiresAt ?? new Date(issuedAt.getTime() + ADMIN_ABSOLUTE_TIMEOUT_MS),
    twoFactorCompletedAt:
      options.twoFactorCompletedAt === undefined
        ? new Date(NOW.getTime() - 30 * 60 * 1000)
        : options.twoFactorCompletedAt,
    revokedAt: options.revokedAt ?? null,
  };
  stores.identities.set(identity.id, identity);
  stores.sessions.set(session.id, session);
  return { stores, identity, session };
}

async function errorFor(action: () => Promise<unknown>): Promise<AdminAccessError> {
  try {
    await action();
    throw new Error("Expected action to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(AdminAccessError);
    return error as AdminAccessError;
  }
}

describe("admin session lifecycle", () => {
  it("distinguishes a missing token from other authentication failures", async () => {
    const { stores } = fixture();
    const error = await errorFor(() =>
      requireAdminSession(null, { identities: stores, sessions: stores, now: NOW }),
    );
    expect(error).toMatchObject({ code: "jwt_missing", status: 401 });
  });

  it("rejects idle and absolute expiry with explicit reasons", async () => {
    const idle = fixture({
      issuedAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000),
      lastSeenAt: new Date(NOW.getTime() - ADMIN_IDLE_TIMEOUT_MS),
    });
    const idleError = await errorFor(() =>
      requireAdminSession(TOKEN, { identities: idle.stores, sessions: idle.stores, now: NOW }),
    );
    expect(idleError.code).toBe("jwt_expired");
    expect(idleError.details.reason).toBe("idle_timeout");

    const absolute = fixture({ absoluteExpiresAt: new Date(NOW) });
    const absoluteError = await errorFor(() =>
      requireAdminSession(TOKEN, {
        identities: absolute.stores,
        sessions: absolute.stores,
        now: NOW,
      }),
    );
    expect(absoluteError.details.reason).toBe("absolute_timeout");
  });

  it("rejects revoked and session-version-mismatched records", async () => {
    for (const value of [
      fixture({ revokedAt: NOW }),
      fixture({ identityVersion: 4, sessionVersion: 3 }),
    ]) {
      const error = await errorFor(() =>
        requireAdminSession(TOKEN, { identities: value.stores, sessions: value.stores, now: NOW }),
      );
      expect(error).toMatchObject({ code: "jwt_invalid", status: 401 });
    }
  });

  it("touches lastSeen only after the 15 minute update interval", async () => {
    const fresh = fixture({ lastSeenAt: new Date(NOW.getTime() - ADMIN_SESSION_TOUCH_INTERVAL_MS + 1) });
    await requireAdminSession(TOKEN, { identities: fresh.stores, sessions: fresh.stores, now: NOW });
    expect(fresh.stores.sessions.get("session-1")?.lastSeenAt.getTime()).not.toBe(NOW.getTime());

    const stale = fixture({ lastSeenAt: new Date(NOW.getTime() - ADMIN_SESSION_TOUCH_INTERVAL_MS) });
    await requireAdminSession(TOKEN, { identities: stale.stores, sessions: stale.stores, now: NOW });
    expect(stale.stores.sessions.get("session-1")?.lastSeenAt).toEqual(NOW);
  });
});

describe("admin capabilities", () => {
  it("defaults only credential and takedown to super_admin", async () => {
    const { stores } = fixture();
    const context = await requireAdminSession(TOKEN, { identities: stores, sessions: stores, now: NOW });
    expect(hasAdminCapability(context, "credential:manage", {} as NodeJS.ProcessEnv)).toBe(true);
    expect(hasAdminCapability(context, "content:takedown", {} as NodeJS.ProcessEnv)).toBe(true);
    expect(hasAdminCapability(context, "promo:claim", {} as NodeJS.ProcessEnv)).toBe(false);
    expect(hasAdminCapability(context, "revenue:view", {} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("supports independent role and user allowlists", async () => {
    const { stores } = fixture({ role: "ops" });
    const context = await requireAdminSession(TOKEN, { identities: stores, sessions: stores, now: NOW });
    expect(
      hasAdminCapability(context, "promo:claim", {
        PROMO_CLAIM_ROLES: "ops",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      hasAdminCapability(context, "revenue:view", {
        REVENUE_VIEW_USER_IDS: "admin-1",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it("requires completed 2FA for every capability", async () => {
    const capabilities: AdminCapability[] = [
      "credential:manage",
      "content:takedown",
      "promo:claim",
      "revenue:view",
    ];
    const { stores } = fixture({ twoFactorCompletedAt: null });
    const context = await requireAdminSession(TOKEN, { identities: stores, sessions: stores, now: NOW });
    const env = {
      PROMO_CLAIM_USER_IDS: "admin-1",
      REVENUE_VIEW_USER_IDS: "admin-1",
    } as unknown as NodeJS.ProcessEnv;
    for (const capability of capabilities) {
      expect(() => requireHighRiskAdminCapability(context, capability, env)).toThrowError(
        expect.objectContaining({ code: "admin_two_factor_required", status: 403 }),
      );
    }
  });
});
