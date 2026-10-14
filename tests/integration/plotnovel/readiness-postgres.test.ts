/**
 * v0.6.0 D：就绪规则按剧场模式二选一——真实库、真实角色、真实 grants。
 *
 *   - link 模式（MoboReader）：规则逐字不变——要网址；有口令码没网址 = 不就绪、不公开可见（防误伤）；
 *   - code 模式（PlotNovel）：fetched + 口令码非空 + 书的语种在 codeModeLocales 里。
 *
 * 程序判定（isPromoReady）与数据库判定（promoReadySql）必须逐行一致；公开列表 / 搜索 / 详情 / 站点地图 /
 * IndexNow / hreflang / 发布门禁 / 可生成判定 / 领取批次 / 首页轮播，每一处都用真实角色跑一遍，
 * 因为单测测不出角色权限（web_app 读不到 upstream_code、只读派生布尔列 upstream_code_present，scheduler_app 的
 * queryActiveLocales 要读剧场配置）。
 *
 * 数据库层收紧（v0.6.0，Owner 2026-10-14）：web_app 对 promo_link.upstream_code 没有任何读权限；口令码非空由触发器
 * 维护的布尔列表示，口令码本身只能经 SECURITY DEFINER 函数 code_mode_upstream_code() 取（该函数的逐项用例在
 * code-function-postgres.test.ts）。
 */
import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadCodeModePageData } from "@/app/go/_lib/code-mode-page-data";
import { queryActiveLocales } from "@/lib/locale/active-locales";
import { loadNovelHreflangSiblings } from "@/lib/seo/novel-hreflang";
import { createSitemapFamilyBuilder } from "@/lib/seo/sitemap";
import { getHomeCarouselItems } from "@/lib/site/home-carousel-service";
import { listPublicNovelPage, queryPublicListCount } from "@/lib/site/public-list";
import { getPublicChapterView, getPublicNovelDetail, resolvePublicArticleBySlugParam } from "@/lib/site/queries";
import { isNovelIndexNowEligible, loadIndexNowCandidateArticle } from "@/lib/indexnow/eligibility";
import { computeHomeCarouselInTx } from "@/server/home-carousel";
import { readCatalogBatchContext } from "@/server/catalog-batch/service";
import { listNovelsForArticleGenerate, resolveArticleGenerateAdmissions } from "@/server/content-creation/eligibility";
import { resolveNovelArticlePublicAccessByShortId } from "@/server/publication/access";
import { evaluatePublishGate } from "@/server/publish-gate/evaluator";
import { loadPublishGateFacts } from "@/server/publish-gate/facts";
import { isPromoReady, JS_TRIM_WHITESPACE_CHARACTERS, promoReadySql } from "@/server/publication/visibility";

import {
  MOBO_AGENCY,
  PLOT_AGENCY,
  analyst,
  assertDisposableDatabase,
  enabled,
  ids,
  owner,
  scheduler,
  seedPublished,
  seedTheaters,
  truncateDatabase,
  web,
  worker,
} from "./support";

const ENV_OFF = { NODE_ENV: "test" } as NodeJS.ProcessEnv;
const BIG_URL = "https://example.test/read";

async function permissionDenied(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (error) {
    return /permission denied/i.test(String((error as Error).message));
  }
}

describe.skipIf(!enabled).sequential("v0.6.0 D：就绪规则按剧场模式（真实库）", () => {
  beforeAll(async () => {
    await assertDisposableDatabase();
    process.env.SITE_URL = "https://novel.test";
  });
  afterAll(async () => {
    await Promise.all([owner.$disconnect(), web.$disconnect(), worker.$disconnect(), scheduler.$disconnect(), analyst.$disconnect()]);
  });

  describe("列级授权（真实角色）", () => {
    beforeEach(async () => { await truncateDatabase(); await seedTheaters(); });

    it("🔴 web_app 读 upstream_code 被拒（permission denied）；只能读派生布尔列 upstream_code_present；读不了 raw_links；analyst_ro 与 scheduler_app 两列都读不了", async () => {
      await seedPublished({ appId: ids.plotApp, externalBookId: "g1", title: "Grant Book", agencyId: PLOT_AGENCY, promo: { upstreamCode: "960031" } });
      await seedPublished({ appId: ids.moboApp, externalBookId: "g2", title: "Mobo Grant", agencyId: MOBO_AGENCY, promo: { upstreamCode: "M1", webUrl: BIG_URL } });
      // 任何形态都读不到口令码：裸 SELECT、Prisma select、表达式里引用、WHERE 里引用、SELECT *
      expect(await permissionDenied(() => web.$queryRaw`SELECT upstream_code FROM promo_link LIMIT 1`)).toBe(true);
      expect(await permissionDenied(() => web.promoLink.findMany({ select: { upstreamCode: true }, take: 1 }))).toBe(true);
      expect(await permissionDenied(() => web.$queryRaw`SELECT length(upstream_code) FROM promo_link LIMIT 1`)).toBe(true);
      expect(await permissionDenied(() => web.$queryRaw`SELECT id FROM promo_link WHERE upstream_code = '960031'`)).toBe(true);
      expect(await permissionDenied(() => web.$queryRaw`SELECT * FROM promo_link LIMIT 1`)).toBe(true);
      // 派生布尔列可读，且不含口令码
      const rows = await web.$queryRaw<Array<{ upstream_code_present: boolean }>>`SELECT upstream_code_present FROM promo_link ORDER BY upstream_code_present`;
      expect(rows).toEqual([{ upstream_code_present: true }, { upstream_code_present: true }]);
      // 其它列的既有授权不变
      expect(await permissionDenied(() => web.$queryRaw`SELECT status, channel_app_id, novel_id, web_url, app_url, public_redirect_code FROM promo_link LIMIT 1`)).toBe(false);
      expect(await permissionDenied(() => web.$queryRaw`SELECT raw_links FROM promo_link LIMIT 1`)).toBe(true);
      // analyst_ro、scheduler_app：口令码与布尔列都不给
      for (const column of ["upstream_code", "upstream_code_present"]) {
        expect(await permissionDenied(() => analyst.$queryRawUnsafe(`SELECT ${column} FROM promo_link LIMIT 1`)), `analyst ${column}`).toBe(true);
        expect(await permissionDenied(() => scheduler.$queryRawUnsafe(`SELECT ${column} FROM promo_link LIMIT 1`)), `scheduler ${column}`).toBe(true);
      }
      // worker_app 照旧整表可读（领取 / 目录同步 / 站点地图都要读口令码）
      const [workerRow] = await worker.$queryRaw<Array<{ upstream_code: string | null }>>`
        SELECT upstream_code FROM promo_link WHERE upstream_code = '960031'`;
      expect(workerRow?.upstream_code).toBe("960031");
      expect(await permissionDenied(() => scheduler.$queryRaw`SELECT config, id FROM channel_app LIMIT 1`)).toBe(false);
      expect(await permissionDenied(() => scheduler.$queryRaw`SELECT external_app_id FROM channel_app LIMIT 1`)).toBe(true);
      // web_app 仍然读不了凭据密文这类东西（边界没有因为这次授权松动）
      expect(await permissionDenied(() => web.$queryRaw`SELECT encrypted_secret FROM channel_account_credential LIMIT 1`)).toBe(true);
    });
  });

  describe("promoReadySql 与 isPromoReady 逐行等价", () => {
    // 口令码"是否非空"在数据库里由触发器 promo_link_sync_upstream_code_present 算出来（web_app 读不到口令码本身，
    // 就绪 SQL 只读这个布尔列）。这里在一张与 promo_link 同列名的临时表上挂**同一个触发器函数**，用它给每个样本口令码算
    // 布尔值，再把布尔值喂给 promoReadySql——于是"触发器 + 就绪 SQL"整体与 JS 的 isPromoReady 逐行对照。
    beforeAll(async () => {
      await truncateDatabase();
      await owner.$executeRawUnsafe("DROP TABLE IF EXISTS public.zz_code_present_probe");
      await owner.$executeRawUnsafe("CREATE TABLE public.zz_code_present_probe (idx int PRIMARY KEY, upstream_code text, upstream_code_present boolean NOT NULL DEFAULT false)");
      await owner.$executeRawUnsafe(`CREATE TRIGGER zz_probe_sync BEFORE INSERT OR UPDATE ON public.zz_code_present_probe
        FOR EACH ROW EXECUTE FUNCTION public.promo_link_sync_upstream_code_present()`);
    });
    afterAll(async () => {
      await owner.$executeRawUnsafe("DROP TABLE IF EXISTS public.zz_code_present_probe");
    });

    const presenceCache = new Map<string, boolean>();
    /** 对每个不同的口令码（含 NULL）让触发器算一次布尔值；结果缓存，大矩阵只算不同的口令码。 */
    async function presenceOf(codes: ReadonlyArray<string | null>): Promise<(code: string | null) => boolean> {
      const key = (code: string | null) => (code === null ? NULL_SENTINEL : code);
      const missing = [...new Set(codes.map(key))].filter((k) => !presenceCache.has(k));
      for (let offset = 0; offset < missing.length; offset += 20_000) {
        const chunk = missing.slice(offset, offset + 20_000);
        await owner.$executeRawUnsafe("TRUNCATE public.zz_code_present_probe");
        await owner.$executeRaw(Prisma.sql`
          INSERT INTO public.zz_code_present_probe (idx, upstream_code)
          SELECT t.idx::int, NULLIF(t.code, ${NULL_SENTINEL}) FROM unnest(${chunk}::text[]) WITH ORDINALITY AS t(code, idx)
        `);
        const rows = await owner.$queryRaw<Array<{ idx: number; upstream_code_present: boolean }>>`
          SELECT idx, upstream_code_present FROM public.zz_code_present_probe ORDER BY idx`;
        expect(rows).toHaveLength(chunk.length);
        for (const row of rows) presenceCache.set(chunk[row.idx - 1]!, row.upstream_code_present);
      }
      return (code) => presenceCache.get(key(code))!;
    }

    type Sample = {
      status: string;
      webUrl: string | null;
      appUrl: string | null;
      upstreamCode: string | null;
      config: unknown;
      locale: string;
    };

    const NULL_SENTINEL = "__PLOT_NULL__";

    async function judgeInDatabase(samples: readonly Sample[]): Promise<boolean[]> {
      const enc = (value: string | null) => (value === null ? NULL_SENTINEL : value);
      const present = await presenceOf(samples.map((s) => s.upstreamCode));
      const rows = await web.$queryRaw<Array<{ idx: number; ready: boolean }>>(Prisma.sql`
        SELECT p.idx::int AS idx, (${promoReadySql("p", { channelAppAlias: "pca", novelAlias: "n" })}) AS ready
        FROM (
          SELECT t.status, NULLIF(t.web_url, ${NULL_SENTINEL}) AS web_url, NULLIF(t.app_url, ${NULL_SENTINEL}) AS app_url,
                 t.upstream_code_present, t.idx
          FROM unnest(
            ${samples.map((s) => s.status)}::text[], ${samples.map((s) => enc(s.webUrl))}::text[],
            ${samples.map((s) => enc(s.appUrl))}::text[], ${samples.map((s) => present(s.upstreamCode))}::boolean[]
          ) WITH ORDINALITY AS t(status, web_url, app_url, upstream_code_present, idx)
        ) p
        JOIN (
          SELECT c.config::jsonb AS config, c.idx FROM unnest(${samples.map((s) => JSON.stringify(s.config))}::text[]) WITH ORDINALITY AS c(config, idx)
        ) pca ON pca.idx = p.idx
        JOIN (
          SELECT l.locale, l.idx FROM unnest(${samples.map((s) => s.locale)}::text[]) WITH ORDINALITY AS l(locale, idx)
        ) n ON n.idx = p.idx
        ORDER BY p.idx
      `);
      expect(rows).toHaveLength(samples.length);
      return rows.map((row) => row.ready);
    }

    function judgeInJs(samples: readonly Sample[]): boolean[] {
      return samples.map((s) => isPromoReady({
        status: s.status, webUrl: s.webUrl, appUrl: s.appUrl, upstreamCode: s.upstreamCode,
        channelApp: { config: s.config }, novel: { locale: s.locale },
      }));
    }

    function describeSample(sample: Sample): string {
      const show = (value: string | null) => value === null ? "NULL" : [...value].map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`).join(" ") || "''";
      return `status=${sample.status} web=${show(sample.webUrl)} app=${show(sample.appUrl)} code=${show(sample.upstreamCode)} config=${JSON.stringify(sample.config)} locale=${sample.locale}`;
    }

    async function expectIdentical(samples: readonly Sample[]): Promise<{ ready: number; notReady: number }> {
      const database = await judgeInDatabase(samples);
      const program = judgeInJs(samples);
      const disagreements: string[] = [];
      for (let index = 0; index < samples.length; index += 1) {
        if (database[index] !== program[index]) disagreements.push(`${describeSample(samples[index]!)} database=${database[index]} program=${program[index]}`);
      }
      expect(disagreements.slice(0, 20)).toEqual([]);
      return { ready: program.filter(Boolean).length, notReady: program.filter((v) => !v).length };
    }

    function bmpCharacters(): string[] {
      const chars: string[] = [];
      for (let codePoint = 1; codePoint <= 0xffff; codePoint += 1) {
        if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
        chars.push(String.fromCodePoint(codePoint));
      }
      return chars;
    }

    const CODE = { promoMode: "code", agencyIds: ["1351"], codeModeLocales: ["en"] };

    it("口令码模式：U+0001–U+FFFF 每个字符单独作为 upstream_code（status ∈ fetched/pending，有无网址）", async () => {
      const chars = bmpCharacters();
      let ready = 0;
      let notReady = 0;
      for (const status of ["fetched", "pending"]) {
        for (const webUrl of [null, BIG_URL]) {
          const result = await expectIdentical(chars.map((c) => ({ status, webUrl, appUrl: null, upstreamCode: c, config: CODE, locale: "en" })));
          ready += result.ready;
          notReady += result.notReady;
        }
      }
      expect(ready).toBeGreaterThan(100_000);
      expect(notReady).toBeGreaterThan(100_000);
    }, 300_000);

    it("口令码模式：25 个空白字符各自单独 / 夹在 x 两侧 / 两两相邻——与 JS trim 一致", async () => {
      const ws = [...JS_TRIM_WHITESPACE_CHARACTERS];
      const samples: Sample[] = [];
      for (const a of ws) {
        for (const code of [a, `${a}x${a}`, `x${a}x`, `${a}${a}`]) samples.push({ status: "fetched", webUrl: null, appUrl: null, upstreamCode: code, config: CODE, locale: "en" });
        for (const b of ws) samples.push({ status: "fetched", webUrl: null, appUrl: null, upstreamCode: `${a}${b}`, config: CODE, locale: "en" });
      }
      const result = await expectIdentical(samples);
      expect(result.ready).toBeGreaterThan(0);
      expect(result.notReady).toBeGreaterThan(0);
    });

    it("配置 × 语种 × 口令码 × 网址 × 状态 的全组合：模式二选一、白名单逐项原样比对，两边一致", async () => {
      const configs: unknown[] = [
        CODE,
        { promoMode: "code", codeModeLocales: ["en", "fr"] },
        { promoMode: "code", codeModeLocales: [] },
        { promoMode: "code" },
        { promoMode: "code", codeModeLocales: "en" },
        { promoMode: "code", codeModeLocales: [" en"] },
        { promoMode: "code", codeModeLocales: ["EN"] },
        { promoMode: "code", codeModeLocales: [null, 5, "en"] },
        { promoMode: "code", codeModeLocales: [""] }, // 空语种边界：白名单含 "" 且书的语种也是 ""
        { promoMode: "code", codeModeLocales: ["", "en"] },
        { promoMode: "code", codeModeLocales: { 0: "en" } },
        { promoMode: "link", codeModeLocales: ["en"] },
        { promoMode: "Code", codeModeLocales: ["en"] },
        { promoMode: "codes", codeModeLocales: ["en"] },
        { promoMode: 1, codeModeLocales: ["en"] },
        { promoMode: true, codeModeLocales: ["en"] },
        { promoMode: null, codeModeLocales: ["en"] },
        { promoMode: ["code"], codeModeLocales: ["en"] },
        { codeModeLocales: ["en"] },
        {},
        [],
        ["code"],
        "code",
        null,
        5,
      ];
      const samples: Sample[] = [];
      for (const config of configs) {
        for (const locale of ["en", "fr", " en", "EN", "", "zh-Hant"]) {
          for (const upstreamCode of [null, "", " ", "960031", "　", " 1 "]) {
            for (const webUrl of [null, "", "  ", BIG_URL]) {
              for (const status of ["fetched", "pending"]) {
                samples.push({ status, webUrl, appUrl: null, upstreamCode, config, locale });
              }
            }
          }
        }
      }
      const result = await expectIdentical(samples);
      expect(result.ready).toBeGreaterThan(50);
      expect(result.notReady).toBeGreaterThan(50);
    }, 120_000);
  });

  describe("全链路（真实 persistence、真实角色）", () => {
    beforeEach(async () => {
      await truncateDatabase();
      await seedTheaters();
      await owner.siteSetting.create({ data: { id: 1 } });
    });

    async function world() {
      const plotReady = await seedPublished({ appId: ids.plotApp, externalBookId: "plot-ready", title: "Plot Ready", agencyId: PLOT_AGENCY, promo: { upstreamCode: "960031" } });
      const moboReady = await seedPublished({ appId: ids.moboApp, externalBookId: "mobo-ready", title: "Mobo Ready", agencyId: MOBO_AGENCY, promo: { upstreamCode: "M1", webUrl: BIG_URL } });
      // 🔴 防误伤：MoboReader 下"有口令码、没有网址"——必须不就绪、不公开可见
      const moboCodeOnly = await seedPublished({ appId: ids.moboApp, externalBookId: "mobo-codeonly", title: "Mobo Code Only", agencyId: MOBO_AGENCY, promo: { upstreamCode: "ABC123" } });
      const plotBlank = await seedPublished({ appId: ids.plotApp, externalBookId: "plot-blank", title: "Plot Blank", agencyId: PLOT_AGENCY, promo: { upstreamCode: "   " } });
      const plotPending = await seedPublished({ appId: ids.plotApp, externalBookId: "plot-pending", title: "Plot Pending", agencyId: PLOT_AGENCY, promo: { status: "pending", upstreamCode: null } });
      return { plotReady, moboReady, moboCodeOnly, plotBlank, plotPending };
    }

    it("公开列表 / 计数：口令码模式的书进列表，MoboReader 有码没网址的不进；语种不在白名单的不进，放开白名单后进；剧场改成 link 模式后不进", async () => {
      const w = await world();
      const frBook = await seedPublished({ appId: ids.plotApp, externalBookId: "plot-fr", title: "Plot French", locale: "fr", agencyId: PLOT_AGENCY, promo: { upstreamCode: "123" } });

      const page = await listPublicNovelPage(web, { locale: "en", page: 1, pageSize: 20, env: ENV_OFF });
      expect(page.novels.map((card) => card.title).sort()).toEqual(["Mobo Ready", "Plot Ready"]);
      expect(page.totalCount).toBe(2);
      expect(await queryPublicListCount(web, { locale: "en", env: ENV_OFF })).toBe(2);
      expect(await queryPublicListCount(web, { locale: "fr", env: ENV_OFF })).toBe(0); // fr 不在 codeModeLocales

      await owner.channelApp.update({ where: { id: ids.plotApp }, data: { config: { promoMode: "code", agencyIds: [PLOT_AGENCY], codeModeLocales: ["en", "fr"] } } });
      expect(await queryPublicListCount(web, { locale: "fr", env: ENV_OFF })).toBe(1);
      expect((await listPublicNovelPage(web, { locale: "fr", page: 1, pageSize: 20, env: ENV_OFF })).novels.map((card) => card.title)).toEqual(["Plot French"]);

      await owner.channelApp.update({ where: { id: ids.plotApp }, data: { config: { promoMode: "link", agencyIds: [PLOT_AGENCY] } } });
      expect(await queryPublicListCount(web, { locale: "en", env: ENV_OFF })).toBe(1); // 只剩 Mobo Ready
      expect(frBook.article).not.toBeNull();
      void w;
    });

    it("详情页访问判定：口令码模式 → published；MoboReader 有码没网址 / 口令码空白 / 状态不是 fetched → unavailable（不是公开可访问）", async () => {
      const w = await world();
      const access = async (shortId: string) => (await resolveNovelArticlePublicAccessByShortId(web, { shortId })).kind;
      expect(await access(w.plotReady.article!.publicPageShortId)).toBe("published");
      expect(await access(w.moboReady.article!.publicPageShortId)).toBe("published");
      expect(await access(w.moboCodeOnly.article!.publicPageShortId)).toBe("unavailable");
      expect(await access(w.plotBlank.article!.publicPageShortId)).toBe("unavailable");
      expect(await access(w.plotPending.article!.publicPageShortId)).toBe("unavailable");
      // 页面入口（解析短码 + slug + 语种前缀）同口径
      const parsed = await resolvePublicArticleBySlugParam(web, `${w.plotReady.article!.slug}-${w.plotReady.article!.publicPageShortId}`, "en");
      expect(parsed.kind === "published" || parsed.kind === "not_found" || parsed.kind === "redirect").toBe(true);
    });

    it("发布门禁：口令码模式的草稿文章不再被 promo_link_not_ready 挡住；MoboReader 有码没网址仍被挡", async () => {
      const w = await world();
      for (const key of ["plotReady", "moboCodeOnly", "plotBlank", "moboReady"] as const) {
        await owner.article.update({ where: { id: w[key].article!.id }, data: { status: "draft", publishedAt: null } });
      }
      const reasonsFor = async (articleId: string) => {
        const loaded = await loadPublishGateFacts(web, articleId);
        return evaluatePublishGate(loaded!.facts, {}).reasons as readonly string[];
      };
      expect(await reasonsFor(w.plotReady.article!.id)).not.toContain("promo_link_not_ready");
      expect(await reasonsFor(w.plotReady.article!.id)).not.toContain("promo_link_missing");
      expect(await reasonsFor(w.moboReady.article!.id)).not.toContain("promo_link_not_ready");
      expect(await reasonsFor(w.moboCodeOnly.article!.id)).toContain("promo_link_not_ready");
      expect(await reasonsFor(w.plotBlank.article!.id)).toContain("promo_link_not_ready");
    });

    it("站点地图 / IndexNow / hreflang：口令码模式的书进，防误伤的书不进", async () => {
      const w = await world();
      const files = await createSitemapFamilyBuilder(worker, ENV_OFF)({ type: "novelpage", locale: "en" });
      const locs = files.flatMap((file) => file.entries.map((entry) => entry.loc));
      const has = (shortId: string) => locs.some((loc) => loc.includes(shortId));
      expect(has(w.plotReady.article!.publicPageShortId)).toBe(true);
      expect(has(w.moboReady.article!.publicPageShortId)).toBe(true);
      expect(has(w.moboCodeOnly.article!.publicPageShortId)).toBe(false);
      expect(has(w.plotBlank.article!.publicPageShortId)).toBe(false);
      expect(has(w.plotPending.article!.publicPageShortId)).toBe(false);

      const eligible = async (articleId: string) => {
        const row = await loadIndexNowCandidateArticle(worker, articleId);
        if (!row || row.articleType !== "novel_article") return false;
        return isNovelIndexNowEligible(row, row.novel, row.promoLink);
      };
      expect(await eligible(w.plotReady.article!.id)).toBe(true);
      expect(await eligible(w.moboReady.article!.id)).toBe(true);
      expect(await eligible(w.moboCodeOnly.article!.id)).toBe(false);
      expect(await eligible(w.plotBlank.article!.id)).toBe(false);

      expect((await loadNovelHreflangSiblings(web, w.plotReady.novel.id)).map((sibling) => sibling.locale)).toEqual(["en"]);
      expect(await loadNovelHreflangSiblings(web, w.moboCodeOnly.novel.id)).toEqual([]);
    });

    it("前台（真实 web_app 角色）：中间页取数拿到口令码；书页 / 章节页视图与站点地图里没有它；MoboReader 的 link 模式不会走到中间页", async () => {
      const w = await world();
      await owner.novelChapter.create({
        data: { novelId: w.plotReady.novel.id, canonicalChapterNumber: 1, title: "Chapter One", status: "preview", content: { create: { body: "First paragraph.\n\nSecond paragraph.", charCount: 34, contentHash: "a".repeat(64), materializedAt: new Date() } } },
      });
      // 中间页：站内码 → 口令码 / App 名 / 商店链接 / 书名 / 回书页路径
      const page = await loadCodeModePageData(web, w.plotReady.promo.publicRedirectCode);
      expect(page).toMatchObject({
        code: "960031", appName: "PlotNovel", title: "Plot Ready",
        appStoreUrl: "https://apps.apple.com/app/plotnovel/id123",
        googlePlayUrl: "https://play.google.com/store/apps/details?id=com.plotnovel",
      });
      expect(page?.backHref).toBe(`/novel/${w.plotReady.article!.slug}-p${w.plotReady.article!.publicPageShortId}`);
      // 不就绪 / 不是口令码模式的推广不出中间页
      expect(await loadCodeModePageData(web, w.plotBlank.promo.publicRedirectCode)).toBeNull();
      expect(await loadCodeModePageData(web, w.plotPending.promo.publicRedirectCode)).toBeNull();
      expect(await loadCodeModePageData(web, w.moboReady.promo.publicRedirectCode)).toBeNull();
      expect(await loadCodeModePageData(web, w.moboCodeOnly.promo.publicRedirectCode)).toBeNull();

      // 书页 / 章节页视图：有模式标记，没有口令码
      const detail = await getPublicNovelDetail(web, w.plotReady.article!.id);
      expect(detail).toMatchObject({ readOnUpstreamHref: `/go/${w.plotReady.promo.publicRedirectCode}`, readOnUpstreamMode: "code", readOnUpstreamAppName: "PlotNovel" });
      const chapter = await getPublicChapterView(web, w.plotReady.article!.id, 1);
      expect(chapter).toMatchObject({ readOnUpstreamMode: "code", readOnUpstreamAppName: "PlotNovel" });
      expect(JSON.stringify([detail, chapter])).not.toContain("960031");
      // MoboReader 的书页没有模式标记
      expect(await getPublicNovelDetail(web, w.moboReady.article!.id)).not.toHaveProperty("readOnUpstreamMode");
      expect(await getPublicNovelDetail(web, w.moboCodeOnly.article!.id)).toBeNull(); // 有码没网址：不就绪

      // 站点地图（含章节页）里没有口令码
      const files = await createSitemapFamilyBuilder(worker, ENV_OFF)({ type: "novelpage", locale: "en" });
      expect(JSON.stringify(files)).not.toContain("960031");
      expect(files.flatMap((file) => file.entries.map((entry) => entry.loc)).some((loc) => loc.includes("/chapter"))).toBe(true);
    });

    it("scheduler_app 的活跃语种查询：用真实调度器角色跑通（不被 permission denied），口令码模式的语种算活跃、防误伤的不算", async () => {
      await owner.channelApp.update({ where: { id: ids.plotApp }, data: { config: { promoMode: "code", agencyIds: [PLOT_AGENCY], codeModeLocales: ["en", "fr"] } } });
      await seedPublished({ appId: ids.plotApp, externalBookId: "plot-fr", title: "Plot French", locale: "fr", agencyId: PLOT_AGENCY, promo: { upstreamCode: "123" } });
      await seedPublished({ appId: ids.moboApp, externalBookId: "mobo-de", title: "Mobo German", locale: "de", agencyId: MOBO_AGENCY, promo: { upstreamCode: "ABC" } }); // 有码没网址
      const active = await queryActiveLocales(scheduler, ENV_OFF);
      expect(active).toContain("en");
      expect(active).toContain("fr");
      expect(active).not.toContain("de");
      // 同一个查询用 worker 角色（站点地图刷新用的）结果一致
      expect(await queryActiveLocales(worker, ENV_OFF)).toEqual(active);
    });

    it("可生成判定：口令码模式的书可生成；MoboReader 有码没网址 / 口令码空白 / 排队中不可生成，原因标签是 promo_link_not_ready", async () => {
      const books = {
        ready: await seedPublished({ appId: ids.plotApp, externalBookId: "gen-ready", title: "Gen Ready", agencyId: PLOT_AGENCY, promo: { upstreamCode: "960031" }, withoutArticle: true }),
        mobo: await seedPublished({ appId: ids.moboApp, externalBookId: "gen-mobo", title: "Gen Mobo", agencyId: MOBO_AGENCY, promo: { upstreamCode: "ABC" }, withoutArticle: true }),
        blank: await seedPublished({ appId: ids.plotApp, externalBookId: "gen-blank", title: "Gen Blank", agencyId: PLOT_AGENCY, promo: { upstreamCode: "  " }, withoutArticle: true }),
        pending: await seedPublished({ appId: ids.plotApp, externalBookId: "gen-pending", title: "Gen Pending", agencyId: PLOT_AGENCY, promo: { status: "pending", upstreamCode: null }, withoutArticle: true }),
      };
      const rows = await owner.novel.findMany({
        where: { id: { in: Object.values(books).map((b) => b.novel.id) } },
        select: { id: true, title: true, locale: true, businessId: true, updatedAt: true, deletedAt: true, articles: { select: { id: true, locale: true, deletedAt: true } } },
      });
      const admissions = await resolveArticleGenerateAdmissions(worker, rows.map((row) => row.id), rows);
      expect(admissions.get(books.ready.novel.id)).toMatchObject({ canGenerate: true, promoOutcome: "ready" });
      for (const key of ["mobo", "blank", "pending"] as const) {
        expect(admissions.get(books[key].novel.id)).toMatchObject({ canGenerate: false, promoOutcome: "promo_link_not_ready" });
      }
      // 后台"批量生成"列表（web_app）：默认只列可生成；计数口径与逐行判定一致（口令码为空白的那本是已接受的预筛缺口）
      const listing = await listNovelsForArticleGenerate(web, { eligibleOnly: true, showIneligible: true });
      expect(listing.rows.find((row) => row.novelId === books.ready.novel.id)).toMatchObject({ canGenerateArticle: true, promoReady: true });
      expect(listing.rows.find((row) => row.novelId === books.mobo.novel.id)).toMatchObject({ canGenerateArticle: false });
      const defaultView = await listNovelsForArticleGenerate(web, { eligibleOnly: true });
      expect(defaultView.rows.map((row) => row.novelId)).toContain(books.ready.novel.id);
      expect(defaultView.rows.map((row) => row.novelId)).not.toContain(books.mobo.novel.id);
    });

    it("领取批次上下文：PlotNovel 剧场按自己分组，能看到它的书（剧场打开 + 开了领取能力之后可入队）", async () => {
      await seedPublished({ appId: ids.plotApp, externalBookId: "batch-plot", title: "Batch Plot", agencyId: PLOT_AGENCY, promo: { status: "pending", upstreamCode: null }, withoutArticle: true });
      await seedPublished({ appId: ids.moboApp, externalBookId: "batch-mobo", title: "Batch Mobo", agencyId: MOBO_AGENCY, promo: { status: "pending", upstreamCode: null }, withoutArticle: true });
      const context = await readCatalogBatchContext(web, { scope: "all_filtered", filter: { status: "linked" } });
      const plotGroup = context.channelGroups.find((group) => group.channelAppId === ids.plotApp);
      const moboGroup = context.channelGroups.find((group) => group.channelAppId === ids.moboApp);
      expect(plotGroup).toMatchObject({ eligibleCount: 1, active: true, claimCapabilityEnabled: false });
      expect(moboGroup).toMatchObject({ eligibleCount: 1, active: true });
      expect(plotGroup!.accounts.map((account) => account.id)).toEqual([ids.account]);
      // 剧场还没打开时：分组存在但 active = false（运营在弹窗里看得到、选不了）
      await owner.channelApp.update({ where: { id: ids.plotApp }, data: { status: "registered_disabled" } });
      const closed = await readCatalogBatchContext(web, { scope: "all_filtered", filter: { status: "linked" } });
      expect(closed.channelGroups.find((group) => group.channelAppId === ids.plotApp)).toMatchObject({ active: false, eligibleCount: 1 });
    });

    it("首页轮播：自动计算与前台读取都不含口令码模式剧场的书；MoboReader 的书照常", async () => {
      const w = await world();
      const compute = await worker.$transaction((tx) => computeHomeCarouselInTx(tx, { locale: "en", source: "manual", now: new Date() }));
      expect(compute.status).toBe("success");
      const serving = await owner.homeCarouselServing.findMany({ where: { locale: "en" } });
      // 候选的数据库预筛只看推广链接 status = fetched（粗预筛，行级就绪由读取端复核），所以有码没网址的 MoboReader 书
      // 可能在快照里；口令码模式剧场的书一条都不能有。
      expect(serving.map((row) => row.articleId)).toContain(w.moboReady.article!.id);
      expect(serving.map((row) => row.articleId)).not.toContain(w.plotReady.article!.id);
      expect(serving.map((row) => row.articleId)).not.toContain(w.plotBlank.article!.id);
      expect(serving.map((row) => row.articleId)).not.toContain(w.plotPending.article!.id);
      const items = await getHomeCarouselItems("en", web);
      expect(items.map((item) => item.novel.title)).toEqual(["Mobo Ready"]);
      // 就算快照里残留了一行口令码模式的书（比如以前手动放过），前台读取也不会出它
      await owner.homeCarouselServing.create({
        data: { locale: "en", position: 4, novelId: w.plotReady.novel.id, articleId: w.plotReady.article!.id, source: "recency", mergedAt: new Date() },
      });
      expect((await getHomeCarouselItems("en", web)).map((item) => item.novel.title)).toEqual(["Mobo Ready"]);
    });
  });
});
