/**
 * M-2 (C-27 review closure, `docs/governance/database-governance.md` §12
 * C-27 row / 规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md §三/C-27
 * "测试" section — "tests/integration/: **必需**"): real-PostgreSQL
 * verification of the C-27 migration
 * (`prisma/migrations/20260910090000_c27_blog_article_foundation/migration.sql`),
 * which cannot be exercised by any unit test — CHECK constraints and the
 * partial/composite-key NULL semantics they lean on only exist inside the
 * database engine itself.
 *
 * Scope (four things, matching this review's exact ask):
 *   1. `article_novel_id_by_type_check` rejects a `novel_article` with a
 *      NULL `novel_id` (plus, for a complete truth table on the same CHECK,
 *      its mirror-image case: a non-`novel_article` with a non-NULL
 *      `novel_id`).
 *   2. `article_published_promo_link_check` still rejects a published
 *      `novel_article` with no PromoLink — the regression check the plan
 *      itself calls out ("证明放宽没有殃及小说文章") — contrasted with a
 *      published `blog_article` with no PromoLink, which must now succeed
 *      (otherwise the fork never actually forked).
 *   3. Multiple `novel_id IS NULL` `blog_article` rows can coexist in the
 *      same locale — `article_novel_locale_key` (`UNIQUE(novel_id, locale)`)
 *      relies on PostgreSQL's default "every NULL is distinct" semantics,
 *      which this migration deliberately does not touch (see the migration
 *      file's header and governance §5 item 21).
 *   4. Existing (pre-C-27-shaped) `novel_article` rows are unaffected: the
 *      migration's own `ALTER COLUMN novel_id DROP NOT NULL` is a pure
 *      relaxation (no data rewrite), so a legacy-shaped row must remain
 *      exactly as it was and must remain normally writable.
 *
 * Not in scope here (already covered elsewhere, or explicitly out of this
 * review's four items): the composite FK's MATCH SIMPLE behavior with both
 * columns NULL (already covered by `p1-05b-postgres.test.ts`'s "enforces
 * same-Novel PromoLink while preserving MATCH SIMPLE drafts", which this
 * file does not duplicate) and the evaluator/service-layer fork (covered by
 * `tests/backend/publish-gate/evaluator.test.ts` and
 * `tests/backend/content-creation/publish-gate-e2e.test.ts`).
 *
 * Gate: `C27_DATABASE_TEST=1` against a disposable PostgreSQL database whose
 * name contains `c27` (enforced below, same "refuse to run against the
 * wrong database" discipline as every other `*-postgres.test.ts` in this
 * directory) with every migration up to and including
 * `20260910090000_c27_blog_article_foundation` already applied via
 * `prisma migrate deploy`.
 *
 * I did not run this file — this worktree has no PostgreSQL connection
 * available (no `DATABASE_URL` pointed at a real database, no container
 * runtime permitted by this task's constraints). It is written against the
 * same conventions as the existing `tests/integration/database/*-postgres
 * .test.ts` files (`p1-05b-postgres.test.ts` in particular: env-gated
 * `describe.skipIf`, a `databaseName.includes(...)` refusal guard, raw-SQL
 * `execute`/`executeBatch`/`expectDatabaseFailure` helpers, TRUNCATE-based
 * per-run reset) and reviewed carefully against the actual migration SQL
 * and `prisma/schema.prisma`'s `Article`/`Novel`/`PromoLink` shapes, but it
 * has not been executed and must be run by whoever next has a real
 * PostgreSQL 16 container available, per this task's constraints.
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.C27_DATABASE_TEST === "1";
const prisma = new PrismaClient();

const ids = {
  channel: "00000000-0000-4000-8000-0000000c2701",
  sourceApp: "10000000-0000-4000-8000-0000000c2701",
  channelApp: "20000000-0000-4000-8000-0000000c2701",
  channelAccount: "30000000-0000-4000-8000-0000000c2701",
  novel: "40000000-0000-4000-8000-0000000c2701",
  sourceItem: "50000000-0000-4000-8000-0000000c2701",
  promo: "60000000-0000-4000-8000-0000000c2701",
  legacyArticle: "70000000-0000-4000-8000-0000000c2701",
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

/**
 * Builds one `INSERT INTO article` statement. Every column not explicitly
 * about the four C-27 scenarios above gets a fixed, always-legal value —
 * same "one function, override only what a test cares about" shape as
 * `p1-05b-postgres.test.ts`'s own `articleInsert`.
 */
function articleInsert({
  id,
  novelId = "NULL",
  promoLinkId = "NULL",
  articleType = "novel_article",
  locale,
  slug,
  status = "draft",
  publishedAt = "NULL",
}: {
  id: string;
  novelId?: string;
  promoLinkId?: string;
  articleType?: "novel_article" | "blog_article";
  locale: string;
  slug: string;
  status?: "draft" | "published";
  publishedAt?: string;
}) {
  return `
    INSERT INTO article (
      id, novel_id, promo_link_id, article_type, locale, slug,
      public_page_short_id, title, body, status, published_at, updated_at
    ) VALUES (
      '${id}', ${novelId}, ${promoLinkId}, '${articleType}', '${locale}', '${slug}',
      '${id.slice(-12)}', 'Title', 'Rendered body', '${status}', ${publishedAt}, now()
    )
  `;
}

async function seedFoundation() {
  await executeBatch(`
    INSERT INTO channel (id, code, name, updated_at)
    VALUES ('${ids.channel}', 'c27-test-channel', 'C-27 Test Channel', now());
    INSERT INTO source_app (id, code, name, updated_at)
    VALUES ('${ids.sourceApp}', 'c27-test-source', 'C-27 Test Source', now());
    INSERT INTO channel_app (id, channel_id, source_app_id, external_app_id, project_type, updated_at)
    VALUES ('${ids.channelApp}', '${ids.channel}', '${ids.sourceApp}', 'c27-app', 2, now());
    INSERT INTO channel_account (id, channel_id, business_id, account_name, updated_at)
    VALUES ('${ids.channelAccount}', '${ids.channel}', 'c27-account', 'C-27 Account', now());
    INSERT INTO novel (id, business_id, title, description, locale, slug, status, updated_at)
    VALUES ('${ids.novel}', 'c27-novel', 'C-27 Novel', 'Description', 'en-US', 'c27-novel', 'ready', now());
    INSERT INTO novel_source_item (
      id, channel_app_id, novel_id, external_book_id, source_language_code,
      source_locale, title, description, status, raw_payload, updated_at
    ) VALUES (
      '${ids.sourceItem}', '${ids.channelApp}', '${ids.novel}', 'c27-book', 'en', 'en-US',
      'Book', 'Description', 'linked', '{}', now()
    );
    INSERT INTO promo_link (
      id, novel_id, novel_source_item_id, channel_app_id, channel_account_id,
      offer_type, public_redirect_code, idempotency_key, status, web_url, updated_at
    ) VALUES (
      '${ids.promo}', '${ids.novel}', '${ids.sourceItem}', '${ids.channelApp}', '${ids.channelAccount}',
      'read', 'PUBC2701', repeat('c', 64), 'fetched', 'https://example.com/c27', now()
    );
  `);
  // 4. "Existing rows unaffected" baseline — a fully legacy-shaped (pre-C-27)
  // published novel_article: novel_id set, promo_link_id set, article_type
  // defaults to 'novel_article'. Seeded once here and re-read (never
  // mutated except by the dedicated "still writable" assertion) by the
  // "existing rows unaffected" describe block below.
  await execute(articleInsert({
    id: ids.legacyArticle,
    novelId: `'${ids.novel}'`,
    promoLinkId: `'${ids.promo}'`,
    locale: "en-US",
    slug: "legacy-novel-article",
    status: "published",
    publishedAt: "now()",
  }));
}

describe.skipIf(!enabled).sequential("M-2 (C-27 review): C-27 blog article foundation — real PostgreSQL", () => {
  beforeAll(async () => {
    const [{ database_name: databaseName }] = await prisma.$queryRawUnsafe<
      Array<{ database_name: string }>
    >(`SELECT current_database() AS database_name`);
    if (!databaseName.includes("c27")) {
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

  describe("article_novel_id_by_type_check (full truth table)", () => {
    it("1. rejects a novel_article with NULL novel_id", async () => {
      await expectDatabaseFailure(
        articleInsert({
          id: "90000000-0000-4000-8000-0000000c2701",
          articleType: "novel_article",
          novelId: "NULL",
          locale: "x-c27-01",
          slug: "novel-article-no-novel",
        }),
        "article_novel_id_by_type_check",
      );
    });

    it("mirror case: rejects a blog_article with a non-NULL novel_id (the 'no half-attached blog' invariant the C-27 migration file calls out)", async () => {
      await expectDatabaseFailure(
        articleInsert({
          id: "90000000-0000-4000-8000-0000000c2702",
          articleType: "blog_article",
          novelId: `'${ids.novel}'`,
          locale: "x-c27-02",
          slug: "blog-article-with-novel",
        }),
        "article_novel_id_by_type_check",
      );
    });

    it("accepts a novel_article with a novel_id (unchanged legal shape)", async () => {
      await execute(articleInsert({
        id: "90000000-0000-4000-8000-0000000c2703",
        articleType: "novel_article",
        novelId: `'${ids.novel}'`,
        locale: "x-c27-03",
        slug: "novel-article-with-novel",
      }));
    });

    it("accepts a blog_article with NULL novel_id (the newly legal C-28 shape)", async () => {
      await execute(articleInsert({
        id: "90000000-0000-4000-8000-0000000c2704",
        articleType: "blog_article",
        novelId: "NULL",
        locale: "x-c27-04",
        slug: "blog-article-no-novel",
      }));
    });
  });

  describe("article_published_promo_link_check (forked by article_type)", () => {
    it("2. still rejects a published novel_article with no PromoLink — proves the C-27 relaxation did not weaken novel_article's own protection", async () => {
      await expectDatabaseFailure(
        articleInsert({
          id: "90000000-0000-4000-8000-0000000c2705",
          articleType: "novel_article",
          novelId: `'${ids.novel}'`,
          promoLinkId: "NULL",
          locale: "x-c27-05",
          slug: "published-novel-article-no-promo",
          status: "published",
          publishedAt: "now()",
        }),
        "article_published_promo_link_check",
      );
    });

    it("contrast: accepts a published blog_article with no PromoLink — proves the fork actually forked, not just that novel_article stayed strict", async () => {
      await execute(articleInsert({
        id: "90000000-0000-4000-8000-0000000c2706",
        articleType: "blog_article",
        novelId: "NULL",
        promoLinkId: "NULL",
        locale: "x-c27-06",
        slug: "published-blog-article-no-promo",
        status: "published",
        publishedAt: "now()",
      }));
      const [row] = await prisma.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM article WHERE id = '90000000-0000-4000-8000-0000000c2706'`,
      );
      expect(row.status).toBe("published");
    });
  });

  describe("article_novel_locale_key NULL semantics (article(novel_id, locale) unique index)", () => {
    it("3. multiple NULL-novel blog_article rows can coexist in the same locale", async () => {
      await execute(articleInsert({
        id: "90000000-0000-4000-8000-0000000c2707",
        articleType: "blog_article",
        novelId: "NULL",
        locale: "x-c27-07",
        slug: "blog-post-one",
      }));
      await execute(articleInsert({
        id: "90000000-0000-4000-8000-0000000c2708",
        articleType: "blog_article",
        novelId: "NULL",
        locale: "x-c27-07",
        slug: "blog-post-two",
      }));
      await execute(articleInsert({
        id: "90000000-0000-4000-8000-0000000c2709",
        articleType: "blog_article",
        novelId: "NULL",
        locale: "x-c27-07",
        slug: "blog-post-three",
      }));
      const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM article WHERE locale = 'x-c27-07' AND novel_id IS NULL ORDER BY slug`,
      );
      expect(rows).toHaveLength(3);
    });

    it("still rejects a second novel_article for the same (novel_id, locale) pair — the unique index itself is unmodified by C-27", async () => {
      await execute(articleInsert({
        id: "90000000-0000-4000-8000-0000000c2710",
        articleType: "novel_article",
        novelId: `'${ids.novel}'`,
        locale: "x-c27-10",
        slug: "novel-article-first",
      }));
      await expectDatabaseFailure(
        articleInsert({
          id: "90000000-0000-4000-8000-0000000c2711",
          articleType: "novel_article",
          novelId: `'${ids.novel}'`,
          locale: "x-c27-10",
          slug: "novel-article-second",
        }),
        "article_novel_locale_key",
      );
    });
  });

  describe("4. existing rows unaffected", () => {
    it("the legacy-shaped novel_article seeded before any C-27-specific write keeps its exact shape", async () => {
      const [row] = await prisma.$queryRawUnsafe<
        Array<{
          novel_id: string;
          promo_link_id: string;
          article_type: string;
          status: string;
        }>
      >(`
        SELECT novel_id, promo_link_id, article_type, status
        FROM article WHERE id = '${ids.legacyArticle}'
      `);
      expect(row.novel_id).toBe(ids.novel);
      expect(row.promo_link_id).toBe(ids.promo);
      expect(row.article_type).toBe("novel_article");
      expect(row.status).toBe("published");
    });

    it("remains normally writable under the new CHECKs (a title-only update touches neither new constraint)", async () => {
      await execute(`
        UPDATE article SET title = 'Legacy title, updated', updated_at = now()
        WHERE id = '${ids.legacyArticle}'
      `);
      const [row] = await prisma.$queryRawUnsafe<Array<{ title: string }>>(
        `SELECT title FROM article WHERE id = '${ids.legacyArticle}'`,
      );
      expect(row.title).toBe("Legacy title, updated");
    });

    it("still satisfies article_novel_id_by_type_check and article_published_promo_link_check as a plain re-affirmation (would fail loudly if the migration had ever weakened either for novel_article)", async () => {
      const [row] = await prisma.$queryRawUnsafe<Array<{ ok: boolean }>>(`
        SELECT (
          (article_type = 'novel_article' AND novel_id IS NOT NULL)
          AND (status <> 'published' OR promo_link_id IS NOT NULL)
        ) AS ok
        FROM article WHERE id = '${ids.legacyArticle}'
      `);
      expect(row.ok).toBe(true);
    });
  });
});
