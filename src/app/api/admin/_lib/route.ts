import type { AdminAuthContext } from "@/lib/auth/types";
import { requireAdminRouteAccess, type AdminServiceAuthorization } from "@/server/auth/guards";

import { guardDependencies, mutationRequestInput, prisma, readSessionToken } from "./deps";

export type ServiceDeps = ReturnType<typeof serviceDependencies>;

export function serviceDependencies() {
  const guards = guardDependencies();
  return { db: prisma, identities: guards.identities, sessions: guards.sessions };
}

/**
 * Read guard.
 *
 * `requireAdminRouteAccess` resolves the path against the registry first, so an
 * unregistered route 404s before any session lookup — default-deny is a property
 * of the registry, not of each handler remembering to check.
 */
export async function guardRead(request: Request): Promise<AdminAuthContext> {
  const { context } = await requireAdminRouteAccess(
    {
      pathname: new URL(request.url).pathname,
      method: request.method,
      sessionToken: await readSessionToken(),
    },
    guardDependencies(),
  );
  return context;
}

/**
 * Mutation guard.
 *
 * Returns the guard-issued authorization ticket plus the validated request id.
 * The ticket is not a substitute for authorisation: the mutation service calls
 * `requireFreshAdminServiceMutation`, which re-reads the session and re-checks
 * the capability before writing.
 */
export async function guardMutation(request: Request): Promise<{
  authorization: AdminServiceAuthorization;
  requestId: string;
  body: Record<string, unknown>;
}> {
  const input = await mutationRequestInput(request);
  const { serviceAuthorization } = await requireAdminRouteAccess(
    { pathname: new URL(request.url).pathname, method: request.method, ...input },
    guardDependencies(),
  );
  if (!serviceAuthorization) {
    // Only reachable if a route is registered without a capability; refuse
    // rather than run a privileged write on an unbound ticket.
    const { AdminAccessError } = await import("@/lib/auth/errors");
    throw new AdminAccessError(
      "admin_service_authorization_required",
      403,
      "Route is not bound to a capability",
    );
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  return { authorization: serviceAuthorization, requestId: serviceAuthorization.requestId, body };
}

export function text(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value : "";
}
