import { isAdminAccessError } from "@/lib/auth/errors";
import { TaskAdminError } from "@/server/task-admin";

import { jsonError, jsonOk } from "./respond";

/** Task-admin-only boundary: stable 4xx codes and a generic, detail-free 500. */
export async function handleTaskAdmin<T>(run: () => Promise<T>): Promise<Response> {
  try {
    return jsonOk(await run());
  } catch (error) {
    if (error instanceof TaskAdminError) {
      return Response.json(
        { ok: false, status: error.status, code: error.code },
        { status: error.status },
      );
    }
    if (isAdminAccessError(error)) return jsonError(error);
    return Response.json(
      { ok: false, status: 500, code: "task_admin_internal_error" },
      { status: 500 },
    );
  }
}
