/**
 * TEST_ONLY — a minimal hand-rolled in-memory double for exactly the Prisma
 * call shapes `src/server/publish-gate/{facts,service}.ts` issue. Not a
 * general query engine: each method pattern-matches the specific
 * `where`/`select` shape its one real call site uses.
 *
 * `$transaction` gives real rollback-on-throw semantics via a write-log
 * (`undoLog`), not a no-op and deliberately NOT a whole-store snapshot:
 * every write method that mutates `novels`/`articles`/`chapters`/`audits`
 * pushes an undo closure onto `undoLog` (only while a transaction is open);
 * if the callback throws, those closures run in reverse order, undoing only
 * *this transaction's own writes*. A whole-store snapshot-and-restore would
 * be wrong here: `onFactsLoaded` (below) simulates a *different*, already-
 * committed concurrent transaction by mutating the same stores directly —
 * those mutations must survive this transaction's rollback, not be wiped
 * out by it, exactly as a real concurrent COMMIT in another Postgres session
 * would. See `service.test.ts`'s TOCTOU regression tests, which depend on
 * this distinction.
 */
import type { PrismaClient } from "@prisma/client";

export type FakeNovel = { id: string; status: string; locale: string; deletedAt: Date | null };
export type FakePromoLink = { id: string; status: string; webUrl: string | null; appUrl: string | null } | null;
export type FakeArticle = {
  id: string;
  /**
   * C-27: nullable — a blog/listicle/guide Article has no Novel. Every
   * pre-C-27 seeded fixture in this repo's tests supplies a real novel id
   * (nothing here defaults it), so this widening is additive: existing
   * tests are unaffected.
   */
  novelId: string | null;
  locale: string;
  slug: string;
  status: string;
  title: string;
  body: string;
  publishedAt: Date | null;
  publishAt: Date | null;
  deletedAt: Date | null;
  promoLink: FakePromoLink;
  /**
   * Optional: only the invalidation-wiring tests
   * (`tests/backend/publish-gate/invalidation-wiring.test.ts`) need a real,
   * assertable value here. Every other existing test seeds Articles without
   * it and gets `defaultShortId(id)` — deterministic, never asserted on by
   * tests that don't care about it.
   */
  publicPageShortId?: string;
  /**
   * C-29b: defaults to `"novel_article"` when omitted — every pre-C-29b
   * fixture in this repo's tests gets that default and is unaffected. Set
   * to `"blog_article"` (or another blog-family value) alongside
   * `novelId: null`/`promoLink: null` to seed a blog Article; `service.ts`
   * reads this to pick `revalidatePublicArticlePaths` vs.
   * `revalidatePublicBlogPaths` after a publish commits.
   */
  articleType?: string;
};

/** Deterministic fallback for `FakeArticle.publicPageShortId` when a test doesn't set one. */
function defaultShortId(articleId: string): string {
  return articleId.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "shortid1";
}
export type FakeChapter = { id: string; novelId: string; status: string; deletedAt: Date | null; body: string | null };
export type FakeAudit = {
  actorType: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  requestId: string;
  reason?: string | null;
  beforeSnapshot?: unknown;
  afterSnapshot?: unknown;
};

export class FakePublishGateDb {
  readonly novels = new Map<string, FakeNovel>();
  readonly articles = new Map<string, FakeArticle>();
  readonly chapters = new Map<string, FakeChapter>();
  readonly audits: FakeAudit[] = [];
  /** Call log for assertions like "the update was never issued". */
  readonly calls: string[] = [];
  /**
   * Fires exactly once, immediately after the primary by-id Article lookup
   * `loadPublishGateFacts` issues (i.e. right after the read a real
   * transaction's gate decision is based on) — then clears itself. Lets a
   * test simulate a concurrent transaction (e.g. `takedownNovel`) committing
   * in the window between that read and this transaction's conditional
   * write, without any real threads/processes: the hook mutates `novels`/
   * `articles`/`chapters` directly, exactly as if another connection had
   * committed. See `service.test.ts`'s TOCTOU regression test.
   */
  onFactsLoaded: (() => void) | null = null;
  /** Non-null only while a `$transaction` callback is running. See the module header. */
  private undoLog: Array<() => void> | null = null;

  private logUndo(undo: () => void): void {
    this.undoLog?.push(undo);
  }

  seedNovel(novel: FakeNovel): this {
    this.novels.set(novel.id, novel);
    return this;
  }

  seedArticle(article: FakeArticle): this {
    this.articles.set(article.id, article);
    return this;
  }

  seedChapter(chapter: FakeChapter): this {
    this.chapters.set(chapter.id, chapter);
    return this;
  }

  private articleFindFirst = async (args: { where: Record<string, unknown> }) => {
    this.calls.push("article.findFirst");
    const where = args.where;
    if ("id" in where && typeof where.id === "string") {
      const article = this.articles.get(where.id);
      if (!article || article.deletedAt !== null) return null;
      // C-27: a null `novelId` (blog/listicle/guide) means "no Novel to
      // join" -- mirroring Prisma's own behavior for an optional relation,
      // this is `novel: null` on the returned row, not "article not found".
      // A non-null `novelId` with no matching seeded Novel stays treated as
      // not-found (pre-existing behavior, unreachable on a real DB given the
      // RESTRICT FK, kept as-is for novel_article fixtures).
      const novel = article.novelId !== null ? this.novels.get(article.novelId) : null;
      if (article.novelId !== null && !novel) return null;
      const result = {
        id: article.id,
        novelId: article.novelId,
        locale: article.locale,
        slug: article.slug,
        publicPageShortId: article.publicPageShortId ?? defaultShortId(article.id),
        status: article.status,
        title: article.title,
        body: article.body,
        publishedAt: article.publishedAt,
        articleType: article.articleType ?? "novel_article",
        novel: novel ? { status: novel.status, locale: novel.locale, deletedAt: novel.deletedAt } : null,
        promoLink: article.promoLink,
      };
      if (this.onFactsLoaded) {
        const hook = this.onFactsLoaded;
        this.onFactsLoaded = null;
        hook();
      }
      return result;
    }
    // Page-identity conflict lookup: { id: { not }, deletedAt: null, locale, slug }
    const notId = (where.id as { not?: string } | undefined)?.not;
    const locale = where.locale as string;
    const slug = where.slug as string;
    for (const article of this.articles.values()) {
      if (article.deletedAt !== null) continue;
      if (article.id === notId) continue;
      if (article.locale === locale && article.slug === slug) return { id: article.id };
    }
    return null;
  };

  private novelFindFirst = async (args: { where: { id: string; deletedAt?: null } }) => {
    this.calls.push("novel.findFirst");
    const novel = this.novels.get(args.where.id);
    if (!novel || novel.deletedAt !== null) return null;
    return { ...novel };
  };

  private novelFindUniqueOrThrow = async (args: { where: { id: string } }) => {
    this.calls.push("novel.findUniqueOrThrow");
    const novel = this.novels.get(args.where.id);
    if (!novel) throw new Error(`novel ${args.where.id} not found`);
    return { ...novel };
  };

  private novelUpdate = async (args: { where: { id: string }; data: { status: string } }) => {
    this.calls.push("novel.update");
    const novel = this.novels.get(args.where.id);
    if (!novel) throw new Error(`novel ${args.where.id} not found`);
    const prevStatus = novel.status;
    this.logUndo(() => {
      novel.status = prevStatus;
    });
    novel.status = args.data.status;
    return { ...novel };
  };

  /** Conditional single-row update — same TOCTOU-closing shape as `articleUpdateMany`'s single-row branch. */
  private novelUpdateMany = async (args: {
    where: { id: string; status: string; deletedAt: null };
    data: { status: string };
  }) => {
    this.calls.push("novel.updateMany");
    const novel = this.novels.get(args.where.id);
    if (!novel || novel.deletedAt !== null || novel.status !== args.where.status) {
      return { count: 0 };
    }
    const prevStatus = novel.status;
    this.logUndo(() => {
      novel.status = prevStatus;
    });
    novel.status = args.data.status;
    return { count: 1 };
  };

  private articleFindMany = async (args: { where: Record<string, unknown> }) => {
    this.calls.push("article.findMany");
    const where = args.where;
    const results: Array<{ id: string; locale: string; slug: string; publicPageShortId: string }> = [];
    for (const article of this.articles.values()) {
      if (article.novelId !== where.novelId) continue;
      if (where.deletedAt === null && article.deletedAt !== null) continue;
      if (where.status !== undefined && article.status !== where.status) continue;
      results.push({
        id: article.id,
        locale: article.locale,
        slug: article.slug,
        publicPageShortId: article.publicPageShortId ?? defaultShortId(article.id),
      });
    }
    return results;
  };

  /**
   * Two distinct call shapes, both real: `applyNovelRightsTransition` bulk-
   * updates by `{ id: { in: [...] } }` (uniform, ungated cascade — see
   * `service.ts`); `applyPublishTransition` conditionally updates a single
   * row by `{ id, status: <expected current status>, deletedAt: null }` and
   * inspects `count` to detect a concurrent change (TOCTOU close — see
   * `service.ts`'s module header and `onFactsLoaded` above).
   */
  private articleUpdateMany = async (args: {
    where: Record<string, unknown>;
    data: { status?: string; publishedAt?: Date | null };
  }) => {
    this.calls.push("article.updateMany");
    const where = args.where;
    if (where.id && typeof where.id === "object" && "in" in (where.id as object)) {
      let count = 0;
      for (const id of (where.id as { in: string[] }).in) {
        const article = this.articles.get(id);
        if (!article) continue;
        if (args.data.status !== undefined) {
          const prevStatus = article.status;
          this.logUndo(() => {
            article.status = prevStatus;
          });
          article.status = args.data.status;
        }
        count += 1;
      }
      return { count };
    }
    // Conditional single-row shape: { id, status, deletedAt: null }.
    const id = where.id as string;
    const article = this.articles.get(id);
    if (!article || article.deletedAt !== null || article.status !== where.status) {
      return { count: 0 };
    }
    const prevStatus = article.status;
    const prevPublishedAt = article.publishedAt;
    this.logUndo(() => {
      article.status = prevStatus;
      article.publishedAt = prevPublishedAt;
    });
    if (args.data.status !== undefined) article.status = args.data.status;
    if (args.data.publishedAt !== undefined) article.publishedAt = args.data.publishedAt;
    return { count: 1 };
  };

  private novelChapterFindMany = async (args: { where: Record<string, unknown>; select?: unknown }) => {
    this.calls.push("novelChapter.findMany");
    const where = args.where;
    const results: Array<{ id?: string; content: { body: string } | null }> = [];
    for (const chapter of this.chapters.values()) {
      if (chapter.novelId !== where.novelId) continue;
      if (where.deletedAt === null && chapter.deletedAt !== null) continue;
      if (typeof where.status === "string" && chapter.status !== where.status) continue;
      const notStatus = (where.status as { not?: string } | undefined)?.not;
      if (notStatus !== undefined && chapter.status === notStatus) continue;
      results.push({ id: chapter.id, content: chapter.body !== null ? { body: chapter.body } : null });
    }
    return results;
  };

  private novelChapterUpdateMany = async (args: { where: { id: { in: string[] } }; data: { status: string } }) => {
    this.calls.push("novelChapter.updateMany");
    let count = 0;
    for (const id of args.where.id.in) {
      const chapter = this.chapters.get(id);
      if (!chapter) continue;
      const prevStatus = chapter.status;
      this.logUndo(() => {
        chapter.status = prevStatus;
      });
      chapter.status = args.data.status;
      count += 1;
    }
    return { count };
  };

  private novelChapterContentDeleteMany = async (args: { where: { novelChapterId: { in: string[] } } }) => {
    this.calls.push("novelChapterContent.deleteMany");
    let count = 0;
    for (const id of args.where.novelChapterId.in) {
      const chapter = this.chapters.get(id);
      if (chapter && chapter.body !== null) {
        const prevBody = chapter.body;
        this.logUndo(() => {
          chapter.body = prevBody;
        });
        chapter.body = null;
        count += 1;
      }
    }
    return { count };
  };

  private articleFindManyDue = async (args: { where: Record<string, unknown>; take?: number }) => {
    this.calls.push("article.findMany.due");
    const where = args.where;
    const status = where.status as string;
    const deadline = (where.publishAt as { lte: Date }).lte;
    const results: Array<{ id: string }> = [];
    for (const article of [...this.articles.values()].sort(
      (a, b) => (a.publishAt?.getTime() ?? 0) - (b.publishAt?.getTime() ?? 0),
    )) {
      if (article.status !== status) continue;
      if (article.deletedAt !== null) continue;
      if (!article.publishAt || article.publishAt.getTime() > deadline.getTime()) continue;
      results.push({ id: article.id });
      if (args.take !== undefined && results.length >= args.take) break;
    }
    return results;
  };

  private operationAuditFindFirst = async (args: {
    where: Pick<FakeAudit, "actorType" | "action" | "entityType" | "entityId" | "requestId">;
  }) => {
    this.calls.push("operationAudit.findFirst");
    const where = args.where;
    const found = this.audits.find(
      (audit) =>
        audit.actorType === where.actorType
        && audit.action === where.action
        && audit.entityType === where.entityType
        && audit.entityId === where.entityId
        && audit.requestId === where.requestId,
    );
    return found ? { ...found } : null;
  };

  private operationAuditCreate = async (args: { data: FakeAudit }) => {
    this.calls.push("operationAudit.create");
    this.audits.push({ ...args.data });
    // `undoLog` runs in strict reverse order, so by the time this entry's
    // undo runs, any audit pushed after it (within the same transaction)
    // has already been popped — this is always the current tail.
    this.logUndo(() => {
      this.audits.pop();
    });
    return { ...args.data };
  };

  private buildClient(): FakeClient {
    const client: FakeClient = {
      article: {
        findFirst: this.articleFindFirst,
        findMany: (args: { where: Record<string, unknown>; take?: number }) =>
          "publishAt" in (args.where ?? {}) ? this.articleFindManyDue(args) : this.articleFindMany(args),
        updateMany: this.articleUpdateMany,
      },
      novel: {
        findFirst: this.novelFindFirst,
        findUniqueOrThrow: this.novelFindUniqueOrThrow,
        update: this.novelUpdate,
        updateMany: this.novelUpdateMany,
      },
      novelChapter: {
        findMany: this.novelChapterFindMany,
        updateMany: this.novelChapterUpdateMany,
      },
      novelChapterContent: {
        deleteMany: this.novelChapterContentDeleteMany,
      },
      operationAudit: {
        findFirst: this.operationAuditFindFirst,
        create: this.operationAuditCreate,
      },
      $transaction: async (callback) => {
        // Real rollback-on-throw via the write-log described in this file's
        // header — deliberately not a whole-store snapshot, which would also
        // undo `onFactsLoaded`'s simulated *concurrent, already-committed*
        // transaction. This codebase has no nested `$transaction` calls, but
        // save/restore the previous log anyway rather than assuming that.
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
  article: {
    findFirst: (args: { where: Record<string, unknown> }) => Promise<unknown>;
    findMany: (args: { where: Record<string, unknown>; take?: number }) => Promise<unknown>;
    updateMany: (args: {
      where: Record<string, unknown>;
      data: { status?: string; publishedAt?: Date | null };
    }) => Promise<{ count: number }>;
  };
  novel: {
    findFirst: (args: { where: { id: string; deletedAt?: null } }) => Promise<unknown>;
    findUniqueOrThrow: (args: { where: { id: string } }) => Promise<unknown>;
    update: (args: { where: { id: string }; data: { status: string } }) => Promise<unknown>;
    updateMany: (args: {
      where: { id: string; status: string; deletedAt: null };
      data: { status: string };
    }) => Promise<{ count: number }>;
  };
  novelChapter: {
    findMany: (args: { where: Record<string, unknown>; select?: unknown }) => Promise<unknown>;
    updateMany: (args: { where: { id: { in: string[] } }; data: { status: string } }) => Promise<unknown>;
  };
  novelChapterContent: {
    deleteMany: (args: { where: { novelChapterId: { in: string[] } } }) => Promise<unknown>;
  };
  operationAudit: {
    findFirst: (args: {
      where: Pick<FakeAudit, "actorType" | "action" | "entityType" | "entityId" | "requestId">;
    }) => Promise<unknown>;
    create: (args: { data: FakeAudit }) => Promise<unknown>;
  };
  $transaction: <T>(callback: (tx: FakeClient) => Promise<T>) => Promise<T>;
};
