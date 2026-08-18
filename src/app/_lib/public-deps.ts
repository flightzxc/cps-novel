import { PrismaClient } from "@prisma/client";

/**
 * Public-site Prisma accessor.
 *
 * Must not import `@/app/api/admin/_lib/deps` — that module pulls cookies /
 * session into the public render path. Reuse the same `globalThis.adminPrisma`
 * key as the admin deps file so both surfaces share one connection pool.
 */
const globalForPrisma = globalThis as unknown as { adminPrisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.adminPrisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.adminPrisma = prisma;
