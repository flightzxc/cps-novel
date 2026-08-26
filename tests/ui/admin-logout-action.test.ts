import "./setup-cleanup";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ADMIN_SESSION_COOKIE_NAME, ADMIN_TWO_FACTOR_COOKIE_NAME } from "@/server/auth/cookie-contract";

/**
 * PR-C1 · `(admin-auth)/_lib/logout-action.ts`.
 *
 * Mocks the service boundary (`guardDependencies`/`readSessionToken` from
 * `deps.ts`, `revokeAdminSession` from `@/lib/auth/login`) and the two
 * framework boundaries (`next/navigation`, `next/headers`) — not
 * `logoutAction` itself, and not the real `clearSessionCookie` /
 * `clearTwoFactorChallengeCookie` it calls, so the cookie-clearing assertions
 * below exercise real code.
 */

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT:${url}`);
  }
}

const redirectMock = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new RedirectSignal(url);
  }),
);
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

const cookieJar = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve(cookieJar),
  headers: () => Promise.resolve({ get: vi.fn() }),
}));

const revokeAdminSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/login", () => ({ revokeAdminSession }));

const readSessionToken = vi.hoisted(() => vi.fn());
const findByTokenHash = vi.hoisted(() => vi.fn());
vi.mock("@/app/api/admin/_lib/deps", () => ({
  readSessionToken,
  guardDependencies: () => ({ sessions: { findByTokenHash } }),
}));

const { logoutAction } = await import("@/app/(admin-auth)/_lib/logout-action");

async function run(): Promise<string> {
  try {
    await logoutAction();
    throw new Error("logoutAction did not redirect");
  } catch (error) {
    if (error instanceof RedirectSignal) return error.url;
    throw error;
  }
}

beforeEach(() => {
  readSessionToken.mockReset();
  findByTokenHash.mockReset();
  revokeAdminSession.mockReset();
  cookieJar.get.mockReset();
  cookieJar.set.mockReset();
  redirectMock.mockClear();
});

describe("logoutAction", () => {
  it("revokes the matching session, clears both cookies, and lands on /login", async () => {
    readSessionToken.mockResolvedValue("raw-token");
    findByTokenHash.mockResolvedValue({ id: "session-1" });

    const url = await run();

    expect(findByTokenHash).toHaveBeenCalledTimes(1);
    expect(revokeAdminSession).toHaveBeenCalledWith({ findByTokenHash }, "session-1");
    expect(cookieJar.set).toHaveBeenCalledWith(
      ADMIN_SESSION_COOKIE_NAME,
      "",
      expect.objectContaining({ maxAge: 0 }),
    );
    expect(cookieJar.set).toHaveBeenCalledWith(
      ADMIN_TWO_FACTOR_COOKIE_NAME,
      "",
      expect.objectContaining({ maxAge: 0 }),
    );
    expect(url).toBe("/login");
  });

  it("is idempotent when the session is already gone (no matching row)", async () => {
    readSessionToken.mockResolvedValue("stale-token");
    findByTokenHash.mockResolvedValue(null);

    const url = await run();

    expect(revokeAdminSession).not.toHaveBeenCalled();
    expect(cookieJar.set).toHaveBeenCalledWith(ADMIN_SESSION_COOKIE_NAME, "", expect.anything());
    expect(url).toBe("/login");
  });

  it("is a harmless no-op when there is no session cookie at all", async () => {
    readSessionToken.mockResolvedValue(null);

    const url = await run();

    expect(findByTokenHash).not.toHaveBeenCalled();
    expect(revokeAdminSession).not.toHaveBeenCalled();
    expect(cookieJar.set).toHaveBeenCalledWith(ADMIN_SESSION_COOKIE_NAME, "", expect.anything());
    expect(url).toBe("/login");
  });
});
