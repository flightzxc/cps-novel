import {
  projectAdminSourceLabelMapping,
  projectAdminSourceLabelMappingList,
  projectAdminTagMutationResult,
} from "@/contracts";
import {
  getAdminSourceLabelMapping,
  listAdminSourceLabelMappings,
  mutateAdminSourceLabelMapping,
} from "@/server/tagging/admin-service";

import { prisma } from "../_lib/deps";
import { guardMutation, guardRead, serviceDependencies } from "../_lib/route";
import { handle } from "../_lib/respond";
import { sourceLabelMappingGetInput, sourceLabelMappingMutation } from "../_lib/tagging-route";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handle(async () => {
    await guardRead(request);
    const input = sourceLabelMappingGetInput(new URL(request.url));
    return input.id !== undefined
      ? projectAdminSourceLabelMapping(await getAdminSourceLabelMapping(prisma, input.id))
      : projectAdminSourceLabelMappingList(await listAdminSourceLabelMappings(prisma, input));
  });
}

export async function PUT(request: Request) {
  return handle(async () => {
    const guarded = await guardMutation(request);
    const result = await mutateAdminSourceLabelMapping({
      authorization: guarded.authorization,
      entryId: "admin.api.tag_mapping.write",
      mutation: sourceLabelMappingMutation(guarded.body, guarded.requestId),
    }, serviceDependencies());
    return projectAdminTagMutationResult(result);
  });
}
