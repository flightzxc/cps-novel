/**
 * C-28 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-28
 * "测试" section — "tests/integration/: **必需**. 真实库上跑一遍'建博客 →
 * 发布 → 查库',确认 novel_id IS NULL 且状态为 published 且新旧 CHECK 都没被
 * 触发"): real-PostgreSQL, real-service end-to-end run of the whole C-28
 * write path, unlike `c27-blog-article-postgres.test.ts` (raw SQL against
 * the CHECK constraints directly) — this file drives the actual
 * `createBlogArticle` (`src/server/content-creation/blog.ts`) and
 * `applyPublishTransition` (`src/server/publish-gate/service.ts`) service
 * functions against a real database connection, the same "exercise the real
 * function, not a hand-built SQL stand-in" discipline
 * `article-templates/p2-02b-article-render-postgres.test.ts` already uses
 * for its own smoke test. Neither service needs the full admin-auth ticket
 * stack (`createBlogArticle` takes a plain `CreateContentActor`,
 * `applyPublishTransition` a plain `PublishTransitionActor`), so this test
 * has no `TestOnlyInMemoryAuthStores`/`requireAdminActionAccess` machinery
 * to set up — a real advantage of this being a service-layer test, not an
 * HTTP-boundary one.
 *
 * Also confirms the C-27→C-29 boundary this task itself draws: a published
 * blog Article still resolves as `not_found` through
 * `checkNovelArticlePublicAccess` (`src/server/publication/access.ts`) —
 * "Public routes are C-29 — a created blog must remain invisible publicly".
 *
 * Gate: `C28_DATABASE_TEST=1` against a disposable PostgreSQL database whose
 * name contains `c28`, migrated up to at least
 * `20260910090000_c27_blog_article_foundation`. No seed foundation is
 * needed at all (unlike the C-27 CHECK test) — blog creation touches no
 * Novel/PromoLink/ChannelApp row by construction.
 *
 * I did not run this file — no PostgreSQL connection is available in this
 * worktree. Written against the same conventions as the other
 * `tests/integration/database/*-postgres.test.ts` files and reviewed
 * carefully against `createBlogArticle`/`applyPublishTransition`'s actual
 * signatures, but not executed; must be run by whoever next has a real
 * PostgreSQL 16 container available.
 */
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkNovelArticlePublicAccess } from "@/server/publication/access";
import { applyPublishTransition } from "@/server/publish-gate/service";
import { createBlogArticle } from "@/server/content-creation/blog";

const enabled = process.env.C28_DATABASE_TEST === "1";
const prisma = new PrismaClient();

const ENABLED_ENV = { FEATURE_ARTICLE_BLOG: "true", ARTICLE_BLOG_ALLOW_WRITE: "true" } as unknown as NodeJS.ProcessEnv;
const ADMIN_ACTOR = { type: "admin", adminId: "c28-integration-actor" } as const;

describe.skipIf(!enabled).sequential("C-28: real PostgreSQL — create blog → publish → query", () => {
  beforeAll(async () => {
    const [{ database_name: databaseName }] = await prisma.$queryRawUnsafe<
      Array<{ database_name: string }>
    >(`SELECT current_database() AS database_name`);
    if (!databaseName.includes("c28")) {
      throw new Error(`Refusing destructive test setup against ${databaseName}`);
    }
    const tables = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
    `);
    const names = tables.map(({ tablename }) => `"${tablename}"`).join(", ");
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
  }, 30_000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates a draft blog Article, publishes it through the real gate, and every column lands exactly as C-27/C-28 promise", async () => {
    const slug = `c28-e2e-${randomUUID().slice(0, 8)}`;
    const created = await createBlogArticle(
      prisma,
      {
        locale: "en",
        title: "Real PostgreSQL Blog Post",
        slug,
        body: "<p>Real content written against a real database.</p>",
        seoVisibility: "public",
        metaTitle: "Meta Title",
        metaDescription: "Meta Description",
        metaKeywords: "novels, reading",
        coverUrl: "https://example.com/cover.jpg",
        actor: ADMIN_ACTOR,
        requestId: `req-${randomUUID()}`,
      },
      ENABLED_ENV,
    );
    expect(created.outcome).toBe("created");
    if (created.outcome !== "created") throw new Error("unreachable");

    // Query the row back directly — proves the six fixed values and the
    // "draft, not spelled" discipline hold against a real Postgres insert,
    // not just the in-memory fake `blog.test.ts` already covers.
    const [draftRow] = await prisma.$queryRawUnsafe<
      Array<{
        novel_id: string | null;
        template_id: string | null;
        promo_link_id: string | null;
        article_type: string;
        content_mode: string;
        status: string;
        seo_metadata: unknown;
      }>
    >(`
      SELECT novel_id, template_id, promo_link_id, article_type, content_mode, status, seo_metadata
      FROM article WHERE id = $1
    `, created.articleId);
    expect(draftRow.novel_id).toBeNull();
    expect(draftRow.template_id).toBeNull();
    expect(draftRow.promo_link_id).toBeNull();
    expect(draftRow.article_type).toBe("blog_article");
    expect(draftRow.content_mode).toBe("manual");
    expect(draftRow.status).toBe("draft");
    expect(draftRow.seo_metadata).toEqual({
      metaTitle: "Meta Title",
      metaDescription: "Meta Description",
      metaKeywords: "novels, reading",
      coverUrl: "https://example.com/cover.jpg",
    });

    // Still invisible publicly while a draft (C-29 boundary, drafts are
    // always 404 anyway regardless of type).
    const draftAccess = await checkNovelArticlePublicAccess(prisma, { locale: "en", slug });
    expect(draftAccess).toEqual({ kind: "not_found" });

    // Publish through the real, unmodified gate — no CHECK bypass, no
    // second write口: this is the one function allowed to flip `status`.
    const published = await applyPublishTransition(prisma, {
      articleId: created.articleId,
      requestId: `req-publish-${randomUUID()}`,
      actor: ADMIN_ACTOR,
    });
    expect(published).toMatchObject({ outcome: "published", articleId: created.articleId, novelId: null });

    const [publishedRow] = await prisma.$queryRawUnsafe<
      Array<{ status: string; published_at: Date | null; novel_id: string | null }>
    >(`SELECT status, published_at, novel_id FROM article WHERE id = $1`, created.articleId);
    // Confirms both C-27 CHECKs stayed satisfied through the transition:
    // article_novel_id_by_type_check (novel_id still NULL for this
    // article_type) and article_published_promo_link_check (status is now
    // 'published' with no promo_link_id at all — would have failed the
    // CHECK outright had the fork not been in place, and this UPDATE would
    // never have committed).
    expect(publishedRow.status).toBe("published");
    expect(publishedRow.published_at).not.toBeNull();
    expect(publishedRow.novel_id).toBeNull();

    // C-27→C-29 boundary: still not_found even though published — public
    // routes are C-29's job, not built yet.
    const publishedAccess = await checkNovelArticlePublicAccess(prisma, { locale: "en", slug });
    expect(publishedAccess).toEqual({ kind: "not_found" });
  });

  it("slug_conflict end-to-end: a second blog Article for the same (locale, slug) is refused, zero new rows, no auto-suffix", async () => {
    const slug = `c28-conflict-${randomUUID().slice(0, 8)}`;
    const first = await createBlogArticle(
      prisma,
      {
        locale: "en",
        title: "First",
        slug,
        body: "<p>First</p>",
        seoVisibility: "public",
        actor: ADMIN_ACTOR,
        requestId: `req-${randomUUID()}`,
      },
      ENABLED_ENV,
    );
    expect(first.outcome).toBe("created");

    const second = await createBlogArticle(
      prisma,
      {
        locale: "en",
        title: "Second",
        slug,
        body: "<p>Second</p>",
        seoVisibility: "public",
        actor: ADMIN_ACTOR,
        requestId: `req-${randomUUID()}`,
      },
      ENABLED_ENV,
    );
    expect(second).toEqual({ outcome: "slug_conflict", locale: "en", slug });

    const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM article WHERE locale = $1 AND slug = $2 AND deleted_at IS NULL`,
      "en",
      slug,
    );
    expect(rows).toHaveLength(1);
  });

  it("multiple NULL-novel blog Articles coexist in the same locale (end-to-end, not just the raw-SQL CHECK test)", async () => {
    const locale = "fr";
    const results = await Promise.all(
      ["one", "two", "three"].map((suffix) =>
        createBlogArticle(
          prisma,
          {
            locale,
            title: `Post ${suffix}`,
            slug: `c28-coexist-${suffix}-${randomUUID().slice(0, 6)}`,
            body: `<p>${suffix}</p>`,
            seoVisibility: "public",
            actor: ADMIN_ACTOR,
            requestId: `req-${randomUUID()}`,
          },
          ENABLED_ENV,
        ),
      ),
    );
    for (const result of results) expect(result.outcome).toBe("created");
  });
});
