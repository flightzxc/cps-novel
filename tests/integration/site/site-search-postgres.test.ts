/**
 * PN-15 站内搜索·真实库用例（一次性 postgres:16.14，真实角色，真实 grants）。
 *
 * 全部搜索都用 **web_app** 角色连接执行（公开站读路径的真实身份）：新增的读语句没有漏授权，也是这条用例的一部分
 * （单元测试与复核都测不出角色权限，Lane E / L10N P5 两次同款事故）。
 *
 * 证明的事：
 *  1. 搜索结果 ⊆ 列表可见集合：对推广链接未就绪（含只有各种空白的地址）、seo_only / hidden（开关开）、文章与小说的
 *     下架 / 撤回 / 草稿 / 软删除、他语种、博客文章逐类构造反例；并与独立参照（Prisma `findMany` +
 *     `buildPublicListArticleWhere` + `isPromoReady`）逐 id 相等；
 *  2. LIKE 元字符 `%`、`_`、`\`、全角 `％` 按字面匹配（先归一再转义）；
 *  3. 两边 NFKC + lower：俄语大小写、法语重音、德语 Ü、泰语 "ำ"（U+0E33）、日语全角 / 半角；
 *  4. 分档次序（全等 → 开头 → 包含）与同档 `published_at DESC, id ASC`；阿语书名首尾的方向控制符仍进 1/2 档；
 *  5. 分页：总数、最后一页、越界页的总数、页码装不进安全整数。
 *
 * 运行：`bash scripts/run-site-search-postgres-verification.sh`（按文件写死期望用例数）。
 */
import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { queryPublicListIds } from "@/lib/site/public-list";
import { querySiteSearchPage } from "@/lib/site-search/search-query";
import { clearSiteSearchCacheForTest, searchSite, searchSiteCached } from "@/lib/site-search/site-search-service";
import { normalizeSearchInput } from "@/lib/site-search/query-normalizer";
import {
  assertIsolatedDatabase,
  connectRoles,
  disconnectRoles,
  enabled,
  resetDatabase,
  seedFoundation,
  type Foundation,
} from "../tagging/effective-tag-fixtures";
import { envFor, FIXTURE_SITES, referenceList, seedListScenario } from "./site-fixtures";

const roles = connectRoles();
const { owner, web, scheduler } = roles;

let foundation: Foundation;
let accountId = "";
let counter = 0;

type PromoSpec = Readonly<{ status: string; webUrl: string | null; appUrl: string | null }>;
const READY: PromoSpec = { status: "fetched", webUrl: "https://promo.example/read", appUrl: null };

type BookSpec = Readonly<{
  title: string;
  locale?: string;
  novelStatus?: string;
  novelDeleted?: boolean;
  articleStatus?: string;
  articleDeleted?: boolean;
  seoVisibility?: string;
  promo?: PromoSpec;
  publishedAt?: Date;
  /** 博客文章（无小说、无推广链接）。 */
  blog?: boolean;
  /** 指定文章编号（控制同档同时间的并列次序）。 */
  articleId?: string;
}>;

/** 造一本书：小说 + 书目 + 推广链接 + 文章（书名 = 文章标题）。返回文章编号。 */
async function seedBook(db: PrismaClient, spec: BookSpec): Promise<string> {
  counter += 1;
  const locale = spec.locale ?? "en";
  const articleId = spec.articleId ?? randomUUID();
  const status = spec.articleStatus ?? "published";
  const publishedAt = spec.publishedAt ?? (status === "published" ? new Date(Date.UTC(2026, 0, 1, 0, 0, counter)) : null);
  const base = {
    id: articleId,
    locale,
    slug: `pn15-${counter}-${articleId.slice(0, 8)}`,
    // 取编号的末 16 位：指定编号的夹具（控制并列次序）前缀相同、只有末几位不同。
    publicPageShortId: articleId.replaceAll("-", "").slice(-16),
    title: spec.title,
    body: "Body",
    status,
    seoVisibility: spec.seoVisibility ?? "public",
    publishedAt,
    deletedAt: spec.articleDeleted ? new Date() : null,
  };
  if (spec.blog) {
    await db.article.create({ data: { ...base, novelId: null, promoLinkId: null, articleType: "blog_article" } });
    return articleId;
  }
  const novelId = randomUUID();
  const sourceItemId = randomUUID();
  const promoLinkId = randomUUID();
  const promo = spec.promo ?? READY;
  await db.novel.create({
    data: {
      id: novelId, businessId: `pn15-${novelId}`, title: spec.title, description: "", locale, slug: `pn15-n-${counter}-${novelId.slice(0, 8)}`,
      status: spec.novelStatus ?? "published", deletedAt: spec.novelDeleted ? new Date() : null,
    },
  });
  await db.novelSourceItem.create({
    data: {
      id: sourceItemId, channelAppId: foundation.appActive, novelId, externalBookId: sourceItemId, sourceLocale: locale,
      sourceLanguageCode: `promo-${locale}`, rawLanguageScope: null, title: spec.title, description: "", status: "linked", rawPayload: {},
    },
  });
  await db.promoLink.create({
    data: {
      id: promoLinkId, novelId, novelSourceItemId: sourceItemId, channelAppId: foundation.appActive, channelAccountId: accountId,
      offerType: "cps", publicRedirectCode: `r${promoLinkId.replaceAll("-", "").slice(0, 20)}`,
      idempotencyKey: `${promoLinkId.replaceAll("-", "")}${promoLinkId.replaceAll("-", "")}`,
      status: promo.status, webUrl: promo.webUrl, appUrl: promo.appUrl,
    },
  });
  await db.article.create({ data: { ...base, novelId, promoLinkId, articleType: "novel_article" } });
  return articleId;
}

type SearchOptions = { locale?: string; limit?: number; offset?: number; env?: NodeJS.ProcessEnv };

/** 直接跑搜索 SQL（不经归一器——要测数据库一侧的归一与转义）。 */
async function sql(query: string, options: SearchOptions = {}) {
  return querySiteSearchPage(web, {
    query,
    locale: options.locale ?? "en",
    limit: options.limit ?? 20,
    offset: options.offset ?? 0,
    env: options.env ?? envFor({ seoVisibility: true }),
  });
}

/** 经归一器（页面真实路径）取全部命中（翻完所有页）。 */
async function allIdsViaNormalizer(rawQuery: string, locale = "en", env = envFor({ seoVisibility: true })): Promise<string[]> {
  const normalized = normalizeSearchInput(rawQuery, locale);
  if (!normalized.ok) throw new Error(`normalizer rejected ${JSON.stringify(rawQuery)}: ${normalized.reason}`);
  const ids: string[] = [];
  for (let offset = 0; ; offset += 20) {
    const page = await querySiteSearchPage(web, { query: normalized.query, locale, limit: 20, offset, env });
    ids.push(...page.ids);
    if (page.ids.length < 20) return ids;
  }
}

async function titlesOf(ids: readonly string[]): Promise<string[]> {
  const rows = await owner.article.findMany({ where: { id: { in: [...ids] } }, select: { id: true, title: true } });
  const byId = new Map(rows.map((row) => [row.id, row.title]));
  return ids.map((id) => byId.get(id)!);
}

/** 独立的"分档"参照（不共用被测 SQL）：书名去首尾空白 / 方向控制符 + NFKC + 小写之后与搜索词比较。 */
function jsTier(title: string, query: string): 1 | 2 | 3 {
  const fold = (value: string) => value.normalize("NFKC").toLowerCase();
  const trimmed = fold(title.replace(/^[\s\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+|[\s\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+$/gu, ""));
  const q = fold(query);
  return trimmed === q ? 1 : trimmed.startsWith(q) ? 2 : 3;
}

describe.skipIf(!enabled).sequential("PN-15 站内搜索（真实库、真实 web_app 角色）", () => {
  beforeAll(async () => {
    await assertIsolatedDatabase(owner);
    await resetDatabase(owner);
    foundation = await seedFoundation(owner);
    const account = await owner.channelAccount.create({
      data: { channelId: foundation.channel, businessId: `pn15-${randomUUID()}`, accountName: "pn15 account", status: "active" },
    });
    accountId = account.id;
    clearSiteSearchCacheForTest();
  }, 240_000);

  afterAll(async () => {
    await disconnectRoles(roles);
  });

  it("角色身份：搜索用的是 web_app；scheduler_app 没有读书名的权限（最小权限没有被放宽）", async () => {
    expect(await web.$queryRaw`SELECT current_user AS role`).toEqual([{ role: "web_app" }]);
    await expect(
      querySiteSearchPage(scheduler, { query: "anything", locale: "en", limit: 20, offset: 0, env: envFor({}) }),
    ).rejects.toThrow(/permission denied/i);
  });

  // 🔴 必须排在其它造书的用例之前：`seedListScenario` 给库里**所有**小说各造三个语种的文章，
  // 库里已有别的用例造的书时会撞 (novel_id, locale) 唯一键。
  describe("随机夹具（B-38 的混合夹具）：对三个语种 × 两种开关，搜索 === 列表可见集合里书名匹配的那些", () => {
    beforeAll(async () => {
      await seedListScenario(owner, foundation, { novels: 220, seed: 20_261_209 });
    }, 240_000);

    it.each(FIXTURE_SITES.flatMap((locale) => [true, false].map((seo) => [locale, seo] as const)))(
      "%s · SEO 可见性 %s",
      async (locale, seo) => {
        const env = envFor({ seoVisibility: seo });
        const query = `b38 article ${locale}`;
        const found = await allIdsViaNormalizer(query, locale, env);
        const reference = await referenceList(owner, locale, env);
        const refTitles = new Map((await owner.article.findMany({ where: { id: { in: reference.map((card) => card.articleId) } }, select: { id: true, title: true } })).map((row) => [row.id, row.title]));
        const expected = reference
          .map((card) => card.articleId)
          .filter((id) => refTitles.get(id)!.toLowerCase().includes(query));
        // 这个夹具的参照列表本身有序（发布时间降序、编号升序），书名都以搜索词开头（同一档），所以顺序也应逐个相等。
        expect(found.length).toBeGreaterThan(5);
        expect(found).toEqual(expected);
        const listed = new Set(await queryPublicListIds(web, { locale, limit: 100_000, offset: 0, env }));
        for (const id of found) expect(listed.has(id)).toBe(true);
      },
      120_000,
    );
  });

  describe("搜索结果 ⊆ 列表可见集合：逐类反例，并与独立参照逐 id 相等", () => {
    const MARK = "qvisib";
    // [标签, 书的规格, 开关关时是否可见, 开关开时是否可见]
    const SPECS: ReadonlyArray<readonly [label: string, spec: Omit<BookSpec, "title">, visibleSeoOff: boolean, visibleSeoOn: boolean]> = [
      ["baseline", {}, true, true],
      ["promo-pending", { promo: { status: "pending", webUrl: null, appUrl: null } }, false, false],
      ["promo-failed", { promo: { status: "failed", webUrl: "https://promo.example/failed", appUrl: null } }, false, false],
      ["promo-disabled", { promo: { status: "registered_disabled", webUrl: "https://promo.example/d", appUrl: null } }, false, false],
      ["promo-empty-both", { promo: { status: "fetched", webUrl: "", appUrl: "" } }, false, false],
      ["promo-null-both", { promo: { status: "fetched", webUrl: null, appUrl: null } }, false, false],
      ["promo-blank-spaces", { promo: { status: "fetched", webUrl: "   ", appUrl: null } }, false, false],
      ["promo-blank-unicode", { promo: { status: "fetched", webUrl: "\u3000\ufeff\u00a0", appUrl: "\t\n" } }, false, false],
      ["promo-blank-one-space-each", { promo: { status: "fetched", webUrl: " ", appUrl: " " } }, false, false],
      ["promo-u180e-only", { promo: { status: "fetched", webUrl: "\u180e", appUrl: null } }, true, true],
      ["promo-app-only", { promo: { status: "fetched", webUrl: null, appUrl: "https://app.example/read" } }, true, true],
      ["promo-padded-url", { promo: { status: "fetched", webUrl: "  https://padded.example/read \t", appUrl: null } }, true, true],
      ["seo-only", { seoVisibility: "seo_only" }, true, false],
      ["seo-hidden", { seoVisibility: "hidden" }, true, false],
      ["article-draft", { articleStatus: "draft" }, false, false],
      ["article-unpublished", { articleStatus: "unpublished" }, false, false],
      ["article-takedown", { articleStatus: "takedown" }, false, false],
      ["article-deleted", { articleDeleted: true }, false, false],
      ["novel-draft", { novelStatus: "draft" }, false, false],
      ["novel-ready", { novelStatus: "ready" }, false, false],
      ["novel-unpublished", { novelStatus: "unpublished" }, false, false],
      ["novel-takedown", { novelStatus: "takedown" }, false, false],
      ["novel-deleted", { novelDeleted: true }, false, false],
      ["other-locale-es", { locale: "es" }, false, false],
      ["blog-article", { blog: true }, false, false],
    ];
    const ids = new Map<string, string>();

    beforeAll(async () => {
      for (const [label, spec] of SPECS) ids.set(label, await seedBook(owner, { ...spec, title: `${MARK} ${label}` }));
    }, 120_000);

    it.each([
      ["SEO 可见性开关关", false],
      ["SEO 可见性开关开", true],
    ])("%s：搜索结果恰好是列表可见的那些（每个反例逐个断言）", async (_name, seo) => {
      const env = envFor({ seoVisibility: seo });
      const found = new Set((await sql(MARK, { env })).ids);
      for (const [label, , visibleOff, visibleOn] of SPECS) {
        const expected = seo ? visibleOn : visibleOff;
        expect(found.has(ids.get(label)!), `${label} 应${expected ? "可见" : "不可见"}`).toBe(expected);
      }
      // 独立参照：Prisma findMany + buildPublicListArticleWhere + isPromoReady。
      const reference = (await referenceList(owner, "en", env)).map((card) => card.articleId);
      const marked = new Set([...ids.values()]);
      expect(new Set(reference.filter((id) => marked.has(id)))).toEqual(found);
      // 与列表页同一条 SQL 的可见集合（queryPublicListIds）：搜索结果是它的子集。
      const listed = new Set(await queryPublicListIds(web, { locale: "en", limit: 100_000, offset: 0, env }));
      for (const id of found) expect(listed.has(id)).toBe(true);
    });

    it("他语种书用对应语种的搜索能搜到，英语搜不到；博客文章在任何语种都搜不到", async () => {
      const es = await sql(MARK, { locale: "es", env: envFor({ seoVisibility: true }) });
      expect(es.ids).toEqual([ids.get("other-locale-es")]);
      const blog = ids.get("blog-article")!;
      for (const locale of ["en", "es", "ko"]) expect((await sql(MARK, { locale })).ids).not.toContain(blog);
    });
  });

  describe("LIKE 元字符按字面匹配（先归一再转义）", () => {
    const MARK = "qspecl";
    const ids: Record<string, string> = {};
    beforeAll(async () => {
      const titles: Record<string, string> = {
        percent: `${MARK} 100% Sweet`,
        noPercent: `${MARK} 100 Sweet`,
        fullPercent: `${MARK} 100％ Salty`,
        underscore: `${MARK} a_b`,
        x: `${MARK} axb`,
        backslash: `${MARK} back\\slash`,
        trailing: `${MARK} trailing\\`,
        quote: `${MARK} it's "quoted"`,
      };
      for (const [key, title] of Object.entries(titles)) ids[key] = await seedBook(owner, { title });
    }, 120_000);

    it("'%' 不是通配符：'qspecl 100%' 只命中真含 % 的两本（半角与全角书名），不命中 '100 Sweet'", async () => {
      const found = (await sql(`${MARK} 100%`)).ids;
      expect(new Set(found)).toEqual(new Set([ids.percent, ids.fullPercent]));
    });

    it("'%' 单独做后缀也不是通配符：'qspecl %' 零命中", async () => {
      expect((await sql(`${MARK} %`)).ids).toEqual([]);
    });

    it("'_' 不是单字符通配符：'qspecl a_b' 只命中 'a_b'，不命中 'axb'；'qspecl _' 零命中", async () => {
      expect((await sql(`${MARK} a_b`)).ids).toEqual([ids.underscore]);
      expect((await sql(`${MARK} _`)).ids).toEqual([]);
    });

    it("反斜杠按字面：'qspecl back\\sl' 命中 'back\\slash'；搜索词以反斜杠结尾不报 LIKE 错误并命中书名末尾的反斜杠", async () => {
      expect((await sql(`${MARK} back\\sl`)).ids).toEqual([ids.backslash]);
      expect((await sql(`${MARK} trailing\\`)).ids).toEqual([ids.trailing]);
      // 反斜杠不是转义前缀：'qspecl \\'（空格 + 反斜杠）不出现在任何书名里，零命中，也不报错。
      expect((await sql(`${MARK} \\`)).ids).toEqual([]);
    });

    it("全角 '％'（U+FF05）在搜索词里先 NFKC 成 '%' 再转义：搜 'qspecl 100％' 与搜 'qspecl 100%' 结果相同", async () => {
      const half = new Set((await sql(`${MARK} 100%`)).ids);
      const full = new Set((await sql(`${MARK} 100％`)).ids);
      expect(full).toEqual(half);
      expect(full.size).toBe(2);
    });

    it("经归一器（页面真实路径）同样：全角 '％'、引号、注入式字符串都只是字面", async () => {
      expect(new Set(await allIdsViaNormalizer(`${MARK} 100％`))).toEqual(new Set([ids.percent, ids.fullPercent]));
      expect(await allIdsViaNormalizer(`${MARK} it's "quoted"`)).toEqual([ids.quote]);
      expect(await allIdsViaNormalizer(`${MARK} ' OR 1=1 --`)).toEqual([]);
      expect(await allIdsViaNormalizer(`${MARK}'; DROP TABLE article; --`)).toEqual([]);
      expect(await owner.article.count()).toBeGreaterThan(0);
    });
  });

  describe("两边 NFKC + 小写折叠", () => {
    it("俄语大小写：'АЛЬФА' 与 'альфа' 命中相同（书名 'Альфа Король'）", async () => {
      const id = await seedBook(owner, { title: "qfolds Альфа Король" });
      for (const query of ["qfolds АЛЬФА", "qfolds альфа", "qfolds Альфа КОРОЛЬ"]) {
        expect(await allIdsViaNormalizer(query, "en"), query).toEqual([id]);
      }
    });

    it("法语重音：'ÉTÉ' 与 'été' 命中相同；德语 'ÜBER' 与 'über' 命中相同", async () => {
      const fr = await seedBook(owner, { title: "qfolds Été Français" });
      const de = await seedBook(owner, { title: "qfolds Über alles" });
      for (const query of ["qfolds ÉTÉ", "qfolds été", "QFOLDS ÉTÉ FRANÇAIS"]) {
        expect(await allIdsViaNormalizer(query), query).toEqual([fr]);
      }
      for (const query of ["qfolds ÜBER", "qfolds über"]) {
        expect(await allIdsViaNormalizer(query), query).toEqual([de]);
      }
    });

    it("泰语 '\u0e17\u0e33'（书名含 U+0E33）：照着书名打字能搜到；书名已是分解形态（U+0E4D U+0E32）的也能搜到", async () => {
      // 🔴 用 \\u 转义写，不要贴成字面泰文：U+0E33（ำ）与 U+0E4D U+0E32（ํา）肉眼看起来几乎一样，贴字面等于看不出夹具在测什么。
      const composed = await seedBook(owner, { title: "qthaix \u0e17\u0e33\u0e44\u0e21\u0e15\u0e49\u0e2d\u0e07\u0e23\u0e31\u0e01", locale: "th" });
      const decomposed = await seedBook(owner, { title: "qthaix \u0e17\u0e4d\u0e32\u0e44\u0e21", locale: "th" });
      const other = await seedBook(owner, { title: "qthaix \u0e04\u0e27\u0e32\u0e21\u0e23\u0e31\u0e01", locale: "th" });
      expect(composed).not.toBe(decomposed);
      const found = await allIdsViaNormalizer("qthaix \u0e17\u0e33", "th");
      expect(new Set(found)).toEqual(new Set([composed, decomposed]));
      expect(found).not.toContain(other);
      // 数据库一侧直接给未归一的 U+0E33 也行（两边都在数据库里归一）。
      expect(new Set((await sql("qthaix \u0e17\u0e33", { locale: "th" })).ids)).toEqual(new Set([composed, decomposed]));
      // 书名里的 U+0E33 没有被拆开（夹具确实存在"书名未归一"的情形）。
      const stored = await owner.article.findUniqueOrThrow({ where: { id: composed }, select: { title: true } });
      expect(stored.title.includes("\u0e33")).toBe(true);
    });

    it("日语全角 / 半角：'ＡＢＣ' 与 'abc'、半角 'ｱｲｳ' 与 'アイウ' 互相命中", async () => {
      const fullLatin = await seedBook(owner, { title: "qjapan ＡＢＣ小説", locale: "ja" });
      const halfLatin = await seedBook(owner, { title: "qjapan ABC小説", locale: "ja" });
      const halfKana = await seedBook(owner, { title: "qjapan ｱｲｳ", locale: "ja" });
      const fullKana = await seedBook(owner, { title: "qjapan アイウ", locale: "ja" });
      for (const query of ["qjapan abc", "qjapan ＡＢＣ", "QJAPAN ABC小説"]) {
        expect(new Set(await allIdsViaNormalizer(query, "ja")), query).toEqual(new Set([fullLatin, halfLatin]));
      }
      for (const query of ["qjapan アイウ", "qjapan ｱｲｳ"]) {
        expect(new Set(await allIdsViaNormalizer(query, "ja")), query).toEqual(new Set([halfKana, fullKana]));
      }
    });

    it("日语单个汉字（zh/ja/ko 放行）经服务层：'愛' 在 ja 搜到，分档 全等 → 开头 → 包含", async () => {
      const base = new Date(Date.UTC(2026, 3, 1));
      const exact = await seedBook(owner, { title: "愛", locale: "ja", publishedAt: new Date(base.getTime() + 1000) });
      const prefix = await seedBook(owner, { title: "愛の物語", locale: "ja", publishedAt: new Date(base.getTime() + 3000) });
      const contains = await seedBook(owner, { title: "切ない愛", locale: "ja", publishedAt: new Date(base.getTime() + 5000) });
      clearSiteSearchCacheForTest();
      const result = await searchSite({ query: "愛", locale: "ja" }, web, { env: envFor({ seoVisibility: true }) });
      expect(result.status).toBe("ok");
      expect(result.totalCount).toBe(3);
      expect(result.items.map((card) => card.title)).toEqual(["愛", "愛の物語", "切ない愛"]);
      expect(new Set([exact, prefix, contains]).size).toBe(3);
    });
  });

  describe("分档次序与同档排序", () => {
    it("阿语书名首尾的方向 / 零宽控制符与空白不挡分档：全等进 1 档、开头进 2 档、包含进 3 档（即使 3 档最新）", async () => {
      const MARK = "qarabi";
      const query = `${MARK} حب`;
      const t1 = await seedBook(owner, { title: `\u200f\u202b${MARK} حب\u202c\u200f`, publishedAt: new Date(Date.UTC(2026, 4, 1)) });
      const t1b = await seedBook(owner, { title: `  \u200e${MARK} حب \u2067 `, publishedAt: new Date(Date.UTC(2026, 4, 2)) });
      const t2 = await seedBook(owner, { title: `\u200f${MARK} حب الأبد`, publishedAt: new Date(Date.UTC(2026, 4, 3)) });
      const t3 = await seedBook(owner, { title: `أحب ${MARK} حب`, publishedAt: new Date(Date.UTC(2026, 4, 4)) });
      const found = (await sql(query)).ids;
      expect(found).toEqual([t1b, t1, t2, t3]); // 1 档内较新的在前；整体 1 → 2 → 3
    });

    it("分档 → 发布时间新→旧 → 编号升序（并列的发布时间用指定编号造，与独立的 JS 参照逐个比较）", async () => {
      const MARK = "qtiers";
      const query = `${MARK} moon`;
      const d = (minutes: number) => new Date(Date.UTC(2026, 5, 1, 0, minutes));
      const specs: Array<{ title: string; minutes: number; id: string }> = [
        { title: `${MARK} moon`, minutes: 1, id: "00000000-0000-4000-8000-000000000a01" },
        { title: `  ${MARK.toUpperCase()} MOON  `, minutes: 9, id: "00000000-0000-4000-8000-000000000a02" },
        { title: `${MARK} moon rising`, minutes: 5, id: "00000000-0000-4000-8000-000000000a03" },
        { title: `${MARK} moonlight`, minutes: 5, id: "00000000-0000-4000-8000-000000000a04" },
        { title: `${MARK} moon again`, minutes: 5, id: "00000000-0000-4000-8000-000000000a00" },
        { title: `${MARK} moon late`, minutes: 20, id: "00000000-0000-4000-8000-000000000a05" },
        { title: `the ${MARK} moon`, minutes: 30, id: "00000000-0000-4000-8000-000000000a06" },
        { title: `a ${MARK} moon story`, minutes: 30, id: "00000000-0000-4000-8000-000000000a07" },
        { title: `old ${MARK} moon`, minutes: 2, id: "00000000-0000-4000-8000-000000000a08" },
      ];
      for (const spec of specs) await seedBook(owner, { title: spec.title, publishedAt: d(spec.minutes), articleId: spec.id });
      const expected = [...specs]
        .sort((a, b) => jsTier(a.title, query) - jsTier(b.title, query) || d(b.minutes).getTime() - d(a.minutes).getTime() || (a.id < b.id ? -1 : 1))
        .map((spec) => spec.id);
      expect((await sql(query)).ids).toEqual(expected);
      // 并列处确实被造出来了：同档同时间的三本（minutes=5 的 a00 / a03 / a04）按编号升序。
      const fives = expected.filter((id) => ["a00", "a03", "a04"].some((suffix) => id.endsWith(suffix)));
      expect(fives.map((id) => id.slice(-3))).toEqual(["a00", "a03", "a04"]);
    });
  });

  describe("分页：总数、最后一页、越界页、巨大页码", () => {
    const MARK = "qpages";
    let expectedOrder: string[] = [];

    beforeAll(async () => {
      const specs: Array<{ title: string; publishedAt: Date; id: string }> = [];
      for (let index = 0; index < 45; index += 1) {
        // 发布时间每 3 本并列一次，制造同档并列。
        specs.push({
          title: index % 9 === 8 ? `the ${MARK} book ${index}` : `${MARK} book ${index}`,
          publishedAt: new Date(Date.UTC(2026, 6, 1, 0, Math.floor(index / 3))),
          id: `00000000-0000-4000-8000-0000000b${String(index).padStart(4, "0")}`,
        });
      }
      for (const spec of specs) await seedBook(owner, { title: spec.title, publishedAt: spec.publishedAt, articleId: spec.id });
      expectedOrder = [...specs]
        .sort((a, b) => jsTier(a.title, MARK) - jsTier(b.title, MARK) || b.publishedAt.getTime() - a.publishedAt.getTime() || (a.id < b.id ? -1 : 1))
        .map((spec) => spec.id);
    }, 120_000);

    it("45 本命中：三页 20 / 20 / 5，每页总数都是 45，拼起来恰好是全部且无重复、次序稳定", async () => {
      const pages = [await sql(MARK, { offset: 0 }), await sql(MARK, { offset: 20 }), await sql(MARK, { offset: 40 })];
      expect(pages.map((page) => page.ids.length)).toEqual([20, 20, 5]);
      expect(pages.map((page) => page.total)).toEqual([45, 45, 45]);
      const all = pages.flatMap((page) => page.ids);
      expect(new Set(all).size).toBe(45);
      expect(all).toEqual(expectedOrder);
      // 再取一遍：次序不漂移（翻页稳定）。
      expect((await sql(MARK, { offset: 20 })).ids).toEqual(expectedOrder.slice(20, 40));
    });

    it("越界页：本页无行，补一条计数拿到真实总数 45（页面据此判 404）", async () => {
      const page = await sql(MARK, { offset: 60 });
      expect(page).toEqual({ ids: [], total: 45 });
      expect(await sql(MARK, { offset: 1000 })).toEqual({ ids: [], total: 45 });
    });

    it("零命中：第 1 页总数 0；越界页总数 0", async () => {
      expect(await sql("qpages-no-such-book")).toEqual({ ids: [], total: 0 });
      expect(await sql("qpages-no-such-book", { offset: 20 })).toEqual({ ids: [], total: 0 });
    });

    it("页码装不进安全整数：不发编号查询（数据库的 OFFSET 装不下），只数总数", async () => {
      expect(await sql(MARK, { offset: (10 ** 19 - 1) * 20 })).toEqual({ ids: [], total: 45 });
      expect(await sql(MARK, { offset: Number.MAX_SAFE_INTEGER + 2 })).toEqual({ ids: [], total: 45 });
    });

    it("经服务层（归一 + 查询 + 补全卡片）：第 3 页 5 本、总页数 3；第 4 页空且总页数仍是 3", async () => {
      clearSiteSearchCacheForTest();
      const env = envFor({ seoVisibility: true });
      const third = await searchSite({ query: `  ${MARK}  `, locale: "en", page: 3 }, web, { env });
      expect(third).toMatchObject({ status: "ok", totalCount: 45, totalPages: 3, page: 3, pageSize: 20, displayQuery: MARK });
      expect(third.items).toHaveLength(5);
      const fourth = await searchSite({ query: MARK, locale: "en", page: 4 }, web, { env });
      expect(fourth).toMatchObject({ status: "ok", totalCount: 45, totalPages: 3, page: 4, items: [] });
      const huge = await searchSite({ query: MARK, locale: "en", page: 10 ** 19 }, web, { env });
      expect(huge).toMatchObject({ status: "ok", totalCount: 45, totalPages: 3, items: [] });
    });

    it("经带缓存的入口：同一页第二次不再查库（结果一致）", async () => {
      clearSiteSearchCacheForTest();
      const env = envFor({ seoVisibility: true });
      const first = await searchSiteCached({ query: MARK, locale: "en", page: 1 }, web, { env });
      const second = await searchSiteCached({ query: MARK, locale: "en", page: 1 }, web, { env });
      expect(second).toBe(first);
      expect(first.items.map((card) => card.title)).toEqual(await titlesOf(expectedOrder.slice(0, 20)));
    });
  });

  describe("只搜书名", () => {
    it("小说简介 / 作者里有搜索词但书名没有：搜不到", async () => {
      const id = await seedBook(owner, { title: "qtitle only here" });
      const row = await owner.article.findUniqueOrThrow({ where: { id }, select: { novelId: true } });
      await owner.novel.update({ where: { id: row.novelId! }, data: { description: "qdescription-word", author: "qauthor-word" } });
      await owner.article.update({ where: { id }, data: { summary: "qsummary-word", body: "qbody-word" } });
      for (const word of ["qdescription-word", "qauthor-word", "qsummary-word", "qbody-word"]) {
        expect((await sql(word)).ids, word).toEqual([]);
      }
      expect((await sql("qtitle only")).ids).toEqual([id]);
    });
  });
});
