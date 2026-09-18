/**
 * Real-Postgres regression for the 2026-09-18 batch-publish audit collision.
 *
 * Why this cannot be a Fake-DB test: the whole bug lives in a database object
 * the fakes do not model —
 *
 *     operation_audit_admin_request_action_uidx
 *     UNIQUE (request_id, action) WHERE actor_type = 'admin' AND request_id IS NOT NULL
 *
 * `tests/backend/publish-gate/fake-db.ts` accepts every audit insert, and the
 * one pre-existing batch test happened to have exactly one publishable item,
 * so the entire suite stayed green while a two-publishable-item batch aborted
 * in production. Anything asserting this fix must run against real migrations.
 *
 * Gated like `../tasks/preview-account-hold-postgres.test.ts`: set
 * `PUBLISH_BATCH_DATABASE_TEST=1` and point `PUBLISH_BATCH_DATABASE_URL` at a
 * throwaway database carrying this repo's migrations.
 */
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  publishArticlesBatch,
  publishArticlesBatchAsAdmin,
  publishBatchItemRequestId,
} from "@/server/publish-gate/service";

import { NOW, issueAuthorization, newStores, seedAdmin } from "../../backend/publish-gate/test-support";

const dispatchFirstPublicPublication = vi.fn().mockResolvedValue({ errors: [] });
vi.mock("@/server/publication/dispatcher", () => ({
  dispatchFirstPublicPublication: (...args: unknown[]) => dispatchFirstPublicPublication(...args),
}));

const enabled = process.env.PUBLISH_BATCH_DATABASE_TEST === "1";
const db = new PrismaClient({ datasourceUrl: process.env.PUBLISH_BATCH_DATABASE_URL });

const CHANNEL = randomUUID();
const SOURCE_APP = randomUUID();
const CHANNEL_APP = randomUUID();
const CHANNEL_ACCOUNT = randomUUID();
const ADMIN_ID = randomUUID();

type Seeded = { readonly articleId: string; readonly novelId: string };

async function resetFixtures(): Promise<void> {
  // Scoped teardown: only rows this suite created, never a global TRUNCATE.
  //
  // `operation_audit` is deliberately NOT cleaned: the table carries an
  // append-only trigger (`reject_operation_audit_mutation`) that refuses
  // DELETE/UPDATE outright, and that invariant is worth more than tidy test
  // fixtures. Every assertion below is keyed on an `entity_id` this suite
  // freshly generated, so leftover rows from an earlier case cannot be
  // mistaken for this one's.
  await db.$executeRaw(Prisma.sql`DELETE FROM article WHERE slug LIKE 'batch-probe-%'`);
  await db.$executeRaw(Prisma.sql`DELETE FROM novel_chapter_content WHERE novel_chapter_id IN (SELECT id FROM novel_chapter WHERE title LIKE 'batch-probe-%')`);
  await db.$executeRaw(Prisma.sql`DELETE FROM novel_chapter WHERE title LIKE 'batch-probe-%'`);
  await db.$executeRaw(Prisma.sql`DELETE FROM promo_link WHERE public_redirect_code LIKE 'bp%'`);
  await db.$executeRaw(Prisma.sql`DELETE FROM novel_source_item WHERE external_book_id LIKE 'batch-probe-%'`);
  await db.$executeRaw(Prisma.sql`DELETE FROM novel WHERE business_id LIKE 'batch-probe-%'`);
}

async function seedScope(): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    INSERT INTO channel (id, code, name, status, created_at, updated_at)
    VALUES (${CHANNEL}::uuid, ${`ch-${CHANNEL.slice(0, 8)}`}, 'batch probe', 'active', now(), now())
    ON CONFLICT DO NOTHING`);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO source_app (id, code, name, status, created_at, updated_at)
    VALUES (${SOURCE_APP}::uuid, ${`sa-${SOURCE_APP.slice(0, 8)}`}, 'MoboReader', 'active', now(), now())
    ON CONFLICT DO NOTHING`);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO channel_app (id, channel_id, source_app_id, external_app_id, project_type, status, created_at, updated_at)
    VALUES (${CHANNEL_APP}::uuid, ${CHANNEL}::uuid, ${SOURCE_APP}::uuid, ${`app-${CHANNEL_APP.slice(0, 8)}`}, 1, 'active', now(), now())
    ON CONFLICT DO NOTHING`);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO channel_account (id, channel_id, business_id, account_name, status, created_at, updated_at)
    VALUES (${CHANNEL_ACCOUNT}::uuid, ${CHANNEL}::uuid, ${`acct-${CHANNEL_ACCOUNT.slice(0, 8)}`}, 'batch probe', 'active', now(), now())
    ON CONFLICT DO NOTHING`);
}

type SeedOptions = {
  readonly preview?: "readable" | "none";
  readonly promo?: "ready" | "missing";
  readonly articleStatus?: string;
};

let seq = 0;

async function seedArticle(label: string, options: SeedOptions = {}): Promise<Seeded> {
  seq += 1;
  const novelId = randomUUID();
  const articleId = randomUUID();
  const promoId = randomUUID();
  const sourceItemId = randomUUID();
  const slug = `batch-probe-${label}-${seq}`;
  const status = options.articleStatus ?? "draft";
  await db.$executeRaw(Prisma.sql`
    INSERT INTO novel (id, business_id, title, description, locale, slug, status, total_chapter_count, created_at, updated_at)
    VALUES (${novelId}::uuid, ${`batch-probe-${novelId.slice(0, 8)}`}, ${label}, 'd', 'en', ${`n-${slug}`},
            ${status === "published" ? "published" : "draft"}, 10, now(), now())`);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO novel_source_item (id, channel_app_id, novel_id, external_book_id, external_agency_id, source_language_code,
                                   title, description, raw_payload, raw_payload_schema_version, created_at, updated_at)
    VALUES (${sourceItemId}::uuid, ${CHANNEL_APP}::uuid, ${novelId}::uuid, ${`batch-probe-${sourceItemId.slice(0, 8)}`},
            '7', '1', ${label}, 'd', '{}'::jsonb, 1, now(), now())`);
  if ((options.promo ?? "ready") === "ready") {
    await db.$executeRaw(Prisma.sql`
      INSERT INTO promo_link (id, novel_id, novel_source_item_id, channel_app_id, channel_account_id, offer_type,
                              public_redirect_code, idempotency_key, status, web_url, created_at, updated_at)
      VALUES (${promoId}::uuid, ${novelId}::uuid, ${sourceItemId}::uuid, ${CHANNEL_APP}::uuid, ${CHANNEL_ACCOUNT}::uuid,
              'default', ${`bp${seq}${novelId.slice(0, 8)}`}, ${`idem-${promoId}`},
              'fetched', 'https://example.test/read', now(), now())`);
  }
  await db.$executeRaw(Prisma.sql`
    INSERT INTO article (id, novel_id, locale, slug, public_page_short_id, title, body, status, published_at,
                         promo_link_id, seo_metadata, seo_schema_version, article_type, content_mode, seo_visibility, created_at, updated_at)
    VALUES (${articleId}::uuid, ${novelId}::uuid, 'en', ${slug}, ${`s${seq}${articleId.slice(0, 6)}`}, ${label}, 'body',
            ${status}, ${status === "published" ? Prisma.sql`now()` : Prisma.sql`NULL`},
            ${(options.promo ?? "ready") === "ready" ? promoId : null}::uuid,
            '{}'::jsonb, 1, 'novel_article', 'template', 'public', now(), now())`);
  if ((options.preview ?? "readable") === "readable") {
    const chapterId = randomUUID();
    await db.$executeRaw(Prisma.sql`
      INSERT INTO novel_chapter (id, novel_id, canonical_chapter_number, title, status, created_at, updated_at)
      VALUES (${chapterId}::uuid, ${novelId}::uuid, 1, ${`batch-probe-${label}`}, 'preview', now(), now())`);
    await db.$executeRaw(Prisma.sql`
      INSERT INTO novel_chapter_content (id, novel_chapter_id, body, char_count, content_hash, materialized_at, created_at, updated_at)
      VALUES (${randomUUID()}::uuid, ${chapterId}::uuid, 'chapter body', 12, ${"0".repeat(64)}, now(), now(), now())`);
  }
  return { articleId, novelId };
}

const ADMIN_ACTOR = { type: "admin" as const, adminId: ADMIN_ID };

async function statusOf(articleId: string): Promise<string> {
  const rows = await db.$queryRaw<Array<{ status: string }>>(
    Prisma.sql`SELECT status FROM article WHERE id = ${articleId}::uuid`);
  return rows[0]!.status;
}

async function publishAuditsFor(articleId: string): Promise<Array<{ request_id: string | null }>> {
  return db.$queryRaw<Array<{ request_id: string | null }>>(Prisma.sql`
    SELECT request_id FROM operation_audit
    WHERE action = 'article.publish' AND entity_id = ${articleId} AND actor_id = ${ADMIN_ID}
    ORDER BY id`);
}

describe.skipIf(!enabled)("batch publish · real Postgres (audit unique index in force)", () => {
  beforeEach(async () => {
    dispatchFirstPublicPublication.mockClear();
    await seedScope();
    await resetFixtures();
  });

  afterAll(async () => {
    await resetFixtures();
    await db.$disconnect();
  });

  it("the index this fix exists for really is present and really is (request_id, action)", async () => {
    const rows = await db.$queryRaw<Array<{ indexdef: string }>>(Prisma.sql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'operation_audit' AND indexname = 'operation_audit_admin_request_action_uidx'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toContain("UNIQUE");
    expect(rows[0]!.indexdef).toContain("request_id");
    expect(rows[0]!.indexdef).toContain("action");
    // Not keyed on entity_id — which is exactly why the per-item replay
    // lookup (which IS keyed on it) could not protect the insert.
    expect(rows[0]!.indexdef).not.toContain("entity_id");
  });

  it("Case 1a: two publishable articles in one batch both succeed", async () => {
    const a = await seedArticle("two-a");
    const b = await seedArticle("two-b");
    const requestId = randomUUID();

    const result = await publishArticlesBatch(db, {
      articleIds: [a.articleId, b.articleId],
      requestId,
      actor: ADMIN_ACTOR,
    });

    expect(result.aborted).toBeUndefined();
    expect(result.results.map((entry) => entry.result.outcome)).toEqual(["published", "published"]);
    expect(await statusOf(a.articleId)).toBe("published");
    expect(await statusOf(b.articleId)).toBe("published");
    // Each row carries its own derived operation id; the batch id is still the
    // shared prefix, so one grep on it still finds the whole batch.
    expect((await publishAuditsFor(a.articleId)).map((row) => row.request_id))
      .toEqual([publishBatchItemRequestId(requestId, a.articleId)]);
    expect((await publishAuditsFor(b.articleId)).map((row) => row.request_id))
      .toEqual([publishBatchItemRequestId(requestId, b.articleId)]);
    const linked = await db.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT count(*)::bigint AS count FROM operation_audit
      WHERE action = 'article.publish' AND request_id LIKE ${`${requestId}:%`}`);
    expect(Number(linked[0]!.count)).toBe(2);
  });

  it("Case 1b: a 20-article batch publishes all 20", async () => {
    const seeded: Seeded[] = [];
    for (let index = 0; index < 20; index += 1) seeded.push(await seedArticle(`bulk-${index}`));
    const requestId = randomUUID();

    const result = await publishArticlesBatch(db, {
      articleIds: seeded.map((item) => item.articleId),
      requestId,
      actor: ADMIN_ACTOR,
    });

    expect(result.aborted).toBeUndefined();
    expect(result.results).toHaveLength(20);
    expect(result.results.every((entry) => entry.result.outcome === "published")).toBe(true);
    for (const item of seeded) expect(await statusOf(item.articleId)).toBe("published");
    expect(dispatchFirstPublicPublication).toHaveBeenCalledTimes(20);
  });

  it("Case 2: replaying the SAME batch requestId does not add success audits or re-fire first-publish side effects", async () => {
    const a = await seedArticle("replay-a");
    const b = await seedArticle("replay-b");
    const requestId = randomUUID();
    const ids = [a.articleId, b.articleId];

    const first = await publishArticlesBatch(db, { articleIds: ids, requestId, actor: ADMIN_ACTOR });
    expect(first.results.every((entry) => entry.result.outcome === "published")).toBe(true);
    expect(dispatchFirstPublicPublication).toHaveBeenCalledTimes(2);

    dispatchFirstPublicPublication.mockClear();
    const replay = await publishArticlesBatch(db, { articleIds: ids, requestId, actor: ADMIN_ACTOR });

    expect(replay.aborted).toBeUndefined();
    expect(replay.results.every((entry) => entry.result.outcome === "published")).toBe(true);
    // The replay recognised both as already done: no second audit row…
    expect(await publishAuditsFor(a.articleId)).toHaveLength(1);
    expect(await publishAuditsFor(b.articleId)).toHaveLength(1);
    // …and no second first-publish dispatch.
    expect(dispatchFirstPublicPublication).not.toHaveBeenCalled();
  });

  it("Case 2b: the per-item id is derived from the article, not the loop position — reordering the same batch still replays", async () => {
    const a = await seedArticle("order-a");
    const b = await seedArticle("order-b");
    const requestId = randomUUID();

    await publishArticlesBatch(db, { articleIds: [a.articleId, b.articleId], requestId, actor: ADMIN_ACTOR });
    dispatchFirstPublicPublication.mockClear();
    // Same batch id, REVERSED order. A loop-index-derived id would produce
    // brand-new operation ids here and re-publish both.
    const replay = await publishArticlesBatch(db, { articleIds: [b.articleId, a.articleId], requestId, actor: ADMIN_ACTOR });

    expect(replay.aborted).toBeUndefined();
    expect(await publishAuditsFor(a.articleId)).toHaveLength(1);
    expect(await publishAuditsFor(b.articleId)).toHaveLength(1);
    expect(dispatchFirstPublicPublication).not.toHaveBeenCalled();
  });

  it("Case 2c: a duplicate article id inside one batch is a replay of itself, never a collision", async () => {
    const a = await seedArticle("dup-a");
    const requestId = randomUUID();

    const result = await publishArticlesBatch(db, {
      articleIds: [a.articleId, a.articleId],
      requestId,
      actor: ADMIN_ACTOR,
    });

    expect(result.aborted).toBeUndefined();
    expect(result.results.map((entry) => entry.result.outcome)).toEqual(["published", "published"]);
    expect(await publishAuditsFor(a.articleId)).toHaveLength(1);
    expect(dispatchFirstPublicPublication).toHaveBeenCalledTimes(1);
  });

  it("Case 3: publishable + gate-rejected + already-published mix reports each correctly", async () => {
    const ok = await seedArticle("mix-ok");
    const noPromo = await seedArticle("mix-nopromo", { promo: "missing" });
    const noPreview = await seedArticle("mix-nopreview", { preview: "none" });
    const alreadyPublished = await seedArticle("mix-done", { articleStatus: "published" });
    const requestId = randomUUID();

    const result = await publishArticlesBatch(db, {
      articleIds: [ok.articleId, noPromo.articleId, noPreview.articleId, alreadyPublished.articleId],
      requestId,
      actor: ADMIN_ACTOR,
    });

    expect(result.aborted).toBeUndefined();
    const byId = new Map(result.results.map((entry) => [entry.articleId, entry.result]));
    expect(byId.get(ok.articleId)!.outcome).toBe("published");
    // 产品口径未变：缺 promo 仍然拒绝……
    expect(byId.get(noPromo.articleId)).toMatchObject({
      outcome: "rejected",
      gate: { reasons: ["promo_link_missing"] },
    });
    expect(await statusOf(noPromo.articleId)).toBe("draft");
    // ……没有试读仍然可以发布，只带 warning。
    expect(byId.get(noPreview.articleId)).toMatchObject({
      outcome: "published",
      warnings: ["preview_chapter_missing"],
    });
    expect(await statusOf(noPreview.articleId)).toBe("published");
    // 已发布的再发一次：是一次新操作（新的 requestId），不是重放，会再写一条审计。
    expect(byId.get(alreadyPublished.articleId)!.outcome).toBe("published");
    expect(await publishAuditsFor(alreadyPublished.articleId)).toHaveLength(1);
  });

  it("Case 5: a genuine unique violation from another constraint is reported, never smuggled through as success", async () => {
    const a = await seedArticle("conflict-a");
    const b = await seedArticle("conflict-b");
    // Pre-write the audit row the SECOND item is going to need, using that
    // item's own derived operation id. Its insert will now hit the same
    // unique index for a reason the fix does not address, which is exactly
    // the case that must NOT be interpreted as "already done".
    const requestId = randomUUID();
    await db.$executeRaw(Prisma.sql`
      INSERT INTO operation_audit (actor_type, actor_id, action, entity_type, entity_id, request_id, created_at)
      VALUES ('admin', ${`${ADMIN_ID}-squatter`}, 'article.publish', 'Article', ${randomUUID()},
              ${publishBatchItemRequestId(requestId, b.articleId)}, now())`);

    const result = await publishArticlesBatch(db, {
      articleIds: [a.articleId, b.articleId],
      requestId,
      actor: ADMIN_ACTOR,
    });

    // Item 1 really published and stays published.
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.result.outcome).toBe("published");
    expect(await statusOf(a.articleId)).toBe("published");
    // Item 2 aborted, named, and truthfully left alone — not counted as success.
    expect(result.aborted).toMatchObject({ articleId: b.articleId, notProcessedArticleIds: [] });
    // Exact shape, not a substring: this is the whole sanitization contract —
    // Prisma's class + code + the constraint's column names, and nothing else.
    // A regression that appended `error.message` (which embeds the conflicting
    // row's values) would still contain "P2002" and slip past a loose check.
    expect(result.aborted!.errorKind).toBe("PrismaClientKnownRequestError:P2002:request_id,action");
    expect(result.aborted!.errorKind).not.toContain(requestId);
    expect(await statusOf(b.articleId)).toBe("draft");
    // Item 1's audit row carries its OWN derived id — proof that the abort was
    // the pre-planted squatter row and not the pre-fix shared-id collision,
    // which would have made item 1 the one item 2 collided with.
    expect((await publishAuditsFor(a.articleId)).map((row) => row.request_id))
      .toEqual([publishBatchItemRequestId(requestId, a.articleId)]);
  });

  it("Case 4: after a mid-batch abort, committed items stay committed and untouched items are reported as not processed", async () => {
    const a = await seedArticle("abort-a");
    const b = await seedArticle("abort-b");
    const c = await seedArticle("abort-c");
    // A second unreached item, so `notProcessedArticleIds` pins order and
    // multiplicity rather than being satisfied by any single-element array.
    const d = await seedArticle("abort-d");
    const requestId = randomUUID();
    await db.$executeRaw(Prisma.sql`
      INSERT INTO operation_audit (actor_type, actor_id, action, entity_type, entity_id, request_id, created_at)
      VALUES ('admin', ${`${ADMIN_ID}-squatter`}, 'article.publish', 'Article', ${randomUUID()},
              ${publishBatchItemRequestId(requestId, b.articleId)}, now())`);

    const result = await publishArticlesBatch(db, {
      articleIds: [a.articleId, b.articleId, c.articleId, d.articleId],
      requestId,
      actor: ADMIN_ACTOR,
    });

    expect(result.results.map((entry) => entry.articleId)).toEqual([a.articleId]);
    expect(result.aborted).toEqual({
      articleId: b.articleId,
      errorKind: "PrismaClientKnownRequestError:P2002:request_id,action",
      notProcessedArticleIds: [c.articleId, d.articleId],
    });
    expect(await statusOf(a.articleId)).toBe("published"); // committed, NOT rolled back
    expect(await statusOf(b.articleId)).toBe("draft");     // its own transaction rolled back
    expect(await statusOf(c.articleId)).toBe("draft");     // never attempted
    expect(await statusOf(d.articleId)).toBe("draft");     // never attempted
    // Same proof as Case 5: item 1 used its own derived id, so the abort is
    // attributable to the squatter row, not to a shared-id collision.
    expect((await publishAuditsFor(a.articleId)).map((row) => row.request_id))
      .toEqual([publishBatchItemRequestId(requestId, a.articleId)]);
  });

  it("Case 5b: two concurrent submissions of the same batch do not double-publish or double-dispatch", async () => {
    const a = await seedArticle("race-a");
    const b = await seedArticle("race-b");
    const requestId = randomUUID();
    const ids = [a.articleId, b.articleId];

    const [left, right] = await Promise.all([
      publishArticlesBatch(db, { articleIds: ids, requestId, actor: ADMIN_ACTOR }).catch((error) => error),
      publishArticlesBatch(db, { articleIds: ids, requestId, actor: ADMIN_ACTOR }).catch((error) => error),
    ]);

    // Whatever the interleaving, the durable facts must hold: one audit row
    // per article, one first-publish dispatch per article, both published.
    expect(await statusOf(a.articleId)).toBe("published");
    expect(await statusOf(b.articleId)).toBe("published");
    expect(await publishAuditsFor(a.articleId)).toHaveLength(1);
    expect(await publishAuditsFor(b.articleId)).toHaveLength(1);
    // Exactly one first-publish dispatch per article across BOTH callers —
    // `toBeLessThanOrEqual` would also accept 0, which would mean neither call
    // ever published anything.
    expect(dispatchFirstPublicPublication).toHaveBeenCalledTimes(2);
    // Neither call may report an article as published that is not actually
    // published in the database.
    for (const outcome of [left, right]) {
      if (outcome instanceof Error) continue;
      for (const entry of outcome.results as Array<{ articleId: string; result: { outcome: string } }>) {
        if (entry.result.outcome !== "published") continue;
        expect(await statusOf(entry.articleId)).toBe("published");
      }
    }
  });

  it("Case 6a: the articles-page entry (publishArticlesBatchAsAdmin, real authorization) publishes a two-item batch", async () => {
    const a = await seedArticle("entry-a");
    const b = await seedArticle("entry-b");
    const stores = newStores();
    const { token } = seedAdmin(stores, { identityId: ADMIN_ID });
    const { authorization, requestId } = await issueAuthorization(stores, "admin.article.publish_batch", token);

    const result = await publishArticlesBatchAsAdmin(
      { authorization, requestId, articleIds: [a.articleId, b.articleId] },
      // Same `Dependencies` shape the fake-db wrapper test uses — a real,
      // guard-checked authorization on one side, the real database on the
      // other. `now` is the fixed instant `seedAdmin`'s session was minted
      // against (`NOW`), so session freshness is deterministic.
      { db, identities: stores, sessions: stores, now: NOW },
    );

    expect(result.aborted).toBeUndefined();
    expect(result.results.map((entry) => entry.result.outcome)).toEqual(["published", "published"]);
    expect(await statusOf(a.articleId)).toBe("published");
    expect(await statusOf(b.articleId)).toBe("published");
  });
});
