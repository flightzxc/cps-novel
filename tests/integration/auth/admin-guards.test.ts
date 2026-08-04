import { describe, expect, it } from "vitest";

import { AdminAccessError } from "@/lib/auth/errors";
import { ADMIN_ABSOLUTE_TIMEOUT_MS, hashAdminSessionToken } from "@/lib/auth/session";
import type { AdminIdentity, AdminSessionRecord } from "@/lib/auth/types";
import {
  requireAdminActionAccess,
  requireAdminPageAccess,
  requireAdminRouteAccess,
  requireAdminServiceMutation,
  type AdminServiceAuthorization,
} from "@/server/auth/guards";
import type { AdminRegistry } from "@/server/auth/registry";
import { P1_08B_ADMIN_REGISTRY } from "@/server/credentials";

import { TestOnlyInMemoryAuthStores } from "../../backend/auth/test-only-in-memory-stores";

const NOW = new Date("2026-08-03T12:00:00.000Z");
const TOKEN = "integration-session-token";
const REQUEST_ID = "550e8400-e29b-41d4-a716-446655440000";
const ORIGIN = "https://admin.example.com";

const registry: AdminRegistry = {
  pageRoots: ["/dashboard"],
  routes: [
    {
      id: "credential.validate",
      path: "/api/admin/credentials/validate",
      methods: ["POST"],
      capability: "credential:manage",
    },
  ],
  actions: [
    {
      id: "admin.credentials.validate",
      capability: "credential:manage",
      mutation: true,
    },
  ],
};

function fixture(options: {
  role?: string;
  twoFactorCompleted?: boolean;
  expired?: boolean;
} = {}) {
  const stores = new TestOnlyInMemoryAuthStores();
  const identity: AdminIdentity = {
    id: "admin-1",
    username: "admin",
    role: options.role ?? "super_admin",
    status: "active",
    sessionVersion: 1,
    twoFactorEnabled: true,
  };
  const issuedAt = new Date(NOW.getTime() - 60 * 60 * 1000);
  const session: AdminSessionRecord = {
    id: "session-1",
    tokenHash: hashAdminSessionToken(TOKEN),
    identityId: identity.id,
    sessionVersion: 1,
    issuedAt,
    lastSeenAt: new Date(NOW.getTime() - 60_000),
    absoluteExpiresAt: options.expired
      ? new Date(NOW)
      : new Date(issuedAt.getTime() + ADMIN_ABSOLUTE_TIMEOUT_MS),
    twoFactorCompletedAt: options.twoFactorCompleted === false ? null : new Date(NOW.getTime() - 60_000),
    revokedAt: null,
  };
  stores.identities.set(identity.id, identity);
  stores.sessions.set(session.id, session);
  return stores;
}

function dependencies(
  stores: TestOnlyInMemoryAuthStores,
  env: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv,
) {
  return {
    identities: stores,
    sessions: stores,
    registry,
    env,
    now: NOW,
    rateLimit: {
      async consume() {
        return { allowed: true };
      },
    },
  };
}

describe("default-deny admin boundary", () => {
  it("returns 404 for unregistered routes and actions before authentication", async () => {
    const stores = fixture();
    await expect(
      requireAdminRouteAccess(
        { pathname: "/api/admin/unknown", method: "POST" },
        dependencies(stores),
      ),
    ).rejects.toMatchObject({ code: "admin_route_not_registered", status: 404 });
    await expect(
      requireAdminActionAccess({ actionId: "admin.unknown" }, dependencies(stores)),
    ).rejects.toMatchObject({ code: "admin_action_not_registered", status: 404 });
  });

  it("returns 401 for a registered entry without authentication", async () => {
    const stores = fixture();
    await expect(
      requireAdminRouteAccess(
        { pathname: "/api/admin/credentials/validate", method: "POST" },
        dependencies(stores),
      ),
    ).rejects.toMatchObject({ code: "jwt_missing", status: 401 });
  });

  it("keeps page access at AuthN only", async () => {
    const stores = fixture({ role: "viewer" });
    await expect(
      requireAdminPageAccess(
        { pathname: "/dashboard", sessionToken: TOKEN },
        dependencies(stores),
      ),
    ).resolves.toMatchObject({ identity: { role: "viewer" } });
  });

  it("returns 403 for missing capability and incomplete 2FA", async () => {
    const noCapability = fixture({ role: "viewer" });
    await expect(
      requireAdminRouteAccess(
        {
          pathname: "/api/admin/credentials/validate",
          method: "POST",
          sessionToken: TOKEN,
          origin: ORIGIN,
          canonicalOrigin: ORIGIN,
          requestId: REQUEST_ID,
        },
        dependencies(noCapability),
      ),
    ).rejects.toMatchObject({ code: "admin_capability_denied", status: 403 });

    const noTwoFactor = fixture({ twoFactorCompleted: false });
    await expect(
      requireAdminRouteAccess(
        {
          pathname: "/api/admin/credentials/validate",
          method: "POST",
          sessionToken: TOKEN,
          origin: ORIGIN,
          canonicalOrigin: ORIGIN,
          requestId: REQUEST_ID,
        },
        dependencies(noTwoFactor),
      ),
    ).rejects.toMatchObject({ code: "admin_two_factor_required", status: 403 });
  });

  it("rejects expired sessions and illegal origins", async () => {
    const expired = fixture({ expired: true });
    await expect(
      requireAdminRouteAccess(
        {
          pathname: "/api/admin/credentials/validate",
          method: "POST",
          sessionToken: TOKEN,
        },
        dependencies(expired),
      ),
    ).rejects.toMatchObject({ code: "jwt_expired", status: 401 });

    const stores = fixture();
    await expect(
      requireAdminRouteAccess(
        {
          pathname: "/api/admin/credentials/validate",
          method: "POST",
          sessionToken: TOKEN,
          origin: "https://evil.example",
          canonicalOrigin: ORIGIN,
          requestId: REQUEST_ID,
        },
        dependencies(stores),
      ),
    ).rejects.toMatchObject({ code: "admin_origin_denied", status: 403 });
  });

  it("issues an opaque service ticket and rechecks service capability", async () => {
    const stores = fixture();
    const guarded = await requireAdminActionAccess(
      {
        actionId: "admin.credentials.validate",
        sessionToken: TOKEN,
        origin: ORIGIN,
        canonicalOrigin: ORIGIN,
        requestId: REQUEST_ID,
      },
      dependencies(stores),
    );
    expect(
      requireAdminServiceMutation(guarded.serviceAuthorization, "credential:manage", {} as NodeJS.ProcessEnv),
    ).toMatchObject({ identity: { id: "admin-1" } });

    const forged = {
      context: guarded.context,
      capability: "credential:manage",
      requestId: REQUEST_ID,
      entryId: "forged",
    } as AdminServiceAuthorization;
    expect(() => requireAdminServiceMutation(forged, "credential:manage")).toThrowError(
      expect.objectContaining({ code: "admin_service_authorization_required", status: 403 }),
    );
  });

  it("keeps promo:claim disabled without an explicit allowlist", async () => {
    const promoRegistry: AdminRegistry = {
      ...registry,
      actions: [{ id: "admin.promo.claim", capability: "promo:claim", mutation: true }],
    };
    const stores = fixture();
    await expect(
      requireAdminActionAccess(
        {
          actionId: "admin.promo.claim",
          sessionToken: TOKEN,
          origin: ORIGIN,
          canonicalOrigin: ORIGIN,
          requestId: REQUEST_ID,
        },
        { ...dependencies(stores), registry: promoRegistry },
      ),
    ).rejects.toMatchObject({ code: "admin_capability_denied", status: 403 });
  });

  it("returns 429 when the injected mutation limiter denies", async () => {
    const stores = fixture();
    await expect(
      requireAdminRouteAccess(
        {
          pathname: "/api/admin/credentials/validate",
          method: "POST",
          sessionToken: TOKEN,
          origin: ORIGIN,
          canonicalOrigin: ORIGIN,
          requestId: REQUEST_ID,
        },
        {
          ...dependencies(stores),
          rateLimit: {
            async consume() {
              return { allowed: false, retryAfterSeconds: 30 };
            },
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "admin_rate_limited",
      status: 429,
      details: { retryAfterSeconds: "30" },
    });
  });

  it("maps guard errors to explicit access classes", () => {
    expect(new AdminAccessError("jwt_missing", 401, "missing")).toMatchObject({ status: 401 });
    expect(new AdminAccessError("admin_capability_denied", 403, "denied")).toMatchObject({ status: 403 });
    expect(new AdminAccessError("admin_route_not_registered", 404, "missing")).toMatchObject({ status: 404 });
    expect(new AdminAccessError("admin_rate_limited", 429, "limited")).toMatchObject({ status: 429 });
  });

  it("guards synchronous credential replacement with capability, 2FA, and origin", async () => {
    const request = {
      pathname: "/api/admin/credentials/replace",
      method: "POST",
      sessionToken: TOKEN,
      origin: ORIGIN,
      canonicalOrigin: ORIGIN,
      requestId: REQUEST_ID,
    };
    const noCapability = fixture({ role: "viewer" });
    await expect(requireAdminRouteAccess(request, {
      ...dependencies(noCapability),
      registry: P1_08B_ADMIN_REGISTRY,
    })).rejects.toMatchObject({ code: "admin_capability_denied", status: 403 });

    const noTwoFactor = fixture({ twoFactorCompleted: false });
    await expect(requireAdminRouteAccess(request, {
      ...dependencies(noTwoFactor),
      registry: P1_08B_ADMIN_REGISTRY,
    })).rejects.toMatchObject({ code: "admin_two_factor_required", status: 403 });

    const allowed = fixture();
    await expect(requireAdminRouteAccess({ ...request, origin: "https://evil.example" }, {
      ...dependencies(allowed),
      registry: P1_08B_ADMIN_REGISTRY,
    })).rejects.toMatchObject({ code: "admin_origin_denied", status: 403 });
  });
});
