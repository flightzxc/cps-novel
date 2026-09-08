import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * C-21 (`分析_文章管理Parity缺口_2026-09-08.md` §六): the article list's new
 * row-level 发布/下线 and list-level 批量发布 Server Action wrappers
 * (`src/app/(admin)/articles/_actions.ts`'s `publishArticleAction`,
 * `withdrawArticleAction`, `publishArticlesBatchAction`).
 *
 * Same harness discipline as `tests/ui/catalog-sync-actions.test.ts`: mocks
 * everything the module reaches into `@/server/**`/`next/headers`/
 * `next/cache` for, then drives the real, unmocked `_actions.ts` function
 * bodies — the doc's own C-21 test guidance is "发布门禁本身已有覆盖
 * （`tests/backend/publish-gate/`），仅补动作层封装的错误码映射", which is
 * exactly what this file pins: which `actionId`/entryId each wrapper
 * requests, that it forwards the right arguments to the (mocked) publish-gate
 * primitive, which paths it revalidates, and that `PublishLifecycleError`'s
 * `code` survives the wrapper instead of collapsing to the generic fallback
 * (mirroring `ArticleConflictError`'s existing precedent in this same file).
 */

const harness = vi.hoisted(() => ({
  origin: "https://admin.example.com" as string | null,
  sessionToken: "session-token-abc" as string | null,
}));

const guards = vi.hoisted(() => ({
  requireAdminActionAccess: vi.fn(),
}));

const articlesService = vi.hoisted(() => {
  class ArticleConflictError extends Error {
    readonly code: string;
    constructor(code: string) {
      super(code);
      this.name = "ArticleConflictError";
      this.code = code;
    }
  }
  return {
    ArticleConflictError,
    regenerateArticle: vi.fn(),
    regenerateArticlesBatch: vi.fn(),
    updateArticleContent: vi.fn(),
  };
});

const publishGate = vi.hoisted(() => {
  class PublishLifecycleError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = "PublishLifecycleError";
      this.code = code;
    }
  }
  return {
    PublishLifecycleError,
    publishArticleAsAdmin: vi.fn(),
    publishArticlesBatchAsAdmin: vi.fn(),
    withdrawNovel: vi.fn(),
  };
});

const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (key: string) => (key.toLowerCase() === "origin" ? harness.origin : null),
  })),
}));
vi.mock("next/cache", () => cache);
vi.mock("@/server/auth/guards", () => guards);
vi.mock("@/server/articles", () => articlesService);
vi.mock("@/server/publish-gate", () => publishGate);
vi.mock("@/app/api/admin/_lib/deps", () => ({
  prisma: { __brand: "prisma-stub" },
  guardDependencies: () => ({
    identities: "identities-stub",
    sessions: "sessions-stub",
    registry: "registry-stub",
  }),
  canonicalOrigin: async () => "https://admin.example.com",
  readSessionToken: async () => harness.sessionToken,
}));

const { publishArticleAction, withdrawArticleAction, publishArticlesBatchAction } = await import(
  "@/app/(admin)/articles/_actions"
);

const IDENTITY = { id: "admin-1", username: "ops", role: "super_admin", status: "active", sessionVersion: 1, twoFactorEnabled: true };
const CONTEXT = { identity: IDENTITY, session: { id: "sess-1" }, twoFactorCompleted: true };

function granted() {
  return { context: CONTEXT, serviceAuthorization: { ticket: true } };
}

beforeEach(() => {
  guards.requireAdminActionAccess.mockReset();
  publishGate.publishArticleAsAdmin.mockReset();
  publishGate.publishArticlesBatchAsAdmin.mockReset();
  publishGate.withdrawNovel.mockReset();
  cache.revalidatePath.mockReset();
  harness.origin = "https://admin.example.com";
  harness.sessionToken = "session-token-abc";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("publishArticleAction · 鉴权与透传", () => {
  it("以 admin.article.publish 请求授权，把 articleId/requestId 转发给 publishArticleAsAdmin", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    publishGate.publishArticleAsAdmin.mockResolvedValue({ outcome: "published", articleId: "a1", novelId: "n1", locale: "en", firstPublish: true });

    const result = await publishArticleAction({ requestId: "req-1", articleId: "a1" });

    expect(guards.requireAdminActionAccess).toHaveBeenCalledTimes(1);
    const [input] = guards.requireAdminActionAccess.mock.calls[0];
    expect(input).toMatchObject({
      actionId: "admin.article.publish",
      sessionToken: "session-token-abc",
      origin: "https://admin.example.com",
      requestId: "req-1",
    });

    expect(publishGate.publishArticleAsAdmin).toHaveBeenCalledTimes(1);
    const [call] = publishGate.publishArticleAsAdmin.mock.calls[0];
    expect(call).toMatchObject({ authorization: { ticket: true }, requestId: "req-1", articleId: "a1" });

    expect(result).toEqual({ ok: true, data: { outcome: "published", articleId: "a1", novelId: "n1", locale: "en", firstPublish: true } });
    expect(cache.revalidatePath).toHaveBeenCalledWith("/articles");
  });

  it("outcome: rejected/conflict/not_found 原样透传，不被当成失败（发布门禁的拒绝不是动作层错误）", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    const rejected = { outcome: "rejected", gate: { publishable: false, reasons: ["preview_chapter_missing"] } };
    publishGate.publishArticleAsAdmin.mockResolvedValue(rejected);

    const result = await publishArticleAction({ requestId: "req-1", articleId: "a1" });
    expect(result).toEqual({ ok: true, data: rejected });
  });

  it("PublishLifecycleError 的 code 原样透传，而不是折叠成通用 fallback（同 ArticleConflictError 既有约定）", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    publishGate.publishArticleAsAdmin.mockRejectedValue(new publishGate.PublishLifecycleError("article_not_found", "gone"));

    const result = await publishArticleAction({ requestId: "req-1", articleId: "a1" });
    expect(result).toEqual({ ok: false, code: "article_not_found" });
  });

  it("未预期的错误折叠为 article_publish_failed", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    publishGate.publishArticleAsAdmin.mockRejectedValue(new Error("boom"));

    const result = await publishArticleAction({ requestId: "req-1", articleId: "a1" });
    expect(result).toEqual({ ok: false, code: "article_publish_failed" });
  });

  it("鉴权被拒绝时不调用 publishArticleAsAdmin", async () => {
    guards.requireAdminActionAccess.mockResolvedValue({ context: CONTEXT });

    const result = await publishArticleAction({ requestId: "req-1", articleId: "a1" });
    expect(result).toEqual({ ok: false, code: "article_publish_failed" });
    expect(publishGate.publishArticleAsAdmin).not.toHaveBeenCalled();
  });
});

describe("withdrawArticleAction · 鉴权与透传", () => {
  it("以 admin.novel.withdraw 请求授权，把 novelId/reason 转发给 withdrawNovel，并额外 revalidate 该书目详情页", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    publishGate.withdrawNovel.mockResolvedValue({ novelId: "n1", novelStatus: "unpublished", affectedArticleIds: ["a1"] });

    const result = await withdrawArticleAction({ requestId: "req-2", novelId: "n1", reason: "运营决定下线" });

    const [input] = guards.requireAdminActionAccess.mock.calls[0];
    expect(input).toMatchObject({ actionId: "admin.novel.withdraw", requestId: "req-2" });

    const [call] = publishGate.withdrawNovel.mock.calls[0];
    expect(call).toMatchObject({ authorization: { ticket: true }, requestId: "req-2", novelId: "n1", reason: "运营决定下线" });

    expect(result).toEqual({ ok: true, data: { novelId: "n1", novelStatus: "unpublished", affectedArticleIds: ["a1"] } });
    expect(cache.revalidatePath).toHaveBeenCalledWith("/articles");
    expect(cache.revalidatePath).toHaveBeenCalledWith("/novels/n1");
  });

  it("PublishLifecycleError（如 novel_not_currently_published）的 code 原样透传", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    publishGate.withdrawNovel.mockRejectedValue(
      new publishGate.PublishLifecycleError("novel_not_currently_published", "not published"),
    );

    const result = await withdrawArticleAction({ requestId: "req-2", novelId: "n1", reason: "x" });
    expect(result).toEqual({ ok: false, code: "novel_not_currently_published" });
  });

  it("空理由被 withdrawNovel 拒绝（裸 Error）时折叠为 article_withdraw_failed——UI 层负责在提交前拦住空理由", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    publishGate.withdrawNovel.mockRejectedValue(new Error("A reason is required"));

    const result = await withdrawArticleAction({ requestId: "req-2", novelId: "n1", reason: "" });
    expect(result).toEqual({ ok: false, code: "article_withdraw_failed" });
  });
});

describe("publishArticlesBatchAction · 鉴权与透传", () => {
  it("以 admin.article.publish_batch 请求授权，把 articleIds 原样转发", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    const payload = { results: [{ articleId: "a1", result: { outcome: "published", articleId: "a1", novelId: "n1", locale: "en", firstPublish: false } }] };
    publishGate.publishArticlesBatchAsAdmin.mockResolvedValue(payload);

    const result = await publishArticlesBatchAction({ requestId: "req-3", articleIds: ["a1"] });

    const [input] = guards.requireAdminActionAccess.mock.calls[0];
    expect(input).toMatchObject({ actionId: "admin.article.publish_batch", requestId: "req-3" });

    const [call] = publishGate.publishArticlesBatchAsAdmin.mock.calls[0];
    expect(call).toMatchObject({ authorization: { ticket: true }, requestId: "req-3", articleIds: ["a1"] });

    expect(result).toEqual({ ok: true, data: payload });
    expect(cache.revalidatePath).toHaveBeenCalledWith("/articles");
  });

  it("超过发布门禁批量上限时 batch_too_large 原样透传", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    publishGate.publishArticlesBatchAsAdmin.mockRejectedValue(
      new publishGate.PublishLifecycleError("batch_too_large", "too many"),
    );

    const result = await publishArticlesBatchAction({ requestId: "req-3", articleIds: ["a1", "a2"] });
    expect(result).toEqual({ ok: false, code: "batch_too_large" });
  });
});
