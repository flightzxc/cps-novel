import "./setup-cleanup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminAuthContext } from "@/lib/auth/types";

/**
 * B-39 — `loginAction` wiring of the Turnstile gate.
 *
 * Same harness as `admin-login-action.test.ts` (service boundary and store
 * factories mocked, `next/headers` stubbed, the same-origin check / cookie
 * writers / `toErrorEnvelope` real). The one difference: the mocked
 * `authenticateAdminLogin` here runs the `verifyHuman` it is handed — exactly
 * where the real one runs it, after the lockout check — so the REAL
 * `createAdminLoginHumanVerification` and `verifyAdminLoginTurnstileToken` are
 * exercised end to end; only `fetch` (Cloudflare) is a stub. The ordering and
 * lockout-accounting guarantees of the real `authenticateAdminLogin` are in
 * `tests/backend/auth/admin-login-turnstile.test.ts`.
 *
 * Keys are Cloudflare's published dummy keys; no real key, no network.
 */

const TEST_SECRET = "1x0000000000000000000000000000000AA";
const ADMIN_HOST = "zbcwf.example.test";

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

vi.mock("@/app/api/admin/_lib/deps", () => ({
  guardDependencies: () => ({ identities: {}, sessions: {} }),
  canonicalOrigin: () => Promise.resolve(`https://${ADMIN_HOST}`),
  readSessionToken: () => Promise.resolve(null),
}));
vi.mock("@/app/api/admin/_lib/auth-deps", () => ({
  loginAttemptStore: () => ({ marker: "login-attempt-store" }),
  twoFactorStore: () => ({ marker: "two-factor-store" }),
}));

const { loginAction } = await import("@/app/(admin-auth)/login/_actions");

function context(twoFactorEnabled: boolean): AdminAuthContext {
  return {
    identity: {
      id: "id-1",
      username: "root",
      role: "super_admin",
      status: "active",
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
    twoFactorCompleted: false,
  };
}

function siteverify(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

function enableTurnstile(overrides: Record<string, string> = {}) {
  vi.stubEnv("ADMIN_LOGIN_TURNSTILE_ENABLED", "true");
  vi.stubEnv("ADMIN_LOGIN_TURNSTILE_SITE_KEY", "1x00000000000000000000AA");
  vi.stubEnv("ADMIN_LOGIN_TURNSTILE_SECRET_KEY", TEST_SECRET);
  for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);
}

beforeEach(() => {
  cookieJar.get.mockReset();
  cookieJar.set.mockReset();
  headersMock.get.mockReset();
  headersMock.get.mockImplementation((name: string) => {
    if (name === "origin") return `https://${ADMIN_HOST}`;
    if (name === "x-forwarded-for") return "203.0.113.9, 10.0.0.1";
    return null;
  });
  authenticateAdminLogin.mockReset();
  authenticateAdminLogin.mockImplementation(async (args: { verifyHuman?: () => Promise<void> }) => {
    if (args.verifyHuman) await args.verifyHuman();
    return { token: "session-token", context: context(true) };
  });
  createTwoFactorChallenge.mockReset();
  createTwoFactorChallenge.mockResolvedValue({ token: "challenge-token", expiresAt: new Date(), sessionId: "session-1" });
  vi.stubEnv("ADMIN_CANONICAL_ORIGIN", `https://${ADMIN_HOST}`);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("loginAction — switch OFF", () => {
  it.each([[undefined], ["false"], ["TRUE"]])(
    "ADMIN_LOGIN_TURNSTILE_ENABLED=%s: authenticateAdminLogin gets no verifyHuman key at all and Cloudflare is never called",
    async (value) => {
      if (value !== undefined) vi.stubEnv("ADMIN_LOGIN_TURNSTILE_ENABLED", value);
      const fetchStub = siteverify({ success: true, hostname: ADMIN_HOST });
      vi.stubGlobal("fetch", fetchStub);

      const result = await loginAction({ username: "root", password: "pw", turnstileToken: "ignored-when-off" });

      expect(result).toEqual({ ok: true, next: "/two-factor/challenge" });
      const args = authenticateAdminLogin.mock.calls[0]![0] as Record<string, unknown>;
      expect("verifyHuman" in args).toBe(false);
      expect(fetchStub).not.toHaveBeenCalled();
    },
  );
});

describe("loginAction — switch ON", () => {
  it("verifies the token with Cloudflare (first x-forwarded-for hop as remoteip) and then continues to 2FA unchanged", async () => {
    enableTurnstile();
    const fetchStub = siteverify({ success: true, hostname: ADMIN_HOST });
    vi.stubGlobal("fetch", fetchStub);

    const result = await loginAction({ username: "root", password: "pw", next: "/novels", turnstileToken: "XXXX.DUMMY.TOKEN.XXXX" });

    expect(result).toEqual({ ok: true, next: "/two-factor/challenge?next=%2Fnovels" });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const body = init.body as URLSearchParams;
    expect(body.get("secret")).toBe(TEST_SECRET);
    expect(body.get("response")).toBe("XXXX.DUMMY.TOKEN.XXXX");
    expect(body.get("remoteip")).toBe("203.0.113.9");
    expect(createTwoFactorChallenge).toHaveBeenCalledTimes(1);
    expect(cookieJar.set).toHaveBeenCalledWith("__Host-cps_admin_session", "session-token", expect.anything());
    expect(cookieJar.set).toHaveBeenCalledWith("__Host-cps_admin_2fa", "challenge-token", expect.anything());
  });

  it("a rejected token returns admin_human_verification_failed and writes no cookie", async () => {
    enableTurnstile();
    vi.stubGlobal("fetch", siteverify({ success: false, "error-codes": ["invalid-input-response"] }));

    const result = await loginAction({ username: "root", password: "pw", turnstileToken: "bad" });

    expect(result).toEqual({
      ok: false,
      envelope: expect.objectContaining({ code: "admin_human_verification_failed", status: 403 }),
    });
    expect(cookieJar.set).not.toHaveBeenCalled();
    expect(createTwoFactorChallenge).not.toHaveBeenCalled();
  });

  it("a token minted for another hostname is refused", async () => {
    enableTurnstile();
    vi.stubGlobal("fetch", siteverify({ success: true, hostname: "pulsenovels.com" }));

    const result = await loginAction({ username: "root", password: "pw", turnstileToken: "wrong-site" });

    expect(result).toEqual({
      ok: false,
      envelope: expect.objectContaining({ code: "admin_human_verification_failed" }),
    });
    expect(cookieJar.set).not.toHaveBeenCalled();
  });

  it("no token at all (a client that never ran the widget) is refused without calling Cloudflare", async () => {
    enableTurnstile();
    const fetchStub = siteverify({ success: true, hostname: ADMIN_HOST });
    vi.stubGlobal("fetch", fetchStub);

    const result = await loginAction({ username: "root", password: "pw" });

    expect(result).toEqual({
      ok: false,
      envelope: expect.objectContaining({ code: "admin_human_verification_failed" }),
    });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(cookieJar.set).not.toHaveBeenCalled();
  });

  it("Cloudflare down / erroring is a fail-closed admin_human_verification_unavailable", async () => {
    enableTurnstile();
    for (const stub of [siteverify({}, 503), vi.fn(async () => { throw new TypeError("fetch failed"); })]) {
      vi.stubGlobal("fetch", stub);
      const result = await loginAction({ username: "root", password: "pw", turnstileToken: "t" });
      expect(result).toEqual({
        ok: false,
        envelope: expect.objectContaining({ code: "admin_human_verification_unavailable" }),
      });
    }
    expect(cookieJar.set).not.toHaveBeenCalled();
  });

  it("ON without a secret (never loaded) is fail-closed and never reaches Cloudflare", async () => {
    enableTurnstile({ ADMIN_LOGIN_TURNSTILE_SECRET_KEY: "" });
    const fetchStub = siteverify({ success: true, hostname: ADMIN_HOST });
    vi.stubGlobal("fetch", fetchStub);

    const result = await loginAction({ username: "root", password: "pw", turnstileToken: "t" });

    expect(result).toEqual({
      ok: false,
      envelope: expect.objectContaining({ code: "admin_human_verification_unavailable" }),
    });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(cookieJar.set).not.toHaveBeenCalled();
  });

  it("the same-origin check still comes first: a cross-origin post never reaches the gate or Cloudflare", async () => {
    enableTurnstile();
    const fetchStub = siteverify({ success: true, hostname: ADMIN_HOST });
    vi.stubGlobal("fetch", fetchStub);
    headersMock.get.mockImplementation((name: string) => (name === "origin" ? "https://evil.example" : null));

    const result = await loginAction({ username: "root", password: "pw", turnstileToken: "t" });

    expect(result).toEqual({ ok: false, envelope: expect.objectContaining({ code: "admin_origin_denied" }) });
    expect(authenticateAdminLogin).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("a non-string turnstileToken smuggled in by a hand-built client is treated as missing", async () => {
    enableTurnstile();
    const fetchStub = siteverify({ success: true, hostname: ADMIN_HOST });
    vi.stubGlobal("fetch", fetchStub);

    const result = await loginAction({
      username: "root",
      password: "pw",
      turnstileToken: { toString: () => "x" } as unknown as string,
    });

    expect(result).toEqual({
      ok: false,
      envelope: expect.objectContaining({ code: "admin_human_verification_failed" }),
    });
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
