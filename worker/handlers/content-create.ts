import type { PrismaClient } from "@prisma/client";
import { CONTENT_CREATE_TASK_TYPE } from "../../src/lib/tasks/catalog-batch";
import {
  LEGACY_CONTENT_CREATE_RETIRED_CODE,
  LEGACY_CONTENT_CREATE_RETIRED_MESSAGE,
} from "../../src/lib/tasks/legacy-content-create";
import { createHandlerRegistry, type TaskHandler } from "../../src/lib/tasks";

type Payload = { novelSourceItemId?: string; requestId?: string; expiresAt?: string };

function parse(value: unknown): Payload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Payload;
}

export function createContentCreateHandler(_db: PrismaClient): TaskHandler {
  void _db;
  return async ({ lease }) => {
    const payload = parse(lease.payload);
    return {
      status: "failed",
      error: {
        code: LEGACY_CONTENT_CREATE_RETIRED_CODE,
        message: LEGACY_CONTENT_CREATE_RETIRED_MESSAGE,
      },
      result: {
        decision: "legacy_protocol_retired",
        novelSourceItemId: payload.novelSourceItemId ?? null,
        requestId: payload.requestId ?? null,
        expiresAt: payload.expiresAt ?? null,
      },
    };
  };
}

export function createContentCreateWorkerHandlers(db: PrismaClient) {
  return createHandlerRegistry({
    [CONTENT_CREATE_TASK_TYPE]: { family: "generic", maxAttempts: 1, handler: createContentCreateHandler(db) },
  });
}
