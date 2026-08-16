import {
  projectAdminCanonicalTagDetail,
  projectAdminCanonicalTagList,
  projectAdminTagMutationResult,
} from "@/contracts";
import {
  getAdminCanonicalTag,
  listAdminCanonicalTags,
  mutateAdminCanonicalTag,
} from "@/server/tagging/admin-service";

import { prisma } from "../_lib/deps";
import { guardMutation, guardRead, serviceDependencies } from "../_lib/route";
import { handle } from "../_lib/respond";
import { canonicalTagGetInput, canonicalTagMutation } from "../_lib/tagging-route";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handle(async () => {
    await guardRead(request);
    const input = canonicalTagGetInput(new URL(request.url));
    return input.id !== undefined
      ? projectAdminCanonicalTagDetail(await getAdminCanonicalTag(prisma, input.id))
      : projectAdminCanonicalTagList(await listAdminCanonicalTags(prisma, input));
  });
}

export async function PUT(request: Request) {
  return handle(async () => {
    const guarded = await guardMutation(request);
    const result = await mutateAdminCanonicalTag({
      authorization: guarded.authorization,
      entryId: "admin.api.canonical_tag.write",
      mutation: canonicalTagMutation(guarded.body, guarded.requestId),
    }, serviceDependencies());
    return projectAdminTagMutationResult(result);
  });
}
