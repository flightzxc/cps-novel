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

/**
 * Review follow-up (复核_C30施工单2, 2026-09-09). The client component may not
 * import from `@/server/**` (`tests/ui/admin-secret-boundary.test.tsx`), so
 * its `REBIND_BATCH_APPLY_CAP` is a hand-copied duplicate of
 * `REBIND_BATCH_LIMITS.apply` — and nothing pinned the two together. A
 * mutation run during review proved it: flipping the server constant to 201
 * turned ZERO tests red, including the UI test that asserts the literal
 * copy「已超过单次执行上限（200 篇）」, because that string is produced from the
 * client's own copy of the number.
 *
 * That matters here more than it usually would: 施工工单 §7 item 2 explicitly
 * schedules this constant to be RE-TUNED once
 * `tests/integration/article-rebind/batch-200.test.ts` measures a real
 * 200-item run. Whoever re-tunes it would otherwise silently desync the two
 * halves — the client refusing at 200 while the server accepts more, or the
 * client permitting a selection the server then rejects wholesale with
 * INVALID_SELECTION after the operator has already written a recovery token.
 */
describe("客户端上限常量与服务端 REBIND_BATCH_LIMITS.apply 必须同值（手抄副本的防漂移锁）", () => {
  it("batch-rebind-client.tsx 的 REBIND_BATCH_APPLY_CAP 等于 REBIND_BATCH_LIMITS.apply", async () => {
    const { REBIND_BATCH_LIMITS } = await import("@/server/article-rebind/batch-constants");
    const clientSource = readFileSync(
      resolve(root, "src/app/(admin)/articles/batch-novel-rebind/_components/batch-rebind-client.tsx"),
      "utf8",
    );
    const match = clientSource.match(/const REBIND_BATCH_APPLY_CAP = (\d+);/);
    expect(match, "REBIND_BATCH_APPLY_CAP declaration not found in the client component").toBeTruthy();
    expect(Number(match![1])).toBe(REBIND_BATCH_LIMITS.apply);
  });

  it("客户端超限提示文案里的数字也来自同一个常量，不是又一份手写字面量", async () => {
    const { REBIND_BATCH_LIMITS } = await import("@/server/article-rebind/batch-constants");
    const clientSource = readFileSync(
      resolve(root, "src/app/(admin)/articles/batch-novel-rebind/_components/batch-rebind-client.tsx"),
      "utf8",
    );
    // The rendered copy must interpolate the constant rather than repeat the
    // literal — otherwise re-tuning the cap leaves the operator-facing number
    // stale even after the two constants above agree.
    expect(clientSource).not.toMatch(new RegExp(`上限（${REBIND_BATCH_LIMITS.apply} 篇）`));
    expect(clientSource).toMatch(/上限（\{REBIND_BATCH_APPLY_CAP\} 篇）/);
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
