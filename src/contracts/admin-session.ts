import type { AdminCapability } from "@/lib/auth/capabilities";
import type { AdminIdentity, AdminSessionRecord } from "@/lib/auth/types";

/**
 * Capability is tri-state, never a boolean.
 *
 * `two_factor_required` is the case a boolean would destroy: the operator holds
 * the capability but this session has not completed step-up 2FA, so the UI must
 * offer the challenge instead of hiding the control or letting the click through.
 */
export type AdminCapabilityState = "granted" | "two_factor_required" | "denied";

export type AdminCapabilityView = {
  readonly capability: AdminCapability;
  readonly state: AdminCapabilityState;
};

export type AdminSessionView = {
  readonly identityId: string;
  readonly username: string;
  readonly role: string;
  readonly twoFactorCompleted: boolean;
  /** ISO-8601. Derived from `lastSeenAt + idleTimeoutMs`; slides on activity. */
  readonly idleExpiresAt: string;
  /** ISO-8601. Fixed at issue time and never extended. */
  readonly absoluteExpiresAt: string;
  readonly capabilities: readonly AdminCapabilityView[];
};

/**
 * Resolve one capability chip.
 *
 * Fails closed by construction: `granted` is only reachable when the caller
 * proved the grant AND (2FA is not required OR this session completed it).
 * A capability whose configured role list is empty arrives here as
 * `granted: false` and renders `denied`, so an unconfigured capability can
 * never be shown as usable.
 */
export function projectAdminCapability(input: {
  capability: AdminCapability;
  granted: boolean;
  requiresTwoFactor: boolean;
  twoFactorCompleted: boolean;
}): AdminCapabilityView {
  const state: AdminCapabilityState = !input.granted
    ? "denied"
    : input.requiresTwoFactor && !input.twoFactorCompleted
      ? "two_factor_required"
      : "granted";
  return Object.freeze({ capability: input.capability, state });
}

/**
 * Build the browser-facing session view.
 *
 * `idleTimeoutMs` is injected rather than imported so this module keeps zero
 * runtime dependencies — `@/lib/auth/session` pulls in `node:crypto`, which must
 * not reach a client bundle. Server callers pass `ADMIN_IDLE_TIMEOUT_MS`.
 *
 * Reads only `lastSeenAt` and `absoluteExpiresAt` off the session record; the
 * row's `id`, `tokenHash`, `sessionVersion` and `revokedAt` are never read and
 * therefore cannot be emitted.
 */
export function projectAdminSession(input: {
  identity: Pick<AdminIdentity, "id" | "username" | "role">;
  session: Pick<AdminSessionRecord, "lastSeenAt" | "absoluteExpiresAt">;
  twoFactorCompleted: boolean;
  idleTimeoutMs: number;
  capabilities: readonly AdminCapabilityView[];
}): AdminSessionView {
  return Object.freeze({
    identityId: input.identity.id,
    username: input.identity.username,
    role: input.identity.role,
    twoFactorCompleted: input.twoFactorCompleted,
    idleExpiresAt: new Date(
      input.session.lastSeenAt.getTime() + input.idleTimeoutMs,
    ).toISOString(),
    absoluteExpiresAt: input.session.absoluteExpiresAt.toISOString(),
    capabilities: Object.freeze(
      input.capabilities.map((entry) =>
        Object.freeze({ capability: entry.capability, state: entry.state }),
      ),
    ),
  });
}
