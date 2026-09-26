import { PrismaClient } from "@prisma/client";

// Web-only pool: public rendering and admin wiring share this neutral module.
// Cache in production too, including separately loaded Next server bundles.
// Prisma continues to honor DATABASE_URL and its connection parameters.
const webGlobal = globalThis as unknown as { webPrisma?: PrismaClient };
export const prisma = webGlobal.webPrisma ?? new PrismaClient();
webGlobal.webPrisma = prisma;
