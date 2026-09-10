import type { PrismaClient } from "@prisma/client";

/**
 * TEST_ONLY in-memory double for the C-30A rebind service/guards — same
 * "only what's used here" discipline as `tests/backend/articles/service.test.ts`'s
 * `FakeArticlesDb`.
 */

export type FakeArticleRow = {
  id: string;
  novelId: string | null;
  promoLinkId: string | null;
  locale: string;
  slug: string;
  publicPageShortId: string;
  title: string;
  status: string;
  articleType: string;
  deletedAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
};

export type FakeNovelRow = {
  id: string;
  title: string;
  businessId: string;
  slug: string;
  locale: string;
  status: string;
  deletedAt: Date | null;
};

export type FakePromoLinkRow = {
  id: string;
  novelId: string;
  status: string;
  webUrl: string | null;
  appUrl: string | null;
  fetchedAt: Date | null;
  publicRedirectCode: string;
  deletedAt: Date | null;
};

export type FakeAuditRow = {
  id: bigint;
  actorType: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  requestId: string | null;
  reason: string | null;
  beforeSnapshot: unknown;
  afterSnapshot: unknown;
  createdAt: Date;
};

type WhereClause = Record<string, unknown>;

function matchesField(actual: unknown, expected: unknown): boolean {
  if (expected === null) return actual === null;
  if (expected && typeof expected === "object" && !(expected instanceof Date)) {
    const clause = expected as { not?: unknown; in?: unknown[]; contains?: string; mode?: string };
    if ("not" in clause) return actual !== clause.not;
    if ("in" in clause) return Array.isArray(clause.in) && clause.in.includes(actual);
    if ("contains" in clause) {
      const haystack = String(actual ?? "");
      const needle = String(clause.contains ?? "");
      if (clause.mode === "insensitive") return haystack.toLowerCase().includes(needle.toLowerCase());
      return haystack.includes(needle);
    }
  }
  return actual === expected;
}

function matches(row: Record<string, unknown>, where: WhereClause): boolean {
  for (const [key, expected] of Object.entries(where)) {
    if (key === "OR") {
      const options = expected as WhereClause[];
      if (!options.some((option) => matches(row, option))) return false;
      continue;
    }
    if (!matchesField(row[key], expected)) return false;
  }
  return true;
}

export class FakeRebindDb {
  readonly articles: FakeArticleRow[] = [];
  readonly novels: FakeNovelRow[] = [];
  readonly promoLinks: FakePromoLinkRow[] = [];
  readonly audits: FakeAuditRow[] = [];
  private nextAuditId = 1n;
  /**
   * Test-only hook: when set, the NEXT `article.updateMany` call returns
   * `{ count: <this value> }` regardless of whether a row actually matched,
   * and does not mutate any row — used to exercise the write step's own
   * defense-in-depth CAS check (`if (write.count !== 1) throw
   * RebindDriftError()`) independently of the guard evaluator, which in
   * practice reads the same predicate first and would otherwise always
   * catch a mismatch before the write is ever attempted.
   */
  forceNextUpdateManyCount: number | null = null;

  private client() {
    return {
      article: {
        findFirst: async (args: { where: WhereClause; select?: Record<string, unknown> }) => {
          const row = this.articles.find((candidate) => matches(candidate as unknown as Record<string, unknown>, args.where));
          if (!row) return null;
          return this.projectArticle(row, args.select);
        },
        updateMany: async (args: { where: WhereClause; data: Partial<FakeArticleRow> }) => {
          if (this.forceNextUpdateManyCount !== null) {
            const forced = this.forceNextUpdateManyCount;
            this.forceNextUpdateManyCount = null;
            return { count: forced };
          }
          const row = this.articles.find((candidate) => matches(candidate as unknown as Record<string, unknown>, args.where));
          if (!row) return { count: 0 };
          Object.assign(row, args.data, { updatedAt: new Date(row.updatedAt.getTime() + 1) });
          return { count: 1 };
        },
      },
      novel: {
        findFirst: async (args: { where: WhereClause; select?: Record<string, unknown> }) => {
          const row = this.novels.find((candidate) => matches(candidate as unknown as Record<string, unknown>, args.where));
          return row ? { ...row } : null;
        },
        findMany: async (args: {
          where: WhereClause;
          select?: Record<string, unknown>;
          orderBy?: Array<Record<string, "asc" | "desc">> | Record<string, "asc" | "desc">;
          take?: number;
        }) => {
          let rows = this.novels.filter((candidate) => matches(candidate as unknown as Record<string, unknown>, args.where));
          rows = [...rows].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
          return rows.slice(0, args.take ?? rows.length).map((row) => ({ ...row }));
        },
      },
      promoLink: {
        findMany: async (args: { where: WhereClause; select?: Record<string, unknown>; orderBy?: unknown }) => {
          const rows = this.promoLinks.filter((candidate) => matches(candidate as unknown as Record<string, unknown>, args.where));
          const sorted = [...rows].sort((a, b) => {
            const fa = a.fetchedAt?.getTime() ?? 0;
            const fb = b.fetchedAt?.getTime() ?? 0;
            if (fa !== fb) return fb - fa; // desc
            return a.id.localeCompare(b.id); // asc
          });
          return sorted.map((row) => ({ ...row }));
        },
      },
      operationAudit: {
        create: async (args: { data: Record<string, unknown> }) => {
          const row: FakeAuditRow = {
            id: this.nextAuditId,
            actorType: String(args.data.actorType ?? "admin"),
            actorId: (args.data.actorId as string) ?? null,
            action: String(args.data.action),
            entityType: String(args.data.entityType),
            entityId: String(args.data.entityId),
            requestId: (args.data.requestId as string) ?? null,
            reason: (args.data.reason as string) ?? null,
            beforeSnapshot: args.data.beforeSnapshot ?? null,
            afterSnapshot: args.data.afterSnapshot ?? null,
            createdAt: new Date(Date.now() + Number(this.nextAuditId)),
          };
          this.nextAuditId += 1n;
          this.audits.push(row);
          return { id: row.id };
        },
        findFirst: async (args: { where: WhereClause; orderBy?: { createdAt: "asc" | "desc" } }) => {
          const rows = this.audits.filter((candidate) => matches(candidate as unknown as Record<string, unknown>, args.where));
          const sorted = [...rows].sort((a, b) =>
            args.orderBy?.createdAt === "asc"
              ? a.createdAt.getTime() - b.createdAt.getTime()
              : b.createdAt.getTime() - a.createdAt.getTime(),
          );
          return sorted[0] ? { ...sorted[0] } : null;
        },
        findMany: async (args: { where: WhereClause; orderBy?: { createdAt: "asc" | "desc" }; take?: number }) => {
          const rows = this.audits.filter((candidate) => matches(candidate as unknown as Record<string, unknown>, args.where));
          const sorted = [...rows].sort((a, b) =>
            args.orderBy?.createdAt === "asc"
              ? a.createdAt.getTime() - b.createdAt.getTime()
              : b.createdAt.getTime() - a.createdAt.getTime(),
          );
          return sorted.slice(0, args.take ?? sorted.length).map((row) => ({ ...row }));
        },
      },
      $transaction: async <T>(run: (tx: unknown) => Promise<T>): Promise<T> => run(this.client()),
    };
  }

  private projectArticle(row: FakeArticleRow, select?: Record<string, unknown>) {
    const novel = row.novelId ? this.novels.find((candidate) => candidate.id === row.novelId) ?? null : null;
    const promoLink = row.promoLinkId ? this.promoLinks.find((candidate) => candidate.id === row.promoLinkId) ?? null : null;
    const full = {
      ...row,
      novel: novel ? { id: novel.id, title: novel.title, status: novel.status } : null,
      promoLink: promoLink ? { id: promoLink.id, publicRedirectCode: promoLink.publicRedirectCode } : null,
    };
    if (!select) return full;
    // For this fake, `select` is honored loosely: nested relation selects
    // (`novel`/`promoLink`) always project the same shape above regardless
    // of the caller's own nested `select` sub-object — every call site in
    // `src/server/article-rebind/` only ever asks for the same fixed nested
    // shape (`{id,title,status}` / `{id,publicRedirectCode}`), so this is
    // not a meaningful divergence for these tests.
    return full;
  }

  asPrismaClient(): PrismaClient {
    return this.client() as unknown as PrismaClient;
  }
}

export function seedArticle(db: FakeRebindDb, overrides: Partial<FakeArticleRow> & { id: string }): FakeArticleRow {
  const now = new Date("2026-09-08T00:00:00.000Z");
  const row: FakeArticleRow = {
    novelId: null,
    promoLinkId: null,
    locale: "en",
    slug: "some-article",
    publicPageShortId: "AbCdEf12",
    title: "Some Article",
    status: "draft",
    articleType: "novel_article",
    deletedAt: null,
    updatedAt: now,
    createdAt: now,
    ...overrides,
  };
  db.articles.push(row);
  return row;
}

export function seedNovel(db: FakeRebindDb, overrides: Partial<FakeNovelRow> & { id: string }): FakeNovelRow {
  const row: FakeNovelRow = {
    title: "Some Novel",
    businessId: `biz-${overrides.id}`,
    slug: `novel-${overrides.id}`,
    locale: "en",
    status: "published",
    deletedAt: null,
    ...overrides,
  };
  db.novels.push(row);
  return row;
}

export function seedPromoLink(db: FakeRebindDb, overrides: Partial<FakePromoLinkRow> & { id: string; novelId: string }): FakePromoLinkRow {
  const row: FakePromoLinkRow = {
    status: "fetched",
    webUrl: "https://example.com/w",
    appUrl: null,
    fetchedAt: new Date("2026-09-01T00:00:00.000Z"),
    publicRedirectCode: `code-${overrides.id}`,
    deletedAt: null,
    ...overrides,
  };
  db.promoLinks.push(row);
  return row;
}
