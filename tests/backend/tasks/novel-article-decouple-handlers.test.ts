import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { CATALOG_BATCH_TASK_TYPE } from "@/lib/tasks/catalog-batch";
import {
  LEGACY_CONTENT_CREATE_RETIRED_CODE,
  LEGACY_CONTENT_CREATE_RETIRED_MESSAGE,
} from "@/lib/tasks/legacy-content-create";

import {
  ARTICLE_GENERATE_BATCH_TASK_TYPE,
  ARTICLE_GENERATE_BATCH_TASK_TYPE_V2,
  ARTICLE_GENERATE_LEAF_MAX,
  ARTICLE_GENERATE_TASK_TYPE,
} from "@/lib/tasks/article-generate";

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

describe("catalog-batch locale policy payload", () => {
  const payload = {
    operation: "novel_materialize",
    selection: { scope: "explicit_ids", ids: [UUID] },
    actorId: "admin-1",
    requestId: "req-1",
    submittedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  } as const;

  it.each([0, 3, "2", null])("rejects invalid policy version %p", async (enumEligibilityPolicyVersion) => {
    await expect(createCatalogBatchHandler({} as PrismaClient)(
      lease(CATALOG_BATCH_TASK_TYPE, { ...payload, enumEligibilityPolicyVersion }),
    )).rejects.toThrow("catalog_batch_payload_invalid");
  });

  it("rejects v2 on a non-materialization operation", async () => {
    await expect(createCatalogBatchHandler({} as PrismaClient)(
      lease(CATALOG_BATCH_TASK_TYPE, {
        ...payload,
        operation: "promo_claim",
        channelAccounts: {},
        enumEligibilityPolicyVersion: 2,
      }),
    )).rejects.toThrow("catalog_batch_payload_invalid");
  });
});

describe("article.generate.batch.v1 handler (EXT-06)", () => {
  it("splits 201 eligible novels into leaves of at most 200", async () => {
    const novels = Array.from({ length: 201 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      title: `Novel ${index + 1}`,
      locale: "en",
      businessId: `biz-${index + 1}`,
      deletedAt: null,
      articles: [],
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
      promoLink: {
        findMany: async (args: { where: { novelId: { in: string[] } } }) => args.where.novelId.in.map((novelId) => ({
          id: `promo-${novelId}`,
          novelId,
          status: "fetched",
          webUrl: "https://example.test/promo",
          appUrl: null,
          fetchedAt: new Date(),
          publicRedirectCode: novelId.slice(-8),
        })),
        groupBy: async () => [],
        count: async () => 0,
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

  it("records all-filtered promo blockers without creating doomed children", async () => {
    const row = {
      id: UUID, title: "Blocked", locale: "en", businessId: "blocked", deletedAt: null, articles: [],
    };
    const created: unknown[] = [];
    const updates: Array<{ data: { result?: Record<string, unknown> } }> = [];
    const prepared = await createArticleGenerateBatchHandler({} as PrismaClient)(lease(
      ARTICLE_GENERATE_BATCH_TASK_TYPE,
      {
        filter: {}, actorId: "admin-1", requestId: "req-blocked-parent",
        submittedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ));
    if (prepared.status !== "success" || !("protectedWrite" in prepared) || !prepared.protectedWrite) {
      throw new Error("expected protectedWrite");
    }
    const written = await prepared.protectedWrite({
      novel: { findMany: async (args: { where?: { id?: { gt?: string } } }) => args.where?.id?.gt ? [] : [row] },
      promoLink: { findMany: async () => [], groupBy: async () => [], count: async () => 0 },
      genericTask: {
        create: async (args: unknown) => { created.push(args); },
        update: async (args: { data: { result?: Record<string, unknown> } }) => { updates.push(args); },
      },
      operationAudit: { create: async () => ({}) },
    } as never);
    expect(created).toHaveLength(0);
    expect(written).toMatchObject({
      status: "success",
      result: {
        selectedCount: 1,
        submittedCount: 0,
        blockedCount: 1,
        blockedReasonCounts: { promo_link_missing: 1 },
        childTaskCount: 0,
      },
    });
    expect(updates.at(-1)?.data.result).toMatchObject({ blockedReasonCounts: { promo_link_missing: 1 } });
  });

  it("rejects a v1 payload whose filter carries a new-shape key (locales) instead of silently ignoring it", async () => {
    const outcome = await createArticleGenerateBatchHandler({} as PrismaClient)(lease(
      ARTICLE_GENERATE_BATCH_TASK_TYPE,
      {
        // A v2-shaped filter reaching the v1 task type — e.g. a stale
        // enqueue path, or a hand-edited row. If this were silently
        // coerced through the legacy `{search?, locale?}` reader, `locales`
        // would be dropped and the worker would enumerate with NO locale
        // constraint at all — the exact scope-widening bug this rejection
        // exists to prevent.
        filter: { locales: ["en"] },
        actorId: "admin-1",
        requestId: "req-v1-new-shape",
        submittedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ));
    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "article_generate_batch_v1_filter_unsupported" },
    });
    // Terminal on the first attempt, not thrown — never burns through
    // maxAttempts retrying something that can never succeed (same shape as
    // `legacy_template_on_materialize` below).
    expect("protectedWrite" in outcome).toBe(false);
  });

  it("still accepts the frozen legacy {search, locale} shape on v1 (no false-positive rejection)", async () => {
    const row = { id: UUID, title: "Legacy", locale: "ja", businessId: "legacy", deletedAt: null, articles: [] };
    const prepared = await createArticleGenerateBatchHandler({} as PrismaClient)(lease(
      ARTICLE_GENERATE_BATCH_TASK_TYPE,
      {
        filter: { search: "old", locale: "ja" },
        actorId: "admin-1",
        requestId: "req-v1-legacy-shape",
        submittedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ));
    expect(prepared.status).toBe("success");
    if (prepared.status !== "success" || !("protectedWrite" in prepared) || !prepared.protectedWrite) {
      throw new Error("expected protectedWrite");
    }
    const written = await prepared.protectedWrite({
      novel: { findMany: async (args: { where: Record<string, unknown> }) => {
        const localeIn = (args.where.locale as { in?: string[] } | undefined)?.in;
        return localeIn?.includes(row.locale) ? [row] : [];
      } },
      promoLink: { findMany: async () => [{
        id: "promo-1", novelId: row.id, status: "fetched", webUrl: "https://example.test/ready",
        appUrl: null, fetchedAt: new Date(), publicRedirectCode: "ready",
      }], groupBy: async () => [], count: async () => 0 },
      genericTask: { create: async () => {}, update: async () => {} },
      operationAudit: { create: async () => ({}) },
    } as never);
    expect(written).toMatchObject({ status: "success", result: { submittedCount: 1 } });
  });

  it("v2 re-normalizes the persisted filter snapshot: sorts/dedupes locales and rejects blank ones before enumerating", async () => {
    const enRow = { id: UUID, title: "En", locale: "en", businessId: "en-biz", deletedAt: null, articles: [] };
    const jaRow = {
      id: "22222222-2222-4222-8222-222222222222", title: "Ja", locale: "ja", businessId: "ja-biz",
      deletedAt: null, articles: [],
    };
    const receivedWheres: unknown[] = [];
    const prepared = await createArticleGenerateBatchHandler({} as PrismaClient)(lease(
      ARTICLE_GENERATE_BATCH_TASK_TYPE_V2,
      {
        // Unsorted, padded, duplicated — exactly what a hand-edited or
        // future-shape row might carry. v2 re-runs the real normalizer
        // rather than trusting this verbatim.
        filter: { locales: [" ja ", "en", "en", "  "] },
        actorId: "admin-1",
        requestId: "req-v2-renormalize",
        submittedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ));
    expect(prepared.status).toBe("success");
    if (prepared.status !== "success" || !("protectedWrite" in prepared) || !prepared.protectedWrite) {
      throw new Error("expected protectedWrite");
    }
    await prepared.protectedWrite({
      novel: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          receivedWheres.push(args.where);
          const localeIn = (args.where.locale as { in?: string[] } | undefined)?.in;
          return [enRow, jaRow].filter((candidate) => localeIn?.includes(candidate.locale));
        },
      },
      promoLink: { findMany: async () => [], groupBy: async () => [], count: async () => 0 },
      genericTask: { create: async () => {}, update: async () => {} },
      operationAudit: { create: async () => ({}) },
    } as never);
    expect(receivedWheres[0]).toMatchObject({ locale: { in: ["en", "ja"] } });
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
