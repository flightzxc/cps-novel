/**
 * P2-02B 真实 PostgreSQL 冒烟：模板 → 生成文章 → 公开正文/SEO。
 *
 * 走的是真实链路：`regenerateArticle`（挑模板 + 引擎渲染 + 落库）→
 * `resolvePublicArticleBySlugParam` + `getPublicNovelDetail`（公开侧读取）。
 *
 * 🔴 **两本小说是有意的**：一本有封面、一本没有。`cover_url` 在 `fields.ts` 是
 * `required: false`，而区块编译器给 image 区块产出的是 `{if cover_url}…{endif}`。
 * 如果哪天有人把那层条件包裹去掉，带图片区块的模板会照常保存、照常通过单测，
 * 却对**每一本没有封面的小说**在生成期抛 ERR_TEMPLATE_VAR_EMPTY——无封面这条
 * 用例就是钉住这个的。
 *
 * 门禁：`P2_02B_DATABASE_TEST=1`（与同目录 lifecycle 冒烟同一开关）。
 */
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashAdminSessionToken } from "@/lib/auth/session";
import type { AdminIdentity, AdminSessionRecord } from "@/lib/auth/types";
import { requireAdminActionAccess } from "@/server/auth/guards";
import { P2_04_ADMIN_REGISTRY } from "@/app/api/admin/_lib/registry";
import { createArticleTemplate } from "@/server/article-templates";
import { regenerateArticle } from "@/server/articles";
import { getPublicNovelDetail, resolvePublicArticleBySlugParam } from "@/lib/site/queries";
import { TestOnlyInMemoryAuthStores } from "../../backend/auth/test-only-in-memory-stores";

const enabled = process.env.P2_02B_DATABASE_TEST === "1";
const webUrl = process.env.P2_02B_WEB_DATABASE_URL ?? process.env.DATABASE_URL;
const ownerUrl = process.env.P2_02B_OWNER_DATABASE_URL ?? webUrl;

const NOW = new Date("2026-09-06T00:00:00.000Z");
const TOKEN = "smoke-session-token";
const ORIGIN = "https://admin.example.test";

const web = new PrismaClient({ datasourceUrl: webUrl });
const owner = new PrismaClient({ datasourceUrl: ownerUrl });

function authFixture() {
  const stores = new TestOnlyInMemoryAuthStores();
  const identity: AdminIdentity = {
    id: "admin-1", username: "admin", role: "super_admin",
    status: "active", sessionVersion: 1, twoFactorEnabled: true,
  };
  const session: AdminSessionRecord = {
    id: "session-1", tokenHash: hashAdminSessionToken(TOKEN), identityId: identity.id,
    sessionVersion: 1,
    issuedAt: new Date(NOW.getTime() - 3_600_000),
    lastSeenAt: new Date(NOW.getTime() - 60_000),
    absoluteExpiresAt: new Date(NOW.getTime() + 23 * 3_600_000),
    twoFactorCompletedAt: new Date(NOW.getTime() - 30_000),
    revokedAt: null,
  };
  stores.identities.set(identity.id, identity);
  stores.sessions.set(session.id, session);
  return stores;
}

async function authorize(stores: TestOnlyInMemoryAuthStores, actionId: string) {
  const requestId = randomUUID();
  const guarded = await requireAdminActionAccess(
    { actionId, sessionToken: TOKEN, origin: ORIGIN, canonicalOrigin: ORIGIN, requestId },
    { identities: stores, sessions: stores, registry: P2_04_ADMIN_REGISTRY, now: NOW, env: {} as NodeJS.ProcessEnv },
  );
  return { authorization: guarded.serviceAuthorization!, requestId };
}

const tag = String(Date.now());
const ids = {
  channel: randomUUID(), sourceApp: randomUUID(), channelApp: randomUUID(),
  channelAccount: randomUUID(),
  withCover: { novel: randomUUID(), item: randomUUID(), promo: randomUUID(), article: randomUUID() },
  noCover: { novel: randomUUID(), item: randomUUID(), promo: randomUUID(), article: randomUUID() },
};

/** 恰好 10 位小写字母数字，符合 `PUBLIC_REDIRECT_CODE_FORMAT`。 */
function redirectCode(kind: "withCover" | "noCover"): string {
  // 前缀必须留在最前面：两种 kind 靠它区分，`public_redirect_code` 有唯一约束。
  const prefix = kind === "withCover" ? "wc" : "nc";
  return `${prefix}${tag.slice(-8).padStart(8, "0")}`;
}

async function seedNovel(kind: "withCover" | "noCover", coverUrl: string | null) {
  const k = ids[kind];
  const slug = `${kind.toLowerCase()}-${tag}`;
  const shortId = `${kind === "withCover" ? "aa" : "bb"}${tag.slice(-6)}`;
  await owner.$executeRawUnsafe(`
    INSERT INTO novel (id, business_id, title, description, locale, slug, cover_url, total_chapter_count, status, created_at, updated_at)
    VALUES ($1::uuid,$2,$3,$4,'en',$5,$6,12,'published',NOW(),NOW())`,
    k.novel, `biz-${kind}-${tag}`, `Novel ${kind}`, `Description for ${kind}.`, slug, coverUrl);
  await owner.$executeRawUnsafe(`
    INSERT INTO novel_source_item (id, channel_app_id, external_book_id, source_language_code, title, description, raw_payload, novel_id, status, created_at, updated_at)
    VALUES ($1::uuid,$2::uuid,$3,'3',$4,'d','{}'::jsonb,$5::uuid,'linked',NOW(),NOW())`,
    k.item, ids.channelApp, `ext-${kind}-${tag}`, `Novel ${kind}`, k.novel);
  await owner.$executeRawUnsafe(`
    INSERT INTO promo_link (id, novel_id, novel_source_item_id, channel_app_id, channel_account_id, offer_type, public_redirect_code, idempotency_key, status, web_url, created_at, updated_at)
    VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,'default',$6,$7,'fetched',$8,NOW(),NOW())`,
    k.promo, k.novel, k.item, ids.channelApp, ids.channelAccount,
    // 🔴 公开跳转码必须是恰好 10 位小写字母数字（`PUBLIC_REDIRECT_CODE_FORMAT`），
    // 否则 `buildReadOnUpstreamHref` 会静默返回 undefined，正式阅读 CTA 不渲染。
    redirectCode(kind), `${kind}-${tag}`.padEnd(36, "0").slice(0, 36),
    `https://upstream.example.test/${kind}`);
  await owner.$executeRawUnsafe(`
    INSERT INTO article (id, novel_id, locale, slug, public_page_short_id, title, body, status, template_id, promo_link_id, published_at, seo_schema_version, created_at, updated_at)
    VALUES ($1::uuid,$2::uuid,'en',$3,$4,'placeholder title','placeholder body','published',NULL,$5::uuid,NOW(),1,NOW(),NOW())`,
    k.article, k.novel, slug, shortId, k.promo);
  return { slug, shortId, param: `${slug}-p${shortId}` };
}

describe.skipIf(!enabled).sequential("P2-02B 模板→生成文章→公开正文/SEO（真实 PostgreSQL）", () => {
  const stores = authFixture();
  let withCover: Awaited<ReturnType<typeof seedNovel>>;
  let noCover: Awaited<ReturnType<typeof seedNovel>>;

  beforeAll(async () => {
    await owner.$connect();
    await web.$connect();
    await owner.$executeRawUnsafe(
      `INSERT INTO channel (id, code, name, created_at, updated_at) VALUES ($1::uuid,$2,'Smoke Channel',NOW(),NOW())`,
      ids.channel, `smoke${tag}`);
    await owner.$executeRawUnsafe(
      `INSERT INTO source_app (id, code, name, created_at, updated_at) VALUES ($1::uuid,$2,'Smoke App',NOW(),NOW())`,
      ids.sourceApp, `app${tag}`);
    await owner.$executeRawUnsafe(
      `INSERT INTO channel_app (id, channel_id, source_app_id, external_app_id, project_type, created_at, updated_at)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,2,NOW(),NOW())`,
      ids.channelApp, ids.channel, ids.sourceApp, `extapp${tag}`);
    await owner.$executeRawUnsafe(
      `INSERT INTO channel_account (id, channel_id, business_id, account_name, created_at, updated_at)
       VALUES ($1::uuid,$2::uuid,$3,'Smoke Account',NOW(),NOW())`,
      ids.channelAccount, ids.channel, `acct${tag}`);

    // 一个走完整区块表（含 image / cta）的活跃模板。
    const g = await authorize(stores, "admin.article_template.create");
    await createArticleTemplate({
      authorization: g.authorization, requestId: g.requestId,
      template: {
        templateKey: `render-${tag}`, templateName: "渲染冒烟模板", locale: "en", status: "active",
        applicableArticleType: "novel_article",
        titleTemplate: "{novel_title} — Read Online",
        contentTemplate: [
          { type: "heading", content: "{novel_title}" },
          { type: "image", content: "" },
          { type: "paragraph", content: "{novel_description}" },
          { type: "paragraph", content: "{if total_chapter_count}Total chapters: {total_chapter_count}{endif}" },
          { type: "cta", content: "Start Reading" },
          { type: "divider", content: "" },
        ],
        metaTitleTemplate: "{novel_title} | Smoke",
        metaDescriptionTemplate: "{novel_description}",
      },
    }, { db: web, identities: stores, sessions: stores, now: NOW });

    withCover = await seedNovel("withCover", "https://cdn.example.test/cover.jpg");
    noCover = await seedNovel("noCover", null);
  });

  afterAll(async () => { await web.$disconnect(); await owner.$disconnect(); });

  async function regenerate(articleId: string) {
    const article = await web.article.findUniqueOrThrow({ where: { id: articleId }, select: { updatedAt: true } });
    const g = await authorize(stores, "admin.article.regenerate");
    return regenerateArticle(
      { authorization: g.authorization, requestId: g.requestId, articleId, expectedUpdatedAt: article.updatedAt.toISOString() },
      { db: web, identities: stores, sessions: stores, now: NOW },
    );
  }

  it("有封面的小说：用模板生成文章成功，正文含封面图与 CTA", async () => {
    const result = await regenerate(ids.withCover.article);
    expect(result.outcome).toBe("regenerated");
    const row = await web.article.findUniqueOrThrow({ where: { id: ids.withCover.article } });
    expect(row.title).toBe("Novel withCover — Read Online");
    expect(row.body).toContain('<img src="https://cdn.example.test/cover.jpg"');
    expect(row.body).toContain("<h2>Novel withCover</h2>");
    expect(row.body).toContain("Total chapters: 12");
    expect(row.body).toContain(`href="/go/${redirectCode("withCover")}"`);
    expect(row.body).toContain("<hr />");
  });

  it("🔴 无封面的小说：同一模板照样生成成功，正文里没有 <img>，其余区块完整", async () => {
    const result = await regenerate(ids.noCover.article);
    expect(result.outcome).toBe("regenerated");
    const row = await web.article.findUniqueOrThrow({ where: { id: ids.noCover.article } });
    expect(row.body).not.toContain("<img");
    expect(row.body).toContain("<h2>Novel noCover</h2>");
    expect(row.body).toContain("Description for noCover.");
    expect(row.body).toContain("Start Reading");
    expect(row.body).not.toContain("<p></p>");
  });

  it("公开侧：两篇文章都可解析、正文与 SEO 元数据都读得到", async () => {
    for (const [label, seed, ids_] of [
      ["withCover", withCover, ids.withCover],
      ["noCover", noCover, ids.noCover],
    ] as const) {
      const access = await resolvePublicArticleBySlugParam(web, seed.param, "en");
      expect(access.kind, `${label} access`).toBe("published");
      if (access.kind !== "published") throw new Error("unreachable");

      const detail = await getPublicNovelDetail(web, access.articleId);
      expect(detail, `${label} detail`).not.toBeNull();
      expect(detail!.seoTitle).toBe(`Novel ${label} | Smoke`);
      expect(detail!.seoDescription).toBe(`Description for ${label}.`);
      // 公开视图里模板产出的正文叫 contentBody（`NovelDetailView`）。
      expect(detail!.contentBody, `${label} contentBody`).toBeTypeOf("string");
      expect(detail!.contentBody!).toContain(`<h2>Novel ${label}</h2>`);
      expect(detail!.contentBody!).toContain(`Description for ${label}.`);
      if (label === "noCover") expect(detail!.contentBody!).not.toContain("<img");
      else expect(detail!.contentBody!).toContain('<img src="https://cdn.example.test/cover.jpg"');
      // CTA 的落点：公开跳转地址由公开跳转码构造，模板不构造 URL。
      expect(detail!.readOnUpstreamHref, `${label} readOnUpstreamHref`).toBe(`/go/${redirectCode(label)}`);
      void ids_;
    }
  });
});
