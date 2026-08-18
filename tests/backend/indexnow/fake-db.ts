/**
 * TEST_ONLY — a minimal hand-rolled in-memory double for exactly the Prisma
 * call shapes `src/lib/indexnow/**` and `worker/handlers/indexnow-delivery.ts`
 * issue. Not a general query engine — each method pattern-matches the one
 * real call site's shape, following the same convention as
 * `tests/backend/publish-gate/fake-db.ts`. None of this Stream's code uses
 * `$transaction` (see the outbox/recovery/handler file headers for why —
 * plain sequential writes, not fenced), so this double does not implement one.
 */
import { Prisma, type PrismaClient } from "@prisma/client";

export type FakePromoLink = { status: string; webUrl: string | null; appUrl: string | null } | null;

export type FakeArticle = {
  id: string;
  novelId: string;
  locale: string;
  slug: string;
  publicPageShortId: string;
  status: string;
  updatedAt: Date;
  deletedAt: Date | null;
  novelStatus: string;
  promoLink: FakePromoLink;
};

export type FakeOutboxRow = {
  id: string;
  articleId: string | null;
  url: string;
  revision: bigint;
  eventType: string;
  locale: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: Date | null;
  availableAt: Date | null;
  lastHttpStatus: number | null;
  lastErrorKind: string | null;
  lastErrorSummary: string | null;
  lastRequestAt: Date | null;
  lastResponseAt: Date | null;
  deferReason: string | null;
  releasedAt: Date | null;
  releaseReason: string | null;
  releaseCommit: string;
  payloadHost: string;
  source: string;
  sourceTaskId: string | null;
  deliveryTaskId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type FakeAttempt = {
  id: bigint;
  outboxId: string;
  attemptNo: number;
  outcome: string;
  attemptState: string;
  requestBatchId: string;
  startedAt: Date;
  requestAt: Date;
  responseAt: Date | null;
  httpStatus: number | null;
  errorKind: string | null;
  responseSummary: string | null;
  batchSize: number;
  workerTaskId: string | null;
};

export type FakeGenericTaskItem = { id: string; taskId: string; targetType: string; targetId: string; status: string; payload: unknown };
export type FakeGenericTask = { id: string; taskType: string; status: string; operationScopeHash: string };

let nextId = 1;
function freshId(prefix: string): string {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

export type FakeSiteSetting = { indexNowHost: string; indexNowKey: string; indexNowKeyLocation: string; updatedAt: Date };

const DEFAULT_SITE_SETTING: FakeSiteSetting = {
  indexNowHost: "enpulsedrama.com",
  indexNowKey: "test-index-now-key",
  indexNowKeyLocation: "https://enpulsedrama.com/test-index-now-key.txt",
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

export class FakeIndexNowDb {
  readonly articles = new Map<string, FakeArticle>();
  readonly outbox = new Map<string, FakeOutboxRow>();
  readonly attempts = new Map<string, FakeAttempt>();
  readonly genericTasks = new Map<string, FakeGenericTask>();
  readonly genericTaskItems = new Map<string, FakeGenericTaskItem>();
  siteSettingRow: FakeSiteSetting | null = { ...DEFAULT_SITE_SETTING };
  private attemptSeq = 1;

  /** `null` simulates the (should-never-happen) missing-singleton fail-closed case; omit to keep the configured default. */
  seedSiteSetting(overrides: Partial<FakeSiteSetting> | null): this {
    this.siteSettingRow = overrides === null ? null : { ...DEFAULT_SITE_SETTING, ...overrides };
    return this;
  }

  seedArticle(article: Partial<FakeArticle> & { id: string }): this {
    this.articles.set(article.id, {
      novelId: article.novelId ?? "novel-1",
      locale: article.locale ?? "en",
      slug: article.slug ?? "slug",
      publicPageShortId: article.publicPageShortId ?? "shortid1",
      status: article.status ?? "published",
      updatedAt: article.updatedAt ?? new Date("2026-01-01T00:00:00.000Z"),
      deletedAt: article.deletedAt ?? null,
      novelStatus: article.novelStatus ?? "published",
      promoLink: article.promoLink === undefined ? { status: "fetched", webUrl: "https://example.com/w", appUrl: null } : article.promoLink,
      ...article,
    });
    return this;
  }

  seedOutbox(row: Partial<FakeOutboxRow> & { id: string; url: string; revision: bigint }): this {
    const now = row.createdAt ?? new Date();
    this.outbox.set(row.id, {
      articleId: null,
      eventType: "article_first_publish",
      locale: "en",
      status: "pending",
      attemptCount: 0,
      maxAttempts: 5,
      nextAttemptAt: null,
      availableAt: null,
      lastHttpStatus: null,
      lastErrorKind: null,
      lastErrorSummary: null,
      lastRequestAt: null,
      lastResponseAt: null,
      deferReason: null,
      releasedAt: null,
      releaseReason: null,
      releaseCommit: "",
      payloadHost: "",
      source: "test",
      sourceTaskId: null,
      deliveryTaskId: null,
      createdAt: now,
      updatedAt: now,
      ...row,
    });
    return this;
  }

  seedAttempt(attempt: Partial<FakeAttempt> & { outboxId: string; attemptNo: number }): FakeAttempt {
    const id = BigInt(this.attemptSeq++);
    const full: FakeAttempt = {
      outcome: "started",
      attemptState: "started",
      requestBatchId: `batch-${id}`,
      startedAt: attempt.startedAt ?? new Date(),
      requestAt: attempt.requestAt ?? new Date(),
      responseAt: attempt.responseAt ?? null,
      httpStatus: attempt.httpStatus ?? null,
      errorKind: attempt.errorKind ?? null,
      responseSummary: attempt.responseSummary ?? null,
      batchSize: attempt.batchSize ?? 1,
      workerTaskId: attempt.workerTaskId ?? null,
      ...attempt,
      id,
    };
    this.attempts.set(String(id), full);
    return full;
  }

  private article = {
    findFirst: async (args: { where: { id: string; deletedAt: null }; select: unknown }) => {
      const article = this.articles.get(args.where.id);
      if (!article || article.deletedAt !== null) return null;
      return {
        id: article.id,
        novelId: article.novelId,
        locale: article.locale,
        slug: article.slug,
        publicPageShortId: article.publicPageShortId,
        status: article.status,
        updatedAt: article.updatedAt,
        novel: { status: article.novelStatus },
        promoLink: article.promoLink,
      };
    },
    findMany: async (args: { where: { status: string; deletedAt: null }; orderBy?: unknown; take?: number; select: unknown }) => {
      const rows = [...this.articles.values()]
        .filter((a) => a.deletedAt === null && a.status === args.where.status)
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      const limited = args.take ? rows.slice(0, args.take) : rows;
      return limited.map((a) => ({ id: a.id }));
    },
  };

  private indexNowOutbox = {
    create: async (args: { data: Record<string, unknown>; select?: { id: true } }) => {
      const url = args.data.url as string;
      const revision = args.data.revision as bigint;
      const conflict = [...this.outbox.values()].some((row) => row.url === url && row.revision === revision);
      if (conflict) {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`url`,`revision`)", {
          code: "P2002",
          clientVersion: "test",
        });
      }
      const id = freshId("outbox");
      const now = new Date();
      this.seedOutbox({
        id,
        url,
        revision,
        articleId: (args.data.articleId as string) ?? null,
        eventType: (args.data.eventType as string) ?? "article_first_publish",
        locale: (args.data.locale as string) ?? "en",
        status: (args.data.status as string) ?? "pending",
        availableAt: (args.data.availableAt as Date | null) ?? null,
        deferReason: (args.data.deferReason as string | null) ?? null,
        source: (args.data.source as string) ?? "test",
        sourceTaskId: (args.data.sourceTaskId as string | null) ?? null,
        createdAt: now,
        updatedAt: now,
      });
      return { id };
    },
    findUnique: async (args: { where: { id: string }; select?: unknown }) => {
      const row = this.outbox.get(args.where.id);
      return row ? { ...row } : null;
    },
    findMany: async (args: {
      where: Record<string, unknown>;
      select?: { attempts?: unknown; articleId?: true; id?: true };
      orderBy?: unknown;
      take?: number;
    }) => {
      let rows = [...this.outbox.values()];
      const where = args.where;
      if (where.status && typeof where.status === "string") rows = rows.filter((r) => r.status === where.status);
      if (where.updatedAt && typeof where.updatedAt === "object") {
        const lt = (where.updatedAt as { lt?: Date }).lt;
        if (lt) rows = rows.filter((r) => r.updatedAt.getTime() < lt.getTime());
      }
      if (where.articleId && typeof where.articleId === "object" && "in" in (where.articleId as object)) {
        const ids = new Set((where.articleId as { in: string[] }).in);
        rows = rows.filter((r) => r.articleId !== null && ids.has(r.articleId));
      }
      if (where.OR && Array.isArray(where.OR)) {
        rows = rows.filter((r) =>
          (where.OR as Array<Record<string, unknown>>).some((clause) => {
            if (clause.status === "pending") {
              const avail = clause.OR as Array<Record<string, unknown>> | undefined;
              if (r.status !== "pending") return false;
              if (!avail) return true;
              return avail.some((sub) => {
                if ("availableAt" in sub && sub.availableAt === null) return r.availableAt === null;
                const lte = (sub.availableAt as { lte?: Date } | undefined)?.lte;
                return lte !== undefined && r.availableAt !== null && r.availableAt.getTime() <= lte.getTime();
              });
            }
            if (clause.status === "retry_wait") {
              if (r.status !== "retry_wait") return false;
              // Compare against the caller-supplied `lte` (the sweep's own
              // `now`), never a freshly-constructed wall-clock `Date` — the
              // whole point of this query is "due as of the caller's now",
              // which in a test is a fixed fixture date that may be far from
              // the real clock.
              const lte = (clause.nextAttemptAt as { lte?: Date } | undefined)?.lte;
              return lte !== undefined && r.nextAttemptAt !== null && r.nextAttemptAt.getTime() <= lte.getTime();
            }
            return false;
          }),
        );
      }
      rows.sort((a, b) => (a.id < b.id ? -1 : 1));
      const limited = args.take ? rows.slice(0, args.take) : rows;
      if (args.select?.attempts) {
        return limited.map((r) => ({
          id: r.id,
          attemptCount: r.attemptCount,
          maxAttempts: r.maxAttempts,
          attempts: [...this.attempts.values()]
            .filter((a) => a.outboxId === r.id)
            .sort((a, b) => b.attemptNo - a.attemptNo)
            .slice(0, 1),
        }));
      }
      if (args.select?.articleId) return limited.filter((r) => r.articleId !== null).map((r) => ({ articleId: r.articleId }));
      return limited.map((r) => ({ id: r.id }));
    },
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = this.outbox.get(args.where.id);
      if (!row) throw new Error(`outbox row ${args.where.id} not found`);
      Object.assign(row, args.data, { updatedAt: new Date() });
      return { ...row };
    },
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let rows = [...this.outbox.values()];
      const where = args.where;
      if (where.id && typeof where.id === "object" && "in" in (where.id as object)) {
        const ids = new Set((where.id as { in: string[] }).in);
        rows = rows.filter((r) => ids.has(r.id));
      }
      if (where.status) rows = rows.filter((r) => r.status === where.status);
      if ("deferReason" in where) {
        const clause = where.deferReason as { not?: null } | null;
        if (clause && "not" in clause) rows = rows.filter((r) => r.deferReason !== null);
      }
      if (where.availableAt && typeof where.availableAt === "object") {
        const gt = (where.availableAt as { gt?: Date }).gt;
        if (gt) rows = rows.filter((r) => r.availableAt !== null && r.availableAt.getTime() > gt.getTime());
      }
      for (const row of rows) Object.assign(row, args.data, { updatedAt: new Date() });
      return { count: rows.length };
    },
  };

  private indexNowOutboxAttempt = {
    create: async (args: { data: Record<string, unknown> }) => {
      const attempt = this.seedAttempt({
        outboxId: args.data.outboxId as string,
        attemptNo: args.data.attemptNo as number,
        outcome: args.data.outcome as string,
        attemptState: args.data.attemptState as string,
        requestBatchId: args.data.requestBatchId as string,
        startedAt: args.data.startedAt as Date,
        requestAt: args.data.requestAt as Date,
        batchSize: (args.data.batchSize as number) ?? 1,
        workerTaskId: (args.data.workerTaskId as string) ?? null,
      });
      return { ...attempt };
    },
    update: async (args: { where: { id: bigint }; data: Record<string, unknown> }) => {
      const attempt = this.attempts.get(String(args.where.id));
      if (!attempt) throw new Error(`attempt ${args.where.id} not found`);
      Object.assign(attempt, args.data);
      return { ...attempt };
    },
    updateMany: async (args: { where: { outboxId: string; attemptNo: number }; data: Record<string, unknown> }) => {
      const rows = [...this.attempts.values()].filter(
        (a) => a.outboxId === args.where.outboxId && a.attemptNo === args.where.attemptNo,
      );
      for (const row of rows) Object.assign(row, args.data);
      return { count: rows.length };
    },
  };

  private siteSetting = {
    findUnique: async (_args: { where: { id: 1 } }) => (this.siteSettingRow ? { ...this.siteSettingRow } : null),
  };

  private genericTask = {
    create: async (args: { data: Record<string, unknown> & { items?: { create?: Array<Record<string, unknown>> } } }) => {
      const id = freshId("task");
      this.genericTasks.set(id, {
        id,
        taskType: args.data.taskType as string,
        status: "pending",
        operationScopeHash: args.data.operationScopeHash as string,
      });
      for (const itemData of args.data.items?.create ?? []) {
        const itemId = freshId("item");
        this.genericTaskItems.set(itemId, {
          id: itemId,
          taskId: id,
          targetType: itemData.targetType as string,
          targetId: itemData.targetId as string,
          status: "pending",
          payload: itemData.payload,
        });
      }
      return { id };
    },
    count: async (args: { where: { id: { in: string[] }; status: string } }) => {
      const ids = new Set(args.where.id.in);
      return [...this.genericTasks.values()].filter((t) => ids.has(t.id) && t.status === args.where.status).length;
    },
  };

  private genericTaskItem = {
    findMany: async (args: { where: { targetType: string; targetId: { in: string[] }; status: { in: string[] } } }) => {
      const ids = new Set(args.where.targetId.in);
      const statuses = new Set(args.where.status.in);
      return [...this.genericTaskItems.values()]
        .filter((item) => item.targetType === args.where.targetType && ids.has(item.targetId) && statuses.has(item.status))
        .map((item) => ({ targetId: item.targetId }));
    },
  };

  asPrismaClient(): PrismaClient {
    return {
      article: this.article,
      indexNowOutbox: this.indexNowOutbox,
      indexNowOutboxAttempt: this.indexNowOutboxAttempt,
      genericTask: this.genericTask,
      genericTaskItem: this.genericTaskItem,
      siteSetting: this.siteSetting,
    } as unknown as PrismaClient;
  }
}

/**
 * `NodeJS.ProcessEnv` requires `NODE_ENV` in this project's `@types/node`
 * version — matches the pattern `tests/backend/credentials/web-ingress.test.ts`
 * already uses rather than an `as NodeJS.ProcessEnv` cast (which `tsc`
 * correctly refuses as an insufficient-overlap conversion).
 */
export function testEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...overrides };
}
