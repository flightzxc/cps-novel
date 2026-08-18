/**
 * IndexNow key-verification file (Stream E, P2-11).
 *
 * Ported COPY_THEN_ADAPT from CPS `src/app/indexnow-key.txt/route.ts` (24
 * lines). `docs/governance/port-registry.md` has the symbol registration.
 * Despite the `.txt` directory name, this is a real dynamic Next.js route
 * (the directory name is what makes the served path literally
 * `/indexnow-key.txt`, matching IndexNow's key-verification protocol) — it
 * queries the database on every request, exactly like CPS's version
 * (`DECISION-CHECK.md` 核查2b confirms CPS never had a static-file/DB
 * "dual source" for this key; it was single-source all along).
 *
 * Reads through `getIndexNowDeliveryConfig` (the foundation's `SiteSetting`
 * accessor) rather than a bare `prisma.siteSetting.findFirst(...)` — see
 * `docs/p2/V020_FOUNDATION_INTERFACES.md` §6's mandatory calling convention.
 * Outside `resolveAdminRoute`'s registry by construction, the same way
 * `src/app/api/health/route.ts` is (`resolveAdminRoute` only ever matches
 * `/api/admin`).
 */
import { getIndexNowDeliveryConfig } from "@/server/site-settings/service";

import { prisma } from "../api/admin/_lib/deps";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(): Promise<Response> {
  const config = await getIndexNowDeliveryConfig(prisma, { ttlMs: 0 });
  const key = config.key.trim();
  if (!key) {
    return new Response("Not Found", { status: 404 });
  }
  return new Response(key, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
