import { projectCredentialTaskStatus } from "@/contracts";
import { getCredentialTaskResult } from "@/server/credentials/service";

import { prisma } from "../../_lib/deps";
import { handle } from "../../_lib/respond";
import { guardRead } from "../../_lib/route";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handle(async () => {
    await guardRead(request);
    const taskId = new URL(request.url).searchParams.get("taskId") ?? "";
    const task = await getCredentialTaskResult(prisma, taskId);
    return projectCredentialTaskStatus({
      taskId,
      status: task.state,
      result: task.result,
      error: task.error,
    });
  });
}
