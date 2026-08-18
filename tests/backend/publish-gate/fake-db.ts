/**
 * TEST_ONLY — a minimal hand-rolled in-memory double for exactly the Prisma
 * call shapes `src/server/publish-gate/{facts,service}.ts` issue. Not a
 * general query engine: each method pattern-matches the specific
 * `where`/`select` shape its one real call site uses. `$transaction` simply
 * invokes the callback against `this` (no real atomicity/rollback) — none of
 * this PR's tests depend on partial-write rollback, only on the sequence of
 * calls and the resulting store state.
 */
import type { PrismaClient } from "@prisma/client";

export type FakeNovel = { id: string; status: string; locale: string; deletedAt: Date | null };
export type FakePromoLink = { id: string; status: string; webUrl: string | null; appUrl: string | null } | null;
export type FakeArticle = {
  id: string;
  novelId: string;
  locale: string;
  slug: string;
  status: string;
  title: string;
  body: string;
  publishedAt: Date | null;
  publishAt: Date | null;
  deletedAt: Date | null;
  promoLink: FakePromoLink;
};
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
      const novel = this.novels.get(article.novelId);
      if (!novel) return null;
      return {
        id: article.id,
        novelId: article.novelId,
        locale: article.locale,
        slug: article.slug,
        status: article.status,
        title: article.title,
        body: article.body,
        publishedAt: article.publishedAt,
        novel: { status: novel.status, locale: novel.locale, deletedAt: novel.deletedAt },
        promoLink: article.promoLink,
      };
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
    novel.status = args.data.status;
    return { ...novel };
  };

  private articleUpdate = async (args: {
    where: { id: string };
    data: { status?: string; publishedAt?: Date | null };
  }) => {
    this.calls.push("article.update");
    const article = this.articles.get(args.where.id);
    if (!article) throw new Error(`article ${args.where.id} not found`);
    if (args.data.status !== undefined) article.status = args.data.status;
    if (args.data.publishedAt !== undefined) article.publishedAt = args.data.publishedAt;
    return { ...article };
  };

  private articleFindMany = async (args: { where: Record<string, unknown> }) => {
    this.calls.push("article.findMany");
    const where = args.where;
    const results: Array<{ id: string }> = [];
    for (const article of this.articles.values()) {
      if (article.novelId !== where.novelId) continue;
      if (where.deletedAt === null && article.deletedAt !== null) continue;
      if (where.status !== undefined && article.status !== where.status) continue;
      results.push({ id: article.id });
    }
    return results;
  };

  private articleUpdateMany = async (args: { where: { id: { in: string[] } }; data: { status: string } }) => {
    this.calls.push("article.updateMany");
    let count = 0;
    for (const id of args.where.id.in) {
      const article = this.articles.get(id);
      if (!article) continue;
      article.status = args.data.status;
      count += 1;
    }
    return { count };
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
    return { ...args.data };
  };

  private buildClient(): FakeClient {
    const client: FakeClient = {
      article: {
        findFirst: this.articleFindFirst,
        findMany: (args: { where: Record<string, unknown>; take?: number }) =>
          "publishAt" in (args.where ?? {}) ? this.articleFindManyDue(args) : this.articleFindMany(args),
        update: this.articleUpdate,
        updateMany: this.articleUpdateMany,
      },
      novel: {
        findFirst: this.novelFindFirst,
        findUniqueOrThrow: this.novelFindUniqueOrThrow,
        update: this.novelUpdate,
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
      $transaction: async (callback) => callback(client),
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
    update: (args: { where: { id: string }; data: { status?: string; publishedAt?: Date | null } }) => Promise<unknown>;
    updateMany: (args: { where: { id: { in: string[] } }; data: { status: string } }) => Promise<unknown>;
  };
  novel: {
    findFirst: (args: { where: { id: string; deletedAt?: null } }) => Promise<unknown>;
    findUniqueOrThrow: (args: { where: { id: string } }) => Promise<unknown>;
    update: (args: { where: { id: string }; data: { status: string } }) => Promise<unknown>;
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
