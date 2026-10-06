/**
 * 真实 PostgreSQL 验收：一次性运维脚本 `scripts/ops/withdraw-zero-chapter-novels-20261007.ts`
 * （上游零章节 236 本切换前下线）必须和后台「撤回」按钮的数据库事务**逐项一致**，并且不越界。
 *
 * 为什么必须是真实库：撤回的全部语义落在假库不建模的东西上——`@updatedAt` 自动维护、
 * `operation_audit_admin_request_action_uidx`（request_id, action）唯一约束、`operation_audit` 的
 * 只追加触发器、以及 `web_app` 角色的列级/表级授权（`novel_source_item` 对 web_app 只有列级 SELECT，
 * 用 `SELECT *` 就会 permission denied）。所以脚本核心与按钮服务函数（`withdrawNovel`）都用真实
 * `web_app` 连接串跑，夹具与快照用 owner 连接串。
 *
 * 运行方式：`scripts/run-article-publish-batch-postgres-verification.sh`（一次性 postgres:16.14，
 * 真实迁移 + `infra/postgres/grants.sql`，skipped=0 硬断言）。开关/连接串与该运行器的另一个文件共用
 * `ARTICLE_PUBLISH_BATCH_*`；库名守卫要求以 `cps_novel_article_publish_batch_` 开头。
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PrismaClient } from "@prisma/client";
import { transformSync } from "esbuild";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { withdrawNovel } from "@/server/publish-gate/service";

import { NOW, issueAuthorization, newStores, seedAdmin } from "../../backend/publish-gate/test-support";
import {
  CONFIRM_PHRASE,
  LIST_HEADER,
  applyWithdrawals,
  main,
} from "../../../scripts/ops/withdraw-zero-chapter-novels-20261007";

// 按钮路径在事务提交后会做公开页缓存失效；测试里没有 Next 请求上下文，直接 mock 并计数。
// 脚本核心刻意不做这一步（见脚本头部注释），所以只有按钮那一本会计数。
const revalidateCalls = vi.hoisted(() => ({ set: 0 }));
vi.mock("@/server/publication/revalidate", () => ({
  revalidatePublicArticlePaths: vi.fn(),
  revalidatePublicArticleSet: vi.fn(() => {
    revalidateCalls.set += 1;
  }),
  revalidatePublicBlogPaths: vi.fn(),
}));

const enabled = process.env.ARTICLE_PUBLISH_BATCH_DATABASE_TEST === "1";
const ownerUrl = process.env.ARTICLE_PUBLISH_BATCH_OWNER_DATABASE_URL;
const webUrl = process.env.ARTICLE_PUBLISH_BATCH_WEB_DATABASE_URL;
const owner = new PrismaClient({ datasourceUrl: ownerUrl });
const web = new PrismaClient({ datasourceUrl: webUrl });

const execFileAsync = promisify(execFile);

const ACTOR_ID = "71f0e655-0640-4f07-bcbb-041f027fa7cb";
const PREFIX = "withdraw-zero-chapter-test";
const REASON = "  上游零章节，切换前下线  ";
const NORMALIZED_REASON = "上游零章节，切换前下线";
const SEED_TIME = new Date("2026-01-01T00:00:00.000Z");
const HEADER = LIST_HEADER.join("\t");

let workDir: string;
let foundation: { channelId: string; channelAppId: string; accountId: string; tagId: string };
let externalSequence = 5_000_000;

type Book = {
  readonly novelId: string;
  readonly articleId: string;
  readonly sourceItemId: string;
  readonly promoLinkId: string | null;
  readonly externalBookId: string;
  readonly title: string;
};

type BookSpec = {
  title?: string;
  novelStatus?: string;
  articleStatus?: string;
  totalChapterCount?: number;
  novelDeleted?: boolean;
  sourceDeleted?: boolean;
  articleDeleted?: boolean;
  /** 同一本书再挂的其它语种文章（unique(novel, locale)）。 */
  extraArticles?: Array<{ locale: string; status: string; deleted?: boolean }>;
  promo?: boolean;
  chapter?: boolean;
  tag?: boolean;
};

async function resetDatabase(): Promise<void> {
  const [{ name, version }] = await owner.$queryRaw<Array<{ name: string; version: string }>>`
    SELECT current_database() AS name, current_setting('server_version') AS version`;
  if (!name.startsWith("cps_novel_article_publish_batch_") || !version.startsWith("16.14")) {
    throw new Error(`Refusing withdraw-zero-chapter setup against ${name} (${version})`);
  }
  const tables = await owner.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await owner.$executeRawUnsafe(
    `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(",")} RESTART IDENTITY CASCADE`,
  );
  await owner.siteSetting.create({ data: { id: 1 } });
  const channel = await owner.channel.create({ data: { code: "changdu", name: "local" } });
  const sourceApp = await owner.sourceApp.create({ data: { code: "moboreader", name: "local" } });
  const channelApp = await owner.channelApp.create({
    data: { channelId: channel.id, sourceAppId: sourceApp.id, externalAppId: "local", projectType: 1 },
  });
  const account = await owner.channelAccount.create({
    data: { channelId: channel.id, businessId: randomUUID(), accountName: "local" },
  });
  const tag = await owner.canonicalTag.create({
    data: {
      stableId: "ct-v1-fixture",
      slug: "fixture",
      canonicalDefinition: "fixture",
      sortOrder: 1,
      taxonomyVersion: "fixture",
    },
  });
  // 脚本在 --apply 前会核对 --actor-id 在 admin_identity 里存在且 active。
  await owner.adminIdentity.create({
    data: {
      id: ACTOR_ID,
      username: "owner-fixture",
      passwordHash: `scrypt$v1$${"0".repeat(32)}`,
      role: "super_admin",
      status: "active",
    },
  });
  foundation = { channelId: channel.id, channelAppId: channelApp.id, accountId: account.id, tagId: tag.id };
}

function nextExternalBookId(): string {
  externalSequence += 1;
  return String(externalSequence);
}

/**
 * 一本书：书目 + 来源条目（章节数默认 0）+ 推广链接 + 已发布文章 +（可选）章节正文 + 标签。
 * 默认就是「名单里那种书」：已发布、零章节、已领到推广码。updated_at 固定在 SEED_TIME，
 * 这样「被写过」可以直接从 updated_at 前移看出来。
 */
async function seedBook(spec: BookSpec = {}): Promise<Book> {
  const key = randomUUID().replaceAll("-", "");
  const externalBookId = nextExternalBookId();
  const title = spec.title ?? `Zero Chapter Book ${externalBookId}`;
  const novel = await owner.novel.create({
    data: {
      businessId: `wz-${key}`,
      title,
      description: "fixture",
      locale: "en",
      slug: `wz-n-${key}`,
      status: spec.novelStatus ?? "published",
      totalChapterCount: spec.totalChapterCount ?? 0,
      deletedAt: spec.novelDeleted ? SEED_TIME : null,
      createdAt: SEED_TIME,
      updatedAt: SEED_TIME,
    },
  });
  const source = await owner.novelSourceItem.create({
    data: {
      channelAppId: foundation.channelAppId,
      novelId: novel.id,
      externalBookId,
      sourceLanguageCode: "2",
      title,
      description: "fixture",
      totalChapterCount: spec.totalChapterCount ?? 0,
      status: "linked",
      rawPayload: {},
      deletedAt: spec.sourceDeleted ? SEED_TIME : null,
      createdAt: SEED_TIME,
      updatedAt: SEED_TIME,
    },
  });
  const promo =
    spec.promo === false
      ? null
      : await owner.promoLink.create({
          data: {
            novelId: novel.id,
            novelSourceItemId: source.id,
            channelAppId: foundation.channelAppId,
            channelAccountId: foundation.accountId,
            offerType: "read",
            publicRedirectCode: `p${key.slice(0, 20)}`,
            idempotencyKey: key.padEnd(64, "0"),
            status: "fetched",
            webUrl: "https://local.example/read",
            createdAt: SEED_TIME,
            updatedAt: SEED_TIME,
          },
        });
  const articleBase = {
    novelId: novel.id,
    title,
    body: "fixture body",
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
  };
  const article = await owner.article.create({
    data: {
      ...articleBase,
      locale: "en",
      slug: `wz-a-${key}`,
      publicPageShortId: key.slice(0, 12),
      status: spec.articleStatus ?? "published",
      publishedAt: SEED_TIME,
      promoLinkId: promo?.id ?? null,
      deletedAt: spec.articleDeleted ? SEED_TIME : null,
    },
  });
  for (const [index, extra] of (spec.extraArticles ?? []).entries()) {
    await owner.article.create({
      data: {
        ...articleBase,
        locale: extra.locale,
        slug: `wz-a-${extra.locale}-${key}`,
        publicPageShortId: `x${index}${key.slice(2, 12)}`,
        status: extra.status,
        publishedAt: extra.status === "published" ? SEED_TIME : null,
        // article_published_promo_link_check：已发布的文章必须挂推广链接（同一本书的文章可共用一个）。
        promoLinkId: promo?.id ?? null,
        deletedAt: extra.deleted ? SEED_TIME : null,
      },
    });
  }
  if (spec.chapter !== false) {
    await owner.novelChapter.create({
      data: {
        novelId: novel.id,
        canonicalChapterNumber: 1,
        title: "chapter 1",
        status: "preview",
        createdAt: SEED_TIME,
        updatedAt: SEED_TIME,
        content: {
          create: {
            body: "chapter body",
            charCount: 12,
            contentHash: createHash("sha256").update(key).digest("hex"),
            materializedAt: SEED_TIME,
            createdAt: SEED_TIME,
            updatedAt: SEED_TIME,
          },
        },
      },
    });
  }
  if (spec.tag !== false) {
    await owner.novelCanonicalTag.create({
      data: {
        novelId: novel.id,
        canonicalTagId: foundation.tagId,
        source: "manual",
        decidedBy: ACTOR_ID,
        decidedAt: SEED_TIME,
        createdAt: SEED_TIME,
        updatedAt: SEED_TIME,
      },
    });
    await owner.novelTagState.create({ data: { novelId: novel.id, createdAt: SEED_TIME, updatedAt: SEED_TIME } });
  }
  return {
    novelId: novel.id,
    articleId: article.id,
    sourceItemId: source.id,
    promoLinkId: promo?.id ?? null,
    externalBookId,
    title,
  };
}

async function seedCandidates(count: number, spec: BookSpec = {}): Promise<Book[]> {
  const books: Book[] = [];
  for (let index = 0; index < count; index += 1) books.push(await seedBook(spec));
  return books;
}

type ListFile = { path: string; sha256: string };

async function writeList(books: readonly Book[], mutate: (lines: string[]) => string[] = (lines) => lines): Promise<ListFile> {
  const lines = mutate(
    books.map((book) =>
      [book.novelId, book.articleId, book.sourceItemId, book.externalBookId, "en", book.title].join("\t"),
    ),
  );
  const text = `${[HEADER, ...lines].join("\n")}\n`;
  const file = path.join(workDir, `list-${randomUUID()}.tsv`);
  await writeFile(file, text);
  return { path: file, sha256: createHash("sha256").update(text).digest("hex") };
}

function statsArgv(list: ListFile, extra: string[] = []): string[] {
  return ["--list", list.path, "--list-sha256-prefix", list.sha256.slice(0, 8), ...extra];
}

function applyArgv(
  list: ListFile,
  expectCount: number,
  over: { sha?: string; confirm?: string | null; prefix?: string; actor?: string; apply?: boolean } = {},
): string[] {
  const argv = [
    "--list", list.path,
    "--list-sha256-prefix", over.sha ?? list.sha256.slice(0, 8),
    "--expect-count", String(expectCount),
    "--reason", REASON,
    "--request-id-prefix", over.prefix ?? PREFIX,
    "--actor-id", over.actor ?? ACTOR_ID,
  ];
  if (over.apply !== false) argv.push("--apply");
  if (over.confirm !== null) argv.push("--confirm", over.confirm ?? CONFIRM_PHRASE);
  return argv;
}

type CliRun = { code: number; out: string[]; err: string[]; lines: Array<Record<string, unknown>> };

async function runCli(argv: string[], client: () => PrismaClient = () => new PrismaClient({ datasourceUrl: webUrl })): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { createPrismaClient: client, io: { out: (l) => out.push(l), err: (l) => err.push(l) } });
  const lines = out.flatMap((chunk) => {
    try {
      return [JSON.parse(chunk) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
  return { code, out, err, lines };
}

/** 整库快照：每张表（除 _prisma_migrations）的行数 + 整表内容摘要（含 updated_at），任何一处写入都会让它变。 */
async function fullSnapshot(): Promise<Record<string, string>> {
  const tables = await owner.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY tablename`;
  const snapshot: Record<string, string> = {};
  for (const { tablename } of tables) {
    const [row] = await owner.$queryRawUnsafe<Array<{ n: bigint; h: string }>>(
      `SELECT count(*) AS n, coalesce(md5(string_agg(t::text, E'\\n' ORDER BY t::text)), '') AS h FROM "${tablename}" t`,
    );
    snapshot[tablename] = `${row!.n}:${row!.h}`;
  }
  return snapshot;
}

const WRITTEN_BY_WITHDRAW = ["novel", "article", "operation_audit"];

function onlyWithdrawTablesChanged(before: Record<string, string>, after: Record<string, string>): string[] {
  return Object.keys(after).filter((table) => before[table] !== after[table]);
}

async function statusCounts(): Promise<{ novel: Record<string, number>; article: Record<string, number> }> {
  const [novels, articles] = await Promise.all([
    owner.novel.groupBy({ by: ["status"], _count: { _all: true } }),
    owner.article.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  return {
    novel: Object.fromEntries(novels.map((row) => [row.status, row._count._all])),
    article: Object.fromEntries(articles.map((row) => [row.status, row._count._all])),
  };
}

/** 名单外书目/文章的内容摘要（全部列，含 updated_at）。 */
async function outsideFingerprint(listedNovelIds: readonly string[]): Promise<string> {
  const listed = new Set(listedNovelIds);
  const novels = (await owner.novel.findMany({ orderBy: { id: "asc" } })).filter((novel) => !listed.has(novel.id));
  const articles = (await owner.article.findMany({ orderBy: { id: "asc" } })).filter(
    (article) => !article.novelId || !listed.has(article.novelId),
  );
  return createHash("sha256").update(JSON.stringify({ novels, articles })).digest("hex");
}

async function auditRows(novelId?: string) {
  return owner.operationAudit.findMany({
    where: novelId ? { entityId: novelId } : {},
    orderBy: { id: "asc" },
  });
}

type RowShape = Record<string, unknown>;

function without(row: RowShape, drop: readonly string[]): RowShape {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !drop.includes(key)));
}

describe.skipIf(!enabled)("withdraw-zero-chapter-novels script against real PostgreSQL (web_app)", () => {
  beforeAll(async () => {
    workDir = await mkdtemp(path.join(os.tmpdir(), "withdraw-zero-chapter-"));
  });

  beforeEach(async () => {
    await resetDatabase();
    revalidateCalls.set = 0;
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
    await owner.$disconnect();
    await web.$disconnect();
  });

  it("matches the admin button (withdrawNovel) field by field: novel, articles, audit row", async () => {
    // 两本条件完全相同的书：都有两篇额外文章（草稿 ja 不应被撤回；已软删的已发布 de 也不应被撤回）、
    // 推广链接、章节正文、标签。一本走按钮的服务函数，一本走脚本核心。
    const spec: BookSpec = {
      title: "Zero Chapter Parity Book",
      extraArticles: [
        { locale: "ja", status: "draft" },
        { locale: "de", status: "published", deleted: true },
      ],
    };
    const buttonBook = await seedBook(spec);
    const scriptBook = await seedBook(spec);
    const untouchedBefore = await fullSnapshot();

    const stores = newStores();
    const admin = seedAdmin(stores, { identityId: ACTOR_ID });
    const { authorization, requestId } = await issueAuthorization(stores, "admin.novel.withdraw", admin.token);
    const buttonResult = await withdrawNovel(
      { authorization, requestId, novelId: buttonBook.novelId, reason: REASON },
      { db: web, identities: stores, sessions: stores, now: NOW },
    );
    const script = await applyWithdrawals(web, {
      novelIds: [scriptBook.novelId],
      requestIdPrefix: PREFIX,
      actorId: ACTOR_ID,
      reason: REASON,
    });

    // 返回值
    expect(buttonResult.novelStatus).toBe("unpublished");
    expect(script.results).toHaveLength(1);
    expect(script.results[0]).toMatchObject({ outcome: "withdrawn", errorCategory: null });
    expect(script.results[0]!.affectedArticleCount).toBe(buttonResult.affectedArticleIds.length);
    expect(buttonResult.affectedArticleIds).toHaveLength(1);
    // 按钮路径提交后做了一次缓存失效；脚本刻意不做。
    expect(revalidateCalls.set).toBe(1);

    // 书目：除天然不同的 id / business_id / slug / created_at 外全部列一致；updated_at 都前移了。
    const novelDrop = ["id", "businessId", "slug", "createdAt", "updatedAt"];
    const [buttonNovel, scriptNovel] = await Promise.all([
      owner.novel.findUniqueOrThrow({ where: { id: buttonBook.novelId } }),
      owner.novel.findUniqueOrThrow({ where: { id: scriptBook.novelId } }),
    ]);
    expect(without(scriptNovel, novelDrop)).toEqual(without(buttonNovel, novelDrop));
    expect(scriptNovel.status).toBe("unpublished");
    expect(buttonNovel.updatedAt.getTime()).toBeGreaterThan(SEED_TIME.getTime());
    expect(scriptNovel.updatedAt.getTime()).toBeGreaterThan(SEED_TIME.getTime());

    // 文章：逐语种对比。已发布 → unpublished 且 updated_at 前移；草稿/已软删的已发布文章原样不动。
    const articleDrop = ["id", "novelId", "slug", "publicPageShortId", "promoLinkId", "createdAt", "updatedAt"];
    const [buttonArticles, scriptArticles] = await Promise.all([
      owner.article.findMany({ where: { novelId: buttonBook.novelId }, orderBy: { locale: "asc" } }),
      owner.article.findMany({ where: { novelId: scriptBook.novelId }, orderBy: { locale: "asc" } }),
    ]);
    expect(scriptArticles.map((a) => without(a, articleDrop))).toEqual(buttonArticles.map((a) => without(a, articleDrop)));
    expect(scriptArticles.map((a) => [a.locale, a.status, a.deletedAt !== null])).toEqual([
      ["de", "published", true],
      ["en", "unpublished", false],
      ["ja", "draft", false],
    ]);
    for (const [index, article] of scriptArticles.entries()) {
      const moved = article.updatedAt.getTime() > SEED_TIME.getTime();
      expect(moved).toBe(buttonArticles[index]!.updatedAt.getTime() > SEED_TIME.getTime());
      expect(moved).toBe(article.locale === "en");
    }

    // 审计：各一条；除 id / entity_id / request_id / created_at 外每个字段一致。
    const [buttonAudits, scriptAudits] = await Promise.all([auditRows(buttonBook.novelId), auditRows(scriptBook.novelId)]);
    expect(buttonAudits).toHaveLength(1);
    expect(scriptAudits).toHaveLength(1);
    const auditDrop = ["id", "entityId", "requestId", "createdAt"];
    expect(without(scriptAudits[0]!, auditDrop)).toEqual(without(buttonAudits[0]!, auditDrop));
    expect(scriptAudits[0]).toMatchObject({
      actorType: "admin",
      actorId: ACTOR_ID,
      action: "novel.withdraw",
      entityType: "Novel",
      entityId: scriptBook.novelId,
      requestId: `${PREFIX}:${scriptBook.novelId}`,
      reason: NORMALIZED_REASON,
      taskType: null,
      taskId: null,
      beforeSnapshot: { novelStatus: "published" },
      afterSnapshot: { novelStatus: "unpublished" },
    });
    expect(buttonAudits[0]!.requestId).toBe(requestId);
    expect(scriptAudits[0]!.createdAt).toBeInstanceOf(Date);
    expect(await auditRows()).toHaveLength(2);

    // 其余所有表（推广链接、章节正文、标签、任务……）前后完全一致。
    const after = await fullSnapshot();
    expect(onlyWithdrawTablesChanged(untouchedBefore, after).sort()).toEqual([...WRITTEN_BY_WITHDRAW].sort());
  });

  it("is idempotent: re-running with the same prefix replays, writes nothing and keeps the audit count", async () => {
    const books = await seedCandidates(3, { extraArticles: [{ locale: "ja", status: "draft" }] });
    const list = await writeList(books);

    const first = await runCli(applyArgv(list, 3));
    expect(first.code).toBe(0);
    expect(first.lines.at(-1)).toMatchObject({ type: "summary", total: 3, withdrawn: 3, replayed: 0, failed: 0 });
    expect(await auditRows()).toHaveLength(3);
    const afterFirst = await fullSnapshot();

    // 整条命令行用同一个前缀重跑：前置条件把「本前缀已撤回」算进名单范围，所以不会被拒。
    const second = await runCli(applyArgv(list, 3));
    expect(second.code).toBe(0);
    const novelLines = second.lines.filter((line) => line.type === "novel");
    expect(novelLines.map((line) => line.outcome)).toEqual(["replayed", "replayed", "replayed"]);
    expect(second.lines.at(-1)).toMatchObject({ type: "summary", total: 3, withdrawn: 0, replayed: 3, failed: 0 });
    expect(await auditRows()).toHaveLength(3);
    expect(await fullSnapshot()).toEqual(afterFirst);

    // 直接调核心函数同样回放：回放时受影响文章数 = 该书全部未软删文章（与按钮路径的回放分支一致）。
    const replay = await applyWithdrawals(web, {
      novelIds: books.map((book) => book.novelId),
      requestIdPrefix: PREFIX,
      actorId: ACTOR_ID,
      reason: REASON,
    });
    expect(replay.results.map((result) => [result.outcome, result.affectedArticleCount])).toEqual([
      ["replayed", 2],
      ["replayed", 2],
      ["replayed", 2],
    ]);
    expect(await fullSnapshot()).toEqual(afterFirst);

    // 换一个前缀 = 另一次操作：这些书已不满足下线条件、也没有该前缀的审计，前置条件拒绝，仍然零写入。
    const otherPrefix = await runCli(applyArgv(list, 3, { prefix: `${PREFIX}-other` }));
    expect(otherPrefix.code).toBe(1);
    expect(otherPrefix.lines.at(-1)).toMatchObject({ type: "refused" });
    expect(await fullSnapshot()).toEqual(afterFirst);
  });

  describe("preconditions refuse to execute and leave the database untouched", () => {
    async function expectRefused(argv: string[], expectedFailure: string, client?: () => PrismaClient): Promise<CliRun> {
      const before = await fullSnapshot();
      const run = await runCli(argv, client);
      expect(run.code).toBe(1);
      const refused = run.lines.find((line) => line.type === "refused");
      expect(refused).toBeDefined();
      expect(refused!.failures).toContain(expectedFailure);
      expect(run.lines.some((line) => line.type === "novel" || line.type === "summary")).toBe(false);
      expect(await fullSnapshot()).toEqual(before);
      expect(await auditRows()).toHaveLength(0);
      return run;
    }

    it("SHA-256 prefix mismatch", async () => {
      const books = await seedCandidates(3);
      const list = await writeList(books);
      await expectRefused(applyArgv(list, 3, { sha: "deadbeef" }), "listSha256PrefixMatches");
    });

    it("--expect-count differs from the list size / the re-queried size", async () => {
      const books = await seedCandidates(3);
      const list = await writeList(books);
      const run = await expectRefused(applyArgv(list, 4), "expectCountEqualsListCount");
      expect(run.lines.find((line) => line.type === "refused")!.failures).toContain("expectCountEqualsQueryCount");
    });

    it("list has a book the database no longer matches (not published)", async () => {
      const books = await seedCandidates(3);
      const draft = await seedBook({ novelStatus: "draft", articleStatus: "draft" });
      const list = await writeList([...books, draft]);
      const run = await expectRefused(applyArgv(list, 4), "listAndQuerySetsEqual");
      expect(run.lines.find((line) => line.type === "refused")!.inListNotInQuery).toEqual([draft.novelId]);
    });

    it("database has a matching book the list does not contain", async () => {
      const books = await seedCandidates(3);
      const extra = await seedBook();
      const list = await writeList(books);
      const run = await expectRefused(applyArgv(list, 3), "listAndQuerySetsEqual");
      expect(run.lines.find((line) => line.type === "refused")!.inQueryNotInList).toEqual([extra.novelId]);
    });

    it("the same book maps to a different article id than the list says", async () => {
      const books = await seedCandidates(3);
      const list = await writeList(books, (lines) =>
        lines.map((line, index) => (index === 0 ? line.replace(books[0]!.articleId, randomUUID()) : line)),
      );
      const run = await expectRefused(applyArgv(list, 3), "listAndQuerySetsEqual");
      expect(run.lines.find((line) => line.type === "refused")!.articleMismatches).toHaveLength(1);
    });

    it("a book with a second published article is not a one-row-per-book scope", async () => {
      const books = await seedCandidates(2);
      const wide = await seedBook({ extraArticles: [{ locale: "ja", status: "published" }] });
      const list = await writeList([...books, wide]);
      const run = await expectRefused(applyArgv(list, 3), "queryHasOneRowPerNovel");
      expect(run.lines.find((line) => line.type === "refused")!.checks).toMatchObject({ queryHasOneRowPerNovel: false });
    });

    it("wrong confirmation phrase", async () => {
      const books = await seedCandidates(3);
      const list = await writeList(books);
      await expectRefused(applyArgv(list, 3, { confirm: "withdraw-zero-chapter-novels" }), "confirmPhraseMatches");
    });

    it("--actor-id is not an active admin identity", async () => {
      const books = await seedCandidates(3);
      const list = await writeList(books);
      await expectRefused(applyArgv(list, 3, { actor: randomUUID() }), "actorIsActiveAdminIdentity");
      await owner.adminIdentity.update({ where: { id: ACTOR_ID }, data: { status: "disabled" } });
      await expectRefused(applyArgv(list, 3), "actorIsActiveAdminIdentity");
    });

    it("the connection is not the web_app role", async () => {
      const books = await seedCandidates(3);
      const list = await writeList(books);
      await expectRefused(applyArgv(list, 3), "databaseRoleIsWebApp", () => new PrismaClient({ datasourceUrl: ownerUrl }));
    });

    it("a missing --confirm is a usage error (exit 2) and writes nothing", async () => {
      const books = await seedCandidates(3);
      const list = await writeList(books);
      const before = await fullSnapshot();
      const run = await runCli(applyArgv(list, 3, { confirm: null }));
      expect(run.code).toBe(2);
      expect(await fullSnapshot()).toEqual(before);
    });
  });

  it("does not overstep: only the listed novels/articles change; everything else is byte-identical", async () => {
    const listed = await seedCandidates(4, { extraArticles: [{ locale: "ja", status: "draft" }] });
    // 名单外的各种「长得像」的书：都有推广链接、章节正文、标签。
    await seedBook({ totalChapterCount: 12 });
    await seedBook({ novelStatus: "draft", articleStatus: "draft" });
    await seedBook({ novelStatus: "unpublished", articleStatus: "unpublished" });
    await seedBook({ novelStatus: "takedown", articleStatus: "takedown" });
    await seedBook({ sourceDeleted: true });
    await seedBook({ articleDeleted: true });
    await seedBook({ novelDeleted: true });
    await seedBook({ novelStatus: "ready", articleStatus: "draft", promo: false, chapter: false, tag: false });
    const list = await writeList(listed);
    const listedIds = listed.map((book) => book.novelId);

    const snapshotBefore = await fullSnapshot();
    const outsideBefore = await outsideFingerprint(listedIds);
    const countsBefore = await statusCounts();

    const run = await runCli(applyArgv(list, 4));
    expect(run.code).toBe(0);
    expect(run.lines.at(-1)).toMatchObject({ type: "summary", total: 4, withdrawn: 4, replayed: 0, failed: 0, articlesWithdrawn: 4 });

    const snapshotAfter = await fullSnapshot();
    // 推广链接、章节、章节正文、标签、任务、站点地图任务……所有表：除 novel/article/operation_audit 外一行不变。
    expect(onlyWithdrawTablesChanged(snapshotBefore, snapshotAfter).sort()).toEqual([...WRITTEN_BY_WITHDRAW].sort());
    for (const table of ["promo_link", "novel_chapter", "novel_chapter_content", "novel_canonical_tag", "novel_tag_state", "generic_task", "channel_sync_task", "novel_source_item"]) {
      expect(snapshotAfter[table], table).toBe(snapshotBefore[table]);
    }
    // 名单外的书目与文章：全部列（含 updated_at）一字不差。
    expect(await outsideFingerprint(listedIds)).toBe(outsideBefore);
    // 状态分布：恰好 4 本 published → unpublished（书目），4 篇文章同样。
    const countsAfter = await statusCounts();
    expect(countsAfter.novel).toEqual({ ...countsBefore.novel, published: countsBefore.novel.published! - 4, unpublished: countsBefore.novel.unpublished! + 4 });
    expect(countsAfter.article).toEqual({ ...countsBefore.article, published: countsBefore.article.published! - 4, unpublished: countsBefore.article.unpublished! + 4 });
    // 名单内：书目与（已发布的）文章 unpublished，草稿文章不动；审计恰好 4 条且都在名单里。
    expect((await owner.novel.findMany({ where: { id: { in: listedIds } } })).map((n) => n.status)).toEqual(["unpublished", "unpublished", "unpublished", "unpublished"]);
    expect((await owner.article.findMany({ where: { novelId: { in: listedIds }, locale: "ja" } })).map((a) => a.status)).toEqual(["draft", "draft", "draft", "draft"]);
    const audits = await auditRows();
    expect(audits).toHaveLength(4);
    expect(audits.map((a) => a.entityId).sort()).toEqual([...listedIds].sort());
  });

  it("a single failing book is recorded and does not stop the others; the summary adds up", async () => {
    const [ok1, ok2] = await seedCandidates(2);
    const alreadyUnpublished = await seedBook({ novelStatus: "unpublished", articleStatus: "unpublished" });
    const softDeleted = await seedBook({ novelDeleted: true });
    const failedBefore = await outsideFingerprint([ok1!.novelId, ok2!.novelId]);

    const seen: string[] = [];
    const { results, summary } = await applyWithdrawals(web, {
      novelIds: [ok1!.novelId, alreadyUnpublished.novelId, softDeleted.novelId, ok2!.novelId],
      requestIdPrefix: PREFIX,
      actorId: ACTOR_ID,
      reason: REASON,
      onResult: (result) => seen.push(result.outcome),
    });

    expect(seen).toEqual(["withdrawn", "failed", "failed", "withdrawn"]);
    expect(results.map((result) => [result.outcome, result.errorCategory])).toEqual([
      ["withdrawn", null],
      ["failed", "novel_not_currently_published"],
      ["failed", "novel_not_found"],
      ["withdrawn", null],
    ]);
    expect(summary).toMatchObject({
      total: 4,
      withdrawn: 2,
      replayed: 0,
      failed: 2,
      articlesWithdrawn: 2,
      failedByCategory: { novel_not_currently_published: 1, novel_not_found: 1 },
      failedNovelIds: [alreadyUnpublished.novelId, softDeleted.novelId],
    });
    expect((await auditRows()).map((a) => a.entityId).sort()).toEqual([ok1!.novelId, ok2!.novelId].sort());
    // 失败的两本（以及其余名单外的书）原样不动。
    expect(await outsideFingerprint([ok1!.novelId, ok2!.novelId])).toBe(failedBefore);
  });

  it("a failure inside the transaction rolls that book back completely; the CLI reports it and exits 3", async () => {
    const [first, second, third] = await seedCandidates(3);
    const list = await writeList([first!, second!, third!]);
    // 预置一条「别的书」占用了第二本的 requestId 的审计行：前置条件看不出（entity_id 不是这本书），
    // 幂等守卫也不命中，事务内 create 审计时撞 (request_id, action) 唯一约束 → 整本回滚。
    await owner.operationAudit.create({
      data: {
        actorType: "admin",
        actorId: ACTOR_ID,
        action: "novel.withdraw",
        entityType: "Novel",
        entityId: randomUUID(),
        requestId: `${PREFIX}:${second!.novelId}`,
        reason: "squatter",
      },
    });

    const run = await runCli(applyArgv(list, 3));
    expect(run.code).toBe(3);
    const novelLines = run.lines.filter((line) => line.type === "novel");
    expect(novelLines.map((line) => [line.novelId, line.outcome, line.errorCategory])).toEqual([
      [first!.novelId, "withdrawn", null],
      [second!.novelId, "failed", "unique_violation"],
      [third!.novelId, "withdrawn", null],
    ]);
    expect(run.lines.at(-1)).toMatchObject({
      type: "summary",
      total: 3,
      withdrawn: 2,
      failed: 1,
      failedByCategory: { unique_violation: 1 },
      failedNovelIds: [second!.novelId],
    });
    // 书目、文章状态改动与审计在同一个事务里：失败的那本没有留下半截状态。
    const secondNovel = await owner.novel.findUniqueOrThrow({ where: { id: second!.novelId } });
    const secondArticle = await owner.article.findUniqueOrThrow({ where: { id: second!.articleId } });
    expect([secondNovel.status, secondArticle.status]).toEqual(["published", "published"]);
    expect(secondNovel.updatedAt.getTime()).toBe(SEED_TIME.getTime());
    expect(secondArticle.updatedAt.getTime()).toBe(SEED_TIME.getTime());
  });

  describe("the default (no --apply) is strictly read-only", () => {
    it("prints the statistics and leaves the whole database identical, even with every other flag supplied", async () => {
      const books = await seedCandidates(3, { extraArticles: [{ locale: "ja", status: "draft" }] });
      await seedBook({ totalChapterCount: 7 });
      await seedBook({ novelStatus: "draft", articleStatus: "draft" });
      const list = await writeList(books);
      const before = await fullSnapshot();

      const stats = await runCli(statsArgv(list, ["--expect-count", "3"]));
      expect(stats.code).toBe(0);
      expect(stats.lines).toHaveLength(1);
      const report = stats.lines[0] as Record<string, any>;
      expect(report).toMatchObject({
        type: "stats",
        mode: "read_only",
        databaseRole: "web_app",
        list: { sha256: list.sha256, sha256Prefix8: list.sha256.slice(0, 8), rowCount: 3 },
        query: { rowCount: 3, distinctNovels: 3 },
        inListNotInQuery: [],
        inQueryNotInList: [],
        articleMismatches: [],
        statusCounts: { novel: { published: 3 }, article: { draft: 3, published: 3 } },
        localeDistribution: { list: { en: 3 }, query: { en: 3 } },
        failures: [],
      });
      expect(report.checks).toMatchObject({
        listSha256PrefixMatches: true,
        expectCountEqualsListCount: true,
        expectCountEqualsQueryCount: true,
        listAndQuerySetsEqual: true,
        confirmPhraseMatches: null,
      });
      expect(report.novels).toHaveLength(3);
      expect(report.novels[0]).toMatchObject({
        novelId: books[0]!.novelId,
        novelStatus: "published",
        novelDeleted: false,
        articles: [
          { articleId: books[0]!.articleId, locale: "en", status: "published", deleted: false },
          { locale: "ja", status: "draft", deleted: false },
        ],
      });
      expect(await fullSnapshot()).toEqual(before);

      // 就算把执行用的其它参数（原因/前缀/操作人/确认短语）全给齐，只要没有 --apply 就仍然只读。
      const allButApply = await runCli(applyArgv(list, 3, { apply: false }));
      expect(allButApply.code).toBe(0);
      expect(allButApply.lines[0]).toMatchObject({ type: "stats", mode: "read_only" });
      expect(await fullSnapshot()).toEqual(before);
      expect(await auditRows()).toHaveLength(0);
    });

    it("reports a list/database mismatch (exit 1) without writing", async () => {
      const books = await seedCandidates(3);
      const draft = await seedBook({ novelStatus: "draft", articleStatus: "draft" });
      const extra = await seedBook();
      const list = await writeList([...books, draft]);
      const before = await fullSnapshot();

      const run = await runCli(statsArgv(list, ["--expect-count", "4"]));
      expect(run.code).toBe(1);
      const report = run.lines[0] as Record<string, any>;
      expect(report.inListNotInQuery).toEqual([draft.novelId]);
      expect(report.inQueryNotInList).toEqual([extra.novelId]);
      expect(report.failures).toContain("listAndQuerySetsEqual");
      expect(report.checks.expectCountEqualsListCount).toBe(true);
      expect(await fullSnapshot()).toEqual(before);
    });

    it("run with --request-id-prefix, tells which listed novels a previous run already withdrew", async () => {
      const books = await seedCandidates(3);
      const list = await writeList(books);
      await runCli(applyArgv(list, 3));
      const before = await fullSnapshot();

      const stats = await runCli(statsArgv(list, ["--expect-count", "3", "--request-id-prefix", PREFIX]));
      expect(stats.code).toBe(0);
      expect(stats.lines[0]).toMatchObject({
        query: { rowCount: 0 },
        alreadyWithdrawnUnderPrefix: { checked: true, novelIds: books.map((b) => b.novelId).sort() },
        failures: [],
      });
      expect(await fullSnapshot()).toEqual(before);
    });
  });

  it("runs as a standalone compiled file outside the repo (createRequire, auto-run, exit code) with DATABASE_URL only", async () => {
    // tsx 在容器里 /tmp 下把这个 .ts 当 CJS 编译；这里用同一个编译器（esbuild）得到 CJS，拷到仓库外、
    // 以仓库根为 cwd 运行：证明脚本不依赖仓库内任何相对/别名 import，@prisma/client 靠 createRequire 解析。
    const source = await readFile(path.resolve(process.cwd(), "scripts/ops/withdraw-zero-chapter-novels-20261007.ts"), "utf8");
    const compiled = transformSync(source, { loader: "ts", format: "cjs", target: "node20" }).code;
    const standalone = path.join(workDir, "withdraw-zero-chapter-novels-20261007.cjs");
    await writeFile(standalone, compiled);

    const books = await seedCandidates(2);
    const list = await writeList(books);
    const env = { NODE_ENV: "test", PATH: process.env.PATH ?? "", DATABASE_URL: webUrl ?? "" } satisfies NodeJS.ProcessEnv;
    const run = (argv: string[]) =>
      execFileAsync(process.execPath, [standalone, ...argv], { cwd: process.cwd(), env }).then(
        ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
        (error: { code?: number; stdout?: string; stderr?: string }) => ({ code: error.code ?? -1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }),
      );

    const before = await fullSnapshot();
    const stats = await run(statsArgv(list, ["--expect-count", "2"]));
    expect(stats.code, stats.stderr).toBe(0);
    expect(JSON.parse(stats.stdout)).toMatchObject({ type: "stats", databaseRole: "web_app", query: { rowCount: 2 }, failures: [] });
    expect(await fullSnapshot()).toEqual(before);

    const refused = await run(applyArgv(list, 2, { confirm: "nope" }));
    expect(refused.code).toBe(1);
    expect(await fullSnapshot()).toEqual(before);

    const applied = await run(applyArgv(list, 2));
    expect(applied.code, applied.stderr).toBe(0);
    const lines = applied.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => line.type)).toEqual(["preflight", "novel", "novel", "summary"]);
    expect(lines.at(-1)).toMatchObject({ withdrawn: 2, failed: 0 });
    expect((await owner.novel.findMany({ where: { id: { in: books.map((b) => b.novelId) } } })).map((n) => n.status)).toEqual(["unpublished", "unpublished"]);

    const usage = await run(["--list"]);
    expect(usage.code).toBe(2);
  });
});
