"use server";

import { headers } from "next/headers";

import { createTotpQrCodeDataUrl } from "@/lib/auth/totp";
import { confirmTwoFactorSetup, startTwoFactorSetup } from "@/lib/auth/two-factor";
import { regenerateRecoveryCodes } from "@/lib/auth/recovery-codes";
import { requireAdminActionAccess } from "@/server/auth/guards";

import { authUnitOfWork, twoFactorStore } from "../../../api/admin/_lib/auth-deps";
import { canonicalOrigin, guardDependencies, readSessionToken } from "../../../api/admin/_lib/deps";

type SecurityActionId =
  | "admin.security.two_factor.start"
  | "admin.security.two_factor.confirm"
  | "admin.security.recovery_codes.regenerate";

async function guard(actionId: SecurityActionId, requestId: string) {
  const requestHeaders = await headers();
  return requireAdminActionAccess({
    actionId,
    sessionToken: await readSessionToken(),
    origin: requestHeaders.get("origin"),
    canonicalOrigin: await canonicalOrigin(),
    requestId,
  }, guardDependencies());
}

export async function startSecuritySetupAction(input: { requestId: string }) {
  try {
    const access = await guard("admin.security.two_factor.start", input.requestId);
    const deps = guardDependencies();
    const setup = await startTwoFactorSetup({
      identityId: access.context.identity.id,
      identities: deps.identities,
      twoFactor: twoFactorStore(),
    });
    return { ok: true as const, data: {
      manualKey: setup.manualKey,
      otpauthUri: setup.otpauthUri,
      qrCodeDataUrl: await createTotpQrCodeDataUrl(setup.otpauthUri),
      pendingExpiresAt: setup.pendingExpiresAt.toISOString(),
    } };
  } catch { return { ok: false as const, code: "security_setup_failed" }; }
}

export async function confirmSecuritySetupAction(input: { requestId: string; code: string }) {
  try {
    const access = await guard("admin.security.two_factor.confirm", input.requestId);
    const deps = guardDependencies();
    const result = await confirmTwoFactorSetup({
      identityId: access.context.identity.id,
      code: input.code,
      identities: deps.identities,
      twoFactor: twoFactorStore(),
      transactions: authUnitOfWork(),
    });
    return { ok: true as const, data: { recoveryCodes: result.recoveryCodes } };
  } catch { return { ok: false as const, code: "security_confirm_failed" }; }
}

export async function regenerateSecurityRecoveryCodesAction(input: { requestId: string; code: string }) {
  try {
    const access = await guard("admin.security.recovery_codes.regenerate", input.requestId);
    const deps = guardDependencies();
    const result = await regenerateRecoveryCodes({
      identityId: access.context.identity.id,
      code: input.code,
      identities: deps.identities,
      twoFactor: twoFactorStore(),
      transactions: authUnitOfWork(),
    });
    return { ok: true as const, data: { recoveryCodes: result.recoveryCodes } };
  } catch { return { ok: false as const, code: "security_regenerate_failed" }; }
}
