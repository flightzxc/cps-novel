import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { CATALOG_BATCH_TASK_TYPE } from "@/lib/tasks/catalog-batch";
import {
  LEGACY_CONTENT_CREATE_RETIRED_CODE,
  LEGACY_CONTENT_CREATE_RETIRED_MESSAGE,
} from "@/lib/tasks/legacy-content-create";

import { createCatalogBatchHandler } from "../../../worker/handlers/catalog-batch";
import { createContentCreateHandler } from "../../../worker/handlers/content-create";
import { createNovelMaterializeHandler } from "../../../worker/handlers/novel-materialize";

const UUID = "11111111-1111-4111-8111-111111111111";

function lease(taskType: string, payload: unknown, itemId = "item-1") {
  return {
    lease: {
      family: "generic" as const,
      taskType,
      taskId: "task-1",
      itemId,
      workerId: "worker-1",
      payload,
      attemptCount: 1,
      executionToken: "token-1",
      leaseEpoch: 1n,
      lockedUntil: new Date(Date.now() + 60_000),
      mode: "apply" as const,
    },
    mode: "apply" as const,
    signal: new AbortController().signal,
    heartbeat: async () => true,
  };
}

describe("legacy content.create.v1 (T22)", () => {
  it("fails closed without retrying or converting the payload", async () => {
    const outcome = await createContentCreateHandler({} as PrismaClient)(
      lease("content.create.v1", { novelSourceItemId: UUID, requestId: "req-1", expiresAt: new Date().toISOString() }),
    );
    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: LEGACY_CONTENT_CREATE_RETIRED_CODE, message: LEGACY_CONTENT_CREATE_RETIRED_MESSAGE },
      result: { decision: "legacy_protocol_retired", novelSourceItemId: UUID },
    });
  });
});

describe("catalog-batch parent content_create (T22)", () => {
  it("fails the parent without enumerating children", async () => {
    const updates: unknown[] = [];
    const handler = createCatalogBatchHandler({} as PrismaClient);
    const prepared = await handler(
      lease(CATALOG_BATCH_TASK_TYPE, {
        operation: "content_create",
        selection: { scope: "explicit_ids", ids: [UUID] },
        actorId: "admin-1",
        requestId: "req-1",
        submittedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        templateKeysByLocale: { en: "system-default-v1" },
      }),
    );
    expect(prepared.status).toBe("success");
    if (prepared.status !== "success" || !("protectedWrite" in prepared) || !prepared.protectedWrite) {
      throw new Error("expected protectedWrite");
    }
    const written = await prepared.protectedWrite({
      genericTask: {
        update: async (args: unknown) => {
          updates.push(args);
        },
      },
    } as never);
    expect(written).toMatchObject({
      status: "failed",
      error: { code: LEGACY_CONTENT_CREATE_RETIRED_CODE },
    });
    expect(updates).toHaveLength(1);
  });
});

describe("novel.materialize.v1 payload", () => {
  it("rejects leftover templateKey instead of silently ignoring it", async () => {
    await expect(
      createNovelMaterializeHandler({} as PrismaClient)(
        lease("novel.materialize.v1", {
          novelSourceItemId: UUID,
          channelAppId: UUID,
          actorId: "admin-1",
          requestId: "req-1",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          templateKey: "system-default-v1",
        }),
      ),
    ).rejects.toThrow(/novel_materialize_template_forbidden/);
  });
});
