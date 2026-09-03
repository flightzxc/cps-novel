import "./setup-cleanup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminAccessError } from "@/lib/auth/errors";

/**
 * PR-C1 / PR-C1b · `(admin)/_lib/page-guard.ts` — the three UX-layer
 * redirects added on top of the unchanged `requireAdminPageAccess` security
 * boundary (see the docstring on `requireAdminPage` for the full rationale):
 * unauthenticated -> `/login`, never-enrolled -> `/two-factor/setup`, and
 * (PR-C1b) enrolled-but-not-completed-this-session -> `/two-factor/challenge`.
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
});

describe("requireAdminPage — session-level step-up (PR-C1b)", () => {
  it("redirects to /two-factor/challenge?next=<root> when 2FA is enabled but this session has not completed a challenge", async () => {
    requireAdminPageAccess.mockResolvedValue({
      identity: identity({ twoFactorEnabled: true }),
      session: {},
      twoFactorCompleted: false,
    });
    const result = await visit("/tags");
    expect(result).toEqual({ redirectedTo: "/two-factor/challenge?next=%2Ftags" });
  });

  it("resolves a dynamic route pattern back to its registered root for the step-up next param too", async () => {
    requireAdminPageAccess.mockResolvedValue({
      identity: identity({ twoFactorEnabled: true }),
      session: {},
      twoFactorCompleted: false,
    });
    const result = await visit("/novels/[novelId]");
    expect(result).toEqual({ redirectedTo: "/two-factor/challenge?next=%2Fnovels" });
  });

  it("renders normally once the challenge for this session is completed", async () => {
    const context = {
      identity: identity({ twoFactorEnabled: true }),
      session: {},
      twoFactorCompleted: true,
    };
    requireAdminPageAccess.mockResolvedValue(context);
    const result = await visit("/tags");
    expect(redirectMock).not.toHaveBeenCalled();
    expect(result).toEqual({ context });
  });

  it("still forces enrollment first when 2FA was never enabled — /two-factor/setup wins over the step-up check", async () => {
    requireAdminPageAccess.mockResolvedValue({
      identity: identity({ twoFactorEnabled: false }),
      session: {},
      twoFactorCompleted: false,
    });
    const result = await visit("/tags");
    expect(result).toEqual({ redirectedTo: "/two-factor/setup" });
  });
});

describe("requireAdminPage — RC-10 ADMIN_TWO_FACTOR_ENFORCEMENT=disabled", () => {
  afterEach(() => {
    delete process.env.ADMIN_TWO_FACTOR_ENFORCEMENT;
  });

  it("renders normally for a never-enrolled, never-stepped-up session — neither redirect fires", async () => {
    process.env.ADMIN_TWO_FACTOR_ENFORCEMENT = "disabled";
    const context = {
      identity: identity({ twoFactorEnabled: false }),
      session: {},
      twoFactorCompleted: false,
    };
    requireAdminPageAccess.mockResolvedValue(context);
    const result = await visit("/tags");
    expect(redirectMock).not.toHaveBeenCalled();
    expect(result).toEqual({ context });
  });

  it("an unrecognized value (fail-closed) still forces enrollment, same as required", async () => {
    process.env.ADMIN_TWO_FACTOR_ENFORCEMENT = "off";
    requireAdminPageAccess.mockResolvedValue({
      identity: identity({ twoFactorEnabled: false }),
      session: {},
      twoFactorCompleted: false,
    });
    const result = await visit("/tags");
    expect(result).toEqual({ redirectedTo: "/two-factor/setup" });
  });
});
