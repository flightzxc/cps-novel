import { initializeMaterializedTaskTags } from "../../src/server/tagging/materialization";
import type { PrismaClient } from "@prisma/client";
import { NOVEL_MATERIALIZE_TASK_TYPE } from "../../src/lib/tasks/catalog-batch";
import { createHandlerRegistry, type TaskHandler } from "../../src/lib/tasks";
import { materializeNovelFromSourceItemInTransaction } from "../../src/server/content-creation";

type Payload = { novelSourceItemId: string; channelAppId: string; actorId: string; requestId: string; expiresAt: string };
type ParsedPayload =
  | { readonly kind: "legacy_template" }
  | { readonly kind: "ok"; readonly payload: Payload };
function parse(value: unknown): ParsedPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("novel_materialize_payload_invalid");
  const p = value as Partial<Payload> & { templateKey?: unknown };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!p.novelSourceItemId || !uuid.test(p.novelSourceItemId) || !p.channelAppId || !uuid.test(p.channelAppId) || !p.actorId || !p.requestId || !p.expiresAt
    || !Number.isFinite(Date.parse(p.expiresAt))) throw new Error("novel_materialize_payload_invalid");
  if ("templateKey" in p && p.templateKey) {
    return { kind: "legacy_template" };
  }
  return { kind: "ok", payload: p as Payload };
}

export function createNovelMaterializeHandler(db: PrismaClient): TaskHandler {
  void db;
  return async ({ lease }) => {
    const parsed = parse(lease.payload);
    if (parsed.kind === "legacy_template") {
      return {
        status: "failed",
        error: {
          code: "legacy_template_on_materialize",
          message: "novel.materialize.v1 不得携带 templateKey，请按新流程重新提交",
        },
      };
    }
    const payload = parsed.payload;
    if (Date.now() >= Date.parse(payload.expiresAt)) return { status: "skipped", result: { decision: "expired" } };
    return { status: "success", protectedWrite: async (tx) => {
      const result = await materializeNovelFromSourceItemInTransaction(tx, {
        novelSourceItemId: payload.novelSourceItemId,
        actor: { type: "admin", adminId: payload.actorId },
        requestId: payload.requestId,
      });
      if (result.outcome === "created") return { status: "success", result };
      if (result.outcome === "already_exists") return { status: "skipped", result };
      if (result.outcome === "concurrent_creation_conflict") throw new Error("novel_materialize_concurrent_conflict");
      return { status: "failed", error: { code: result.outcome, message: "Novel materialization was blocked by current source state" } };
    } };
  };
}

export function createNovelMaterializeWorkerHandlers(db: PrismaClient) {
  return createHandlerRegistry({ [NOVEL_MATERIALIZE_TASK_TYPE]: { family: "generic", maxAttempts: 3, handler: createNovelMaterializeHandler(db), afterItemCommit: (taskId) => initializeMaterializedTaskTags(db, taskId) } });
}
