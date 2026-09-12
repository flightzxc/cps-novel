import type { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSitemapFamilyBuilder } from "@/lib/seo/sitemap";
import { resolvePublicArticleBySlugParam } from "@/lib/site/queries";
import { applyPublishTransition } from "@/server/publish-gate/service";
import { invalidateSiteSettingCache } from "@/server/site-settings/service";

import { FakePublishGateDb } from "../backend/publish-gate/fake-db";

// L10N P4: the `@/lib/locale/locale-canonical` mock that used to live here
// (overriding `isPublishableLocale`/`listPublishableLocales` to a fixed
// `{en}` set) is dead — both symbols are deleted, and every consumer this
// test exercises (`createSitemapFamilyBuilder`, `resolvePublicArticleBySlugParam`,
// `applyPublishTransition`) now reads `SITE_LOCALES` (the real, static,
// always-15-entry registry) instead, which already includes "en" — no mock
// needed to make this test's `en`-locale fixtures resolve correctly.

const ARTICLE_ID = "article-p2-12";
const NOVEL_ID = "novel-p2-12";
const SHORT_ID = "accept12";
const SLUG = "vertical-acceptance";
const UPDATED_AT = new Date("2026-08-18T12:00:00.000Z");
const SITE_URL = "https://acceptance.example";

const GATED_ENV = {
  SITE_URL,
  FEATURE_INDEXNOW_OUTBOX: "true",
  INDEXNOW_OUTBOX_ALLOW_WRITE: "true",
  FEATURE_SITEMAP_AUTO_REFRESH: "true",
  SITEMAP_AUTO_REFRESH_ALLOW_WRITE: "true",
} as const;

type MutableClient = PrismaClient & {
  $queryRaw: (...args: unknown[]) => Promise<unknown>;
};

type OutboxRow = {
  id: string;
  articleId: string;
  url: string;
  revision: bigint;
  deliveryTaskId?: string;
};

type TaskRow = {
  id: string;
  taskType: string;
  status: string;
  operationScopeHash: string;
};

function seedReady(db: FakePublishGateDb, promoUrl = "https://promo.example/acceptance") {
  db.seedNovel({ id: NOVEL_ID, status: "ready", locale: "en", deletedAt: null });
  db.seedArticle({
    id: ARTICLE_ID,
    novelId: NOVEL_ID,
    locale: "en",
    slug: SLUG,
    publicPageShortId: SHORT_ID,
    status: "draft",
    title: "Vertical Acceptance",
    body: "Acceptance body",
    publishedAt: null,
    publishAt: null,
    deletedAt: null,
    promoLink: { id: "promo-p2-12", status: "fetched", webUrl: promoUrl, appUrl: null },
  });
  db.seedChapter({
    id: "chapter-p2-12",
    novelId: NOVEL_ID,
    status: "preview",
    deletedAt: null,
    body: "Preview body",
  });
}

/**
 * Extends the existing publish-gate fake only at the cross-stream seams the
 * real dispatcher reaches. Production code remains unmocked: publish gate,
 * public access, sitemap filtering, IndexNow eligibility/outbox, and sitemap
 * enqueue all execute their real implementations against this one store.
 */
function acceptanceClient(db: FakePublishGateDb) {
  const client = db.asPrismaClient() as MutableClient;
  const articleDelegate = client.article as unknown as {
    findFirst: (args: { where: Record<string, unknown>; select?: Record<string, unknown> }) => Promise<unknown>;
    findMany: (args: { where: Record<string, unknown>; select?: Record<string, unknown> }) => Promise<unknown>;
  };
  const originalFindFirst = articleDelegate.findFirst.bind(articleDelegate);
  const originalFindMany = articleDelegate.findMany.bind(articleDelegate);
  const outboxRows: OutboxRow[] = [];
  const taskRows: TaskRow[] = [];

  const articleSnapshot = () => {
    const article = db.articles.get(ARTICLE_ID)!;
    const novel = db.novels.get(NOVEL_ID)!;
    return {
      id: article.id,
      novelId: article.novelId,
      locale: article.locale,
      slug: article.slug,
      publicPageShortId: article.publicPageShortId!,
      title: article.title,
      status: article.status,
      deletedAt: article.deletedAt,
      publishedAt: article.publishedAt,
      updatedAt: UPDATED_AT,
      novel: {
        id: novel.id,
        businessId: "biz-p2-12",
        title: article.title,
        description: "Acceptance fixture",
        coverUrl: "/covers/acceptance.webp",
        locale: novel.locale,
        totalChapterCount: 1,
        status: novel.status,
        deletedAt: novel.deletedAt,
      },
      promoLink: article.promoLink
        ? { ...article.promoLink, deletedAt: null }
        : null,
    };
  };

  articleDelegate.findFirst = async (args) => {
    const where = args.where ?? {};
    const and = Array.isArray(where.AND) ? where.AND as Array<Record<string, unknown>> : [];
    const routeWhere = and.find((entry) => typeof entry.locale === "string" && typeof entry.slug === "string");
    if (routeWhere) {
      const snapshot = articleSnapshot();
      return snapshot.locale === routeWhere.locale && snapshot.slug === routeWhere.slug
        ? snapshot
        : null;
    }

    const result = await originalFindFirst(args) as Record<string, unknown> | null;
    if (result && where.id === ARTICLE_ID) {
      return { ...result, updatedAt: UPDATED_AT };
    }
    return result;
  };

  articleDelegate.findMany = async (args) => {
    if (args.select?.updatedAt === true) return [articleSnapshot()];
    return originalFindMany(args);
  };

  Object.assign(client, {
    $queryRaw: async () => [{ pg_advisory_xact_lock: null }],
    indexNowOutbox: {
      create: async ({ data }: { data: Omit<OutboxRow, "id"> }) => {
        const row = { ...data, id: `outbox-${outboxRows.length + 1}` };
        outboxRows.push(row);
        return { id: row.id };
      },
      update: async ({ where, data }: { where: { id: string }; data: { deliveryTaskId: string } }) => {
        const row = outboxRows.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error(`missing outbox ${where.id}`);
        row.deliveryTaskId = data.deliveryTaskId;
        return { ...row };
      },
    },
    genericTask: {
      findFirst: async ({ where }: { where: { taskType: string; operationScopeHash: string } }) => {
        const row = taskRows.find((candidate) =>
          candidate.taskType === where.taskType
          && candidate.operationScopeHash === where.operationScopeHash
          && ["pending", "processing"].includes(candidate.status));
        return row ? { id: row.id } : null;
      },
      create: async ({ data }: {
        data: { id?: string; taskType: string; status?: string; operationScopeHash: string };
      }) => {
        const row = {
          id: data.id ?? `task-${taskRows.length + 1}`,
          taskType: data.taskType,
          status: data.status ?? "pending",
          operationScopeHash: data.operationScopeHash,
        };
        taskRows.push(row);
        return { id: row.id };
      },
    },
    siteSetting: {
      findUnique: async () => ({
        siteName: "Acceptance Fixture",
        siteDescription: "",
        homeMetaTitle: "",
        homeMetaDescription: "",
        defaultOgImage: "",
        googleSearchConsoleVerification: "",
        footerCopyrightText: "",
        footerDisclaimerText: "",
        friendLinks: [],
        indexNowHost: "",
        indexNowKey: "",
        indexNowKeyLocation: "",
        ga4MeasurementId: null,
        updatedAt: UPDATED_AT,
      }),
    },
  });

  return { client, outboxRows, taskRows };
}

const previousEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const [key, value] of Object.entries(GATED_ENV)) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
});

afterEach(() => {
  for (const key of Object.keys(GATED_ENV)) {
    const previous = previousEnv.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  previousEnv.clear();
  invalidateSiteSettingCache();
});

describe("P2-12 vertical acceptance", () => {
  it("publishes, exposes the public page, enters sitemap, and enqueues one IndexNow outbox row", async () => {
    const db = new FakePublishGateDb();
    seedReady(db);
    const { client, outboxRows, taskRows } = acceptanceClient(db);

    await expect(applyPublishTransition(client, {
      articleId: ARTICLE_ID,
      requestId: "p2-12-vertical-acceptance",
      actor: { type: "admin", adminId: "owner-fixture" },
      now: UPDATED_AT,
    })).resolves.toEqual({
      outcome: "published",
      articleId: ARTICLE_ID,
      novelId: NOVEL_ID,
      locale: "en",
      firstPublish: true,
    });

    await expect(resolvePublicArticleBySlugParam(client, `${SLUG}-p${SHORT_ID}`, "en"))
      .resolves.toMatchObject({ kind: "published", articleId: ARTICLE_ID, novelId: NOVEL_ID });

    const sitemapFiles = await createSitemapFamilyBuilder(client)({ type: "novelpage", locale: "en" });
    expect(sitemapFiles.flatMap((file) => file.entries).map((entry) => entry.loc))
      .toEqual([`${SITE_URL}/novel/${SLUG}-p${SHORT_ID}`]);

    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]).toMatchObject({
      articleId: ARTICLE_ID,
      url: `${SITE_URL}/novel/${SLUG}-p${SHORT_ID}`,
      revision: BigInt(UPDATED_AT.getTime()),
    });
    expect(taskRows.filter((task) => task.taskType === "indexnow_delivery")).toHaveLength(1);
    expect(taskRows.filter((task) => task.taskType === "sitemap_refresh")).toHaveLength(1);
  });
});
