/**
 * B-38 第二段·真实库用例 5/7：博客列表改数据库分页（`skip` / `take` + `count`），无任何上限。
 *
 * 参照 = 改造前逻辑去掉上限：不设 take 的 `findMany`（`buildPublicListBlogArticleWhere`，发布时间降序、编号升序）。
 * 博客开关打开（`FEATURE_ARTICLE_BLOG=true`，页面入口的前置条件），夹具混合：状态（草稿 / 下架 / 撤回 / 已删除）、
 * SEO 可见性（hidden / seo_only，开关开关各一遍）、三种博客类型、三个语种、大量并列的发布时间。
 * 新函数逐页拼起来要与参照逐 id 相等，`totalCount` / `totalPages` 相等；页码超出返回空页（页面据此 404）。
 *
 * 运行：`bash scripts/run-public-list-postgres-verification.sh`（一次性 postgres:16.14，真实角色）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listPublicBlogArticles } from "@/lib/site/blog-queries";
import { assertIsolatedDatabase, connectRoles, disconnectRoles, enabled, resetDatabase } from "../tagging/effective-tag-fixtures";
import { envFor, expectedTotalPages, PAGE_SIZE, referenceBlogList, seedBlogScenario, FIXTURE_SITES } from "./site-fixtures";

const roles = connectRoles();
const { owner, web } = roles;

let stats: Readonly<Record<string, number>>;

async function collect(locale: string, env: NodeJS.ProcessEnv) {
  const first = await listPublicBlogArticles(web, locale as never, 1, env);
  const ids = first.posts.map((post) => post.id);
  for (let page = 2; page <= first.totalPages; page += 1) {
    const next = await listPublicBlogArticles(web, locale as never, page, env);
    expect(next.totalCount).toBe(first.totalCount);
    expect(next.totalPages).toBe(first.totalPages);
    expect(next.page).toBe(page);
    if (page < first.totalPages) expect(next.posts).toHaveLength(PAGE_SIZE);
    ids.push(...next.posts.map((post) => post.id));
  }
  return { ids, first };
}

describe.skipIf(!enabled).sequential("B-38 博客列表分页 === 不设上限的参照（真实 web_app）", () => {
  beforeAll(async () => {
    await assertIsolatedDatabase(owner);
    await resetDatabase(owner);
    stats = await seedBlogScenario(owner, { posts: 420, seed: 20_261_013 });
  }, 120_000);
  afterAll(async () => { await disconnectRoles(roles); });

  it("用的是真实角色身份；夹具不是空壳", async () => {
    expect(await web.$queryRaw`SELECT current_user AS role`).toEqual([{ role: "web_app" }]);
    for (const key of ["blog:published", "blog:draft", "blog:unpublished", "blog:takedown", "blog:published:deleted", "blogseo:public", "blogseo:seo_only", "blogseo:hidden"]) {
      expect(stats[key] ?? 0, key).toBeGreaterThan(0);
    }
  });

  for (const seoVisibility of [false, true]) {
    for (const locale of FIXTURE_SITES) {
      it(`SEO 可见性${seoVisibility ? "开" : "关"} · ${locale}：逐页拼起来与参照逐 id 相等，totalCount / totalPages 相等`, async () => {
        const env = { ...envFor({ seoVisibility }), FEATURE_ARTICLE_BLOG: "true" };
        const reference = await referenceBlogList(web, locale, env);
        expect(reference.length).toBeGreaterThan(PAGE_SIZE); // 多于一页，分页才有意义
        const { ids, first } = await collect(locale, env);
        expect(ids).toEqual(reference);
        expect(first.totalCount).toBe(reference.length);
        expect(first.totalPages).toBe(expectedTotalPages(reference.length));
        // 超出范围：空页，真实总页数。
        const beyond = await listPublicBlogArticles(web, locale as never, first.totalPages + 1, env);
        expect(beyond.posts).toEqual([]);
        expect(beyond.totalPages).toBe(first.totalPages);
      }, 60_000);
    }
  }

  it("规则：SEO 可见性开时 hidden / seo_only 被排除，关时不区分；每条都带 href 与发布时间", async () => {
    const on = await listPublicBlogArticles(web, "en", 1, { ...envFor({ seoVisibility: true }), FEATURE_ARTICLE_BLOG: "true" });
    const off = await listPublicBlogArticles(web, "en", 1, { ...envFor({ seoVisibility: false }), FEATURE_ARTICLE_BLOG: "true" });
    expect(off.totalCount).toBeGreaterThan(on.totalCount);
    for (const post of on.posts) {
      expect(post.href).toMatch(/^\/blog\//);
      expect(post.publishedAt).toBeInstanceOf(Date);
    }
  });

  it("没有任何博客的语种：第 1 页空、总数 0、总页数 1；非法页码按第 1 页；极大页码不报错", async () => {
    const env = envFor({ seoVisibility: true });
    expect(await listPublicBlogArticles(web, "ru", 1, env)).toMatchObject({ posts: [], page: 1, totalPages: 1, totalCount: 0 });
    expect(await listPublicBlogArticles(web, "ru", 2, env)).toMatchObject({ posts: [], page: 2, totalPages: 1, totalCount: 0 });
    const reference = await listPublicBlogArticles(web, "en", 1, env);
    expect((await listPublicBlogArticles(web, "en", 0, env)).posts.map((p) => p.id)).toEqual(reference.posts.map((p) => p.id));
    expect((await listPublicBlogArticles(web, "en", Number.NaN, env)).page).toBe(1);
    expect((await listPublicBlogArticles(web, "en", Number.MAX_SAFE_INTEGER, env)).posts).toEqual([]);
    const huge = await listPublicBlogArticles(web, "en", 1e21, env);
    expect(huge.posts).toEqual([]);
    expect(huge.totalCount).toBe(reference.totalCount);
  });
});
