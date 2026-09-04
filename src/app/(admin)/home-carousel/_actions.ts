"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireAdminActionAccess } from "@/server/auth/guards";
import { deleteHomeCarouselManualSlot, enqueueHomeCarouselCompute, updateHomeCarouselConfig, upsertHomeCarouselManualSlot } from "@/server/home-carousel";
import { canonicalOrigin, guardDependencies, prisma, readSessionToken } from "../../api/admin/_lib/deps";

async function auth(actionId: `admin.home_carousel.${string}`, requestId: string) {
  const requestHeaders = await headers();
  const result = await requireAdminActionAccess({ actionId, sessionToken: await readSessionToken(), origin: requestHeaders.get("origin"), canonicalOrigin: await canonicalOrigin(), requestId }, guardDependencies());
  if (!result.serviceAuthorization) throw new Error("authorization_required");
  return result.serviceAuthorization;
}
function deps() { const guards = guardDependencies(); return { db: prisma, identities: guards.identities, sessions: guards.sessions }; }
async function run<T>(fn: () => Promise<T>) { try { const data = await fn(); revalidatePath("/home-carousel"); revalidatePath("/"); return { ok: true as const, data }; } catch { return { ok: false as const, code: "home_carousel_write_failed" }; } }

export async function saveCarouselConfigAction(input: { requestId: string; cronSchedule: string; cronTimezone: string; cronEnabled: boolean }) {
  return run(async () => updateHomeCarouselConfig({ authorization: await auth("admin.home_carousel.config", input.requestId), ...input }, deps()));
}
export async function saveManualCarouselSlotAction(input: { requestId: string; id?: string; locale: string; position: number; articleId: string; enabled: boolean }) {
  return run(async () => upsertHomeCarouselManualSlot({ authorization: await auth("admin.home_carousel.manual_upsert", input.requestId), ...input }, deps()));
}
/** N-5: reuses the manual_upsert action id/capability — see deleteHomeCarouselManualSlot's doc comment. */
export async function deleteManualCarouselSlotAction(input: { requestId: string; id: string; locale: string }) {
  return run(async () => deleteHomeCarouselManualSlot({ authorization: await auth("admin.home_carousel.manual_upsert", input.requestId), ...input }, deps()));
}
export async function enqueueCarouselComputeAction(input: { requestId: string; locale: string }) {
  return run(async () => enqueueHomeCarouselCompute({ authorization: await auth("admin.home_carousel.compute", input.requestId), ...input }, deps()));
}
