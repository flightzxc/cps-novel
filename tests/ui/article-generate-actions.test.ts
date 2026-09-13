import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  origin: "https://admin.example.com" as string | null,
  sessionToken: "session-token-abc" as string | null,
}));

const guards = vi.hoisted(() => ({
  requireAdminActionAccess: vi.fn(),
  requireFreshAdminServiceMutation: vi.fn(),
}));

const contentCreation = vi.hoisted(() => {
  class ContentCreationInputError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = "ContentCreationInputError";
      this.code = code;
    }
  }
  class BlogArticleInputError extends Error {
    readonly code: string;
    constructor(code: string) {
      super(code);
      this.name = "BlogArticleInputError";
      this.code = code;
    }
  }
  return {
    ContentCreationInputError,
    BlogArticleInputError,
    generateArticleFromNovel: vi.fn(),
    createBlogArticle: vi.fn(),
  };
});

const articleGenerate = vi.hoisted(() => {
  class ArticleGenerateInputError extends Error {
    readonly code: string;
    constructor(code: string) {
      super(code);
      this.name = "ArticleGenerateInputError";
      this.code = code;
    }
  }
  return {
    ArticleGenerateInputError,
    enqueueArticleGenerateBatch: vi.fn(),
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
vi.mock("@/server/content-creation", () => contentCreation);
vi.mock("@/lib/tasks/article-generate", () => articleGenerate);
vi.mock("@/server/articles", () => ({
  ArticleConflictError: class extends Error {},
  regenerateArticle: vi.fn(),
  regenerateArticlesBatch: vi.fn(),
  updateArticleContent: vi.fn(),
}));
vi.mock("@/server/publish-gate", () => ({
  PublishLifecycleError: class extends Error {},
  publishArticleAsAdmin: vi.fn(),
  publishArticlesBatchAsAdmin: vi.fn(),
  withdrawNovel: vi.fn(),
}));
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

const {
  dryRunArticleGenerateAction,
  applyArticleGenerateAction,
  enqueueArticleGenerateBatchAction,
} = await import("@/app/(admin)/articles/_actions");

const IDENTITY = { id: "admin-1", username: "ops", role: "super_admin", status: "active", sessionVersion: 1, twoFactorEnabled: true };
const CONTEXT = { identity: IDENTITY, session: { id: "sess-1" }, twoFactorCompleted: true };

function granted() {
  return { context: CONTEXT, serviceAuthorization: { ticket: true } };
}

beforeEach(() => {
  guards.requireAdminActionAccess.mockReset();
  guards.requireFreshAdminServiceMutation.mockReset();
  contentCreation.generateArticleFromNovel.mockReset();
  articleGenerate.enqueueArticleGenerateBatch.mockReset();
  cache.revalidatePath.mockReset();
  harness.origin = "https://admin.example.com";
  harness.sessionToken = "session-token-abc";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("article generate actions reuse frozen capabilities", () => {
  it("dry-run uses content:view via admin.article.generate_dry_run", async () => {
    guards.requireAdminActionAccess.mockResolvedValue({ context: CONTEXT });
    contentCreation.generateArticleFromNovel.mockResolvedValue({ outcome: "dry_run", plan: { locale: "en" } });

    const result = await dryRunArticleGenerateAction({ novelId: "n1", requestId: "req-1" });
    expect(guards.requireAdminActionAccess.mock.calls[0][0]).toMatchObject({
      actionId: "admin.article.generate_dry_run",
      requestId: "req-1",
    });
    expect(contentCreation.generateArticleFromNovel).toHaveBeenCalledWith(
      { __brand: "prisma-stub" },
      expect.objectContaining({ novelId: "n1", mode: "dry_run" }),
    );
    expect(result).toEqual({ ok: true, data: { outcome: "dry_run", plan: { locale: "en" } } });
    expect(guards.requireFreshAdminServiceMutation).not.toHaveBeenCalled();
  });

  it("apply uses content:publish and revalidates only on created", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    guards.requireFreshAdminServiceMutation.mockResolvedValue(CONTEXT);
    contentCreation.generateArticleFromNovel.mockResolvedValue({ outcome: "created", novelId: "n1" });

    const created = await applyArticleGenerateAction({ novelId: "n1", requestId: "req-2", templateKey: "system-default-v1" });
    expect(guards.requireFreshAdminServiceMutation).toHaveBeenCalledWith(
      { ticket: true },
      "content:publish",
      expect.objectContaining({ entryId: "admin.article.generate_apply" }),
    );
    expect(created).toEqual({ ok: true, data: { outcome: "created", novelId: "n1" } });
    expect(cache.revalidatePath).toHaveBeenCalledWith("/articles");
    expect(cache.revalidatePath).toHaveBeenCalledWith("/novels");

    cache.revalidatePath.mockClear();
    contentCreation.generateArticleFromNovel.mockResolvedValue({ outcome: "already_exists", novelId: "n1" });
    await applyArticleGenerateAction({ novelId: "n1", requestId: "req-3" });
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it("batch enqueue uses content:publish and keeps novel ids (never source-item ids)", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    guards.requireFreshAdminServiceMutation.mockResolvedValue(CONTEXT);
    articleGenerate.enqueueArticleGenerateBatch.mockResolvedValue({ taskId: "task-1" });

    const result = await enqueueArticleGenerateBatchAction({
      novelIds: ["11111111-1111-4111-8111-111111111111"],
      requestId: "req-4",
      templateKeysByLocale: { en: "system-default-v1" },
    });
    expect(guards.requireAdminActionAccess.mock.calls[0][0]).toMatchObject({
      actionId: "admin.article.generate_batch",
    });
    expect(articleGenerate.enqueueArticleGenerateBatch).toHaveBeenCalledWith(
      { __brand: "prisma-stub" },
      expect.objectContaining({
        novelIds: ["11111111-1111-4111-8111-111111111111"],
        actorId: "admin-1",
      }),
    );
    expect(result).toEqual({ ok: true, taskId: "task-1" });
  });
});
