import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.P1_05B_DATABASE_TEST === "1";
const prisma = new PrismaClient();

const ids = {
  channel: "00000000-0000-4000-8000-000000000001",
  source: "10000000-0000-4000-8000-000000000001",
  appA: "20000000-0000-4000-8000-000000000001",
  appB: "20000000-0000-4000-8000-000000000002",
  accountA: "30000000-0000-4000-8000-000000000001",
  accountB: "30000000-0000-4000-8000-000000000002",
  novelA: "40000000-0000-4000-8000-000000000001",
  novelB: "40000000-0000-4000-8000-000000000002",
  sourceA: "50000000-0000-4000-8000-000000000001",
  sourceB: "50000000-0000-4000-8000-000000000002",
  promoA: "60000000-0000-4000-8000-000000000001",
  promoB: "60000000-0000-4000-8000-000000000002",
  credentialA: "70000000-0000-4000-8000-000000000001",
  credentialB: "70000000-0000-4000-8000-000000000002",
} as const;

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
      const prismaHidUniqueName = text.includes("Code: `23505`") && /(?:key|uidx)$/.test(marker);
      expect(prismaHidUniqueName, text).toBe(true);
    }
    return;
  }
  throw new Error("Expected PostgreSQL to reject the statement");
}

function articleInsert({
  id,
  novelId = ids.novelA,
  promoLinkId = `'${ids.promoA}'`,
  locale,
  slug = "'published-slug'",
  title = "'Published title'",
  body = "'Rendered SEO article body'",
  status = "published",
  publishedAt = "now()",
}: {
  id: string;
  novelId?: string;
  promoLinkId?: string;
  locale: string;
  slug?: string;
  title?: string;
  body?: string;
  status?: string;
  publishedAt?: string;
}) {
  return `
    INSERT INTO article (
      id, novel_id, promo_link_id, locale, slug, public_page_short_id,
      title, body, status, published_at, updated_at
    ) VALUES (
      '${id}', '${novelId}', ${promoLinkId}, '${locale}', ${slug},
      '${id.slice(-12)}', ${title}, ${body}, '${status}', ${publishedAt}, now()
    )
  `;
}

async function seedFoundation() {
  await executeBatch(`
    INSERT INTO channel (id, code, name, updated_at)
    VALUES ('${ids.channel}', 'test-channel', 'Test Channel', now());
    INSERT INTO source_app (id, code, name, updated_at)
    VALUES ('${ids.source}', 'test-source', 'Test Source', now());
    INSERT INTO channel_app (id, channel_id, source_app_id, external_app_id, project_type, updated_at)
    VALUES
      ('${ids.appA}', '${ids.channel}', '${ids.source}', 'app-a', 2, now()),
      ('${ids.appB}', '${ids.channel}', '${ids.source}', 'app-b', 2, now());
    INSERT INTO channel_account (id, channel_id, business_id, account_name, updated_at)
    VALUES
      ('${ids.accountA}', '${ids.channel}', 'account-a', 'Account A', now()),
      ('${ids.accountB}', '${ids.channel}', 'account-b', 'Account B', now());
    INSERT INTO novel (id, business_id, title, description, locale, slug, status, updated_at)
    VALUES
      ('${ids.novelA}', 'novel-a', 'Novel A', 'Description A', 'en-US', 'novel-a', 'ready', now()),
      ('${ids.novelB}', 'novel-b', 'Novel B', 'Description B', 'en-US', 'novel-b', 'ready', now());
    INSERT INTO novel_source_item (
      id, channel_app_id, novel_id, external_book_id, source_language_code,
      source_locale, title, description, status, raw_payload, updated_at
    ) VALUES
      ('${ids.sourceA}', '${ids.appA}', '${ids.novelA}', 'book-a', 'en', 'en-US', 'Book A', 'Description A', 'linked', '{}', now()),
      ('${ids.sourceB}', '${ids.appA}', '${ids.novelB}', 'book-b', 'en', 'en-US', 'Book B', 'Description B', 'linked', '{}', now());
    INSERT INTO promo_link (
      id, novel_id, novel_source_item_id, channel_app_id, channel_account_id,
      offer_type, public_redirect_code, idempotency_key, status, updated_at
    ) VALUES
      ('${ids.promoA}', '${ids.novelA}', '${ids.sourceA}', '${ids.appA}', '${ids.accountA}', 'read', 'PUB_A', repeat('a', 64), 'fetched', now()),
      ('${ids.promoB}', '${ids.novelB}', '${ids.sourceB}', '${ids.appA}', '${ids.accountA}', 'read', 'PUB_SOFT', repeat('b', 64), 'fetched', now());
    INSERT INTO channel_account_credential (
      id, channel_account_id, encrypted_secret, key_version, secret_fingerprint,
      fingerprint_prefix, status, updated_at
    ) VALUES
      ('${ids.credentialA}', '${ids.accountA}', decode('01', 'hex'), 1, repeat('a', 64), 'aaaa', 'active', now()),
      ('${ids.credentialB}', '${ids.accountB}', decode('02', 'hex'), 1, repeat('b', 64), 'bbbb', 'active', now());
  `);
}

function collectIndexNames(node: unknown, output = new Set<string>()) {
  if (Array.isArray(node)) {
    for (const value of node) collectIndexNames(value, output);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "Index Name" && typeof value === "string") output.add(value);
      collectIndexNames(value, output);
    }
  }
  return output;
}

async function explainIndex(sql: string, expected: string) {
  const rows = await prisma.$queryRawUnsafe<Array<{ "QUERY PLAN": unknown }>>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
  );
  const names = collectIndexNames(rows[0]["QUERY PLAN"]);
  expect(names.has(expected)).toBe(true);
  return [...names];
}

describe.skipIf(!enabled).sequential("P1-05B PostgreSQL constraints", () => {
  beforeAll(async () => {
    const [{ database_name: databaseName }] = await prisma.$queryRawUnsafe<
      Array<{ database_name: string }>
    >(`SELECT current_database() AS database_name`);
    if (!databaseName.includes("p1_05b")) {
      throw new Error(`Refusing destructive test setup against ${databaseName}`);
    }
    const tables = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
    `);
    const names = tables.map(({ tablename }) => `"${tablename}"`).join(", ");
    await execute(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
    await seedFoundation();
  }, 30_000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("rejects every incomplete published Article shape", async () => {
    await expectDatabaseFailure(
      articleInsert({ id: "90000000-0000-4000-8000-000000000001", locale: "x-01", title: "'   '" }),
      "article_published_title_check",
    );
    await expectDatabaseFailure(
      articleInsert({ id: "90000000-0000-4000-8000-000000000002", locale: "x-02", slug: "'   '" }),
      "article_published_slug_check",
    );
    await expectDatabaseFailure(
      articleInsert({ id: "90000000-0000-4000-8000-000000000003", locale: "x-03", body: "'   '" }),
      "article_published_body_check",
    );
    await expectDatabaseFailure(
      articleInsert({ id: "90000000-0000-4000-8000-000000000004", locale: "x-04", promoLinkId: "NULL" }),
      "article_published_promo_link_check",
    );
    await expectDatabaseFailure(
      articleInsert({ id: "90000000-0000-4000-8000-000000000005", locale: "x-05", publishedAt: "NULL" }),
      "article_published_published_at_check",
    );
  });

  it("enforces same-Novel PromoLink while preserving MATCH SIMPLE drafts", async () => {
    await expectDatabaseFailure(
      articleInsert({
        id: "90000000-0000-4000-8000-000000000006",
        novelId: ids.novelA,
        promoLinkId: `'${ids.promoB}'`,
        locale: "x-06",
        status: "draft",
        publishedAt: "NULL",
      }),
      "article_promo_link_novel_fkey",
    );
    await execute(
      articleInsert({
        id: "90000000-0000-4000-8000-000000000007",
        promoLinkId: "NULL",
        locale: "en-US",
        status: "draft",
        publishedAt: "NULL",
      }),
    );
    const rows = await prisma.$queryRawUnsafe<Array<{ confmatchtype: string }>>(`
      SELECT confmatchtype::text FROM pg_constraint
      WHERE conname = 'article_promo_link_novel_fkey'
    `);
    expect(rows).toEqual([{ confmatchtype: "s" }]);
  });

  it("permanently reserves and freezes public redirect codes", async () => {
    await expectDatabaseFailure(`
      INSERT INTO promo_link (
        id, novel_id, novel_source_item_id, channel_app_id, channel_account_id,
        offer_type, public_redirect_code, idempotency_key, status, updated_at
      ) VALUES (
        '60000000-0000-4000-8000-000000000003', '${ids.novelA}', '${ids.sourceA}',
        '${ids.appA}', '${ids.accountA}', 'read', 'PUB_A', repeat('c', 64), 'fetched', now()
      )
    `, "promo_link_public_redirect_code_key");
    await execute(`UPDATE promo_link SET deleted_at = now(), updated_at = now() WHERE id = '${ids.promoB}'`);
    await expectDatabaseFailure(`
      INSERT INTO promo_link (
        id, novel_id, novel_source_item_id, channel_app_id, channel_account_id,
        offer_type, public_redirect_code, idempotency_key, status, updated_at
      ) VALUES (
        '60000000-0000-4000-8000-000000000004', '${ids.novelA}', '${ids.sourceA}',
        '${ids.appA}', '${ids.accountA}', 'read', 'PUB_SOFT', repeat('d', 64), 'fetched', now()
      )
    `, "promo_link_public_redirect_code_key");
    await expectDatabaseFailure(
      `UPDATE promo_link SET public_redirect_code = 'PUB_CHANGED' WHERE id = '${ids.promoA}'`,
      "public_redirect_code is immutable",
    );
  });

  it("uses a database-unique active credential fingerprint latch", async () => {
    await executeBatch(`
      INSERT INTO channel_credential_active_fingerprint (
        id, fingerprint, credential_id, channel_account_id, credential_type
      ) VALUES (
        '71000000-0000-4000-8000-000000000001', repeat('f', 64),
        '${ids.credentialA}', '${ids.accountA}', 'bearer_jwt'
      )
    `);
    await expectDatabaseFailure(`
      INSERT INTO channel_credential_active_fingerprint (
        id, fingerprint, credential_id, channel_account_id, credential_type
      ) VALUES (
        '71000000-0000-4000-8000-000000000002', repeat('f', 64),
        '${ids.credentialB}', '${ids.accountB}', 'bearer_jwt'
      )
    `, "channel_credential_active_fingerprint_fingerprint_key");
  });

  it("enforces CatalogScan active scope per account and app", async () => {
    await execute(`
      INSERT INTO catalog_scan_task (
        id, channel_account_id, channel_app_id, project_type, request_token,
        page_start, page_end, page_size, updated_at
      ) VALUES (
        'a0000000-0000-4000-8000-000000000001', '${ids.accountA}', '${ids.appA}', 2,
        'scan-a', 1, 2, 20, now()
      )
    `);
    await expectDatabaseFailure(`
      INSERT INTO catalog_scan_task (
        id, channel_account_id, channel_app_id, project_type, request_token,
        page_start, page_end, page_size, status, updated_at
      ) VALUES (
        'a0000000-0000-4000-8000-000000000002', '${ids.accountA}', '${ids.appA}', 2,
        'scan-conflict', 1, 2, 20, 'processing', now()
      )
    `, "catalog_scan_active_scope_uidx");
    await execute(`
      INSERT INTO catalog_scan_task (
        id, channel_account_id, channel_app_id, project_type, request_token,
        page_start, page_end, page_size, updated_at
      ) VALUES
        ('a0000000-0000-4000-8000-000000000003', '${ids.accountB}', '${ids.appA}', 2, 'scan-account-b', 1, 2, 20, now()),
        ('a0000000-0000-4000-8000-000000000004', '${ids.accountA}', '${ids.appB}', 2, 'scan-app-b', 1, 2, 20, now())
    `);
  });

  it("enforces IndexNow, side-effect, status, and append-only constraints", async () => {
    await execute(`
      INSERT INTO indexnow_outbox (id, url, revision, event_type, locale, source, updated_at)
      VALUES ('b0000000-0000-4000-8000-000000000001', 'https://example.test/n/a', 1, 'publish', 'en-US', 'article', now())
    `);
    await expectDatabaseFailure(`
      INSERT INTO indexnow_outbox (id, url, revision, event_type, locale, source, updated_at)
      VALUES ('b0000000-0000-4000-8000-000000000002', 'https://example.test/n/a', 1, 'publish', 'en-US', 'article', now())
    `, "indexnow_outbox_url_revision_key");
    await execute(`
      INSERT INTO side_effect_intent (id, effect_key, operation_type, idempotency_key, target_type, target_id)
      VALUES ('c0000000-0000-4000-8000-000000000001', repeat('e', 64), 'claim', repeat('1', 64), 'promo', 'a')
    `);
    await expectDatabaseFailure(`
      INSERT INTO side_effect_intent (id, effect_key, operation_type, idempotency_key, target_type, target_id)
      VALUES ('c0000000-0000-4000-8000-000000000002', repeat('e', 64), 'claim', repeat('2', 64), 'promo', 'b')
    `, "side_effect_intent_effect_key_key");
    await expectDatabaseFailure(`
      INSERT INTO novel (id, business_id, title, description, locale, slug, status, updated_at)
      VALUES ('40000000-0000-4000-8000-000000000099', 'invalid-status', 'Invalid', 'Invalid', 'en-US', 'invalid-status', 'bogus', now())
    `, "novel_status_check");
    const [{ id }] = await prisma.$queryRawUnsafe<Array<{ id: bigint }>>(`
      INSERT INTO operation_audit (actor_type, action, entity_type, entity_id)
      VALUES ('test', 'insert', 'Novel', '${ids.novelA}') RETURNING id
    `);
    await expectDatabaseFailure(`UPDATE operation_audit SET action = 'mutated' WHERE id = ${id}`, "operation_audit is append-only");
    await expectDatabaseFailure(`DELETE FROM operation_audit WHERE id = ${id}`, "operation_audit is append-only");
  });

  it("accepts stale and withdrawn chapter states", async () => {
    await execute(`
      INSERT INTO novel_chapter (id, novel_id, canonical_chapter_number, status, updated_at)
      VALUES
        ('d0000000-0000-4000-8000-000000000001', '${ids.novelA}', 1, 'stale', now()),
        ('d0000000-0000-4000-8000-000000000002', '${ids.novelA}', 2, 'withdrawn', now())
    `);
  });

  it("uses separate pending-claim and expired-lease indexes for every Item table", async () => {
    await executeBatch(`
      INSERT INTO catalog_scan_task (
        id, channel_account_id, channel_app_id, project_type, request_token,
        page_start, page_end, page_size, status, updated_at
      ) VALUES (
        'a0000000-0000-4000-8000-000000000010', '${ids.accountA}', '${ids.appA}', 9,
        'scan-explain', 1, 6000, 20, 'completed', now()
      );
      INSERT INTO channel_sync_task (
        id, task_type, channel_account_id, channel_app_id, operation_scope_hash,
        request_token, status, updated_at
      ) VALUES (
        'e0000000-0000-4000-8000-000000000010', 'explain', '${ids.accountA}', '${ids.appA}',
        repeat('e', 64), 'sync-explain', 'completed', now()
      );
      INSERT INTO generic_task (
        id, task_type, operation_scope_hash, request_token, status, updated_at
      ) VALUES (
        'f0000000-0000-4000-8000-000000000010', 'explain', repeat('f', 64),
        'generic-explain', 'completed', now()
      );
      INSERT INTO novel_source_item (
        id, channel_app_id, external_book_id, source_language_code, title,
        description, status, raw_payload, updated_at
      )
      SELECT
        ('81000000-0000-4000-8000-' || lpad(gs::text, 12, '0'))::uuid,
        '${ids.appA}', 'explain-' || gs, 'en', 'Explain ' || gs, '', 'pending', '{}', now()
      FROM generate_series(1, 6000) gs;
      INSERT INTO catalog_scan_task_item (
        id, task_id, page_index, request_fingerprint, status, attempt_count,
        execution_token, lease_epoch, locked_by, locked_until, updated_at
      )
      SELECT
        ('82000000-0000-4000-8000-' || lpad(gs::text, 12, '0'))::uuid,
        'a0000000-0000-4000-8000-000000000010', gs, repeat(md5(gs::text), 2),
        CASE WHEN gs <= 20 THEN 'pending' WHEN gs <= 40 THEN 'processing' ELSE 'success' END,
        CASE WHEN gs BETWEEN 21 AND 40 THEN 1 ELSE 0 END,
        CASE WHEN gs BETWEEN 21 AND 40 THEN ('83000000-0000-4000-8000-' || lpad(gs::text, 12, '0'))::uuid ELSE NULL END,
        CASE WHEN gs BETWEEN 21 AND 40 THEN 1 ELSE 0 END,
        CASE WHEN gs BETWEEN 21 AND 40 THEN 'worker-a' ELSE NULL END,
        CASE WHEN gs BETWEEN 21 AND 40 THEN now() - interval '1 hour' ELSE NULL END,
        now()
      FROM generate_series(1, 6000) gs;
      INSERT INTO channel_sync_task_item (
        id, task_id, novel_source_item_id, status, attempt_count, execution_token,
        lease_epoch, locked_by, locked_until, updated_at
      )
      SELECT
        ('84000000-0000-4000-8000-' || lpad(gs::text, 12, '0'))::uuid,
        'e0000000-0000-4000-8000-000000000010',
        ('81000000-0000-4000-8000-' || lpad(gs::text, 12, '0'))::uuid,
        CASE WHEN gs <= 20 THEN 'pending' WHEN gs <= 40 THEN 'processing' ELSE 'success' END,
        CASE WHEN gs BETWEEN 21 AND 40 THEN 1 ELSE 0 END,
        CASE WHEN gs BETWEEN 21 AND 40 THEN ('85000000-0000-4000-8000-' || lpad(gs::text, 12, '0'))::uuid ELSE NULL END,
        CASE WHEN gs BETWEEN 21 AND 40 THEN 1 ELSE 0 END,
        CASE WHEN gs BETWEEN 21 AND 40 THEN 'worker-b' ELSE NULL END,
        CASE WHEN gs BETWEEN 21 AND 40 THEN now() - interval '1 hour' ELSE NULL END,
        now()
      FROM generate_series(1, 6000) gs;
      INSERT INTO generic_task_item (
        id, task_id, target_type, target_id, status, attempt_count, execution_token,
        lease_epoch, locked_by, locked_until, updated_at
      )
      SELECT
        ('86000000-0000-4000-8000-' || lpad(gs::text, 12, '0'))::uuid,
        'f0000000-0000-4000-8000-000000000010', 'explain', gs::text,
        CASE WHEN gs <= 20 THEN 'pending' WHEN gs <= 40 THEN 'processing' ELSE 'success' END,
        CASE WHEN gs BETWEEN 21 AND 40 THEN 1 ELSE 0 END,
        CASE WHEN gs BETWEEN 21 AND 40 THEN ('87000000-0000-4000-8000-' || lpad(gs::text, 12, '0'))::uuid ELSE NULL END,
        CASE WHEN gs BETWEEN 21 AND 40 THEN 1 ELSE 0 END,
        CASE WHEN gs BETWEEN 21 AND 40 THEN 'worker-c' ELSE NULL END,
        CASE WHEN gs BETWEEN 21 AND 40 THEN now() - interval '1 hour' ELSE NULL END,
        now()
      FROM generate_series(1, 6000) gs;
      ANALYZE catalog_scan_task_item;
      ANALYZE channel_sync_task_item;
      ANALYZE generic_task_item;
    `);

    const tables = ["catalog_scan_task_item", "channel_sync_task_item", "generic_task_item"];
    const plans: Record<string, { pending: string[]; recovery: string[] }> = {};
    for (const table of tables) {
      plans[table] = {
        pending: await explainIndex(
          `SELECT id FROM "${table}" WHERE status = 'pending' ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
          `${table}_pending_global_idx`,
        ),
        recovery: await explainIndex(
          `SELECT id FROM "${table}" WHERE status = 'processing' AND locked_until < transaction_timestamp() ORDER BY locked_until, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
          `${table}_expired_lease_idx`,
        ),
      };
    }
    process.stdout.write(`P1_05B_INDEX_PLANS=${JSON.stringify(plans)}\n`);
  }, 60_000);
});
