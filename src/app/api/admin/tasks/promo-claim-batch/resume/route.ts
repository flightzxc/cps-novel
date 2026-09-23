import { resumePromoClaimBatch } from "@/server/task-admin";

import { guardMutation, serviceDependencies } from "../../../_lib/route";
import { handleTaskAdmin } from "../../../_lib/task-admin-route";

export async function POST(request: Request) {
  return handleTaskAdmin(async () => {
    const { authorization, requestId, body } = await guardMutation(request);
    return resumePromoClaimBatch({
      authorization,
      requestId,
      taskId: body.taskId,
    }, serviceDependencies());
  });
}
