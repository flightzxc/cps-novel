/**
 * C-30B TEST_ONLY in-memory double for the batch-rebind preview/execution
 * modules (`src/server/article-rebind/preview.ts`/`batch.ts`). Same
 * "purpose-built, not a generic Prisma emulator" discipline as `./fake-db.ts`
 * (C-30A's own fixture) — every delegate method here implements the EXACT
 * filter shape the production code issues, nothing more general.
 *
 * `$transaction` gives REAL rollback semantics (snapshot before, restore on
 * throw) — unlike `./fake-db.ts`'s `$transaction`, which just invokes the
 * callback with no isolation, this repo's C-30B batch tests need genuine
 * per-item atomicity to prove "🔴 one failing item never rolls back a peer
 * item's already-committed write" (施工工单 §4B.2/§6 item 8).
 */
import type { PrismaClient } from "@prisma/client";

export type FakeChannelRow = { id: string; code: string; name: string; status: string };
export type FakeSourceAppRow = { id: string; code: string; name: string; status: string };
export type FakeChannelAppRow = { id: string; channelId: string; sourceAppId: string };
export type FakeNovelSourceItemRow = { id: string; channelAppId: string; novelId: string | null; deletedAt: Date | null };
export type FakeNovelRow = {
  id: string;
  title: string;
  titleNormalized: string | null;
  businessId: string;
  slug: string;
  locale: string;
  status: string;
  deletedAt: Date | null;
};
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
export type FakePreviewRow = {
  id: string;
  createdBy: string;
  sourceChannelCode: string;
  targetChannelCode: string;
  filtersJson: unknown;
  planHash: string;
  sourceScanned: number;
  matchedCount: number;
  ambiguousCount: number;
  skippedCount: number;
  matchesJson: unknown;
  expiresAt: Date;
  createdAt: Date;
};
export type FakeBatchRow = {
  id: string;
  createdBy: string;
  requestToken: string;
  previewId: string;
  selectionHash: string;
  requestPayloadHash: string;
  sourceChannelCode: string;
  targetChannelCode: string;
  status: string;
  acknowledgeRisks: boolean;
  submittedCount: number;
  resolvableCount: number;
  appliedCount: number;
  skippedCount: number;
  failedCount: number;
  filtersJson: unknown;
  planHash: string;
  reason: string;
  executionToken: string | null;
  leaseExpiresAt: Date | null;
  heartbeatAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
export type FakeBatchItemRow = {
  id: string;
  batchId: string;
  articleId: string;
  oldNovelId: string;
  oldPromoLinkId: string | null;
  expectedNewNovelId: string;
  expectedNewPromoLinkId: string | null;
  appliedNewNovelId: string | null;
  appliedNewPromoLinkId: string | null;
  status: string;
  processingToken: string | null;
  errorKind: string | null;
  errorMessage: string | null;
  auditId: bigint | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type WhereClause = Record<string, unknown>;

function matchesField(actual: unknown, expected: unknown): boolean {
  if (expected === null) return actual === null;
  if (expected && typeof expected === "object" && !(expected instanceof Date)) {
    const clause = expected as { not?: unknown; in?: unknown[]; lte?: unknown; gt?: unknown; contains?: string; mode?: string };
    if ("not" in clause) return actual !== clause.not;
    if ("in" in clause) return Array.isArray(clause.in) && clause.in.includes(actual);
    if ("lte" in clause) return actual instanceof Date && actual.getTime() <= (clause.lte as Date).getTime();
    if ("gt" in clause) return actual instanceof Date && actual.getTime() > (clause.gt as Date).getTime();
    if ("contains" in clause) {
      const haystack = String(actual ?? "");
      const needle = String(clause.contains ?? "");
      return clause.mode === "insensitive" ? haystack.toLowerCase().includes(needle.toLowerCase()) : haystack.includes(needle);
    }
  }
  return actual === expected;
}

function matchesFlat(row: Record<string, unknown>, where: WhereClause): boolean {
  for (const [key, expected] of Object.entries(where)) {
    if (key === "OR") {
      const options = expected as WhereClause[];
      if (!options.some((option) => matchesFlat(row, option))) return false;
      continue;
    }
    if (!matchesField(row[key], expected)) return false;
  }
  return true;
}

let sequence = 0;
function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

export class FakeBatchRebindDb {
  channels: FakeChannelRow[] = [];
  sourceApps: FakeSourceAppRow[] = [];
  channelApps: FakeChannelAppRow[] = [];
  novelSourceItems: FakeNovelSourceItemRow[] = [];
  novels: FakeNovelRow[] = [];
  articles: FakeArticleRow[] = [];
  promoLinks: FakePromoLinkRow[] = [];
  audits: FakeAuditRow[] = [];
  previews: FakePreviewRow[] = [];
  batches: FakeBatchRow[] = [];
  batchItems: FakeBatchItemRow[] = [];
  private nextAuditId = 1n;

  /** Per-instance query counter — the "禁止 N+1" test asserts this does not grow linearly with candidate count. */
  queryCount = 0;

  private snapshot() {
    return {
      articles: structuredClone(this.articles),
      novels: structuredClone(this.novels),
      promoLinks: structuredClone(this.promoLinks),
      audits: this.audits.map((row) => ({ ...row })),
      previews: this.previews.map((row) => ({ ...row })),
      batches: this.batches.map((row) => ({ ...row })),
      batchItems: this.batchItems.map((row) => ({ ...row })),
      nextAuditId: this.nextAuditId,
    };
  }

  private restore(snap: ReturnType<FakeBatchRebindDb["snapshot"]>) {
    this.articles = snap.articles;
    this.novels = snap.novels;
    this.promoLinks = snap.promoLinks;
    this.audits = snap.audits;
    this.previews = snap.previews;
    this.batches = snap.batches;
    this.batchItems = snap.batchItems;
    this.nextAuditId = snap.nextAuditId;
  }

  private resolveSourceItem(item: FakeNovelSourceItemRow) {
    const channelApp = this.channelApps.find((ca) => ca.id === item.channelAppId)!;
    const channel = this.channels.find((c) => c.id === channelApp.channelId)!;
    const sourceApp = this.sourceApps.find((s) => s.id === channelApp.sourceAppId)!;
    return { ...item, channelApp: { ...channelApp, channel, sourceApp } };
  }

  /** Does `novelId` have a non-deleted source item under channel `code`? */
  private novelHasSourceItemUnderChannel(novelId: string, code: string): boolean {
    return this.novelSourceItems.some((item) => {
      if (item.novelId !== novelId || item.deletedAt) return false;
      const resolved = this.resolveSourceItem(item);
      return resolved.channelApp.channel.code === code;
    });
  }

  private projectArticle(row: FakeArticleRow, select?: Record<string, unknown>) {
    const novel = row.novelId ? this.novels.find((n) => n.id === row.novelId) ?? null : null;
    const promoLink = row.promoLinkId ? this.promoLinks.find((p) => p.id === row.promoLinkId) ?? null : null;
    const full = {
      ...row,
      novel: novel ? { id: novel.id, title: novel.title, titleNormalized: novel.titleNormalized, locale: novel.locale, status: novel.status, deletedAt: novel.deletedAt } : null,
      promoLink: promoLink ? { id: promoLink.id, publicRedirectCode: promoLink.publicRedirectCode } : null,
    };
    void select;
    return full;
  }

  private articleMatchesRebindSourceWhere(row: FakeArticleRow, where: WhereClause): boolean {
    if (where.articleType !== undefined && !matchesField(row.articleType, where.articleType)) return false;
    if (where.status !== undefined && !matchesField(row.status, where.status)) return false;
    if (where.deletedAt === null && row.deletedAt !== null) return false;
    if (where.locale !== undefined && !matchesField(row.locale, where.locale)) return false;
    if (where.id !== undefined && !matchesField(row.id, where.id)) return false;
    if (where.novelId !== undefined && !matchesField(row.novelId, where.novelId)) return false;
    const novelClause = where.novel as { is?: { sourceItems?: { some?: { deletedAt: null; channelApp: { channel: { code: string } } } } } } | undefined;
    if (novelClause?.is?.sourceItems?.some) {
      if (!row.novelId) return false;
      const code = novelClause.is.sourceItems.some.channelApp.channel.code;
      if (!this.novelHasSourceItemUnderChannel(row.novelId, code)) return false;
    }
    return true;
  }

  private client(): unknown {
    return {
      channel: {
        findMany: async (args: { where?: WhereClause; select?: Record<string, unknown> }) => {
          this.queryCount += 1;
          const rows = this.channels.filter((row) => !args.where || matchesFlat(row as unknown as Record<string, unknown>, args.where));
          return rows.map((row) => ({ id: row.id, code: row.code, name: row.name }));
        },
      },
      sourceApp: {
        findMany: async (args: { where?: WhereClause; select?: Record<string, unknown> }) => {
          this.queryCount += 1;
          const rows = this.sourceApps.filter((row) => !args.where || matchesFlat(row as unknown as Record<string, unknown>, args.where));
          return rows.map((row) => ({ id: row.id, code: row.code, name: row.name }));
        },
      },
      novelSourceItem: {
        findMany: async (args: { where: WhereClause }) => {
          this.queryCount += 1;
          const where = args.where as { novelId?: { in: string[] }; deletedAt?: null; channelApp?: { channel: { code: string } } };
          const rows = this.novelSourceItems.filter((item) => {
            if (where.novelId && !matchesField(item.novelId, where.novelId)) return false;
            if (where.deletedAt === null && item.deletedAt) return false;
            if (item.novelId === null) return false;
            if (where.channelApp) {
              const resolved = this.resolveSourceItem(item);
              if (resolved.channelApp.channel.code !== where.channelApp.channel.code) return false;
            }
            return true;
          });
          return rows.map((item) => {
            const resolved = this.resolveSourceItem(item);
            return { novelId: item.novelId, channelApp: { sourceApp: { code: resolved.channelApp.sourceApp.code } } };
          });
        },
      },
      article: {
        count: async (args: { where: WhereClause }) => {
          this.queryCount += 1;
          return this.articles.filter((row) => this.articleMatchesRebindSourceWhere(row, args.where)).length;
        },
        findMany: async (args: { where: WhereClause; select?: Record<string, unknown>; orderBy?: unknown; take?: number }) => {
          this.queryCount += 1;
          // Two shapes share this method: the bounded-scan source-universe
          // query (articleType/status/locale/novel.is.sourceItems.some) and
          // the simpler bulk lookups (id-in / novelId-in) used by the
          // guard-fact resolver and page re-fetch — both go through the
          // same flat-plus-relation matcher above, which no-ops any clause
          // it does not recognize.
          let rows = this.articles.filter((row) => this.articleMatchesRebindSourceWhere(row, args.where));
          rows = [...rows].sort((a, b) => a.id.localeCompare(b.id));
          if (args.take !== undefined) rows = rows.slice(0, args.take);
          return rows.map((row) => this.projectArticle(row, args.select));
        },
        groupBy: async (args: { by: string[]; where: WhereClause; _count?: { _all: true } }) => {
          this.queryCount += 1;
          const rows = this.articles.filter((row) => this.articleMatchesRebindSourceWhere(row, args.where));
          // Honor `args.by` rather than assuming `locale`: two call sites now
          // share this delegate — `buildRebindBatchFacets` groups by `locale`
          // WITH `_count`, and `buildCandidateFindings`' guard-9 sibling
          // lookup groups by `novelId` with NO aggregate (C-30 施工单2复核
          // §6.3 item 2). Prisma returns one row per distinct combination of
          // the `by` fields carrying only those fields plus any requested
          // aggregate; mirror exactly that, and refuse anything this fake
          // has not actually been taught, so a future multi-field groupBy
          // fails loudly instead of silently returning wrong groups.
          if (args.by.length !== 1 || (args.by[0] !== "locale" && args.by[0] !== "novelId")) {
            throw new Error(`FakeBatchRebindDb.article.groupBy: unsupported by=${JSON.stringify(args.by)}`);
          }
          const key = args.by[0] as "locale" | "novelId";
          const counts = new Map<string | null, number>();
          for (const row of rows) {
            const value = row[key] ?? null;
            counts.set(value, (counts.get(value) ?? 0) + 1);
          }
          return [...counts.entries()].map(([value, count]) =>
            args._count ? { [key]: value, _count: { _all: count } } : { [key]: value },
          );
        },
        findFirst: async (args: { where: WhereClause; select?: Record<string, unknown> }) => {
          this.queryCount += 1;
          const row = this.articles.find((candidate) => matchesFlat(candidate as unknown as Record<string, unknown>, args.where));
          return row ? this.projectArticle(row, args.select) : null;
        },
        findUnique: async (args: { where: { id: string } }) => {
          this.queryCount += 1;
          const row = this.articles.find((candidate) => candidate.id === args.where.id);
          return row ? { locale: row.locale, slug: row.slug, publicPageShortId: row.publicPageShortId } : null;
        },
        updateMany: async (args: { where: WhereClause; data: Partial<FakeArticleRow> }) => {
          this.queryCount += 1;
          const row = this.articles.find((candidate) => matchesFlat(candidate as unknown as Record<string, unknown>, args.where));
          if (!row) return { count: 0 };
          Object.assign(row, args.data, { updatedAt: new Date(row.updatedAt.getTime() + 1) });
          return { count: 1 };
        },
      },
      novel: {
        findFirst: async (args: { where: WhereClause; select?: Record<string, unknown> }) => {
          this.queryCount += 1;
          const row = this.novels.find((candidate) => matchesFlat(candidate as unknown as Record<string, unknown>, args.where));
          return row ? { ...row } : null;
        },
        findMany: async (args: { where: WhereClause; select?: Record<string, unknown>; orderBy?: unknown; take?: number }) => {
          this.queryCount += 1;
          const where = args.where as {
            deletedAt?: null;
            locale?: string;
            titleNormalized?: { in: string[] };
            sourceItems?: { some: { deletedAt: null; channelApp: { channel: { code: string } } } };
            id?: { in: string[] };
          };
          let rows = this.novels.filter((row) => {
            if (where.deletedAt === null && row.deletedAt) return false;
            if (where.locale !== undefined && !matchesField(row.locale, where.locale)) return false;
            if (where.titleNormalized && !matchesField(row.titleNormalized, where.titleNormalized)) return false;
            if (where.id && !matchesField(row.id, where.id)) return false;
            if (where.sourceItems?.some) {
              if (!this.novelHasSourceItemUnderChannel(row.id, where.sourceItems.some.channelApp.channel.code)) return false;
            }
            return true;
          });
          rows = [...rows].sort((a, b) => a.id.localeCompare(b.id));
          if (args.take !== undefined) rows = rows.slice(0, args.take);
          return rows.map((row) => ({ ...row }));
        },
      },
      promoLink: {
        findMany: async (args: { where: WhereClause; select?: Record<string, unknown>; orderBy?: unknown }) => {
          this.queryCount += 1;
          const rows = this.promoLinks.filter((candidate) => matchesFlat(candidate as unknown as Record<string, unknown>, args.where));
          const sorted = [...rows].sort((a, b) => {
            const fa = a.fetchedAt?.getTime() ?? 0;
            const fb = b.fetchedAt?.getTime() ?? 0;
            if (fa !== fb) return fb - fa;
            return a.id.localeCompare(b.id);
          });
          return sorted.map((row) => ({ ...row }));
        },
      },
      operationAudit: {
        create: async (args: { data: Record<string, unknown> }) => {
          this.queryCount += 1;
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
          this.queryCount += 1;
          const rows = this.audits.filter((candidate) => matchesFlat(candidate as unknown as Record<string, unknown>, args.where));
          const sorted = [...rows].sort((a, b) => (args.orderBy?.createdAt === "asc" ? a.createdAt.getTime() - b.createdAt.getTime() : b.createdAt.getTime() - a.createdAt.getTime()));
          return sorted[0] ? { ...sorted[0] } : null;
        },
        findMany: async (args: { where: WhereClause; orderBy?: { createdAt: "asc" | "desc" }; take?: number }) => {
          this.queryCount += 1;
          const rows = this.audits.filter((candidate) => matchesFlat(candidate as unknown as Record<string, unknown>, args.where));
          const sorted = [...rows].sort((a, b) => (args.orderBy?.createdAt === "asc" ? a.createdAt.getTime() - b.createdAt.getTime() : b.createdAt.getTime() - a.createdAt.getTime()));
          return sorted.slice(0, args.take ?? sorted.length).map((row) => ({ ...row }));
        },
      },
      articleNovelRebindPreview: {
        create: async (args: { data: Record<string, unknown> }) => {
          this.queryCount += 1;
          const row = { ...args.data, createdAt: new Date() } as unknown as FakePreviewRow;
          this.previews.push(row);
          return { ...row };
        },
        findUnique: async (args: { where: { id: string } }) => {
          this.queryCount += 1;
          const row = this.previews.find((p) => p.id === args.where.id);
          return row ? { ...row } : null;
        },
        findMany: async (args: { where: WhereClause; orderBy?: unknown; take?: number }) => {
          this.queryCount += 1;
          let rows = this.previews.filter((row) => matchesFlat(row as unknown as Record<string, unknown>, args.where));
          rows = [...rows].sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
          if (args.take !== undefined) rows = rows.slice(0, args.take);
          return rows.map((row) => ({ ...row }));
        },
        deleteMany: async (args: { where: WhereClause }) => {
          this.queryCount += 1;
          const before = this.previews.length;
          this.previews = this.previews.filter((row) => !matchesFlat(row as unknown as Record<string, unknown>, args.where));
          return { count: before - this.previews.length };
        },
      },
      articleNovelRebindBatch: {
        create: async (args: { data: Record<string, unknown> }) => {
          this.queryCount += 1;
          if (this.batches.some((b) => b.id === args.data.id || b.requestToken === args.data.requestToken)) {
            throw Object.assign(new Error("unique constraint"), { code: "P2002" });
          }
          const now = new Date();
          // Explicit `null` defaults for every nullable column NOT present
          // in `args.data` — mirrors a real Prisma `create()` against a
          // nullable-with-no-DEFAULT column (Postgres writes NULL, not
          // `undefined`). Omitting this defaulting previously made
          // `executionToken`/`leaseExpiresAt` read back as `undefined`,
          // which fails EVERY `{field: null}` `where` branch a real DB would
          // match — a real, reproduced bug (`acquireRebindBatchLease` could
          // never acquire a lease on a freshly-created batch), not just
          // defensive styling.
          const defaults = {
            status: "ready",
            acknowledgeRisks: false,
            submittedCount: 0,
            resolvableCount: 0,
            appliedCount: 0,
            skippedCount: 0,
            failedCount: 0,
            executionToken: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            startedAt: null,
            finishedAt: null,
          };
          const row = Object.assign({}, defaults, args.data, { createdAt: now, updatedAt: now }) as unknown as FakeBatchRow;
          this.batches.push(row);
          return { ...row };
        },
        findUnique: async (args: { where: { id?: string; requestToken?: string } }) => {
          this.queryCount += 1;
          const row = this.batches.find((b) => (args.where.id ? b.id === args.where.id : b.requestToken === args.where.requestToken));
          return row ? { ...row } : null;
        },
        findFirst: async (args: { where: WhereClause; include?: unknown }) => {
          this.queryCount += 1;
          const row = this.batches.find((b) => matchesFlat(b as unknown as Record<string, unknown>, args.where));
          if (!row) return null;
          if (args.include) {
            const items = this.batchItems.filter((item) => item.batchId === row.id).sort((a, b) => a.id.localeCompare(b.id));
            return { ...row, items: items.map((item) => ({ ...item })) };
          }
          return { ...row };
        },
        updateMany: async (args: { where: WhereClause; data: Record<string, unknown> }) => {
          this.queryCount += 1;
          const rows = this.batches.filter((b) => matchesFlat(b as unknown as Record<string, unknown>, args.where));
          for (const row of rows) {
            for (const [key, value] of Object.entries(args.data)) {
              if (value !== undefined) (row as unknown as Record<string, unknown>)[key] = value;
            }
            row.updatedAt = new Date();
          }
          return { count: rows.length };
        },
      },
      articleNovelRebindBatchItem: {
        createMany: async (args: { data: Array<Record<string, unknown>> }) => {
          this.queryCount += 1;
          const now = new Date();
          for (const data of args.data) {
            this.batchItems.push({
              id: nextId("item"),
              batchId: data.batchId as string,
              articleId: data.articleId as string,
              oldNovelId: data.oldNovelId as string,
              oldPromoLinkId: (data.oldPromoLinkId as string) ?? null,
              expectedNewNovelId: data.expectedNewNovelId as string,
              expectedNewPromoLinkId: (data.expectedNewPromoLinkId as string) ?? null,
              appliedNewNovelId: null,
              appliedNewPromoLinkId: null,
              status: data.status as string,
              processingToken: null,
              errorKind: (data.errorKind as string) ?? null,
              errorMessage: (data.errorMessage as string) ?? null,
              auditId: null,
              startedAt: null,
              finishedAt: (data.finishedAt as Date) ?? null,
              createdAt: now,
              updatedAt: now,
            });
          }
          return { count: args.data.length };
        },
        findMany: async (args: { where: WhereClause; orderBy?: unknown }) => {
          this.queryCount += 1;
          let rows = this.batchItems.filter((row) => matchesFlat(row as unknown as Record<string, unknown>, args.where));
          rows = [...rows].sort((a, b) => a.id.localeCompare(b.id));
          return rows.map((row) => ({ ...row }));
        },
        findUnique: async (args: { where: { id: string } }) => {
          this.queryCount += 1;
          const row = this.batchItems.find((item) => item.id === args.where.id);
          return row ? { ...row } : null;
        },
        updateMany: async (args: { where: WhereClause; data: Record<string, unknown> }) => {
          this.queryCount += 1;
          const rows = this.batchItems.filter((row) => matchesFlat(row as unknown as Record<string, unknown>, args.where));
          for (const row of rows) {
            for (const [key, value] of Object.entries(args.data)) {
              if (value !== undefined) (row as unknown as Record<string, unknown>)[key] = value;
            }
            row.updatedAt = new Date();
          }
          return { count: rows.length };
        },
        groupBy: async (args: { by: string[]; where: WhereClause; _count: { _all: true } }) => {
          this.queryCount += 1;
          const rows = this.batchItems.filter((row) => matchesFlat(row as unknown as Record<string, unknown>, args.where));
          const counts = new Map<string, number>();
          for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
          return [...counts.entries()].map(([status, count]) => ({ status, _count: { _all: count } }));
        },
      },
      $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
        const snap = this.snapshot();
        try {
          return await fn(this.client());
        } catch (error) {
          this.restore(snap);
          throw error;
        }
      },
    };
  }

  asPrismaClient(): PrismaClient {
    return this.client() as unknown as PrismaClient;
  }
}

export function seedChannel(db: FakeBatchRebindDb, overrides: Partial<FakeChannelRow> & { id: string; code: string }): FakeChannelRow {
  const row: FakeChannelRow = { name: overrides.code, status: "active", ...overrides };
  db.channels.push(row);
  return row;
}

export function seedSourceApp(db: FakeBatchRebindDb, overrides: Partial<FakeSourceAppRow> & { id: string; code: string }): FakeSourceAppRow {
  const row: FakeSourceAppRow = { name: overrides.code, status: "active", ...overrides };
  db.sourceApps.push(row);
  return row;
}

export function seedChannelApp(db: FakeBatchRebindDb, overrides: FakeChannelAppRow): FakeChannelAppRow {
  db.channelApps.push(overrides);
  return overrides;
}

export function seedSourceItem(db: FakeBatchRebindDb, overrides: Partial<FakeNovelSourceItemRow> & { id: string; channelAppId: string; novelId: string }): FakeNovelSourceItemRow {
  const row: FakeNovelSourceItemRow = { deletedAt: null, ...overrides };
  db.novelSourceItems.push(row);
  return row;
}

export function seedNovel(db: FakeBatchRebindDb, overrides: Partial<FakeNovelRow> & { id: string }): FakeNovelRow {
  const row: FakeNovelRow = {
    title: "Some Novel",
    titleNormalized: "some novel",
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

export function seedArticle(db: FakeBatchRebindDb, overrides: Partial<FakeArticleRow> & { id: string }): FakeArticleRow {
  const now = new Date("2026-09-08T00:00:00.000Z");
  const row: FakeArticleRow = {
    novelId: null,
    promoLinkId: null,
    locale: "en",
    slug: `article-${overrides.id}`,
    publicPageShortId: `Short${overrides.id}`,
    title: `Article ${overrides.id}`,
    status: "published",
    articleType: "novel_article",
    deletedAt: null,
    updatedAt: now,
    createdAt: now,
    ...overrides,
  };
  db.articles.push(row);
  return row;
}

export function seedPromoLink(db: FakeBatchRebindDb, overrides: Partial<FakePromoLinkRow> & { id: string; novelId: string }): FakePromoLinkRow {
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

/**
 * Wires a full "one channel, one source app" registration for a novel — the
 * common case every test uses at least twice (once per side of a rebind
 * pairing). Returns the created `NovelSourceItem` id.
 */
export function seedNovelUnderChannel(
  db: FakeBatchRebindDb,
  input: { novelId: string; channelId: string; sourceAppId: string },
): FakeNovelSourceItemRow {
  const channelApp = db.channelApps.find((ca) => ca.channelId === input.channelId && ca.sourceAppId === input.sourceAppId) ?? seedChannelApp(db, { id: nextId("channel-app"), channelId: input.channelId, sourceAppId: input.sourceAppId });
  return seedSourceItem(db, { id: nextId("source-item"), channelAppId: channelApp.id, novelId: input.novelId });
}
