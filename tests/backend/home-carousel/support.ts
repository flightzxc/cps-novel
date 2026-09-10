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
import { CAROUSEL_BATCH_STATUSES, CAROUSEL_SOURCES } from "@/domain/database-statuses";

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
 * Mirrors what a real PostgreSQL CHECK-constraint violation looks like once
 * Prisma has surfaced it: an *unmapped* connector error, not a known `P*`
 * code — this is the exact shape the production incident this fake is
 * guarding against showed (`docs/governance/database-governance.md` §12's
 * 2026-09-11 L10N P5.2 changelog row: `sqlState`/`prismaCode`/`constraint`
 * all `null` in the Worker's own error capture). Unlike `prismaUniqueError`
 * above (a real `PrismaClientKnownRequestError` with code `P2002`, Prisma's
 * own mapping for a UNIQUE violation), Prisma has no dedicated `P*` code for
 * a raw CHECK violation raised by a plain `createMany` (as opposed to a
 * `$queryRaw`), so it comes back as `Prisma.PrismaClientUnknownRequestError`
 * — no `.code` at all.
 *
 * Generalized (carousel batch-status schema-contract-drift fix, sibling to
 * `20260912100000_carousel_serving_source_check_fix`) to take `relation`/
 * `method` instead of hardcoding `home_carousel_serving`/`createMany` — this
 * now backs the CHECK simulation on all four `home_carousel_*` tables this
 * fake models, not just `home_carousel_serving`.
 */
function prismaCheckViolationError(relation: string, method: string, constraintName: string, detail: string): InstanceType<typeof Prisma.PrismaClientUnknownRequestError> {
  return new Prisma.PrismaClientUnknownRequestError(
    `Invalid \`prisma.${method}()\` invocation: new row for relation "${relation}" violates check constraint "${constraintName}" (${detail})`,
    { clientVersion: "test" },
  );
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
  /**
   * X8 轮 2d ⑦: lets `grants-returning`-style tests in this suite simulate
   * an unseeded `site_setting` singleton (migration rolled back / seed row
   * manually deleted) without a real database — `findUnique`/`update`
   * below both key off this flag, mirroring `src/server/site-settings/
   * service.ts`'s own `SiteSettingNotSeededError` fail-closed contract.
   * `true` by default: every other fixture in this suite assumes the
   * bootstrap-seeded row is present, same as production outside that one
   * broken-migration case.
   */
  siteSettingSeeded = true;
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

  /**
   * Mirrors `carousel_manual_position_check` (`position` > 0) and
   * `carousel_manual_window_check` (`starts_at` IS NULL OR `ends_at` IS
   * NULL OR `starts_at` < `ends_at`), both from
   * `20260803090000_p1_initial_schema`. `upsertHomeCarouselManualSlot`
   * (`src/server/home-carousel/service.ts`) already rejects an out-of-range
   * `position` before ever reaching the database (`carousel_position_invalid`)
   * and never sets `startsAt`/`endsAt` at all, so neither of these should
   * ever actually fire through that code path today — this exists so the
   * fake stays a faithful CHECK simulation for any write path (present or
   * future) that reaches `homeCarouselManualSlot.create`/`.update` directly,
   * same discipline as the other three tables' CHECK mirrors below.
   */
  private assertManualSlotChecks(row: FakeManualSlot): void {
    if (!Number.isInteger(row.position) || row.position <= 0) {
      throw prismaCheckViolationError("home_carousel_manual_slot", "homeCarouselManualSlot", "carousel_manual_position_check", `position > 0, got ${row.position}`);
    }
    if (row.startsAt !== null && row.endsAt !== null && row.startsAt.getTime() >= row.endsAt.getTime()) {
      throw prismaCheckViolationError(
        "home_carousel_manual_slot", "homeCarouselManualSlot",
        "carousel_manual_window_check",
        `starts_at (${row.startsAt.toISOString()}) must be before ends_at (${row.endsAt.toISOString()})`,
      );
    }
  }

  /**
   * Mirrors the two partial unique indexes `20260803090000_p1_initial_schema`
   * installs on this table — `carousel_manual_position_active_uidx`
   * (locale, position) and `carousel_manual_novel_active_uidx` (locale,
   * novel_id), both `WHERE enabled IS TRUE AND deleted_at IS NULL` — so only
   * active (enabled, non-deleted) rows can collide, matching real Postgres
   * partial-index semantics. Skips the row's own current entry (same `id`)
   * so re-saving an unchanged active row, or the position-in-range check
   * inside `upsertHomeCarouselManualSlot` itself, never self-collides.
   */
  private assertManualSlotUniqueness(row: FakeManualSlot): void {
    if (!row.enabled || row.deletedAt !== null) return;
    for (const other of this.manualSlots.values()) {
      if (other.id === row.id) continue;
      if (!other.enabled || other.deletedAt !== null) continue;
      if (other.locale === row.locale && other.position === row.position) {
        throw prismaUniqueError("carousel_manual_position_active_uidx");
      }
      if (other.locale === row.locale && other.novelId === row.novelId) {
        throw prismaUniqueError("carousel_manual_novel_active_uidx");
      }
    }
  }

  private client() {
    return {
      siteSetting: {
        findUnique: async () => {
          this.calls.push("siteSetting.findUnique");
          if (!this.siteSettingSeeded) return null;
          return { id: 1, carouselConfigJson: this.carouselConfigJson };
        },
        /**
         * X8 轮 2d ⑦ fix: replaces the old `upsert` double. Mirrors real
         * Prisma/Postgres `update` behavior -- a `WHERE` that matches zero
         * rows throws `P2025` (`RecordNotFound`), not a silent insert.
         * `updateHomeCarouselConfig`'s own `findUnique` guard already
         * throws `SiteSettingNotSeededError` before this would ever be
         * reached in that case; this branch exists so the fake stays
         * faithful even if a future edit calls `update` directly.
         */
        update: async (args: { where: { id: number }; data: { carouselConfigJson: unknown } }) => {
          this.calls.push("siteSetting.update");
          if (!this.siteSettingSeeded) {
            throw new Prisma.PrismaClientKnownRequestError(
              "An operation failed because it depends on one or more records that were required but not found. Record to update not found.",
              { code: "P2025", clientVersion: "test" },
            );
          }
          this.carouselConfigJson = args.data.carouselConfigJson;
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
        /**
         * L10N P5 (矩阵 #13): `queryActiveLocales` (`@/lib/locale/active-locales`)
         * — the cron scheduler's own active-locale source, see
         * `service.ts`'s `buildHomeCarouselCronTaskInput` — issues one
         * `article.groupBy({ by: ["locale"], where: activePublicArticleWhere(...) })`.
         * This fake mirrors this file's own existing "published,
         * non-deleted, novel published non-deleted, optional seoVisibility
         * gate" fidelity (the same subset `article.findMany` above already
         * simulates) — it deliberately does NOT model promo-link
         * readiness (`isPromoReady`'s DB-level superset), since none of
         * this suite's fixtures set one up. Full predicate-shape coverage
         * of `queryActiveLocales` itself lives in
         * `tests/backend/locale/active-locales.test.ts`; this fake only
         * needs to produce a plausible active-locale set for the cron
         * tests in this directory, not re-verify that predicate.
         */
        groupBy: async (args: { where?: { AND?: Array<Record<string, unknown>> } }) => {
          this.calls.push("article.groupBy");
          const seoVisibilityGated = Array.isArray(args.where?.AND)
            && args.where.AND.some((clause) => clause.seoVisibility === "public");
          const rows = [...this.articles.values()]
            .filter((row) => row.status === "published" && row.deletedAt === null && row.novel.status === "published" && row.novel.deletedAt === null)
            .filter((row) => !seoVisibilityGated || (row.seoVisibility ?? "public") === "public");
          const counts = new Map<string, number>();
          for (const row of rows) counts.set(row.locale, (counts.get(row.locale) ?? 0) + 1);
          return [...counts.entries()].map(([locale, count]) => ({ locale, _count: { _all: count } }));
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
          this.assertManualSlotChecks(row);
          this.assertManualSlotUniqueness(row);
          this.manualSlots.set(row.id, row);
          return row;
        },
        update: async (args: { where: { id: string }; data: Partial<FakeManualSlot> }) => {
          this.calls.push("homeCarouselManualSlot.update");
          const existing = this.manualSlots.get(args.where.id);
          if (!existing) throw new Error(`manual slot not found: ${args.where.id}`);
          const updated = { ...existing, ...args.data };
          this.assertManualSlotChecks(updated);
          this.assertManualSlotUniqueness(updated);
          this.manualSlots.set(existing.id, updated);
          return updated;
        },
      },
      homeCarouselAutoBatch: {
        /**
         * Mirrors `home_carousel_auto_batch_status_check`
         * (`20260803090000_p1_initial_schema` — `pending`/`processing`/
         * `completed`/`failed`, unchanged since) in addition to the
         * pre-existing `unique_key` uniqueness. Carousel batch-status
         * schema-contract-drift fix: this is the CHECK
         * `computeHomeCarouselInTx`'s pre-fix `status: "success"` terminal
         * write violated — `"success"` was never a member of this set,
         * same class of bug as the sibling `home_carousel_serving.source`
         * fix (`20260912100000_carousel_serving_source_check_fix`), just on
         * this table's own status column instead of a row it produces.
         */
        create: async (args: { data: { uniqueKey: string; status?: string; [key: string]: unknown } }) => {
          this.calls.push("homeCarouselAutoBatch.create");
          if ([...this.batches.values()].some((batch) => batch.uniqueKey === args.data.uniqueKey)) {
            throw prismaUniqueError("home_carousel_auto_batch_unique_key_key");
          }
          const status = args.data.status ?? "pending";
          if (!(CAROUSEL_BATCH_STATUSES as readonly string[]).includes(status)) {
            throw prismaCheckViolationError(
              "home_carousel_auto_batch", "homeCarouselAutoBatch.create",
              "home_carousel_auto_batch_status_check",
              `status in CHECK ("status"::text = ANY (ARRAY[${CAROUSEL_BATCH_STATUSES.map((value) => `'${value}'::character varying`).join(", ")}]::text[])), got '${status}'`,
            );
          }
          const row = { id: randomUUID(), finishedAt: null as Date | null, ...args.data, status } as { id: string; uniqueKey: string; status: string; finishedAt: Date | null; [key: string]: unknown };
          this.batches.set(row.id, row);
          return row;
        },
        /**
         * X8 轮 2d ⑥ fix: `computeHomeCarouselInTx` now calls
         * `createMany({ data: [row], skipDuplicates: true })` instead of
         * `create` + catch-P2002, to avoid PostgreSQL's open-transaction-
         * abort hazard on a caught unique-constraint violation (see that
         * function's own header comment for the full reasoning). Real
         * Postgres `skipDuplicates` compiles to `INSERT ... ON CONFLICT DO
         * NOTHING`: it resolves a `unique_key` collision silently -- no
         * thrown error, the skipped row is simply absent from `count` --
         * but does NOT suppress a CHECK violation, a different failure
         * class this fake still must simulate the same way `.create`
         * above does (`home_carousel_auto_batch_status_check` is checked
         * per-row, same as `.create`, before that row is ever considered
         * for the uniqueness skip).
         */
        createMany: async (args: { data: Array<{ uniqueKey: string; status?: string; [key: string]: unknown }>; skipDuplicates?: boolean }) => {
          this.calls.push("homeCarouselAutoBatch.createMany");
          let created = 0;
          for (const data of args.data) {
            const isDuplicate = [...this.batches.values()].some((batch) => batch.uniqueKey === data.uniqueKey);
            if (isDuplicate) {
              if (args.skipDuplicates) continue;
              throw prismaUniqueError("home_carousel_auto_batch_unique_key_key");
            }
            const status = data.status ?? "pending";
            if (!(CAROUSEL_BATCH_STATUSES as readonly string[]).includes(status)) {
              throw prismaCheckViolationError(
                "home_carousel_auto_batch", "homeCarouselAutoBatch.createMany",
                "home_carousel_auto_batch_status_check",
                `status in CHECK ("status"::text = ANY (ARRAY[${CAROUSEL_BATCH_STATUSES.map((value) => `'${value}'::character varying`).join(", ")}]::text[])), got '${status}'`,
              );
            }
            const row = { id: randomUUID(), finishedAt: null as Date | null, ...data, status } as { id: string; uniqueKey: string; status: string; finishedAt: Date | null; [key: string]: unknown };
            this.batches.set(row.id, row);
            created += 1;
          }
          return { count: created };
        },
        update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          this.calls.push("homeCarouselAutoBatch.update");
          const existing = this.batches.get(args.where.id);
          if (!existing) throw new Error(`batch not found: ${args.where.id}`);
          if (typeof args.data.status === "string" && !(CAROUSEL_BATCH_STATUSES as readonly string[]).includes(args.data.status)) {
            throw prismaCheckViolationError(
              "home_carousel_auto_batch", "homeCarouselAutoBatch.update",
              "home_carousel_auto_batch_status_check",
              `status in CHECK ("status"::text = ANY (ARRAY[${CAROUSEL_BATCH_STATUSES.map((value) => `'${value}'::character varying`).join(", ")}]::text[])), got '${args.data.status}'`,
            );
          }
          Object.assign(existing, args.data);
          return existing;
        },
      },
      homeCarouselAutoCandidate: {
        /**
         * Mirrors `carousel_candidate_rank_check` (`rank` > 0) and the two
         * unique indexes `20260803090000_p1_initial_schema` installs on
         * this table — `carousel_candidate_batch_locale_rank_key`
         * (batch_id, locale, rank) and `carousel_candidate_batch_novel_key`
         * (batch_id, novel_id) — with the same all-or-nothing, validate-
         * before-commit shape `homeCarouselServing.createMany` above uses
         * (every row in `args.data` is checked against both the existing
         * table state and the rest of the same batch before any row is
         * written). No CHECK on `source` here: unlike
         * `home_carousel_serving.source`, `home_carousel_auto_candidate.source`
         * has no CHECK constraint in either migration (verified against
         * both migration files) — `CAROUSEL_SOURCES` governs it only as a
         * documented application-level convention (see that constant's doc
         * comment in `database-statuses.ts`), enforced by the static guard
         * (`tests/backend/database/carousel-check-static.test.ts`'s
         * write-site literal scan), not by this fake mirroring a
         * nonexistent database CHECK.
         */
        createMany: async (args: { data: Array<Record<string, unknown>> }) => {
          this.calls.push("homeCarouselAutoCandidate.createMany");
          // Note: deliberately not named `*LocaleRankKeys*` / `*LocaleRank*`
          // — `tests/ui/locale-canonical.test.ts`'s "没有第二张语种映射表"
          // guard flags any `const <name containing Locale> = new Set/Map/{/[`
          // declaration outside the canonical locale-registry file, and a
          // composite dedupe key that happens to *include* `locale` as one
          // of its components is not a second locale mapping table.
          const existingRankKeys = new Set(this.candidates.map((row) => `${row.batchId} ${row.locale} ${row.rank}`));
          const existingNovelKeys = new Set(this.candidates.map((row) => `${row.batchId} ${row.novelId}`));
          const seenRankKeys = new Set<string>();
          const seenNovel = new Set<string>();
          for (const row of args.data) {
            const rank = row.rank as number;
            if (!Number.isInteger(rank) || rank <= 0) {
              throw prismaCheckViolationError("home_carousel_auto_candidate", "homeCarouselAutoCandidate.createMany", "carousel_candidate_rank_check", `rank > 0, got ${rank}`);
            }
            const rankKey = `${row.batchId} ${row.locale} ${rank}`;
            if (existingRankKeys.has(rankKey) || seenRankKeys.has(rankKey)) {
              throw prismaUniqueError("carousel_candidate_batch_locale_rank_key");
            }
            seenRankKeys.add(rankKey);
            const novelKey = `${row.batchId} ${row.novelId}`;
            if (existingNovelKeys.has(novelKey) || seenNovel.has(novelKey)) {
              throw prismaUniqueError("carousel_candidate_batch_novel_key");
            }
            seenNovel.add(novelKey);
          }
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
        /**
         * Mirrors the three constraints `20260803090000_p1_initial_schema`
         * (position/uniqueness) and `20260912100000_carousel_serving_source_check_fix`
         * (source) install on `home_carousel_serving`, in the same
         * all-or-nothing shape a real single multi-row PostgreSQL `INSERT`
         * has: every row in `args.data` is validated *before* any row is
         * committed to `this.serving`, so a batch with one bad row leaves
         * the fake's state completely unchanged — same as a real `INSERT`
         * whose CHECK/unique violation aborts the whole statement, taking
         * any otherwise-valid rows in the same `createMany` call down with
         * it (this is exactly how the production bug this fake now guards
         * against manifested: one `new_novel`/`recency` row poisoned the
         * entire compute, including its `manual` rows in the same call).
         */
        createMany: async (args: { data: Array<Omit<FakeServingRow, "id">> }) => {
          this.calls.push("homeCarouselServing.createMany");
          const existingKeys = new Set(this.serving.map((row) => `${row.locale} ${row.position}`));
          const seenInBatch = new Set<string>();
          for (const row of args.data) {
            if (!(CAROUSEL_SOURCES as readonly string[]).includes(row.source)) {
              throw prismaCheckViolationError(
                "home_carousel_serving", "homeCarouselServing.createMany",
                "home_carousel_serving_source_check",
                `source in CHECK ("source"::text = ANY (ARRAY[${CAROUSEL_SOURCES.map((value) => `'${value}'::character varying`).join(", ")}]::text[])), got '${row.source}'`,
              );
            }
            if (!Number.isInteger(row.position) || row.position <= 0) {
              throw prismaCheckViolationError("home_carousel_serving", "homeCarouselServing.createMany", "carousel_serving_position_check", `position > 0, got ${row.position}`);
            }
            const key = `${row.locale} ${row.position}`;
            if (existingKeys.has(key) || seenInBatch.has(key)) throw prismaUniqueError("carousel_serving_locale_position_key");
            seenInBatch.add(key);
          }
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
