/**
 * 文章「全选 → 后台批量发布」任务的真实 PostgreSQL 验收（开发单 §四 场景 A–F；G/H 见
 * `tests/backend/tasks/worker-lanes.test.ts` 与既有同步发布用例）。
 *
 * 🔴 角色真实：入队与任务控制走 `web_app`（Server Action 的真实角色），枚举、逐篇发布、
 * 试读合并派发、站点地图触发全部走 **`worker_app`** 连接——发布核心原本只在 web 进程里
 * 跑，现在挪到 worker-light 执行，这个项目出过两次"单测与复核都测不出来的 worker 缺
 * 授权"事故，所以整条发布路径必须以真实角色跑通，任何一处缺授权都是 `permission denied`。
 *
 * 运行方式：`scripts/run-article-publish-batch-postgres-verification.sh`（一次性
 * postgres:16.14，真实迁移 + `infra/postgres/grants.sql`，skipped=0 硬断言）。
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { P2_04_ADMIN_REGISTRY } from "@/app/api/admin/_lib/registry";
import {
  ARTICLE_PUBLISH_BATCH_TASK_TYPE,
  ARTICLE_PUBLISH_TASK_TYPE,
} from "@/domain/article-publish-batch";
import { enqueueArticlePublishParentBatch } from "@/lib/tasks/article-publish";
import { buildWorkerAllowlist, createHandlerRegistry, SITEMAP_REFRESH_TASK_TYPE } from "@/lib/tasks";
import { generateStaticSitemaps } from "@/lib/seo/static-sitemap-generator";
import { refreshStaticSitemap } from "@/lib/seo/sitemap-refresh-state";
import { countArticlesForFilter } from "@/server/articles";
import { applyPublishTransition } from "@/server/publish-gate/service";
import { requireAdminRouteAccess } from "@/server/auth/guards";
import {
  abortTask,
  getAdminTaskDetail,
  pauseTask,
  resumeTask,
  retryFailedTask,
} from "@/server/task-admin";
import { encryptCredentialSecretForWorker } from "../../../worker/credentials/crypto";
import { createArticlePublishWorkerHandlers } from "../../../worker/handlers/article-publish";
import { createArticlePublishBatchWorkerHandlers } from "../../../worker/handlers/article-publish-batch";
import { createSitemapRefreshWorkerHandlers } from "../../../worker/handlers/sitemap-refresh";
import { processOneWorkerCycle } from "../../../worker/runtime/worker";

import { issueTaskAuthorization, newStores, NOW, seedTaskAdmin } from "../../backend/task-admin/test-support";

// worker 进程里没有 Next 请求上下文，`revalidatePath` 本来就会抛并被调用方吞掉；测试里直接 mock，免得刷屏。
vi.mock("@/server/publication/revalidate", () => ({
  revalidatePublicArticlePaths: vi.fn(),
  revalidatePublicArticleSet: vi.fn(),
  revalidatePublicBlogPaths: vi.fn(),
}));

// 站点地图"触发次数"的实测口径：数 `enqueueSitemapRefresh` 与发布核心用的
// `enqueueSitemapRefreshForPublication` 两个入口被调用的总次数（合并机制会把多次调用
// 压成一个任务，所以数任务行数证明不了"触发次数不随篇数线性增长"，必须数调用）。
const sitemapCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/tasks/sitemap-refresh", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tasks/sitemap-refresh")>();
  return {
    ...actual,
    enqueueSitemapRefresh: (...args: Parameters<typeof actual.enqueueSitemapRefresh>) => {
      sitemapCalls.count += 1;
      return actual.enqueueSitemapRefresh(...args);
    },
    enqueueSitemapRefreshForPublication: (...args: Parameters<typeof actual.enqueueSitemapRefreshForPublication>) => {
      sitemapCalls.count += 1;
      return actual.enqueueSitemapRefreshForPublication(...args);
    },
  };
});

const enabled = process.env.ARTICLE_PUBLISH_BATCH_DATABASE_TEST === "1";
const owner = new PrismaClient({ datasourceUrl: process.env.ARTICLE_PUBLISH_BATCH_OWNER_DATABASE_URL });
const web = new PrismaClient({ datasourceUrl: process.env.ARTICLE_PUBLISH_BATCH_WEB_DATABASE_URL });
const worker = new PrismaClient({ datasourceUrl: process.env.ARTICLE_PUBLISH_BATCH_WORKER_DATABASE_URL });

const ENV = {
  NODE_ENV: "test",
  FEATURE_NOVEL_CATALOG_SYNC: "true",
  NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true",
  MOBOREADER_PREVIEW_SOURCE_APP_CODES: "moboreader",
  FEATURE_SITEMAP_AUTO_REFRESH: "true",
  SITEMAP_AUTO_REFRESH_ALLOW_WRITE: "true",
  FEATURE_INDEXNOW_OUTBOX: "true",
  INDEXNOW_OUTBOX_ALLOW_WRITE: "true",
  SITE_URL: "https://publish-batch.example",
} satisfies NodeJS.ProcessEnv;

const ADMIN_ID = "batch-publisher-admin";
const BATCH_TYPES = `${ARTICLE_PUBLISH_BATCH_TASK_TYPE},${ARTICLE_PUBLISH_TASK_TYPE}`;
const roots: string[] = [];

let foundation: { channel: string; app: string; account: string; secondAccount: string };

async function account(channelId: string): Promise<string> {
  const a = await owner.channelAccount.create({ data: { channelId, businessId: randomUUID(), accountName: "local" } });
  const id = randomUUID();
  await owner.channelAccountCredential.create({ data: {
    id, channelAccountId: a.id,
    encryptedSecret: new Uint8Array(encryptCredentialSecretForWorker("local-only-token", a.id, id, 1)),
    keyVersion: 1, secretFingerprint: `hmac-sha256:v1:${"a".repeat(64)}`, fingerprintPrefix: "aaaaaaaaaaaa", status: "active",
  } });
  return a.id;
}

async function resetDatabase(): Promise<void> {
  const [{ name, version }] = await owner.$queryRaw<Array<{ name: string; version: string }>>`
    SELECT current_database() AS name, current_setting('server_version') AS version`;
  if (!name.startsWith("cps_novel_article_publish_batch_") || !version.startsWith("16.14")) {
    throw new Error(`Refusing article-publish-batch setup against ${name} (${version})`);
  }
  const tables = await owner.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await owner.$executeRawUnsafe(
    `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(",")} RESTART IDENTITY CASCADE`,
  );
  await owner.siteSetting.create({ data: { id: 1 } });
  const channel = await owner.channel.create({ data: { code: "changdu", name: "local" } });
  const sourceApp = await owner.sourceApp.create({ data: { code: "moboreader", name: "local" } });
  const app = await owner.channelApp.create({ data: { channelId: channel.id, sourceAppId: sourceApp.id, externalAppId: "local", projectType: 1 } });
  await owner.channelCapability.createMany({ data: ["getbydataid", "getchapterinfo", "getlistpc"].map((capabilityKey) => ({
    channelAppId: app.id, capabilityKey, status: "enabled", sideEffecting: false, evidenceLevel: "READ_ONLY_PRODUCTION_READ_PROVEN",
  })) });
  foundation = { channel: channel.id, app: app.id, account: await account(channel.id), secondAccount: await account(channel.id) };
  sitemapCalls.count = 0;
}

/**
 * 一条语句批量造草稿：每篇一本书 + 来源条目 + 推广链接 + 草稿文章（同 `publication-preview`
 * 用例的夹具形状）。`rejectEvery = k` 时第 k、2k… 篇不建推广链接 → 发布检查会以
 * `promo_link_missing` 拒绝。返回按序号排序的文章编号。
 */
async function seedDrafts(
  count: number,
  options: { accountId?: string; rejectEvery?: number; prefix?: string } = {},
): Promise<string[]> {
  const accountId = options.accountId ?? foundation.account;
  const rejectEvery = options.rejectEvery ?? 0;
  const prefix = options.prefix ?? "bp";
  await owner.$executeRaw(Prisma.sql`
    WITH g AS (
      SELECT n, gen_random_uuid() AS novel_id, gen_random_uuid() AS source_id,
             gen_random_uuid() AS promo_id, gen_random_uuid() AS article_id,
             (${rejectEvery}::int > 0 AND n % ${rejectEvery}::int = 0) AS no_promo
      FROM generate_series(1, ${count}::int) AS n
    ), n_ins AS (
      INSERT INTO novel (id, business_id, title, description, locale, slug, status, total_chapter_count, created_at, updated_at)
      SELECT novel_id, ${prefix}::text || '-' || substr(md5(novel_id::text), 1, 20), 'Novel ' || n, 'd', 'en',
             ${prefix}::text || '-n-' || substr(md5(novel_id::text), 1, 20), 'ready', 3, now(), now()
      FROM g
    ), s_ins AS (
      INSERT INTO novel_source_item (id, channel_app_id, novel_id, external_book_id, external_agency_id, source_language_code,
                                     title, description, status, raw_payload, raw_payload_schema_version, created_at, updated_at)
      SELECT source_id, ${foundation.app}::uuid, novel_id, ${prefix}::text || '-b-' || substr(md5(source_id::text), 1, 20), 'agency', '2',
             'Novel ' || n, 'd', 'linked',
             jsonb_build_object('agencyId', 'agency', 'seriesId', substr(md5(source_id::text), 1, 20), 'language', '2',
                                'projectType', 1, 'allEpis', 3, 'payEpisFrom', 2),
             1, now(), now()
      FROM g
    ), p_ins AS (
      INSERT INTO promo_link (id, novel_id, novel_source_item_id, channel_app_id, channel_account_id, offer_type,
                              public_redirect_code, idempotency_key, status, web_url, created_at, updated_at)
      SELECT promo_id, novel_id, source_id, ${foundation.app}::uuid, ${accountId}::uuid, 'read',
             'p' || substr(md5(promo_id::text), 1, 20), rpad(md5(promo_id::text), 64, '0'), 'fetched',
             'https://local.example/read', now(), now()
      FROM g WHERE NOT no_promo
    )
    INSERT INTO article (id, novel_id, locale, slug, public_page_short_id, title, body, status, promo_link_id,
                         seo_metadata, seo_schema_version, article_type, content_mode, seo_visibility, created_at, updated_at)
    SELECT article_id, novel_id, 'en', ${prefix}::text || '-a-' || substr(md5(article_id::text), 1, 20),
           substr(md5(article_id::text), 1, 12), 'Article ' || n, 'Fixture body', 'draft',
           CASE WHEN no_promo THEN NULL ELSE promo_id END,
           '{}'::jsonb, 1, 'novel_article', 'template', 'public', now(), now()
    FROM g
  `);
  const rows = await owner.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM article WHERE slug LIKE ${`${prefix}-a-%`} ORDER BY created_at, id`);
  return rows.map((row) => row.id);
}

function lightRegistry(extra: Parameters<typeof createHandlerRegistry>[0] = {}) {
  return {
    ...createArticlePublishBatchWorkerHandlers(worker),
    ...createArticlePublishWorkerHandlers(worker, ENV),
    ...extra,
  };
}

async function cycle(types = BATCH_TYPES, registry = lightRegistry()): Promise<boolean> {
  return processOneWorkerCycle({
    prisma: worker,
    workerId: "light-publish-test",
    handlers: registry,
    allowlist: buildWorkerAllowlist(types, registry),
    signal: new AbortController().signal,
  });
}

async function drain(limit = 200_000): Promise<number> {
  let cycles = 0;
  while (await cycle()) {
    cycles += 1;
    if (cycles > limit) throw new Error("worker never went idle");
  }
  return cycles;
}

async function runCycles(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await cycle();
}

async function submit(options: {
  filter?: Record<string, string>;
  skipPreview?: boolean;
  requestId?: string;
}): Promise<{ taskId: string; requestId: string; draftCount: number }> {
  const requestId = options.requestId ?? randomUUID();
  const filter = options.filter ?? {};
  const draftCount = await countArticlesForFilter(web, { ...filter, status: "draft" });
  const result = await enqueueArticlePublishParentBatch(web, {
    filter,
    skipPreview: options.skipPreview,
    actorId: ADMIN_ID,
    requestId,
    draftCount,
  });
  return { taskId: result.taskId, requestId, draftCount };
}

async function children(parentId: string) {
  return owner.genericTask.findMany({
    where: { parentTaskId: parentId, taskType: ARTICLE_PUBLISH_TASK_TYPE },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

async function count(sql: Prisma.Sql): Promise<number> {
  const [row] = await owner.$queryRaw<Array<{ n: bigint | number }>>(sql);
  return Number(row.n);
}

const publishedCount = () => count(Prisma.sql`SELECT count(*) AS n FROM article WHERE status = 'published'`);

async function controlDependencies() {
  const stores = newStores();
  const admin = seedTaskAdmin(stores, { identityId: ADMIN_ID });
  return { stores, admin };
}

async function ticket(
  pathname: "/api/admin/tasks/pause" | "/api/admin/tasks/resume" | "/api/admin/tasks/abort" | "/api/admin/tasks/retry-failed",
) {
  const { stores, admin } = await controlDependencies();
  const issued = await issueTaskAuthorization(stores, { token: admin.token, pathname });
  return { ...issued, dependencies: { db: web, identities: stores, sessions: stores, now: NOW, env: ENV } };
}

async function readContext() {
  const { stores, admin } = await controlDependencies();
  const { context } = await requireAdminRouteAccess(
    { pathname: "/api/admin/tasks", method: "GET", sessionToken: admin.token },
    { identities: stores, sessions: stores, registry: P2_04_ADMIN_REGISTRY, now: NOW },
  );
  return context;
}

async function parentDetail(parentId: string) {
  return getAdminTaskDetail(web, await readContext(), { family: "generic", taskId: parentId }, ENV);
}

async function rootDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "article-publish-batch-sitemap-"));
  roots.push(root);
  return root;
}

describe.skipIf(!enabled).sequential("article publish batch task · real roles (web_app enqueue/control, worker_app execution)", () => {
  beforeAll(async () => {
    for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
    await resetDatabase();
    expect((await worker.$queryRaw<Array<{ role: string }>>`SELECT current_user AS role`)[0].role).toBe("worker_app");
    expect((await web.$queryRaw<Array<{ role: string }>>`SELECT current_user AS role`)[0].role).toBe("web_app");
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    await Promise.all([owner.$disconnect(), web.$disconnect(), worker.$disconnect()]);
  });

  describe("A / C(默认) / D：全选 1,000 篇草稿", () => {
    let parentId = "";
    let batchRequestId = "";
    let articleIds: string[] = [];
    let sitemapCallsAfterRun = 0;
    let cyclesUsed = 0;

    beforeAll(async () => {
      await resetDatabase();
      articleIds = await seedDrafts(1000);
      const submitted = await submit({});
      parentId = submitted.taskId;
      batchRequestId = submitted.requestId;
      expect(submitted.draftCount).toBe(1000);
      cyclesUsed = await drain();
      sitemapCallsAfterRun = sitemapCalls.count;
    }, 590_000);

    it("A. 建 1 个父任务 + 5 个子任务（各 200 篇），全部发布，审计 1,000 条、actor 为提交人、请求编号是「批次:文章」格式", async () => {
      expect(await owner.genericTask.count({ where: { taskType: ARTICLE_PUBLISH_BATCH_TASK_TYPE } })).toBe(1);
      const kids = await children(parentId);
      expect(kids).toHaveLength(5);
      expect(kids.map((kid) => kid.totalCount)).toEqual([200, 200, 200, 200, 200]);
      expect(kids.every((kid) => kid.status === "completed" && kid.successCount === 200)).toBe(true);
      expect(await publishedCount()).toBe(1000);
      expect(await count(Prisma.sql`SELECT count(*) AS n FROM novel WHERE status = 'published'`)).toBe(1000);
      expect(await count(Prisma.sql`SELECT count(*) AS n FROM article WHERE status = 'published' AND published_at IS NOT NULL`)).toBe(1000);
      const audits = await count(Prisma.sql`
        SELECT count(*) AS n FROM operation_audit
        WHERE action = 'article.publish' AND entity_type = 'Article' AND actor_type = 'admin' AND actor_id = ${ADMIN_ID}`);
      expect(audits).toBe(1000);
      const wellFormed = await count(Prisma.sql`
        SELECT count(*) AS n FROM operation_audit
        WHERE action = 'article.publish' AND request_id = ${batchRequestId}::text || ':' || entity_id`);
      expect(wellFormed).toBe(1000);
      // 提交人也写进了任务本身的审计。
      expect(await count(Prisma.sql`
        SELECT count(*) AS n FROM operation_audit
        WHERE action = 'article_publish_batch.queued' AND actor_id = ${ADMIN_ID} AND request_id = ${batchRequestId}`)).toBe(1);
      const parent = await owner.genericTask.findUniqueOrThrow({ where: { id: parentId } });
      expect(parent.result).toMatchObject({ enumerationStatus: "completed", selectedCount: 1000, childTaskCount: 5, skipPreview: false });
      expect(articleIds).toHaveLength(1000);
      process.stdout.write(`ARTICLE_PUBLISH_BATCH_A articles=1000 children=5 worker_cycles=${cyclesUsed}\n`);
    });

    it("C. 默认每个子任务合并建 1 个试读抓取任务，覆盖本子任务的 200 本书", async () => {
      const tasks = await owner.channelSyncTask.findMany({ orderBy: { createdAt: "asc" } });
      expect(tasks).toHaveLength(5);
      expect(tasks.every((task) => task.taskType === "moboreader.preview_refresh.v1" && task.totalCount === 200)).toBe(true);
      const kids = await children(parentId);
      for (const kid of kids) {
        // 本子任务的书 = 该子任务条目对应文章的来源条目。
        const mismatch = await count(Prisma.sql`
          WITH kid_sources AS (
            SELECT p.novel_source_item_id AS id
            FROM generic_task_item i
            JOIN article a ON a.id = (i.result->>'articleId')::uuid
            JOIN promo_link p ON p.id = a.promo_link_id
            WHERE i.task_id = ${kid.id}::uuid
          ), covering AS (
            SELECT t.id FROM channel_sync_task t
            WHERE t.task_type = 'moboreader.preview_refresh.v1'
              AND NOT EXISTS (
                SELECT 1 FROM channel_sync_task_item ti
                WHERE ti.task_id = t.id AND ti.novel_source_item_id NOT IN (SELECT id FROM kid_sources)
              )
              AND (SELECT count(*) FROM channel_sync_task_item ti WHERE ti.task_id = t.id) = 200
          )
          SELECT count(*) AS n FROM covering`);
        expect(mismatch, `child ${kid.id}`).toBe(1);
        expect(kid.result).toMatchObject({ previewDispatch: { publishedCount: 200, groupCount: 1 } });
      }
      const detail = await parentDetail(parentId);
      expect(detail.articlePublishBatch).toMatchObject({
        skipPreview: false, publishedCount: 1000, rejectedCount: 0, unfinishedCount: 0,
        preview: { dispatchedChildCount: 5, taskGroupCount: 5, skippedBookCount: null },
      });
    });

    it("D. 全量发布后站点地图触发一次（实测次数不随篇数线性增长），且那次刷新真的成功把文章写进站点地图", async () => {
      process.stdout.write(`ARTICLE_PUBLISH_BATCH_D sitemap_trigger_calls=${sitemapCallsAfterRun} for_articles=1000\n`);
      expect(sitemapCallsAfterRun).toBe(1);
      const parent = await owner.genericTask.findUniqueOrThrow({ where: { id: parentId } });
      expect(parent.result).toMatchObject({
        publishedCount: 1000,
        sitemapRefresh: { status: "queued", triggerCount: 1, coveredPublishedCount: 1000 },
      });
      const refreshTasks = await owner.genericTask.findMany({ where: { taskType: SITEMAP_REFRESH_TASK_TYPE } });
      expect(refreshTasks).toHaveLength(1);
      expect(refreshTasks[0]).toMatchObject({ status: "pending" });
      expect(refreshTasks[0].params).toMatchObject({
        reason: "article_publish_batch", triggeredBy: `${ARTICLE_PUBLISH_BATCH_TASK_TYPE}#${parentId}`,
      });

      // 再让轻量 worker 真的把这个刷新任务跑完：站点地图成功生成，并且收录了刚发布的文章。
      const root = await rootDir();
      const registry = createSitemapRefreshWorkerHandlers(worker, {
        rootDir: root,
        env: { ...process.env, ...ENV },
        refresh: (options) => refreshStaticSitemap({
          ...options,
          generate: (generation) => generateStaticSitemaps({ ...generation, types: ["novelpage"], routeLocales: ["en"] }),
        }),
      });
      expect(await cycle(SITEMAP_REFRESH_TASK_TYPE, registry)).toBe(true);
      const done = await owner.genericTask.findUniqueOrThrow({ where: { id: refreshTasks[0].id } });
      expect(done.status).toBe("completed");
      const refreshItem = await owner.genericTaskItem.findFirstOrThrow({ where: { taskId: refreshTasks[0].id } });
      expect(refreshItem.status).toBe("success");
      expect(refreshItem.result).toMatchObject({ coalesced: false });
      expect((refreshItem.result as { urlCount: number }).urlCount).toBeGreaterThanOrEqual(1000);
      const entries = await readdir(root);
      expect(entries.length).toBeGreaterThan(0);
    }, 300_000);
  });

  it("B. 与按钮一致：同一类文章，后台任务发布与按钮发布后，文章/书目/审计/试读/IndexNow 的数据库结果逐项一致", async () => {
    await resetDatabase();
    const [buttonArticle] = await seedDrafts(1, { accountId: foundation.account, prefix: "btn" });
    const [taskArticle] = await seedDrafts(1, { accountId: foundation.secondAccount, prefix: "tsk" });

    // 按钮路径：web 进程里直接调发布核心（同步「发布」按钮、同步批量发布都是它）。
    const buttonRequest = randomUUID();
    const buttonResult = await applyPublishTransition(
      web, { articleId: buttonArticle, requestId: buttonRequest, actor: { type: "admin", adminId: ADMIN_ID } },
    );
    expect(buttonResult.outcome).toBe("published");

    // 后台任务路径：只发布 `tsk-` 开头那一篇（按搜索条件圈定）。
    const submitted = await submit({ filter: { search: "tsk-a-" } });
    expect(submitted.draftCount).toBe(1);
    await drain();

    async function snapshot(articleId: string, label: string) {
      const [article] = await owner.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT a.status, a.published_at IS NOT NULL AS has_published_at, a.locale, a.article_type, a.seo_visibility,
               n.status AS novel_status
        FROM article a JOIN novel n ON n.id = a.novel_id WHERE a.id = ${articleId}::uuid`);
      const audit = await owner.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT action, entity_type, actor_type, actor_id, before_snapshot, after_snapshot
        FROM operation_audit WHERE entity_id = ${articleId} AND action = 'article.publish'`);
      // B-34：出站记录逐列对比，不只看"有一条"——事件、状态、语种、来源、是否立即投递、URL 形状
      // （去掉文章自己的 slug / 短码后必须一样）、revision 是否等于文章 updated_at 毫秒，以及配套建出的
      // 投递任务与条目（类型、条数、reason、triggeredBy、条目状态）。
      const outbox = await owner.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT o.event_type, o.status, o.locale, o.source, (o.available_at IS NULL) AS immediate,
               (o.defer_reason IS NULL) AS not_deferred, (o.source_task_id IS NULL) AS no_source_task,
               replace(replace(o.url, a.slug, '<slug>'), a.public_page_short_id, '<short-id>') AS url_shape,
               (o.revision = floor(extract(epoch FROM a.updated_at) * 1000)::bigint) AS revision_is_article_updated_at,
               t.task_type AS delivery_task_type, t.total_count AS delivery_total_count,
               t.params ->> 'reason' AS delivery_reason, t.params ->> 'triggeredBy' AS delivery_triggered_by,
               ti.target_type AS delivery_item_target, ti.status AS delivery_item_status
        FROM indexnow_outbox o
        JOIN article a ON a.id = o.article_id
        LEFT JOIN generic_task t ON t.id = o.delivery_task_id
        LEFT JOIN generic_task_item ti ON ti.task_id = t.id
        WHERE o.article_id = ${articleId}::uuid`);
      const preview = await owner.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT t.task_type, t.mode, t.status, t.total_count, ti.status AS item_status
        FROM channel_sync_task t
        JOIN channel_sync_task_item ti ON ti.task_id = t.id
        JOIN promo_link p ON p.novel_source_item_id = ti.novel_source_item_id
        JOIN article a ON a.promo_link_id = p.id
        WHERE a.id = ${articleId}::uuid`);
      return { label, article, audit, outbox, preview };
    }
    const button = await snapshot(buttonArticle, "button");
    const task = await snapshot(taskArticle, "task");
    expect(button.article).toMatchObject({ status: "published", has_published_at: true, novel_status: "published" });
    expect(button.audit).toHaveLength(1);
    expect(button.outbox).toHaveLength(1);
    expect(button.preview).toHaveLength(1);
    // B-34：开关为 true 时，经 worker_app（worker-light 的真实角色）执行的子任务写出的出站记录
    // 与按钮发布（web_app）写出的记录形状一致——并且是"真的写了"，不是两边都空。
    const expectedOutbox = {
      event_type: "article_first_publish", status: "pending", locale: "en", source: "admin.article.publish",
      immediate: true, not_deferred: true, no_source_task: true, revision_is_article_updated_at: true,
      delivery_task_type: "indexnow_delivery", delivery_total_count: 1,
      delivery_reason: "article_first_publish", delivery_triggered_by: "admin.article.publish",
      delivery_item_target: "indexnow_outbox", delivery_item_status: "pending",
    };
    expect(button.outbox).toEqual([expect.objectContaining(expectedOutbox)]);
    expect(task.outbox).toEqual([expect.objectContaining(expectedOutbox)]);
    expect(task.outbox[0]!.url_shape).toBe("https://publish-batch.example/novel/<slug>-p<short-id>");
    expect(await count(Prisma.sql`SELECT count(*) AS n FROM indexnow_outbox`)).toBe(2);
    // 逐项一致（请求编号按设计不同：按钮是调用方给的编号，任务是「批次:文章」）。
    expect({ ...task, label: "" }).toEqual({ ...button, label: "" });

    // 唯一按设计不同的一项：站点地图。按钮每篇首次发布各触发一次；后台任务整批结束触发一次。
    // 这里批次只有 1 篇，所以两边各 1 次——差别在 D 场景里用 1,000 篇证明。
    expect(sitemapCalls.count).toBe(2);
  }, 300_000);

  // B-34：双闸任何一把没开，两条路径都不能写。用 `it.each` 把三种"没同时打开"的取值都跑一遍；
  // 每个用例结束（含失败）都把进程 env 还原成文件级的 ENV（两把都 true），不影响后面的用例。
  it.each([
    { name: "总闸与写闸都关", feature: "false", allow: "false" },
    { name: "只开总闸（dry-run 形状）", feature: "true", allow: "false" },
    { name: "只开写闸", feature: "false", allow: "true" },
  ])("B'. IndexNow 出站双闸未同时打开（$name）：按钮发布与后台任务发布都不写出站记录、不建投递任务，其余发布结果照常", async ({ feature, allow }) => {
    await resetDatabase();
    const [buttonArticle] = await seedDrafts(1, { accountId: foundation.account, prefix: "btn" });
    const [taskArticle] = await seedDrafts(1, { accountId: foundation.secondAccount, prefix: "tsk" });
    vi.stubEnv("FEATURE_INDEXNOW_OUTBOX", feature);
    vi.stubEnv("INDEXNOW_OUTBOX_ALLOW_WRITE", allow);
    try {
      const buttonResult = await applyPublishTransition(
        web, { articleId: buttonArticle, requestId: randomUUID(), actor: { type: "admin", adminId: ADMIN_ID } },
      );
      expect(buttonResult.outcome).toBe("published");
      const submitted = await submit({ filter: { search: "tsk-a-" } });
      expect(submitted.draftCount).toBe(1);
      await drain();
    } finally {
      vi.stubEnv("FEATURE_INDEXNOW_OUTBOX", ENV.FEATURE_INDEXNOW_OUTBOX);
      vi.stubEnv("INDEXNOW_OUTBOX_ALLOW_WRITE", ENV.INDEXNOW_OUTBOX_ALLOW_WRITE);
    }
    // 两条路径都真的发布了（审计各 1 条）——只是没有出站副作用。
    expect(await publishedCount()).toBe(2);
    for (const articleId of [buttonArticle, taskArticle]) {
      expect(await count(Prisma.sql`
        SELECT count(*) AS n FROM operation_audit WHERE action = 'article.publish' AND entity_id = ${articleId}`)).toBe(1);
    }
    expect(await count(Prisma.sql`SELECT count(*) AS n FROM indexnow_outbox`)).toBe(0);
    expect(await count(Prisma.sql`SELECT count(*) AS n FROM generic_task WHERE task_type = 'indexnow_delivery'`)).toBe(0);
    expect(await count(Prisma.sql`SELECT count(*) AS n FROM generic_task_item WHERE target_type = 'indexnow_outbox'`)).toBe(0);
  }, 300_000);

  it("C'. 勾选「发布时暂不抓试读」：一个试读任务都不建，父任务结果记录跳过的本数", async () => {
    await resetDatabase();
    await seedDrafts(400);
    const { taskId } = await submit({ skipPreview: true });
    await drain();
    expect(await publishedCount()).toBe(400);
    expect(await owner.channelSyncTask.count()).toBe(0);
    expect(await owner.channelSyncTaskItem.count()).toBe(0);
    const kids = await children(taskId);
    expect(kids).toHaveLength(2);
    for (const kid of kids) expect(kid.result).toMatchObject({ previewDispatch: { skipped: true, publishedCount: 200 } });
    const parent = await owner.genericTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(parent.result).toMatchObject({ skipPreview: true, previewSkippedBookCount: 400, publishedCount: 400 });
    const detail = await parentDetail(taskId);
    expect(detail.articlePublishBatch).toMatchObject({
      skipPreview: true, publishedCount: 400, preview: { skippedBookCount: 400, dispatchedChildCount: 0, taskGroupCount: 0 },
    });
  }, 300_000);

  it("E. 暂停后不再发布新文章，恢复后继续；中止后剩余条目标记为未尝试、已发布的保持，并收尾已发布部分", async () => {
    await resetDatabase();
    await seedDrafts(400);
    const { taskId } = await submit({});
    await runCycles(1); // 只做枚举：建 2 个子任务，条目都还没动
    expect(await children(taskId)).toHaveLength(2);
    expect(await publishedCount()).toBe(0);
    await runCycles(30);
    const before = await publishedCount();
    expect(before).toBe(30);

    // ---- 整批暂停（任务中心对父任务点「暂停」→ 级联到子任务）
    const pause = await ticket("/api/admin/tasks/pause");
    const paused = await pauseTask({ authorization: pause.authorization, requestId: pause.requestId, family: "generic", taskId, reason: "验收：暂停" }, pause.dependencies);
    expect(paused).toMatchObject({ status: "paused", wrote: true });
    expect((await children(taskId)).map((kid) => kid.status)).toEqual(["paused", "paused"]);
    // 同一个请求编号重放：不重复写
    expect(await pauseTask({ authorization: pause.authorization, requestId: pause.requestId, family: "generic", taskId, reason: "验收：暂停" }, pause.dependencies))
      .toMatchObject({ status: "paused", wrote: false });
    expect(await cycle()).toBe(false); // worker 找不到可领的条目
    await runCycles(20);
    expect(await publishedCount()).toBe(before); // 暂停后不再发布新文章
    expect((await parentDetail(taskId)).status).toBe("paused");
    // 暂停期间没有任何收尾：还有 pending 条目，所以不触发站点地图、不建试读任务
    expect(sitemapCalls.count).toBe(0);
    expect(await owner.channelSyncTask.count()).toBe(0);

    // ---- 恢复后继续，发布到 60
    const resume = await ticket("/api/admin/tasks/resume");
    expect(await resumeTask({ authorization: resume.authorization, requestId: resume.requestId, family: "generic", taskId }, resume.dependencies))
      .toMatchObject({ status: "pending", wrote: true });
    expect((await children(taskId)).every((kid) => kid.status === "pending")).toBe(true);
    await runCycles(30);
    expect(await publishedCount()).toBe(60);

    // ---- 整批中止：剩余 340 个条目标记为未尝试，已发布的 60 篇保持
    const abort = await ticket("/api/admin/tasks/abort");
    const aborted = await abortTask({ authorization: abort.authorization, requestId: abort.requestId, family: "generic", taskId, reason: "验收：中止" }, abort.dependencies);
    expect(aborted).toMatchObject({ status: "cancelled", terminatedPendingItemCount: 340, wrote: true });
    expect((await children(taskId)).every((kid) => kid.status === "cancelled")).toBe(true);
    expect(await owner.genericTaskItem.count({
      where: { task: { parentTaskId: taskId }, status: "skipped", error: { path: ["code"], equals: "task_manually_aborted" } },
    })).toBe(340);
    expect(await cycle()).toBe(false);
    expect(await publishedCount()).toBe(60); // 已发布的保持，没有回滚也没有新增
    expect(await owner.article.count({ where: { status: "draft" } })).toBe(340);

    const detail = await parentDetail(taskId);
    expect(detail.status).toBe("cancelled");
    expect(detail.articlePublishBatch).toMatchObject({
      publishedCount: 60, abortedUnattemptedCount: 340, unfinishedCount: 0, rejectedCount: 0,
    });
    // 中止时恰好没有在途条目：整批级联中止在提交之后主动收尾——已发布的 60 篇补一次站点地图，试读合并派发。
    expect(sitemapCalls.count).toBe(1);
    const parent = await owner.genericTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(parent.result).toMatchObject({ sitemapRefresh: { triggerCount: 1, coveredPublishedCount: 60 } });
    // 试读：每个"有已发布文章"的子任务各合并派发一次（条目在子任务间怎么分布取决于领取顺序，
    // 所以这里数的是"有已发布文章的子任务数"，而不是写死 2）。
    const kidsWithPublished = await count(Prisma.sql`
      SELECT count(DISTINCT c.id) AS n FROM generic_task c
      JOIN generic_task_item i ON i.task_id = c.id AND i.status = 'success'
      WHERE c.parent_task_id = ${taskId}::uuid`);
    expect(kidsWithPublished).toBeGreaterThanOrEqual(1);
    expect(await owner.channelSyncTask.count()).toBe(kidsWithPublished);
  }, 590_000);

  it("F. 发布检查不通过的文章记为失败并带原因；重试失败项不会重复发布已发布的；条目重放走稳定请求编号", async () => {
    await resetDatabase();
    const articleIds = await seedDrafts(10, { rejectEvery: 3 }); // 第 3/6/9 篇没有推广链接
    const { taskId, requestId } = await submit({});
    await drain();

    expect(await publishedCount()).toBe(7);
    let detail = await parentDetail(taskId);
    expect(detail.status).toBe("completed_with_errors");
    expect(detail.articlePublishBatch).toMatchObject({
      publishedCount: 7, rejectedCount: 3, unfinishedCount: 0, rejectedReasonCounts: { promo_link_missing: 3 },
    });
    const failed = await owner.genericTaskItem.findMany({ where: { task: { parentTaskId: taskId }, status: "failed" } });
    expect(failed).toHaveLength(3);
    for (const item of failed) {
      expect(item.error).toMatchObject({ code: "publish_gate_rejected" });
      expect(item.result).toMatchObject({ outcome: "rejected", reasons: ["promo_link_missing"] });
    }
    const auditCountBefore = await count(Prisma.sql`SELECT count(*) AS n FROM operation_audit WHERE action = 'article.publish'`);
    expect(auditCountBefore).toBe(7);
    const publishedAtBefore = await owner.$queryRaw<Array<{ id: string; published_at: Date }>>(Prisma.sql`
      SELECT id, published_at FROM article WHERE status = 'published' ORDER BY id`);
    const outboxBefore = await count(Prisma.sql`SELECT count(*) AS n FROM indexnow_outbox`);
    expect(outboxBefore).toBe(7);

    // 条目重放（租约过期重领 / 提交与落库之间进程死掉的等价物）：把一个已发布条目重置成 pending。
    const publishedItem = await owner.genericTaskItem.findFirstOrThrow({
      where: { task: { parentTaskId: taskId }, status: "success" }, orderBy: { id: "asc" },
    });
    await owner.$executeRaw(Prisma.sql`
      UPDATE generic_task_item SET status = 'pending', result = NULL, finished_at = NULL WHERE id = ${publishedItem.id}::uuid`);
    await owner.$executeRaw(Prisma.sql`
      UPDATE generic_task SET status = 'processing', completed_at = NULL WHERE id = ${publishedItem.taskId}::uuid`);
    await drain();
    const replayed = await owner.genericTaskItem.findUniqueOrThrow({ where: { id: publishedItem.id } });
    expect(replayed.status).toBe("success");
    expect(replayed.result).toMatchObject({ outcome: "published", firstPublish: false, wrote: false });
    expect(await count(Prisma.sql`SELECT count(*) AS n FROM operation_audit WHERE action = 'article.publish'`)).toBe(7);
    expect(await count(Prisma.sql`SELECT count(*) AS n FROM indexnow_outbox`)).toBe(7);
    expect(await owner.$queryRaw(Prisma.sql`
      SELECT id, published_at FROM article WHERE status = 'published' ORDER BY id`)).toEqual(publishedAtBefore);

    // 运营补好那 3 篇的推广链接，再点「重试失败项」。
    const rejectedArticleIds = (await owner.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM article WHERE promo_link_id IS NULL ORDER BY id`)).map((row) => row.id);
    expect(rejectedArticleIds).toHaveLength(3);
    expect(articleIds).toHaveLength(10);
    for (const articleId of rejectedArticleIds) {
      await owner.$executeRaw(Prisma.sql`
        WITH a AS (SELECT id, novel_id FROM article WHERE id = ${articleId}::uuid),
        s AS (SELECT id FROM novel_source_item WHERE novel_id = (SELECT novel_id FROM a)),
        p AS (
          INSERT INTO promo_link (id, novel_id, novel_source_item_id, channel_app_id, channel_account_id, offer_type,
                                  public_redirect_code, idempotency_key, status, web_url, created_at, updated_at)
          SELECT gen_random_uuid(), (SELECT novel_id FROM a), s.id, ${foundation.app}::uuid, ${foundation.account}::uuid, 'read',
                 'r' || substr(md5(random()::text), 1, 20), md5(random()::text) || md5(random()::text), 'fetched',
                 'https://local.example/read', now(), now()
          FROM s RETURNING id)
        UPDATE article SET promo_link_id = (SELECT id FROM p) WHERE id = ${articleId}::uuid`);
    }
    const retry = await ticket("/api/admin/tasks/retry-failed");
    const retried = await retryFailedTask({ authorization: retry.authorization, requestId: retry.requestId, family: "generic", taskId }, retry.dependencies);
    expect(retried).toMatchObject({ status: "pending", retriedItemCount: 3, wrote: true });
    await drain();

    expect(await publishedCount()).toBe(10);
    detail = await parentDetail(taskId);
    expect(detail.status).toBe("completed");
    expect(detail.articlePublishBatch).toMatchObject({ publishedCount: 10, rejectedCount: 0, unfinishedCount: 0 });
    // 每篇恰好 1 条发布审计、1 条 IndexNow 出站；先前发布过的 7 篇 published_at 没动；请求编号稳定。
    expect(await count(Prisma.sql`SELECT count(*) AS n FROM operation_audit WHERE action = 'article.publish'`)).toBe(10);
    expect(await count(Prisma.sql`SELECT count(*) AS n FROM indexnow_outbox`)).toBe(10);
    const after = await owner.$queryRaw<Array<{ id: string; published_at: Date }>>(Prisma.sql`
      SELECT id, published_at FROM article WHERE id = ANY(${publishedAtBefore.map((row) => row.id)}::uuid[]) ORDER BY id`);
    expect(after).toEqual(publishedAtBefore);
    expect(await count(Prisma.sql`
      SELECT count(*) AS n FROM operation_audit
      WHERE action = 'article.publish' AND request_id = ${requestId}::text || ':' || entity_id`)).toBe(10);
    // 重试补发了新增的 3 篇：整批的站点地图水位线推进到 10，总共触发 2 次（首次跑完 7 篇 + 重试后补 3 篇）。
    const parent = await owner.genericTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(parent.result).toMatchObject({ sitemapRefresh: { triggerCount: 2, coveredPublishedCount: 10 } });
  }, 590_000);

  it("执行时文章已不是草稿（被别人下线/发布）→ 跳过，不重新发布；已删除 → 跳过", async () => {
    await resetDatabase();
    const ids = await seedDrafts(4);
    const { taskId } = await submit({});
    await runCycles(1);
    await owner.article.update({ where: { id: ids[0] }, data: { status: "unpublished" } });
    await owner.article.update({ where: { id: ids[1] }, data: { status: "published", publishedAt: new Date() } });
    await owner.article.update({ where: { id: ids[2] }, data: { deletedAt: new Date() } });
    await drain();
    expect(await owner.article.findUniqueOrThrow({ where: { id: ids[0] } })).toMatchObject({ status: "unpublished" });
    expect(await owner.article.findUniqueOrThrow({ where: { id: ids[3] } })).toMatchObject({ status: "published" });
    const detail = await parentDetail(taskId);
    expect(detail.articlePublishBatch).toMatchObject({ publishedCount: 1, notDraftCount: 2, notFoundCount: 1, unfinishedCount: 0 });
    // 被跳过的文章没有产生发布审计。
    expect(await count(Prisma.sql`SELECT count(*) AS n FROM operation_audit WHERE action = 'article.publish'`)).toBe(1);
  }, 300_000);

  it("入队：同一个请求编号重放得到同一个任务；超过 50,000 篇与零草稿被拒；筛选快照按列表同一个 WHERE 枚举", async () => {
    await resetDatabase();
    await seedDrafts(3, { prefix: "keep" });
    await seedDrafts(2, { prefix: "other" });
    const requestId = randomUUID();
    const first = await submit({ filter: { search: "keep-a-" }, requestId });
    const again = await enqueueArticlePublishParentBatch(web, {
      filter: { search: "keep-a-" }, actorId: ADMIN_ID, requestId, draftCount: 3,
    });
    expect(again).toMatchObject({ taskId: first.taskId, duplicate: true });
    await expect(enqueueArticlePublishParentBatch(web, {
      filter: { search: "other-a-" }, actorId: ADMIN_ID, requestId, draftCount: 2,
    })).rejects.toMatchObject({ code: "request_replay_mismatch" });
    await expect(enqueueArticlePublishParentBatch(web, {
      filter: {}, actorId: ADMIN_ID, requestId: randomUUID(), draftCount: 50_001,
    })).rejects.toMatchObject({ code: "selection_too_large" });
    await expect(enqueueArticlePublishParentBatch(web, {
      filter: {}, actorId: ADMIN_ID, requestId: randomUUID(), draftCount: 0,
    })).rejects.toMatchObject({ code: "no_draft_in_filter" });
    await drain();
    // 只发布了筛选圈定的 3 篇，`other-` 的 2 篇保持草稿。
    expect(await publishedCount()).toBe(3);
    expect(await owner.article.count({ where: { status: "draft" } })).toBe(2);
  }, 300_000);
});
