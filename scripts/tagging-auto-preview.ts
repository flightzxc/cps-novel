/**
 * 前台自动标签开闸 · 第一步质量评估（只读）。
 *
 * 目的：在不动任何开关、不写任何标签、不跑任何回填的前提下，按语种抽样把
 * "如果现在把 `FEATURE_NOVEL_TAG_AUTO` 打开，公开页会多出哪些标签、这些标签
 * 好不好"变成可审阅的 JSON + CSV，供 Owner 判断是否批准开闸。
 *
 * 只读保证（三层，任何一层被破坏都应让脚本直接失败，而不是静默继续）：
 *
 *  1. 全程运行在**同一个** `prisma.$transaction(async (tx) => { ... })` 回调
 *     内，回调第一件事就是 `setTransactionReadOnly(tx)`
 *     （`scripts/lib/set-transaction-read-only.ts`，对 Postgres 连接执行
 *     `SET TRANSACTION READ ONLY`）——任何写语句（哪怕本文件将来被改坏、
 *     不小心引入一次写）都会被数据库本身拒绝（Postgres 25006），不依赖代码
 *     审查。`scripts/run-tagging-auto-preview-postgres-verification.sh` 的
 *     "变异"用例就是刻意在一份打了补丁的临时副本里插入一次写调用，证明这道
 *     闸真的挡得住，而不是自证。
 *  2. 只调用纯读函数：`resolveAutoClassificationAuthorities`/
 *     `readNovelClassificationSnapshot`（`src/server/tagging/
 *     auto-classification.ts`）、`classifyNovelText`（`src/lib/tagging/
 *     classifier.ts`，纯函数，不接触数据库）、`loadPublicTaxonomyByNovelIds`
 *     （`src/lib/site/public-taxonomy.ts`，生产公开投影本身用的同一个函数，
 *     不是重新发明一份"看起来差不多"的查询）——没有一处调用任何
 *     `create`/`update`/`upsert`/`delete`/`$executeRaw*`。
 *  3. 启动时校验 `SELECT current_user = 'web_app'`——同生产 resolver/worker
 *     实际使用的角色，不使用、也不需要更高权限的角色。
 *
 * 开闸判定本身完全不受这次预览触碰：`loadPublicTaxonomyByNovelIds` 在被显式
 * 传入 `{ FEATURE_NOVEL_TAG_AUTO: "false" }`（而不是继承真实 `process.env`）
 * 时只返回 manual FULL_SNAPSHOT ∪ 当前映射（source_label_mapping）——即"如果
 * 现在开闸，映射层会保留哪些标签"，与本机/容器当前的真实开关状态无关，这样
 * 预览结果不会因为谁在什么环境跑了这份脚本而漂移。"文本分类候选"另外调用
 * `classifyNovelText` 计算，二者在应用层按 `canonicalTagId` 去重后得到"公开
 * 投影 = 映射 ∪ 当前 run 的 auto，映射优先"这条 ADR-P2-06-5 合同的只读预演。
 *
 * 抽样：每个语种固定 `--seed` 下确定性抽样（Fisher-Yates + mulberry32 PRNG，
 * 完全在应用层做，不依赖 Postgres `random()`/`setseed()` 的跨连接可复现性），
 * 在"当前有映射标签"与"当前没有映射标签"两个池子间尽量各半，不足的一侧全取、
 * 缺口转给另一侧补足（见 `pickBalancedSample`）。抽样对象限定为未删除、
 * `NovelTagState.mode` 为 `automatic` 或没有该行（尚未被人工设为 manual）的
 * Novel——同 `classifyNovelForAuto` 实际会处理的候选集合。
 *
 * `--seed` 是必填项，刻意没有默认值：这份工具存在的意义之一就是让"这次抽样
 * 能不能复现"是一个显式决定，而不是不小心用了 `Date.now()` 之类不可复现的
 * 默认值。
 *
 * 设计为可以在已部署的镜像里原样运行：只用相对导入 `../src/...`，与
 * `scripts/preview-opening.ts`/`scripts/x8-preview-one.ts` 同一惯例——不用
 * `@/*` 别名（`tsx` 按入口文件所在目录向上找最近的 `tsconfig.json`，被
 * `docker cp` 到容器内别的目录时会解析失败）。
 *
 * 用法：
 *   npx tsx scripts/tagging-auto-preview.ts \
 *     --seed 20260928 --sample-per-locale 100 \
 *     [--locales en,ja,ko] [--out-dir /tmp/tagging-auto-preview]
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import { Prisma, PrismaClient } from "@prisma/client";

import { setTransactionReadOnly } from "./lib/set-transaction-read-only";
import {
  readNovelClassificationSnapshot,
  resolveAutoClassificationAuthorities,
  type NovelClassificationSnapshot,
} from "../src/server/tagging/auto-classification";
import { classifyNovelText, type NovelClassifierInput } from "../src/lib/tagging/classifier";
import { TaggingError } from "../src/lib/tagging/contracts";
import { loadPublicTaxonomyByNovelIds, type PublicTaxonomyTag } from "../src/lib/site/public-taxonomy";
import { resolveCanonicalTagLabel } from "../src/lib/site/canonical-tag-label";

type Db = Prisma.TransactionClient;

export class TaggingAutoPreviewError extends Error {
  readonly code: string;
  readonly detail: Record<string, unknown> | null;
  constructor(code: string, detail: Record<string, unknown> | null = null) {
    super(code);
    this.name = "TaggingAutoPreviewError";
    this.code = code;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// CLI argv helpers. Deliberately self-contained (not imported from
// scripts/preview-opening.ts) -- same "scripts/ carries no CLI-parsing
// library dependency" convention, applied per-file so this script has no
// dependency on another script's unrelated imports (task-termination,
// preview-enqueue, ...).
// ---------------------------------------------------------------------------

function option(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function requireOption(argv: readonly string[], flag: string): string {
  const value = option(argv, flag);
  if (value === undefined) throw new TaggingAutoPreviewError("missing_argument", { flag });
  return value;
}

function parsePositiveInt(raw: string, flag: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0 || String(value) !== raw.trim()) {
    throw new TaggingAutoPreviewError("invalid_argument", { flag, value: raw });
  }
  return value;
}

function parseSeed(raw: string, flag: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || String(value) !== raw.trim()) {
    throw new TaggingAutoPreviewError("invalid_argument", { flag, value: raw });
  }
  // Folded into an unsigned 32-bit int for the PRNG -- any safe integer
  // (including negative) is accepted as an operator-facing seed value.
  return value >>> 0;
}

export interface PreviewOptions {
  readonly samplePerLocale: number;
  readonly seed: number;
  readonly locales: readonly string[] | null;
  readonly outDir: string;
}

export function parseArgs(argv: readonly string[]): PreviewOptions {
  const samplePerLocaleRaw = option(argv, "--sample-per-locale");
  const samplePerLocale = samplePerLocaleRaw === undefined ? 100 : parsePositiveInt(samplePerLocaleRaw, "--sample-per-locale");
  const seed = parseSeed(requireOption(argv, "--seed"), "--seed");
  const localesRaw = option(argv, "--locales");
  const locales = localesRaw === undefined
    ? null
    : localesRaw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (locales !== null && locales.length === 0) throw new TaggingAutoPreviewError("invalid_argument", { flag: "--locales", value: localesRaw });
  const outDir = option(argv, "--out-dir") ?? "/tmp/tagging-auto-preview";
  return { samplePerLocale, seed, locales, outDir };
}

// ---------------------------------------------------------------------------
// Deterministic sampling. Pure functions -- no I/O -- so they are directly
// unit-testable (tests/backend/tagging/tagging-auto-preview-sampling.test.ts)
// without a database.
// ---------------------------------------------------------------------------

/** mulberry32: small, fast, deterministic 32-bit PRNG. Same seed -> same infinite output stream, on any machine/Node version. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic Fisher-Yates shuffle keyed off `seed`; never mutates `items`. */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const rng = mulberry32(seed);
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/** FNV-1a-style fold of the run seed with a locale string, so every locale gets an independent-looking but still fully deterministic shuffle order from one `--seed`. */
export function deriveLocaleSeed(seed: number, locale: string): number {
  let h = (seed >>> 0) ^ 0x811c9dc5;
  for (let i = 0; i < locale.length; i += 1) {
    h ^= locale.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface BalancedSampleResult {
  readonly sampleIds: readonly string[];
  readonly mappedSampledCount: number;
  readonly unmappedSampledCount: number;
  readonly mappedPoolSize: number;
  readonly unmappedPoolSize: number;
}

/**
 * Picks up to `n` ids split as evenly as possible between the "currently has
 * a mapped tag" and "currently has none" pools (ceil(n/2) from the mapped
 * pool, the rest from the unmapped one). When one pool is smaller than its
 * half, it is taken in full and the shortfall is made up from the other pool
 * (never silently returns fewer than `min(n, mappedPool.length +
 * unmappedPool.length)`). Both input arrays must already be in a stable
 * (e.g. sorted) order -- the shuffle is seeded, not the input order.
 */
export function pickBalancedSample(
  mappedIds: readonly string[],
  unmappedIds: readonly string[],
  n: number,
  seed: number,
): BalancedSampleResult {
  const shuffledMapped = seededShuffle(mappedIds, seed);
  const shuffledUnmapped = seededShuffle(unmappedIds, seed + 1);
  const halfMapped = Math.ceil(n / 2);
  const halfUnmapped = n - halfMapped;

  let takeMapped = Math.min(halfMapped, shuffledMapped.length);
  let takeUnmapped = Math.min(halfUnmapped, shuffledUnmapped.length);
  let remaining = n - takeMapped - takeUnmapped;

  if (remaining > 0) {
    const extra = Math.min(remaining, shuffledUnmapped.length - takeUnmapped);
    takeUnmapped += extra;
    remaining -= extra;
  }
  if (remaining > 0) {
    const extra = Math.min(remaining, shuffledMapped.length - takeMapped);
    takeMapped += extra;
    remaining -= extra;
  }

  return {
    sampleIds: [...shuffledMapped.slice(0, takeMapped), ...shuffledUnmapped.slice(0, takeUnmapped)],
    mappedSampledCount: takeMapped,
    unmappedSampledCount: takeUnmapped,
    mappedPoolSize: mappedIds.length,
    unmappedPoolSize: unmappedIds.length,
  };
}

/** Prefix by Unicode code point, not UTF-16 code unit or byte -- consistent with `codePointLength` (`src/lib/tagging/stable-json.ts`) used elsewhere in the tagging stack. */
export function prefixCodePoints(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join("");
}

// ---------------------------------------------------------------------------
// Read-only database access.
// ---------------------------------------------------------------------------

interface LocaleNovelRow {
  readonly id: string;
  readonly hasMapped: boolean;
  readonly eligible: boolean;
}

/**
 * One read per locale returning, for every non-deleted Novel in it: whether
 * it currently has at least one mapped tag (manual FULL_SNAPSHOT row ∪ an
 * active `source_label_mapping` edge reachable from its linked source item --
 * the exact same predicate shape as `loadPublicTaxonomyByNovelIds`'s own
 * `base_membership` CTE, `src/lib/site/public-taxonomy.ts`, kept in raw SQL
 * here purely so this can be one aggregate pass over an entire locale instead
 * of first pulling every id into the app to call that function), and whether
 * it is eligible for auto classification today (`NovelTagState.mode` is
 * `automatic` or the row does not exist yet -- the same population
 * `classifyNovelForAuto` would ever be asked to classify).
 */
async function fetchLocaleNovelRows(tx: Db, locale: string): Promise<LocaleNovelRow[]> {
  const rows = await tx.$queryRaw<Array<{ id: string; has_mapped: boolean; eligible: boolean }>>(Prisma.sql`
    WITH target_source_item AS (
      SELECT nsi.id, nsi.novel_id, nsi.channel_app_id, nsi.raw_language_scope
      FROM novel_source_item nsi
      JOIN novel n ON n.id = nsi.novel_id
      WHERE n.locale = ${locale} AND n.deleted_at IS NULL
        AND nsi.status = 'linked' AND nsi.deleted_at IS NULL AND nsi.raw_language_scope IS NOT NULL
    ),
    mapped_novels AS (
      SELECT DISTINCT nct.novel_id
      FROM novel_canonical_tag nct
      JOIN novel_tag_state nts ON nts.novel_id = nct.novel_id AND nts.mode = 'manual'
      JOIN novel n ON n.id = nct.novel_id
      WHERE n.locale = ${locale} AND n.deleted_at IS NULL AND nct.source = 'manual'
      UNION
      SELECT DISTINCT tsi.novel_id
      FROM target_source_item tsi
      JOIN channel_app ca ON ca.id = tsi.channel_app_id AND ca.status = 'active'
      JOIN novel_source_item_label nsil ON nsil.novel_source_item_id = tsi.id AND nsil.active IS TRUE
      JOIN source_label sl ON sl.id = nsil.source_label_id AND sl.channel_app_id = tsi.channel_app_id AND sl.label_kind = 'series_type'
      JOIN source_label_mapping slm ON slm.channel_app_id = tsi.channel_app_id
        AND slm.raw_language_scope COLLATE "C" = tsi.raw_language_scope COLLATE "C"
        AND slm.raw_token COLLATE "C" = sl.external_label_value::text COLLATE "C"
        AND slm.active IS TRUE
      WHERE NOT EXISTS (
        SELECT 1 FROM novel_tag_state nts WHERE nts.novel_id = tsi.novel_id AND nts.mode = 'manual'
      )
    )
    SELECT n.id AS id,
           (mn.novel_id IS NOT NULL) AS has_mapped,
           (nts.mode IS NULL OR nts.mode = 'automatic') AS eligible
    FROM novel n
    LEFT JOIN novel_tag_state nts ON nts.novel_id = n.id
    LEFT JOIN mapped_novels mn ON mn.novel_id = n.id
    WHERE n.locale = ${locale} AND n.deleted_at IS NULL
    ORDER BY n.id
  `);
  return rows.map((row) => ({ id: row.id, hasMapped: row.has_mapped, eligible: row.eligible }));
}

async function fetchDistinctLocales(tx: Db): Promise<string[]> {
  const rows = await tx.novel.findMany({
    where: { deletedAt: null },
    distinct: ["locale"],
    select: { locale: true },
    orderBy: { locale: "asc" },
  });
  return rows.map((row) => row.locale);
}

interface CanonicalTagMeta {
  readonly slug: string;
  readonly translationsByLocale: ReadonlyMap<string, string>;
}

async function loadCanonicalTagMeta(tx: Db): Promise<Map<string, CanonicalTagMeta>> {
  const rows = await tx.canonicalTag.findMany({
    where: { status: "active" },
    select: { id: true, slug: true, translations: { select: { locale: true, displayName: true } } },
  });
  return new Map(rows.map((row) => [row.id, {
    slug: row.slug,
    translationsByLocale: new Map(row.translations.map((translation) => [translation.locale, translation.displayName])),
  }]));
}

const TAXONOMY_CHUNK_SIZE = 200;
/** Read-only mapped-tag lookup for a batch of ids -- reuses the production projection function unmodified, chunked the same way `scripts/preview-opening.ts`'s `ENQUEUE_CHUNK_SIZE` batches article ids. `FEATURE_NOVEL_TAG_AUTO` is pinned to `"false"` here (a synthetic env object, never the real `process.env`) so this always answers "manual ∪ mapped, regardless of what this container's live flag happens to be" -- see this file's header comment. */
async function loadTaxonomyForIds(tx: Db, ids: readonly string[], locale: string): Promise<Map<string, readonly PublicTaxonomyTag[]>> {
  const merged = new Map<string, readonly PublicTaxonomyTag[]>();
  for (let offset = 0; offset < ids.length; offset += TAXONOMY_CHUNK_SIZE) {
    const chunk = ids.slice(offset, offset + TAXONOMY_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const chunkMap = await loadPublicTaxonomyByNovelIds(tx, chunk, locale, { FEATURE_NOVEL_TAG_AUTO: "false" } as unknown as NodeJS.ProcessEnv);
    for (const [id, tags] of chunkMap) merged.set(id, tags);
  }
  return merged;
}

function describeError(error: unknown): string {
  if (error instanceof TaggingError) return error.code;
  if (error instanceof Error) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// Candidate detail shaping (evidence -> human-reviewable fields).
// ---------------------------------------------------------------------------

interface ClassifierEvidenceMatch { readonly keywordId: string }
interface ClassifierEvidence {
  readonly matchedFields: readonly string[];
  readonly matches: { readonly title: readonly ClassifierEvidenceMatch[]; readonly description: readonly ClassifierEvidenceMatch[] };
}

export interface MatchedKeyword {
  readonly field: "title" | "description";
  readonly keywordId: string;
  readonly value: string;
}

export interface CandidateDetail {
  readonly canonicalTagId: string;
  readonly stableId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly score: number;
  readonly matchedFields: readonly string[];
  readonly matchedKeywords: readonly MatchedKeyword[];
}

function buildMappedTagDetails(
  tags: readonly PublicTaxonomyTag[],
  tagMetaById: ReadonlyMap<string, CanonicalTagMeta>,
): MappedTagDetail[] {
  return tags.map((tag) => {
    const meta = tagMetaById.get(tag.id) ?? null;
    return {
      slug: tag.slug,
      label: tag.label,
      nameEn: meta?.translationsByLocale.get("en") ?? null,
      nameZh: meta?.translationsByLocale.get("zh") ?? null,
    };
  });
}

function buildCandidateDetails(
  candidates: ReturnType<typeof classifyNovelText>["candidates"],
  tagMetaById: ReadonlyMap<string, CanonicalTagMeta>,
  artifactStableIdById: ReadonlyMap<string, string>,
  keywordValueById: ReadonlyMap<string, string>,
  locale: string,
): CandidateDetail[] {
  return candidates.map((candidate) => {
    const meta = tagMetaById.get(candidate.canonicalTagId) ?? null;
    const evidence = candidate.evidence as unknown as ClassifierEvidence;
    const matchedKeywords: MatchedKeyword[] = [];
    for (const field of ["title", "description"] as const) {
      for (const match of evidence.matches?.[field] ?? []) {
        matchedKeywords.push({ field, keywordId: match.keywordId, value: keywordValueById.get(match.keywordId) ?? match.keywordId });
      }
    }
    return {
      canonicalTagId: candidate.canonicalTagId,
      stableId: artifactStableIdById.get(candidate.canonicalTagId) ?? "unknown",
      slug: meta?.slug ?? "unknown",
      displayName: meta
        ? resolveCanonicalTagLabel({
          requested: meta.translationsByLocale.get(locale) ?? null,
          en: meta.translationsByLocale.get("en") ?? null,
          zh: meta.translationsByLocale.get("zh") ?? null,
          slug: meta.slug,
        })
        : "unknown",
      score: candidate.score,
      matchedFields: Array.isArray(evidence.matchedFields) ? evidence.matchedFields : [],
      matchedKeywords,
    };
  });
}

// ---------------------------------------------------------------------------
// Output shaping.
// ---------------------------------------------------------------------------

export interface MappedTagDetail {
  readonly slug: string;
  /** Resolved for this sample's own locale (production fallback order: requested -> en -> zh -> slug). */
  readonly label: string;
  /** Raw `en` translation, independent of the sample's own locale -- not the same as `label` whenever the locale is not `en`. */
  readonly nameEn: string | null;
  /** Raw `zh` translation -- the classifier's own `canonical_definition`/keyword lexicon is authored in Chinese, so this is the most directly comparable name for manual review regardless of the sample's site locale. */
  readonly nameZh: string | null;
}

export interface SampleRecord {
  readonly novelId: string;
  readonly locale: string;
  readonly title: string | null;
  readonly descriptionPrefix300: string | null;
  readonly mappedTags: readonly MappedTagDetail[];
  readonly candidates: readonly CandidateDetail[];
  readonly finalAutoTagsAfterDedup: readonly CandidateDetail[];
  readonly rawEligibleCount: number | null;
  readonly selectedCount: number | null;
  readonly truncatedCount: number | null;
  readonly skippedReason: string | null;
}

export interface LocaleSummary {
  readonly locale: string;
  readonly sampleRequested: number;
  readonly sampleTaken: number;
  readonly processedCount: number;
  readonly skippedCount: number;
  readonly mappedPoolSize: number;
  readonly unmappedPoolSize: number;
  readonly mappedSampledCount: number;
  readonly unmappedSampledCount: number;
  readonly mappedCoverageRatio: number;
  readonly autoHitRatio: number;
  readonly autoOnlyGainRatio: number;
  readonly avgFinalAutoTagCount: number;
  readonly finalAutoTagTop10: ReadonlyArray<{ slug: string; stableId: string; count: number }>;
  readonly mappedDuplicateRatio: number;
  readonly globalTotalNovelCount: number;
  readonly globalMappedNovelCount: number;
  readonly globalUnmappedNovelCount: number;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function buildCsv(samples: readonly SampleRecord[]): string {
  const header = [
    "locale", "novel_id", "title", "description_prefix_300",
    "mapped_tag_slugs", "mapped_tag_labels", "mapped_tag_names_en", "mapped_tag_names_zh",
    "candidate_slugs_scores", "candidate_matched_fields",
    "final_auto_slugs_after_dedup",
    "raw_eligible_count", "selected_count", "truncated_count",
    "skipped_reason",
  ];
  const lines = [header.join(",")];
  for (const sample of samples) {
    const row = [
      sample.locale,
      sample.novelId,
      sample.title ?? "",
      sample.descriptionPrefix300 ?? "",
      sample.mappedTags.map((tag) => tag.slug).join(";"),
      sample.mappedTags.map((tag) => tag.label).join(";"),
      sample.mappedTags.map((tag) => tag.nameEn ?? "").join(";"),
      sample.mappedTags.map((tag) => tag.nameZh ?? "").join(";"),
      sample.candidates.map((c) => `${c.slug}:${c.score}`).join(";"),
      sample.candidates.map((c) => `${c.slug}=${c.matchedFields.join("+")}`).join(";"),
      sample.finalAutoTagsAfterDedup.map((c) => c.slug).join(";"),
      sample.rawEligibleCount === null ? "" : String(sample.rawEligibleCount),
      sample.selectedCount === null ? "" : String(sample.selectedCount),
      sample.truncatedCount === null ? "" : String(sample.truncatedCount),
      sample.skippedReason ?? "",
    ];
    lines.push(row.map((cell) => csvCell(String(cell))).join(","));
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

export interface RunMeta {
  readonly generatedAt: string;
  readonly seed: number;
  readonly samplePerLocale: number;
  readonly locales: readonly string[];
  readonly databaseRole: string;
  readonly transactionMode: "READ_ONLY";
  readonly classifierConfigVersion: string;
  readonly classifierConfigFingerprint: string;
  readonly classifierParameters: {
    readonly titleWeight: number; readonly descriptionWeight: number;
    readonly threshold: number; readonly maxTextTags: number;
  };
  readonly taxonomyVersion: string;
  readonly taxonomySha256: string;
  readonly keywordLexiconVersion: string;
  readonly keywordFingerprint: string;
}

export interface PreviewRunResult {
  readonly runMeta: RunMeta;
  readonly localeSummaries: readonly LocaleSummary[];
  readonly samples: readonly SampleRecord[];
}

/** Everything above this point is pure or read-only-by-construction; this is the one place the read-only transaction is opened and torn down. */
export async function runTaggingAutoPreview(prisma: PrismaClient, options: PreviewOptions): Promise<PreviewRunResult> {
  return prisma.$transaction(async (tx) => {
    await setTransactionReadOnly(tx);

    const roleRows = await tx.$queryRaw<Array<{ current_user: string }>>(Prisma.sql`SELECT current_user`);
    const role = roleRows[0]?.current_user ?? null;
    if (role !== "web_app") throw new TaggingAutoPreviewError("wrong_database_role", { role, expected: "web_app" });

    const authorities = await resolveAutoClassificationAuthorities(tx);
    const tagMetaById = await loadCanonicalTagMeta(tx);
    const artifactStableIdById = new Map(authorities.artifact.tags.map((tag) => [tag.canonicalTagId, tag.stableId]));
    const keywordValueById = new Map(
      authorities.artifact.tags.flatMap((tag) => tag.keywords.map((keyword) => [keyword.keywordId, keyword.value] as const)),
    );

    const locales = options.locales ?? await fetchDistinctLocales(tx);

    const localeSummaries: LocaleSummary[] = [];
    const samples: SampleRecord[] = [];

    for (const locale of locales) {
      const rows = await fetchLocaleNovelRows(tx, locale);
      const totalNovelCount = rows.length;
      const mappedNovelCount = rows.filter((row) => row.hasMapped).length;
      const eligible = rows.filter((row) => row.eligible);
      const mappedIds = eligible.filter((row) => row.hasMapped).map((row) => row.id).sort();
      const unmappedIds = eligible.filter((row) => !row.hasMapped).map((row) => row.id).sort();

      const localeSeed = deriveLocaleSeed(options.seed, locale);
      const picked = pickBalancedSample(mappedIds, unmappedIds, options.samplePerLocale, localeSeed);
      const sampleIdsSorted = [...picked.sampleIds].sort();

      const taxonomyMap = await loadTaxonomyForIds(tx, sampleIdsSorted, locale);

      let mappedInSample = 0;
      let autoHit = 0;
      let autoOnlyGain = 0;
      let sumFinalAutoTags = 0;
      let rawCandidateTotal = 0;
      let rawCandidateDuplicateWithMapped = 0;
      let localeSkipped = 0;
      const finalAutoTagCounts = new Map<string, { slug: string; stableId: string; count: number }>();

      for (const novelId of sampleIdsSorted) {
        let snapshot: NovelClassificationSnapshot;
        try {
          snapshot = await readNovelClassificationSnapshot(tx, novelId);
        } catch (error) {
          localeSkipped += 1;
          samples.push({
            novelId, locale, title: null, descriptionPrefix300: null,
            mappedTags: [], candidates: [], finalAutoTagsAfterDedup: [],
            rawEligibleCount: null, selectedCount: null, truncatedCount: null,
            skippedReason: describeError(error),
          });
          continue;
        }

        const input: NovelClassifierInput = { title: snapshot.title, description: snapshot.description };
        const result = classifyNovelText(input, authorities.artifact, authorities.config);
        const mappedTags = taxonomyMap.get(novelId) ?? [];
        const mappedIdSet = new Set(mappedTags.map((tag) => tag.id));
        const candidateDetails = buildCandidateDetails(result.candidates, tagMetaById, artifactStableIdById, keywordValueById, locale);
        const finalAfterDedup = candidateDetails.filter((candidate) => !mappedIdSet.has(candidate.canonicalTagId));

        rawCandidateTotal += candidateDetails.length;
        rawCandidateDuplicateWithMapped += candidateDetails.length - finalAfterDedup.length;
        if (mappedTags.length > 0) mappedInSample += 1;
        if (result.selectedCount > 0) autoHit += 1;
        if (mappedTags.length === 0 && finalAfterDedup.length > 0) autoOnlyGain += 1;
        sumFinalAutoTags += finalAfterDedup.length;
        for (const candidate of finalAfterDedup) {
          const entry = finalAutoTagCounts.get(candidate.canonicalTagId) ?? { slug: candidate.slug, stableId: candidate.stableId, count: 0 };
          entry.count += 1;
          finalAutoTagCounts.set(candidate.canonicalTagId, entry);
        }

        samples.push({
          novelId, locale,
          title: snapshot.title,
          descriptionPrefix300: prefixCodePoints(snapshot.description, 300),
          mappedTags: buildMappedTagDetails(mappedTags, tagMetaById),
          candidates: candidateDetails,
          finalAutoTagsAfterDedup: finalAfterDedup,
          rawEligibleCount: result.rawEligibleCount,
          selectedCount: result.selectedCount,
          truncatedCount: result.truncatedCount,
          skippedReason: null,
        });
      }

      const processedCount = sampleIdsSorted.length - localeSkipped;
      localeSummaries.push({
        locale,
        sampleRequested: options.samplePerLocale,
        sampleTaken: sampleIdsSorted.length,
        processedCount,
        skippedCount: localeSkipped,
        mappedPoolSize: mappedIds.length,
        unmappedPoolSize: unmappedIds.length,
        mappedSampledCount: picked.mappedSampledCount,
        unmappedSampledCount: picked.unmappedSampledCount,
        mappedCoverageRatio: ratio(mappedInSample, processedCount),
        autoHitRatio: ratio(autoHit, processedCount),
        autoOnlyGainRatio: ratio(autoOnlyGain, processedCount),
        avgFinalAutoTagCount: processedCount > 0 ? sumFinalAutoTags / processedCount : 0,
        finalAutoTagTop10: [...finalAutoTagCounts.values()]
          .sort((left, right) => right.count - left.count || left.slug.localeCompare(right.slug, "en"))
          .slice(0, 10),
        mappedDuplicateRatio: ratio(rawCandidateDuplicateWithMapped, rawCandidateTotal),
        globalTotalNovelCount: totalNovelCount,
        globalMappedNovelCount: mappedNovelCount,
        globalUnmappedNovelCount: totalNovelCount - mappedNovelCount,
      });
    }

    const runMeta: RunMeta = {
      generatedAt: new Date().toISOString(),
      seed: options.seed,
      samplePerLocale: options.samplePerLocale,
      locales,
      databaseRole: role,
      transactionMode: "READ_ONLY",
      classifierConfigVersion: authorities.config.version,
      classifierConfigFingerprint: authorities.config.fingerprint,
      classifierParameters: {
        titleWeight: authorities.config.titleWeight,
        descriptionWeight: authorities.config.descriptionWeight,
        threshold: authorities.config.threshold,
        maxTextTags: authorities.config.maxTextTags,
      },
      taxonomyVersion: authorities.artifact.taxonomyVersion,
      taxonomySha256: authorities.artifact.taxonomySha256,
      keywordLexiconVersion: authorities.artifact.keywordLexiconVersion,
      keywordFingerprint: authorities.artifact.keywordFingerprint,
    };

    return { runMeta, localeSummaries, samples };
  }, { maxWait: 30_000, timeout: 600_000 });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const { runMeta, localeSummaries, samples } = await runTaggingAutoPreview(prisma, options);

    await mkdir(options.outDir, { recursive: true });
    await writeFile(
      path.join(options.outDir, "tagging-auto-preview.json"),
      JSON.stringify({ runMeta, localeSummaries, samples }, null, 2),
    );
    await writeFile(path.join(options.outDir, "tagging-auto-preview.csv"), buildCsv(samples));

    console.log(JSON.stringify({
      result: "TAGGING_AUTO_PREVIEW_OK",
      outDir: options.outDir,
      locales: runMeta.locales,
      totalSamples: samples.length,
      totalSkipped: samples.filter((sample) => sample.skippedReason !== null).length,
      databaseTransaction: "READ_ONLY",
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    if (error instanceof TaggingAutoPreviewError) {
      console.error(JSON.stringify({ error: error.code, detail: error.detail }));
    } else {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    }
    process.exitCode = 64;
  });
}
