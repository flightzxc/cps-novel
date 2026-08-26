import "./setup-cleanup";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminAccessError } from "@/lib/auth/errors";
import type { AdminAuthContext } from "@/lib/auth/types";

/**
 * PR-C1 · `two-factor/setup/_actions.ts` — `startSetupAction` and
 * `confirmSetupAction`'s own wiring.
 *
 * Same mocking policy as `admin-two-factor-challenge-action.test.ts`:
 * `../../_lib/auth-session` is replaced as a unit (its own logic lives in
 * `admin-auth-session-lib.test.ts`); `@/lib/auth/two-factor`,
 * `@/lib/auth/login` (for the post-confirm revoke) and the store factories
 * are mocked at the service boundary. What this file proves is
 * `confirmSetupAction`'s documented, slightly unusual contract: on success it
 * does not leave the bootstrapping session half-alive — it revokes it and
 * clears both cookies outright, forcing a real second login that this time
 * engages the challenge — see the docstring on `confirmSetupAction` for why.
 */

const requireActiveContext = vi.hoisted(() => vi.fn());
const requireSameOriginSubmission = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const clearSessionCookie = vi.hoisted(() => vi.fn());
const clearTwoFactorChallengeCookie = vi.hoisted(() => vi.fn());

vi.mock("@/app/(admin-auth)/_lib/auth-session", () => ({
  requireActiveContext,
  requireSameOriginSubmission,
  clearSessionCookie,
  clearTwoFactorChallengeCookie,
}));

const guardDependencies = vi.hoisted(() =>
  vi.fn(() => ({ identities: { marker: "identities" }, sessions: { marker: "sessions" } })),
);
vi.mock("@/app/api/admin/_lib/deps", () => ({ guardDependencies }));

const startTwoFactorSetup = vi.hoisted(() => vi.fn());
const confirmTwoFactorSetup = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/two-factor", () => ({ startTwoFactorSetup, confirmTwoFactorSetup }));

const revokeAdminSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/login", () => ({ revokeAdminSession }));

const authUnitOfWork = vi.hoisted(() => vi.fn(() => ({ marker: "auth-uow" })));
const twoFactorStore = vi.hoisted(() => vi.fn(() => ({ marker: "two-factor-store" })));
vi.mock("@/app/api/admin/_lib/auth-deps", () => ({ authUnitOfWork, twoFactorStore }));

const { startSetupAction, confirmSetupAction } = await import("@/app/(admin-auth)/two-factor/setup/_actions");

const fakeContext = {
  identity: { id: "id-1", twoFactorEnabled: false },
  session: { id: "session-1" },
} as unknown as AdminAuthContext;

beforeEach(() => {
  requireActiveContext.mockReset();
  requireActiveContext.mockResolvedValue(fakeContext);
  requireSameOriginSubmission.mockReset();
  requireSameOriginSubmission.mockResolvedValue(undefined);
  clearSessionCookie.mockReset();
  clearTwoFactorChallengeCookie.mockReset();
  guardDependencies.mockClear();
  startTwoFactorSetup.mockReset();
  confirmTwoFactorSetup.mockReset();
  revokeAdminSession.mockReset();
  authUnitOfWork.mockClear();
  twoFactorStore.mockClear();
});

describe("startSetupAction", () => {
  it("rejects a cross-origin submission before touching the identity store", async () => {
    requireSameOriginSubmission.mockRejectedValue(
      new AdminAccessError("admin_origin_denied", 403, "Admin mutation origin denied"),
    );

    const result = await startSetupAction();

    expect(result).toEqual({ ok: false, envelope: expect.objectContaining({ code: "admin_origin_denied" }) });
    expect(startTwoFactorSetup).not.toHaveBeenCalled();
  });

  it("refuses to regenerate a secret for an identity that already has 2FA enabled", async () => {
    requireActiveContext.mockResolvedValue({
      identity: { id: "id-1", twoFactorEnabled: true },
      session: { id: "session-1" },
    } as unknown as AdminAuthContext);

    const result = await startSetupAction();

    expect(result).toEqual({ ok: false, envelope: expect.objectContaining({ code: "two_factor_failed" }) });
    expect(startTwoFactorSetup).not.toHaveBeenCalled();
  });

  it("projects the manual key, otpauth URI and pending expiry on success", async () => {
    const pendingExpiresAt = new Date("2026-08-26T12:10:00.000Z");
    startTwoFactorSetup.mockResolvedValue({
      manualKey: "JBSWY3DPEHPK3PXP",
      otpauthUri: "otpauth://totp/root@cps-novel?secret=JBSWY3DPEHPK3PXP",
      pendingExpiresAt,
    });

    const result = await startSetupAction();

    expect(startTwoFactorSetup).toHaveBeenCalledWith({
      identityId: "id-1",
      identities: { marker: "identities" },
      twoFactor: { marker: "two-factor-store" },
    });
    expect(result).toEqual({
      ok: true,
      data: {
        manualKey: "JBSWY3DPEHPK3PXP",
        otpauthUri: "otpauth://totp/root@cps-novel?secret=JBSWY3DPEHPK3PXP",
        pendingExpiresAt: pendingExpiresAt.toISOString(),
      },
    });
  });

  it("surfaces an expired pending setup as two_factor_expired", async () => {
    startTwoFactorSetup.mockRejectedValue(new AdminAccessError("two_factor_expired", 403, "Two-factor setup expired"));

    const result = await startSetupAction();

    expect(result).toEqual({ ok: false, envelope: expect.objectContaining({ code: "two_factor_expired" }) });
  });
});

describe("confirmSetupAction", () => {
  it("rejects a cross-origin submission before touching the pending secret", async () => {
    requireSameOriginSubmission.mockRejectedValue(
      new AdminAccessError("admin_origin_denied", 403, "Admin mutation origin denied"),
    );

    const result = await confirmSetupAction({ code: "123456" });

    expect(result).toEqual({ ok: false, envelope: expect.objectContaining({ code: "admin_origin_denied" }) });
    expect(confirmTwoFactorSetup).not.toHaveBeenCalled();
  });

  it("never revokes the session or clears cookies on a failed confirmation", async () => {
    confirmTwoFactorSetup.mockRejectedValue(new AdminAccessError("two_factor_failed", 403, "Invalid two-factor code"));

    const result = await confirmSetupAction({ code: "000000" });

    expect(result).toEqual({ ok: false, envelope: expect.objectContaining({ code: "two_factor_failed" }) });
    expect(revokeAdminSession).not.toHaveBeenCalled();
    expect(clearSessionCookie).not.toHaveBeenCalled();
    expect(clearTwoFactorChallengeCookie).not.toHaveBeenCalled();
  });

  it("on success: forwards the code, then revokes the bootstrapping session and clears both cookies", async () => {
    confirmTwoFactorSetup.mockResolvedValue({
      recoveryCodes: ["A1B2-C3D4-E5F6", "G7H8-I9J0-K1L2"],
      nextSessionVersion: 2,
    });

    const result = await confirmSetupAction({ code: "123456" });

    expect(confirmTwoFactorSetup).toHaveBeenCalledWith({
      identityId: "id-1",
      code: "123456",
      identities: { marker: "identities" },
      twoFactor: { marker: "two-factor-store" },
      transactions: { marker: "auth-uow" },
    });
    expect(revokeAdminSession).toHaveBeenCalledWith({ marker: "sessions" }, "session-1");
    expect(clearSessionCookie).toHaveBeenCalledTimes(1);
    expect(clearTwoFactorChallengeCookie).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: true,
      data: { codes: ["A1B2-C3D4-E5F6", "G7H8-I9J0-K1L2"], generatedAt: expect.any(String) },
    });
  });

  it("revokes and clears cookies only after confirmTwoFactorSetup resolves, never before", async () => {
    let revokedBeforeConfirm = false;
    revokeAdminSession.mockImplementation(() => {
      revokedBeforeConfirm = confirmTwoFactorSetup.mock.calls.length === 0;
      return Promise.resolve(true);
    });
    confirmTwoFactorSetup.mockResolvedValue({ recoveryCodes: ["X"], nextSessionVersion: 2 });

    await confirmSetupAction({ code: "123456" });

    expect(revokedBeforeConfirm).toBe(false);
  });
});
