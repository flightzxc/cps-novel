/**
 * 规模类真实库用例共用的「批量公开文章」夹具（站点地图规模缺陷修复，2026-10-06）。
 *
 * 为什么不用 Prisma `create` 逐条造：两万量级的文章要带上完整的组合外键链路
 * （novel → novel_source_item → promo_link → article，其中 article → promo_link 是
 * `(promo_link_id, novel_id)` 组合外键），逐条 create 要几万次往返；这里用
 * `generate_series` 一条 SQL 一张表，几秒内灌完，并且走的是真实表约束（CHECK、唯一索引、外键），
 * 不是绕开约束的捷径。
 *
 * 所有 id / 唯一键都由 `prefix + 序号` 的 md5 派生，所以同一个 prefix 在同一个库里只能灌一次，
 * 不同 prefix 互不冲突；序号 1..count 同时写进 slug（`<prefix>-<序号>`），后面的「噪声」和「预期」
 * 都靠它定位，不依赖任何被测代码。
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

export type ChannelFixture = {
  readonly channelAppId: string;
  readonly channelAccountId: string;
};

export async function createChannelFixture(owner: PrismaClient): Promise<ChannelFixture> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const channel = await owner.channel.create({ data: { code: `scale-${suffix}`, name: "Scale fixture" } });
  const sourceApp = await owner.sourceApp.create({ data: { code: `scale-source-${suffix}`, name: "Scale source" } });
  const channelApp = await owner.channelApp.create({ data: {
    channelId: channel.id, sourceAppId: sourceApp.id, externalAppId: `scale-app-${suffix}`, projectType: 1,
  } });
  const account = await owner.channelAccount.create({ data: {
    channelId: channel.id, businessId: `scale-account-${suffix}`, accountName: "Scale account",
  } });
  return { channelAppId: channelApp.id, channelAccountId: account.id };
}

export type BulkPublicArticleInput = {
  /** 同一个库里每次调用必须不同；决定 id、slug、短码、业务号的派生。 */
  readonly prefix: string;
  readonly locale: string;
  readonly count: number;
  readonly channel: ChannelFixture;
  /** 第 i 篇文章的 `updated_at` = 基准时间 + i 秒（整秒，避免毫秒/微秒取整歧义）。 */
  readonly baseUpdatedAt: Date;
};

/** 每篇文章 = 一本已发布小说 + 一条 fetched 推广链接 + 一篇已发布文章，走真实组合外键。 */
export async function seedBulkPublicArticles(owner: PrismaClient, input: BulkPublicArticleInput): Promise<void> {
  const { prefix, locale, count, channel, baseUpdatedAt } = input;
  await owner.$executeRaw`
    INSERT INTO novel (id, business_id, title, description, cover_url, locale, slug, status, created_at, updated_at)
    SELECT md5(${prefix} || '-n-' || g)::uuid, ${prefix} || '-book-' || g, 'Scale book ' || g, 'Fixture',
           '/covers/' || g || '.webp', ${locale}, ${prefix} || '-' || g, 'published', now(), now()
    FROM generate_series(1, ${count}::int) AS g`;
  await owner.$executeRaw`
    INSERT INTO novel_source_item (id, channel_app_id, novel_id, external_book_id, source_language_code,
                                   title, description, status, raw_payload, created_at, updated_at)
    SELECT md5(${prefix} || '-s-' || g)::uuid, ${channel.channelAppId}::uuid, md5(${prefix} || '-n-' || g)::uuid,
           ${prefix} || '-ext-' || g, ${locale}, 'Scale book ' || g, 'Fixture', 'linked', '{}'::jsonb, now(), now()
    FROM generate_series(1, ${count}::int) AS g`;
  await owner.$executeRaw`
    INSERT INTO promo_link (id, novel_id, novel_source_item_id, channel_app_id, channel_account_id, offer_type,
                            public_redirect_code, idempotency_key, web_url, status, created_at, updated_at)
    SELECT md5(${prefix} || '-p-' || g)::uuid, md5(${prefix} || '-n-' || g)::uuid, md5(${prefix} || '-s-' || g)::uuid,
           ${channel.channelAppId}::uuid, ${channel.channelAccountId}::uuid, 'upstream_existing',
           'r' || substr(md5(${prefix} || '-c-' || g), 1, 20),
           md5(${prefix} || '-k1-' || g) || md5(${prefix} || '-k2-' || g),
           'https://promo.example/' || ${prefix} || '/' || g, 'fetched', now(), now()
    FROM generate_series(1, ${count}::int) AS g`;
  // article → promo_link 走 (promo_link_id, novel_id) 组合外键 article_promo_link_novel_fkey。
  await owner.$executeRaw`
    INSERT INTO article (id, novel_id, promo_link_id, locale, slug, public_page_short_id, title, body, status,
                         published_at, created_at, updated_at)
    SELECT md5(${prefix} || '-a-' || g)::uuid, md5(${prefix} || '-n-' || g)::uuid, md5(${prefix} || '-p-' || g)::uuid,
           ${locale}, ${prefix} || '-' || g, substr(md5(${prefix} || '-sid-' || g), 1, 12), 'Scale article ' || g,
           'Fixture body', 'published',
           ${baseUpdatedAt}::timestamptz + g * interval '1 second', now(),
           ${baseUpdatedAt}::timestamptz + g * interval '1 second'
    FROM generate_series(1, ${count}::int) AS g`;
}

/**
 * 噪声：序号 `g % 700 = k`（k = 0..6）的文章各以一种方式变成「不该进站点地图」——
 * 草稿文章 / 软删文章 / 小说未发布 / 小说软删 / 推广链接 pending / 推广地址纯空白 / 推广链接软删。
 * 前六种能被数据库侧的粗筛挡掉；只有「推广地址纯空白」（`not: ""` 放行、去空白后为空）必须靠应用层
 * 逐行复核才能排除——站点地图「DB 过滤是超集，应用层才权威」的纪律。
 */
export async function applyBulkNoise(owner: PrismaClient, input: { prefix: string; count: number }): Promise<void> {
  const { prefix, count } = input;
  // 一条 UPDATE 一种噪声；用 generate_series 反推 id，不需要先把序号读回应用层。
  await owner.$executeRaw`
    UPDATE article SET status = 'draft'
    WHERE id IN (SELECT md5(${prefix} || '-a-' || g)::uuid FROM generate_series(1, ${count}::int) AS g WHERE g % 700 = 1)`;
  await owner.$executeRaw`
    UPDATE article SET deleted_at = now()
    WHERE id IN (SELECT md5(${prefix} || '-a-' || g)::uuid FROM generate_series(1, ${count}::int) AS g WHERE g % 700 = 2)`;
  await owner.$executeRaw`
    UPDATE novel SET status = 'unpublished'
    WHERE id IN (SELECT md5(${prefix} || '-n-' || g)::uuid FROM generate_series(1, ${count}::int) AS g WHERE g % 700 = 3)`;
  await owner.$executeRaw`
    UPDATE novel SET deleted_at = now()
    WHERE id IN (SELECT md5(${prefix} || '-n-' || g)::uuid FROM generate_series(1, ${count}::int) AS g WHERE g % 700 = 4)`;
  await owner.$executeRaw`
    UPDATE promo_link SET status = 'pending'
    WHERE id IN (SELECT md5(${prefix} || '-p-' || g)::uuid FROM generate_series(1, ${count}::int) AS g WHERE g % 700 = 5)`;
  await owner.$executeRaw`
    UPDATE promo_link SET web_url = '   '
    WHERE id IN (SELECT md5(${prefix} || '-p-' || g)::uuid FROM generate_series(1, ${count}::int) AS g WHERE g % 700 = 6)`;
  await owner.$executeRaw`
    UPDATE promo_link SET deleted_at = now()
    WHERE id IN (SELECT md5(${prefix} || '-p-' || g)::uuid FROM generate_series(1, ${count}::int) AS g WHERE g % 700 = 0)`;
}

export type VisibleArticleRow = {
  id: string;
  slug: string;
  short_id: string;
  updated_at: Date;
  novel_id: string;
};

/**
 * 预期值的独立来源：用 SQL JOIN 直接按「公开可见」的业务定义取行（已发布、未软删、小说已发布且未软删、
 * 推广链接 fetched 且未软删且地址去空白后非空），按 `article.id` 升序——这是站点地图条目的排序依据。
 * 与被测代码（Prisma 关系加载 + 应用层复核）完全不共用实现。
 */
export async function oracleVisibleArticles(owner: PrismaClient, locale: string): Promise<VisibleArticleRow[]> {
  return owner.$queryRaw<VisibleArticleRow[]>`
    SELECT a.id::text AS id, a.slug, a.public_page_short_id AS short_id, a.updated_at, a.novel_id::text AS novel_id
    FROM article a
    JOIN novel n ON n.id = a.novel_id
    JOIN promo_link p ON p.id = a.promo_link_id AND p.novel_id = a.novel_id
    WHERE a.locale = ${locale} AND a.article_type = 'novel_article'
      AND a.status = 'published' AND a.deleted_at IS NULL
      AND n.status = 'published' AND n.deleted_at IS NULL
      AND p.status = 'fetched' AND p.deleted_at IS NULL
      AND (btrim(coalesce(p.web_url, '')) <> '' OR btrim(coalesce(p.app_url, '')) <> '')
    ORDER BY a.id`;
}

/**
 * 每本书 `chaptersPerNovel` 个可读章节（status = preview，带正文行，字数 > 0），章节号 1..n，
 * `updated_at` = 基准时间 + 书序号 秒（同一本书的各章相同，便于独立推算预期 lastmod）。
 */
export async function seedBulkPreviewChapters(owner: PrismaClient, input: {
  prefix: string; count: number; chaptersPerNovel: number; baseUpdatedAt: Date;
}): Promise<void> {
  const { prefix, count, chaptersPerNovel, baseUpdatedAt } = input;
  await owner.$executeRaw`
    INSERT INTO novel_chapter (id, novel_id, canonical_chapter_number, title, status, created_at, updated_at)
    SELECT md5(${prefix} || '-c-' || g || '-' || c)::uuid, md5(${prefix} || '-n-' || g)::uuid, c, 'Chapter ' || c,
           'preview', now(), ${baseUpdatedAt}::timestamptz + g * interval '1 second'
    FROM generate_series(1, ${count}::int) AS g, generate_series(1, ${chaptersPerNovel}::int) AS c`;
  await owner.$executeRaw`
    INSERT INTO novel_chapter_content (id, novel_chapter_id, body, char_count, content_hash, materialized_at,
                                       created_at, updated_at)
    SELECT md5(${prefix} || '-cc-' || g || '-' || c)::uuid, md5(${prefix} || '-c-' || g || '-' || c)::uuid,
           'Body of chapter ' || c, 24, md5(${prefix} || '-h-' || g || '-' || c) || md5(${prefix} || '-h2-' || g || '-' || c),
           now(), now(), now()
    FROM generate_series(1, ${count}::int) AS g, generate_series(1, ${chaptersPerNovel}::int) AS c`;
}

export type BulkCategory = { readonly slug: string; readonly displayName: string };

/**
 * 手工分类归属（`novel_tag_state.mode = 'manual'` + `novel_canonical_tag.source = 'manual'`，
 * 站点地图分类页走的公开归属之一）：序号 g 的书归 `categories[g % categories.length]`。
 */
export async function seedBulkManualCategories(owner: PrismaClient, input: {
  prefix: string; count: number; categories: readonly BulkCategory[];
}): Promise<Array<{ slug: string; id: string }>> {
  const { prefix, count, categories } = input;
  const created: Array<{ slug: string; id: string }> = [];
  for (const [index, category] of categories.entries()) {
    const tag = await owner.canonicalTag.create({ data: {
      stableId: `ct-v1-${prefix}-${category.slug}`, slug: category.slug, canonicalDefinition: "Fixture",
      sortOrder: index + 1, taxonomyVersion: "scale-fixture",
      translations: { create: [{ locale: "en", displayName: category.displayName }] },
    } });
    created.push({ slug: category.slug, id: tag.id });
  }
  const tagIds = created.map((tag) => tag.id);
  // 手工归属的真实约束：source = 'manual' 必须有 decided_by（admin_identity 外键）。
  const admin = await owner.adminIdentity.create({ data: {
    username: `scale-${prefix}-${randomUUID()}`, passwordHash: "scrypt$v1$test-only", sessionVersion: 1, role: "super_admin",
  } });
  await owner.$executeRaw`
    INSERT INTO novel_tag_state (novel_id, mode, revision, created_at, updated_at)
    SELECT md5(${prefix} || '-n-' || g)::uuid, 'manual', 0, now(), now()
    FROM generate_series(1, ${count}::int) AS g`;
  await owner.$executeRaw`
    INSERT INTO novel_canonical_tag (id, novel_id, canonical_tag_id, source, decided_by, evidence,
                                     created_at, updated_at, decided_at)
    SELECT md5(${prefix} || '-t-' || g)::uuid, md5(${prefix} || '-n-' || g)::uuid,
           (${tagIds}::uuid[])[(g % ${tagIds.length}::int) + 1], 'manual', ${admin.id}::uuid, '{}'::jsonb,
           now(), now(), now()
    FROM generate_series(1, ${count}::int) AS g`;
  return created;
}

/** 博客家族文章（无小说、无推广链接）：已发布，`updated_at` = 基准时间 + 序号 秒；序号 g % 50 = 0 的软删（噪声）。 */
export async function seedBulkBlogArticles(owner: PrismaClient, input: {
  prefix: string; locale: string; count: number; baseUpdatedAt: Date;
}): Promise<void> {
  const { prefix, locale, count, baseUpdatedAt } = input;
  await owner.$executeRaw`
    INSERT INTO article (id, novel_id, promo_link_id, locale, slug, public_page_short_id, title, body, status,
                         article_type, published_at, deleted_at, created_at, updated_at)
    SELECT md5(${prefix} || '-b-' || g)::uuid, NULL, NULL, ${locale}, ${prefix} || '-blog-' || g,
           substr(md5(${prefix} || '-bsid-' || g), 1, 12), 'Scale blog ' || g, 'Fixture body', 'published',
           'blog_article', ${baseUpdatedAt}::timestamptz + g * interval '1 second',
           CASE WHEN g % 50 = 0 THEN now() ELSE NULL END, now(),
           ${baseUpdatedAt}::timestamptz + g * interval '1 second'
    FROM generate_series(1, ${count}::int) AS g`;
}

export type VisibleBlogRow = { id: string; slug: string; updated_at: Date };

export async function oracleVisibleBlogArticles(owner: PrismaClient, locale: string): Promise<VisibleBlogRow[]> {
  return owner.$queryRaw<VisibleBlogRow[]>`
    SELECT id::text AS id, slug, updated_at FROM article
    WHERE locale = ${locale} AND novel_id IS NULL AND article_type <> 'novel_article'
      AND status = 'published' AND deleted_at IS NULL
    ORDER BY id`;
}

export type ListedArticleRow = { slug: string; id: string };

/**
 * 公开列表（首页 / 浏览 / 分类页共用的 `listPublicArticles`）的**独立预期**：先在库里按页面自己的 where 取
 * 「已发布、未软删、小说已发布且未软删、推广链接状态 fetched」，按 `published_at DESC, id ASC` 只取前
 * `cap` 条（`PUBLIC_LIST_CAP`），**然后**再在应用层去掉推广地址去空白后为空的行（`filterPromoReady`
 * 在截断之后才执行，所以被去掉的行不会让后面的书补位进来）。注意它**不**排除推广链接软删的行
 * （列表 where 没有这一条）——与 `oracleVisibleArticles`（站点地图候选口径）有意不同。
 * 与被测代码完全不共用实现。
 */
export async function oracleListedArticles(
  owner: PrismaClient,
  locale: string,
  cap: number,
): Promise<ListedArticleRow[]> {
  return owner.$queryRaw<ListedArticleRow[]>`
    SELECT slug, id FROM (
      SELECT a.slug, a.id::text AS id, a.published_at, p.web_url, p.app_url
      FROM article a
      JOIN novel n ON n.id = a.novel_id
      JOIN promo_link p ON p.id = a.promo_link_id AND p.novel_id = a.novel_id
      WHERE a.locale = ${locale} AND a.article_type = 'novel_article'
        AND a.status = 'published' AND a.deleted_at IS NULL
        AND n.status = 'published' AND n.deleted_at IS NULL
        AND p.status = 'fetched'
      ORDER BY a.published_at DESC, a.id ASC
      LIMIT ${cap}::int
    ) top
    WHERE btrim(coalesce(web_url, '')) <> '' OR btrim(coalesce(app_url, '')) <> ''
    ORDER BY published_at DESC, id ASC`;
}

export type ManualCategoryRange = {
  readonly slug: string;
  readonly displayName: string;
  /** 序号闭区间：序号落在任一区间里的书归这个分类（一本书可以同时归多个分类）。 */
  readonly ordinals: ReadonlyArray<readonly [from: number, to: number]>;
};

/**
 * 按序号区间指定归属的手工分类（与 `seedBulkManualCategories` 的「序号取模」互补：这里要精确控制
 * 「哪个分类的书落在最新 N 本之外」）。走同样的真实约束：`novel_tag_state.mode = 'manual'`、
 * `novel_canonical_tag.source = 'manual'` 且带 `decided_by`。`canonical_tag.updated_at` 统一回拨到 `tagUpdatedAt`，
 * 让站点地图 lastmod（取分类与归属文章 updatedAt 的最大值）由文章决定，而不是被「分类刚建好」的当前时间盖过。
 */
export async function seedManualCategoryRanges(owner: PrismaClient, input: {
  prefix: string;
  count: number;
  categories: readonly ManualCategoryRange[];
  tagUpdatedAt: Date;
}): Promise<Array<{ slug: string; id: string }>> {
  const { prefix, count, categories, tagUpdatedAt } = input;
  const admin = await owner.adminIdentity.create({ data: {
    username: `ranges-${prefix}-${randomUUID()}`, passwordHash: "scrypt$v1$test-only", sessionVersion: 1, role: "super_admin",
  } });
  await owner.$executeRaw`
    INSERT INTO novel_tag_state (novel_id, mode, revision, created_at, updated_at)
    SELECT md5(${prefix} || '-n-' || g)::uuid, 'manual', 0, now(), now()
    FROM generate_series(1, ${count}::int) AS g`;
  const created: Array<{ slug: string; id: string }> = [];
  for (const [index, category] of categories.entries()) {
    const tag = await owner.canonicalTag.create({ data: {
      stableId: `ct-v1-${prefix}-${category.slug}`, slug: category.slug, canonicalDefinition: "Fixture",
      sortOrder: index + 1, taxonomyVersion: "category-cap-fixture",
      translations: { create: [{ locale: "en", displayName: category.displayName }] },
    } });
    created.push({ slug: category.slug, id: tag.id });
    for (const [from, to] of category.ordinals) {
      await owner.$executeRaw`
        INSERT INTO novel_canonical_tag (id, novel_id, canonical_tag_id, source, decided_by, evidence,
                                         created_at, updated_at, decided_at)
        SELECT md5(${prefix} || '-t-' || ${category.slug} || '-' || g)::uuid, md5(${prefix} || '-n-' || g)::uuid,
               ${tag.id}::uuid, 'manual', ${admin.id}::uuid, '{}'::jsonb, now(), now(), now()
        FROM generate_series(${from}::int, ${to}::int) AS g`;
    }
  }
  await owner.$executeRaw`UPDATE canonical_tag SET updated_at = ${tagUpdatedAt}::timestamptz`;
  return created;
}

/**
 * 把**已经存在**的分类（`canonical_tag`，按 slug 找）按序号区间挂到另一批书上——同一个分类同时出现在两个语种里
 * （分类是全局的，归属是按书的）。与 `seedManualCategoryRanges` 的区别：不新建 `canonical_tag`，所以不会撞 slug 唯一约束。
 * 同样走真实约束：`novel_tag_state.mode = 'manual'`、`novel_canonical_tag.source = 'manual'` 且带 `decided_by`。
 * 用来构造"某分类在 A 语种窗口里有书、在 B 语种窗口里没有"这类语种错配场景。
 */
export async function seedExistingCategoryRanges(owner: PrismaClient, input: {
  prefix: string;
  count: number;
  categories: ReadonlyArray<{ readonly slug: string; readonly ordinals: ManualCategoryRange["ordinals"] }>;
}): Promise<void> {
  const { prefix, count, categories } = input;
  const admin = await owner.adminIdentity.create({ data: {
    username: `existing-${prefix}-${randomUUID()}`, passwordHash: "scrypt$v1$test-only", sessionVersion: 1, role: "super_admin",
  } });
  await owner.$executeRaw`
    INSERT INTO novel_tag_state (novel_id, mode, revision, created_at, updated_at)
    SELECT md5(${prefix} || '-n-' || g)::uuid, 'manual', 0, now(), now()
    FROM generate_series(1, ${count}::int) AS g`;
  for (const category of categories) {
    const tag = await owner.canonicalTag.findUniqueOrThrow({ where: { slug: category.slug }, select: { id: true } });
    for (const [from, to] of category.ordinals) {
      await owner.$executeRaw`
        INSERT INTO novel_canonical_tag (id, novel_id, canonical_tag_id, source, decided_by, evidence,
                                         created_at, updated_at, decided_at)
        SELECT md5(${prefix} || '-t-' || ${category.slug} || '-' || g)::uuid, md5(${prefix} || '-n-' || g)::uuid,
               ${tag.id}::uuid, 'manual', ${admin.id}::uuid, '{}'::jsonb, now(), now(), now()
        FROM generate_series(${from}::int, ${to}::int) AS g`;
    }
  }
}

/**
 * 独立预期：每个分类（slug）在**全部公开可见书目**（站点地图候选口径）里归属书的最大 `article.updated_at`。
 * 站点地图分类条目的 lastmod = max(分类 updatedAt, 这个值)。
 */
export async function oracleCategoryNewestArticleUpdate(
  owner: PrismaClient,
  locale: string,
): Promise<Map<string, Date>> {
  const rows = await owner.$queryRaw<Array<{ slug: string; newest: Date }>>`
    SELECT ct.slug, max(a.updated_at) AS newest
    FROM novel_canonical_tag nct
    JOIN canonical_tag ct ON ct.id = nct.canonical_tag_id AND ct.status = 'active'
    JOIN novel_tag_state nts ON nts.novel_id = nct.novel_id AND nts.mode = 'manual'
    JOIN article a ON a.novel_id = nct.novel_id
    JOIN novel n ON n.id = a.novel_id
    JOIN promo_link p ON p.id = a.promo_link_id AND p.novel_id = a.novel_id
    WHERE nct.source = 'manual'
      AND a.locale = ${locale} AND a.article_type = 'novel_article'
      AND a.status = 'published' AND a.deleted_at IS NULL
      AND n.status = 'published' AND n.deleted_at IS NULL
      AND p.status = 'fetched' AND p.deleted_at IS NULL
      AND (btrim(coalesce(p.web_url, '')) <> '' OR btrim(coalesce(p.app_url, '')) <> '')
    GROUP BY ct.slug`;
  return new Map(rows.map((row) => [row.slug, row.newest]));
}
