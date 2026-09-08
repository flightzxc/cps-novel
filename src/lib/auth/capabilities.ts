import { AdminAccessError } from "./errors";
import type { AdminAuthContext } from "./types";
import { isTwoFactorEnforced } from "./two-factor-enforcement";

export type AdminCapability =
  | "credential:manage"
  | "settings:manage"
  | "task:manage"
  | "content:publish"
  | "content:takedown"
  | "content:view"
  | "content:read"
  | "tag:manage"
  | "promo:claim"
  | "revenue:view"
  /**
   * C-30A (施工工单_C30_换小说_移植CPS换租客_2026-09-08.md §4A.3): single-
   * article rebind — CPS parity with `article:rebind-drama`, two granularities
   * per Owner 2026-09-08 decision (do not merge single/batch into one
   * capability).
   */
  | "content:rebind"
  /** C-30A: batch rebind — CPS parity `article:batch-rebind-drama`. Wired by C-30B (order 2); the capability itself is registered now so both orders share one grant surface. */
  | "content:batch-rebind";

type CapabilityConfig = {
  rolesEnv: string;
  userIdsEnv: string;
  defaultRoles: readonly string[];
  requiresTwoFactor: boolean;
};

export const ADMIN_CAPABILITY_CONFIG: Readonly<Record<AdminCapability, CapabilityConfig>> =
  Object.freeze({
    "credential:manage": {
      rolesEnv: "CREDENTIAL_MANAGE_ROLES",
      userIdsEnv: "CREDENTIAL_MANAGE_USER_IDS",
      defaultRoles: ["super_admin"],
      requiresTwoFactor: true,
    },
    "settings:manage": {
      rolesEnv: "SETTINGS_MANAGE_ROLES",
      userIdsEnv: "SETTINGS_MANAGE_USER_IDS",
      defaultRoles: ["super_admin"],
      requiresTwoFactor: true,
    },
    "task:manage": {
      rolesEnv: "TASK_MANAGE_ROLES",
      userIdsEnv: "TASK_MANAGE_USER_IDS",
      defaultRoles: ["super_admin"],
      requiresTwoFactor: true,
    },
    "content:publish": {
      rolesEnv: "CONTENT_PUBLISH_ROLES",
      userIdsEnv: "CONTENT_PUBLISH_USER_IDS",
      defaultRoles: ["super_admin"],
      requiresTwoFactor: true,
    },
    "content:takedown": {
      rolesEnv: "CONTENT_TAKEDOWN_ROLES",
      userIdsEnv: "CONTENT_TAKEDOWN_USER_IDS",
      defaultRoles: ["super_admin"],
      requiresTwoFactor: true,
    },
    "content:view": {
      rolesEnv: "CONTENT_VIEW_ROLES",
      userIdsEnv: "CONTENT_VIEW_USER_IDS",
      defaultRoles: [],
      requiresTwoFactor: false,
    },
    "content:read": {
      rolesEnv: "CONTENT_READ_ROLES",
      userIdsEnv: "CONTENT_READ_USER_IDS",
      defaultRoles: [],
      requiresTwoFactor: false,
    },
    "tag:manage": {
      rolesEnv: "TAG_MANAGE_ROLES",
      userIdsEnv: "TAG_MANAGE_USER_IDS",
      defaultRoles: ["super_admin"],
      requiresTwoFactor: true,
    },
    "promo:claim": {
      rolesEnv: "PROMO_CLAIM_ROLES",
      userIdsEnv: "PROMO_CLAIM_USER_IDS",
      defaultRoles: [],
      requiresTwoFactor: true,
    },
    "revenue:view": {
      rolesEnv: "REVENUE_VIEW_ROLES",
      userIdsEnv: "REVENUE_VIEW_USER_IDS",
      defaultRoles: [],
      requiresTwoFactor: true,
    },
    // C-30A (施工工单_C30_换小说_移植CPS换租客_2026-09-08.md §4A.3): both
    // rebind capabilities default to `["super_admin"]` + `requiresTwoFactor:
    // true` — same tier as `content:publish`. CPS has no 2FA concept at all;
    // this repo's own capability table carries it, and a two-field atomic
    // Article rewrite is at least as sensitive as a publish transition.
    "content:rebind": {
      rolesEnv: "CONTENT_REBIND_ROLES",
      userIdsEnv: "CONTENT_REBIND_USER_IDS",
      defaultRoles: ["super_admin"],
      requiresTwoFactor: true,
    },
    "content:batch-rebind": {
      rolesEnv: "CONTENT_BATCH_REBIND_ROLES",
      userIdsEnv: "CONTENT_BATCH_REBIND_USER_IDS",
      defaultRoles: ["super_admin"],
      requiresTwoFactor: true,
    },
  });

function list(value: string | undefined): Set<string> {
  return new Set(
    String(value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export function hasAdminCapability(
  context: Pick<AdminAuthContext, "identity">,
  capability: AdminCapability,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const config = ADMIN_CAPABILITY_CONFIG[capability];
  const configuredRoles = list(env[config.rolesEnv]);
  const allowedRoles = configuredRoles.size > 0 ? configuredRoles : new Set(config.defaultRoles);
  const allowedUserIds = list(env[config.userIdsEnv]);
  return allowedRoles.has(context.identity.role) || allowedUserIds.has(context.identity.id);
}

export function requireAdminCapability(
  context: AdminAuthContext,
  capability: AdminCapability,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!hasAdminCapability(context, capability, env)) {
    throw new AdminAccessError(
      "admin_capability_denied",
      403,
      `Missing admin capability: ${capability}`,
      { capability },
    );
  }
}

/**
 * RC-10: `env`'s only effect here is `ADMIN_TWO_FACTOR_ENFORCEMENT` — see
 * `./two-factor-enforcement.ts`. When enforcement is `"disabled"` (local UAT
 * only — see that module's header), this returns immediately and treats
 * every session as already stepped up. When it is `"required"` (unset, or
 * any value other than the exact `"disabled"` — the fail-closed default),
 * behaviour is byte-for-byte what it was before RC-10.
 */
export function requireAdminTwoFactor(
  context: AdminAuthContext,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isTwoFactorEnforced(env)) return;
  if (!context.twoFactorCompleted) {
    throw new AdminAccessError(
      "admin_two_factor_required",
      403,
      "Completed two-factor authentication is required",
    );
  }
}

export function requireHighRiskAdminCapability(
  context: AdminAuthContext,
  capability: AdminCapability,
  env: NodeJS.ProcessEnv = process.env,
): void {
  requireAdminCapability(context, capability, env);
  requireAdminTwoFactor(context, env);
}
