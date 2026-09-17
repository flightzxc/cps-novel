import { describe, expect, it } from "vitest";

import { capabilityViews, sessionView } from "@/app/(admin)/_lib/page-guard";
import type { AdminAuthContext } from "@/lib/auth/types";

/**
 * CPS v8.3.6 sidebar parity: capability visibility follows the grant. Novel's
 * UAT-only enforcement switch satisfies step-up for projection purposes; the
 * production projection remains fail-closed.
 */
function context(twoFactorCompleted = false): AdminAuthContext {
  const now = new Date("2026-09-05T00:00:00.000Z");
  return {
    identity: {
      id: "admin-1",
      username: "admin",
      role: "super_admin",
      status: "active",
      sessionVersion: 1,
      twoFactorEnabled: false,
    },
    session: {
      id: "session-1",
      tokenHash: "hash",
      identityId: "admin-1",
      sessionVersion: 1,
      issuedAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: new Date(now.getTime() + 86_400_000),
      twoFactorCompletedAt: null,
      revokedAt: null,
    },
    twoFactorCompleted,
  };
}

function stateMap(ctx: AdminAuthContext, env: NodeJS.ProcessEnv) {
  return new Map(capabilityViews(ctx, env).map((view) => [view.capability, view.state]));
}

describe("admin capability projection follows ADMIN_TWO_FACTOR_ENFORCEMENT", () => {
  it("CPS sidebar semantics: UAT enforcement=false leaves all granted super-admin surfaces usable", () => {
    const env = { ADMIN_TWO_FACTOR_ENFORCEMENT: "false", PROMO_CLAIM_ROLES: "super_admin" } as unknown as NodeJS.ProcessEnv;
    const states = stateMap(context(false), env);

    for (const capability of [
      "credential:manage",
      "settings:manage",
      "task:manage",
      "content:publish",
      "content:takedown",
      "promo:claim",
    ] as const) {
      expect(states.get(capability), capability).toBe("granted");
    }
    expect(sessionView(context(false), env).twoFactorCompleted).toBe(true);
  });

  it("production enforcement=true still projects an incomplete step-up as two_factor_required", () => {
    const env = { ADMIN_TWO_FACTOR_ENFORCEMENT: "true", PROMO_CLAIM_ROLES: "super_admin" } as unknown as NodeJS.ProcessEnv;
    const states = stateMap(context(false), env);

    for (const capability of [
      "credential:manage",
      "settings:manage",
      "task:manage",
      "content:publish",
      "content:takedown",
      "promo:claim",
    ] as const) {
      expect(states.get(capability), capability).toBe("two_factor_required");
    }
    expect(sessionView(context(false), env).twoFactorCompleted).toBe(false);
  });

  it("the enforcement switch never grants a capability the identity does not hold", () => {
    const states = stateMap(context(false), {
      ADMIN_TWO_FACTOR_ENFORCEMENT: "false",
      PROMO_CLAIM_ROLES: "",
    } as unknown as NodeJS.ProcessEnv);
    expect(states.get("promo:claim")).toBe("denied");
  });
});
