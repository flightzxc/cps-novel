/**
 * C-30A (施工工单_C30_换小说_移植CPS换租客_2026-09-08.md §4A.8/§4A.9):
 * real-PostgreSQL verification of the load-bearing physical invariants a
 * unit test (in-memory fake db) cannot exercise — CHECK constraints, the
 * composite FK, and the plain (non-partial) unique index only exist inside
 * the database engine itself. Scope (four things, matching the construction
 * order's exact ask):
 *
 *   1. A real two-field atomic rebind (`UPDATE article SET novel_id = $1,
 *      promo_link_id = $2 ...`) succeeds and satisfies both the composite FK
 *      (`article_promo_link_novel_fkey`) and the published-row CHECK
 *      (`article_published_promo_link_check`).
 *   2. 🔴 "故意只改书目 ID": the same UPDATE with ONLY `novel_id` changed
 *      (leaving `promo_link_id` pointing at the OLD novel's PromoLink) is
 *      rejected by PostgreSQL — proving "the two fields must move together"
 *      is a database-enforced fact, not an application-layer assumption.
 *   3. The target Novel already has an Article in the same locale that is
 *      **soft-deleted** — `article_novel_locale_key` (`UNIQUE(novel_id,
 *      locale)`) still rejects a second Article landing on that (novel_id,
 *      locale) pair, because that unique index carries no `WHERE deleted_at
 *      IS NULL` exemption (contrast: `article_locale_slug_active_uidx` does
 *      — see `docs/governance/database-governance.md` §5 item 22 / §4's
 *      C-30A note).
 *   4. `scripts/backfill-novel-title-normalized.ts`'s `backfillNovelTitleNormalized`
 *      is idempotent against a real database: running it twice back to back
 *      produces the same `updated` count on the first run and exactly zero
 *      writes on the second.
 *
 * Gate: `C30_DATABASE_TEST=1` against a disposable PostgreSQL database whose
 * name contains `c30`, with every migration up to and including
 * `20260911090000_c30_novel_rebind_foundation` already applied via
 * `prisma migrate deploy` — same `describe.skipIf` + `databaseName.includes(...)`
 * refusal-guard discipline as every other `*-postgres.test.ts` /
 * `*.test.ts` under `tests/integration/database/`
 * (`c27-blog-article-postgres.test.ts` in particular).
 *
 * First real run: 2026-09-09, PostgreSQL 16.14 (Debian 16.14-1.pgdg13+1,
 * aarch64) on a disposable `c30_it` database migrated with `prisma migrate
 * deploy` up to and including `20260911090000_c30_novel_rebind_foundation` —
 * 4 passed, 0 failed, 0 skipped in ~250ms, and 8 passed / 0 failed for the
 * whole directory, reproduced five times back to back. Two fixture
 * corrections were needed, neither under `src/` and neither touching an
 * assertion:
 *   (a) `promoLinkInsert` used to derive `idempotency_key` from
 *       `repeat(<first letter of the redirect code>, 64)`, which is the same
 *       value for any two promo links whose codes share a first letter — and
 *       `promo_link_idempotency_key_key` is a real UNIQUE index, so the seed
 *       aborted on its second insert with `23505`. The key is now derived
 *       from the (already unique) redirect code itself.
 *   (b) 🔴 this suite ran concurrently with `batch-200.test.ts` against the
 *       same database and corrupted it — see `SUITE_LOCK_KEY` below.
 * Every assertion below is the one originally written.
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { backfillNovelTitleNormalized } from "../../../scripts/backfill-novel-title-normalized";

const enabled = process.env.C30_DATABASE_TEST === "1";
const prisma = new PrismaClient();

const ids = {
  channel: "00000000-0000-4000-8000-0000000c3001",
  sourceApp: "10000000-0000-4000-8000-0000000c3001",
  channelApp: "20000000-0000-4000-8000-0000000c3001",
  channelAccount: "30000000-0000-4000-8000-0000000c3001",
  novelSource: "40000000-0000-4000-8000-0000000c3001",
  novelTarget: "40000000-0000-4000-8000-0000000c3002",
  novelOccupiedTarget: "40000000-0000-4000-8000-0000000c3003",
  sourceItemSource: "50000000-0000-4000-8000-0000000c3001",
  sourceItemTarget: "50000000-0000-4000-8000-0000000c3002",
  sourceItemOccupiedTarget: "50000000-0000-4000-8000-0000000c3003",
  promoSource: "60000000-0000-4000-8000-0000000c3001",
  promoTarget: "60000000-0000-4000-8000-0000000c3002",
  article: "70000000-0000-4000-8000-0000000c3001",
  softDeletedOccupant: "70000000-0000-4000-8000-0000000c3002",
} as const;

/**
 * 🔴 Suite-level mutual exclusion, shared verbatim with `batch-200.test.ts`
 * — every destructive suite in this directory MUST take this lock for its
 * whole lifetime. Both files `TRUNCATE` every table in `public` against the
 * SAME database and `vitest.config.ts` sets no `fileParallelism: false`, so
 * vitest runs them concurrently in separate workers. This file is the
 * aggressor of the pair: test 4 deliberately runs `UPDATE novel SET
 * title_normalized = NULL` across the WHOLE table and then re-derives the
 * column from `Novel.title`, which — measured on 2026-09-09, before this
 * lock existed — silently rewrote whichever of `batch-200.test.ts`'s 200
 * seeded pairs happened to exist at that instant and cost that suite 3–5 of
 * its pairs, differently on every run. See `batch-200.test.ts`'s own
 * `SUITE_LOCK_KEY` comment for the full diagnosis. The lock is session-
 * scoped, hence its own one-connection client: Prisma's default pool could
 * otherwise release it from a different connection than the one holding it.
 */
const SUITE_LOCK_KEY = 3020260909;
let suiteLock: PrismaClient | null = null;

async function acquireSuiteLock(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  suiteLock = new PrismaClient({ datasourceUrl: `${url}${url.includes("?") ? "&" : "?"}connection_limit=1` });
  // `PERFORM` inside a DO block, not `SELECT pg_advisory_lock(...)`:
  // the function returns `void`, and Prisma's raw-result deserializer
  // rejects a `void` column with P2010. The lock is session-scoped either
  // way — `pg_advisory_lock` is never transaction-scoped.
  await suiteLock.$executeRawUnsafe(`DO $suite$ BEGIN PERFORM pg_advisory_lock(${SUITE_LOCK_KEY}); END $suite$`);
}

async function releaseSuiteLock(): Promise<void> {
  if (!suiteLock) return;
  // `pg_advisory_unlock` returns boolean — `false` would mean this client's
  // connection was NOT the lock holder, i.e. the one-connection assumption
  // above broke; fail loudly rather than leak the lock to the next run.
  const [released] = await suiteLock.$queryRawUnsafe<Array<{ released: boolean }>>(
    `SELECT pg_advisory_unlock(${SUITE_LOCK_KEY}) AS released`,
  );
  await suiteLock.$disconnect();
  suiteLock = null;
  expect(released?.released).toBe(true);
}

async function execute(sql: string) {
  return prisma.$executeRawUnsafe(sql);
}

async function executeBatch(sql: string) {
  for (const statement of sql.split(";").map((part) => part.trim()).filter(Boolean)) {
    await execute(statement);
  }
}

async function expectDatabaseFailure(sql: string, marker?: string) {
  try {
    await execute(sql);
  } catch (error) {
    const text = String(error);
    if (marker && !text.includes(marker)) {
      const prismaHidName = /Code: `(23503|23505)`/.test(text);
      expect(prismaHidName, text).toBe(true);
    }
    return;
  }
  throw new Error("Expected PostgreSQL to reject the statement");
}

/**
 * `promo_link.idempotency_key` is `CHAR(64)` under a real UNIQUE index
 * (`promo_link_idempotency_key_key`), so every seeded promo link needs its
 * own value — derive it from `public_redirect_code`, which carries its own
 * UNIQUE index and is therefore already distinct per row.
 */
function idempotencyKey(redirectCode: string): string {
  return `rpad(lower('${redirectCode}'), 64, '0')`;
}

function novelInsert({ id, businessId, slug, locale = "en-US" }: { id: string; businessId: string; slug: string; locale?: string }) {
  return `
    INSERT INTO novel (id, business_id, title, description, locale, slug, status, updated_at)
    VALUES ('${id}', '${businessId}', 'C-30 Novel ${businessId}', 'Description', '${locale}', '${slug}', 'published', now())
  `;
}

function novelSourceItemInsert({ id, novelId, externalBookId }: { id: string; novelId: string; externalBookId: string }) {
  return `
    INSERT INTO novel_source_item (
      id, channel_app_id, novel_id, external_book_id, source_language_code,
      source_locale, title, description, status, raw_payload, updated_at
    ) VALUES (
      '${id}', '${ids.channelApp}', '${novelId}', '${externalBookId}', 'en', 'en-US',
      'Book', 'Description', 'linked', '{}', now()
    )
  `;
}

function promoLinkInsert({ id, novelId, sourceItemId, redirectCode }: { id: string; novelId: string; sourceItemId: string; redirectCode: string }) {
  return `
    INSERT INTO promo_link (
      id, novel_id, novel_source_item_id, channel_app_id, channel_account_id,
      offer_type, public_redirect_code, idempotency_key, status, web_url, updated_at
    ) VALUES (
      '${id}', '${novelId}', '${sourceItemId}', '${ids.channelApp}', '${ids.channelAccount}',
      'read', '${redirectCode}', ${idempotencyKey(redirectCode)}, 'fetched', 'https://example.com/${redirectCode}', now()
    )
  `;
}

function articleInsert({
  id,
  novelId,
  promoLinkId,
  locale = "en-US",
  slug,
  status = "published",
  deletedAt = "NULL",
}: {
  id: string;
  novelId: string;
  promoLinkId: string | null;
  locale?: string;
  slug: string;
  status?: "draft" | "published";
  deletedAt?: string;
}) {
  return `
    INSERT INTO article (
      id, novel_id, promo_link_id, article_type, locale, slug,
      public_page_short_id, title, body, status, published_at, deleted_at, updated_at
    ) VALUES (
      '${id}', '${novelId}', ${promoLinkId ? `'${promoLinkId}'` : "NULL"}, 'novel_article', '${locale}', '${slug}',
      '${id.slice(-12)}', 'Title', 'Rendered body', '${status}', ${status === "published" ? "now()" : "NULL"}, ${deletedAt}, now()
    )
  `;
}

async function seedFoundation() {
  await executeBatch(`
    INSERT INTO channel (id, code, name, updated_at)
    VALUES ('${ids.channel}', 'c30-test-channel', 'C-30 Test Channel', now());
    INSERT INTO source_app (id, code, name, updated_at)
    VALUES ('${ids.sourceApp}', 'c30-test-source', 'C-30 Test Source', now());
    INSERT INTO channel_app (id, channel_id, source_app_id, external_app_id, project_type, updated_at)
    VALUES ('${ids.channelApp}', '${ids.channel}', '${ids.sourceApp}', 'c30-app', 2, now());
    INSERT INTO channel_account (id, channel_id, business_id, account_name, updated_at)
    VALUES ('${ids.channelAccount}', '${ids.channel}', 'c30-account', 'C-30 Account', now());
    ${novelInsert({ id: ids.novelSource, businessId: "c30-novel-source", slug: "c30-novel-source" })};
    ${novelInsert({ id: ids.novelTarget, businessId: "c30-novel-target", slug: "c30-novel-target" })};
    ${novelInsert({ id: ids.novelOccupiedTarget, businessId: "c30-novel-occupied", slug: "c30-novel-occupied" })};
    ${novelSourceItemInsert({ id: ids.sourceItemSource, novelId: ids.novelSource, externalBookId: "c30-book-source" })};
    ${novelSourceItemInsert({ id: ids.sourceItemTarget, novelId: ids.novelTarget, externalBookId: "c30-book-target" })};
    ${novelSourceItemInsert({ id: ids.sourceItemOccupiedTarget, novelId: ids.novelOccupiedTarget, externalBookId: "c30-book-occupied" })};
    ${promoLinkInsert({ id: ids.promoSource, novelId: ids.novelSource, sourceItemId: ids.sourceItemSource, redirectCode: "PUBC30SRC" })};
    ${promoLinkInsert({ id: ids.promoTarget, novelId: ids.novelTarget, sourceItemId: ids.sourceItemTarget, redirectCode: "PUBC30TGT" })};
  `);
  // The article this whole file rebinds: published, bound to novelSource + promoSource.
  await execute(
    articleInsert({ id: ids.article, novelId: ids.novelSource, promoLinkId: ids.promoSource, locale: "en-US", slug: "c30-article" }),
  );
  // A soft-deleted Article already occupying (novelOccupiedTarget, en-US) —
  // for scenario 3. `deleted_at` non-NULL, but `article_novel_locale_key`
  // has no partial-index exemption, so the slot is still considered taken.
  await execute(
    articleInsert({
      id: ids.softDeletedOccupant,
      novelId: ids.novelOccupiedTarget,
      promoLinkId: null,
      locale: "en-US",
      slug: "c30-soft-deleted-occupant",
      status: "draft",
      deletedAt: "now()",
    }),
  );
}

describe.skipIf(!enabled).sequential("C-30A (施工工单 单 1): 两字段原子换绑 — 真实 PostgreSQL", () => {
  beforeAll(async () => {
    const [{ database_name: databaseName }] = await prisma.$queryRawUnsafe<Array<{ database_name: string }>>(
      `SELECT current_database() AS database_name`,
    );
    if (!databaseName.includes("c30")) {
      throw new Error(`Refusing destructive test setup against ${databaseName}`);
    }
    // Taken AFTER the refusal guard (refuse fast, without queueing behind the
    // other suite) and held until `afterAll` — see `SUITE_LOCK_KEY`. The
    // generous timeout is the wait for `batch-200.test.ts` to finish its own
    // turn, not this file's own work.
    //
    // 🔴 C-30 单 3 W-2 (施工工单_C30单3..._2026-09-09.md §5.3 — "追加用例后必须
    // 重新确认这个数够用，不够就一起提高"): raised from 180_000 to 300_000 when
    // that file's own §5.3 test (#7, the W-2 budget-gate case) was added —
    // it drives `executeRebindBatch` in a loop that, by its own clock's
    // construction, takes exactly `REBIND_BATCH_LIMITS.apply` (200) real
    // round-trips (lease acquire/release + per-item claim/process/finalize
    // each round) to finish a fresh 200-item batch, on top of that file's
    // existing seeding + 200-item batch + resume/replay work — this file's
    // own `beforeAll` blocks on `acquireSuiteLock()` for the whole of that,
    // so its budget has to cover it too. Matches test #7's own 300_000ms
    // per-test timeout (施工工单 §6 item 5 — this is one of the explicit,
    // in-scope hook-timeout adjustments that instruction calls for, not an
    // unrelated change; the CLI's own `--testTimeout` is NOT sufficient on
    // its own here since an explicit hook timeout argument overrides it).
    await acquireSuiteLock();
    const tables = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
    `);
    const names = tables.map(({ tablename }) => `"${tablename}"`).join(", ");
    await execute(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
    await seedFoundation();
  }, 300_000);

  afterAll(async () => {
    await releaseSuiteLock();
    await prisma.$disconnect();
  });

  it("1. 两字段原子换绑（novel_id + promo_link_id 一起改）在真实库上成功，满足复合 FK 与已发布 CHECK", async () => {
    await execute(`
      UPDATE article
         SET novel_id = '${ids.novelTarget}', promo_link_id = '${ids.promoTarget}'
       WHERE id = '${ids.article}'
    `);
    const [row] = await prisma.$queryRawUnsafe<Array<{ novel_id: string; promo_link_id: string }>>(
      `SELECT novel_id, promo_link_id FROM article WHERE id = '${ids.article}'`,
    );
    expect(row?.novel_id).toBe(ids.novelTarget);
    expect(row?.promo_link_id).toBe(ids.promoTarget);

    // Restore for the next test's own baseline.
    await execute(`
      UPDATE article
         SET novel_id = '${ids.novelSource}', promo_link_id = '${ids.promoSource}'
       WHERE id = '${ids.article}'
    `);
  });

  it("2. 🔴 故意只改书目 ID（promo_link_id 仍指向旧书目的推广链接）— 数据库确实拒绝（article_promo_link_novel_fkey）", async () => {
    await expectDatabaseFailure(
      `UPDATE article SET novel_id = '${ids.novelTarget}' WHERE id = '${ids.article}'`,
      "article_promo_link_novel_fkey",
    );
    // Confirm the row is untouched — the failed statement did not partially apply.
    const [row] = await prisma.$queryRawUnsafe<Array<{ novel_id: string }>>(
      `SELECT novel_id FROM article WHERE id = '${ids.article}'`,
    );
    expect(row?.novel_id).toBe(ids.novelSource);
  });

  it("3. 目标书目在同语种已有一篇已软删除的文章时，article_novel_locale_key 仍然拒绝新增/换绑到该 (novel_id, locale)", async () => {
    // A brand-new insert landing on the same (novel_id, locale) as the
    // soft-deleted occupant — same physical collision a rebind's UPDATE
    // would hit.
    await expectDatabaseFailure(
      articleInsert({
        id: "80000000-0000-4000-8000-0000000c3001",
        novelId: ids.novelOccupiedTarget,
        promoLinkId: null,
        locale: "en-US",
        slug: "c30-second-article-same-slot",
        status: "draft",
      }),
      "article_novel_locale_key",
    );
  });

  it("4. scripts/backfill-novel-title-normalized.ts 幂等：跑两遍，第二遍零写入", async () => {
    // Force a NULL title_normalized on all seeded Novel rows (the C-30A
    // migration itself ships title_normalized as NULL for existing rows —
    // this is just making that explicit/robust to test seeding order).
    await execute(`UPDATE novel SET title_normalized = NULL`);

    const first = await backfillNovelTitleNormalized(prisma, { batchSize: 50, maxRows: 50 });
    expect(first.updated).toBeGreaterThan(0);
    expect(first.scanned).toBe(first.updated + first.skippedConcurrentlyFilled);

    const second = await backfillNovelTitleNormalized(prisma, { batchSize: 50, maxRows: 50 });
    expect(second.scanned).toBe(0);
    expect(second.updated).toBe(0);

    const [{ remaining }] = await prisma.$queryRawUnsafe<Array<{ remaining: bigint }>>(
      `SELECT count(*) AS remaining FROM novel WHERE title_normalized IS NULL`,
    );
    expect(Number(remaining)).toBe(0);
  });
});
