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
  /** L10N P2: `Novel.locale`/`Article.locale` are now derived from this field — see `service.ts`'s `deriveLocale`. Defaults to `"en"` in `seedSourceItem` below so every pre-P2 test (none of which set this) keeps deriving the same `"en"` locale it used to pass in explicitly. */
  sourceLocale: string | null;
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
  templateId: string | null;
  deletedAt: Date | null;
};

export type FakeArticleTemplate = {
  id: string;
  templateKey: string;
  // L10N P3: `ArticleTemplate.locale` is database-level `NOT NULL` now
  // (`prisma/schema.prisma`'s `ArticleTemplate.locale String @default("en")`)
  // — no seeded row can legitimately be a null-locale "all locales"
  // template any more, so this fake no longer types the column as nullable.
  locale: string;
  version: number;
  schemaVersion: number;
  status: string;
  bodyTemplate: string;
  seoTemplate: unknown;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
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
  readonly articleTemplates = new Map<string, FakeArticleTemplate>();
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
      // `undefined` (not passed) defaults to "en"; explicitly passing `null`
      // seeds a genuinely unresolved source item (`missing_locale` tests).
      sourceLocale: item.sourceLocale === undefined ? "en" : item.sourceLocale,
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
      templateId: article.templateId ?? null,
      deletedAt: article.deletedAt ?? null,
    };
    this.articles.set(full.id, full);
    return full;
  }

  seedArticleTemplate(template: Partial<FakeArticleTemplate> = {}): FakeArticleTemplate {
    const now = new Date();
    const full: FakeArticleTemplate = {
      id: template.id ?? nextUuid(),
      templateKey: template.templateKey ?? "system-default-v1",
      locale: template.locale === undefined ? "en" : template.locale,
      version: template.version ?? 1,
      schemaVersion: template.schemaVersion ?? 1,
      status: template.status ?? "active",
      bodyTemplate: template.bodyTemplate ?? "<h1>{novel_title}</h1><p>{novel_description}</p>",
      seoTemplate: template.seoTemplate ?? { title: "{novel_title}", metaDescription: "{novel_description}" },
      deletedAt: template.deletedAt ?? null,
      createdAt: template.createdAt ?? now,
      updatedAt: template.updatedAt ?? now,
    };
    this.articleTemplates.set(full.id, full);
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
      templateId: (args.data.templateId as string | null) ?? null,
      deletedAt: null,
    };
    this.articles.set(article.id, article);
    this.logUndo(() => {
      this.articles.delete(article.id);
    });
    return { ...article };
  };

  private articleTemplateCount = async () => {
    this.calls.push("articleTemplate.count");
    return Array.from(this.articleTemplates.values()).filter((row) => row.deletedAt === null).length;
  };

  private articleTemplateCreate = async (args: { data: Record<string, unknown> }) => {
    this.calls.push("articleTemplate.create");
    const row = this.seedArticleTemplate(args.data as Partial<FakeArticleTemplate>);
    this.logUndo(() => this.articleTemplates.delete(row.id));
    return { ...row };
  };

  private articleTemplateFindFirst = async (args: { where: Record<string, unknown> }) => {
    this.calls.push("articleTemplate.findFirst");
    const where = args.where;
    /**
     * L10N P3 fix: `selectActiveArticleTemplate`/`listActiveArticleTemplateOptions`
     * (`src/server/article-templates/service.ts`) no longer emit a `locale`
     * `OR` clause at all — since `ArticleTemplate.locale` is `NOT NULL`,
     * P3 replaced the old `{ OR: [{locale: X}, {locale: null}] }` wildcard
     * with a plain equality condition, `{ locale: input.locale }`, pushed as
     * one element of the top-level `AND` array (`{ ..., AND: [{ locale: X },
     * ...] }` — see that function's own "L10N P3：`locale` 精确匹配" comment).
     *
     * This fake used to look ONLY for `locale` nested inside an `OR` group
     * (either a top-level `where.OR` or an `AND[].OR`). Since P3 stopped
     * emitting that shape, `orClauseGroups` was always empty here, so the
     * locale filter silently degraded to "match any locale" — the exact bug
     * this fix closes (a `ru` request was matching a seeded `en`/`fr`
     * template). Collecting plain `{ locale: X }` equality conditions from
     * both the top level and `AND[]` — in addition to the OR-group form,
     * still checked below — makes this fake enforce the same locale scoping
     * production's exact-match query now does.
     */
    const localeEqualityValues: string[] = [];
    if (typeof where.locale === "string") localeEqualityValues.push(where.locale);
    if (Array.isArray(where.AND)) {
      for (const clause of where.AND as Array<Record<string, unknown>>) {
        if (typeof clause.locale === "string") localeEqualityValues.push(clause.locale);
      }
    }

    // Back-compat only: production has not emitted an `OR`-wrapped locale
    // clause since P3 (see comment above), but this fake keeps recognizing
    // the shape so it doesn't silently stop enforcing locale if a caller
    // ever reintroduces an `OR` form (e.g. a future "also match a fallback
    // locale" query) without this fake being updated in lockstep.
    const orClauseGroups: Array<Array<{ locale?: string | null }>> = [];
    if (Array.isArray(where.OR)) orClauseGroups.push(where.OR as Array<{ locale?: string | null }>);
    if (Array.isArray(where.AND)) {
      for (const clause of where.AND as Array<Record<string, unknown>>) {
        if (Array.isArray(clause.OR)) orClauseGroups.push(clause.OR as Array<{ locale?: string | null }>);
      }
    }
    const localeOrGroup = orClauseGroups.find((group) => group.some((entry) => "locale" in entry));
    const localeOr = localeOrGroup?.map((entry) => entry.locale ?? null);

    const hasLocaleFilter = localeEqualityValues.length > 0 || localeOr !== undefined;
    const matchesLocale = (rowLocale: string | null) =>
      localeEqualityValues.includes(rowLocale as string) || (localeOr?.includes(rowLocale) ?? false);

    const rows = Array.from(this.articleTemplates.values()).filter((row) =>
      row.deletedAt === null &&
      (where.templateKey === undefined || row.templateKey === where.templateKey) &&
      (where.status === undefined || row.status === where.status) &&
      (!hasLocaleFilter || matchesLocale(row.locale)),
    );
    rows.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || right.version - left.version);
    return rows.length > 0 ? { ...rows[0] } : null;
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
      articleTemplate: {
        count: this.articleTemplateCount,
        create: this.articleTemplateCreate,
        findFirst: this.articleTemplateFindFirst,
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
  articleTemplate: {
    count: (args?: unknown) => Promise<number>;
    create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
    findFirst: (args: { where: Record<string, unknown> }) => Promise<unknown>;
  };
  $transaction: <T>(callback: (tx: FakeClient) => Promise<T>) => Promise<T>;
};
