import {
  requireAdminCapability,
  requireAdminTwoFactor,
  type AdminCapability,
} from "@/lib/auth/capabilities";
import { AdminAccessError } from "@/lib/auth/errors";
import type { AdminIdentityStore, AdminRateLimitPort, SessionStore } from "@/lib/auth/ports";
import { requireAdminSession } from "@/lib/auth/session";
import type { AdminAuthContext } from "@/lib/auth/types";

import { requireMutationRequestId, requireSameOrigin } from "./origin";
import {
  DEFAULT_ADMIN_REGISTRY,
  resolveAdminAction,
  resolveAdminPage,
  resolveAdminRoute,
  type AdminRegistry,
} from "./registry";

type SessionDependencies = {
  identities: AdminIdentityStore;
  sessions: SessionStore;
  now?: Date;
};

type GuardDependencies = SessionDependencies & {
  registry?: AdminRegistry;
  env?: NodeJS.ProcessEnv;
  rateLimit?: AdminRateLimitPort;
};

const issuedAuthorizations = new WeakSet<object>();

export type AdminServiceAuthorization = {
  readonly context: AdminAuthContext;
  readonly capability: AdminCapability;
  readonly requestId: string;
  readonly entryId: string;
};

function issueAuthorization(
  context: AdminAuthContext,
  capability: AdminCapability,
  requestId: string,
  entryId: string,
): AdminServiceAuthorization {
  const ticket = Object.freeze({ context, capability, requestId, entryId });
  issuedAuthorizations.add(ticket);
  return ticket;
}

async function enforceRateLimit(
  port: AdminRateLimitPort | undefined,
  input: { scope: string; subject: string; requestId: string; now: Date },
): Promise<void> {
  if (!port) return;
  const decision = await port.consume(input);
  if (!decision.allowed) {
    throw new AdminAccessError("admin_rate_limited", 429, "Admin request rate limited", {
      retryAfterSeconds: String(decision.retryAfterSeconds ?? 1),
    });
  }
}

function enforceCapability(
  context: AdminAuthContext,
  capability: AdminCapability | undefined,
  env: NodeJS.ProcessEnv | undefined,
): void {
  if (!capability) return;
  requireAdminCapability(context, capability, env);
  requireAdminTwoFactor(context);
}

export async function requireAdminPageAccess(
  input: { pathname: string; sessionToken?: string | null },
  dependencies: GuardDependencies,
): Promise<AdminAuthContext> {
  if (!resolveAdminPage(input.pathname, dependencies.registry ?? DEFAULT_ADMIN_REGISTRY)) {
    throw new AdminAccessError("admin_route_not_registered", 404, "Admin page not registered");
  }
  return requireAdminSession(input.sessionToken, dependencies);
}

export async function requireAdminRouteAccess(
  input: {
    pathname: string;
    method: string;
    sessionToken?: string | null;
    origin?: string | null;
    canonicalOrigin?: string;
    requestId?: string | null;
  },
  dependencies: GuardDependencies,
): Promise<{ context: AdminAuthContext; serviceAuthorization?: AdminServiceAuthorization }> {
  const route = resolveAdminRoute(
    input.pathname,
    input.method,
    dependencies.registry ?? DEFAULT_ADMIN_REGISTRY,
  );
  if (!route) {
    throw new AdminAccessError("admin_route_not_registered", 404, "Admin API route not registered");
  }
  const context = await requireAdminSession(input.sessionToken, dependencies);
  enforceCapability(context, route.capability, dependencies.env);
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(input.method.toUpperCase());
  if (!mutation) return { context };
  requireSameOrigin(input.origin, input.canonicalOrigin ?? "");
  const requestId = requireMutationRequestId(input.requestId);
  await enforceRateLimit(dependencies.rateLimit, {
    scope: route.id,
    subject: context.identity.id,
    requestId,
    now: dependencies.now ?? new Date(),
  });
  return {
    context,
    serviceAuthorization: route.capability
      ? issueAuthorization(context, route.capability, requestId, route.id)
      : undefined,
  };
}

export async function requireAdminActionAccess(
  input: {
    actionId: string;
    sessionToken?: string | null;
    origin?: string | null;
    canonicalOrigin?: string;
    requestId?: string | null;
  },
  dependencies: GuardDependencies,
): Promise<{ context: AdminAuthContext; serviceAuthorization?: AdminServiceAuthorization }> {
  const action = resolveAdminAction(input.actionId, dependencies.registry ?? DEFAULT_ADMIN_REGISTRY);
  if (!action) {
    throw new AdminAccessError("admin_action_not_registered", 404, "Admin action not registered");
  }
  const context = await requireAdminSession(input.sessionToken, dependencies);
  enforceCapability(context, action.capability, dependencies.env);
  if (!action.mutation) return { context };
  requireSameOrigin(input.origin, input.canonicalOrigin ?? "");
  const requestId = requireMutationRequestId(input.requestId);
  await enforceRateLimit(dependencies.rateLimit, {
    scope: action.id,
    subject: context.identity.id,
    requestId,
    now: dependencies.now ?? new Date(),
  });
  return {
    context,
    serviceAuthorization: action.capability
      ? issueAuthorization(context, action.capability, requestId, action.id)
      : undefined,
  };
}

export function requireAdminServiceMutation(
  authorization: AdminServiceAuthorization | null | undefined,
  capability: AdminCapability,
  env: NodeJS.ProcessEnv = process.env,
): AdminAuthContext {
  if (!authorization || !issuedAuthorizations.has(authorization)) {
    throw new AdminAccessError(
      "admin_service_authorization_required",
      403,
      "A guard-issued service authorization is required",
    );
  }
  if (authorization.capability !== capability) {
    throw new AdminAccessError("admin_capability_denied", 403, `Missing admin capability: ${capability}`, {
      capability,
    });
  }
  requireAdminCapability(authorization.context, capability, env);
  requireAdminTwoFactor(authorization.context);
  return authorization.context;
}
