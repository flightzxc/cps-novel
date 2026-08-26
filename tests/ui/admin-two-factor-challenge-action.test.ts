import "./setup-cleanup";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminAccessError } from "@/lib/auth/errors";
import type { AdminAuthContext } from "@/lib/auth/types";

/**
 * PR-C1 · `two-factor/challenge/_actions.ts` — `completeChallengeAction` and
 * `resendChallengeAction`'s own wiring.
 *
 * `../../_lib/auth-session` is mocked as a unit (not dug into): its own
 * branching — `requireActiveContext`, cookie read/write/clear, `safeNextPath`
 * — is already covered by `admin-auth-session-lib.test.ts`. This file only
 * proves these two actions call the right `@/lib/auth/two-factor` function
 * with the right arguments, clear the challenge cookie exactly when (and
 * only when) the challenge actually completes, and translate a failed
 * attempt into the same `two_factor_failed` envelope regardless of whether
 * the code or the recovery code was wrong.
 */

const requireActiveContext = vi.hoisted(() => vi.fn());
const requireSameOriginSubmission = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const readTwoFactorChallengeToken = vi.hoisted(() => vi.fn());
const writeTwoFactorChallengeCookie = vi.hoisted(() => vi.fn());
const clearTwoFactorChallengeCookie = vi.hoisted(() => vi.fn());
const safeNextPath = vi.hoisted(() => vi.fn((value: string | null | undefined) => value ?? null));

vi.mock("@/app/(admin-auth)/_lib/auth-session", () => ({
  ADMIN_LANDING_PATH: "/novels",
  requireActiveContext,
  requireSameOriginSubmission,
  readTwoFactorChallengeToken,
  writeTwoFactorChallengeCookie,
  clearTwoFactorChallengeCookie,
  safeNextPath,
}));

const completeTwoFactorChallenge = vi.hoisted(() => vi.fn());
const createTwoFactorChallenge = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/two-factor", () => ({ completeTwoFactorChallenge, createTwoFactorChallenge }));

const authUnitOfWork = vi.hoisted(() => vi.fn(() => ({ marker: "auth-uow" })));
const recoveryCodeStore = vi.hoisted(() => vi.fn(() => ({ marker: "recovery-store" })));
const twoFactorStore = vi.hoisted(() => vi.fn(() => ({ marker: "two-factor-store" })));
vi.mock("@/app/api/admin/_lib/auth-deps", () => ({ authUnitOfWork, recoveryCodeStore, twoFactorStore }));

const { completeChallengeAction, resendChallengeAction } = await import(
  "@/app/(admin-auth)/two-factor/challenge/_actions"
);

const fakeContext = { identity: { id: "id-1", twoFactorEnabled: true }, session: { id: "session-1" } } as unknown as AdminAuthContext;

beforeEach(() => {
  requireActiveContext.mockReset();
  requireActiveContext.mockResolvedValue(fakeContext);
  requireSameOriginSubmission.mockReset();
  requireSameOriginSubmission.mockResolvedValue(undefined);
  readTwoFactorChallengeToken.mockReset();
  writeTwoFactorChallengeCookie.mockReset();
  clearTwoFactorChallengeCookie.mockReset();
  safeNextPath.mockClear();
  completeTwoFactorChallenge.mockReset();
  createTwoFactorChallenge.mockReset();
  authUnitOfWork.mockClear();
  recoveryCodeStore.mockClear();
  twoFactorStore.mockClear();
});

describe("completeChallengeAction — same-origin and an active session are required first", () => {
  it("rejects a cross-origin submission before reading the challenge cookie at all", async () => {
    requireSameOriginSubmission.mockRejectedValue(
      new AdminAccessError("admin_origin_denied", 403, "Admin mutation origin denied"),
    );

    const result = await completeChallengeAction({ code: "123456" });

    expect(result).toEqual({ ok: false, envelope: expect.objectContaining({ code: "admin_origin_denied" }) });
    expect(readTwoFactorChallengeToken).not.toHaveBeenCalled();
  });

  it("fails closed when there is no active session", async () => {
    requireActiveContext.mockRejectedValue(new AdminAccessError("jwt_missing", 401, "Admin session is required"));

    const result = await completeChallengeAction({ code: "123456" });

    expect(result).toEqual({ ok: false, envelope: expect.objectContaining({ code: "jwt_missing" }) });
  });

  it("treats a missing challenge cookie as an expired challenge, not a crash", async () => {
    readTwoFactorChallengeToken.mockResolvedValue(null);

    const result = await completeChallengeAction({ code: "123456" });

    expect(result).toEqual({ ok: false, envelope: expect.objectContaining({ code: "two_factor_expired" }) });
    expect(completeTwoFactorChallenge).not.toHaveBeenCalled();
  });
});

describe("completeChallengeAction — TOTP and recovery code both reach completeTwoFactorChallenge the same way", () => {
  it("forwards a submitted TOTP code with the raw cookie token and the store handles", async () => {
    readTwoFactorChallengeToken.mockResolvedValue("raw-challenge-token");
    completeTwoFactorChallenge.mockResolvedValue({
      identityId: "id-1",
      sessionId: "session-1",
      completedAt: new Date(),
      method: "totp",
      sessionVersion: 1,
    });

    await completeChallengeAction({ code: "123456", next: "/tags" });

    expect(completeTwoFactorChallenge).toHaveBeenCalledWith({
      context: fakeContext,
      token: "raw-challenge-token",
      code: "123456",
      recoveryCode: undefined,
      twoFactor: { marker: "two-factor-store" },
      recoveryCodes: { marker: "recovery-store" },
      transactions: { marker: "auth-uow" },
    });
  });

  it("forwards a submitted recovery code the same way, and clears the cookie + resolves next on success", async () => {
    readTwoFactorChallengeToken.mockResolvedValue("raw-challenge-token");
    completeTwoFactorChallenge.mockResolvedValue({
      identityId: "id-1",
      sessionId: "session-1",
      completedAt: new Date(),
      method: "recovery_code",
      sessionVersion: 1,
    });
    safeNextPath.mockReturnValue("/tags");

    const result = await completeChallengeAction({ recoveryCode: "A1B2-C3D4-E5F6", next: "/tags" });

    expect(completeTwoFactorChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ code: undefined, recoveryCode: "A1B2-C3D4-E5F6" }),
    );
    expect(clearTwoFactorChallengeCookie).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, next: "/tags" });
  });

  it("falls back to the landing page when next was absent or invalid", async () => {
    readTwoFactorChallengeToken.mockResolvedValue("raw-challenge-token");
    completeTwoFactorChallenge.mockResolvedValue({
      identityId: "id-1",
      sessionId: "session-1",
      completedAt: new Date(),
      method: "totp",
      sessionVersion: 1,
    });
    safeNextPath.mockReturnValue(null);

    const result = await completeChallengeAction({ code: "123456" });

    expect(result).toEqual({ ok: true, next: "/novels" });
  });

  it("never clears the cookie on a failed attempt (wrong code or wrong recovery code alike)", async () => {
    readTwoFactorChallengeToken.mockResolvedValue("raw-challenge-token");
    completeTwoFactorChallenge.mockRejectedValue(
      new AdminAccessError("two_factor_failed", 403, "Invalid two-factor or recovery code"),
    );

    const result = await completeChallengeAction({ code: "000000" });

    expect(result).toEqual({ ok: false, envelope: expect.objectContaining({ code: "two_factor_failed" }) });
    expect(clearTwoFactorChallengeCookie).not.toHaveBeenCalled();
  });

  it("surfaces a locked-out challenge as two_factor_locked", async () => {
    readTwoFactorChallengeToken.mockResolvedValue("raw-challenge-token");
    completeTwoFactorChallenge.mockRejectedValue(
      new AdminAccessError("two_factor_locked", 403, "Two-factor challenge locked"),
    );

    const result = await completeChallengeAction({ code: "000000" });

    expect(result).toEqual({ ok: false, envelope: expect.objectContaining({ code: "two_factor_locked" }) });
  });
});

describe("resendChallengeAction — issues a fresh challenge and overwrites the cookie", () => {
  it("refuses to resend for an identity that never enabled 2FA", async () => {
    requireActiveContext.mockResolvedValue({
      identity: { id: "id-1", twoFactorEnabled: false },
      session: { id: "session-1" },
    } as unknown as AdminAuthContext);

    const result = await resendChallengeAction();

    expect(result).toEqual({ ok: false, envelope: expect.objectContaining({ code: "two_factor_failed" }) });
    expect(createTwoFactorChallenge).not.toHaveBeenCalled();
  });

  it("creates a new challenge and writes its token as the 2FA cookie", async () => {
    createTwoFactorChallenge.mockResolvedValue({
      token: "fresh-token",
      expiresAt: new Date(),
      sessionId: "session-1",
    });

    const result = await resendChallengeAction();

    expect(createTwoFactorChallenge).toHaveBeenCalledWith({
      context: fakeContext,
      twoFactor: { marker: "two-factor-store" },
    });
    expect(writeTwoFactorChallengeCookie).toHaveBeenCalledWith("fresh-token");
    expect(result).toEqual({ ok: true });
  });
});
