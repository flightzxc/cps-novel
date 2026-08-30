/**
 * TEST_ONLY — a minimal hand-rolled in-memory double for exactly the Prisma
 * call shapes `src/server/content-creation/{service,business-id}.ts` issue.
 * Modeled directly on `tests/backend/publish-gate/fake-db.ts`'s own header
 * comment: not a general query engine, `$transaction` gives real
 * rollback-on-throw via an undo log (not a whole-store snapshot, so
 * `onSourceItemRead`'s simulated concurrent commit survives this
 * transaction's own rollback — see that file's header for why a snapshot
 * would be wrong here too).
 */
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

export type FakeSourceItem = {
  id: string;
  novelId: string | null;
  status: string;
  title: string;
  description: string;
  coverUrl: string | null;
  totalChapterCount: number;
  paidFromChapter: number | null;
  splitRatio: Prisma.Decimal | null;
  deletedAt: Date | null;
};

export type FakeNovel = {
  id: string;
  businessId: string;
  title: string;
  description: string;
  coverUrl: string | null;
  locale: string;
  slug: string;
  totalChapterCount: number;
  paidFromChapter: number | null;
  splitRatio: Prisma.Decimal | null;
  deletedAt: Date | null;
};

export type FakeArticle = {
  id: string;
  novelId: string;
  locale: string;
  slug: string;
  publicPageShortId: string;
  title: string;
  summary: string | null;
  body: string;
  deletedAt: Date | null;
};

export type FakeAudit = {
  actorType: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  requestId: string;
  afterSnapshot?: unknown;
};

let idCounter = 0;
/** Business-string default (businessId/shortId fixtures) — not a UUID column, no shape requirement. */
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}
/** `id` columns are real `@db.Uuid` in the schema, and `requireUuid` in `service.ts` validates the top-level `novelSourceItemId` input against that shape — fixture ids must satisfy it too. */
function nextUuid(): string {
  return randomUUID();
}

function uniqueViolation(target: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`Unique constraint failed on the fields: (\`${target}\`)`, {
    code: "P2002",
    clientVersion: "test",
    meta: { target: [target] },
  });
}

export class FakeContentCreationDb {
  readonly sourceItems = new Map<string, FakeSourceItem>();
  readonly novels = new Map<string, FakeNovel>();
  readonly articles = new Map<string, FakeArticle>();
  readonly audits: FakeAudit[] = [];
  readonly calls: string[] = [];
  lastSourceItemFindFirstArgs: { where: { id: string }; select?: Record<string, boolean> } | null = null;

  /** How many consecutive `novel.create` calls should throw a `business_id` P2002 before succeeding. */
  novelBusinessIdFailuresRemaining = 0;
  /** How many consecutive `article.create` calls should throw a `public_page_short_id` P2002 before succeeding. */
  articleShortIdFailuresRemaining = 0;

  /** Raw `data` object from the most recent successful `article.create` call — lets a test assert on exactly which keys the service writes (e.g. that `status`/`promoLinkId` are never present at all), not just on the row this fake happens to construct from a subset of them. */
  lastArticleCreateArgs: Record<string, unknown> | null = null;
  lastNovelCreateArgs: Record<string, unknown> | null = null;

  /**
   * Fires exactly once, immediately after the primary `novelSourceItem.findFirst`
   * lookup inside a `$transaction` — then clears itself. Lets a test simulate
   * a concurrent transaction winning the creation race by mutating
   * `sourceItems` directly (as if another connection had already committed),
   * without any real concurrency. See `service.test.ts`'s concurrency test.
   */
  onSourceItemRead: (() => void) | null = null;

  private undoLog: Array<() => void> | null = null;
  private logUndo(undo: () => void): void {
    this.undoLog?.push(undo);
  }

  seedSourceItem(item: Partial<FakeSourceItem> & { id?: string }): FakeSourceItem {
    const full: FakeSourceItem = {
      id: item.id ?? nextUuid(),
      novelId: item.novelId ?? null,
      status: item.status ?? "pending",
      title: item.title ?? "A Sample Title",
      description: item.description ?? "A sample description.",
      coverUrl: item.coverUrl ?? null,
      totalChapterCount: item.totalChapterCount ?? 12,
      paidFromChapter: item.paidFromChapter ?? null,
      splitRatio: item.splitRatio ?? null,
      deletedAt: item.deletedAt ?? null,
    };
    this.sourceItems.set(full.id, full);
    return full;
  }

  seedNovel(novel: Partial<FakeNovel> & { id?: string }): FakeNovel {
    const full: FakeNovel = {
      id: novel.id ?? nextUuid(),
      businessId: novel.businessId ?? nextId("nv"),
      title: novel.title ?? "A Sample Title",
      description: novel.description ?? "A sample description.",
      coverUrl: novel.coverUrl ?? null,
      locale: novel.locale ?? "en",
      slug: novel.slug ?? "a-sample-title",
      totalChapterCount: novel.totalChapterCount ?? 12,
      paidFromChapter: novel.paidFromChapter ?? null,
      splitRatio: novel.splitRatio ?? null,
      deletedAt: novel.deletedAt ?? null,
    };
    this.novels.set(full.id, full);
    return full;
  }

  seedArticle(article: Partial<FakeArticle> & { id?: string; novelId: string }): FakeArticle {
    const full: FakeArticle = {
      id: article.id ?? nextUuid(),
      novelId: article.novelId,
      locale: article.locale ?? "en",
      slug: article.slug ?? "a-sample-title",
      publicPageShortId: article.publicPageShortId ?? nextId("short"),
      title: article.title ?? "A Sample Title",
      summary: article.summary ?? "A sample description.",
      body: article.body ?? "",
      deletedAt: article.deletedAt ?? null,
    };
    this.articles.set(full.id, full);
    return full;
  }

  private sourceItemFindFirst = async (args: {
    where: { id: string };
    select?: Record<string, boolean>;
  }) => {
    this.calls.push("novelSourceItem.findFirst");
    this.lastSourceItemFindFirstArgs = args;
    const stored = this.sourceItems.get(args.where.id) ?? null;
    // Snapshot *before* firing the hook — the hook simulates a different,
    // already-committed concurrent transaction mutating the same
    // underlying row object, and this transaction's read must observe the
    // state as of the moment of the read, not whatever the hook does to it
    // a tick later (a real Postgres READ COMMITTED snapshot would not see
    // it either, since the concurrent transaction's write happens after
    // this statement already returned).
    const snapshot = stored ? { ...stored } : null;
    if (this.onSourceItemRead) {
      const hook = this.onSourceItemRead;
      this.onSourceItemRead = null;
      hook();
    }
    return snapshot;
  };

  private novelFindFirst = async (args: {
    where: { id?: string; locale?: string; slug?: string; deletedAt?: null };
    select?: { id: true };
  }) => {
    this.calls.push("novel.findFirst");
    const { where } = args;
    if (where.id !== undefined) {
      const novel = this.novels.get(where.id);
      return novel ? { ...novel } : null;
    }
    for (const novel of this.novels.values()) {
      if (novel.deletedAt !== null) continue;
      if (novel.locale === where.locale && novel.slug === where.slug) {
        return args.select ? { id: novel.id } : { ...novel };
      }
    }
    return null;
  };

  private articleFindFirst = async (args: {
    where: { novelId?: string; locale?: string; slug?: string; deletedAt?: null };
    select?: { id: true };
  }) => {
    this.calls.push("article.findFirst");
    const { where } = args;
    if (where.slug !== undefined) {
      for (const article of this.articles.values()) {
        if (article.deletedAt !== null) continue;
        if (article.locale === where.locale && article.slug === where.slug) {
          return args.select ? { id: article.id } : { ...article };
        }
      }
      return null;
    }
    for (const article of this.articles.values()) {
      if (article.novelId === where.novelId && article.locale === where.locale) {
        return { ...article };
      }
    }
    return null;
  };

  private novelCreate = async (args: { data: Record<string, unknown> }) => {
    this.calls.push("novel.create");
    this.lastNovelCreateArgs = { ...args.data };
    if (this.novelBusinessIdFailuresRemaining > 0) {
      this.novelBusinessIdFailuresRemaining -= 1;
      throw uniqueViolation("novel_business_id_key");
    }
    const businessId = String(args.data.businessId);
    for (const existing of this.novels.values()) {
      if (existing.businessId === businessId) throw uniqueViolation("novel_business_id_key");
    }
    const novel: FakeNovel = {
      id: nextUuid(),
      businessId,
      title: String(args.data.title),
      description: String(args.data.description),
      coverUrl: (args.data.coverUrl as string | null) ?? null,
      locale: String(args.data.locale),
      slug: String(args.data.slug),
      totalChapterCount: Number(args.data.totalChapterCount ?? 0),
      paidFromChapter: (args.data.paidFromChapter as number | null) ?? null,
      splitRatio: (args.data.splitRatio as Prisma.Decimal | null) ?? null,
      deletedAt: null,
    };
    this.novels.set(novel.id, novel);
    this.logUndo(() => {
      this.novels.delete(novel.id);
    });
    return { ...novel };
  };

  private articleCreate = async (args: { data: Record<string, unknown> }) => {
    this.calls.push("article.create");
    this.lastArticleCreateArgs = { ...args.data };
    if (this.articleShortIdFailuresRemaining > 0) {
      this.articleShortIdFailuresRemaining -= 1;
      throw uniqueViolation("article_public_page_short_id_key");
    }
    const publicPageShortId = String(args.data.publicPageShortId);
    for (const existing of this.articles.values()) {
      if (existing.publicPageShortId === publicPageShortId) throw uniqueViolation("article_public_page_short_id_key");
    }
    const article: FakeArticle = {
      id: nextUuid(),
      novelId: String(args.data.novelId),
      locale: String(args.data.locale),
      slug: String(args.data.slug),
      publicPageShortId,
      title: String(args.data.title),
      summary: (args.data.summary as string | null) ?? null,
      body: String(args.data.body ?? ""),
      deletedAt: null,
    };
    this.articles.set(article.id, article);
    this.logUndo(() => {
      this.articles.delete(article.id);
    });
    return { ...article };
  };

  private sourceItemUpdateMany = async (args: {
    where: { id: string; novelId: null; deletedAt: null };
    data: { novelId: string; status: "linked" };
  }) => {
    this.calls.push("novelSourceItem.updateMany");
    const item = this.sourceItems.get(args.where.id);
    if (!item || item.novelId !== null || item.deletedAt !== null) {
      return { count: 0 };
    }
    const prevNovelId = item.novelId;
    const prevStatus = item.status;
    this.logUndo(() => {
      item.novelId = prevNovelId;
      item.status = prevStatus;
    });
    item.novelId = args.data.novelId;
    item.status = args.data.status;
    return { count: 1 };
  };

  private operationAuditCreate = async (args: { data: FakeAudit }) => {
    this.calls.push("operationAudit.create");
    this.audits.push({ ...args.data });
    this.logUndo(() => {
      this.audits.pop();
    });
    return { ...args.data };
  };

  private buildClient(): FakeClient {
    const client: FakeClient = {
      novelSourceItem: {
        findFirst: this.sourceItemFindFirst,
        updateMany: this.sourceItemUpdateMany,
      },
      novel: {
        findFirst: this.novelFindFirst,
        create: this.novelCreate,
      },
      article: {
        findFirst: this.articleFindFirst,
        create: this.articleCreate,
      },
      operationAudit: {
        create: this.operationAuditCreate,
      },
      $transaction: async (callback) => {
        const previousLog = this.undoLog;
        this.undoLog = [];
        const thisLog = this.undoLog;
        try {
          const result = await callback(client);
          this.undoLog = previousLog;
          return result;
        } catch (error) {
          for (let i = thisLog.length - 1; i >= 0; i -= 1) thisLog[i]();
          this.undoLog = previousLog;
          throw error;
        }
      },
    };
    return client;
  }

  private readonly client: FakeClient = this.buildClient();

  asPrismaClient(): PrismaClient {
    return this.client as unknown as PrismaClient;
  }
}

type FakeClient = {
  novelSourceItem: {
    findFirst: (args: { where: { id: string } }) => Promise<unknown>;
    updateMany: (args: {
      where: { id: string; novelId: null; deletedAt: null };
      data: { novelId: string; status: "linked" };
    }) => Promise<{ count: number }>;
  };
  novel: {
    findFirst: (args: { where: Record<string, unknown>; select?: { id: true } }) => Promise<unknown>;
    create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
  };
  article: {
    findFirst: (args: { where: Record<string, unknown>; select?: { id: true } }) => Promise<unknown>;
    create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
  };
  operationAudit: {
    create: (args: { data: FakeAudit }) => Promise<unknown>;
  };
  $transaction: <T>(callback: (tx: FakeClient) => Promise<T>) => Promise<T>;
};
