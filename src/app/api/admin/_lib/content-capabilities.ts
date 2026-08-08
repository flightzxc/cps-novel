import type { ContentReadCapability } from "@/contracts";
import { AdminAccessError } from "@/lib/auth/errors";
import type { AdminAuthContext } from "@/lib/auth/types";

/**
 * Read capabilities for the content-management surface (P2-04).
 *
 * ## Why these are not `AdminCapability`
 *
 * `src/lib/auth/capabilities.ts` types every entry as `requiresTwoFactor: true`,
 * and `enforceCapability` in `src/server/auth/guards.ts` acts on that: binding a
 * capability to a route makes the guard call `requireAdminTwoFactor`
 * unconditionally. That is correct for the four capabilities that exist — all of
 * them gate writes or secrets.
 *
 * P2-04's brief is the opposite: browsing content metadata, and reading one
 * chapter body, must be gated by a capability but must **not** demand a fresh
 * 2FA step-up. Expressing that inside `AdminCapability` would mean changing the
 * shared config type and the guard's capability branch — Codex-owned kernel code
 * that every existing route depends on, changed to accommodate a read screen.
 *
 * So the read capabilities live here instead, in Claude-owned route wiring, with
 * the same grant model (`*_ROLES` / `*_USER_IDS` env allowlists, deny by
 * default) minus the 2FA coupling. The kernel is untouched; see
 * `docs/p2/P2_04_ADMIN_CONTENT_UI.md` for the note handed back to Codex.
 *
 * ## Default-deny
 *
 * `defaultRoles` is empty for both, matching `promo:claim` and `revenue:view`:
 * an unconfigured deployment grants nobody, and a typo in an env var fails
 * closed rather than open.
 */
export type { ContentReadCapability };

type ContentCapabilityConfig = {
  readonly rolesEnv: string;
  readonly userIdsEnv: string;
  readonly defaultRoles: readonly string[];
  /** Frozen `false`: these gate reads, and reads never demand a 2FA step-up. */
  readonly requiresTwoFactor: false;
};

export const CONTENT_READ_CAPABILITY_CONFIG: Readonly<
  Record<ContentReadCapability, ContentCapabilityConfig>
> = Object.freeze({
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
});

export const CONTENT_READ_CAPABILITIES = Object.freeze(
  Object.keys(CONTENT_READ_CAPABILITY_CONFIG) as ContentReadCapability[],
);

function list(value: string | undefined): Set<string> {
  return new Set(
    String(value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export function hasContentReadCapability(
  context: Pick<AdminAuthContext, "identity">,
  capability: ContentReadCapability,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const config = CONTENT_READ_CAPABILITY_CONFIG[capability];
  const configuredRoles = list(env[config.rolesEnv]);
  const allowedRoles = configuredRoles.size > 0 ? configuredRoles : new Set(config.defaultRoles);
  const allowedUserIds = list(env[config.userIdsEnv]);
  return allowedRoles.has(context.identity.role) || allowedUserIds.has(context.identity.id);
}

/**
 * Throws the same `admin_capability_denied` envelope the kernel throws, so the
 * browser branches on one code regardless of which capability family refused —
 * and `details.capability` still names the missing grant.
 *
 * Notably absent: any call to `requireAdminTwoFactor`. That omission is the
 * whole point of this module and is asserted by
 * `tests/ui/admin-content-registry.test.ts`.
 */
export function requireContentReadCapability(
  context: AdminAuthContext,
  capability: ContentReadCapability,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!hasContentReadCapability(context, capability, env)) {
    throw new AdminAccessError(
      "admin_capability_denied",
      403,
      `Missing admin capability: ${capability}`,
      { capability },
    );
  }
}
