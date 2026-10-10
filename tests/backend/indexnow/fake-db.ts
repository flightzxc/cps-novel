/**
 * TEST_ONLY — an in-memory double for the Prisma call shapes
 * `src/lib/indexnow/**`, `worker/handlers/indexnow-*.ts` and
 * `scripts/indexnow-*.ts` issue.
 *
 * B-41 rewrite: the original hand-pattern-matched one call site per method.
 * The batch handler uses interactive transactions, grouped `updateMany`s with
 * `OR`/`AND`/`not`/`in`/`lte` filters, relation filters, `groupBy`, cursor
 * paging, `createMany({ skipDuplicates })` and the control-event stream — so
 * this double now has a small generic query engine (`matchesWhere`,
 * `orderBy`, `take`, `groupBy`, `increment`) plus per-table unique rules.
 * It is still NOT a general Prisma implementation: unsupported operators throw
 * so a typo cannot silently match nothing.
 *
 * Deliberate fidelity points:
 *   - `$transaction(fn)` snapshots every store and RESTORES it when `fn`
 *     throws, so rollback behaviour of the batch write-back is observable. The
 *     transaction client has no `$transaction` (like Prisma's), so
 *     `ensureIndexNowBatchDeliveryTask` wraps a bare client but not a tx.
 *   - `$queryRaw` / `$queryRawUnsafe` recognise exactly the statements the
 *     code issues (database clock, advisory lock, the control-state SQL
 *     identified by its marker comment) and mimic their SQL semantics in JS.
 *     The SQL text itself is verified against real PostgreSQL by
 *     `tests/integration/tasks/indexnow-batch-postgres.test.ts`.
 *   - `clock` is the "database clock": every `now()`/`clock_timestamp()` the
 *     code reads and every `createdAt`/`updatedAt` stamped here comes from it.
 *   - `writeCount` counts every mutating call, so "this path wrote nothing"
 *     is a one-line assertion.
 */
import { afterEach, beforeEach } from "vitest";
import { Prisma, type PrismaClient } from "@prisma/client";

import { INDEXNOW_CONTROL_STATE_SQL } from "@/lib/indexnow/delivery-control";

export type FakePromoLink = { status: string; webUrl: string | null; appUrl: string | null } | null;

export type FakeArticle = {
  id: string;
  novelId: string;
  locale: string;
  slug: string;
  publicPageShortId: string;
  status: string;
  updatedAt: Date;
  publishedAt?: Date | null;
  deletedAt: Date | null;
  novelStatus: string;
  promoLink: FakePromoLink;
  /**
   * C-29b: defaults to `"novel_article"` when omitted. Set to `"blog_article"`
   * (or another blog-family value) to seed a blog-shaped row — a blog row's
   * returned object carries no `novel`/`promoLink`/`novelId` fields at all,
   * the same discriminated-branch shape production
   * `loadIndexNowCandidateArticle` (`src/lib/indexnow/eligibility.ts`) uses.
   */
  articleType?: string;
  seoVisibility?: string;
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

export type FakeGenericTaskItem = {
  id: string;
  taskId: string;
  targetType: string;
  targetId: string;
  status: string;
  payload: unknown;
};
export type FakeGenericTask = {
  id: string;
  taskType: string;
  status: string;
  operationScopeHash: string;
  requestToken?: string;
  params?: unknown;
  totalCount?: number;
};

export type FakeAudit = {
  id: bigint;
  actorType: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  requestId: string | null;
  taskType: string | null;
  taskId: string | null;
  reason: string | null;
  beforeSnapshot: unknown;
  afterSnapshot: unknown;
  createdAt: Date;
};

type Row = Record<string, any>;

let nextId = 1;
function freshId(prefix: string): string {
  nextId += 1;
  // Zero-padded so that string order == creation order (FIFO tie-breaks sort by id).
  return `${prefix}-${String(nextId).padStart(8, "0")}`;
}

export type FakeSiteSetting = { indexNowHost: string; indexNowKey: string; indexNowKeyLocation: string; updatedAt: Date };

/** Host equals `TEST_SITE_URL`'s host so the B-41 host-consistency check passes by default. */
const DEFAULT_SITE_SETTING: FakeSiteSetting = {
  indexNowHost: "cps-novel.example",
  indexNowKey: "test-index-now-key",
  indexNowKeyLocation: "https://cps-novel.example/test-index-now-key.txt",
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

// ---------------------------------------------------------------------------
// Generic query engine
// ---------------------------------------------------------------------------

function norm(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value;
}

function eq(a: unknown, b: unknown): boolean {
  const x = norm(a);
  const y = norm(b);
  if ((x === null || x === undefined) && (y === null || y === undefined)) return true;
  return x === y;
}

function compare(a: unknown, b: unknown): number {
  const x = norm(a) as any;
  const y = norm(b) as any;
  if (x === y) return 0;
  if (x === null || x === undefined) return -1;
  if (y === null || y === undefined) return 1;
  return x < y ? -1 : 1;
}

function matchCondition(value: unknown, condition: unknown): boolean {
  if (condition === null) return value === null || value === undefined;
  if (condition instanceof Date || typeof condition !== "object") return eq(value, condition);
  for (const [operator, operand] of Object.entries(condition as Row)) {
    switch (operator) {
      case "equals":
        if (!eq(value, operand)) return false;
        break;
      case "in":
        if (!(operand as unknown[]).some((candidate) => eq(value, candidate))) return false;
        break;
      case "notIn":
        if ((operand as unknown[]).some((candidate) => eq(value, candidate))) return false;
        break;
      case "not":
        if (operand === null ? value === null || value === undefined : matchCondition(value, operand)) return false;
        break;
      case "lt":
      case "lte":
      case "gt":
      case "gte": {
        if (value === null || value === undefined) return false;
        const c = compare(value, operand);
        if (operator === "lt" && !(c < 0)) return false;
        if (operator === "lte" && !(c <= 0)) return false;
        if (operator === "gt" && !(c > 0)) return false;
        if (operator === "gte" && !(c >= 0)) return false;
        break;
      }
      default:
        throw new Error(`fake-db: unsupported filter operator "${operator}"`);
    }
  }
  return true;
}

type RelationResolver = (row: Row) => Row[];

function matchesWhere(row: Row, where: Row | undefined, relations: Record<string, RelationResolver>): boolean {
  if (!where) return true;
  for (const [key, condition] of Object.entries(where)) {
    if (condition === undefined) continue;
    if (key === "AND") {
      const list = Array.isArray(condition) ? condition : [condition];
      if (!list.every((sub) => matchesWhere(row, sub, relations))) return false;
    } else if (key === "OR") {
      if (!(condition as Row[]).some((sub) => matchesWhere(row, sub, relations))) return false;
    } else if (key === "NOT") {
      const list = Array.isArray(condition) ? condition : [condition];
      if (list.some((sub) => matchesWhere(row, sub, relations))) return false;
    } else if (relations[key]) {
      const related = relations[key]!(row);
      const spec = condition as Row;
      if ("some" in spec) {
        if (!related.some((candidate) => matchesWhere(candidate, spec.some, {}))) return false;
      } else if (!related.some((candidate) => matchesWhere(candidate, spec.is ?? spec, {}))) {
        return false;
      }
    } else if (!matchCondition(row[key], condition)) {
      return false;
    }
  }
  return true;
}

function sortRows(rows: Row[], orderBy: unknown): Row[] {
  if (!orderBy) return rows;
  const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Row[];
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      const [field, direction] = Object.entries(spec)[0]!;
      const c = compare(a[field], b[field]);
      if (c !== 0) return direction === "desc" ? -c : c;
    }
    return 0;
  });
}

function applyData(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (value !== null && typeof value === "object" && !(value instanceof Date) && "increment" in value) {
      row[key] = (row[key] as number) + (value as { increment: number }).increment;
    } else {
      row[key] = value;
    }
  }
}

function uniqueViolation(fields: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`Unique constraint failed on the fields: (${fields})`, {
    code: "P2002",
    clientVersion: "test",
  });
}

class Table<T extends Row> {
  constructor(
    readonly store: Map<string, T>,
    private readonly owner: FakeIndexNowDb,
    private readonly options: {
      keyOf: (row: T) => string;
      relations?: Record<string, RelationResolver>;
      /** Fills defaults and runs unique checks; returns the row to insert. */
      build: (data: Row, existing: readonly T[]) => T;
      /** Post-processing for `select` (e.g. relation selects). */
      project?: (row: T, select: Row) => Row;
    },
  ) {}

  private all(): T[] {
    return [...this.store.values()];
  }

  private filtered(where?: Row): T[] {
    return this.all().filter((row) => matchesWhere(row, where, this.options.relations ?? {}));
  }

  private shape(row: T, select?: Row): Row {
    const copy = { ...row } as Row;
    return this.options.project && select ? this.options.project(row, select) : copy;
  }

  findMany = async (args: { where?: Row; orderBy?: unknown; take?: number; skip?: number; select?: Row; distinct?: string[] } = {}) => {
    let rows = sortRows(this.filtered(args.where), args.orderBy ?? { id: "asc" });
    if (args.distinct?.length) {
      const seen = new Set<string>();
      rows = rows.filter((row) => {
        const key = args.distinct!.map((field) => String(row[field])).join("|");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    if (args.skip) rows = rows.slice(args.skip);
    if (args.take !== undefined) rows = rows.slice(0, args.take);
    return rows.map((row) => this.shape(row as T, args.select));
  };

  findFirst = async (args: { where?: Row; orderBy?: unknown; select?: Row } = {}) => {
    const rows = await this.findMany({ ...args, take: 1 });
    return rows[0] ?? null;
  };

  findUnique = async (args: { where: Row; select?: Row }) => this.findFirst({ where: args.where, select: args.select });

  count = async (args: { where?: Row } = {}) => this.filtered(args.where).length;

  groupBy = async (args: { by: string[]; where?: Row; _count?: unknown; orderBy?: unknown }) => {
    const groups = new Map<string, { key: Row; count: number }>();
    for (const row of this.filtered(args.where)) {
      const key = Object.fromEntries(args.by.map((field) => [field, row[field] ?? null]));
      const id = args.by.map((field) => String(row[field] ?? null)).join("|");
      const group = groups.get(id) ?? { key, count: 0 };
      group.count++;
      groups.set(id, group);
    }
    return [...groups.values()].map((group) => ({ ...group.key, _count: { _all: group.count } }));
  };

  create = async (args: { data: Row; select?: Row }) => {
    this.owner.writes++;
    const row = this.options.build(args.data, this.all());
    this.store.set(this.options.keyOf(row), row);
    return this.shape(row, args.select);
  };

  createMany = async (args: { data: Row[]; skipDuplicates?: boolean }) => {
    this.owner.writes++;
    let count = 0;
    for (const data of args.data) {
      try {
        const row = this.options.build(data, this.all());
        this.store.set(this.options.keyOf(row), row);
        count++;
      } catch (error) {
        if (args.skipDuplicates && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") continue;
        throw error;
      }
    }
    return { count };
  };

  update = async (args: { where: Row; data: Row; select?: Row }) => {
    this.owner.writes++;
    const row = this.filtered(args.where)[0];
    if (!row) throw new Error(`fake-db: update target not found: ${JSON.stringify(args.where, (_k, v) => (typeof v === "bigint" ? String(v) : v))}`);
    applyData(row, args.data);
    if ("updatedAt" in row && !("updatedAt" in args.data)) (row as Row).updatedAt = this.owner.clock();
    return this.shape(row, args.select);
  };

  updateMany = async (args: { where?: Row; data: Row }) => {
    this.owner.writes++;
    const rows = this.filtered(args.where);
    for (const row of rows) {
      applyData(row, args.data);
      if ("updatedAt" in row && !("updatedAt" in args.data)) (row as Row).updatedAt = this.owner.clock();
    }
    return { count: rows.length };
  };
}

// ---------------------------------------------------------------------------
// The double
// ---------------------------------------------------------------------------

export class FakeIndexNowDb {
  readonly articles = new Map<string, FakeArticle>();
  readonly outbox = new Map<string, FakeOutboxRow>();
  readonly attempts = new Map<string, FakeAttempt>();
  readonly genericTasks = new Map<string, FakeGenericTask>();
  readonly genericTaskItems = new Map<string, FakeGenericTaskItem>();
  readonly audits = new Map<string, FakeAudit>();
  siteSettingRow: FakeSiteSetting | null = { ...DEFAULT_SITE_SETTING };

  /** The "database clock". Replace with `setNow`/`advance` for deterministic time. */
  clock: () => Date = () => new Date();
  /** Number of mutating calls so far. */
  writes = 0;
  private attemptSeq = 1;
  private auditSeq = 1;

  setNow(date: Date): this {
    this.clock = () => new Date(date.getTime());
    return this;
  }

  advance(ms: number): this {
    const current = this.clock();
    return this.setNow(new Date(current.getTime() + ms));
  }

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
      articleType: article.articleType ?? "novel_article",
    });
    return this;
  }

  seedOutbox(row: Partial<FakeOutboxRow> & { id: string; url: string; revision: bigint }): this {
    const now = row.createdAt ?? new Date();
    this.outbox.set(row.id, this.outboxDefaults({ ...row }, now));
    return this;
  }

  private outboxDefaults(row: Partial<FakeOutboxRow> & { id: string; url: string; revision: bigint }, now: Date): FakeOutboxRow {
    return {
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
    };
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

  seedAudit(audit: Partial<FakeAudit> & { action: string; entityId: string }): FakeAudit {
    const id = BigInt(this.auditSeq++);
    const full: FakeAudit = {
      actorType: "worker",
      actorId: null,
      entityType: "indexnow_delivery",
      requestId: null,
      taskType: null,
      taskId: null,
      reason: null,
      beforeSnapshot: null,
      afterSnapshot: null,
      createdAt: this.clock(),
      ...audit,
      id,
    };
    this.audits.set(String(id), full);
    return full;
  }

  /** Deep copy of every store, for "this path changed nothing" assertions and transaction rollback. */
  snapshot() {
    return structuredClone({
      articles: this.articles,
      outbox: this.outbox,
      attempts: this.attempts,
      genericTasks: this.genericTasks,
      genericTaskItems: this.genericTaskItems,
      audits: this.audits,
    });
  }

  private restore(snapshot: ReturnType<FakeIndexNowDb["snapshot"]>): void {
    for (const key of ["articles", "outbox", "attempts", "genericTasks", "genericTaskItems", "audits"] as const) {
      const target = this[key] as Map<string, unknown>;
      target.clear();
      for (const [id, row] of snapshot[key] as Map<string, unknown>) target.set(id, row);
    }
  }

  // ---- tables ----------------------------------------------------------

  private articleTable = new Table<Row>(this.articles as unknown as Map<string, Row>, this, {
    keyOf: (row) => row.id,
    build: () => {
      throw new Error("fake-db: article writes are not supported");
    },
    // Mirrors the discriminated-branch shape of production's article select.
    project: (article, select) => {
      const articleType = article.articleType ?? "novel_article";
      const base: Row = {
        id: article.id,
        locale: article.locale,
        slug: article.slug,
        status: article.status,
        updatedAt: article.updatedAt,
        publishedAt: article.publishedAt ?? null,
        seoVisibility: article.seoVisibility,
        articleType,
        publicPageShortId: article.publicPageShortId,
      };
      if (articleType === "novel_article") {
        base.novelId = article.novelId;
        base.novel = { status: article.novelStatus };
        base.promoLink = article.promoLink;
      }
      void select;
      return base;
    },
  });

  private outboxTable = new Table<Row>(this.outbox as unknown as Map<string, Row>, this, {
    keyOf: (row) => row.id,
    relations: {
      attempts: (row) => [...this.attempts.values()].filter((attempt) => attempt.outboxId === row.id),
    },
    build: (data, existing) => {
      if (existing.some((row) => row.url === data.url && row.revision === data.revision)) {
        throw uniqueViolation("`url`,`revision`");
      }
      const now = this.clock();
      return this.outboxDefaults(
        {
          id: freshId("outbox"),
          articleId: null,
          ...(data as { url: string; revision: bigint }),
          availableAt: (data.availableAt as Date | null) ?? null,
          deferReason: (data.deferReason as string | null) ?? null,
          createdAt: now,
          updatedAt: now,
        } as Partial<FakeOutboxRow> & { id: string; url: string; revision: bigint },
        now,
      ) as Row as FakeOutboxRow;
    },
    project: (row, select) => {
      const out: Row = { ...row };
      if (select.attempts) {
        const spec = select.attempts === true ? {} : (select.attempts as Row);
        let list: Row[] = [...this.attempts.values()].filter((attempt) => attempt.outboxId === row.id && matchesWhere(attempt, spec.where, {}));
        list = sortRows(list, spec.orderBy);
        if (spec.take !== undefined) list = list.slice(0, spec.take);
        out.attempts = list.map((attempt) => ({ ...attempt }));
      }
      return out;
    },
  });

  private attemptTable = new Table<Row>(this.attempts as unknown as Map<string, Row>, this, {
    keyOf: (row) => String(row.id),
    build: (data, existing) => {
      if (existing.some((row) => row.outboxId === data.outboxId && row.attemptNo === data.attemptNo)) {
        throw uniqueViolation("`outbox_id`,`attempt_no`");
      }
      const id = BigInt(this.attemptSeq++);
      const now = this.clock();
      return {
        outcome: "started",
        attemptState: "started",
        startedAt: now,
        requestAt: now,
        responseAt: null,
        httpStatus: null,
        errorKind: null,
        responseSummary: null,
        batchSize: 1,
        workerTaskId: null,
        ...data,
        id,
      };
    },
  });

  private auditTable = new Table<Row>(this.audits as unknown as Map<string, Row>, this, {
    keyOf: (row) => String(row.id),
    build: (data, existing) => {
      if (
        data.actorType === "admin" &&
        data.requestId &&
        existing.some((row) => row.actorType === "admin" && row.requestId === data.requestId && row.action === data.action)
      ) {
        throw uniqueViolation("`request_id`,`action`");
      }
      const id = BigInt(this.auditSeq++);
      return {
        actorId: null,
        requestId: null,
        taskType: null,
        taskId: null,
        reason: null,
        beforeSnapshot: null,
        afterSnapshot: null,
        ...data,
        id,
        createdAt: this.clock(),
      };
    },
  });

  private taskTable = new Table<Row>(this.genericTasks as unknown as Map<string, Row>, this, {
    keyOf: (row) => row.id,
    build: (data, existing) => {
      const status = (data.status as string | undefined) ?? "pending";
      const active = status === "pending" || status === "processing";
      if (existing.some((row) => data.requestToken && row.requestToken === data.requestToken)) {
        throw uniqueViolation("`request_token`");
      }
      if (
        active &&
        existing.some(
          (row) =>
            (row.status === "pending" || row.status === "processing") &&
            row.taskType === data.taskType &&
            row.operationScopeHash === data.operationScopeHash,
        )
      ) {
        // generic_task_active_scope_uidx
        throw uniqueViolation("`task_type`,`channel_account_id`,`channel_app_id`,`operation_scope_hash`");
      }
      return { status, ...data, id: (data.id as string | undefined) ?? freshId("task") };
    },
  });

  private itemTable = new Table<Row>(this.genericTaskItems as unknown as Map<string, Row>, this, {
    keyOf: (row) => row.id,
    relations: { task: (row) => [this.genericTasks.get(row.taskId) as Row].filter(Boolean) },
    build: (data, existing) => {
      if (existing.some((row) => row.taskId === data.taskId && row.targetType === data.targetType && row.targetId === data.targetId)) {
        throw uniqueViolation("`task_id`,`target_type`,`target_id`");
      }
      return { status: "pending", ...data, id: freshId("item") };
    },
  });

  private genericTask = {
    findFirst: this.taskTable.findFirst,
    findMany: this.taskTable.findMany,
    count: this.taskTable.count,
    groupBy: this.taskTable.groupBy,
    createMany: this.taskTable.createMany,
    create: async (args: { data: Row & { items?: { create?: Row[] } } }) => {
      const { items, ...data } = args.data;
      const created = (await this.taskTable.create({ data })) as { id: string };
      if (items?.create?.length) {
        await this.itemTable.createMany({ data: items.create.map((item) => ({ ...item, taskId: created.id })) });
      }
      return { id: created.id };
    },
  };

  // ---- clients ---------------------------------------------------------

  private rawResult(query: unknown): unknown[] {
    const text =
      typeof query === "string"
        ? query
        : Array.isArray(query)
          ? (query as string[]).join("?")
          : ((query as { strings?: string[]; sql?: string }).strings?.join("?") ?? (query as { sql?: string }).sql ?? "");
    if (text.includes("clock_timestamp() AS now")) return [{ now: this.clock() }];
    if (text.includes("pg_advisory_xact_lock")) return [{ lock_result: "" }];
    if (text === INDEXNOW_CONTROL_STATE_SQL || text.includes("/* indexnow:control-state */")) return [this.controlStateRow()];
    throw new Error(`fake-db: unsupported raw SQL: ${text.slice(0, 120)}`);
  }

  /** JS mimic of `INDEXNOW_CONTROL_STATE_SQL` (ordering by id, never created_at). */
  private controlStateRow(): Row {
    const dbNow = this.clock();
    const stream = (entityId: string) =>
      [...this.audits.values()].filter((row) => row.entityType === "indexnow_delivery" && row.entityId === entityId).sort((a, b) => compare(a.id, b.id));
    const breaker = stream("breaker");
    const rate = stream("rate_limit");
    const bisect = stream("bisect");
    const lastBreaker = breaker[breaker.length - 1] ?? null;
    const resumes = breaker.filter((row) => row.action === "indexnow.delivery.breaker_resume");
    const lastResume = resumes[resumes.length - 1] ?? null;
    const lastResumeId = lastResume ? lastResume.id : 0n;
    const tripsSinceResume = breaker.filter((row) => row.action === "indexnow.delivery.breaker_trip" && row.id > lastResumeId);
    const firstTrip = tripsSinceResume[0] ?? null;
    const lastRate = rate[rate.length - 1] ?? null;
    const waitUntil = lastRate ? ((lastRate.afterSnapshot as Row | null)?.waitUntil as string | undefined) : undefined;
    const lastBisect = bisect[bisect.length - 1] ?? null;
    return {
      db_now: dbNow,
      last_breaker_id: lastBreaker?.id ?? null,
      last_breaker_action: lastBreaker?.action ?? null,
      last_resume_id: lastResume?.id ?? null,
      last_resume_actor_id: lastResume?.actorId ?? null,
      last_resume_reason: lastResume?.reason ?? null,
      last_resume_created_at: lastResume?.createdAt ?? null,
      last_resume_after: lastResume?.afterSnapshot ?? null,
      first_trip_id: firstTrip?.id ?? null,
      first_trip_after: firstTrip?.afterSnapshot ?? null,
      first_trip_created_at: firstTrip?.createdAt ?? null,
      trip_events_since_resume: tripsSinceResume.length,
      last_rate_id: lastRate?.id ?? null,
      last_rate_after: lastRate?.afterSnapshot ?? null,
      rate_waiting: waitUntil ? new Date(waitUntil).getTime() > dbNow.getTime() : false,
      last_bisect_id: lastBisect?.id ?? null,
      last_bisect_after: lastBisect?.afterSnapshot ?? null,
      last_bisect_created_at: lastBisect?.createdAt ?? null,
    };
  }

  private clientBody() {
    return {
      article: { findFirst: this.articleTable.findFirst, findMany: this.articleTable.findMany },
      indexNowOutbox: {
        create: this.outboxTable.create,
        findUnique: this.outboxTable.findUnique,
        findFirst: this.outboxTable.findFirst,
        findMany: this.outboxTable.findMany,
        count: this.outboxTable.count,
        groupBy: this.outboxTable.groupBy,
        update: this.outboxTable.update,
        updateMany: this.outboxTable.updateMany,
      },
      indexNowOutboxAttempt: {
        create: this.attemptTable.create,
        createMany: this.attemptTable.createMany,
        update: this.attemptTable.update,
        updateMany: this.attemptTable.updateMany,
        findMany: this.attemptTable.findMany,
        findFirst: this.attemptTable.findFirst,
        count: this.attemptTable.count,
        groupBy: this.attemptTable.groupBy,
      },
      genericTask: this.genericTask,
      genericTaskItem: {
        findMany: this.itemTable.findMany,
        findFirst: this.itemTable.findFirst,
        count: this.itemTable.count,
        groupBy: this.itemTable.groupBy,
        createMany: this.itemTable.createMany,
      },
      operationAudit: {
        create: this.auditTable.create,
        findFirst: this.auditTable.findFirst,
        findMany: this.auditTable.findMany,
        count: this.auditTable.count,
      },
      siteSetting: {
        findUnique: async () => (this.siteSettingRow ? { ...this.siteSettingRow } : null),
      },
      $queryRaw: async (query: unknown) => this.rawResult(query),
      $queryRawUnsafe: async (query: string) => this.rawResult(query),
    };
  }

  /** A transaction client: no `$transaction`, exactly like Prisma's. */
  asTransactionClient(): Prisma.TransactionClient {
    return this.clientBody() as unknown as Prisma.TransactionClient;
  }

  asPrismaClient(): PrismaClient {
    const tx = this.asTransactionClient();
    return {
      ...this.clientBody(),
      $transaction: async <R>(fn: (client: Prisma.TransactionClient) => Promise<R>) => {
        const before = this.snapshot();
        try {
          return await fn(tx);
        } catch (error) {
          this.restore(before);
          throw error;
        }
      },
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

export const TEST_SITE_URL = "https://cps-novel.example";

/**
 * the shared `site-url.ts`'s `toAbsoluteUrl`/`normalizeCanonicalUrl` read
 * `process.env.SITE_URL` directly with no injectable override for callers
 * that go through `buildIndexNowCanonicalUrl` (`outbox.ts`, the worker
 * handler) — since `SiteUrlConfigurationError` is now thrown (not a default
 * domain) when it is unset, every test file exercising those call paths
 * must set it. Call this once at module scope in such a file; it registers
 * `beforeEach`/`afterEach` against that file's root suite (a file importing
 * and calling this synchronously during collection is the same pattern as
 * defining hooks directly in the file).
 */
export function installTestSiteUrl(url: string = TEST_SITE_URL): void {
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.SITE_URL;
    process.env.SITE_URL = url;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.SITE_URL;
    else process.env.SITE_URL = previous;
  });
}
