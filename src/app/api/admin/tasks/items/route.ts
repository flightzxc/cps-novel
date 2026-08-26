import { listAdminTaskItems } from "@/server/task-admin";

import { prisma } from "../../_lib/deps";
import { guardRead } from "../../_lib/route";
import { handleTaskAdmin } from "../../_lib/task-admin-route";

export async function GET(request: Request) {
  return handleTaskAdmin(async () => {
    const context = await guardRead(request);
    const query = new URL(request.url).searchParams;
    return listAdminTaskItems(prisma, context, {
      family: query.get("family"),
      taskId: query.get("taskId"),
      status: query.get("status"),
      limit: query.get("limit"),
    });
  });
}
