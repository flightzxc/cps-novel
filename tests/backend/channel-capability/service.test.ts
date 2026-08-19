/**
 * P0-S6: `setChannelCapabilityStatus` (`src/server/channel-capability/service.ts`).
 *
 * Covers the acceptance list from the S6 construction order: legal switch
 * both directions, unknown key rejected, illegal target status rejected,
 * missing reason rejected, `enabled` without evidence rejected, an audit row
 * with before/after/reason, and idempotent replay of a repeated requestId.
 * A db-retry wiring case is included too, mirroring the S2 discipline this
 * module's `withDbRetry` call site is required to follow.
 */
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import type { AdminAuthContext } from "@/lib/auth/types";
import {
  ChannelCapabilityStatusError,
  setChannelCapabilityStatus,
  validateChannelCapabilityStatusRequest,
  type ChannelCapabilityStatusActor,
} from "@/server/channel-capability/service";

import { FakeChannelCapabilityDb } from "./fake-db";

const SYSTEM_ACTOR: ChannelCapabilityStatusActor = { type: "system", actorId: "operator-1" };
/** Deterministic empty env for the admin-actor tests below — real CI/dev `process.env` must never influence whether `credential:manage`'s default-role check passes. */
const EMPTY_ENV = {} as unknown as NodeJS.ProcessEnv;

/**
 * A minimal, fully synthetic `AdminAuthContext` — `requireHighRiskAdminCapability`
 * only reads `identity.role`/`identity.id` and `twoFactorCompleted`, so this
 * does not need a real session store (see `src/lib/auth/capabilities.ts`).
 */
function adminContext(overrides: Partial<{ role: string; twoFactorCompleted: boolean }> = {}): AdminAuthContext {
  return {
    identity: { id: "admin-1", username: "admin-1", role: overrides.role ?? "super_admin", status: "active", sessionVersion: 1, twoFactorEnabled: true },
    session: {
      id: "session-1",
      tokenHash: "hash",
      identityId: "admin-1",
      sessionVersion: 1,
      issuedAt: new Date("2026-08-20T00:00:00.000Z"),
      lastSeenAt: new Date("2026-08-20T00:00:00.000Z"),
      absoluteExpiresAt: new Date("2026-08-21T00:00:00.000Z"),
      twoFactorCompletedAt: overrides.twoFactorCompleted === false ? null : new Date("2026-08-20T00:00:00.000Z"),
      revokedAt: null,
    },
    twoFactorCompleted: overrides.twoFactorCompleted ?? true,
  };
}

function seedDisabled(db: FakeChannelCapabilityDb, overrides: Partial<{ id: string; channelAppId: string; capabilityKey: string; status: string }> = {}) {
  db.seedCapability({
    id: overrides.id ?? "capability-1",
    channelAppId: overrides.channelAppId ?? "channel-app-1",
    capabilityKey: overrides.capabilityKey ?? "sync.catalog",
    status: overrides.status ?? "registered_disabled",
  });
  return db;
}

describe("setChannelCapabilityStatus: legal transitions", () => {
  it("switches registered_disabled -> enabled with evidence, system actor", async () => {
    const db = seedDisabled(new FakeChannelCapabilityDb());

    const result = await setChannelCapabilityStatus(db.asPrismaClient(), {
      channelAppId: "channel-app-1",
      capabilityKey: "sync.catalog",
      targetStatus: "enabled",
      reason: "smoke test passed, enabling for canary",
      evidenceRef: "smoke-report-2026-08-20.md",
      requestId: "req-enable-1",
      actor: SYSTEM_ACTOR,
    });

    expect(result).toMatchObject({
      capabilityId: "capability-1",
      channelAppId: "channel-app-1",
      capabilityKey: "sync.catalog",
      beforeStatus: "registered_disabled",
      afterStatus: "enabled",
      wrote: true,
    });
    expect(result.auditId).toBe("1");
    expect(db.capabilities.get("capability-1")?.status).toBe("enabled");
  });

  it("switches enabled -> registered_disabled without evidence, system actor", async () => {
    const db = seedDisabled(new FakeChannelCapabilityDb(), { status: "enabled" });

    const result = await setChannelCapabilityStatus(db.asPrismaClient(), {
      channelAppId: "channel-app-1",
      capabilityKey: "sync.catalog",
      targetStatus: "registered_disabled",
      reason: "rolling back after canary regression",
      requestId: "req-disable-1",
      actor: SYSTEM_ACTOR,
    });

    expect(result).toMatchObject({
      beforeStatus: "enabled",
      afterStatus: "registered_disabled",
      wrote: true,
    });
    expect(db.capabilities.get("capability-1")?.status).toBe("registered_disabled");
  });
});

describe("setChannelCapabilityStatus: admin actor wiring (future UI path)", () => {
  // No admin UI calls this yet ("受审计脚本先行，管理界面后补") — these
  // prove the reserved capability-check call site actually enforces
  // `credential:manage` + mandatory 2FA via `requireHighRiskAdminCapability`,
  // not merely that the branch is shaped like it does.
  it("rejects an admin actor without the credential:manage role/allowlist", async () => {
    const db = seedDisabled(new FakeChannelCapabilityDb());

    await expect(
      setChannelCapabilityStatus(db.asPrismaClient(), {
        channelAppId: "channel-app-1",
        capabilityKey: "sync.catalog",
        targetStatus: "enabled",
        reason: "r",
        evidenceRef: "e",
        requestId: "req-admin-1",
        actor: { type: "admin", context: adminContext({ role: "support_agent" }) },
      }, EMPTY_ENV),
    ).rejects.toMatchObject({ code: "admin_capability_denied" });
    expect(db.audits).toHaveLength(0);
  });

  it("rejects an admin actor who has the role but has not completed 2FA", async () => {
    const db = seedDisabled(new FakeChannelCapabilityDb());

    await expect(
      setChannelCapabilityStatus(db.asPrismaClient(), {
        channelAppId: "channel-app-1",
        capabilityKey: "sync.catalog",
        targetStatus: "enabled",
        reason: "r",
        evidenceRef: "e",
        requestId: "req-admin-2",
        actor: { type: "admin", context: adminContext({ twoFactorCompleted: false }) },
      }, EMPTY_ENV),
    ).rejects.toMatchObject({ code: "admin_two_factor_required" });
    expect(db.audits).toHaveLength(0);
  });

  it("succeeds for an admin actor with the role and completed 2FA, audited as actorType admin", async () => {
    const db = seedDisabled(new FakeChannelCapabilityDb());

    const result = await setChannelCapabilityStatus(db.asPrismaClient(), {
      channelAppId: "channel-app-1",
      capabilityKey: "sync.catalog",
      targetStatus: "enabled",
      reason: "admin-initiated enable",
      evidenceRef: "e",
      requestId: "req-admin-3",
      actor: { type: "admin", context: adminContext() },
    }, EMPTY_ENV);

    expect(result.afterStatus).toBe("enabled");
    expect(db.audits[0]).toMatchObject({ actorType: "admin", actorId: "admin-1" });
  });
});

describe("setChannelCapabilityStatus: rejections", () => {
  it("rejects an unknown capability key — no matching row, no write", async () => {
    const db = seedDisabled(new FakeChannelCapabilityDb());

    await expect(
      setChannelCapabilityStatus(db.asPrismaClient(), {
        channelAppId: "channel-app-1",
        capabilityKey: "does.not.exist",
        targetStatus: "enabled",
        reason: "r",
        evidenceRef: "e",
        requestId: "req-unknown-1",
        actor: SYSTEM_ACTOR,
      }),
    ).rejects.toMatchObject({ code: "capability_not_found" });
    expect(db.audits).toHaveLength(0);
  });

  it("rejects an illegal target status", async () => {
    const db = seedDisabled(new FakeChannelCapabilityDb());

    await expect(
      setChannelCapabilityStatus(db.asPrismaClient(), {
        channelAppId: "channel-app-1",
        capabilityKey: "sync.catalog",
        targetStatus: "registered_partial",
        reason: "r",
        requestId: "req-bad-status-1",
        actor: SYSTEM_ACTOR,
      }),
    ).rejects.toMatchObject({ code: "invalid_target_status" });

    await expect(
      setChannelCapabilityStatus(db.asPrismaClient(), {
        channelAppId: "channel-app-1",
        capabilityKey: "sync.catalog",
        targetStatus: "bogus",
        reason: "r",
        requestId: "req-bad-status-2",
        actor: SYSTEM_ACTOR,
      }),
    ).rejects.toMatchObject({ code: "invalid_target_status" });
    expect(db.audits).toHaveLength(0);
    expect(db.capabilities.get("capability-1")?.status).toBe("registered_disabled");
  });

  it("rejects a current status outside the toggle's scope (registered_partial)", async () => {
    const db = seedDisabled(new FakeChannelCapabilityDb(), { status: "registered_partial" });

    await expect(
      setChannelCapabilityStatus(db.asPrismaClient(), {
        channelAppId: "channel-app-1",
        capabilityKey: "sync.catalog",
        targetStatus: "enabled",
        reason: "r",
        evidenceRef: "e",
        requestId: "req-partial-1",
        actor: SYSTEM_ACTOR,
      }),
    ).rejects.toMatchObject({ code: "current_status_not_eligible" });
    expect(db.capabilities.get("capability-1")?.status).toBe("registered_partial");
  });

  it("rejects a missing reason", async () => {
    const db = seedDisabled(new FakeChannelCapabilityDb());

    await expect(
      setChannelCapabilityStatus(db.asPrismaClient(), {
        channelAppId: "channel-app-1",
        capabilityKey: "sync.catalog",
        targetStatus: "enabled",
        reason: "   ",
        evidenceRef: "e",
        requestId: "req-no-reason-1",
        actor: SYSTEM_ACTOR,
      }),
    ).rejects.toMatchObject({ code: "reason_required" });
    expect(db.audits).toHaveLength(0);
  });

  it("rejects enabled without an evidence reference", async () => {
    const db = seedDisabled(new FakeChannelCapabilityDb());

    await expect(
      setChannelCapabilityStatus(db.asPrismaClient(), {
        channelAppId: "channel-app-1",
        capabilityKey: "sync.catalog",
        targetStatus: "enabled",
        reason: "r",
        requestId: "req-no-evidence-1",
        actor: SYSTEM_ACTOR,
      }),
    ).rejects.toMatchObject({ code: "evidence_required" });

    await expect(
      setChannelCapabilityStatus(db.asPrismaClient(), {
        channelAppId: "channel-app-1",
        capabilityKey: "sync.catalog",
        targetStatus: "enabled",
        reason: "r",
        evidenceRef: "   ",
        requestId: "req-no-evidence-2",
        actor: SYSTEM_ACTOR,
      }),
    ).rejects.toMatchObject({ code: "evidence_required" });
    expect(db.audits).toHaveLength(0);
    expect(db.capabilities.get("capability-1")?.status).toBe("registered_disabled");
  });

  it("rejects a blank system actor id", async () => {
    const db = seedDisabled(new FakeChannelCapabilityDb());

    await expect(
      setChannelCapabilityStatus(db.asPrismaClient(), {
        channelAppId: "channel-app-1",
        capabilityKey: "sync.catalog",
        targetStatus: "enabled",
        reason: "r",
        evidenceRef: "e",
        requestId: "req-no-actor-1",
        actor: { type: "system", actorId: "   " },
      }),
    ).rejects.toMatchObject({ code: "system_actor_id_required" });
    expect(db.audits).toHaveLength(0);
  });
});

describe("setChannelCapabilityStatus: audit trail", () => {
  it("writes an OperationAudit row with before/after status and the reason", async () => {
    const db = seedDisabled(new FakeChannelCapabilityDb());

    await setChannelCapabilityStatus(db.asPrismaClient(), {
      channelAppId: "channel-app-1",
      capabilityKey: "sync.catalog",
      targetStatus: "enabled",
      reason: "smoke test 2026-08-20 passed",
      evidenceRef: "smoke-report-2026-08-20.md",
      requestId: "req-audit-1",
      actor: SYSTEM_ACTOR,
    });

    expect(db.audits).toHaveLength(1);
    const audit = db.audits[0]!;
    expect(audit).toMatchObject({
      actorType: "system",
      actorId: "operator-1",
      action: "channel_capability.status.set",
      entityType: "ChannelCapability",
      entityId: "capability-1",
      requestId: "req-audit-1",
      reason: "smoke test 2026-08-20 passed",
      beforeSnapshot: { status: "registered_disabled" },
      afterSnapshot: { status: "enabled", evidenceRef: "smoke-report-2026-08-20.md" },
    });
  });

  it("does not persist an evidenceRef in the audit snapshot for a disable (only meaningful for enable)", async () => {
    const db = seedDisabled(new FakeChannelCapabilityDb(), { status: "enabled" });

    await setChannelCapabilityStatus(db.asPrismaClient(), {
      channelAppId: "channel-app-1",
      capabilityKey: "sync.catalog",
      targetStatus: "registered_disabled",
      reason: "rollback",
      requestId: "req-audit-2",
      actor: SYSTEM_ACTOR,
    });

    expect(db.audits[0]?.afterSnapshot).toMatchObject({ status: "registered_disabled", evidenceRef: null });
  });
});

describe("setChannelCapabilityStatus: idempotency", () => {
  it("replays a repeated requestId without writing a second time", async () => {
    const db = seedDisabled(new FakeChannelCapabilityDb());
    const input = {
      channelAppId: "channel-app-1",
      capabilityKey: "sync.catalog",
      targetStatus: "enabled",
      reason: "first attempt",
      evidenceRef: "smoke-report-2026-08-20.md",
      requestId: "req-idempotent-1",
      actor: SYSTEM_ACTOR,
    } as const;

    const first = await setChannelCapabilityStatus(db.asPrismaClient(), input);
    expect(first.wrote).toBe(true);
    expect(db.audits).toHaveLength(1);
    expect(db.capabilities.get("capability-1")?.status).toBe("enabled");

    // Same requestId, replayed (e.g. the operator re-ran the exact same
    // command after a network blip). Must not double-write or duplicate the
    // audit row, and must report the same before/after status as the first
    // attempt.
    const second = await setChannelCapabilityStatus(db.asPrismaClient(), input);
    expect(second).toMatchObject({
      capabilityId: "capability-1",
      beforeStatus: "registered_disabled",
      afterStatus: "enabled",
      wrote: false,
      auditId: first.auditId,
    });
    expect(db.audits).toHaveLength(1);
  });

  it("keeps distinct requestIds independent (not conflated with each other)", async () => {
    const db = seedDisabled(new FakeChannelCapabilityDb());

    await setChannelCapabilityStatus(db.asPrismaClient(), {
      channelAppId: "channel-app-1",
      capabilityKey: "sync.catalog",
      targetStatus: "enabled",
      reason: "enable",
      evidenceRef: "e",
      requestId: "req-distinct-1",
      actor: SYSTEM_ACTOR,
    });
    await setChannelCapabilityStatus(db.asPrismaClient(), {
      channelAppId: "channel-app-1",
      capabilityKey: "sync.catalog",
      targetStatus: "registered_disabled",
      reason: "disable",
      requestId: "req-distinct-2",
      actor: SYSTEM_ACTOR,
    });

    expect(db.audits).toHaveLength(2);
    expect(db.capabilities.get("capability-1")?.status).toBe("registered_disabled");
  });
});

describe("setChannelCapabilityStatus: db-retry wiring", () => {
  function prismaError(code: string): Prisma.PrismaClientKnownRequestError {
    return new Prisma.PrismaClientKnownRequestError(`simulated ${code}`, { code, clientVersion: "6.19.2" });
  }

  function withInjectedTransientFailures(db: FakeChannelCapabilityDb, failures: number) {
    const client = db.asPrismaClient() as unknown as { $transaction: (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown> };
    const real = client.$transaction.bind(client);
    const attempts = { count: 0 };
    client.$transaction = (callback: (tx: unknown) => Promise<unknown>) => {
      attempts.count += 1;
      if (attempts.count <= failures) return Promise.reject(prismaError("P1008"));
      return real(callback);
    };
    return attempts;
  }

  it("retries a transient P1008 failure and succeeds on the second attempt without double-writing", async () => {
    const db = seedDisabled(new FakeChannelCapabilityDb());
    const attempts = withInjectedTransientFailures(db, 1);

    const result = await setChannelCapabilityStatus(db.asPrismaClient(), {
      channelAppId: "channel-app-1",
      capabilityKey: "sync.catalog",
      targetStatus: "enabled",
      reason: "r",
      evidenceRef: "e",
      requestId: "req-retry-1",
      actor: SYSTEM_ACTOR,
    });

    expect(attempts.count).toBe(2);
    expect(result).toMatchObject({ afterStatus: "enabled", wrote: true });
    expect(db.audits).toHaveLength(1);
  }, 10_000);

  it("does not retry a business rejection (capability_not_found)", async () => {
    const db = seedDisabled(new FakeChannelCapabilityDb());
    const attempts = withInjectedTransientFailures(db, 0);

    await expect(
      setChannelCapabilityStatus(db.asPrismaClient(), {
        channelAppId: "channel-app-1",
        capabilityKey: "does.not.exist",
        targetStatus: "enabled",
        reason: "r",
        evidenceRef: "e",
        requestId: "req-retry-2",
        actor: SYSTEM_ACTOR,
      }),
    ).rejects.toMatchObject({ code: "capability_not_found" });
    expect(attempts.count).toBe(1);
  });
});

describe("validateChannelCapabilityStatusRequest", () => {
  it("is the single source of truth both the service and the CLI dry-run share", () => {
    expect(
      validateChannelCapabilityStatusRequest({ targetStatus: "enabled", reason: "r", evidenceRef: "e" }),
    ).toEqual({ targetStatus: "enabled", reason: "r", evidenceRef: "e" });
    expect(
      validateChannelCapabilityStatusRequest({ targetStatus: "registered_disabled", reason: "r" }),
    ).toEqual({ targetStatus: "registered_disabled", reason: "r", evidenceRef: null });
  });

  it("throws ChannelCapabilityStatusError instances with stable codes", () => {
    try {
      validateChannelCapabilityStatusRequest({ targetStatus: "nope", reason: "r" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ChannelCapabilityStatusError);
      expect((error as ChannelCapabilityStatusError).code).toBe("invalid_target_status");
    }
  });
});
