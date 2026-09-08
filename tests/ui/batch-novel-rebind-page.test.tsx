import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * C-30B (施工工单_C30_换小说_移植CPS换租客_2026-09-08.md §4B.4). Source-text
 * assertions for the batch page's wiring and route registration — same
 * mechanism `tests/ui/articles-new-blog.test.tsx` (C-28) and
 * `tests/ui/article-rebind-page-wiring.test.ts` (C-30A) already use for an
 * async Server Component with no render-based unit test precedent in this
 * repo.
 */
const root = resolve(import.meta.dirname, "../..");

describe("BatchNovelRebindPage（C-30B，源码级断言）", () => {
  const pageSource = readFileSync(resolve(root, "src/app/(admin)/articles/batch-novel-rebind/page.tsx"), "utf8");

  it("总闸 FEATURE_ARTICLE_NOVEL_REBIND 关闭时调用 notFound()（kill switch，形态照新建博客页）", () => {
    expect(pageSource).toMatch(/if\s*\(!isArticleNovelRebindEnabled\(process\.env\)\)\s*notFound\(\);/);
  });

  it("声明 force-dynamic，避免 kill switch 在构建期被固化", () => {
    expect(pageSource).toContain('export const dynamic = "force-dynamic";');
  });

  it("页面级能力校验为 content:batch-rebind（不是 content:rebind，两粒度不合并）", () => {
    expect(pageSource).toContain('requireContentPage("/articles/batch-novel-rebind", "content:batch-rebind")');
  });

  it("能力未授予时渲染 ContentCapabilityDenied，而不是静默空白", () => {
    expect(pageSource).toContain("granted ? <BatchRebindClient /> : <ContentCapabilityDenied");
  });
});

describe("/articles/batch-novel-rebind 路由保护：真实前缀匹配复核（施工工单 §4B.4 明确要求的一条测试）", () => {
  it('resolveAdminPage("/articles/batch-novel-rebind") 解析到已注册的 /articles 根，而不是裸奔', async () => {
    const { resolveAdminPage } = await import("@/server/auth/registry");
    expect(resolveAdminPage("/articles/batch-novel-rebind")).toBe("/articles");
  });
});

describe("批量换绑动作族已在注册表登记，且每一个都过能力校验（施工工单 §4B.3 「🔴 每一个都必须过能力校验」）", () => {
  it("七个动作 id 全部存在，能力均为 content:batch-rebind", async () => {
    const { ADMIN_ARTICLE_BATCH_REBIND_ACTIONS } = await import("@/app/api/admin/_lib/registry");
    const ids = ADMIN_ARTICLE_BATCH_REBIND_ACTIONS.map((action) => action.id);
    expect(ids).toEqual([
      "admin.article.rebind_facets",
      "admin.article.rebind_preview",
      "admin.article.rebind_preview_page",
      "admin.article.rebind_batch_apply",
      "admin.article.rebind_batch_resume",
      "admin.article.rebind_batch_detail",
      "admin.article.rebind_batch_by_token",
    ]);
    for (const action of ADMIN_ARTICLE_BATCH_REBIND_ACTIONS) {
      expect(action.capability).toBe("content:batch-rebind");
    }
  });

  it("🔴 预览单闸例外：admin.article.rebind_preview 是 mutation:true（同 catalog-scan dry_run 的先例），其余读动作是 mutation:false", async () => {
    const { ADMIN_ARTICLE_BATCH_REBIND_ACTIONS } = await import("@/app/api/admin/_lib/registry");
    const byId = Object.fromEntries(ADMIN_ARTICLE_BATCH_REBIND_ACTIONS.map((action) => [action.id, action]));
    expect(byId["admin.article.rebind_preview"]?.mutation).toBe(true);
    expect(byId["admin.article.rebind_facets"]?.mutation).toBe(false);
    expect(byId["admin.article.rebind_preview_page"]?.mutation).toBe(false);
    expect(byId["admin.article.rebind_batch_detail"]?.mutation).toBe(false);
    expect(byId["admin.article.rebind_batch_by_token"]?.mutation).toBe(false);
    expect(byId["admin.article.rebind_batch_apply"]?.mutation).toBe(true);
    expect(byId["admin.article.rebind_batch_resume"]?.mutation).toBe(true);
  });
});

describe("ArticlesPage 「批量换小说」入口按钮（C-30B，源码级断言）", () => {
  const source = readFileSync(resolve(root, "src/app/(admin)/articles/page.tsx"), "utf8");
  const anchorIdx = source.indexOf('data-testid="articles-batch-novel-rebind-entry"');

  it("入口按钮存在，指向 /articles/batch-novel-rebind，文案为「批量换小说」", () => {
    expect(anchorIdx).toBeGreaterThan(-1);
    const before = source.slice(0, anchorIdx);
    const hrefMatch = before.match(/href="([^"]*)"(?!.*href=")/s);
    expect(hrefMatch?.[1]).toBe("/articles/batch-novel-rebind");
    const after = source.slice(anchorIdx, anchorIdx + 200);
    expect(after).toContain("批量换小说");
  });

  it("按钮由 canBatchRebind 门控渲染（总闸 AND content:batch-rebind 能力），不是无条件展示", () => {
    const guardIdx = source.lastIndexOf("{canBatchRebind && (");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(anchorIdx);
    expect(source).toContain(
      'findCapabilityState(capabilityViews(context), "content:batch-rebind") === "granted"',
    );
    expect(source).toContain("isArticleNovelRebindEnabled(process.env) &&");
  });
});
