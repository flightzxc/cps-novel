import { retryFailedTask } from "@/server/task-admin";

import { guardMutation, serviceDependencies } from "../../_lib/route";
import { handleTaskAdmin } from "../../_lib/task-admin-route";

export async function POST(request: Request) {
  return handleTaskAdmin(async () => {
    const { authorization, requestId, body } = await guardMutation(request);
    return retryFailedTask({
      authorization,
      requestId,
      family: body.family,
      taskId: body.taskId,
      reason: body.reason,
    }, serviceDependencies());
  });
}
