import { describe, expect, it } from "vitest";

import {
  ArticleGenerateInputError,
  enqueueArticleGenerateBatch,
  enqueueArticleGenerateParentBatch,
} from "@/lib/tasks/article-generate";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";

type TaskRow = {
  id: string;
  requestToken: string;
  params: Record<string, unknown>;
  status: string;
  result?: unknown;
  data?: Record<string, unknown>;
};

class FakeArticleGenerateDb {
  readonly tasks: TaskRow[] = [];
  creates = 0;

  constructor(private readonly blockedIds = new Set<string>()) {}

  asPrisma() {
    const findUnique = async (args: { where: { requestToken: string } }) =>
      this.tasks.find((task) => task.requestToken === args.where.requestToken) ?? null;
    const create = async (args: { data: { id: string; requestToken: string; params: Record<string, unknown>; status?: string; result?: unknown } }) => {
      if (this.tasks.some((task) => task.requestToken === args.data.requestToken)) {
        const error = new Error("unique") as Error & { code: string };
        error.code = "P2002";
        throw error;
      }
      this.creates += 1;
      this.tasks.push({
        id: args.data.id,
        requestToken: args.data.requestToken,
        params: args.data.params,
        status: args.data.status ?? "pending",
        result: args.data.result,
        data: args.data as unknown as Record<string, unknown>,
      });
      return args.data;
    };
    const db: {
      genericTask: { findUnique: typeof findUnique; create: typeof create };
      novel: { findMany: (args: { where: { id: { in: string[] } } }) => Promise<unknown[]> };
      promoLink: { findMany: (args: { where: { novelId: { in: string[] } } }) => Promise<unknown[]>; groupBy: () => Promise<unknown[]>; count: () => Promise<number> };
      operationAudit: { create: () => Promise<unknown> };
      $transaction: <T>(run: (tx: unknown) => Promise<T>) => Promise<T>;
    } = {
      genericTask: { findUnique, create },
      novel: {
        findMany: async ({ where }) => where.id.in.map((id) => ({
          id,
          title: id,
          locale: "en",
          businessId: id,
          deletedAt: null,
          articles: [],
        })),
      },
      promoLink: {
        findMany: async ({ where }) => where.novelId.in
          .filter((id) => !this.blockedIds.has(id))
          .map((novelId) => ({
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
      operationAudit: { create: async () => ({}) },
      $transaction: async (run) => run(db),
    };
    return db as never;
  }
}

describe("article generate factory fingerprint / replay (R2-03)", () => {
  it("replays the same requestId + payload as a duplicate", async () => {
    const db = new FakeArticleGenerateDb();
    const input = {
      novelIds: [ID_B, ID_A],
      actorId: "admin-1",
      requestId: "req-same",
      templateKeysByLocale: { en: "en-default" },
    };
    const first = await enqueueArticleGenerateBatch(db.asPrisma(), input);
    const second = await enqueueArticleGenerateBatch(db.asPrisma(), input);
    expect(first.duplicate).toBe(false);
    expect(second).toMatchObject({ taskId: first.taskId, duplicate: true, taskStatus: "pending" });
    expect(second.admission).toEqual({ selectedCount: 2, submittedCount: 2, blockedCount: 0, blockedReasonCounts: {} });
    expect(db.creates).toBe(1);
  });

  it("submits only ready explicit ids and records admission blockers", async () => {
    const db = new FakeArticleGenerateDb(new Set([ID_B]));
    const result = await enqueueArticleGenerateBatch(db.asPrisma(), {
      novelIds: [ID_A, ID_B], actorId: "admin-1", requestId: "req-mixed",
    });
    expect(result.admission).toEqual({
      selectedCount: 2,
      submittedCount: 1,
      blockedCount: 1,
      blockedReasonCounts: { promo_link_missing: 1 },
    });
    const data = db.tasks[0]!.data as { totalCount: number; result: unknown; items: { create: unknown[] } };
    expect(data.totalCount).toBe(1);
    expect(data.items.create).toHaveLength(1);
    expect(data.result).toMatchObject({ submittedCount: 1, blockedCount: 1 });
  });

  it("creates a zero-item completed_with_errors audit task when all explicit ids are blocked", async () => {
    const db = new FakeArticleGenerateDb(new Set([ID_A, ID_B]));
    const result = await enqueueArticleGenerateBatch(db.asPrisma(), {
      novelIds: [ID_A, ID_B], actorId: "admin-1", requestId: "req-blocked",
    });
    expect(result).toMatchObject({
      taskStatus: "completed_with_errors",
      admission: { selectedCount: 2, submittedCount: 0, blockedCount: 2 },
    });
    expect(db.tasks[0]!.status).toBe("completed_with_errors");
    expect(db.tasks[0]!.data).not.toHaveProperty("items");
  });

  it("rejects the same requestId with a different filter or template as request_replay_mismatch", async () => {
    const db = new FakeArticleGenerateDb();
    await enqueueArticleGenerateParentBatch(db.asPrisma(), {
      filter: { search: "old", locales: ["en"] },
      actorId: "admin-1",
      requestId: "req-parent",
      templateKeysByLocale: { en: "en-default" },
    });
    await expect(enqueueArticleGenerateParentBatch(db.asPrisma(), {
      filter: {},
      actorId: "admin-1",
      requestId: "req-parent",
      templateKeysByLocale: { en: "en-default" },
    })).rejects.toMatchObject({ name: "ArticleGenerateInputError", code: "request_replay_mismatch" });
    await expect(enqueueArticleGenerateParentBatch(db.asPrisma(), {
      filter: { search: "old", locales: ["en"] },
      actorId: "admin-1",
      requestId: "req-parent",
      templateKeysByLocale: { ja: "ja-body" },
    })).rejects.toBeInstanceOf(ArticleGenerateInputError);
    expect(db.creates).toBe(1);
  });

  it("treats differently-ordered locales as the same replay (fingerprint is order-independent)", async () => {
    const db = new FakeArticleGenerateDb();
    const first = await enqueueArticleGenerateParentBatch(db.asPrisma(), {
      filter: { locales: ["ja", "en"] },
      actorId: "admin-1",
      requestId: "req-same-locales",
    });
    const second = await enqueueArticleGenerateParentBatch(db.asPrisma(), {
      filter: { locales: ["en", "ja"] },
      actorId: "admin-1",
      requestId: "req-same-locales",
    });
    expect(second).toMatchObject({ taskId: first.taskId, duplicate: true });
    expect(db.creates).toBe(1);
  });

  it("creates a new task when the requestId changes", async () => {
    const db = new FakeArticleGenerateDb();
    const first = await enqueueArticleGenerateParentBatch(db.asPrisma(), {
      filter: { locales: ["en"] },
      actorId: "admin-1",
      requestId: "req-1",
    });
    const second = await enqueueArticleGenerateParentBatch(db.asPrisma(), {
      filter: { locales: ["en"] },
      actorId: "admin-1",
      requestId: "req-2",
    });
    expect(second.duplicate).toBe(false);
    expect(second.taskId).not.toBe(first.taskId);
    expect(db.creates).toBe(2);
  });

  it("enqueues new parent batches under the v2 task type", async () => {
    const db = new FakeArticleGenerateDb();
    await enqueueArticleGenerateParentBatch(db.asPrisma(), {
      filter: { locales: ["en"] },
      actorId: "admin-1",
      requestId: "req-v2",
    });
    expect(db.tasks[0]!.data).toMatchObject({ taskType: "article.generate.batch.v2" });
  });
});
