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
};

class FakeArticleGenerateDb {
  readonly tasks: TaskRow[] = [];
  creates = 0;

  asPrisma() {
    const findUnique = async (args: { where: { requestToken: string } }) =>
      this.tasks.find((task) => task.requestToken === args.where.requestToken) ?? null;
    const create = async (args: { data: { id: string; requestToken: string; params: Record<string, unknown> } }) => {
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
        status: "pending",
      });
      return args.data;
    };
    const db: {
      genericTask: { findUnique: typeof findUnique; create: typeof create };
      operationAudit: { create: () => Promise<unknown> };
      $transaction: <T>(run: (tx: unknown) => Promise<T>) => Promise<T>;
    } = {
      genericTask: { findUnique, create },
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
    expect(second).toEqual({ taskId: first.taskId, duplicate: true, taskStatus: "pending" });
    expect(db.creates).toBe(1);
  });

  it("rejects the same requestId with a different filter or template as request_replay_mismatch", async () => {
    const db = new FakeArticleGenerateDb();
    await enqueueArticleGenerateParentBatch(db.asPrisma(), {
      filter: { search: "old", locale: "en" },
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
      filter: { search: "old", locale: "en" },
      actorId: "admin-1",
      requestId: "req-parent",
      templateKeysByLocale: { ja: "ja-body" },
    })).rejects.toBeInstanceOf(ArticleGenerateInputError);
    expect(db.creates).toBe(1);
  });

  it("creates a new task when the requestId changes", async () => {
    const db = new FakeArticleGenerateDb();
    const first = await enqueueArticleGenerateParentBatch(db.asPrisma(), {
      filter: { locale: "en" },
      actorId: "admin-1",
      requestId: "req-1",
    });
    const second = await enqueueArticleGenerateParentBatch(db.asPrisma(), {
      filter: { locale: "en" },
      actorId: "admin-1",
      requestId: "req-2",
    });
    expect(second.duplicate).toBe(false);
    expect(second.taskId).not.toBe(first.taskId);
    expect(db.creates).toBe(2);
  });
});
