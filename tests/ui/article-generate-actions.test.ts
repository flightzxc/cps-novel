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
    listNovelsForArticleGenerate: vi.fn(),
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
    enqueueArticleGenerateParentBatch: vi.fn(),
  };
});

const articleTemplates = vi.hoisted(() => ({
  listActiveArticleTemplateOptionsForLocales: vi.fn(),
}));

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
vi.mock("@/server/article-templates", () => articleTemplates);
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
  listArticleGenerateCandidatesAction,
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
  contentCreation.listNovelsForArticleGenerate.mockReset();
  articleGenerate.enqueueArticleGenerateBatch.mockReset();
  articleGenerate.enqueueArticleGenerateParentBatch.mockReset();
  articleTemplates.listActiveArticleTemplateOptionsForLocales.mockReset();
  articleTemplates.listActiveArticleTemplateOptionsForLocales.mockResolvedValue([]);
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
    articleGenerate.enqueueArticleGenerateBatch.mockResolvedValue({ taskId: "task-1", duplicate: false });

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
    expect(result).toEqual({ ok: true, taskId: "task-1", duplicate: false });
  });

  it("all_filtered enqueues a parent filter snapshot, never a novel id list", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    guards.requireFreshAdminServiceMutation.mockResolvedValue(CONTEXT);
    articleGenerate.enqueueArticleGenerateParentBatch.mockResolvedValue({ taskId: "parent-1", duplicate: false });

    const result = await enqueueArticleGenerateBatchAction({
      selection: { scope: "all_filtered", filter: { search: "old", locale: "en" } },
      requestId: "req-parent",
    });
    expect(articleGenerate.enqueueArticleGenerateParentBatch).toHaveBeenCalledWith(
      { __brand: "prisma-stub" },
      expect.objectContaining({
        filter: { search: "old", locale: "en" },
        actorId: "admin-1",
        requestId: "req-parent",
      }),
    );
    expect(articleGenerate.enqueueArticleGenerateBatch).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, taskId: "parent-1", duplicate: false });
    expect(JSON.stringify(result)).not.toMatch(/novelIds/);
  });

  it("candidate list uses content:view and returns the current page only", async () => {
    guards.requireAdminActionAccess.mockResolvedValue({ context: CONTEXT });
    const page = { rows: [], total: 201, page: 5, pageSize: 50 };
    contentCreation.listNovelsForArticleGenerate.mockResolvedValue(page);

    const result = await listArticleGenerateCandidatesAction({
      requestId: "req-list",
      search: "old",
      locale: "en",
      page: 5,
    });
    expect(guards.requireAdminActionAccess.mock.calls[0][0]).toMatchObject({
      actionId: "admin.article.generate_candidates",
    });
    expect(contentCreation.listNovelsForArticleGenerate).toHaveBeenCalledWith(
      { __brand: "prisma-stub" },
      expect.objectContaining({ search: "old", locale: "en", page: 5, eligibleOnly: true, pageSize: 50 }),
    );
    expect(result).toEqual({ ok: true, data: page, templates: [] });
    expect(articleTemplates.listActiveArticleTemplateOptionsForLocales).not.toHaveBeenCalled();
    expect(guards.requireFreshAdminServiceMutation).not.toHaveBeenCalled();
  });

  it("candidate list canonicalizes search/locale before querying", async () => {
    guards.requireAdminActionAccess.mockResolvedValue({ context: CONTEXT });
    contentCreation.listNovelsForArticleGenerate.mockResolvedValue({
      rows: [],
      total: 0,
      page: 1,
      pageSize: 50,
    });

    await listArticleGenerateCandidatesAction({
      requestId: "req-canonical",
      search: "Alpha ",
      locale: " en ",
      page: 1,
    });
    expect(contentCreation.listNovelsForArticleGenerate).toHaveBeenCalledWith(
      { __brand: "prisma-stub" },
      expect.objectContaining({ search: "Alpha", locale: "en", eligibleOnly: true, pageSize: 50 }),
    );

    contentCreation.listNovelsForArticleGenerate.mockClear();
    await listArticleGenerateCandidatesAction({
      requestId: "req-blank",
      search: "   ",
      locale: "  ",
    });
    const blankCall = contentCreation.listNovelsForArticleGenerate.mock.calls[0][1] as Record<string, unknown>;
    expect(blankCall).not.toHaveProperty("search");
    expect(blankCall).not.toHaveProperty("locale");
  });

  it("candidate list fetches templates only for locales on the current page", async () => {
    guards.requireAdminActionAccess.mockResolvedValue({ context: CONTEXT });
    contentCreation.listNovelsForArticleGenerate.mockResolvedValue({
      rows: [{ novelId: "n1", locale: "ja", title: "J", businessId: "b", hasLiveArticle: false, promoReady: true, promoOutcome: "ready" }],
      total: 1,
      page: 2,
      pageSize: 50,
    });
    articleTemplates.listActiveArticleTemplateOptionsForLocales.mockResolvedValue([
      { id: "tpl-1", templateKey: "ja-body", locale: "ja", version: 3 },
    ]);

    const result = await listArticleGenerateCandidatesAction({ requestId: "req-ja", page: 2 });
    expect(articleTemplates.listActiveArticleTemplateOptionsForLocales).toHaveBeenCalledWith(
      { __brand: "prisma-stub" },
      ["ja"],
      "novel_article",
    );
    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({ page: 2 }),
      templates: [{ templateKey: "ja-body", locale: "ja", version: 3 }],
    });
  });
});
