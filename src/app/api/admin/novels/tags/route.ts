import {
  projectAdminNovelTagMutationResult,
  projectAdminNovelTags,
} from "@/contracts";
import {
  getAdminNovelTags,
  mutateAdminNovelTags,
} from "@/server/tagging/admin-service";

import { prisma } from "../../_lib/deps";
import { guardMutation, guardRead, serviceDependencies } from "../../_lib/route";
import { handle } from "../../_lib/respond";
import { novelTagGetInput, novelTagMutation } from "../../_lib/tagging-route";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handle(async () => {
    await guardRead(request);
    return projectAdminNovelTags(
      await getAdminNovelTags(prisma, novelTagGetInput(new URL(request.url))),
    );
  });
}

export async function PUT(request: Request) {
  return handle(async () => {
    const guarded = await guardMutation(request);
    const result = await mutateAdminNovelTags({
      authorization: guarded.authorization,
      entryId: "admin.api.novel_tag.write",
      mutation: novelTagMutation(guarded.body, guarded.requestId),
    }, serviceDependencies());
    return projectAdminNovelTagMutationResult(result);
  });
}
