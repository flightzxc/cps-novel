/**
 * B-21：自动标签"建任务"内存峰值的可复现测量，以及修改前后的等价性对拍。
 *
 * 背景（待办登记 B-21）：给一个语种建定类任务时，旧实现把该语种所有书的快照
 * 一次性读进内存，再在一个事务里一次性嵌套 createMany 全部条目。生产英文
 * 43,431 本在 2 GiB 的 web 容器里被杀过一次。本脚本用本地一次性 PostgreSQL
 * 造出同规模数据，在**独立子进程**里调用 createTaggingAutoClassifyTask 并读取
 * 进程自己的 RSS 峰值（`process.resourceUsage().maxRSS`，含 Prisma 原生引擎的
 * 原生内存，这正是容器 cgroup 实际计的那部分，不是 JS 堆）。
 *
 * 三个子命令（都读 `DATABASE_URL`；seed/compare 需要 owner 角色，measure 用
 * web_app 即可，与生产回填工具同角色）：
 *
 *   seed     造数。--locale en --count 43431 [--seed 1] [--desc-median-chars 700]
 *            [--manual-ratio 0.02] [--tagged-ratio 0.3]
 *            每本书带一条 linked 的来源条目（与生产形态一致，快照读取会预载它与
 *            channelApp）。manual-ratio 的书写 NovelTagState.mode=manual；
 *            tagged-ratio 的书带一条 TagClassificationRun 并指向 currentAutoRunId，
 *            用来覆盖 initialize_missing / reclassify_existing 的过滤差异。
 *
 *   measure  测一次建任务的 RSS 峰值，输出一行 JSON。
 *            --locale en --lifecycle reclassify_existing --request-id <id>
 *            [--impl current|legacy]   legacy = scripts/lib/tagging-legacy-task-creation.ts
 *            里冻结的 6bc6a11 老实现（原在 tests/ 下；v0.5.7 起搬到 scripts/lib，
 *            因为 tests/ 不进 Docker 构建上下文而本脚本会被 next build 类型检查）。
 *            每次测量前请先清空 generic_task（同一范围的活动任务有唯一索引）。
 *
 *   compare  在同一份数据上先跑 legacy、再跑 current，逐条比较任务行、条目集合
 *            （按 targetId 排序，去掉随机的 item id 与 classificationRequestId，
 *            但会校验它们仍满足 fingerprint({taskItemId, novelId}) 的派生关系）
 *            与审计行。--locale es --lifecycle initialize_missing。
 *            不一致时以退出码 1 结束。
 *
 * 一键编排（起一次性 PG、造 es/fr/en 规模数据、前后对比测量、等价性对拍、清理）：
 *   npm run measure:tagging-task-memory
 *   即 scripts/measure-tagging-task-memory.sh
 *
 * 只相对导入 ../src/...（不用 @/ 别名之外的东西）：与 scripts/ 下其它脚本同一惯例。
 */
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { PrismaClient, type Prisma } from "@prisma/client";

import { CANONICAL_TAG_V1_SHA256, validateKeywordRuleArtifact } from "../src/lib/tagging/keyword-artifact";
import { fingerprint, stableStringify } from "../src/lib/tagging/stable-json";
import {
  createTaggingAutoClassifyTask,
  type CreateTaggingAutoClassifyTaskInput,
  type TaggingTaskCreationResult,
} from "../src/server/tagging/tasks";

type Impl = "current" | "legacy";
type Lifecycle = "initialize_missing" | "reclassify_existing";

const MIB = 1024 * 1024;
const MEASURE_APP_CODE = "b21-measure";

// ---------------------------------------------------------------------------
// argv helpers
// ---------------------------------------------------------------------------

function option(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function requireOption(argv: readonly string[], flag: string): string {
  const value = option(argv, flag);
  if (value === undefined) throw new Error(`${flag} is required`);
  return value;
}

function numberOption(argv: readonly string[], flag: string, fallback: number): number {
  const raw = option(argv, flag);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} must be a non-negative number`);
  return value;
}

function lifecycleOption(argv: readonly string[]): Lifecycle {
  const value = option(argv, "--lifecycle") ?? "reclassify_existing";
  if (value !== "initialize_missing" && value !== "reclassify_existing") throw new Error("--lifecycle must be initialize_missing or reclassify_existing");
  return value;
}

// ---------------------------------------------------------------------------
// 造数：确定性 PRNG + 贴近真实的简介长度分布
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYLLABLES = ["ba", "ra", "lo", "mi", "shen", "tor", "and", "el", "ven", "dar", "ki", "su", "or", "in", "the", "wa", "len", "cor", "fi", "ne", "ma", "ro", "ta", "lis", "ver", "an"];

function makeVocabulary(rng: () => number, size: number): string[] {
  const words = new Set<string>();
  while (words.size < size) {
    const parts = 1 + Math.floor(rng() * 3);
    let word = "";
    for (let i = 0; i < parts; i += 1) word += SYLLABLES[Math.floor(rng() * SYLLABLES.length)];
    words.add(word);
  }
  return [...words];
}

/** 对数正态：中位数 median，sigma 0.7，截到 [60, 8000] 个字符。 */
function targetLength(rng: () => number, median: number): number {
  const u1 = Math.max(rng(), 1e-9);
  const u2 = rng();
  const gaussian = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.min(8000, Math.max(60, Math.round(median * Math.exp(0.7 * gaussian))));
}

function makeDescription(rng: () => number, vocabulary: readonly string[], chars: number): string {
  const sentences: string[] = [];
  let length = 0;
  while (length < chars) {
    const wordCount = 8 + Math.floor(rng() * 13);
    const words: string[] = [];
    for (let i = 0; i < wordCount; i += 1) words.push(vocabulary[Math.floor(rng() * vocabulary.length)]);
    const sentence = `${words.join(" ")}.`;
    sentences.push(sentence[0].toUpperCase() + sentence.slice(1));
    length += sentence.length + 1;
    if (rng() < 0.12) sentences.push("\n\n");
  }
  return sentences.join(" ").replace(/ \n\n /g, "\n\n").slice(0, chars);
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function ensureMeasureApp(db: PrismaClient): Promise<string> {
  const channel = await db.channel.upsert({ where: { code: MEASURE_APP_CODE }, update: {}, create: { code: MEASURE_APP_CODE, name: "B-21 measure" } });
  const sourceApp = await db.sourceApp.upsert({ where: { code: MEASURE_APP_CODE }, update: {}, create: { code: MEASURE_APP_CODE, name: "B-21 measure" } });
  const existing = await db.channelApp.findFirst({ where: { channelId: channel.id, sourceAppId: sourceApp.id, externalAppId: MEASURE_APP_CODE } });
  if (existing) return existing.id;
  const created = await db.channelApp.create({ data: {
    channelId: channel.id, sourceAppId: sourceApp.id, externalAppId: MEASURE_APP_CODE, projectType: 2, status: "active",
  } });
  return created.id;
}

export interface SeedOptions {
  locale: string;
  count: number;
  seed: number;
  descMedianChars: number;
  manualRatio: number;
  taggedRatio: number;
}

export async function seedLocale(db: PrismaClient, options: SeedOptions): Promise<{ novels: number; avgDescriptionChars: number }> {
  const channelAppId = await ensureMeasureApp(db);
  const rng = mulberry32(options.seed ^ [...options.locale].reduce((acc, ch) => acc * 31 + ch.charCodeAt(0), 7));
  const vocabulary = makeVocabulary(rng, 3000);
  const hash = createHash("sha256").update(`b21:${options.locale}`).digest("hex");
  let totalChars = 0;
  for (const batchIndexes of chunked(Array.from({ length: options.count }, (_, i) => i), 2000)) {
    const novels: Prisma.NovelCreateManyInput[] = [];
    const sources: Prisma.NovelSourceItemCreateManyInput[] = [];
    const runs: Prisma.TagClassificationRunCreateManyInput[] = [];
    const states: Prisma.NovelTagStateCreateManyInput[] = [];
    for (const index of batchIndexes) {
      const id = randomUUID();
      const title = `${vocabulary[Math.floor(rng() * vocabulary.length)]} ${vocabulary[Math.floor(rng() * vocabulary.length)]} ${index}`;
      const description = makeDescription(rng, vocabulary, targetLength(rng, options.descMedianChars));
      totalChars += description.length;
      novels.push({ id, businessId: `b21-${options.locale}-${id}`, title, description, locale: options.locale, slug: `b21-${options.locale}-${id}`, status: "draft" });
      sources.push({
        id: randomUUID(), channelAppId, novelId: id, externalBookId: `b21-${options.locale}-${id}`, sourceLanguageCode: "2",
        sourceLanguageName: options.locale, sourceLocale: options.locale, rawLanguageScope: `b21:${options.locale}`,
        title, description, status: "linked", rawPayload: { language: 2, seriesName: title },
      });
      const roll = rng();
      if (roll < options.manualRatio) {
        states.push({ novelId: id, mode: "manual" });
      } else if (roll < options.manualRatio + options.taggedRatio) {
        const runId = randomUUID();
        runs.push({
          id: runId, novelId: id, method: "deterministic_text", taxonomyVersion: "b21", taxonomySha256: hash,
          keywordLexiconVersion: "b21", keywordFingerprint: hash, classifierConfigVersion: "b21", classifierConfigFingerprint: hash,
          contentSha256: hash, requestId: `b21-seed-${id}`,
        });
        states.push({ novelId: id, mode: "automatic", currentAutoRunId: runId });
      }
    }
    await db.novel.createMany({ data: novels });
    await db.novelSourceItem.createMany({ data: sources });
    if (runs.length > 0) await db.tagClassificationRun.createMany({ data: runs });
    if (states.length > 0) await db.novelTagState.createMany({ data: states });
  }
  return { novels: options.count, avgDescriptionChars: Math.round(totalChars / Math.max(1, options.count)) };
}

// ---------------------------------------------------------------------------
// 建任务：current / legacy 两种实现共用同一份输入
// ---------------------------------------------------------------------------

// 固定 id：artifact 指纹会进任务的 authority，随机 id 会让两次建任务的指纹天然不同。
const MEASURE_ARTIFACT_TAG_ID = "00000000-0000-4000-8000-0000000b2101";

function measureArtifact() {
  return validateKeywordRuleArtifact({
    schemaVersion: 1,
    taxonomyVersion: "v1",
    taxonomySha256: CANONICAL_TAG_V1_SHA256,
    keywordLexiconVersion: "b21-measure-lexicon",
    tags: [{
      canonicalTagId: MEASURE_ARTIFACT_TAG_ID, stableId: "ct-v1-alpha", textSelectionPriority: 0,
      keywords: [{ keywordId: "kw-alpha", value: "alpha", scriptBuckets: ["latin"], matchMode: "unicode_word", riskFlags: [] }],
    }],
  });
}

const OPEN_GATES_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  FEATURE_P2_06_5_TAGGING: "true",
  FEATURE_NOVEL_TAG_AUTO: "true",
  AUTO_WRITE_AUTHORIZED: "YES",
};

export function createInput(db: PrismaClient, locale: string, lifecycle: Lifecycle, requestId: string): CreateTaggingAutoClassifyTaskInput {
  return {
    db, lifecycle, mode: "apply", scope: { kind: "locale", locale }, requestId, env: OPEN_GATES_ENV,
    dependencies: { artifact: measureArtifact(), enforceCanonicalV1: false },
  };
}

async function loadImpl(impl: Impl): Promise<(input: CreateTaggingAutoClassifyTaskInput) => Promise<TaggingTaskCreationResult>> {
  if (impl === "current") return createTaggingAutoClassifyTask;
  try {
    const mod = await import("./lib/tagging-legacy-task-creation");
    return mod.legacyCreateTaggingAutoClassifyTask;
  } catch (error) {
    throw new Error(`--impl legacy needs scripts/lib/tagging-legacy-task-creation.ts: ${String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// 内存测量
// ---------------------------------------------------------------------------

export interface MemoryReport {
  startRssMiB: number;
  peakRssMiB: number;
  sampledPeakRssMiB: number;
  endRssMiB: number;
  heapPeakMiB: number;
  externalPeakMiB: number;
  arrayBuffersPeakMiB: number;
  elapsedMs: number;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

export async function measureMemory<T>(run: () => Promise<T>): Promise<{ result: T; memory: MemoryReport }> {
  // 先把 JIT/模块加载的一次性开销放到 start 里，峰值的"增量"才有意义。
  if (typeof global.gc === "function") global.gc();
  const start = process.memoryUsage();
  const startMax = process.resourceUsage().maxRSS * 1024;
  let sampledRss = start.rss;
  let heap = start.heapUsed;
  let external = start.external;
  let arrayBuffers = start.arrayBuffers;
  const timer = setInterval(() => {
    const usage = process.memoryUsage();
    sampledRss = Math.max(sampledRss, usage.rss);
    heap = Math.max(heap, usage.heapUsed);
    external = Math.max(external, usage.external);
    arrayBuffers = Math.max(arrayBuffers, usage.arrayBuffers);
  }, 20);
  const startedAt = Date.now();
  try {
    const result = await run();
    const end = process.memoryUsage();
    return {
      result,
      memory: {
        startRssMiB: round1(start.rss / MIB),
        // maxRSS 是进程自启动以来的峰值（含 tsx 编译与模块加载），它也是容器实际被计的口径。
        peakRssMiB: round1(Math.max(process.resourceUsage().maxRSS * 1024, startMax) / MIB),
        sampledPeakRssMiB: round1(Math.max(sampledRss, end.rss) / MIB),
        endRssMiB: round1(end.rss / MIB),
        heapPeakMiB: round1(heap / MIB),
        externalPeakMiB: round1(external / MIB),
        arrayBuffersPeakMiB: round1(arrayBuffers / MIB),
        elapsedMs: Date.now() - startedAt,
      },
    };
  } finally {
    clearInterval(timer);
  }
}

// ---------------------------------------------------------------------------
// 等价性对拍
// ---------------------------------------------------------------------------

export interface TaskStateDigest {
  status: string;
  eligibleCount: number;
  task: unknown;
  itemCount: number;
  itemsFingerprint: string;
  derivationViolations: number;
  audit: unknown;
}

/** 读回一个任务，去掉随机/时间性字段后做摘要。 */
export async function digestTask(db: PrismaClient, taskId: string, result: TaggingTaskCreationResult): Promise<TaskStateDigest> {
  const task = await db.genericTask.findUniqueOrThrow({ where: { id: taskId } });
  const audit = await db.operationAudit.findMany({ where: { taskId }, orderBy: { createdAt: "asc" } });
  const hash = createHash("sha256");
  let itemCount = 0;
  let derivationViolations = 0;
  let after: string | undefined;
  for (;;) {
    const page = await db.genericTaskItem.findMany({
      where: { taskId, ...(after ? { targetId: { gt: after } } : {}) },
      orderBy: { targetId: "asc" },
      take: 5000,
    });
    if (page.length === 0) break;
    for (const item of page) {
      const payload = { ...(item.payload as Record<string, unknown>) };
      const requestIdForItem = payload.classificationRequestId;
      delete payload.classificationRequestId;
      if (requestIdForItem !== fingerprint({ taskItemId: item.id, novelId: item.targetId })) derivationViolations += 1;
      hash.update(stableStringify({ targetType: item.targetType, targetId: item.targetId, status: item.status, attemptCount: item.attemptCount, payload }));
      hash.update("\n");
      itemCount += 1;
    }
    after = page[page.length - 1]!.targetId;
  }
  // 去掉 id / requestToken / 各类时间戳这些天然不同的字段，其余逐项比较。
  const taskRest = {
    taskType: task.taskType, channelAccountId: task.channelAccountId, channelAppId: task.channelAppId,
    operationScopeHash: task.operationScopeHash, originTaskId: task.originTaskId, parentTaskId: task.parentTaskId,
    mode: task.mode, status: task.status, totalCount: task.totalCount, successCount: task.successCount,
    failedCount: task.failedCount, skippedCount: task.skippedCount, params: task.params, result: task.result,
    error: task.error, startedAt: task.startedAt, completedAt: task.completedAt,
  };
  return {
    status: result.status,
    eligibleCount: result.eligibleCount,
    task: JSON.parse(stableStringify(taskRest)),
    itemCount,
    itemsFingerprint: hash.digest("hex"),
    derivationViolations,
    audit: audit.map((row) => JSON.parse(stableStringify({
      actorType: row.actorType, action: row.action, entityType: row.entityType, taskType: row.taskType,
      afterSnapshot: row.afterSnapshot,
    }))),
  };
}

export async function compareImplementations(
  db: PrismaClient,
  locale: string,
  lifecycle: Lifecycle,
): Promise<{ equal: boolean; legacy: TaskStateDigest; current: TaskStateDigest }> {
  const legacyCreate = await loadImpl("legacy");
  const legacyResult = await legacyCreate(createInput(db, locale, lifecycle, `b21-compare-legacy-${randomUUID()}`));
  if (legacyResult.status !== "enqueued") throw new Error(`legacy did not enqueue: ${JSON.stringify(legacyResult)}`);
  const legacy = await digestTask(db, legacyResult.taskId, legacyResult);
  // 同一范围的活动任务有唯一索引；对拍需要两份任务并存，所以先把第一份置为 cancelled。
  await db.genericTask.update({ where: { id: legacyResult.taskId }, data: { status: "cancelled" } });
  const currentResult = await createTaggingAutoClassifyTask(createInput(db, locale, lifecycle, `b21-compare-current-${randomUUID()}`));
  if (currentResult.status !== "enqueued") throw new Error(`current did not enqueue: ${JSON.stringify(currentResult)}`);
  const current = await digestTask(db, currentResult.taskId, currentResult);
  await db.genericTask.update({ where: { id: currentResult.taskId }, data: { status: "cancelled" } });
  const equal = stableStringify(legacy) === stableStringify(current)
    && legacy.derivationViolations === 0 && current.derivationViolations === 0;
  return { equal, legacy, current };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0];
  const rest = argv.slice(1);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const db = new PrismaClient({ datasourceUrl: url });
  try {
    if (command === "seed") {
      const locale = requireOption(rest, "--locale");
      const summary = await seedLocale(db, {
        locale,
        count: numberOption(rest, "--count", 1000),
        seed: numberOption(rest, "--seed", 1),
        descMedianChars: numberOption(rest, "--desc-median-chars", 700),
        manualRatio: numberOption(rest, "--manual-ratio", 0.02),
        taggedRatio: numberOption(rest, "--tagged-ratio", 0.3),
      });
      process.stdout.write(`${JSON.stringify({ command, locale, ...summary })}\n`);
    } else if (command === "measure") {
      const impl = (option(rest, "--impl") ?? "current") as Impl;
      if (impl !== "current" && impl !== "legacy") throw new Error("--impl must be current or legacy");
      const locale = requireOption(rest, "--locale");
      const lifecycle = lifecycleOption(rest);
      const create = await loadImpl(impl);
      const input = createInput(db, locale, lifecycle, requireOption(rest, "--request-id"));
      // 连接与 Prisma 引擎先热起来，避免把一次性初始化算进建任务峰值之外。
      await db.$queryRaw`SELECT 1`;
      const { result, memory } = await measureMemory(() => create(input));
      process.stdout.write(`${JSON.stringify({ command, impl, locale, lifecycle, result, ...memory })}\n`);
    } else if (command === "compare") {
      const locale = requireOption(rest, "--locale");
      const lifecycle = lifecycleOption(rest);
      const { equal, legacy, current } = await compareImplementations(db, locale, lifecycle);
      process.stdout.write(`${JSON.stringify({
        command, locale, lifecycle, equal, items: current.itemCount,
        legacyItemsFingerprint: legacy.itemsFingerprint, currentItemsFingerprint: current.itemsFingerprint,
        legacyDerivationViolations: legacy.derivationViolations, currentDerivationViolations: current.derivationViolations,
        taskRowsEqual: stableStringify(legacy.task) === stableStringify(current.task),
        auditEqual: stableStringify(legacy.audit) === stableStringify(current.audit),
      })}\n`);
      if (!equal) process.exitCode = 1;
    } else {
      throw new Error("usage: measure-tagging-task-creation-memory.ts seed|measure|compare ...");
    }
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
