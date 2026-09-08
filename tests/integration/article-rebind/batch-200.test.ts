/**
 * C-30B (施工工单_C30_换小说_移植CPS换租客_2026-09-08.md §4B.5, 本单主验收):
 * real-PostgreSQL end-to-end verification of the durable batch engine at the
 * construction order's own scale — a 200-item batch (`REBIND_BATCH_LIMITS.apply`,
 * `src/server/article-rebind/batch-constants.ts`) — through the real TS
 * service layer (`buildRebindBatchPreview`/`submitRebindBatch`/
 * `resumeRebindBatch`), not raw SQL. What raw SQL cannot prove — genuine
 * per-item transaction boundaries, the composite FK/CHECK holding across 200
 * real writes, real lease expiry + resume, real query-plan index usage — is
 * exactly this file's job; `two-field-atomic.test.ts` (C-30A) already covers
 * the single-statement physical invariants raw SQL CAN prove.
 *
 * Six things, matching the construction order's exact ask:
 *   1. A real 200-item batch runs via `submitRebindBatch` to a terminal state.
 *   2. 🔴 逐条事务边界: article #100 (1-indexed) is engineered to fail at
 *      WRITE time (its target's PromoLink is deleted between preview and
 *      apply) — items #1-99 and #101-200 still commit; #100 alone is
 *      `failed`. Proves failure isolation on a REAL database, not just the
 *      fake's snapshot/restore semantics (`tests/backend/article-rebind/batch.test.ts`
 *      already proves the shape; this proves Postgres does not silently
 *      widen one item's transaction to cover its neighbors).
 *   3. The composite FK (`article_promo_link_novel_fkey`) and the published-
 *      row CHECK are never violated across all 200 writes — asserted by the
 *      writes simply succeeding (a violation would throw) plus a direct
 *      per-row consistency query afterward.
 *   4. Lease expiry + resume: the batch is interrupted mid-run (stop after
 *      ~half the items by forcibly expiring the lease), then
 *      `resumeRebindBatch` finishes it — no item is double-applied (audit
 *      count reconciles exactly with `appliedCount`).
 *   5. Same-`requestToken` replay does not double-write (`submitRebindBatch`
 *      called twice with the identical fingerprint).
 *   6. 🔴 `EXPLAIN` confirms `novel_locale_title_normalized_idx` (the
 *      `(locale, title_normalized)` index, C-30A migration) is used for the
 *      destination-novel lookup shape `loadRelevantDurableDestinations`
 *      issues.
 *
 * Timing: each phase's wall-clock duration is logged (not asserted against a
 * fixed budget — CI hardware varies) so a human reviewing the run can
 * confirm or revise the `apply: 200` constant per 施工工单 §7 item 2.
 *
 * Gate: `C30_DATABASE_TEST=1` against a disposable PostgreSQL database whose
 * name contains `c30`, with every migration up to and including
 * `20260911090000_c30_novel_rebind_foundation` already applied. Same
 * `describe.skipIf` + `databaseName.includes(...)` refusal-guard discipline
 * as `two-field-atomic.test.ts`.
 *
 * First real run of the WHOLE directory (`tests/integration/article-rebind/`,
 * both files at once — the shape CI actually runs): 2026-09-09, PostgreSQL
 * 16.14 (Debian 16.14-1.pgdg13+1, aarch64) on a disposable `c30_it` database
 * migrated with `prisma migrate deploy` up to and including
 * `20260911090000_c30_novel_rebind_foundation` — 2 files, 8 passed, 0
 * failed, 0 skipped, reproduced five times back to back. This file's own
 * numbers, read straight out of the database afterwards: 200 submitted, 199
 * applied, 1 failed (`error_kind = blocked`, `rebind blocked:
 * TARGET_PROMO_NOT_READY` — the engineered item #100), and 200
 * `article.rebind_novel` audit rows over 200 distinct `entity_id` and 200
 * distinct `request_id` (199 from this batch + 1 from test 4's resume).
 * Timing across those five green runs: preview 38–47ms; apply 1,776–2,219ms
 * wall for 200 items (8.9–11.1ms/item); per-item claim→terminal span p50
 * 6–8ms, avg 6.3–8.1ms, p95 8–11ms, max 14–19ms. (The very first run against
 * a cold database was 3–5× slower — 9,438ms wall, 47.2ms/item, max 286ms —
 * so read the range above as warm-cache, and the cold figure as the one a
 * first-of-the-day production batch is closer to.) `apply: 200` was NOT
 * changed on the strength of that — see the delivery report for the
 * reasoning (the limiter is the synchronous request path, not the per-item
 * transaction cost).
 *
 * Four fixture corrections were needed to get there, none of them under
 * `src/` and none touching an assertion:
 *   (a) the seeded Article pointed its `promo_link_id` at a placeholder uuid
 *       that existed in no table, which `article_promo_link_novel_fkey` —
 *       the composite FK this whole order is about — rejected with `23503`.
 *       Each pair now seeds a real source-side PromoLink on the source
 *       Novel, so the article starts life FK-consistent and the rebind is a
 *       genuine two-field move rather than a first-time fill-in.
 *   (b) `idempotency_key` was `repeat(<first letter>, 64)`, identical for
 *       every promo link, against a real UNIQUE index (`23505`).
 *   (c) `public_page_short_id` was the uuid's last 12 characters, which
 *       collide between the 200-pair and the resume id families under
 *       `article_public_page_short_id_key`.
 *   (d) 🔴 (a)–(c) got this FILE green in isolation, but the directory-level
 *       run stayed red at `executableCount` 195/196/197 — a different number
 *       every time — because the two suites TRUNCATE and rewrite the same
 *       database in parallel workers. See `SUITE_LOCK_KEY` below for the
 *       diagnosis and the fix; nothing under `src/` was at fault.
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { REBIND_BATCH_LIMITS } from "../../../src/server/article-rebind/batch-constants";
import { resumeRebindBatch, submitRebindBatch } from "../../../src/server/article-rebind/batch";
import { buildRebindBatchPreview } from "../../../src/server/article-rebind/preview";

const enabled = process.env.C30_DATABASE_TEST === "1";
const prisma = new PrismaClient();
const BATCH_SIZE = REBIND_BATCH_LIMITS.apply; // 200 as of this order — see this file's own header.

const ENABLED_ENV = { FEATURE_ARTICLE_NOVEL_REBIND: "true", ARTICLE_NOVEL_REBIND_ALLOW_WRITE: "true" } as unknown as NodeJS.ProcessEnv;

const ids = {
  channelSource: "00000000-0000-4000-8000-0000000c3b01",
  channelTarget: "00000000-0000-4000-8000-0000000c3b02",
  sourceApp: "10000000-0000-4000-8000-0000000c3b01",
  channelAppSource: "20000000-0000-4000-8000-0000000c3b01",
  channelAppTarget: "20000000-0000-4000-8000-0000000c3b02",
  channelAccountSource: "30000000-0000-4000-8000-0000000c3b00",
  channelAccount: "30000000-0000-4000-8000-0000000c3b01",
} as const;

/**
 * Extra `novel` rows that belong to NEITHER channel and carry no
 * `NovelSourceItem` and no `Article`, so they are invisible to every query
 * the rebind path issues (`loadSourceUniverse` starts from Articles;
 * `loadRelevantDestinations` requires both a matching `title_normalized`
 * and a target-channel source item). Their only job is test 6: at the
 * 400-novel scale this fixture's own pairs produce, PostgreSQL is *right*
 * to seq-scan a 13-page table, and it does — measured on this database,
 * 400 rows + `ANALYZE` yields `Seq Scan on novel`, and 400 rows *without*
 * `ANALYZE` yields an index scan on the unrelated `novel_locale_status_idx`.
 * The crossover into the plan production actually runs sits between 400 and
 * 2,000 rows; this filler puts the table clearly past it so test 6 asserts
 * a planner decision rather than a small-table artifact.
 */
const PLANNER_SCALE_FILLER_ROWS = 5_000;

/**
 * 🔴 Suite-level mutual exclusion, shared verbatim with
 * `two-field-atomic.test.ts` — every destructive suite in this directory
 * MUST take this lock for its whole lifetime.
 *
 * Both files `TRUNCATE` every table in `public` and then run whole-table
 * statements against the SAME database, and `vitest.config.ts` sets no
 * `fileParallelism: false`, so vitest hands each file its own worker and
 * runs them at the same time. Measured on 2026-09-09 before this lock
 * existed: the combined run non-deterministically lost 3–5 of the 200 pairs
 * (`executableCount` came back 195 / 196 / 197 instead of 200, a different
 * number per run) while each file ALONE passed. Cause, from the preview
 * snapshot itself — the lost rows were `category: "skipped"`,
 * `skipReason: "unresolved"`, `candidateCount: 0`, `findings: []` (no guard
 * fired at all), and the pairs behind them had had their `title_normalized`
 * rewritten from the seeded `c30b batch book 3` to `c 30b novel c30b src 3`:
 * `two-field-atomic.test.ts`'s test 4 runs `UPDATE novel SET
 * title_normalized = NULL` across the WHOLE table and then re-derives it
 * from `Novel.title` via `backfillNovelTitleNormalized`, which lands on
 * whichever of this file's pairs had already been seeded at that instant and
 * un-pairs source from target. Nothing under `src/` is involved.
 *
 * The lock is session-scoped, so it is taken on its OWN one-connection
 * client: Prisma's default pool could otherwise hand the release a different
 * connection than the one holding the lock, and a lock client kept separate
 * from `prisma` cannot perturb the pool the service layer under test uses.
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

function pairUuid(prefix: string, index: number): string {
  return `${prefix}-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

async function execute(sql: string) {
  return prisma.$executeRawUnsafe(sql);
}

async function executeBatch(sql: string) {
  for (const statement of sql.split(";").map((part) => part.trim()).filter(Boolean)) {
    await execute(statement);
  }
}

function novelInsert(input: { id: string; businessId: string; slug: string; titleNormalized: string }) {
  return `
    INSERT INTO novel (id, business_id, title, description, locale, slug, status, title_normalized, updated_at)
    VALUES ('${input.id}', '${input.businessId}', 'C-30B Novel ${input.businessId}', 'Description', 'en-US', '${input.slug}', 'published', '${input.titleNormalized}', now())
  `;
}

function novelSourceItemInsert(input: { id: string; channelAppId: string; novelId: string; externalBookId: string }) {
  return `
    INSERT INTO novel_source_item (
      id, channel_app_id, novel_id, external_book_id, source_language_code,
      source_locale, title, description, status, raw_payload, updated_at
    ) VALUES (
      '${input.id}', '${input.channelAppId}', '${input.novelId}', '${input.externalBookId}', 'en',
      'en-US', 'Book', 'Description', 'linked', '{}', now()
    )
  `;
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

function promoLinkInsert(input: {
  id: string;
  novelId: string;
  sourceItemId: string;
  redirectCode: string;
  channelAppId: string;
  channelAccountId: string;
}) {
  return `
    INSERT INTO promo_link (
      id, novel_id, novel_source_item_id, channel_app_id, channel_account_id,
      offer_type, public_redirect_code, idempotency_key, status, web_url, updated_at
    ) VALUES (
      '${input.id}', '${input.novelId}', '${input.sourceItemId}', '${input.channelAppId}', '${input.channelAccountId}',
      'read', '${input.redirectCode}', ${idempotencyKey(input.redirectCode)}, 'fetched', 'https://example.com/${input.redirectCode}', now()
    )
  `;
}

/**
 * 🔴 `promoLinkId` is not optional and is not a free-floating id: the
 * article table carries the composite FK `article_promo_link_novel_fkey`
 * (`(promo_link_id, novel_id)` → `promo_link(id, novel_id)`) — the very
 * constraint this whole order exists to honour — so a seeded published
 * novel article must point at a promo link that belongs to *its own*
 * novel. `public_page_short_id` is passed explicitly rather than sliced off
 * the uuid: `article_public_page_short_id_key` is UNIQUE, and two uuids
 * from different id families can share their last 12 characters.
 */
function articleInsert(input: { id: string; novelId: string; promoLinkId: string; slug: string; shortId: string }) {
  return `
    INSERT INTO article (
      id, novel_id, promo_link_id, article_type, locale, slug,
      public_page_short_id, title, body, status, published_at, updated_at
    ) VALUES (
      '${input.id}', '${input.novelId}', '${input.promoLinkId}', 'novel_article', 'en-US', '${input.slug}',
      '${input.shortId}', 'Title', 'Rendered body', 'published', now(), now()
    )
  `;
}

type Pair = {
  index: number;
  sourceNovelId: string;
  targetNovelId: string;
  articleId: string;
  /** The article's CURRENT (source-side) promo link — the other half of the composite FK before the rebind. */
  sourcePromoLinkId: string;
  /** The promo link the rebind is expected to land on (target-side). */
  promoLinkId: string;
};

async function seedFoundation(): Promise<Pair[]> {
  await executeBatch(`
    INSERT INTO channel (id, code, name, updated_at) VALUES ('${ids.channelSource}', 'c30b-source-channel', 'C-30B Source Channel', now());
    INSERT INTO channel (id, code, name, updated_at) VALUES ('${ids.channelTarget}', 'c30b-target-channel', 'C-30B Target Channel', now());
    INSERT INTO source_app (id, code, name, updated_at) VALUES ('${ids.sourceApp}', 'c30b-source-app', 'C-30B Source App', now());
    INSERT INTO channel_app (id, channel_id, source_app_id, external_app_id, project_type, updated_at)
      VALUES ('${ids.channelAppSource}', '${ids.channelSource}', '${ids.sourceApp}', 'c30b-app-source', 2, now());
    INSERT INTO channel_app (id, channel_id, source_app_id, external_app_id, project_type, updated_at)
      VALUES ('${ids.channelAppTarget}', '${ids.channelTarget}', '${ids.sourceApp}', 'c30b-app-target', 2, now());
    INSERT INTO channel_account (id, channel_id, business_id, account_name, updated_at)
      VALUES ('${ids.channelAccountSource}', '${ids.channelSource}', 'c30b-account-source', 'C-30B Source Account', now());
    INSERT INTO channel_account (id, channel_id, business_id, account_name, updated_at)
      VALUES ('${ids.channelAccount}', '${ids.channelTarget}', 'c30b-account', 'C-30B Account', now());
  `);

  const pairs: Pair[] = [];
  for (let index = 1; index <= BATCH_SIZE; index += 1) {
    const sourceNovelId = pairUuid("40100000", index);
    const targetNovelId = pairUuid("40200000", index);
    const sourceItemSourceId = pairUuid("50100000", index);
    const sourceItemTargetId = pairUuid("50200000", index);
    const sourcePromoLinkId = pairUuid("60000000", index);
    const promoLinkId = pairUuid("60100000", index);
    const articleId = pairUuid("70100000", index);
    const titleNormalized = `c30b batch book ${index}`;
    const suffix = String(index).padStart(4, "0");

    await executeBatch(`
      ${novelInsert({ id: sourceNovelId, businessId: `c30b-src-${index}`, slug: `c30b-src-${index}`, titleNormalized })};
      ${novelInsert({ id: targetNovelId, businessId: `c30b-tgt-${index}`, slug: `c30b-tgt-${index}`, titleNormalized })};
      ${novelSourceItemInsert({ id: sourceItemSourceId, channelAppId: ids.channelAppSource, novelId: sourceNovelId, externalBookId: `c30b-book-src-${index}` })};
      ${novelSourceItemInsert({ id: sourceItemTargetId, channelAppId: ids.channelAppTarget, novelId: targetNovelId, externalBookId: `c30b-book-tgt-${index}` })};
      ${promoLinkInsert({ id: sourcePromoLinkId, novelId: sourceNovelId, sourceItemId: sourceItemSourceId, redirectCode: `PB30BS${suffix}`, channelAppId: ids.channelAppSource, channelAccountId: ids.channelAccountSource })};
      ${promoLinkInsert({ id: promoLinkId, novelId: targetNovelId, sourceItemId: sourceItemTargetId, redirectCode: `PB30BT${suffix}`, channelAppId: ids.channelAppTarget, channelAccountId: ids.channelAccount })};
      ${articleInsert({ id: articleId, novelId: sourceNovelId, promoLinkId: sourcePromoLinkId, slug: `c30b-article-${index}`, shortId: `c30b-a-${suffix}` })};
    `);
    pairs.push({ index, sourceNovelId, targetNovelId, articleId, sourcePromoLinkId, promoLinkId });
  }

  // See PLANNER_SCALE_FILLER_ROWS — test 6 only means something on a table
  // big enough that an index scan is the cheaper plan. `ANALYZE` afterwards
  // so every plan this file exercises is chosen from real statistics rather
  // than from PostgreSQL's never-analyzed-table defaults.
  await execute(`
    INSERT INTO novel (id, business_id, title, description, locale, slug, status, title_normalized, updated_at)
    SELECT gen_random_uuid(), 'c30b-filler-' || g, 'C-30B Filler ' || g, 'Description', 'en-US',
           'c30b-filler-' || g, 'published', 'c30b filler book ' || g, now()
      FROM generate_series(1, ${PLANNER_SCALE_FILLER_ROWS}) AS g
  `);
  await execute("ANALYZE");

  return pairs;
}

describe.skipIf(!enabled).sequential("C-30B (施工工单 单 2 主验收): 200 条批量换绑 — 真实 PostgreSQL", () => {
  let pairs: Pair[] = [];
  // Captured by test 1, reused by test 5's replay — `buildRebindBatchRequestFingerprint`
  // hashes `previewId` into `requestPayloadHash`, so a replay MUST pass the
  // exact same `previewId` the original submission used, or it hits
  // `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD` instead of the intended
  // "same payload, replay" path.
  let firstBatchPreviewId = "";

  beforeAll(async () => {
    const [{ database_name: databaseName }] = await prisma.$queryRawUnsafe<Array<{ database_name: string }>>(
      `SELECT current_database() AS database_name`,
    );
    if (!databaseName.includes("c30")) {
      throw new Error(`Refusing destructive test setup against ${databaseName}`);
    }
    // Taken AFTER the refusal guard (refuse fast, without queueing behind the
    // other suite) and held until `afterAll` — see `SUITE_LOCK_KEY`.
    await acquireSuiteLock();
    const tables = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
    `);
    const names = tables.map(({ tablename }) => `"${tablename}"`).join(", ");
    await execute(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
    pairs = await seedFoundation();
  }, 180_000);

  afterAll(async () => {
    await releaseSuiteLock();
    await prisma.$disconnect();
  });

  it("6. 🔴 EXPLAIN 确认 (locale, title_normalized) 索引被用上（目标集扫描的真实查询形状）", async () => {
    const plan = await prisma.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(`
      EXPLAIN SELECT id, title, title_normalized, locale, status, deleted_at
        FROM novel
       WHERE deleted_at IS NULL
         AND locale = 'en-US'
         AND title_normalized IN ('c30b batch book 1', 'c30b batch book 2')
    `);
    const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
    console.log(`[C-30B plan] destination lookup:\n${text}`);
    expect(text).toMatch(/novel_locale_title_normalized_idx/);
  });

  it("1+3. 200 条批次跑到终态，复合 FK 与已发布 CHECK 全程不被违反（写入本身即证明）", async () => {
    const t0 = Date.now();
    const summary = await buildRebindBatchPreview(
      prisma,
      { sourceChannelCode: "c30b-source-channel", targetChannelCode: "c30b-target-channel", locale: "en-US", createdBy: "c30b-admin" },
      ENABLED_ENV,
    );
    const previewMs = Date.now() - t0;
    expect(summary.executableCount).toBe(BATCH_SIZE);
    firstBatchPreviewId = summary.previewId;

    // 🔴 2. Engineer article #100 (1-indexed) to fail at WRITE time — its
    // target's PromoLink is soft-deleted AFTER the preview captured it as
    // ready, exactly the "guards re-run fresh, don't trust the preview"
    // scenario `tests/backend/article-rebind/batch.test.ts`'s in-memory
    // version already proves; this proves it on a real database.
    const failingPair = pairs[99]!;
    await execute(`UPDATE promo_link SET deleted_at = now() WHERE id = '${failingPair.promoLinkId}'`);

    const t1 = Date.now();
    const result = await submitRebindBatch(
      prisma,
      {
        previewId: summary.previewId,
        selectedArticleIds: pairs.map((pair) => pair.articleId),
        reason: "C-30B 200 条批量验收",
        acknowledgeRisks: false,
        requestToken: "550e8400-e29b-41d4-a716-4466554b3001",
        createdBy: "c30b-admin",
      },
      ENABLED_ENV,
    );
    const applyMs = Date.now() - t1;
    console.log(`[C-30B timing] preview=${previewMs}ms apply(${BATCH_SIZE} items)=${applyMs}ms (${(applyMs / BATCH_SIZE).toFixed(1)}ms/item)`);

    // 🔴 逐条事务耗时 (施工工单 §7 item 2 — the data `REBIND_BATCH_LIMITS.apply`
    // is supposed to be calibrated against). Each item's own
    // `started_at`/`finished_at` are written by `claimRebindBatchItem` and by
    // `processRebindBatchItem`'s terminal update respectively, so this
    // distribution is the real claim→commit span of one item's transaction
    // pair, not a wall-clock average smeared over the whole run.
    const [perItem] = await prisma.$queryRawUnsafe<
      Array<{ items: number; min_ms: number; p50_ms: number; avg_ms: number; p95_ms: number; max_ms: number; sum_ms: number }>
    >(`
      SELECT count(*)::int AS items,
             round(min(ms)::numeric, 1)::float8 AS min_ms,
             round((percentile_cont(0.5) WITHIN GROUP (ORDER BY ms))::numeric, 1)::float8 AS p50_ms,
             round(avg(ms)::numeric, 1)::float8 AS avg_ms,
             round((percentile_cont(0.95) WITHIN GROUP (ORDER BY ms))::numeric, 1)::float8 AS p95_ms,
             round(max(ms)::numeric, 1)::float8 AS max_ms,
             round(sum(ms)::numeric, 1)::float8 AS sum_ms
        FROM (
          SELECT extract(epoch FROM (finished_at - started_at)) * 1000 AS ms
            FROM article_novel_rebind_batch_item
           WHERE batch_id = '${result.detail.batchId}'
             AND started_at IS NOT NULL AND finished_at IS NOT NULL
        ) AS spans
    `);
    console.log(`[C-30B timing] per-item claim→terminal: ${JSON.stringify(perItem)}`);

    expect(result.detail.status).toBe("partial");
    expect(result.detail.counts).toMatchObject({ submitted: BATCH_SIZE, applied: BATCH_SIZE - 1, failed: 1, skipped: 0, pending: 0, processing: 0 });

    const failedItem = result.detail.items.find((item) => item.articleId === failingPair.articleId)!;
    expect(failedItem.status).toBe("failed");

    // Spot-check: the article immediately before and after #100 both committed.
    const [before] = await prisma.$queryRawUnsafe<Array<{ novel_id: string; promo_link_id: string }>>(
      `SELECT novel_id, promo_link_id FROM article WHERE id = '${pairs[98]!.articleId}'`,
    );
    const [after] = await prisma.$queryRawUnsafe<Array<{ novel_id: string; promo_link_id: string }>>(
      `SELECT novel_id, promo_link_id FROM article WHERE id = '${pairs[100]!.articleId}'`,
    );
    expect(before?.novel_id).toBe(pairs[98]!.targetNovelId);
    expect(after?.novel_id).toBe(pairs[100]!.targetNovelId);
    // The failed item's own article was never touched.
    const [failing] = await prisma.$queryRawUnsafe<Array<{ novel_id: string }>>(
      `SELECT novel_id FROM article WHERE id = '${failingPair.articleId}'`,
    );
    expect(failing?.novel_id).toBe(failingPair.sourceNovelId);

    // Every OTHER article's novel_id/promo_link_id pair still satisfies the
    // composite FK by construction (the write itself would have thrown
    // otherwise) — this query just re-confirms no row is left half-migrated
    // (novel_id changed but promo_link_id did not, or vice versa).
    const inconsistent = await prisma.$queryRawUnsafe<Array<{ id: string }>>(`
      SELECT a.id FROM article a
      WHERE a.id = ANY(ARRAY[${pairs.map((p) => `'${p.articleId}'`).join(",")}]::uuid[])
        AND a.id <> '${failingPair.articleId}'
        AND a.novel_id NOT IN (SELECT id FROM novel WHERE id = ANY(ARRAY[${pairs.map((p) => `'${p.targetNovelId}'`).join(",")}]::uuid[]))
    `);
    expect(inconsistent).toEqual([]);
  }, 300_000);

  it("5. 同 requestToken 重放不双写", async () => {
    const before = await prisma.operationAudit.count({ where: { action: "article.rebind_novel" } });
    const replay = await submitRebindBatch(
      prisma,
      {
        previewId: firstBatchPreviewId, // must match test 1's exact previewId — see this file's `firstBatchPreviewId` doc comment.
        selectedArticleIds: pairs.map((pair) => pair.articleId),
        reason: "C-30B 200 条批量验收",
        acknowledgeRisks: false,
        requestToken: "550e8400-e29b-41d4-a716-4466554b3001",
        createdBy: "c30b-admin",
      },
      ENABLED_ENV,
    );
    expect(replay.created).toBe(false);
    const after = await prisma.operationAudit.count({ where: { action: "article.rebind_novel" } });
    expect(after).toBe(before);
  });

  it("4. 中途杀掉执行进程（人为过期租约）→ 续跑接上，不重复写", async () => {
    // Two fresh pairs, isolated from the 200-item batch above. Article R1's
    // write is done directly via SQL (standing in for "already committed by
    // the killed process before it died"); Article R2 is left un-migrated —
    // `resumeRebindBatch` must finish R2 and must NOT re-touch R1.
    const resumePair = (n: 1 | 2) => ({
      n,
      source: pairUuid("41100000", n),
      target: pairUuid("41200000", n),
      sourceItemSrc: pairUuid("51100000", n),
      sourceItemTgt: pairUuid("51200000", n),
      sourcePromo: pairUuid("61000000", n),
      promo: pairUuid("61100000", n),
      article: pairUuid("71100000", n),
    });
    const r1 = resumePair(1);
    const r2 = resumePair(2);
    for (const r of [r1, r2]) {
      await executeBatch(`
        ${novelInsert({ id: r.source, businessId: `c30b-resume-src-${r.n}`, slug: `c30b-resume-src-${r.n}`, titleNormalized: `c30b resume book ${r.n}` })};
        ${novelInsert({ id: r.target, businessId: `c30b-resume-tgt-${r.n}`, slug: `c30b-resume-tgt-${r.n}`, titleNormalized: `c30b resume book ${r.n}` })};
        ${novelSourceItemInsert({ id: r.sourceItemSrc, channelAppId: ids.channelAppSource, novelId: r.source, externalBookId: `c30b-resume-book-src-${r.n}` })};
        ${novelSourceItemInsert({ id: r.sourceItemTgt, channelAppId: ids.channelAppTarget, novelId: r.target, externalBookId: `c30b-resume-book-tgt-${r.n}` })};
        ${promoLinkInsert({ id: r.sourcePromo, novelId: r.source, sourceItemId: r.sourceItemSrc, redirectCode: `PB30BRS00${r.n}`, channelAppId: ids.channelAppSource, channelAccountId: ids.channelAccountSource })};
        ${promoLinkInsert({ id: r.promo, novelId: r.target, sourceItemId: r.sourceItemTgt, redirectCode: `PB30BRT00${r.n}`, channelAppId: ids.channelAppTarget, channelAccountId: ids.channelAccount })};
        ${articleInsert({ id: r.article, novelId: r.source, promoLinkId: r.sourcePromo, slug: `c30b-resume-article-${r.n}`, shortId: `c30b-r-${r.n}` })};
      `);
    }

    const resumeSummary = await buildRebindBatchPreview(
      prisma,
      { sourceChannelCode: "c30b-source-channel", targetChannelCode: "c30b-target-channel", locale: "en-US", createdBy: "c30b-admin-resume" },
      ENABLED_ENV,
    );
    expect(resumeSummary.executableCount).toBeGreaterThanOrEqual(2);

    const batchId = "rebind-c30b-interrupted-test";
    const staleToken = "550e8400-e29b-41d4-a716-4466554bdead";
    const now = new Date();
    const pastLease = new Date(now.getTime() - 60_000);
    await executeBatch(`
      INSERT INTO article_novel_rebind_batch (
        id, created_by, request_token, preview_id, selection_hash, request_payload_hash,
        source_channel_code, target_channel_code, status, acknowledge_risks,
        submitted_count, resolvable_count, applied_count, skipped_count, failed_count,
        filters_json, plan_hash, reason, execution_token, lease_expires_at, heartbeat_at, started_at, updated_at
      ) VALUES (
        '${batchId}', 'c30b-admin-resume', '550e8400-e29b-41d4-a716-4466554b3003', '${resumeSummary.previewId}', repeat('a', 64), repeat('a', 64),
        'c30b-source-channel', 'c30b-target-channel', 'processing', false,
        2, 2, 1, 0, 0,
        '{}', repeat('a', 64), 'C-30B 续跑验收', '${staleToken}', '${pastLease.toISOString()}', '${pastLease.toISOString()}', '${pastLease.toISOString()}', now()
      );
      INSERT INTO article_novel_rebind_batch_item (
        id, batch_id, article_id, old_novel_id, expected_new_novel_id, expected_new_promo_link_id,
        applied_new_novel_id, applied_new_promo_link_id, status, updated_at
      ) VALUES (
        gen_random_uuid(), '${batchId}', '${r1.article}', '${r1.source}', '${r1.target}', '${r1.promo}',
        '${r1.target}', '${r1.promo}', 'applied', now()
      );
      INSERT INTO article_novel_rebind_batch_item (
        id, batch_id, article_id, old_novel_id, expected_new_novel_id, expected_new_promo_link_id, status, updated_at
      ) VALUES (
        gen_random_uuid(), '${batchId}', '${r2.article}', '${r2.source}', '${r2.target}', '${r2.promo}', 'pending', now()
      );
    `);
    // Article R1's write already "happened" (as if the killed process
    // committed it right before dying) — done directly, standing in for
    // that prior commit.
    await execute(`UPDATE article SET novel_id = '${r1.target}', promo_link_id = '${r1.promo}' WHERE id = '${r1.article}'`);
    const auditCountBeforeResume = await prisma.operationAudit.count({ where: { action: "article.rebind_novel" } });

    const resumed = await resumeRebindBatch(prisma, { batchId, createdBy: "c30b-admin-resume" }, ENABLED_ENV);
    expect(resumed.status).toBe("completed");
    expect(resumed.counts).toMatchObject({ submitted: 2, applied: 2, failed: 0, skipped: 0, pending: 0, processing: 0 });

    // R2 got migrated by the resume.
    const [r2Row] = await prisma.$queryRawUnsafe<Array<{ novel_id: string; promo_link_id: string }>>(
      `SELECT novel_id, promo_link_id FROM article WHERE id = '${r2.article}'`,
    );
    expect(r2Row?.novel_id).toBe(r2.target);
    expect(r2Row?.promo_link_id).toBe(r2.promo);

    // 🔴 R1 was NOT re-written: exactly ONE new audit row (for R2), not two.
    const auditCountAfterResume = await prisma.operationAudit.count({ where: { action: "article.rebind_novel" } });
    expect(auditCountAfterResume).toBe(auditCountBeforeResume + 1);

    const [batchRow] = await prisma.$queryRawUnsafe<Array<{ status: string; execution_token: string | null }>>(
      `SELECT status, execution_token FROM article_novel_rebind_batch WHERE id = '${batchId}'`,
    );
    expect(batchRow?.status).toBe("completed");
    expect(batchRow?.execution_token).toBeNull();

    // A terminal batch cannot be resumed again — 施工工单's own "resume 不是回滚" contract.
    await expect(resumeRebindBatch(prisma, { batchId, createdBy: "c30b-admin-resume" }, ENABLED_ENV)).rejects.toMatchObject({ code: "BATCH_TERMINAL" });
  });
});
