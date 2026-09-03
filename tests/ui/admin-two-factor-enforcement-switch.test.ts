import "./setup-cleanup";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_TWO_FACTOR_ENFORCEMENT_ENV,
  isTwoFactorEnforced,
  readTwoFactorEnforcement,
  resetTwoFactorDisabledWarningForTests,
  warnTwoFactorDisabledOnce,
} from "@/lib/auth/two-factor-enforcement";
import { requireAdminTwoFactor, requireHighRiskAdminCapability } from "@/lib/auth/capabilities";
import { hashAdminSessionToken } from "@/lib/auth/session";
import type { AdminIdentityStore, SessionStore } from "@/lib/auth/ports";
import type { AdminAuthContext, AdminIdentity, AdminSessionRecord } from "@/lib/auth/types";
import { requireAdminRouteAccess } from "@/server/auth/guards";
import type { AdminRegistry } from "@/server/auth/registry";

/**
 * RC-10 — the global `ADMIN_TWO_FACTOR_ENFORCEMENT` switch
 * (`@/lib/auth/two-factor-enforcement.ts`) and its two backend choke points:
 * `requireAdminTwoFactor` (`@/lib/auth/capabilities.ts`, the single function
 * `enforceCapability`/`requireAdminServiceMutation`/
 * `requireFreshAdminServiceMutation` all funnel through) and
 * `enforceAdminSessionTwoFactor` (`@/server/auth/guards.ts`, a private helper
 * with its own independent "identity never enabled 2FA" throw that does not
 * go through `requireAdminTwoFactor` at all, so it needs its own coverage).
 *
 * Page-guard, login-action and postAuthDestination coverage for both modes
 * lives alongside the existing scaffolding for those functions:
 * `admin-page-guard-redirect.test.ts`, `admin-login-action.test.ts`,
 * `admin-auth-session-lib.test.ts`.
 */

describe("readTwoFactorEnforcement / isTwoFactorEnforced — fail-closed table", () => {
  // Owner correction (2026-09-04, same day as the initial cut): canonical
  // values are `true` (enforced, default) / `false` (disabled);
  // `required`/`disabled` (the initial cut's wording) remain accepted
  // synonyms. Comparison is trim + case-insensitive. Anything other than
  // the exact `false`/`disabled` — including unset, `true`, `required`,
  // `0`, `off`, `no`, an empty string, or garbage — resolves to "required"
  // (fail-closed).
  it.each([
    [undefined, "required"],
    ["true", "required"],
    ["TRUE", "required"],
    ["required", "required"],
    ["REQUIRED", "required"],
    ["yes", "required"],
    ["1", "required"],
    ["0", "required"],
    ["off", "required"],
    ["no", "required"],
    ["disable", "required"],
    ["Disable", "required"],
    ["", "required"],
    ["garbage-value", "required"],
    ["false", "disabled"],
    ["FALSE", "disabled"],
    [" false ", "disabled"],
    ["False", "disabled"],
    ["disabled", "disabled"],
    ["DISABLED", "disabled"],
    ["Disabled", "disabled"],
    [" disabled ", "disabled"],
    ["\tdisabled\n", "disabled"],
    ["\tfalse\n", "disabled"],
  ] as const)("%j -> %s", (raw, expected) => {
    const env = (raw === undefined ? {} : { [ADMIN_TWO_FACTOR_ENFORCEMENT_ENV]: raw }) as NodeJS.ProcessEnv;
    expect(readTwoFactorEnforcement(env)).toBe(expected);
    expect(isTwoFactorEnforced(env)).toBe(expected === "required");
  });

  it("defaults to process.env when no env argument is given, and accepts both the canonical value and its synonym", () => {
    const original = process.env[ADMIN_TWO_FACTOR_ENFORCEMENT_ENV];
    delete process.env[ADMIN_TWO_FACTOR_ENFORCEMENT_ENV];
    try {
      expect(readTwoFactorEnforcement()).toBe("required");
      expect(isTwoFactorEnforced()).toBe(true);
      process.env[ADMIN_TWO_FACTOR_ENFORCEMENT_ENV] = "false";
      expect(readTwoFactorEnforcement()).toBe("disabled");
      expect(isTwoFactorEnforced()).toBe(false);
      process.env[ADMIN_TWO_FACTOR_ENFORCEMENT_ENV] = "disabled"; // pre-correction synonym still works
      expect(readTwoFactorEnforcement()).toBe("disabled");
      expect(isTwoFactorEnforced()).toBe(false);
    } finally {
      if (original === undefined) delete process.env[ADMIN_TWO_FACTOR_ENFORCEMENT_ENV];
      else process.env[ADMIN_TWO_FACTOR_ENFORCEMENT_ENV] = original;
    }
  });
});

describe("warnTwoFactorDisabledOnce", () => {
  afterEach(() => {
    resetTwoFactorDisabledWarningForTests();
  });

  it("logs the exact fixed message, once per process, only when disabled", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const disabled = { [ADMIN_TWO_FACTOR_ENFORCEMENT_ENV]: "disabled" } as unknown as NodeJS.ProcessEnv;

    warnTwoFactorDisabledOnce(disabled);
    warnTwoFactorDisabledOnce(disabled);
    warnTwoFactorDisabledOnce(disabled);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      "[auth] ADMIN_TWO_FACTOR_ENFORCEMENT=disabled — 2FA 未强制，仅允许本地 UAT；生产必须 required",
    );
    spy.mockRestore();
  });

  it("never logs when enforcement is required (default)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    warnTwoFactorDisabledOnce({} as NodeJS.ProcessEnv);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

function context(overrides: Partial<AdminAuthContext> = {}): AdminAuthContext {
  return {
    identity: {
      id: "id-1",
      username: "root",
      role: "super_admin",
      status: "active",
      sessionVersion: 1,
      twoFactorEnabled: true,
    },
    session: {
      id: "session-1",
      tokenHash: "hash",
      identityId: "id-1",
      sessionVersion: 1,
      issuedAt: new Date(),
      lastSeenAt: new Date(),
      absoluteExpiresAt: new Date(Date.now() + 86_400_000),
      twoFactorCompletedAt: null,
      revokedAt: null,
    },
    twoFactorCompleted: false,
    ...overrides,
  };
}

describe("requireAdminTwoFactor — capabilities.ts (the single choke point)", () => {
  it("required (default, unset env): unchanged — throws admin_two_factor_required until the session completes 2FA", () => {
    expect(() => requireAdminTwoFactor(context({ twoFactorCompleted: false }))).toThrowError(
      expect.objectContaining({ code: "admin_two_factor_required", status: 403 }),
    );
    expect(() => requireAdminTwoFactor(context({ twoFactorCompleted: true }))).not.toThrow();
  });

  it("required, explicit env with an unrecognized value: still throws (fail-closed, not just default-unset)", () => {
    const env = { [ADMIN_TWO_FACTOR_ENFORCEMENT_ENV]: "off" } as unknown as NodeJS.ProcessEnv;
    expect(() => requireAdminTwoFactor(context({ twoFactorCompleted: false }), env)).toThrowError(
      expect.objectContaining({ code: "admin_two_factor_required" }),
    );
  });

  it("disabled: never throws, regardless of twoFactorCompleted or twoFactorEnabled", () => {
    const env = { [ADMIN_TWO_FACTOR_ENFORCEMENT_ENV]: "disabled" } as unknown as NodeJS.ProcessEnv;
    expect(() =>
      requireAdminTwoFactor(
        context({ twoFactorCompleted: false, identity: { ...context().identity, twoFactorEnabled: false } }),
        env,
      ),
    ).not.toThrow();
  });

  it("disabled via the canonical value \"false\" (not just the \"disabled\" synonym): never throws", () => {
    const env = { [ADMIN_TWO_FACTOR_ENFORCEMENT_ENV]: "false" } as unknown as NodeJS.ProcessEnv;
    expect(() => requireAdminTwoFactor(context({ twoFactorCompleted: false }), env)).not.toThrow();
  });
});

describe("requireHighRiskAdminCapability — capability check still applies when 2FA is disabled", () => {
  it("required (default): throws the 2FA error for a capability-holding but not-stepped-up session", () => {
    const withEnv = { PROMO_CLAIM_USER_IDS: "id-1" } as unknown as NodeJS.ProcessEnv;
    expect(() =>
      requireHighRiskAdminCapability(context({ twoFactorCompleted: false }), "promo:claim", withEnv),
    ).toThrowError(expect.objectContaining({ code: "admin_two_factor_required" }));
  });

  it("disabled: still denies a missing capability (2FA switch is orthogonal to authorization)", () => {
    const env = { [ADMIN_TWO_FACTOR_ENFORCEMENT_ENV]: "disabled" } as unknown as NodeJS.ProcessEnv;
    expect(() =>
      requireHighRiskAdminCapability(context({ twoFactorCompleted: false }), "promo:claim", env),
    ).toThrowError(expect.objectContaining({ code: "admin_capability_denied" }));
  });

  it("disabled + capability granted: passes without ever raising a 2FA error", () => {
    const env = {
      [ADMIN_TWO_FACTOR_ENFORCEMENT_ENV]: "disabled",
      PROMO_CLAIM_USER_IDS: "id-1",
    } as unknown as NodeJS.ProcessEnv;
    expect(() =>
      requireHighRiskAdminCapability(context({ twoFactorCompleted: false }), "promo:claim", env),
    ).not.toThrow();
  });
});

// --- enforceAdminSessionTwoFactor (server/auth/guards.ts), exercised through
// its two public callers. Minimal fake stores instead of the full Postgres
// implementations; `requireAdminRouteAccess` needs identities/sessions/a
// registry entry for a GET (non-mutation) route so it returns right after
// the 2FA/capability checks without touching origin/rate-limit machinery.

const TOKEN = "rc10-guards-test-token";
const NOW = new Date("2026-09-04T00:00:00.000Z");

function fakeStores(identity: AdminIdentity, session: AdminSessionRecord) {
  const identities: AdminIdentityStore = {
    findById: async (id) => (id === identity.id ? identity : null),
    findByNormalizedUsername: async () => null,
  };
  const sessions: SessionStore = {
    findByTokenHash: async (hash) => (hash === session.tokenHash ? session : null),
    create: async () => undefined,
    touchLastSeen: async () => true,
    revoke: async () => true,
  };
  return { identities, sessions };
}

function routeFixture(overrides: { twoFactorEnabled?: boolean } = {}) {
  const identity: AdminIdentity = {
    id: "id-1",
    username: "root",
    role: "super_admin",
    status: "active",
    sessionVersion: 1,
    twoFactorEnabled: overrides.twoFactorEnabled ?? false,
  };
  const issuedAt = new Date(NOW.getTime() - 5 * 60 * 1000);
  const session: AdminSessionRecord = {
    id: "session-1",
    tokenHash: hashAdminSessionToken(TOKEN),
    identityId: identity.id,
    sessionVersion: 1,
    issuedAt,
    lastSeenAt: new Date(NOW.getTime() - 60 * 1000),
    absoluteExpiresAt: new Date(issuedAt.getTime() + 24 * 60 * 60 * 1000),
    twoFactorCompletedAt: null,
    revokedAt: null,
  };
  return { ...fakeStores(identity, session), identity, session };
}

const registry: AdminRegistry = {
  pageRoots: [],
  routes: [{ id: "test.read", path: "/api/admin/test", methods: ["GET"] }],
  actions: [],
};

describe("requireAdminRouteAccess -> enforceAdminSessionTwoFactor (server/auth/guards.ts)", () => {
  it("required (default): unchanged — an identity that never enabled 2FA is rejected before capability/route logic", async () => {
    const { identities, sessions } = routeFixture({ twoFactorEnabled: false });
    await expect(
      requireAdminRouteAccess(
        { pathname: "/api/admin/test", method: "GET", sessionToken: TOKEN },
        { identities, sessions, registry, now: NOW },
      ),
    ).rejects.toMatchObject({ code: "admin_two_factor_setup_required", status: 403 });
  });

  it("disabled: the same never-enrolled, never-stepped-up session passes through", async () => {
    const { identities, sessions } = routeFixture({ twoFactorEnabled: false });
    const env = { [ADMIN_TWO_FACTOR_ENFORCEMENT_ENV]: "disabled" } as unknown as NodeJS.ProcessEnv;
    const result = await requireAdminRouteAccess(
      { pathname: "/api/admin/test", method: "GET", sessionToken: TOKEN },
      { identities, sessions, registry, now: NOW, env },
    );
    expect(result.context.identity.id).toBe("id-1");
  });
});
