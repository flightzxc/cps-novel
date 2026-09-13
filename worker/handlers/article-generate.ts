import type { PrismaClient } from "@prisma/client";
import { ARTICLE_GENERATE_TASK_TYPE } from "../../src/lib/tasks/article-generate";
import { createHandlerRegistry, type TaskHandler } from "../../src/lib/tasks";
import { generateArticleFromNovelInTransaction } from "../../src/server/content-creation";

type Payload = {
  novelId: string;
  actorId: string;
  requestId: string;
  expiresAt: string;
  templateKey?: string;
  templateKeysByLocale?: Readonly<Record<string, string>>;
};

function parse(value: unknown): Payload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("article_generate_payload_invalid");
  const p = value as Partial<Payload>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!p.novelId || !uuid.test(p.novelId) || !p.actorId || !p.requestId || !p.expiresAt
    || !Number.isFinite(Date.parse(p.expiresAt))) throw new Error("article_generate_payload_invalid");
  return p as Payload;
}

export function createArticleGenerateHandler(db: PrismaClient): TaskHandler {
  void db;
  return async ({ lease }) => {
    const payload = parse(lease.payload);
    if (Date.now() >= Date.parse(payload.expiresAt)) return { status: "skipped", result: { decision: "expired" } };
    return {
      status: "success",
      protectedWrite: async (tx) => {
        const novel = await tx.novel.findFirst({
          where: { id: payload.novelId, deletedAt: null },
          select: { locale: true },
        });
        const templateKey = payload.templateKey
          ?? (novel?.locale ? payload.templateKeysByLocale?.[novel.locale] : undefined);
        const result = await generateArticleFromNovelInTransaction(tx, {
          novelId: payload.novelId,
          actor: { type: "admin", adminId: payload.actorId },
          requestId: payload.requestId,
          ...(templateKey ? { templateKey } : {}),
        });
        if (result.outcome === "created") return { status: "success", result };
        if (result.outcome === "already_exists") return { status: "skipped", result };
        if (result.outcome === "concurrent_generation_conflict") throw new Error("article_generate_concurrent_conflict");
        return { status: "failed", error: { code: result.outcome, message: "Article generation was blocked by current novel, promo, or template state" } };
      },
    };
  };
}

export function createArticleGenerateWorkerHandlers(db: PrismaClient) {
  return createHandlerRegistry({
    [ARTICLE_GENERATE_TASK_TYPE]: { family: "generic", maxAttempts: 3, handler: createArticleGenerateHandler(db) },
  });
}
