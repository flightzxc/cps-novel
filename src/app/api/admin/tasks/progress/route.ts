import { projectErrorEnvelope } from "@/contracts";
import { isAdminAccessError } from "@/lib/auth/errors";
import { getAdminTaskProgress, TaskAdminError } from "@/server/task-admin";

import { prisma } from "../../_lib/deps";
import { guardRead } from "../../_lib/route";

export const dynamic = "force-dynamic";

/**
 * C-6: CPS-parity flat progress read (`GET /api/admin/tasks/progress?taskId=`).
 *
 * Deliberately does NOT go through `handleTaskAdmin`/`jsonOk` — every other
 * admin route in this app wraps its success body as `{ok:true,data:{...}}`,
 * but the ported `ImportProgress` component's `res.json()` expects the flat
 * CPS shape (`{taskType,status,total,...}`) directly, unchanged from the
 * reference implementation it was copied from. The error path still reuses
 * this app's normal envelope — the component only branches on `res.ok`, it
 * never parses the error body.
 */
export async function GET(request: Request) {
  try {
    const context = await guardRead(request);
    const query = new URL(request.url).searchParams;
    const data = await getAdminTaskProgress(prisma, context, {
      taskId: query.get("taskId"),
    });
    return Response.json(data, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    if (error instanceof TaskAdminError) {
      const envelope = projectErrorEnvelope({ code: error.code, status: error.status });
      return Response.json(envelope, { status: envelope.status });
    }
    if (isAdminAccessError(error)) {
      const envelope = projectErrorEnvelope({ code: error.code, status: error.status, details: error.details });
      return Response.json(envelope, { status: envelope.status });
    }
    const envelope = projectErrorEnvelope({ code: "task_admin_internal_error", status: 500 });
    return Response.json(envelope, { status: envelope.status });
  }
}
