import "./setup-cleanup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * RC-11 review fixup — the one invariant that must survive the RC-10 switch in
 * *both* directions: an identity that has never bound 2FA must never be routed
 * to `/two-factor/challenge`, because that screen is a dead end for it (no
 * authenticator entry, no recovery codes — exactly the 2026-09-04 incident).
 *
 * `admin-login-action.test.ts` already covers each mode's happy path. What is
 * pinned *here* is the pair of cross-checks the RC-11 review asked for, both
 * with a stale pre-incident 2FA challenge cookie still sitting in the jar:
 *
 *   1. enforcement required + never bound + stale challenge cookie -> setup
 *   2. enforcement disabled + already bound + stale challenge cookie -> backend
 *
 * `loginAction` only ever *writes* cookies, so the stale cookie cannot steer
 * it — that is the property being frozen, not an incidental detail. The
 * assertions below are deliberately exact (`toEqual` on the destination, and
 * an explicit "never the challenge path"), not `expect.any(String)`.
 */

const cookieJar = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
const headersMock = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve(cookieJar),
  headers: () => Promise.resolve(headersMock),
}));

const authenticateAdminLogin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/login", () => ({ authenticateAdminLogin }));

const createTwoFactorChallenge = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/two-factor", () => ({ createTwoFactorChallenge }));

const guardDependencies = vi.hoisted(() => vi.fn(() => ({ identities: {}, sessions: {} })));
vi.mock("@/app/api/admin/_lib/deps", () => ({
  guardDependencies,
  canonicalOrigin: () => Promise.resolve("https://admin.example.com"),
  readSessionToken: () => Promise.resolve(null),
}));

const loginAttemptStore = vi.hoisted(() => vi.fn(() => ({ marker: "login-attempt-store" })));
const twoFactorStore = vi.hoisted(() => vi.fn(() => ({ marker: "two-factor-store" })));
vi.mock("@/app/api/admin/_lib/auth-deps", () => ({ loginAttemptStore, twoFactorStore }));

const { loginAction } = await import("@/app/(admin-auth)/login/_actions");
const { ADMIN_LANDING_PATH } = await import("@/app/(admin-auth)/_lib/auth-session");

const CHALLENGE_PATH = "/two-factor/challenge";

function context(twoFactorEnabled: boolean, twoFactorCompleted = false) {
  return {
    identity: {
      id: "id-1",
      username: "x8-owner",
      role: "super_admin",
      status: "active" as const,
      sessionVersion: 1,
      twoFactorEnabled,
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
    twoFactorCompleted,
  };
}

describe("loginAction — an identity that never bound 2FA is never sent to the challenge screen", () => {
  beforeEach(() => {
    cookieJar.get.mockReset();
    cookieJar.set.mockReset();
    headersMock.get.mockReset();
    headersMock.get.mockImplementation((name: string) =>
      name === "origin" ? "https://admin.example.com" : null,
    );
    authenticateAdminLogin.mockReset();
    createTwoFactorChallenge.mockReset();
    process.env.ADMIN_CANONICAL_ORIGIN = "https://admin.example.com";
    // The stale pre-incident challenge cookie, present in every case below.
    cookieJar.get.mockReturnValue({ value: "stale-pre-incident-challenge-token" });
  });

  afterEach(() => {
    delete process.env.ADMIN_CANONICAL_ORIGIN;
    delete process.env.ADMIN_TWO_FACTOR_ENFORCEMENT;
  });

  it("enforcement required + never bound + stale challenge cookie -> /two-factor/setup, never the challenge path", async () => {
    process.env.ADMIN_TWO_FACTOR_ENFORCEMENT = "true";
    authenticateAdminLogin.mockResolvedValue({ token: "session-token", context: context(false) });

    const result = await loginAction({ username: "x8-owner", password: "pw", next: "/tags" });

    expect(result).toEqual({ ok: true, next: "/two-factor/setup?next=%2Ftags" });
    expect(result.ok && result.next.startsWith(CHALLENGE_PATH)).toBe(false);
    expect(createTwoFactorChallenge).not.toHaveBeenCalled();
    expect(cookieJar.set).toHaveBeenCalledTimes(1); // session cookie only
  });

  it("same, with the env var unset entirely (fail-closed default) -> still /two-factor/setup", async () => {
    delete process.env.ADMIN_TWO_FACTOR_ENFORCEMENT;
    authenticateAdminLogin.mockResolvedValue({ token: "session-token", context: context(false) });

    const result = await loginAction({ username: "x8-owner", password: "pw" });

    expect(result).toEqual({ ok: true, next: "/two-factor/setup" });
    expect(createTwoFactorChallenge).not.toHaveBeenCalled();
  });

  it("enforcement disabled + never bound + stale challenge cookie -> straight to the backend, not the challenge path", async () => {
    process.env.ADMIN_TWO_FACTOR_ENFORCEMENT = "false";
    authenticateAdminLogin.mockResolvedValue({ token: "session-token", context: context(false) });

    const result = await loginAction({ username: "x8-owner", password: "pw" });

    expect(result).toEqual({ ok: true, next: ADMIN_LANDING_PATH });
    expect(result.ok && result.next.startsWith(CHALLENGE_PATH)).toBe(false);
    expect(createTwoFactorChallenge).not.toHaveBeenCalled();
    expect(cookieJar.set).toHaveBeenCalledTimes(1);
  });

  it("enforcement disabled + already bound + stale challenge cookie + stale uncompleted session -> exact landing path, no new challenge", async () => {
    process.env.ADMIN_TWO_FACTOR_ENFORCEMENT = "false";
    authenticateAdminLogin.mockResolvedValue({
      token: "session-token",
      context: context(true, false),
    });

    const result = await loginAction({ username: "x8-owner", password: "pw" });

    // Exact destination, not `expect.any(String)`: the whole point is that it
    // is the landing page and specifically not the challenge screen.
    expect(result).toEqual({ ok: true, next: ADMIN_LANDING_PATH });
    expect(result.ok && result.next.startsWith(CHALLENGE_PATH)).toBe(false);
    expect(createTwoFactorChallenge).not.toHaveBeenCalled();
    expect(cookieJar.set).toHaveBeenCalledTimes(1);
  });

  it("enforcement required + already bound is the ONLY combination that reaches the challenge screen", async () => {
    process.env.ADMIN_TWO_FACTOR_ENFORCEMENT = "true";
    authenticateAdminLogin.mockResolvedValue({ token: "session-token", context: context(true) });
    createTwoFactorChallenge.mockResolvedValue({ token: "fresh-challenge-token" });

    const result = await loginAction({ username: "x8-owner", password: "pw" });

    expect(result).toEqual({ ok: true, next: CHALLENGE_PATH });
    expect(createTwoFactorChallenge).toHaveBeenCalledTimes(1);
    expect(cookieJar.set).toHaveBeenCalledTimes(2); // session + fresh challenge cookie
  });
});
