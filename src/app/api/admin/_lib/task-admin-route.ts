import { projectErrorEnvelope } from "@/contracts";
import { isAdminAccessError } from "@/lib/auth/errors";
import { TaskAdminError } from "@/server/task-admin";

import { jsonError, jsonOk } from "./respond";

/**
 * Task-admin-only boundary: stable 4xx codes and a distinct, detail-free 500.
 *
 * Both non-`AdminAccessError` branches project through
 * {@link projectErrorEnvelope} — the same frozen, validated shape every other
 * admin route produces — instead of hand-rolling `Response.json({ ok: false,
 * ... })`. The eight `task_admin_*` codes stay their own union members (not
 * collapsed into the generic `admin_internal_error` fallback in
 * `respond.ts`'s `toErrorEnvelope`) because "this task doesn't exist" and
 * "this task has an unresolved manual review" are different instructions to
 * an operator, and merging them back into one boundary would erase that.
 */
export async function handleTaskAdmin<T>(run: () => Promise<T>): Promise<Response> {
  try {
    return jsonOk(await run());
  } catch (error) {
    if (error instanceof TaskAdminError) {
      const envelope = projectErrorEnvelope({ code: error.code, status: error.status });
      return Response.json(envelope, { status: envelope.status });
    }
    if (isAdminAccessError(error)) return jsonError(error);
    const envelope = projectErrorEnvelope({ code: "task_admin_internal_error", status: 500 });
    return Response.json(envelope, { status: envelope.status });
  }
}
