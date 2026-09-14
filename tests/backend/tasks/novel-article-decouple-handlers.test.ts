import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { CATALOG_BATCH_TASK_TYPE } from "@/lib/tasks/catalog-batch";
import {
  LEGACY_CONTENT_CREATE_RETIRED_CODE,
  LEGACY_CONTENT_CREATE_RETIRED_MESSAGE,
} from "@/lib/tasks/legacy-content-create";

import { ARTICLE_GENERATE_BATCH_TASK_TYPE, ARTICLE_GENERATE_LEAF_MAX, ARTICLE_GENERATE_TASK_TYPE } from "@/lib/tasks/article-generate";

import { createArticleGenerateBatchHandler } from "../../../worker/handlers/article-generate-batch";
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

describe("article.generate.batch.v1 handler (EXT-06)", () => {
  it("splits 201 eligible novels into leaves of at most 200", async () => {
    const novels = Array.from({ length: 201 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    }));
    const created: Array<{ data: { taskType: string; parentTaskId?: string; items: { create: unknown[] } } }> = [];
    const updates: Array<{ data: { result?: { submittedCount?: number; childTaskCount?: number } } }> = [];
    const handler = createArticleGenerateBatchHandler({} as PrismaClient);
    const prepared = await handler(
      lease(ARTICLE_GENERATE_BATCH_TASK_TYPE, {
        filter: { search: "old" },
        actorId: "admin-1",
        requestId: "req-parent",
        submittedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    expect(prepared.status).toBe("success");
    if (prepared.status !== "success" || !("protectedWrite" in prepared) || !prepared.protectedWrite) {
      throw new Error("expected protectedWrite");
    }
    const written = await prepared.protectedWrite({
      novel: {
        findMany: async (args: { take: number; where?: { id?: { gt?: string } } }) => {
          const after = args.where?.id?.gt;
          const start = after ? novels.findIndex((row) => row.id === after) + 1 : 0;
          return novels.slice(start, start + args.take);
        },
      },
      genericTask: {
        create: async (args: { data: { taskType: string; parentTaskId?: string; items: { create: unknown[] } } }) => {
          created.push(args);
        },
        update: async (args: { data: { result?: { submittedCount?: number; childTaskCount?: number } } }) => {
          updates.push(args);
        },
      },
      operationAudit: { create: async () => ({}) },
    } as never);

    expect(written).toMatchObject({
      status: "success",
      result: { enumerationStatus: "completed", submittedCount: 201, childTaskCount: 2 },
    });
    expect(created).toHaveLength(2);
    expect(created.every((row) => row.data.taskType === ARTICLE_GENERATE_TASK_TYPE)).toBe(true);
    expect(created.every((row) => row.data.parentTaskId === "task-1")).toBe(true);
    expect(created[0]!.data.items.create).toHaveLength(ARTICLE_GENERATE_LEAF_MAX);
    expect(created[1]!.data.items.create).toHaveLength(1);
    expect(created[0]!.data.items.create.length).toBeLessThanOrEqual(ARTICLE_GENERATE_LEAF_MAX);
    expect(created[1]!.data.items.create.length).toBeLessThanOrEqual(ARTICLE_GENERATE_LEAF_MAX);
    expect(updates.at(-1)?.data.result).toMatchObject({ submittedCount: 201, childTaskCount: 2 });
  });
});

describe("novel.materialize.v1 payload", () => {
  it("rejects leftover templateKey instead of silently ignoring it", async () => {
    const outcome = await createNovelMaterializeHandler({} as PrismaClient)(
      lease("novel.materialize.v1", {
        novelSourceItemId: UUID,
        channelAppId: UUID,
        actorId: "admin-1",
        requestId: "req-1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        templateKey: "system-default-v1",
      }),
    );
    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "legacy_template_on_materialize" },
    });
  });
});
