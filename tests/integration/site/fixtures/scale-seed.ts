/**
 * B-38 第二段：接近生产规模的合成数据种子（给 `public-list-bench-postgres.test.ts` 和新旧代码对比用）。
 *
 * 🔴 只写表，不依赖任何 B-38 新函数，也不碰 `novel_effective_tag`（归属表那一步是单独的
 * `buildProjection`，由调用方决定要不要跑）——所以这个文件可以原样拷进旧代码（v0.5.12）的 worktree，
 * 在旧代码上灌出一模一样的数据再对比。除 `@prisma/client` 外不 import 任何站内模块。
 *
 * 也可以单独当脚本跑（只灌数据，不跑基准）：
 *   B38_SEED_DATABASE_URL=postgresql://<owner>@host/db npx vite-node tests/integration/site/fixtures/scale-seed.ts
 * （连接串里的库名必须以 `cps_novel_` 开头——种子会 TRUNCATE 之外的东西也不碰，但仍拒绝任何别的库。）
 *
 * ## 数据形状（对照方案附录 D / 2.2 的生产实测）
 *
 * | 语种 | 小说 | 列表可见 | 映射边 | 说明 |
 * | en | 40,000 | ≈13,000 | 100 | 一个"大分类"（tag 0）约覆盖 75% 的小说；99 个中小分类按 u^2.5 偏斜分布 |
 * | ru / es / ko | 3,300 / 3,000 / 900 | ≈2,900 / 2,600 / 760 | 40 / 30 / 30 | 小语种 |
 * | fr | 2,700 | ≈2,400 | 0 | 没有映射边，只有自动标签 |
 *
 * 映射边合计 200 条。其余（不可见）的书按固定比例落在：没有文章（小说草稿）、文章草稿、小说未发布、
 * 推广链接 pending、推广链接两个地址都是空白、文章 hidden / seo_only、文章软删、小说撤回——
 * 都是真实库里存在的"不进列表"的原因（其中"还没生成文章"占不可见书的 85%，与生产里 8 万本小说只有 2.9 万篇文章的
 * 比例同量级）。约 30% 的书带自动打标结果（每本 2 个分类）。
 *
 * 所有 id / 唯一键由 `prefix + 序号` 的 md5 派生，同一个库里同一个前缀只能灌一次；分布全部由序号与 md5 字节
 * 确定（不用 `random()`），所以两次灌出来的数据逐行相同，新旧代码的对比才公平。
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

export type ScaleSeedSegment = Readonly<{
  /** 同一个库里唯一；决定 id、slug、短码的派生。 */
  key: string;
  locale: string;
  novels: number;
  /** 其中列表可见的本数。 */
  visible: number;
  /** 带"大分类"（tag 0）上游标签的小说占比。 */
  bigShare: number;
  /** 这个语种的映射边条数（= 参与映射的分类数，tag 0..mappedTags-1）。0 = 没有映射边。 */
  mappedTags: number;
  /** 带自动打标结果的小说占比。 */
  autoShare: number;
}>;

export const PRODUCTION_LIKE_SEGMENTS: readonly ScaleSeedSegment[] = Object.freeze([
  { key: "en", locale: "en", novels: 40_000, visible: 13_000, bigShare: 0.75, mappedTags: 100, autoShare: 0.3 },
  { key: "ru", locale: "ru", novels: 3_300, visible: 2_900, bigShare: 0.5, mappedTags: 40, autoShare: 0.3 },
  { key: "es", locale: "es", novels: 3_000, visible: 2_600, bigShare: 0.5, mappedTags: 30, autoShare: 0.3 },
  { key: "ko", locale: "ko", novels: 900, visible: 760, bigShare: 0.5, mappedTags: 30, autoShare: 0.3 },
  { key: "fr", locale: "fr", novels: 2_700, visible: 2_400, bigShare: 0, mappedTags: 0, autoShare: 0.5 },
]);

export const SCALE_TAG_COUNT = 100;
export const SCALE_BIG_TAG_SLUG = "bench-big";

export type ScaleSeedResult = Readonly<{
  adminId: string;
  channelAppId: string;
  tagIds: readonly string[];
  segments: ReadonlyArray<Readonly<{ key: string; locale: string; novels: number; visible: number }>>;
  mappingEdges: number;
}>;

const HASH_64 = "a".repeat(64);
const BASE_PUBLISHED_AT = "2026-01-01T00:00:00.000Z";

export function rawLanguageScope(code: string): string {
  return `["RAW_LANGUAGE_SCOPE_V1",["string","${code}"],["null"]]`;
}

function lit(value: string): string {
  if (!/^[A-Za-z0-9_.:/\-\[\]",]+$/.test(value)) throw new Error(`unsafe literal: ${value}`);
  return `'${value.replaceAll("'", "''")}'`;
}

/** 0 ≤ u < 1 的确定性伪随机：取 md5 的前两个字节。`salt` 区分同一本书上的不同用途。 */
function uniform(prefix: string, salt: string): string {
  return `((get_byte(decode(md5(${lit(prefix)} || '-' || g || '-${salt}'), 'hex'), 0) * 256 + get_byte(decode(md5(${lit(prefix)} || '-' || g || '-${salt}'), 'hex'), 1)) / 65536.0)`;
}

/** 序号 g 属于哪一类（见文件头）：`pos = (g * 7919) % N` 是 0..N-1 的一个置换（7919 是质数）。 */
function kindExpression(segment: ScaleSeedSegment): string {
  // 不可见的书里绝大多数是"还没生成文章"（生产 8 万本小说只有 2.9 万篇文章），其余各种原因占小头。
  const rest = segment.novels - segment.visible;
  const cumulative = [0, 0.85, 0.88, 0.91, 0.93, 0.95, 0.96, 0.97];
  const cuts = cumulative.map((fraction) => segment.visible + Math.floor(rest * fraction));
  const names = ["visible", "no_article", "article_draft", "novel_unpublished", "promo_pending", "promo_blank", "article_hidden", "article_deleted"];
  const branches = cuts.map((cut, index) => `WHEN pos < ${cut} THEN '${names[index]}'`).join(" ");
  return `CASE ${branches} ELSE 'novel_takedown' END`;
}

function series(segment: ScaleSeedSegment): string {
  return `(SELECT g, (g * 7919) % ${segment.novels} AS pos FROM generate_series(1, ${segment.novels}) AS g) s`;
}

async function seedFoundation(owner: PrismaClient) {
  const admin = await owner.adminIdentity.create({
    data: { username: `bench-${Date.now()}`, passwordHash: "scrypt$v1$test-only", role: "super_admin" },
  });
  const channel = await owner.channel.create({ data: { code: "bench", name: "Bench" } });
  const sourceApp = await owner.sourceApp.create({ data: { code: "bench", name: "Bench" } });
  const app = await owner.channelApp.create({
    data: { channelId: channel.id, sourceAppId: sourceApp.id, externalAppId: "bench-app", projectType: 1, status: "active" },
  });
  const account = await owner.channelAccount.create({
    data: { channelId: channel.id, businessId: "bench-account", accountName: "Bench account", status: "active" },
  });
  const tagIds: string[] = [];
  for (let index = 0; index < SCALE_TAG_COUNT; index += 1) {
    const slug = index === 0 ? SCALE_BIG_TAG_SLUG : `bench-tag-${String(index).padStart(3, "0")}`;
    const tag = await owner.canonicalTag.create({
      data: {
        stableId: `ct-v1-bench-${String(index).padStart(3, "0")}`, slug, canonicalDefinition: "Bench fixture", aliases: [],
        sortOrder: index + 1, taxonomyVersion: "bench",
        translations: { create: [{ locale: "en", displayName: `Bench ${index}` }, ...(index % 3 === 0 ? [{ locale: "zh", displayName: `基准${index}` }] : [])] },
      },
    });
    tagIds.push(tag.id);
  }
  // 100 个上游标签（series_type），编号与分类一一对应，所有语种范围共用同一批（生产里 17 个语言范围共用一批标签）。
  await owner.$executeRawUnsafe(`
    INSERT INTO source_label (id, channel_app_id, label_kind, external_label_value, updated_at)
    SELECT md5('bench-label-' || i)::uuid, '${app.id}'::uuid, 'series_type', 'bench-label-' || i, now()
    FROM generate_series(0, ${SCALE_TAG_COUNT - 1}) AS i`);
  return { admin, app, account, tagIds };
}

async function seedMappings(
  owner: PrismaClient,
  foundation: Awaited<ReturnType<typeof seedFoundation>>,
  segments: readonly ScaleSeedSegment[],
): Promise<number> {
  let edges = 0;
  for (const segment of segments) {
    if (segment.mappedTags === 0) continue;
    await owner.$executeRawUnsafe(`
      INSERT INTO source_label_mapping (id, channel_app_id, raw_language_scope, raw_token, canonical_tag_id, mapping_version, approved_by, active, updated_at)
      SELECT gen_random_uuid(), '${foundation.app.id}'::uuid, ${lit(rawLanguageScope(segment.locale))}, 'bench-label-' || i,
             (ARRAY[${foundation.tagIds.map((id) => `'${id}'::uuid`).join(",")}])[i + 1], 'bench', '${foundation.admin.id}'::uuid, true, now()
      FROM generate_series(0, ${segment.mappedTags - 1}) AS i`);
    edges += segment.mappedTags;
  }
  return edges;
}

async function seedSegment(
  owner: PrismaClient,
  foundation: Awaited<ReturnType<typeof seedFoundation>>,
  segment: ScaleSeedSegment,
): Promise<void> {
  const { key, locale } = segment;
  const kind = kindExpression(segment);
  const scope = lit(rawLanguageScope(locale));

  await owner.$executeRawUnsafe(`
    INSERT INTO novel (id, business_id, title, description, cover_url, locale, slug, status, deleted_at, created_at, updated_at)
    SELECT md5(${lit(key)} || '-n-' || g)::uuid, ${lit(key)} || '-book-' || g, 'Bench book ' || g, 'Fixture',
           '/covers/' || g || '.webp', ${lit(locale)}, ${lit(key)} || '-' || g,
           CASE k WHEN 'no_article' THEN 'draft' WHEN 'novel_unpublished' THEN 'unpublished' WHEN 'novel_takedown' THEN 'takedown' ELSE 'published' END,
           NULL, now(), now()
    FROM (SELECT g, ${kind} AS k FROM ${series(segment)}) t`);

  // 每本书一条书目（绑定、已 linked、带语言范围）——既是"上游标签 → 映射 → 分类"的起点，也是推广链接的书目外键。
  await owner.$executeRawUnsafe(`
    INSERT INTO novel_source_item (id, channel_app_id, novel_id, external_book_id, source_language_code, source_locale, raw_language_scope,
                                   title, description, status, raw_payload, created_at, updated_at)
    SELECT md5(${lit(key)} || '-s-' || g)::uuid, '${foundation.app.id}'::uuid, md5(${lit(key)} || '-n-' || g)::uuid,
           ${lit(key)} || '-ext-' || g, ${lit(locale)}, ${lit(locale)}, ${scope}, 'Bench book ' || g, 'Fixture', 'linked', '{}'::jsonb, now(), now()
    FROM generate_series(1, ${segment.novels}) AS g`);

  if (segment.mappedTags > 0) {
    const m = segment.mappedTags;
    // 大分类标签（label 0）：占比 bigShare；另外每本书 1～3 个偏斜分布的中小分类标签（u^2.5）。
    await owner.$executeRawUnsafe(`
      INSERT INTO novel_source_item_label (id, novel_source_item_id, source_label_id, active)
      SELECT DISTINCT ON (item, label) md5(${lit(key)} || '-l-' || g || '-' || label)::uuid, item, md5('bench-label-' || label)::uuid, true
      FROM (
        SELECT g, md5(${lit(key)} || '-s-' || g)::uuid AS item, 0 AS label FROM generate_series(1, ${segment.novels}) AS g
          WHERE ${uniform(key, "big")} < ${segment.bigShare}
        UNION ALL
        SELECT g, md5(${lit(key)} || '-s-' || g)::uuid, 1 + floor((${m} - 1) * power(${uniform(key, "x1")}, 2.5))::int FROM generate_series(1, ${segment.novels}) AS g
        UNION ALL
        SELECT g, md5(${lit(key)} || '-s-' || g)::uuid, 1 + floor((${m} - 1) * power(${uniform(key, "x2")}, 2.5))::int FROM generate_series(1, ${segment.novels}) AS g
          WHERE ${uniform(key, "k2")} < 0.5
        UNION ALL
        SELECT g, md5(${lit(key)} || '-s-' || g)::uuid, 1 + floor((${m} - 1) * power(${uniform(key, "x3")}, 2.5))::int FROM generate_series(1, ${segment.novels}) AS g
          WHERE ${uniform(key, "k3")} < 0.2
      ) labels`);
  }

  // 推广链接：除"没有文章"的书之外每本一条。visible = fetched + 网页链接（5% 只有 App 链接）。
  await owner.$executeRawUnsafe(`
    INSERT INTO promo_link (id, novel_id, novel_source_item_id, channel_app_id, channel_account_id, offer_type, public_redirect_code,
                            idempotency_key, web_url, app_url, status, created_at, updated_at)
    SELECT md5(${lit(key)} || '-p-' || g)::uuid, md5(${lit(key)} || '-n-' || g)::uuid, md5(${lit(key)} || '-s-' || g)::uuid,
           '${foundation.app.id}'::uuid, '${foundation.account.id}'::uuid, 'upstream_existing',
           'r' || substr(md5(${lit(key)} || '-c-' || g), 1, 20),
           md5(${lit(key)} || '-k1-' || g) || md5(${lit(key)} || '-k2-' || g),
           CASE WHEN k = 'promo_pending' THEN NULL WHEN k = 'promo_blank' THEN '   '
                WHEN ${uniform(key, "app")} < 0.05 THEN NULL ELSE 'https://promo.example/' || ${lit(key)} || '/' || g END,
           CASE WHEN k = 'promo_blank' THEN '' WHEN k <> 'promo_pending' AND ${uniform(key, "app")} < 0.05 THEN 'https://app.example/' || ${lit(key)} || '/' || g ELSE NULL END,
           CASE WHEN k = 'promo_pending' THEN 'pending' ELSE 'fetched' END, now(), now()
    FROM (SELECT g, ${kind} AS k FROM ${series(segment)}) t
    WHERE k <> 'no_article'`);

  await owner.$executeRawUnsafe(`
    INSERT INTO article (id, novel_id, promo_link_id, locale, slug, public_page_short_id, title, body, status, seo_visibility,
                         published_at, deleted_at, created_at, updated_at)
    SELECT md5(${lit(key)} || '-a-' || g)::uuid, md5(${lit(key)} || '-n-' || g)::uuid, md5(${lit(key)} || '-p-' || g)::uuid,
           ${lit(locale)}, ${lit(key)} || '-' || g, substr(md5(${lit(key)} || '-sid-' || g), 1, 12), 'Bench article ' || g, 'Fixture body',
           CASE WHEN k = 'article_draft' THEN 'draft' ELSE 'published' END,
           CASE WHEN k = 'article_hidden' THEN (CASE WHEN g % 2 = 0 THEN 'hidden' ELSE 'seo_only' END) ELSE 'public' END,
           CASE WHEN k = 'article_draft' THEN NULL
                ELSE ${lit(BASE_PUBLISHED_AT)}::timestamptz + (((g::bigint * 104729) % 1000000) / 3) * interval '1 second' END,
           CASE WHEN k = 'article_deleted' THEN now() ELSE NULL END, now(), now()
    FROM (SELECT g, ${kind} AS k FROM ${series(segment)}) t
    WHERE k <> 'no_article'`);

  if (segment.autoShare > 0) {
    // 自动打标：autoShare 的书各有一次打标（run）+ 两个分类（偏斜分布，互不相同），标签状态 automatic 指向这次打标。
    await owner.$executeRawUnsafe(`
      INSERT INTO tag_classification_run (id, novel_id, method, taxonomy_version, taxonomy_sha256, keyword_lexicon_version, keyword_fingerprint,
                                          classifier_config_version, classifier_config_fingerprint, content_sha256, request_id)
      SELECT md5(${lit(key)} || '-run-' || g)::uuid, md5(${lit(key)} || '-n-' || g)::uuid, 'deterministic_text', 'bench', '${HASH_64}', 'bench',
             '${HASH_64}', 'bench', '${HASH_64}', '${HASH_64}', ${lit(key)} || '-req-' || g
      FROM generate_series(1, ${segment.novels}) AS g WHERE ${uniform(key, "auto")} < ${segment.autoShare}`);
    await owner.$executeRawUnsafe(`
      INSERT INTO novel_tag_state (novel_id, mode, current_auto_run_id, updated_at)
      SELECT md5(${lit(key)} || '-n-' || g)::uuid, 'automatic', md5(${lit(key)} || '-run-' || g)::uuid, now()
      FROM generate_series(1, ${segment.novels}) AS g WHERE ${uniform(key, "auto")} < ${segment.autoShare}`);
    await owner.$executeRawUnsafe(`
      INSERT INTO novel_canonical_tag (id, novel_id, canonical_tag_id, source, score, classification_run_id, updated_at)
      SELECT md5(${lit(key)} || '-t-' || g || '-' || n)::uuid, md5(${lit(key)} || '-n-' || g)::uuid,
             (ARRAY[${foundation.tagIds.map((id) => `'${id}'::uuid`).join(",")}])[
               CASE n WHEN 1 THEN t1 ELSE ((t1 + 1 + u2) % ${SCALE_TAG_COUNT}) END + 1],
             'auto', 20 + u3, md5(${lit(key)} || '-run-' || g)::uuid, now()
      FROM (
        SELECT g, floor(${SCALE_TAG_COUNT} * power(${uniform(key, "a1")}, 2.5))::int AS t1,
               floor((${SCALE_TAG_COUNT} - 2) * ${uniform(key, "a2")})::int AS u2,
               floor(80 * ${uniform(key, "a3")})::int AS u3
        FROM generate_series(1, ${segment.novels}) AS g WHERE ${uniform(key, "auto")} < ${segment.autoShare}
      ) picks CROSS JOIN generate_series(1, 2) AS n`);
  }
}

/** 灌数据（不含归属表）。返回规模摘要。 */
export async function seedScaleData(
  owner: PrismaClient,
  segments: readonly ScaleSeedSegment[] = PRODUCTION_LIKE_SEGMENTS,
): Promise<ScaleSeedResult> {
  const foundation = await seedFoundation(owner);
  const mappingEdges = await seedMappings(owner, foundation, segments);
  for (const segment of segments) await seedSegment(owner, foundation, segment);
  return {
    adminId: foundation.admin.id,
    channelAppId: foundation.app.id,
    tagIds: foundation.tagIds,
    segments: segments.map(({ key, locale, novels, visible }) => ({ key, locale, novels, visible })),
    mappingEdges,
  };
}

/** 灌完数据后统计信息要有，否则规划器的选择与生产不可比。 */
export async function analyzeScaleTables(owner: PrismaClient): Promise<void> {
  for (const table of [
    "novel", "novel_source_item", "source_label", "source_label_mapping", "novel_source_item_label", "promo_link", "article",
    "tag_classification_run", "novel_tag_state", "novel_canonical_tag", "canonical_tag", "canonical_tag_translation", "channel_app",
  ]) {
    await owner.$executeRawUnsafe(`ANALYZE ${table}`);
  }
  // 归属表（新代码才有）：存在才分析，旧代码的库里没有它。
  const [{ present }] = await owner.$queryRawUnsafe<Array<{ present: boolean }>>(
    "SELECT to_regclass('public.novel_effective_tag') IS NOT NULL AS present",
  );
  if (present) await owner.$executeRawUnsafe("ANALYZE novel_effective_tag");
}

/** 规模摘要（只读，用于打印）。 */
export async function describeScaleData(owner: PrismaClient): Promise<Record<string, number>> {
  const rows = await owner.$queryRawUnsafe<Array<{ name: string; n: number }>>(`
    SELECT 'novel' AS name, count(*)::int AS n FROM novel
    UNION ALL SELECT 'article', count(*)::int FROM article
    UNION ALL SELECT 'promo_link', count(*)::int FROM promo_link
    UNION ALL SELECT 'source_label_mapping', count(*)::int FROM source_label_mapping
    UNION ALL SELECT 'novel_canonical_tag', count(*)::int FROM novel_canonical_tag
    UNION ALL SELECT 'article_published', count(*)::int FROM article WHERE status = 'published' AND deleted_at IS NULL
    UNION ALL SELECT 'en_published_articles', count(*)::int FROM article WHERE locale = 'en' AND status = 'published' AND deleted_at IS NULL`);
  return Object.fromEntries(rows.map((row) => [row.name, Number(row.n)]));
}

async function main(): Promise<void> {
  const url = process.env.B38_SEED_DATABASE_URL;
  if (!url) throw new Error("B38_SEED_DATABASE_URL is required");
  const database = new URL(url).pathname.replace(/^\//, "");
  if (!database.startsWith("cps_novel_")) throw new Error(`refusing to seed database ${database}`);
  const owner = new PrismaClient({ datasourceUrl: url });
  try {
    const startedAt = Date.now();
    const result = await seedScaleData(owner);
    await analyzeScaleTables(owner);
    console.log(`B38_SCALE_SEED ok ms=${Date.now() - startedAt} mapping_edges=${result.mappingEdges} ${JSON.stringify(await describeScaleData(owner))}`);
  } finally {
    await owner.$disconnect();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "scale seed failed");
    process.exitCode = 1;
  });
}
