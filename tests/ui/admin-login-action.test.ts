import "./setup-cleanup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminAccessError } from "@/lib/auth/errors";
import type { AdminAuthContext } from "@/lib/auth/types";

/**
 * PR-C1 · `login/_actions.ts` — `loginAction`'s own wiring, not the page or
 * form's reaction to it (that's `admin-login-page.test.tsx`, which mocks
 * this whole module). This file proves the action itself: does it enforce
 * same-origin before touching credentials, does it forward the right args to
 * `authenticateAdminLogin`, does it write the session cookie unconditionally,
 * and does it branch to `/two-factor/setup` vs `/two-factor/challenge` on the
 * identity's `twoFactorEnabled` — never distinguishing a bad username from a
 * bad password along the way.
 *
 * Mocks the service boundary (`authenticateAdminLogin`, `createTwoFactorChallenge`),
 * the store factories (`auth-deps.ts` — real Postgres classes never get near
 * jsdom) and `next/headers`. `requireSameOriginSubmission`, `safeNextPath`,
 * `writeSessionCookie` / `writeTwoFactorChallengeCookie` and `toErrorEnvelope`
 * all run for real — their own logic is covered by
 * `admin-auth-session-lib.test.ts`, `admin-content-errors.test.tsx` etc., so
 * this file only needs to prove `loginAction` calls them correctly.
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

function identity(overrides: Partial<AdminAuthContext["identity"]> = {}): AdminAuthContext["identity"] {
  return {
    id: "id-1",
    username: "root",
    role: "super_admin",
    status: "active",
    sessionVersion: 1,
    twoFactorEnabled: true,
    ...overrides,
  };
}

function context(overrides: Partial<AdminAuthContext["identity"]> = {}): AdminAuthContext {
  return {
    identity: identity(overrides),
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
  };
}

beforeEach(() => {
  cookieJar.get.mockReset();
  cookieJar.set.mockReset();
  headersMock.get.mockReset();
  headersMock.get.mockImplementation((name: string) =>
    name === "origin" ? "https://admin.example.com" : null,
  );
  authenticateAdminLogin.mockReset();
  createTwoFactorChallenge.mockReset();
  guardDependencies.mockClear();
  loginAttemptStore.mockClear();
  twoFactorStore.mockClear();
  process.env.ADMIN_CANONICAL_ORIGIN = "https://admin.example.com";
});

afterEach(() => {
  delete process.env.ADMIN_CANONICAL_ORIGIN;
});

describe("loginAction — same-origin is enforced before any credential check", () => {
  it("rejects a cross-origin submission without ever calling authenticateAdminLogin", async () => {
    headersMock.get.mockImplementation((name: string) => (name === "origin" ? "https://evil.example" : null));

    const result = await loginAction({ username: "root", password: "pw" });

    expect(result).toEqual({ ok: false, envelope: expect.objectContaining({ code: "admin_origin_denied" }) });
    expect(authenticateAdminLogin).not.toHaveBeenCalled();
    expect(cookieJar.set).not.toHaveBeenCalled();
  });
});

describe("loginAction — credential failure and lockout, no cookie either way", () => {
  it("surfaces jwt_invalid without writing a cookie (bad password or unknown username alike)", async () => {
    authenticateAdminLogin.mockRejectedValue(new AdminAccessError("jwt_invalid", 401, "Invalid admin credentials"));

    const result = await loginAction({ username: "nobody", password: "wrong" });

    expect(result).toEqual({ ok: false, envelope: expect.objectContaining({ code: "jwt_invalid", status: 401 }) });
    expect(cookieJar.set).not.toHaveBeenCalled();
  });

  it("surfaces admin_rate_limited with the retry window from the lockout", async () => {
    authenticateAdminLogin.mockRejectedValue(
      new AdminAccessError("admin_rate_limited", 429, "Admin login is locked", { retryAfterSeconds: "42" }),
    );

    const result = await loginAction({ username: "root", password: "whatever" });

    expect(result).toEqual({
      ok: false,
      envelope: expect.objectContaining({
        code: "admin_rate_limited",
        status: 429,
        details: { retryAfterSeconds: "42" },
      }),
    });
  });
});

describe("loginAction — forwards the resolved client IP and store handles to authenticateAdminLogin", () => {
  it("passes the first x-forwarded-for hop as ip, plus the store factories and guard dependencies", async () => {
    headersMock.get.mockImplementation((name: string) => {
      if (name === "origin") return "https://admin.example.com";
      if (name === "x-forwarded-for") return "203.0.113.9, 10.0.0.1";
      return null;
    });
    authenticateAdminLogin.mockResolvedValue({ token: "tok", context: context({ twoFactorEnabled: false }) });

    await loginAction({ username: "root", password: "pw" });

    expect(authenticateAdminLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        username: "root",
        password: "pw",
        ip: "203.0.113.9",
        identities: {},
        sessions: {},
        attempts: { marker: "login-attempt-store" },
      }),
    );
  });
});

describe("loginAction — success, 2FA never enabled -> forced setup, not straight into the backend", () => {
  it("writes the session cookie and routes to /two-factor/setup, skipping the 2FA challenge entirely", async () => {
    authenticateAdminLogin.mockResolvedValue({ token: "session-token", context: context({ twoFactorEnabled: false }) });

    const result = await loginAction({ username: "root", password: "pw" });

    expect(cookieJar.set).toHaveBeenCalledWith(
      "__Host-cps_admin_session",
      "session-token",
      expect.objectContaining({ httpOnly: true, secure: true, sameSite: "strict" }),
    );
    expect(createTwoFactorChallenge).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, next: "/two-factor/setup" });
  });

  it("carries a validated ?next= through the detour", async () => {
    authenticateAdminLogin.mockResolvedValue({ token: "session-token", context: context({ twoFactorEnabled: false }) });

    const result = await loginAction({ username: "root", password: "pw", next: "/tags" });

    expect(result).toEqual({ ok: true, next: "/two-factor/setup?next=%2Ftags" });
  });

  it("drops an unregistered or open-redirect-shaped next instead of forwarding it", async () => {
    authenticateAdminLogin.mockResolvedValue({ token: "session-token", context: context({ twoFactorEnabled: false }) });

    const result = await loginAction({ username: "root", password: "pw", next: "https://evil.example" });

    expect(result).toEqual({ ok: true, next: "/two-factor/setup" });
  });
});

describe("loginAction — success, 2FA enabled -> challenge issued and its cookie written", () => {
  it("creates the challenge against the freshly-issued context and writes its token as the 2FA cookie", async () => {
    const loggedInContext = context({ twoFactorEnabled: true });
    authenticateAdminLogin.mockResolvedValue({ token: "session-token", context: loggedInContext });
    createTwoFactorChallenge.mockResolvedValue({
      token: "challenge-token",
      expiresAt: new Date(),
      sessionId: "session-1",
    });

    const result = await loginAction({ username: "root", password: "pw", next: "/novels" });

    expect(createTwoFactorChallenge).toHaveBeenCalledWith({
      context: loggedInContext,
      twoFactor: { marker: "two-factor-store" },
    });
    expect(cookieJar.set).toHaveBeenCalledWith(
      "__Host-cps_admin_2fa",
      "challenge-token",
      expect.objectContaining({ httpOnly: true, secure: true, sameSite: "strict" }),
    );
    expect(result).toEqual({ ok: true, next: "/two-factor/challenge?next=%2Fnovels" });
  });
});

describe("loginAction — RC-10 ADMIN_TWO_FACTOR_ENFORCEMENT=disabled", () => {
  afterEach(() => {
    delete process.env.ADMIN_TWO_FACTOR_ENFORCEMENT;
  });

  it("skips both the setup and challenge detours and lands on the validated deep link", async () => {
    process.env.ADMIN_TWO_FACTOR_ENFORCEMENT = "disabled";
    authenticateAdminLogin.mockResolvedValue({
      token: "session-token",
      context: context({ twoFactorEnabled: false }),
    });

    const result = await loginAction({ username: "root", password: "pw", next: "/tags" });

    expect(createTwoFactorChallenge).not.toHaveBeenCalled();
    expect(cookieJar.set).toHaveBeenCalledTimes(1); // session cookie only, no 2FA challenge cookie
    expect(result).toEqual({ ok: true, next: "/tags" });
  });

  it("falls back to the landing page when next is absent, even for an already-2FA-enrolled identity", async () => {
    process.env.ADMIN_TWO_FACTOR_ENFORCEMENT = "disabled";
    authenticateAdminLogin.mockResolvedValue({
      token: "session-token",
      context: context({ twoFactorEnabled: true }),
    });

    const result = await loginAction({ username: "root", password: "pw" });

    expect(createTwoFactorChallenge).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, next: ADMIN_LANDING_PATH });
  });
});
