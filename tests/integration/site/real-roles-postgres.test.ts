/**
 * B-38 第二段·真实库用例 6/7：真实角色、真实 grants，全程不能出现 permission denied。
 *
 * 公开站读路径用 `web_app` 连接：全部作品页、分类页、首页作品格、每语种每分类本数矩阵、页脚 / 导航的分类名、
 * 卡片标签读归属表、博客列表。站点地图的分类条目（`createSitemapFamilyBuilder` → `listPublicCategoryPageCounts`
 * + `loadPublicTaxonomyByNovelIds`）用 `worker_app` 连接。`scheduler_app` / `analyst_ro` 对公开列表不应有任何依赖，
 * 这里只确认 `analyst_ro` 能只读归属表（运维排查用），`scheduler_app` 没有读归属表与小说 / 文章标题的权限（最小权限没有被放宽）。
 *
 * 上面每条路径执行的是**真实的** SQL（`public-list.ts` / `public-taxonomy.ts` 生成的语句），所以这条用例也是
 * "新增的读语句没有漏授权"的最后一道闸——单元测试与 Opus 复核都测不出角色权限（两次同款事故：Lane E / L10N P5）。
 *
 * 运行：`bash scripts/run-public-list-postgres-verification.sh`（一次性 postgres:16.14，真实角色）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSitemapFamilyBuilder } from "@/lib/seo/sitemap";
import { listPublicBlogArticles } from "@/lib/site/blog-queries";
import { getPublicCategoryPage, listPublicCategoryPageCounts } from "@/lib/site/category-queries";
import { listCategoryPublicLocales } from "@/lib/site/category-locales";
import { clearPublicCategoryCountsCacheForTest, getPublicCategoryCounts, queryPublicCategoryCounts } from "@/lib/site/public-list";
import { loadPublicCategoryTags, loadPublicTaxonomyByNovelIds } from "@/lib/site/public-taxonomy";
import { getPublicBrowsePage, listHomeNovels, listPublicCategories } from "@/lib/site/queries";
import { reconcileAllEffectiveTags } from "@/server/tagging/effective-tag-projection";
import {
  allNovelIds,
  assertIsolatedDatabase,
  connectRoles,
  disconnectRoles,
  enabled,
  resetDatabase,
  seedFoundation,
  type Foundation,
} from "../tagging/effective-tag-fixtures";
import { envFor, seedBlogScenario, seedListScenario } from "./site-fixtures";

const roles = connectRoles();
const { owner, web, worker, scheduler, analyst } = roles;

const SITE = "https://roles.example";
let foundation: Foundation;

async function denied(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (error) {
    return /permission denied/i.test(error instanceof Error ? error.message : String(error));
  }
}

describe.skipIf(!enabled).sequential("B-38 公开列表读路径用真实角色，不出现 permission denied", () => {
  const env = envFor({ autoTags: true, seoVisibility: true });

  beforeAll(async () => {
    process.env.SITE_URL = SITE;
    await assertIsolatedDatabase(owner);
    await resetDatabase(owner);
    await owner.siteSetting.create({ data: { id: 1 } });
    foundation = await seedFoundation(owner);
    await seedListScenario(owner, foundation, { novels: 220, seed: 20_261_014 });
    await seedBlogScenario(owner, { posts: 60, seed: 20_261_015 });
    await reconcileAllEffectiveTags(web);
    clearPublicCategoryCountsCacheForTest();
  }, 240_000);
  afterAll(async () => {
    delete process.env.SITE_URL;
    await disconnectRoles(roles);
  });

  it("角色身份", async () => {
    expect(await web.$queryRaw`SELECT current_user AS role`).toEqual([{ role: "web_app" }]);
    expect(await worker.$queryRaw`SELECT current_user AS role`).toEqual([{ role: "worker_app" }]);
    expect(await scheduler.$queryRaw`SELECT current_user AS role`).toEqual([{ role: "scheduler_app" }]);
    expect(await analyst.$queryRaw`SELECT current_user AS role`).toEqual([{ role: "analyst_ro" }]);
  });

  it("web_app：全部作品页 / 首页作品格 / 分类页 / 矩阵（含缓存版）/ 页脚分类名 / 卡片标签 / hreflang / 博客列表，全程成功", async () => {
    const browse = await getPublicBrowsePage(web, "en", 1, env);
    expect(browse.totalCount).toBeGreaterThan(20);
    expect(browse.novels).toHaveLength(20);
    expect((await listHomeNovels(web, "en", env)).length).toBeGreaterThan(0);

    const categories = await listPublicCategories(web, "en", env);
    expect(categories.length).toBeGreaterThan(3);
    const category = await getPublicCategoryPage(web, "en", categories[0]!.slug, 1, env);
    expect(category).not.toBeNull();
    expect(category!.novels.length).toBeGreaterThan(0);

    const counts = await queryPublicCategoryCounts(web, env);
    expect(counts.rows.length).toBeGreaterThan(3);
    expect(counts.visibleTotalByLocale.get("en")).toBe(browse.totalCount);
    const cached = await getPublicCategoryCounts(web, env);
    expect(cached.rows.length).toBe(counts.rows.length);

    const ids = await allNovelIds(owner);
    expect((await loadPublicTaxonomyByNovelIds(web, ids, "en", env)).size).toBeGreaterThan(10);
    expect((await loadPublicCategoryTags(web, categories.map((tag) => tag.id), "en")).length).toBe(categories.length);
    expect((await listCategoryPublicLocales(web, categories[0]!.slug, ["en", "es", "ko"], env)).length).toBeGreaterThan(0);
    expect((await listPublicBlogArticles(web, "en", 1, env)).totalCount).toBeGreaterThan(0);
  }, 120_000);

  it("worker_app：站点地图 mainpage（分类条目走矩阵 + 读归属表）与页数映射，全程成功", async () => {
    const files = await createSitemapFamilyBuilder(worker, env)({ type: "mainpage", locale: "en" });
    const locs = files.flatMap((file) => file.entries).map((entry) => entry.loc);
    expect(locs[0]).toBe(SITE);
    expect(locs.some((loc) => loc.includes("/category/"))).toBe(true);
    const pageCounts = await listPublicCategoryPageCounts(worker, "en", env);
    expect(pageCounts.size).toBeGreaterThan(3);
    // 矩阵（不带缓存的原函数）worker 也能直接算——scale-check 运维命令在 worker 层执行。
    expect((await queryPublicCategoryCounts(worker, env)).rows.length).toBeGreaterThan(3);
  }, 120_000);

  it("analyst_ro 只读这些表没问题；scheduler_app 没有读公开列表所需表的权限（最小权限没有被放宽）", async () => {
    expect(await denied(() => analyst.$queryRaw`SELECT count(*) FROM novel_effective_tag`)).toBe(false);
    expect(await denied(() => scheduler.$queryRaw`SELECT count(*) FROM novel_effective_tag`)).toBe(true);
    // 调度器对 novel / promo_link / article 只有列级 SELECT（任务调度要的那几列），读不到标题和链接本身。
    expect(await denied(() => scheduler.$queryRaw`SELECT title FROM novel LIMIT 1`)).toBe(true);
    expect(await denied(() => scheduler.$queryRaw`SELECT title FROM article LIMIT 1`)).toBe(true);
  });

  it("公开读路径对 web_app 是纯读：归属表 web_app 有读写删（单本重算在后台事务里要写），但公开列表函数一次写入都不发", async () => {
    const before = await owner.$queryRaw<Array<{ n_tup_ins: bigint; n_tup_upd: bigint; n_tup_del: bigint }>>`
      SELECT n_tup_ins, n_tup_upd, n_tup_del FROM pg_stat_user_tables WHERE relname = 'novel_effective_tag'`;
    await getPublicBrowsePage(web, "en", 2, env);
    await listPublicCategories(web, "es", env);
    await loadPublicTaxonomyByNovelIds(web, await allNovelIds(owner), "en", env);
    // 统计信息是异步刷新的；这里只断言没有出现负增长（读路径不会写）并以语句级别再确认一次：只读事务里全部通过。
    const after = await owner.$queryRaw<Array<{ n_tup_ins: bigint; n_tup_upd: bigint; n_tup_del: bigint }>>`
      SELECT n_tup_ins, n_tup_upd, n_tup_del FROM pg_stat_user_tables WHERE relname = 'novel_effective_tag'`;
    expect(Number(after[0]!.n_tup_ins)).toBeGreaterThanOrEqual(Number(before[0]!.n_tup_ins));
    await web.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      expect((await getPublicBrowsePage(tx, "en", 1, env)).totalCount).toBeGreaterThan(0);
      expect((await listPublicCategories(tx, "en", env)).length).toBeGreaterThan(0);
      expect((await loadPublicTaxonomyByNovelIds(tx, (await allNovelIds(owner)).slice(0, 50), "en", env)).size).toBeGreaterThan(0);
      expect((await listPublicBlogArticles(tx, "en", 1, env)).totalCount).toBeGreaterThan(0);
    });
  }, 120_000);
});
