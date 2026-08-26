import "./setup-cleanup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ADMIN_ABSOLUTE_TIMEOUT_MS } from "@/lib/auth/session";
import {
  ADMIN_SESSION_COOKIE_NAME,
  ADMIN_TWO_FACTOR_COOKIE_NAME,
} from "@/server/auth/cookie-contract";

/**
 * PR-C1 · `(admin-auth)/_lib/auth-session.ts` — the login/2FA cookie and
 * redirect-target helpers.
 *
 * `next/headers` is the only thing mocked here (cookie contracts must be
 * exercised against a real jar, not a source-string scan). Everything else
 * — `safeNextPath`, `postAuthDestination`, `requestIp`,
 * `requireSameOriginSubmission` — runs for real, including its imports from
 * `@/server/auth/*` and `../../api/admin/_lib/deps`; those already load
 * cleanly under `tests/ui/admin-content-registry.test.ts`.
 */

const cookieJar = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
const headersMock = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve(cookieJar),
  headers: () => Promise.resolve(headersMock),
}));

const {
  clearSessionCookie,
  clearTwoFactorChallengeCookie,
  postAuthDestination,
  readTwoFactorChallengeToken,
  requestIp,
  requireSameOriginSubmission,
  safeNextPath,
  TWO_FACTOR_CHALLENGE_PATH,
  TWO_FACTOR_SETUP_PATH,
  ADMIN_LANDING_PATH,
  writeSessionCookie,
  writeTwoFactorChallengeCookie,
} = await import("@/app/(admin-auth)/_lib/auth-session");

beforeEach(() => {
  cookieJar.get.mockReset();
  cookieJar.set.mockReset();
  headersMock.get.mockReset();
  delete process.env.ADMIN_CANONICAL_ORIGIN;
});

afterEach(() => {
  delete process.env.ADMIN_CANONICAL_ORIGIN;
});

describe("safeNextPath — deep-link validation against the registered page roots", () => {
  it("accepts a path that resolves to a registered root", () => {
    expect(safeNextPath("/novels")).toBe("/novels");
    expect(safeNextPath("/novels/some-id")).toBe("/novels/some-id");
  });

  it("strips query and hash before validating", () => {
    expect(safeNextPath("/tags?search=x")).toBe("/tags");
    expect(safeNextPath("/tags#section")).toBe("/tags");
  });

  it("rejects anything that is not a registered root", () => {
    expect(safeNextPath("/not-a-real-page")).toBeNull();
    expect(safeNextPath("/api/admin/novels")).toBeNull();
  });

  it("rejects protocol-relative and non-rooted values (open-redirect guard)", () => {
    expect(safeNextPath("//evil.example/novels")).toBeNull();
    expect(safeNextPath("https://evil.example")).toBeNull();
    expect(safeNextPath("novels")).toBeNull();
  });

  it("takes the first entry when Next hands back a repeated query param as an array", () => {
    expect(safeNextPath(["/novels", "/tags"])).toBe("/novels");
  });

  it("is null-safe", () => {
    expect(safeNextPath(undefined)).toBeNull();
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath("")).toBeNull();
  });
});

function identity(overrides: Partial<{ twoFactorEnabled: boolean }> = {}) {
  return {
    id: "id-1",
    username: "root",
    role: "super_admin",
    status: "active" as const,
    sessionVersion: 1,
    twoFactorEnabled: true,
    ...overrides,
  };
}

describe("postAuthDestination — the three-way branch every entry point shares", () => {
  const base = { identity: identity(), twoFactorCompleted: true } as const;

  it("forces enrollment when 2FA has never been enabled, regardless of next", () => {
    expect(
      postAuthDestination(
        { identity: identity({ twoFactorEnabled: false }), twoFactorCompleted: false },
        "/novels",
      ),
    ).toBe(TWO_FACTOR_SETUP_PATH);
  });

  it("routes to the challenge when 2FA is enabled but this session has not completed it", () => {
    expect(
      postAuthDestination(
        { identity: identity({ twoFactorEnabled: true }), twoFactorCompleted: false },
        "/novels",
      ),
    ).toBe(TWO_FACTOR_CHALLENGE_PATH);
  });

  it("honors a validated deep link once fully authenticated", () => {
    expect(postAuthDestination(base, "/tags")).toBe("/tags");
  });

  it("falls back to the landing page when next is absent or invalid", () => {
    expect(postAuthDestination(base, undefined)).toBe(ADMIN_LANDING_PATH);
    expect(postAuthDestination(base, "https://evil.example")).toBe(ADMIN_LANDING_PATH);
  });
});

describe("requestIp", () => {
  it("prefers x-forwarded-for, taking only the first hop", () => {
    expect(requestIp(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
  });

  it("falls back through x-real-ip then cf-connecting-ip", () => {
    expect(requestIp(new Headers({ "x-real-ip": "203.0.113.5" }))).toBe("203.0.113.5");
    expect(requestIp(new Headers({ "cf-connecting-ip": "203.0.113.6" }))).toBe("203.0.113.6");
  });

  it("is empty (never null/undefined) when nothing is present", () => {
    expect(requestIp(new Headers())).toBe("");
  });
});

describe("requireSameOriginSubmission", () => {
  it("passes when the Origin header matches ADMIN_CANONICAL_ORIGIN", async () => {
    process.env.ADMIN_CANONICAL_ORIGIN = "https://admin.example.com";
    headersMock.get.mockImplementation((name: string) => (name === "origin" ? "https://admin.example.com" : null));
    await expect(requireSameOriginSubmission()).resolves.toBeUndefined();
  });

  it("rejects a mismatched or missing Origin the same way requireAdminRouteAccess does", async () => {
    process.env.ADMIN_CANONICAL_ORIGIN = "https://admin.example.com";
    headersMock.get.mockReturnValue(null);
    await expect(requireSameOriginSubmission()).rejects.toEqual(
      expect.objectContaining({ code: "admin_origin_denied", status: 403 }),
    );
  });
});

describe("cookie contract — every attribute, not just the name", () => {
  it("writes the session cookie exactly per ADMIN_SESSION_COOKIE_CONTRACT", async () => {
    await writeSessionCookie("token-value");
    expect(cookieJar.set).toHaveBeenCalledWith(ADMIN_SESSION_COOKIE_NAME, "token-value", {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: ADMIN_ABSOLUTE_TIMEOUT_MS / 1000,
    });
  });

  it("clears the session cookie with the same attributes and maxAge: 0", async () => {
    await clearSessionCookie();
    expect(cookieJar.set).toHaveBeenCalledWith(ADMIN_SESSION_COOKIE_NAME, "", {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: 0,
    });
  });

  it("writes the two-factor challenge cookie exactly per ADMIN_TWO_FACTOR_COOKIE_CONTRACT", async () => {
    await writeTwoFactorChallengeCookie("challenge-token");
    expect(cookieJar.set).toHaveBeenCalledWith(ADMIN_TWO_FACTOR_COOKIE_NAME, "challenge-token", {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: 300,
    });
  });

  it("clears the two-factor challenge cookie with maxAge: 0", async () => {
    await clearTwoFactorChallengeCookie();
    expect(cookieJar.set).toHaveBeenCalledWith(ADMIN_TWO_FACTOR_COOKIE_NAME, "", {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: 0,
    });
  });

  it("reads the raw challenge token back off the jar", async () => {
    cookieJar.get.mockReturnValue({ value: "raw-token" });
    await expect(readTwoFactorChallengeToken()).resolves.toBe("raw-token");
    expect(cookieJar.get).toHaveBeenCalledWith(ADMIN_TWO_FACTOR_COOKIE_NAME);
  });

  it("returns null, not undefined, when the challenge cookie is absent", async () => {
    cookieJar.get.mockReturnValue(undefined);
    await expect(readTwoFactorChallengeToken()).resolves.toBeNull();
  });
});
