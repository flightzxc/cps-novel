import type { HealthReport } from "@/domain/health";
import { getHealthReport } from "@/server/health";

import { prisma } from "../admin/_lib/deps";

/**
 * Runtime health endpoint (P1-12).
 *
 * Unauthenticated by design: the compose healthcheck runs
 * `wget http://127.0.0.1:3000/api/health` from inside the container with no
 * session and no cookie jar. It stays outside the admin default-deny registry by
 * construction rather than by omission — `resolveAdminRoute` only ever matches
 * paths under `/api/admin`, so this path can never be registered there.
 *
 * The report itself is produced entirely by the frozen `@/server/health`
 * service. This handler owns exactly two decisions: the HTTP status and the
 * cache header.
 */

/** Node built-ins (`node:fs/promises`) and Prisma both rule out the Edge runtime. */
export const runtime = "nodejs";

/** A cached health report is a lie about the process that answered. */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  // The process-wide client, not a second one: a probe that opened its own pool
  // would be reporting on a connection the application never uses.
  const report: HealthReport = await getHealthReport(prisma);

  // `getHealthReport` does not throw for an expected failure — missing build
  // metadata, a stale env claim and an unreachable database all come back as a
  // populated `reasons` list on a well-formed report. There is therefore no
  // second failure shape to translate here, and no ad-hoc error body that could
  // carry a driver message or a stack out of the process.
  return Response.json(report, {
    status: report.ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
