import "./setup-cleanup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * RC-11 — Owner's six-item test matrix for the local-admin-auth-recovery
 * change (`docs/operations/ADMIN_AUTH_RECOVERY_2026-09-04.md`). Items already
 * covered by RC-10's own suites are cross-referenced rather than duplicated:
 *
 *   1. enforcement=false + already-bound identity + stale challenge/session
 *      -> straight to the backend, never the challenge. `loginAction`'s half
 *      is `admin-login-action.test.ts`'s "falls back to the landing page ...
 *      even for an already-2FA-enrolled identity" case. This file adds the
 *      two gaps that test did not cover: `postAuthDestination` and
 *      `requireAdminPage` for the SAME combination (enrolled identity,
 *      `twoFactorCompleted: false` — the literal shape of a session that
 *      completed a challenge before, then had the whole switch flipped off,
 *      or was reissued mid-incident) -- both existing files only exercised
 *      that branch with `twoFactorEnabled: false`.
 *   2. enforcement=true + never enrolled -> setup. Already fully covered by
 *      `admin-login-action.test.ts` and `admin-page-guard-redirect.test.ts`;
 *      not duplicated here.
 *   3. setup action returns `qrCodeDataUrl` — covered by
 *      `admin-two-factor-setup-action.test.ts` and
 *      `tests/backend/auth/totp-qr.test.ts`.
 *   4. bound identity, no challenge completed this session -> challenge.
 *      Already covered by `admin-login-action.test.ts`'s "success, 2FA
 *      enabled" describe block and `admin-page-guard-redirect.test.ts`'s
 *      "session-level step-up" describe block.
 *   5/6. reset/seed scripts — `tests/backend/auth/reset-admin-auth-state
 *      .test.ts` and `tests/backend/auth/ensure-local-admin-identities
 *      .test.ts`.
 */

describe("postAuthDestination — RC-11: enforcement disabled collapses even a stale step-up session", () => {
  it("an already-2FA-enrolled identity whose session never completed a challenge still lands on the deep link, not /two-factor/challenge", async () => {
    const { postAuthDestination, ADMIN_LANDING_PATH, TWO_FACTOR_CHALLENGE_PATH } = await import(
      "@/app/(admin-auth)/_lib/auth-session"
    );
    const disabledEnv = { ADMIN_TWO_FACTOR_ENFORCEMENT: "disabled" } as unknown as NodeJS.ProcessEnv;
    const staleContext = {
      identity: {
        id: "id-1", username: "x8-owner", role: "super_admin", status: "active" as const,
        sessionVersion: 1, twoFactorEnabled: true,
      },
      // The exact shape of "this identity finished 2FA setup at some point in
      // the past (or on a prior volume) but the CURRENT session never
      // completed a challenge" -- what admin-page-guard-redirect.test.ts and
      // admin-auth-session-lib.test.ts's own RC-10 blocks never combined
      // with twoFactorEnabled: true.
      twoFactorCompleted: false,
    };

    expect(postAuthDestination(staleContext, "/tags", disabledEnv)).toBe("/tags");
    expect(postAuthDestination(staleContext, undefined, disabledEnv)).toBe(ADMIN_LANDING_PATH);
    // Sanity: the same context WOULD hit the challenge path once enforcement
    // is back to its fail-closed default -- proves this test is exercising
    // the enforcement gate, not some other branch that always skips it.
    expect(postAuthDestination(staleContext, "/tags")).toBe(TWO_FACTOR_CHALLENGE_PATH);
  });
});

describe("requireAdminPage — RC-11: enforcement disabled renders normally for an enrolled-but-not-stepped-up session", () => {
  const redirectMock = vi.hoisted(() =>
    vi.fn((url: string) => {
      throw Object.assign(new Error(`NEXT_REDIRECT:${url}`), { digest: `NEXT_REDIRECT;replace;${url}` });
    }),
  );
  const requireAdminPageAccess = vi.hoisted(() => vi.fn());
  const readSessionToken = vi.hoisted(() => vi.fn(() => Promise.resolve("token")));

  beforeEach(() => {
    vi.resetModules();
    redirectMock.mockClear();
    requireAdminPageAccess.mockReset();
  });

  afterEach(() => {
    delete process.env.ADMIN_TWO_FACTOR_ENFORCEMENT;
    vi.doUnmock("next/navigation");
    vi.doUnmock("@/server/auth/guards");
    vi.doUnmock("@/app/api/admin/_lib/deps");
  });

  it("does not redirect to /two-factor/challenge for an enrolled identity with twoFactorCompleted: false, once ADMIN_TWO_FACTOR_ENFORCEMENT=disabled", async () => {
    process.env.ADMIN_TWO_FACTOR_ENFORCEMENT = "disabled";
    vi.doMock("next/navigation", () => ({ redirect: redirectMock }));
    vi.doMock("@/server/auth/guards", () => ({ requireAdminPageAccess }));
    vi.doMock("@/app/api/admin/_lib/deps", () => ({ readSessionToken, guardDependencies: () => ({}) }));

    const staleEnrolledContext = {
      identity: {
        id: "id-1", username: "x8-owner", role: "super_admin", status: "active" as const,
        sessionVersion: 1, twoFactorEnabled: true,
      },
      session: {},
      twoFactorCompleted: false,
    };
    requireAdminPageAccess.mockResolvedValue(staleEnrolledContext);

    const { requireAdminPage } = await import("@/app/(admin)/_lib/page-guard");
    const context = await requireAdminPage("/novels");

    expect(redirectMock).not.toHaveBeenCalled();
    expect(context).toEqual(staleEnrolledContext);
  });
});

describe("loginAction — RC-11: same combination at the login-action layer, cross-checked with an unauthenticated old session cookie present", () => {
  const cookieJar = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
  const headersMock = vi.hoisted(() => ({ get: vi.fn() }));
  const authenticateAdminLogin = vi.hoisted(() => vi.fn());
  const createTwoFactorChallenge = vi.hoisted(() => vi.fn());
  const guardDependencies = vi.hoisted(() => vi.fn(() => ({ identities: {}, sessions: {} })));
  const loginAttemptStore = vi.hoisted(() => vi.fn(() => ({ marker: "login-attempt-store" })));
  const twoFactorStore = vi.hoisted(() => vi.fn(() => ({ marker: "two-factor-store" })));

  beforeEach(() => {
    vi.resetModules();
    cookieJar.get.mockReset();
    cookieJar.set.mockReset();
    headersMock.get.mockReset();
    headersMock.get.mockImplementation((name: string) => (name === "origin" ? "https://admin.example.com" : null));
    authenticateAdminLogin.mockReset();
    createTwoFactorChallenge.mockReset();
    guardDependencies.mockClear();
    loginAttemptStore.mockClear();
    twoFactorStore.mockClear();
    process.env.ADMIN_CANONICAL_ORIGIN = "https://admin.example.com";
    process.env.ADMIN_TWO_FACTOR_ENFORCEMENT = "disabled";

    vi.doMock("next/headers", () => ({ cookies: () => Promise.resolve(cookieJar), headers: () => Promise.resolve(headersMock) }));
    vi.doMock("@/lib/auth/login", () => ({ authenticateAdminLogin }));
    vi.doMock("@/lib/auth/two-factor", () => ({ createTwoFactorChallenge }));
    vi.doMock("@/app/api/admin/_lib/deps", () => ({
      guardDependencies, canonicalOrigin: () => Promise.resolve("https://admin.example.com"),
      readSessionToken: () => Promise.resolve(null),
    }));
    vi.doMock("@/app/api/admin/_lib/auth-deps", () => ({ loginAttemptStore, twoFactorStore }));
  });

  afterEach(() => {
    delete process.env.ADMIN_CANONICAL_ORIGIN;
    delete process.env.ADMIN_TWO_FACTOR_ENFORCEMENT;
    vi.doUnmock("next/headers");
    vi.doUnmock("@/lib/auth/login");
    vi.doUnmock("@/lib/auth/two-factor");
    vi.doUnmock("@/app/api/admin/_lib/deps");
    vi.doUnmock("@/app/api/admin/_lib/auth-deps");
  });

  it("a fresh login for an enrolled identity goes straight to the backend and issues no challenge, even though a stale 2FA challenge cookie is still sitting in the jar from before the incident", async () => {
    // The stale cookie itself is irrelevant to loginAction (it only ever
    // WRITES cookies, on a fresh authentication) -- this documents that
    // fact rather than exercising a code path that reads it.
    cookieJar.get.mockReturnValue({ value: "stale-pre-incident-challenge-token" });
    authenticateAdminLogin.mockResolvedValue({
      token: "session-token",
      context: {
        identity: { id: "id-1", username: "x8-owner", role: "super_admin", status: "active", sessionVersion: 1, twoFactorEnabled: true },
        session: { id: "session-1", tokenHash: "hash", identityId: "id-1", sessionVersion: 1, issuedAt: new Date(), lastSeenAt: new Date(), absoluteExpiresAt: new Date(Date.now() + 86_400_000), twoFactorCompletedAt: null, revokedAt: null },
        twoFactorCompleted: false,
      },
    });

    const { loginAction } = await import("@/app/(admin-auth)/login/_actions");
    const result = await loginAction({ username: "x8-owner", password: "pw" });

    expect(createTwoFactorChallenge).not.toHaveBeenCalled();
    expect(cookieJar.set).toHaveBeenCalledTimes(1); // session cookie only
    expect(result).toEqual({ ok: true, next: expect.any(String) });
  });
});
