/**
 * TEST_ONLY — hand-rolled in-memory doubles for exactly the Prisma call
 * shapes `src/server/home-carousel/service.ts` and
 * `src/lib/site/home-carousel-service.ts` issue, plus the admin-auth
 * fixtures needed to call the service layer's mutations directly. Same
 * design as `tests/backend/tasks/promo-link-claim-factory-fake-db.ts` and
 * `tests/backend/site-settings/write-service.test.ts`'s `FakeSiteSettingDb`.
 */
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

import { hashAdminSessionToken } from "@/lib/auth/session";
import type { AdminIdentity, AdminSessionRecord } from "@/lib/auth/types";
import { requireAdminActionAccess, type AdminServiceAuthorization } from "@/server/auth/guards";
import { P2_04_ADMIN_REGISTRY } from "@/app/api/admin/_lib/registry";

import { TestOnlyInMemoryAuthStores } from "../auth/test-only-in-memory-stores";

export const NOW = new Date("2026-09-05T03:00:00.000Z");
export const TOKEN = "home-carousel-fixture-session";
const ORIGIN = "https://admin.example.com";

export type FakeArticle = {
  id: string;
  novelId: string;
  locale: string;
  status: string;
  deletedAt: Date | null;
  publishedAt: Date | null;
  updatedAt: Date;
  /** C-25. Optional — defaults to `"public"` so every pre-existing fixture in this suite is unaffected. */
  seoVisibility?: "public" | "seo_only" | "hidden";
  novel: { title: string; status: string; deletedAt: Date | null; coverUrl: string | null };
};

export type FakeManualSlot = {
  id: string;
  locale: string;
  position: number;
  novelId: string;
  articleId: string;
  enabled: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  deletedAt: Date | null;
  createdBy: string;
  updatedBy: string;
};

function prismaUniqueError(target: string): InstanceType<typeof Prisma.PrismaClientKnownRequestError> {
  return new Prisma.PrismaClientKnownRequestError(`Unique constraint failed on ${target}`, {
    code: "P2002",
    clientVersion: "test",
    meta: { target: [target] },
  });
}

/**
 * In-memory double for the Prisma calls issued by `computeHomeCarouselInTx`,
 * `upsertHomeCarouselManualSlot`, `deleteHomeCarouselManualSlot`,
 * `updateHomeCarouselConfig`, and `enqueueHomeCarouselCompute`. `$transaction`
 * simply invokes the callback with the same client (no real isolation) —
 * sufficient for exercising this module's own branching, not for testing the
 * generic scheduler/task-lease framework (covered separately by
 * `tests/integration/tasks/p1-07-postgres.test.ts` against real PostgreSQL).
 */
export type FakeServingRow = { id: string; locale: string; position: number; novelId: string; articleId: string; source: string; manualSlotId: string | null; batchId: string | null; mergedAt: Date };

export class FakeHomeCarouselDb {
  carouselConfigJson: unknown = {};
  readonly articles = new Map<string, FakeArticle>();
  readonly manualSlots = new Map<string, FakeManualSlot>();
  readonly batches = new Map<string, { id: string; uniqueKey: string; status: string; finishedAt: Date | null; [key: string]: unknown }>();
  readonly candidates: Array<Record<string, unknown>> = [];
  readonly serving: FakeServingRow[] = [];
  readonly changeLog: Array<Record<string, unknown>> = [];
  readonly audits: Array<Record<string, unknown>> = [];
  readonly genericTasks = new Map<string, Record<string, unknown>>();
  readonly calls: string[] = [];

  seedArticle(article: FakeArticle): this {
    this.articles.set(article.id, article);
    return this;
  }

  seedManualSlot(slot: FakeManualSlot): this {
    this.manualSlots.set(slot.id, slot);
    return this;
  }

  private client() {
    return {
      siteSetting: {
        findUnique: async () => {
          this.calls.push("siteSetting.findUnique");
          return { carouselConfigJson: this.carouselConfigJson };
        },
        upsert: async (args: { create: { carouselConfigJson: unknown }; update: { carouselConfigJson: unknown } }) => {
          this.calls.push("siteSetting.upsert");
          this.carouselConfigJson = args.update.carouselConfigJson ?? args.create.carouselConfigJson;
          return { id: 1, carouselConfigJson: this.carouselConfigJson };
        },
      },
      article: {
        findMany: async (args: { where?: { AND?: Array<Record<string, unknown>> }; take: number }) => {
          this.calls.push("article.findMany");
          // C-25 review fix: `computeHomeCarouselInTx` now spreads
          // `buildPublicListArticleWhere(...)` into this call's `where` —
          // that helper only adds a `seoVisibility: "public"` clause to its
          // `AND` array while `FEATURE_ARTICLE_SEO_VISIBILITY` is on (see
          // `src/server/publication/visibility.ts`). This fake has no real
          // Prisma engine to evaluate `where` against, so it detects that
          // clause the same way the rest of this hand-rolled double mirrors
          // the production query shape, rather than re-implementing generic
          // Prisma `where` matching.
          const seoVisibilityGated = Array.isArray(args.where?.AND)
            && args.where.AND.some((clause) => clause.seoVisibility === "public");
          const rows = [...this.articles.values()]
            .filter((row) => row.status === "published" && row.deletedAt === null && row.novel.status === "published" && row.novel.deletedAt === null && !!row.novel.coverUrl)
            .filter((row) => !seoVisibilityGated || (row.seoVisibility ?? "public") === "public")
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0) || a.id.localeCompare(b.id));
          return rows.slice(0, args.take).map((row) => ({ id: row.id, novelId: row.novelId, publishedAt: row.publishedAt, updatedAt: row.updatedAt, novel: { coverUrl: row.novel.coverUrl } }));
        },
        findFirst: async (args: { where: { id: string; locale: string } }) => {
          this.calls.push("article.findFirst");
          const row = this.articles.get(args.where.id);
          if (!row || row.locale !== args.where.locale || row.status !== "published" || row.deletedAt !== null) return null;
          if (row.novel.status !== "published" || row.novel.deletedAt !== null || !row.novel.coverUrl) return null;
          return { id: row.id, novelId: row.novelId };
        },
      },
      homeCarouselManualSlot: {
        findMany: async (args: { where: { locale: string }; take: number }) => {
          this.calls.push("homeCarouselManualSlot.findMany");
          const now = NOW;
          const rows = [...this.manualSlots.values()]
            .filter((row) => row.locale === args.where.locale && row.enabled && row.deletedAt === null)
            .filter((row) => row.startsAt === null || row.startsAt.getTime() <= now.getTime())
            .filter((row) => row.endsAt === null || row.endsAt.getTime() > now.getTime())
            .sort((a, b) => a.position - b.position);
          return rows.slice(0, args.take);
        },
        create: async (args: { data: Omit<FakeManualSlot, "id" | "deletedAt" | "startsAt" | "endsAt"> & Partial<Pick<FakeManualSlot, "startsAt" | "endsAt">> }) => {
          this.calls.push("homeCarouselManualSlot.create");
          const row: FakeManualSlot = { id: randomUUID(), deletedAt: null, startsAt: null, endsAt: null, ...args.data };
          this.manualSlots.set(row.id, row);
          return row;
        },
        update: async (args: { where: { id: string }; data: Partial<FakeManualSlot> }) => {
          this.calls.push("homeCarouselManualSlot.update");
          const existing = this.manualSlots.get(args.where.id);
          if (!existing) throw new Error(`manual slot not found: ${args.where.id}`);
          const updated = { ...existing, ...args.data };
          this.manualSlots.set(existing.id, updated);
          return updated;
        },
      },
      homeCarouselAutoBatch: {
        create: async (args: { data: { uniqueKey: string; [key: string]: unknown } }) => {
          this.calls.push("homeCarouselAutoBatch.create");
          if ([...this.batches.values()].some((batch) => batch.uniqueKey === args.data.uniqueKey)) {
            throw prismaUniqueError("home_carousel_auto_batch_unique_key_key");
          }
          const row = { id: randomUUID(), finishedAt: null as Date | null, ...args.data } as { id: string; uniqueKey: string; status: string; finishedAt: Date | null; [key: string]: unknown };
          this.batches.set(row.id, row);
          return row;
        },
        update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          this.calls.push("homeCarouselAutoBatch.update");
          const existing = this.batches.get(args.where.id);
          if (!existing) throw new Error(`batch not found: ${args.where.id}`);
          Object.assign(existing, args.data);
          return existing;
        },
      },
      homeCarouselAutoCandidate: {
        createMany: async (args: { data: Array<Record<string, unknown>> }) => {
          this.calls.push("homeCarouselAutoCandidate.createMany");
          this.candidates.push(...args.data);
          return { count: args.data.length };
        },
      },
      homeCarouselServing: {
        deleteMany: async (args: { where: { locale: string } }) => {
          this.calls.push("homeCarouselServing.deleteMany");
          const before = this.serving.length;
          for (let i = this.serving.length - 1; i >= 0; i -= 1) if (this.serving[i].locale === args.where.locale) this.serving.splice(i, 1);
          return { count: before - this.serving.length };
        },
        createMany: async (args: { data: Array<Omit<FakeServingRow, "id">> }) => {
          this.calls.push("homeCarouselServing.createMany");
          for (const row of args.data) this.serving.push({ id: randomUUID(), ...row });
          return { count: args.data.length };
        },
      },
      homeCarouselChangeLog: {
        create: async (args: { data: Record<string, unknown> }) => {
          this.calls.push("homeCarouselChangeLog.create");
          this.changeLog.push(args.data);
          return { id: BigInt(this.changeLog.length), ...args.data };
        },
      },
      operationAudit: {
        create: async (args: { data: Record<string, unknown> }) => {
          this.calls.push("operationAudit.create");
          this.audits.push(args.data);
          return { id: BigInt(this.audits.length) };
        },
      },
      genericTask: {
        findFirst: async (args: { where: { taskType: string; operationScopeHash: string; status: { in: string[] } } }) => {
          this.calls.push("genericTask.findFirst");
          const row = [...this.genericTasks.values()].find(
            (task) => task.taskType === args.where.taskType && task.operationScopeHash === args.where.operationScopeHash && args.where.status.in.includes(task.status as string),
          );
          return row ? { id: row.id as string } : null;
        },
        create: async (args: { data: Record<string, unknown> }) => {
          this.calls.push("genericTask.create");
          const id = randomUUID();
          const row = { id, status: "pending", ...args.data };
          this.genericTasks.set(id, row);
          return row;
        },
      },
      $transaction: async <T>(run: (tx: unknown) => Promise<T>): Promise<T> => run(this.client()),
    };
  }

  asPrismaClient(): PrismaClient {
    return this.client() as unknown as PrismaClient;
  }

  /** Cast for functions typed against `Prisma.TransactionClient` directly (e.g. `computeHomeCarouselInTx`'s `tx`). */
  asTransactionClient(): Prisma.TransactionClient {
    return this.client() as unknown as Prisma.TransactionClient;
  }
}

/** Grants `settings:manage` — the capability every `admin.home_carousel.*` action requires. */
export function authFixture() {
  const stores = new TestOnlyInMemoryAuthStores();
  const identity: AdminIdentity = {
    id: "admin-1",
    username: "admin",
    role: "super_admin",
    status: "active",
    sessionVersion: 1,
    twoFactorEnabled: true,
  };
  const issuedAt = new Date(NOW.getTime() - 60 * 60 * 1000);
  const session: AdminSessionRecord = {
    id: "session-1",
    tokenHash: hashAdminSessionToken(TOKEN),
    identityId: identity.id,
    sessionVersion: 1,
    issuedAt,
    lastSeenAt: new Date(NOW.getTime() - 60_000),
    absoluteExpiresAt: new Date(NOW.getTime() + 23 * 60 * 60 * 1000),
    twoFactorCompletedAt: new Date(NOW.getTime() - 30_000),
    revokedAt: null,
  };
  stores.identities.set(identity.id, identity);
  stores.sessions.set(session.id, session);
  return { stores, identity, session };
}

/**
 * Mints a real, guard-issued `AdminServiceAuthorization` for `actionId` by
 * running it through `requireAdminActionAccess` against the actual admin
 * action registry (`P2_04_ADMIN_REGISTRY`, read-only here) — the same path
 * `_actions.ts` uses. This is what makes the capability-mismatch mutation
 * tests meaningful: the authorization really was minted for the registry's
 * declared capability, so a service function that asks
 * `requireFreshAdminServiceMutation` for a *different* capability fails for
 * the same reason production would.
 */
export async function authorizeAction(
  stores: TestOnlyInMemoryAuthStores,
  actionId: `admin.home_carousel.${string}`,
  requestId = "550e8400-e29b-41d4-a716-446655440000",
): Promise<{ authorization: AdminServiceAuthorization; requestId: string }> {
  const guarded = await requireAdminActionAccess(
    { actionId, sessionToken: TOKEN, origin: ORIGIN, canonicalOrigin: ORIGIN, requestId },
    { identities: stores, sessions: stores, registry: P2_04_ADMIN_REGISTRY, now: NOW, env: {} as NodeJS.ProcessEnv },
  );
  if (!guarded.serviceAuthorization) throw new Error(`admin action ${actionId} issued no service authorization`);
  return { authorization: guarded.serviceAuthorization, requestId };
}

export function dependencies(db: FakeHomeCarouselDb, stores: TestOnlyInMemoryAuthStores) {
  return { db: db.asPrismaClient(), identities: stores, sessions: stores, now: NOW, env: {} as NodeJS.ProcessEnv };
}
