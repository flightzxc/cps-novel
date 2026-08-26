import "./setup-cleanup";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminAccessError } from "@/lib/auth/errors";

/**
 * PR-C1 · `(admin)/_lib/page-guard.ts` — the two UX-layer redirects added on
 * top of the unchanged `requireAdminPageAccess` security boundary (see the
 * docstring on `requireAdminPage` for the full rationale).
 *
 * Mocks `requireAdminPageAccess` itself (the service boundary this file
 * wraps) and `next/navigation`'s `redirect`; `resolveAdminPage` runs for
 * real off the frozen 14-root registry so the "pathname may be a route
 * pattern" resolution is exercised against real data, not a stub.
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

const requireAdminPageAccess = vi.hoisted(() => vi.fn());
vi.mock("@/server/auth/guards", () => ({ requireAdminPageAccess }));

const readSessionToken = vi.hoisted(() => vi.fn(() => Promise.resolve("token")));
vi.mock("@/app/api/admin/_lib/deps", () => ({
  readSessionToken,
  guardDependencies: () => ({}),
}));

const { requireAdminPage } = await import("@/app/(admin)/_lib/page-guard");

function identity(overrides: Partial<{ twoFactorEnabled: boolean }> = {}) {
  return { id: "id-1", username: "root", role: "super_admin", status: "active", sessionVersion: 1, twoFactorEnabled: true, ...overrides };
}

beforeEach(() => {
  requireAdminPageAccess.mockReset();
  redirectMock.mockClear();
});

async function visit(pathname: string): Promise<{ redirectedTo: string } | { context: unknown } | { threw: unknown }> {
  try {
    const context = await requireAdminPage(pathname);
    return { context };
  } catch (error) {
    if (error instanceof RedirectSignal) return { redirectedTo: error.url };
    return { threw: error };
  }
}

describe("requireAdminPage — unauthenticated -> /login redirect", () => {
  it.each(["jwt_missing", "jwt_invalid", "jwt_expired"] as const)(
    "redirects to /login?next=<root> on %s instead of throwing",
    async (code) => {
      requireAdminPageAccess.mockRejectedValue(new AdminAccessError(code, 401, "no session"));
      const result = await visit("/novels");
      expect(result).toEqual({ redirectedTo: "/login?next=%2Fnovels" });
    },
  );

  it("resolves a dynamic route pattern back to its registered, navigable root", async () => {
    requireAdminPageAccess.mockRejectedValue(new AdminAccessError("jwt_missing", 401, "no session"));
    const result = await visit("/novels/[novelId]");
    expect(result).toEqual({ redirectedTo: "/login?next=%2Fnovels" });
  });

  it("still rejects — does not redirect — for an unregistered path (404 stays a 404)", async () => {
    const notRegistered = new AdminAccessError("admin_route_not_registered", 404, "not registered");
    requireAdminPageAccess.mockRejectedValue(notRegistered);
    const result = await visit("/nonexistent");
    expect(redirectMock).not.toHaveBeenCalled();
    expect(result).toEqual({ threw: notRegistered });
  });
});

describe("requireAdminPage — forced 2FA enrollment", () => {
  it("redirects to /two-factor/setup when the identity has never enabled 2FA", async () => {
    requireAdminPageAccess.mockResolvedValue({
      identity: identity({ twoFactorEnabled: false }),
      session: {},
      twoFactorCompleted: false,
    });
    const result = await visit("/tags");
    expect(result).toEqual({ redirectedTo: "/two-factor/setup" });
  });

  it("returns the context normally once 2FA is enabled — reads never demand a completed step-up", async () => {
    const context = {
      identity: identity({ twoFactorEnabled: true }),
      session: {},
      twoFactorCompleted: false,
    };
    requireAdminPageAccess.mockResolvedValue(context);
    const result = await visit("/tags");
    expect(redirectMock).not.toHaveBeenCalled();
    expect(result).toEqual({ context });
  });
});
