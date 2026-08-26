import { resolveManualReview } from "@/server/task-admin";

import { guardMutation, serviceDependencies, text } from "../../../_lib/route";
import { handleTaskAdmin } from "../../../_lib/task-admin-route";

export async function POST(request: Request) {
  return handleTaskAdmin(async () => {
    const { authorization, requestId, body } = await guardMutation(request);
    return resolveManualReview({
      authorization,
      requestId,
      intentId: body.intentId,
      resolution: body.resolution,
      reason: text(body, "reason"),
    }, serviceDependencies());
  });
}
