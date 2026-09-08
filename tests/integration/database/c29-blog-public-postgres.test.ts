/**
 * C-29 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-29
 * "测试" section — "tests/integration/: **必需**. 真实库上跑一遍'建博客 →
 * 发布 → 详情页可达 → 出现在 sitemap 博客家族 → 不出现在 /blog 列表（若标为
 * seo_only）'"): real-PostgreSQL, real-service end-to-end run of the C-29
 * public read path, built on the same `createBlogArticle`/
 * `applyPublishTransition` real-function drive `c28-blog-article-postgres.test.ts`
 * already establishes for the write side — this file picks up exactly where
 * that one's "still not_found — public routes are C-29's job" assertion
 * leaves off, and proves the other side of that boundary.
 *
 * Gate: `C29_DATABASE_TEST=1` against a disposable PostgreSQL database whose
 * name contains `c29`, migrated up to at least
 * `20260910090000_c27_blog_article_foundation`. No seed foundation needed —
 * same reasoning as the C-28 file (blog creation touches no Novel/
 * PromoLink/ChannelApp row by construction).
 *
 * I did not run this file — no PostgreSQL connection is available in this
 * worktree (same constraint `c28-blog-article-postgres.test.ts` and
 * `c27-blog-article-postgres.test.ts` both record). Written against the
 * same conventions as those files and reviewed carefully against
 * `createBlogArticle`/`applyPublishTransition`/`checkBlogArticlePublicAccess`/
 * `listPublicBlogArticles`/`createSitemapFamilyBuilder`'s actual signatures,
 * but not executed; must be run by whoever next has a real PostgreSQL 16
 * container available.
 */
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBlogArticle } from "@/server/content-creation/blog";
import { applyPublishTransition } from "@/server/publish-gate/service";
import { checkBlogArticlePublicAccess } from "@/server/publication/access";
import { listPublicBlogArticles } from "@/lib/site/blog-queries";
import { createSitemapFamilyBuilder } from "@/lib/seo/sitemap";

const enabled = process.env.C29_DATABASE_TEST === "1";
const prisma = new PrismaClient();

const ADMIN_ACTOR = { type: "admin", adminId: "c29-integration-actor" } as const;

/** Write-side gate (creating the fixtures) — same double-gate `c28-blog-article-postgres.test.ts` uses. */
const WRITE_ENABLED_ENV = { FEATURE_ARTICLE_BLOG: "true", ARTICLE_BLOG_ALLOW_WRITE: "true" } as unknown as NodeJS.ProcessEnv;
/** Read-side gate under test — both C-29's own flag AND C-25's seoVisibility flag on, so all three seoVisibility values take real effect. */
const READ_ENABLED_ENV = {
  FEATURE_ARTICLE_BLOG: "true",
  FEATURE_ARTICLE_SEO_VISIBILITY: "true",
} as unknown as NodeJS.ProcessEnv;

async function createAndPublish(seoVisibility: "public" | "seo_only" | "hidden") {
  const slug = `c29-${seoVisibility}-${randomUUID().slice(0, 8)}`;
  const created = await createBlogArticle(
    prisma,
    {
      locale: "en",
      title: `Post (${seoVisibility})`,
      slug,
      body: `<p>Body for ${seoVisibility}.</p>`,
      summary: `Summary for ${seoVisibility}.`,
      seoVisibility,
      actor: ADMIN_ACTOR,
      requestId: `req-${randomUUID()}`,
    },
    WRITE_ENABLED_ENV,
  );
  if (created.outcome !== "created") throw new Error(`unreachable: ${created.outcome}`);
  const published = await applyPublishTransition(prisma, {
    articleId: created.articleId,
    requestId: `req-publish-${randomUUID()}`,
    actor: ADMIN_ACTOR,
  });
  if (published.outcome !== "published") throw new Error(`unreachable: ${published.outcome}`);
  return { slug, articleId: created.articleId };
}

describe.skipIf(!enabled).sequential("C-29: real PostgreSQL — create blog → publish → public read paths", () => {
  beforeAll(async () => {
    const [{ database_name: databaseName }] = await prisma.$queryRawUnsafe<
      Array<{ database_name: string }>
    >(`SELECT current_database() AS database_name`);
    if (!databaseName.includes("c29")) {
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

  it("a published, public blog Article is detail-reachable, listed, and in the sitemap blogpage family", async () => {
    const { slug } = await createAndPublish("public");

    const access = await checkBlogArticlePublicAccess(prisma, { locale: "en", slug }, READ_ENABLED_ENV);
    expect(access.kind).toBe("published");

    const list = await listPublicBlogArticles(prisma, "en", READ_ENABLED_ENV);
    expect(list.some((post) => post.slug === slug)).toBe(true);

    process.env.SITE_URL ??= "https://c29-integration.example";
    const files = await createSitemapFamilyBuilder(prisma, READ_ENABLED_ENV)({ type: "blogpage", locale: "en" });
    const locs = files.flatMap((file) => file.entries.map((entry) => entry.loc));
    expect(locs.some((loc) => loc.endsWith(`/blog/${slug}`))).toBe(true);
  });

  it("a published, seo_only blog Article is detail-reachable and in the sitemap, but NOT in the /blog list — the承重 C-25 distinction", async () => {
    const { slug } = await createAndPublish("seo_only");

    const access = await checkBlogArticlePublicAccess(prisma, { locale: "en", slug }, READ_ENABLED_ENV);
    expect(access.kind).toBe("published");

    const list = await listPublicBlogArticles(prisma, "en", READ_ENABLED_ENV);
    expect(list.some((post) => post.slug === slug)).toBe(false);

    process.env.SITE_URL ??= "https://c29-integration.example";
    const files = await createSitemapFamilyBuilder(prisma, READ_ENABLED_ENV)({ type: "blogpage", locale: "en" });
    const locs = files.flatMap((file) => file.entries.map((entry) => entry.loc));
    expect(locs.some((loc) => loc.endsWith(`/blog/${slug}`))).toBe(true);
  });

  it("a published, hidden blog Article is unreachable everywhere — 404, absent from the list, absent from the sitemap", async () => {
    const { slug } = await createAndPublish("hidden");

    const access = await checkBlogArticlePublicAccess(prisma, { locale: "en", slug }, READ_ENABLED_ENV);
    expect(access).toEqual({ kind: "not_found" });

    const list = await listPublicBlogArticles(prisma, "en", READ_ENABLED_ENV);
    expect(list.some((post) => post.slug === slug)).toBe(false);

    process.env.SITE_URL ??= "https://c29-integration.example";
    const files = await createSitemapFamilyBuilder(prisma, READ_ENABLED_ENV)({ type: "blogpage", locale: "en" });
    const locs = files.flatMap((file) => file.entries.map((entry) => entry.loc));
    expect(locs.some((loc) => loc.endsWith(`/blog/${slug}`))).toBe(false);
  });

  it("C-29 开关: with FEATURE_ARTICLE_BLOG off, the same published public Article 404s and the sitemap family is empty", async () => {
    const { slug } = await createAndPublish("public");
    const flagOffEnv = {} as NodeJS.ProcessEnv;

    const access = await checkBlogArticlePublicAccess(prisma, { locale: "en", slug }, flagOffEnv);
    expect(access).toEqual({ kind: "not_found" });

    process.env.SITE_URL ??= "https://c29-integration.example";
    const files = await createSitemapFamilyBuilder(prisma, flagOffEnv)({ type: "blogpage", locale: "en" });
    expect(files).toEqual([]);
  });
});
