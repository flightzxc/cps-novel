import { AdminAccessError } from "./errors";
import type { AdminAuthContext } from "./types";

export type AdminCapability =
  | "credential:manage"
  | "content:takedown"
  | "promo:claim"
  | "revenue:view";

type CapabilityConfig = {
  rolesEnv: string;
  userIdsEnv: string;
  defaultRoles: readonly string[];
  requiresTwoFactor: true;
};

export const ADMIN_CAPABILITY_CONFIG: Readonly<Record<AdminCapability, CapabilityConfig>> =
  Object.freeze({
    "credential:manage": {
      rolesEnv: "CREDENTIAL_MANAGE_ROLES",
      userIdsEnv: "CREDENTIAL_MANAGE_USER_IDS",
      defaultRoles: ["super_admin"],
      requiresTwoFactor: true,
    },
    "content:takedown": {
      rolesEnv: "CONTENT_TAKEDOWN_ROLES",
      userIdsEnv: "CONTENT_TAKEDOWN_USER_IDS",
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

export function requireAdminTwoFactor(context: AdminAuthContext): void {
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
  requireAdminTwoFactor(context);
}
