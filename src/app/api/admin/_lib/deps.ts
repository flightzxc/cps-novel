import { PrismaClient } from "@prisma/client";
import { cookies } from "next/headers";

import {
  PostgreSQLAdminIdentityStore,
  PostgreSQLSessionStore,
} from "@/lib/auth/postgres";
import { ADMIN_SESSION_COOKIE_NAME } from "@/server/auth/cookie-contract";
import { P1_08B_ADMIN_REGISTRY } from "@/server/credentials";

/**
 * Admin-side server wiring.
 *
 * Lives under `src/app/api/admin/_lib/` rather than `src/server/`: the `_`
 * prefix keeps it off the router, and P1-09's write boundary is `src/app/**`.
 * `src/server/**` stays Codex-owned.
 */
const globalForPrisma = globalThis as unknown as { adminPrisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.adminPrisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.adminPrisma = prisma;

export const ADMIN_REGISTRY = P1_08B_ADMIN_REGISTRY;

export function guardDependencies() {
  return {
    identities: new PostgreSQLAdminIdentityStore(prisma),
    sessions: new PostgreSQLSessionStore(prisma),
    registry: ADMIN_REGISTRY,
  };
}

export async function readSessionToken(): Promise<string | null> {
  return (await cookies()).get(ADMIN_SESSION_COOKIE_NAME)?.value ?? null;
}

/**
 * Canonical origin for the same-origin check.
 *
 * The configured value is mandatory in every environment. Returning an empty
 * value keeps mutations fail-closed in `requireSameOrigin`; request Host is
 * never trusted to define its own security boundary.
 */
export async function canonicalOrigin(): Promise<string> {
  return process.env.ADMIN_CANONICAL_ORIGIN?.trim() ?? "";
}

export async function mutationRequestInput(request: Request) {
  return {
    origin: request.headers.get("origin"),
    canonicalOrigin: await canonicalOrigin(),
    requestId: request.headers.get("x-request-id"),
    sessionToken: await readSessionToken(),
  };
}
