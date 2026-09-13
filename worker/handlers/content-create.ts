import type { PrismaClient } from "@prisma/client";
import { CONTENT_CREATE_TASK_TYPE } from "../../src/lib/tasks/catalog-batch";
import { createHandlerRegistry, type TaskHandler } from "../../src/lib/tasks";
import { enqueueMoboreaderPreviewRefreshTask } from "../../src/lib/tasks/moboreader";
import { createContentFromSourceItemInTransaction, resolveContentPreviewAccount } from "../../src/server/content-creation";

type Payload = { novelSourceItemId: string; channelAppId: string; actorId: string; requestId: string; expiresAt: string; templateKey?: string };
function parse(value: unknown): Payload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("content_create_payload_invalid");
  const p = value as Partial<Payload>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!p.novelSourceItemId || !uuid.test(p.novelSourceItemId) || !p.channelAppId || !uuid.test(p.channelAppId) || !p.actorId || !p.requestId || !p.expiresAt
    || !Number.isFinite(Date.parse(p.expiresAt))) throw new Error("content_create_payload_invalid");
  return p as Payload;
}

export function createContentCreateHandler(db: PrismaClient): TaskHandler {
  void db;
  return async ({ lease }) => {
    const payload = parse(lease.payload);
    if (Date.now() >= Date.parse(payload.expiresAt)) return { status: "skipped", result: { decision: "expired" } };
    return { status: "success", protectedWrite: async (tx) => {
      const result = await createContentFromSourceItemInTransaction(tx, {
        novelSourceItemId: payload.novelSourceItemId,
        actor: { type: "admin", adminId: payload.actorId }, requestId: payload.requestId,
        ...(payload.templateKey ? { templateKey: payload.templateKey } : {}),
      });
      if (result.outcome === "created") {
        const accountId = await resolveContentPreviewAccount(tx, payload.channelAppId);
        const preview = accountId ? await enqueueMoboreaderPreviewRefreshTask(tx, {
          trigger: "auto", channelAccountId: accountId, channelAppId: payload.channelAppId,
          novelSourceItemIds: [payload.novelSourceItemId],
          requestToken: `content_preview:${lease.itemId}`, actorId: payload.actorId,
          requestId: payload.requestId, mode: "apply",
        }) : { queued: false as const, reason: "no_channel_account" as const };
        return { status: "success", result: { ...result, previewEnqueue: preview } };
      }
      if (result.outcome === "already_exists") return { status: "skipped", result };
      if (result.outcome === "concurrent_creation_conflict") throw new Error("content_create_concurrent_conflict");
      return { status: "failed", error: { code: result.outcome, message: "Content creation was blocked by current source or template state" } };
    } };
  };
}

export function createContentCreateWorkerHandlers(db: PrismaClient) {
  return createHandlerRegistry({ [CONTENT_CREATE_TASK_TYPE]: { family: "generic", maxAttempts: 3, handler: createContentCreateHandler(db) } });
}
