/**
 * Isolated-PG probes for Novel/Article decoupling (T04 / T16 / T26 / T27).
 *
 * Off by default. Enable only with:
 *   NOVEL_ARTICLE_DECOUPLE_DATABASE_TEST=1
 *   P1_06_OWNER_DATABASE_URL
 *   P1_06_WEB_DATABASE_URL
 *   P1_06_WORKER_DATABASE_URL
 *
 * This module never constructs PrismaClient or reads DATABASE_URL /
 * CATALOG_BATCH_* fallbacks at load time. Owner is fixture-only.
 * Database name must start with `cps_novel_article_decouple_`.
 * This round does not run against shared X8 / UAT / production volumes.
 */
import { randomUUID } from "node:crypto";

import { Prisma, PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";

import { generateArticleFromNovel } from "@/server/content-creation/generate";
import { materializeNovelFromSourceItem } from "@/server/content-creation/service";

import { assertRoleClientsShareIsolatedDatabase } from "../../backend/content-creation/novel-article-decouple-database-guard";

const enabled = process.env.NOVEL_ARTICLE_DECOUPLE_DATABASE_TEST === "1";

type RoleClients = {
  owner: PrismaClient;
  web: PrismaClient;
  worker: PrismaClient;
};

function requiredUrl(name: "P1_06_OWNER_DATABASE_URL" | "P1_06_WEB_DATABASE_URL" | "P1_06_WORKER_DATABASE_URL"): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; refusing owner/DATABASE_URL fallback`);
  return value;
}

async function currentDatabase(db: PrismaClient): Promise<{ name: string; version: string }> {
  const [database] = await db.$queryRaw<Array<{ name: string; version: string }>>`
    SELECT current_database() AS name, current_setting('server_version') AS version
  `;
  return database;
}

async function assertIsolatedDecoupleDatabase(db: PrismaClient): Promise<string> {
  const database = await currentDatabase(db);
  if (!database.version.startsWith("16.")) {
    throw new Error(`PostgreSQL 16 required, got ${database.version}`);
  }
  return database.name;
}

async function currentUser(db: PrismaClient): Promise<string> {
  const [{ current_user: user }] = await db.$queryRawUnsafe<Array<{ current_user: string }>>("SELECT current_user");
  return user;
}

function createClientsWhenEnabled(): RoleClients | null {
  if (!enabled) return null;
  return {
    owner: new PrismaClient({ datasourceUrl: requiredUrl("P1_06_OWNER_DATABASE_URL") }),
    web: new PrismaClient({ datasourceUrl: requiredUrl("P1_06_WEB_DATABASE_URL") }),
    worker: new PrismaClient({ datasourceUrl: requiredUrl("P1_06_WORKER_DATABASE_URL") }),
  };
}

const clients = createClientsWhenEnabled();
const owner = clients?.owner;
const web = clients?.web;
const worker = clients?.worker;
const ACTOR = { type: "admin" as const, adminId: "decouple-pg-admin" };

describe.skipIf(!enabled)("Novel/Article decoupling isolated PG", () => {
  beforeAll(async () => {
    if (!owner || !web || !worker) throw new Error("role clients were not created");
    const [ownerDatabase, webDatabase, workerDatabase] = await Promise.all([
      assertIsolatedDecoupleDatabase(owner),
      assertIsolatedDecoupleDatabase(web),
      assertIsolatedDecoupleDatabase(worker),
    ]);
    assertRoleClientsShareIsolatedDatabase({ ownerDatabase, webDatabase, workerDatabase });
    const [webUser, workerUser, ownerUser] = await Promise.all([
      currentUser(web),
      currentUser(worker),
      currentUser(owner),
    ]);
    expect(webUser).toBe("web_app");
    expect(workerUser).toBe("worker_app");
    expect(webUser).not.toBe(ownerUser);
    expect(workerUser).not.toBe(ownerUser);
    expect(webUser).not.toBe("migration_owner");
    expect(workerUser).not.toBe("migration_owner");
  }, 30_000);

  it("T04 concurrent materialize yields one Novel and zero Articles", async () => {
    if (!owner || !worker) throw new Error("missing clients");
    const sourceId = await seedPendingSource(owner);
    const [first, second] = await Promise.all([
      materializeNovelFromSourceItem(worker, { novelSourceItemId: sourceId, mode: "apply", actor: ACTOR, requestId: `t04-a-${sourceId}` }),
      materializeNovelFromSourceItem(worker, { novelSourceItemId: sourceId, mode: "apply", actor: ACTOR, requestId: `t04-b-${sourceId}` }),
    ]);
    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toContain("created");
    expect(outcomes.every((outcome) => outcome === "created" || outcome === "already_exists" || outcome === "concurrent_creation_conflict")).toBe(true);
    const linked = await owner.novelSourceItem.findUniqueOrThrow({ where: { id: sourceId } });
    expect(linked.novelId).toBeTruthy();
    expect(await owner.article.count({ where: { novelId: linked.novelId! } })).toBe(0);
  });

  it("T16 concurrent generate yields one Article and does not overwrite", async () => {
    if (!owner || !worker) throw new Error("missing clients");
    const { novelId, promoId } = await seedNovelWithReadyPromo(owner);
    await seedTemplate(owner, "en");
    const [first, second] = await Promise.all([
      generateArticleFromNovel(worker, { novelId, mode: "apply", actor: ACTOR, requestId: `t16-a-${novelId}` }),
      generateArticleFromNovel(worker, { novelId, mode: "apply", actor: ACTOR, requestId: `t16-b-${novelId}` }),
    ]);
    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toContain("created");
    expect(outcomes.every((outcome) => outcome === "created" || outcome === "already_exists" || outcome === "concurrent_generation_conflict")).toBe(true);
    const articles = await owner.article.findMany({ where: { novelId, deletedAt: null } });
    expect(articles).toHaveLength(1);
    expect(articles[0]?.promoLinkId).toBe(promoId);
  });

  it("T26 worker_app and web_app can INSERT article with implicit RETURNING", async () => {
    if (!owner || !web || !worker) throw new Error("missing clients");
    const workerSeed = await seedNovelWithReadyPromo(owner, "t26w");
    const webSeed = await seedNovelWithReadyPromo(owner, "t26b");
    await seedTemplate(owner, "en");
    const workerResult = await generateArticleFromNovel(worker, {
      novelId: workerSeed.novelId, mode: "apply", actor: ACTOR, requestId: `t26-worker-${workerSeed.novelId}`,
    });
    const webResult = await generateArticleFromNovel(web, {
      novelId: webSeed.novelId, mode: "apply", actor: ACTOR, requestId: `t26-web-${webSeed.novelId}`,
    });
    expect(workerResult.outcome).toBe("created");
    expect(webResult.outcome).toBe("created");
    if (workerResult.outcome !== "created" || webResult.outcome !== "created") throw new Error("unreachable");
    expect(await owner.article.findUniqueOrThrow({ where: { id: workerResult.articleId } })).toMatchObject({
      promoLinkId: workerSeed.promoId,
      contentMode: "template",
    });
    expect(await owner.article.findUniqueOrThrow({ where: { id: webResult.articleId } })).toMatchObject({
      promoLinkId: webSeed.promoId,
    });
  });

  it("T27 source → 1 Novel 0 Article → fixture promo still 0 Article → generate 1 bound draft", async () => {
    if (!owner || !worker) throw new Error("missing clients");
    const sourceId = await seedPendingSource(owner, "t27");
    const materialized = await materializeNovelFromSourceItem(worker, {
      novelSourceItemId: sourceId, mode: "apply", actor: ACTOR, requestId: `t27-mat-${sourceId}`,
    });
    expect(materialized.outcome).toBe("created");
    if (materialized.outcome !== "created") throw new Error("unreachable");
    expect(await owner.article.count({ where: { novelId: materialized.novelId } })).toBe(0);

    const promoId = await seedFetchedPromo(owner, materialized.novelId, "t27");
    expect(await owner.article.count({ where: { novelId: materialized.novelId } })).toBe(0);

    await seedTemplate(owner, materialized.locale);
    const generated = await generateArticleFromNovel(worker, {
      novelId: materialized.novelId, mode: "apply", actor: ACTOR, requestId: `t27-gen-${sourceId}`,
    });
    expect(generated.outcome).toBe("created");
    if (generated.outcome !== "created") throw new Error("unreachable");
    const article = await owner.article.findUniqueOrThrow({ where: { id: generated.articleId } });
    expect(article).toMatchObject({
      novelId: materialized.novelId,
      promoLinkId: promoId,
      status: "draft",
      articleType: "novel_article",
      contentMode: "template",
    });
    expect(article.body).toContain(`/go/`);
  });
});

async function seedPendingSource(db: PrismaClient, prefix = "t04"): Promise<string> {
  const channelAppId = await ensureChannelApp(db, prefix);
  const created = await db.novelSourceItem.create({
    data: {
      channelAppId,
      externalBookId: `${prefix}-${randomUUID()}`,
      sourceLanguageCode: "en",
      sourceLocale: "en",
      title: `${prefix} Decouple Source`,
      description: "Isolated PG description.",
      status: "pending",
      rawPayload: {} as Prisma.InputJsonObject,
    },
    select: { id: true },
  });
  return created.id;
}

async function seedNovelWithReadyPromo(db: PrismaClient, prefix = "t16"): Promise<{ novelId: string; promoId: string }> {
  const novel = await db.novel.create({
    data: {
      businessId: `${prefix}-${randomUUID().slice(0, 12)}`,
      title: `${prefix} Ready Novel`,
      description: "Isolated PG description.",
      locale: "en",
      slug: `${prefix}-${randomUUID()}`,
    },
    select: { id: true },
  });
  const promoId = await seedFetchedPromo(db, novel.id, prefix);
  return { novelId: novel.id, promoId };
}

async function seedFetchedPromo(db: PrismaClient, novelId: string, prefix: string): Promise<string> {
  const channelAppId = await ensureChannelApp(db, prefix);
  const source = await db.novelSourceItem.create({
    data: {
      channelAppId,
      novelId,
      externalBookId: `${prefix}-linked-${randomUUID()}`,
      sourceLanguageCode: "en",
      sourceLocale: "en",
      title: `${prefix} Linked Source`,
      description: "Linked source.",
      status: "linked",
      rawPayload: {} as Prisma.InputJsonObject,
    },
    select: { id: true },
  });
  const account = await db.channelAccount.findFirstOrThrow({
    where: { channel: { channelApps: { some: { id: channelAppId } } } },
    select: { id: true },
  });
  const promo = await db.promoLink.create({
    data: {
      novelId,
      novelSourceItemId: source.id,
      channelAppId,
      channelAccountId: account.id,
      offerType: "cps",
      publicRedirectCode: `${prefix}${randomUUID().replaceAll("-", "").slice(0, 10)}`,
      idempotencyKey: randomUUID().replaceAll("-", "").padEnd(64, "0").slice(0, 64),
      origin: "claim",
      status: "fetched",
      webUrl: "https://example.com/read",
      fetchedAt: new Date(),
    },
    select: { id: true },
  });
  return promo.id;
}

async function seedTemplate(db: PrismaClient, locale: string): Promise<void> {
  const existing = await db.articleTemplate.findFirst({
    where: { locale, status: "active", deletedAt: null },
    select: { id: true },
  });
  if (existing) return;
  await db.articleTemplate.create({
    data: {
      templateKey: `decouple-default-${locale}`,
      templateName: `Decouple default ${locale}`,
      locale,
      version: 1,
      status: "active",
      applicableArticleType: "novel_article",
      bodyTemplate: "<h1>{novel_title}</h1><p>{novel_description}</p>{if promo_redirect_url}<a href=\"{promo_redirect_url}\">Start</a>{endif}",
      seoTemplate: { title: "{novel_title}", metaDescription: "{novel_description}" },
    },
  });
}

async function ensureChannelApp(db: PrismaClient, prefix: string): Promise<string> {
  const existing = await db.channelApp.findFirst({ select: { id: true } });
  if (existing) return existing.id;
  const channel = await db.channel.create({ data: { code: `${prefix}-${randomUUID()}`, name: `${prefix} channel` } });
  const sourceApp = await db.sourceApp.create({ data: { code: `${prefix}-src-${randomUUID()}`, name: `${prefix} source` } });
  const channelApp = await db.channelApp.create({
    data: { channelId: channel.id, sourceAppId: sourceApp.id, externalAppId: `${prefix}-app`, projectType: 1 },
  });
  await db.channelAccount.create({
    data: { channelId: channel.id, businessId: `${prefix}-acct-${randomUUID()}`, accountName: `${prefix} account` },
  });
  return channelApp.id;
}
