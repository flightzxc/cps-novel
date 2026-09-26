import { getAdminSitemapState, requestAdminSitemapRefresh } from "@/server/sitemap-admin/service";
import { prisma } from "../_lib/deps";
import { handle } from "../_lib/respond";
import { guardMutation, guardRead, serviceDependencies } from "../_lib/route";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return handle(async () => { await guardRead(request); return getAdminSitemapState(prisma); });
}
export async function POST(request: Request) {
  return handle(async () => {
    const guarded = await guardMutation(request);
    return requestAdminSitemapRefresh({ ...guarded, reason: guarded.body.reason }, serviceDependencies());
  });
}
