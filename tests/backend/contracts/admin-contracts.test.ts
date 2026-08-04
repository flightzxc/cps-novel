import { describe, expect, it } from "vitest";

import {
  projectAdminCapability,
  projectAdminSession,
  projectChannelAccount,
  projectCredentialMetadata,
  projectCredentialOperationAvailability,
  projectCredentialQueuedResult,
  projectCredentialTaskStatus,
  projectErrorEnvelope,
  projectRecoveryCodes,
  projectTwoFactorChallenge,
  projectTwoFactorSetup,
  projectTwoFactorState,
} from "@/contracts";
import { CredentialReplacementIdempotencyConflictError } from "@/server/credentials/service";
import { AdminAccessError } from "@/lib/auth/errors";
import {
  ADMIN_ABSOLUTE_TIMEOUT_MS,
  ADMIN_IDLE_TIMEOUT_MS,
  validateAdminSession,
} from "@/lib/auth/session";
import type { AdminIdentity, AdminSessionRecord } from "@/lib/auth/types";

const NOW = new Date("2026-08-04T00:00:00.000Z");
const IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

function identity() {
  return { id: "identity-1", username: "operator", role: "super_admin" };
}

function session() {
  return {
    lastSeenAt: new Date("2026-08-04T00:10:00.000Z"),
    absoluteExpiresAt: new Date("2026-08-05T00:00:00.000Z"),
  };
}

describe("admin session contract", () => {
  it("derives idle expiry from lastSeenAt and emits only browser-safe fields", () => {
    const view = projectAdminSession({
      identity: identity(),
      session: session(),
      twoFactorCompleted: true,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      capabilities: [],
    });

    expect(view.idleExpiresAt).toBe("2026-08-04T02:10:00.000Z");
    expect(view.absoluteExpiresAt).toBe("2026-08-05T00:00:00.000Z");
    expect(Object.keys(view).sort()).toEqual([
      "absoluteExpiresAt",
      "capabilities",
      "identityId",
      "idleExpiresAt",
      "role",
      "twoFactorCompleted",
      "username",
    ]);
  });
});

describe("capability contract", () => {
  it("is tri-state and never collapses two_factor_required into denied", () => {
    const base = { capability: "credential:manage" as const, requiresTwoFactor: true };
    expect(
      projectAdminCapability({ ...base, granted: true, twoFactorCompleted: true }).state,
    ).toBe("granted");
    expect(
      projectAdminCapability({ ...base, granted: true, twoFactorCompleted: false }).state,
    ).toBe("two_factor_required");
    expect(
      projectAdminCapability({ ...base, granted: false, twoFactorCompleted: true }).state,
    ).toBe("denied");
  });

  it("renders an unconfigured capability as denied rather than usable", () => {
    // promo:claim and revenue:view ship with an empty default role list, so
    // hasAdminCapability returns false until an env allowlist is configured.
    expect(
      projectAdminCapability({
        capability: "promo:claim",
        granted: false,
        requiresTwoFactor: true,
        twoFactorCompleted: true,
      }).state,
    ).toBe("denied");
  });
});

describe("two-factor contract", () => {
  const baseState = {
    enabled: false,
    confirmedAt: null,
    pendingEncryptedSecret: null as string | null,
    pendingExpiresAt: null as Date | null,
    recoveryCodesRotatedAt: null,
  };

  it("derives all four setup states", () => {
    expect(
      projectTwoFactorState({ state: baseState, recoveryCodesRemaining: 0, now: NOW }).status,
    ).toBe("disabled");

    expect(
      projectTwoFactorState({
        state: {
          ...baseState,
          pendingEncryptedSecret: "ciphertext",
          pendingExpiresAt: new Date(NOW.getTime() + 60_000),
        },
        recoveryCodesRemaining: 0,
        now: NOW,
      }).status,
    ).toBe("pending");

    expect(
      projectTwoFactorState({
        state: {
          ...baseState,
          pendingEncryptedSecret: "ciphertext",
          pendingExpiresAt: new Date(NOW.getTime() - 1),
        },
        recoveryCodesRemaining: 0,
        now: NOW,
      }).status,
    ).toBe("pending_expired");

    expect(
      projectTwoFactorState({
        state: { ...baseState, enabled: true, confirmedAt: NOW },
        recoveryCodesRemaining: 7,
        now: NOW,
      }),
    ).toMatchObject({ status: "enabled", recoveryCodesRemaining: 7 });
  });

  it("reports remaining challenge attempts and never the token binding", () => {
    const view = projectTwoFactorChallenge({
      challenge: { expiresAt: new Date(NOW.getTime() + 300_000), attemptCount: 2 },
      maxAttempts: 5,
    });
    expect(view).toEqual({ expiresAt: "2026-08-04T00:05:00.000Z", attemptsRemaining: 3 });
  });

  it("clamps attemptsRemaining at zero", () => {
    expect(
      projectTwoFactorChallenge({
        challenge: { expiresAt: NOW, attemptCount: 9 },
        maxAttempts: 5,
      }).attemptsRemaining,
    ).toBe(0);
  });

  it("passes one-time setup and recovery payloads through unchanged", () => {
    expect(
      projectTwoFactorSetup({
        manualKey: "JBSWY3DPEHPK3PXP",
        otpauthUri: "otpauth://totp/example",
        pendingExpiresAt: NOW,
      }),
    ).toEqual({
      manualKey: "JBSWY3DPEHPK3PXP",
      otpauthUri: "otpauth://totp/example",
      pendingExpiresAt: "2026-08-04T00:00:00.000Z",
    });

    expect(projectRecoveryCodes({ codes: ["AAAA-BBBB-CCCC"], generatedAt: NOW })).toEqual({
      codes: ["AAAA-BBBB-CCCC"],
      generatedAt: "2026-08-04T00:00:00.000Z",
    });
  });
});

describe("channel account contract", () => {
  it("narrows status to the two account values", () => {
    const view = projectChannelAccount({
      id: "account-1",
      channelId: "channel-1",
      businessId: "biz-1",
      accountName: "Ops",
      status: "disabled",
      lastValidatedAt: null,
      lastSyncedAt: null,
      createdAt: NOW,
    });
    expect(view.status).toBe("disabled");
    expect(view.createdAt).toBe("2026-08-04T00:00:00.000Z");
  });
});

describe("credential contract", () => {
  it("keeps status to exactly the four frozen values", () => {
    for (const status of ["active", "superseded", "expired", "invalid"]) {
      expect(
        projectCredentialMetadata({
          credentialId: "credential-1",
          channelAccountId: "account-1",
          credentialType: "bearer_jwt",
          status,
          expiresAt: null,
          lastValidatedAt: null,
          fingerprintPrefix: "ab12",
        }).status,
      ).toBe(status);
    }
  });

  it("refuses disabled and revoked, which belong to no credential", () => {
    for (const rejected of ["disabled", "revoked"]) {
      expect(
        projectCredentialMetadata({
          credentialId: "credential-1",
          channelAccountId: "account-1",
          credentialType: "bearer_jwt",
          status: rejected,
          expiresAt: null,
          lastValidatedAt: null,
          fingerprintPrefix: "ab12",
        }).status,
      ).toBe("invalid");
    }
  });

  it("exposes add/replace as supported after the Owner-approved synchronous ingress", () => {
    const granted = projectCredentialOperationAvailability({ credentialManage: "granted" });
    expect(granted.find((entry) => entry.operation === "add_or_replace_credential")?.state).toBe(
      "supported",
    );
    expect(granted.find((entry) => entry.operation === "validate_credential")?.state).toBe(
      "supported",
    );
  });

  it("distinguishes capability denial from a pending step-up", () => {
    const denied = projectCredentialOperationAvailability({ credentialManage: "denied" });
    expect(denied.find((entry) => entry.operation === "supersede_credential")?.state).toBe(
      "unavailable_capability_denied",
    );
    const stepUp = projectCredentialOperationAvailability({
      credentialManage: "two_factor_required",
    });
    expect(stepUp.find((entry) => entry.operation === "supersede_credential")?.state).toBe(
      "unavailable_two_factor_required",
    );
  });

  it("carries taskId and mutationRequestId so a refresh can resume the operation", () => {
    expect(
      projectCredentialQueuedResult({
        taskId: "task-1",
        credentialId: "credential-1",
        channelAccountId: "account-1",
        enqueuedAt: NOW,
        mutationRequestId: "550e8400-e29b-41d4-a716-446655440000",
      }),
    ).toEqual({
      code: "credential_validation_queued",
      state: "queued",
      taskId: "task-1",
      credentialId: "credential-1",
      channelAccountId: "account-1",
      enqueuedAt: "2026-08-04T00:00:00.000Z",
      mutationRequestId: "550e8400-e29b-41d4-a716-446655440000",
    });
  });

  it("maps every durable task status to a browser state", () => {
    const cases: Array<[string, string]> = [
      ["pending", "queued"],
      ["processing", "running"],
      ["completed", "completed"],
      ["completed_with_errors", "completed_with_errors"],
      ["failed", "failed"],
      ["disabled", "disabled"],
      ["something-new", "unknown"],
    ];
    for (const [status, expected] of cases) {
      expect(projectCredentialTaskStatus({ taskId: "task-1", status }).state).toBe(expected);
    }
  });

  it("surfaces an advisory code from a successful validation result", () => {
    const view = projectCredentialTaskStatus({
      taskId: "task-1",
      status: "completed",
      result: {
        code: "credential_expired",
        credentialId: "credential-1",
        status: "expired",
        expiresAt: "2026-01-01T00:00:00.000Z",
        lastValidatedAt: "2026-08-04T00:00:00.000Z",
        fingerprintPrefix: "ab12",
      },
    });
    expect(view.result).toEqual({
      code: "credential_expired",
      credentialId: "credential-1",
      status: "expired",
      expiresAt: "2026-01-01T00:00:00.000Z",
      lastValidatedAt: "2026-08-04T00:00:00.000Z",
      fingerprintPrefix: "ab12",
    });
    expect(view.failureCode).toBeNull();
  });

  it("surfaces a precondition failure code from the persisted task error", () => {
    const view = projectCredentialTaskStatus({
      taskId: "task-1",
      status: "failed",
      error: { code: "account_inactive", message: "Channel account is inactive" },
    });
    expect(view).toEqual({
      taskId: "task-1",
      state: "failed",
      result: null,
      failureCode: "account_inactive",
    });
  });

  it("drops an unrecognised code instead of exposing an unhandled branch", () => {
    expect(
      projectCredentialTaskStatus({
        taskId: "task-1",
        status: "failed",
        error: { code: "handler_failed", message: "Task handler failed" },
      }).failureCode,
    ).toBeNull();
  });
});

describe("error envelope", () => {
  it("keeps stable codes and whitelisted structured details only", () => {
    expect(
      projectErrorEnvelope({
        code: "admin_rate_limited",
        status: 429,
        details: { retryAfterSeconds: "30", capability: "credential:manage", note: "free text" },
      }),
    ).toEqual({
      ok: false,
      status: 429,
      code: "admin_rate_limited",
      details: { retryAfterSeconds: "30", capability: "credential:manage" },
    });
  });

  it("omits details entirely when nothing is whitelisted", () => {
    expect(projectErrorEnvelope({ code: "credential_missing", status: 404 })).toEqual({
      ok: false,
      status: 404,
      code: "credential_missing",
    });
  });

  it("falls back to 403 for a status outside the published envelope", () => {
    expect(projectErrorEnvelope({ code: "credential_missing", status: 500 }).status).toBe(403);
  });

  it("preserves a 409 idempotency conflict instead of coercing it to 403", () => {
    // Coercion would make a replayed mutation request id look like a permission
    // problem, sending the operator to the capability screen instead of the
    // request they actually need to resubmit.
    expect(
      projectErrorEnvelope({
        code: "admin_mutation_request_id_invalid",
        status: 409,
        details: { reason: "idempotency_conflict" },
      }),
    ).toEqual({
      ok: false,
      status: 409,
      code: "admin_mutation_request_id_invalid",
      details: { reason: "idempotency_conflict" },
    });
  });

  it("drops an unrecognised reason rather than forwarding it", () => {
    expect(
      projectErrorEnvelope({
        code: "admin_mutation_request_id_invalid",
        status: 409,
        details: { reason: "something the browser cannot branch on" },
      }),
    ).toEqual({
      ok: false,
      status: 409,
      code: "admin_mutation_request_id_invalid",
    });
  });

  it("preserves both session expiry reasons from the real validateAdminSession error", () => {
    // Idle expiry is recoverable by signing in again; the absolute cap is not.
    // Collapsing them would leave the sign-in screen unable to say which.
    const identity: AdminIdentity = {
      id: "identity-1",
      username: "operator",
      role: "super_admin",
      status: "active",
      sessionVersion: 1,
      twoFactorEnabled: true,
    };
    const issuedAt = new Date(NOW.getTime() - 3 * 60 * 60 * 1000);
    const base: AdminSessionRecord = {
      id: "session-1",
      tokenHash: "a".repeat(64),
      identityId: identity.id,
      sessionVersion: identity.sessionVersion,
      issuedAt,
      lastSeenAt: NOW,
      absoluteExpiresAt: new Date(issuedAt.getTime() + ADMIN_ABSOLUTE_TIMEOUT_MS),
      twoFactorCompletedAt: NOW,
      revokedAt: null,
    };

    const cases: Array<[AdminSessionRecord, string]> = [
      [{ ...base, lastSeenAt: new Date(NOW.getTime() - ADMIN_IDLE_TIMEOUT_MS) }, "idle_timeout"],
      [{ ...base, absoluteExpiresAt: new Date(NOW) }, "absolute_timeout"],
    ];

    for (const [session, reason] of cases) {
      let caught: unknown;
      try {
        validateAdminSession(session, identity, NOW);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AdminAccessError);
      const error = caught as AdminAccessError;
      expect(error.code).toBe("jwt_expired");

      const envelope = projectErrorEnvelope({
        code: error.code,
        status: error.status,
        details: error.details,
      });
      expect(envelope).toEqual({
        ok: false,
        status: 401,
        code: "jwt_expired",
        details: { reason },
      });
      expect(JSON.stringify(envelope)).not.toContain("Admin session expired");
      expect(JSON.stringify(envelope)).not.toContain("a".repeat(64));
    }
  });

  it("projects the real service conflict error without leaking its message", () => {
    const error = new CredentialReplacementIdempotencyConflictError();
    const envelope = projectErrorEnvelope({
      code: error.code,
      status: error.status,
      details: error.details,
    });

    expect(envelope).toEqual({
      ok: false,
      status: 409,
      code: "admin_mutation_request_id_invalid",
      details: { reason: "idempotency_conflict" },
    });
    expect(envelope).not.toHaveProperty("message");
    expect(JSON.stringify(envelope)).not.toContain("binding conflict");
  });
});
