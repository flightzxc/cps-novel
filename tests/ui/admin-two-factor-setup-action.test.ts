import "./setup-cleanup";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminAccessError } from "@/lib/auth/errors";
import { hashAdminSessionToken } from "@/lib/auth/session";
import type { AdminAuthContext } from "@/lib/auth/types";

/**
 * PR-C1 / U5 · `two-factor/setup/_actions.ts` — `startSetupAction`,
 * `confirmSetupAction`, and `finishSetupAction`.
 *
 * `confirmSetupAction` returns the one-time recovery codes and does **not**
 * revoke or clear cookies: doing that in the same action made the follow-up
 * RSC render bounce to `/login` before the operator could save the codes
 * (X8 R1). Session fencing still happens inside `confirmTwoFactorSetup`
 * (`sessionVersion` bump). Explicit revoke + cookie clear + `/login` are
 * `finishSetupAction`, after "我已保存，继续".
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

const requireActiveContext = vi.hoisted(() => vi.fn());
const requireSameOriginSubmission = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const clearSessionCookie = vi.hoisted(() => vi.fn());
const clearTwoFactorChallengeCookie = vi.hoisted(() => vi.fn());
const safeNextPath = vi.hoisted(() => vi.fn((value: string | null | undefined) => value ?? null));

vi.mock("@/app/(admin-auth)/_lib/auth-session", () => ({
  requireActiveContext,
  requireSameOriginSubmission,
  clearSessionCookie,
  clearTwoFactorChallengeCookie,
  LOGIN_PATH: "/login",
  safeNextPath,
}));

const findByTokenHash = vi.hoisted(() => vi.fn());
const readSessionToken = vi.hoisted(() => vi.fn());
const guardDependencies = vi.hoisted(() =>
  vi.fn(() => ({
    identities: { marker: "identities" },
    sessions: { marker: "sessions", findByTokenHash },
  })),
);
vi.mock("@/app/api/admin/_lib/deps", () => ({ guardDependencies, readSessionToken }));

const startTwoFactorSetup = vi.hoisted(() => vi.fn());
const confirmTwoFactorSetup = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/two-factor", () => ({ startTwoFactorSetup, confirmTwoFactorSetup }));

const revokeAdminSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/login", () => ({ revokeAdminSession }));

const authUnitOfWork = vi.hoisted(() => vi.fn(() => ({ marker: "auth-uow" })));
const twoFactorStore = vi.hoisted(() => vi.fn(() => ({ marker: "two-factor-store" })));
vi.mock("@/app/api/admin/_lib/auth-deps", () => ({ authUnitOfWork, twoFactorStore }));

const { startSetupAction, confirmSetupAction, finishSetupAction } = await import(
  "@/app/(admin-auth)/two-factor/setup/_actions"
);

const fakeContext = {
  identity: { id: "id-1", twoFactorEnabled: false },
  session: { id: "session-1" },
} as unknown as AdminAuthContext;

async function runFinish(next?: string | null): Promise<string> {
  try {
    await finishSetupAction(next === undefined ? {} : { next });
    throw new Error("finishSetupAction did not redirect");
  } catch (error) {
    if (error instanceof RedirectSignal) return error.url;
    throw error;
  }
}

beforeEach(() => {
  requireActiveContext.mockReset();
  requireActiveContext.mockResolvedValue(fakeContext);
  requireSameOriginSubmission.mockReset();
  requireSameOriginSubmission.mockResolvedValue(undefined);
  clearSessionCookie.mockReset();
  clearTwoFactorChallengeCookie.mockReset();
  safeNextPath.mockReset();
  safeNextPath.mockImplementation((value: string | null | undefined) => value ?? null);
  guardDependencies.mockClear();
  findByTokenHash.mockReset();
  readSessionToken.mockReset();
  startTwoFactorSetup.mockReset();
  confirmTwoFactorSetup.mockReset();
  revokeAdminSession.mockReset();
  authUnitOfWork.mockClear();
  twoFactorStore.mockClear();
  redirectMock.mockClear();
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

  it("on success: returns the one-time codes and does not revoke or clear cookies", async () => {
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
    expect(revokeAdminSession).not.toHaveBeenCalled();
    expect(clearSessionCookie).not.toHaveBeenCalled();
    expect(clearTwoFactorChallengeCookie).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      data: { codes: ["A1B2-C3D4-E5F6", "G7H8-I9J0-K1L2"], generatedAt: expect.any(String) },
    });
  });
});

describe("finishSetupAction", () => {
  it("rejects a cross-origin submission before revoking anything", async () => {
    requireSameOriginSubmission.mockRejectedValue(
      new AdminAccessError("admin_origin_denied", 403, "Admin mutation origin denied"),
    );

    await expect(finishSetupAction()).rejects.toEqual(
      expect.objectContaining({ code: "admin_origin_denied" }),
    );
    expect(revokeAdminSession).not.toHaveBeenCalled();
    expect(clearSessionCookie).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("revokes the leftover bootstrap session, clears both cookies, and lands on /login", async () => {
    readSessionToken.mockResolvedValue("raw-token");
    findByTokenHash.mockResolvedValue({ id: "session-1" });

    const url = await runFinish();

    expect(findByTokenHash).toHaveBeenCalledWith(hashAdminSessionToken("raw-token"));
    expect(revokeAdminSession).toHaveBeenCalledWith(
      expect.objectContaining({ findByTokenHash }),
      "session-1",
    );
    expect(clearSessionCookie).toHaveBeenCalledTimes(1);
    expect(clearTwoFactorChallengeCookie).toHaveBeenCalledTimes(1);
    expect(url).toBe("/login");
  });

  it("appends a validated next onto /login so the second login can resume the deep link", async () => {
    readSessionToken.mockResolvedValue("raw-token");
    findByTokenHash.mockResolvedValue({ id: "session-1" });
    safeNextPath.mockReturnValue("/tags");

    expect(await runFinish("/tags")).toBe("/login?next=%2Ftags");
  });

  it("drops an unsafe next rather than putting it on the login URL", async () => {
    readSessionToken.mockResolvedValue(null);
    safeNextPath.mockReturnValue(null);

    expect(await runFinish("https://evil.example")).toBe("/login");
  });

  it("still clears cookies and redirects when the leftover cookie is already gone", async () => {
    readSessionToken.mockResolvedValue(null);

    expect(await runFinish()).toBe("/login");
    expect(revokeAdminSession).not.toHaveBeenCalled();
    expect(clearSessionCookie).toHaveBeenCalledTimes(1);
    expect(clearTwoFactorChallengeCookie).toHaveBeenCalledTimes(1);
  });
});
