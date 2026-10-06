import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 文章「全选 → 后台批量发布」Server Action（2026-10-06）。
 *
 * 只验证 action 这一层的契约：以 `admin.article.publish_batch_task`（`content:publish`，
 * 与按钮同一能力）请求授权、要求两步验证的 fresh mutation 授权、提交人写进任务、用与
 * 列表同一个 WHERE 数草稿再入队、错误码映射。入队与枚举本身的数据库行为在真实库用例
 * （`tests/integration/tasks/article-publish-batch-postgres.test.ts`）里。
 */

const harness = vi.hoisted(() => ({
  origin: "https://admin.example.com" as string | null,
  sessionToken: "session-token-abc" as string | null,
}));
const guards = vi.hoisted(() => ({
  requireAdminActionAccess: vi.fn(),
  requireFreshAdminServiceMutation: vi.fn(),
}));
const articles = vi.hoisted(() => ({
  ArticleConflictError: class extends Error {},
  ARTICLE_ID_RESOLVE_MAX_LIMIT: 200,
  countArticlesForFilter: vi.fn(),
  listArticleIdsForFilter: vi.fn(),
  regenerateArticle: vi.fn(),
  regenerateArticlesBatch: vi.fn(),
  updateArticleContent: vi.fn(),
}));
const publish = vi.hoisted(() => ({ enqueueArticlePublishParentBatch: vi.fn() }));
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
const publishGate = vi.hoisted(() => ({
  PublishLifecycleError: class extends Error {},
  publishArticleAsAdmin: vi.fn(),
  publishArticlesBatchAsAdmin: vi.fn(),
  withdrawNovel: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (key: string) => (key.toLowerCase() === "origin" ? harness.origin : null),
  })),
}));
vi.mock("next/cache", () => cache);
vi.mock("@/server/auth/guards", () => guards);
vi.mock("@/server/articles", () => articles);
vi.mock("@/lib/tasks/article-publish", () => publish);
vi.mock("@/server/publish-gate", () => publishGate);
vi.mock("@/server/content-creation", () => ({
  ContentCreationInputError: class extends Error {},
  BlogArticleInputError: class extends Error {},
  createBlogArticle: vi.fn(),
  generateArticleFromNovel: vi.fn(),
  listNovelsForArticleGenerate: vi.fn(),
}));
vi.mock("@/server/article-templates", () => ({ listActiveArticleTemplateOptionsForLocales: vi.fn() }));
vi.mock("@/app/api/admin/_lib/deps", () => ({
  prisma: { __brand: "prisma-stub" },
  guardDependencies: () => ({ identities: "identities-stub", sessions: "sessions-stub", registry: "registry-stub" }),
  canonicalOrigin: async () => "https://admin.example.com",
  readSessionToken: async () => harness.sessionToken,
}));

const { enqueueArticlePublishBatchAction } = await import("@/app/(admin)/articles/_actions");
const { ArticlePublishInputError } = await import("@/domain/article-publish-batch");
const { AdminContentQueryError } = await import("@/server/admin-content");

const IDENTITY = { id: "admin-1", username: "ops", role: "super_admin", status: "active", sessionVersion: 1, twoFactorEnabled: true };
const CONTEXT = { identity: IDENTITY, session: { id: "sess-1" }, twoFactorCompleted: true };

function granted() {
  guards.requireAdminActionAccess.mockResolvedValue({ context: CONTEXT, serviceAuthorization: { ticket: true } });
  guards.requireFreshAdminServiceMutation.mockResolvedValue(CONTEXT);
}

beforeEach(() => {
  guards.requireAdminActionAccess.mockReset();
  guards.requireFreshAdminServiceMutation.mockReset();
  articles.countArticlesForFilter.mockReset();
  publish.enqueueArticlePublishParentBatch.mockReset();
  publishGate.publishArticlesBatchAsAdmin.mockReset();
  cache.revalidatePath.mockReset();
  harness.origin = "https://admin.example.com";
  harness.sessionToken = "session-token-abc";
});
afterEach(() => vi.unstubAllGlobals());

describe("enqueueArticlePublishBatchAction", () => {
  it("以 admin.article.publish_batch_task 请求授权，并要求 content:publish 的 fresh（两步验证）mutation 授权", async () => {
    granted();
    articles.countArticlesForFilter.mockResolvedValue(1234);
    publish.enqueueArticlePublishParentBatch.mockResolvedValue({ taskId: "task-1", duplicate: false, taskStatus: "pending" });
    await enqueueArticlePublishBatchAction({ requestId: "req-1", filters: { locale: "en" } });
    expect(guards.requireAdminActionAccess.mock.calls[0][0]).toMatchObject({
      actionId: "admin.article.publish_batch_task", requestId: "req-1",
    });
    expect(guards.requireFreshAdminServiceMutation.mock.calls[0].slice(1)).toEqual([
      "content:publish",
      expect.objectContaining({ entryId: "admin.article.publish_batch_task", requestId: "req-1" }),
    ]);
  });

  it("提交人写进任务；用与列表同一个 WHERE 数草稿（状态固定为 draft）再入队；成功后刷新任务中心", async () => {
    granted();
    articles.countArticlesForFilter.mockResolvedValue(29_000);
    publish.enqueueArticlePublishParentBatch.mockResolvedValue({ taskId: "task-9", duplicate: false, taskStatus: "pending" });
    const result = await enqueueArticlePublishBatchAction({
      requestId: "req-2", filters: { locale: "en", status: "draft", articleType: "all", search: "  love  " }, skipPreview: true,
    });
    expect(articles.countArticlesForFilter).toHaveBeenCalledWith(
      { __brand: "prisma-stub" }, { locale: "en", search: "love", status: "draft" },
    );
    expect(publish.enqueueArticlePublishParentBatch).toHaveBeenCalledWith({ __brand: "prisma-stub" }, {
      filter: { locale: "en", search: "love" },
      skipPreview: true,
      actorId: "admin-1",
      requestId: "req-2",
      draftCount: 29_000,
    });
    expect(cache.revalidatePath).toHaveBeenCalledWith("/tasks");
    expect(result).toEqual({ ok: true, data: { taskId: "task-9", duplicate: false, draftCount: 29_000 } });
  });

  it("默认不勾「暂不抓试读」（和按钮一致）", async () => {
    granted();
    articles.countArticlesForFilter.mockResolvedValue(5);
    publish.enqueueArticlePublishParentBatch.mockResolvedValue({ taskId: "t", duplicate: true, taskStatus: "pending" });
    const result = await enqueueArticlePublishBatchAction({ requestId: "req-3", filters: {} });
    expect(publish.enqueueArticlePublishParentBatch.mock.calls[0][1]).toMatchObject({ skipPreview: false });
    expect(result).toMatchObject({ ok: true, data: { duplicate: true } });
  });

  it("授权失败：不数草稿、不入队，返回 access_denied", async () => {
    guards.requireAdminActionAccess.mockRejectedValue(new Error("denied"));
    const result = await enqueueArticlePublishBatchAction({ requestId: "req-4", filters: {} });
    expect(result).toEqual({ ok: false, kind: "access_denied", code: "article_publish_batch_task_denied" });
    expect(articles.countArticlesForFilter).not.toHaveBeenCalled();
    expect(publish.enqueueArticlePublishParentBatch).not.toHaveBeenCalled();
  });

  it("没有两步验证（fresh 授权失败）：不入队", async () => {
    guards.requireAdminActionAccess.mockResolvedValue({ context: CONTEXT, serviceAuthorization: { ticket: true } });
    guards.requireFreshAdminServiceMutation.mockRejectedValue(new Error("two_factor_required"));
    const result = await enqueueArticlePublishBatchAction({ requestId: "req-5", filters: {} });
    expect(result).toMatchObject({ ok: false, kind: "access_denied" });
    expect(publish.enqueueArticlePublishParentBatch).not.toHaveBeenCalled();
  });

  it.each([
    ["筛选里选了非草稿状态", { status: "published" }, "filter_status_not_draft"],
    ["未知筛选键", { novelIdd: "x" }, "filter_key_unknown"],
  ])("非法筛选：%s → invalid_input，不入队", async (_label, filters, code) => {
    granted();
    const result = await enqueueArticlePublishBatchAction({ requestId: "req-6", filters: filters as never });
    expect(result).toEqual({ ok: false, kind: "invalid_input", code });
    expect(publish.enqueueArticlePublishParentBatch).not.toHaveBeenCalled();
  });

  it("入队层拒绝（超过 50000 篇 / 没有草稿）→ invalid_input 并带原码", async () => {
    granted();
    articles.countArticlesForFilter.mockResolvedValue(50_001);
    publish.enqueueArticlePublishParentBatch.mockRejectedValue(new ArticlePublishInputError("selection_too_large"));
    expect(await enqueueArticlePublishBatchAction({ requestId: "req-7", filters: {} }))
      .toEqual({ ok: false, kind: "invalid_input", code: "selection_too_large" });
  });

  it("筛选值本身不合法（列表同一个校验器抛 AdminContentQueryError）→ invalid_input", async () => {
    granted();
    articles.countArticlesForFilter.mockRejectedValue(new AdminContentQueryError("invalid_locale", "Locale is not registered"));
    expect(await enqueueArticlePublishBatchAction({ requestId: "req-8", filters: { locale: "xx" } }))
      .toEqual({ ok: false, kind: "invalid_input", code: "invalid_locale" });
  });

  it("不改同步路径：本 action 绝不调用同步批量发布", async () => {
    granted();
    articles.countArticlesForFilter.mockResolvedValue(3);
    publish.enqueueArticlePublishParentBatch.mockResolvedValue({ taskId: "t", duplicate: false, taskStatus: "pending" });
    await enqueueArticlePublishBatchAction({ requestId: "req-9", filters: {} });
    expect(publishGate.publishArticlesBatchAsAdmin).not.toHaveBeenCalled();
  });
});
