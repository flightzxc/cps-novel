import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `src/app/(admin)/novels/_actions.ts` — the PR-C3 Server Action wrapper
 * around `src/server/publish-gate`'s five previously-uncalled admin-facing
 * exports. Same real-module discipline `tests/ui/catalog-sync-actions.test.ts`
 * already established for `_actions.ts` files: import the real module and
 * call its real exported functions; mock only `@/server/auth/guards` and
 * `@/server/publish-gate` (Codex territory, covered elsewhere), plus the
 * page-local read helper `./_lib/read-primary-article` (this file's own
 * boundary to the database). `@/lib/auth/errors` (`AdminAccessError`) stays
 * real so the `instanceof` classification in `_actions.ts` is actually
 * exercised.
 */

const harness = vi.hoisted(() => ({
  origin: "https://admin.example.com" as string | null,
  sessionToken: "session-token-abc" as string | null,
}));

const guards = vi.hoisted(() => ({
  requireAdminActionAccess: vi.fn(),
}));

const publishGate = vi.hoisted(() => {
  class PublishLifecycleError extends Error {
    readonly code: string;
    readonly status = 409 as const;
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
    takedownNovel: vi.fn(),
    restoreNovel: vi.fn(),
  };
});

const readRefs = vi.hoisted(() => ({
  readPrimaryArticlesForNovels: vi.fn(),
}));

const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (key: string) => (key.toLowerCase() === "origin" ? harness.origin : null),
  })),
}));
vi.mock("next/cache", () => cache);
vi.mock("@/server/auth/guards", () => guards);
vi.mock("@/server/publish-gate", () => publishGate);
vi.mock("@/app/(admin)/novels/_lib/read-primary-article", () => readRefs);
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
vi.mock("@/app/api/admin/_lib/route", () => ({
  serviceDependencies: () => ({
    db: { __brand: "prisma-stub" },
    identities: "identities-stub",
    sessions: "sessions-stub",
  }),
}));

const { AdminAccessError } = await import("@/lib/auth/errors");
const { MAX_BATCH_PUBLISH_SELECTION } = await import(
  "@/app/(admin)/novels/_lib/batch-publish-constants"
);
const {
  publishArticleAction,
  withdrawNovelAction,
  takedownNovelAction,
  restoreNovelAction,
  publishNovelsBatchAction,
} = await import("@/app/(admin)/novels/_actions");

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
  publishGate.takedownNovel.mockReset();
  publishGate.restoreNovel.mockReset();
  readRefs.readPrimaryArticlesForNovels.mockReset();
  cache.revalidatePath.mockReset();
  harness.origin = "https://admin.example.com";
  harness.sessionToken = "session-token-abc";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("publishArticleAction · 鉴权与接线", () => {
  it("以 admin.article.publish 请求授权，并带上 session/origin/requestId", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    publishGate.publishArticleAsAdmin.mockResolvedValue({ outcome: "published", articleId: "a1", novelId: "n1", locale: "en", firstPublish: true });

    await publishArticleAction({ novelId: "n1", articleId: "a1", requestId: "req-1" });

    expect(guards.requireAdminActionAccess).toHaveBeenCalledTimes(1);
    const [input] = guards.requireAdminActionAccess.mock.calls[0];
    expect(input).toMatchObject({
      actionId: "admin.article.publish",
      sessionToken: "session-token-abc",
      origin: "https://admin.example.com",
      canonicalOrigin: "https://admin.example.com",
      requestId: "req-1",
    });
  });

  it("把 guard 发的 ticket 原样交给 publishArticleAsAdmin，db 来自 serviceDependencies", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    publishGate.publishArticleAsAdmin.mockResolvedValue({ outcome: "published", articleId: "a1", novelId: "n1", locale: "en", firstPublish: true });

    await publishArticleAction({ novelId: "n1", articleId: "a1", requestId: "req-1" });

    expect(publishGate.publishArticleAsAdmin).toHaveBeenCalledWith(
      { authorization: { ticket: true }, requestId: "req-1", articleId: "a1" },
      { db: { __brand: "prisma-stub" }, identities: "identities-stub", sessions: "sessions-stub" },
    );
  });

  it("成功时原样透传 service 返回值，并 revalidate 详情页与列表页", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    const payload = { outcome: "rejected" as const, gate: { publishable: false, reasons: ["promo_link_missing"], requiredMetadataMissing: null } };
    publishGate.publishArticleAsAdmin.mockResolvedValue(payload);

    const result = await publishArticleAction({ novelId: "n1", articleId: "a1", requestId: "req-1" });
    expect(result).toEqual({ ok: true, data: payload });
    expect(cache.revalidatePath).toHaveBeenCalledWith("/novels/n1");
    expect(cache.revalidatePath).toHaveBeenCalledWith("/novels");
  });

  it("守卫拒绝 → access_denied，且从不调用 service", async () => {
    guards.requireAdminActionAccess.mockRejectedValue(
      new AdminAccessError("admin_two_factor_required", 403, "2fa"),
    );
    const result = await publishArticleAction({ novelId: "n1", articleId: "a1", requestId: "req-1" });
    expect(result).toMatchObject({ ok: false, kind: "access_denied" });
    expect(result.ok === false && result.kind === "access_denied" && result.envelope.code).toBe(
      "admin_two_factor_required",
    );
    expect(publishGate.publishArticleAsAdmin).not.toHaveBeenCalled();
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it("registration 未来若丢了 capability（serviceAuthorization 为空）也 fail-closed 成 access_denied", async () => {
    guards.requireAdminActionAccess.mockResolvedValue({ context: CONTEXT, serviceAuthorization: undefined });
    const result = await publishArticleAction({ novelId: "n1", articleId: "a1", requestId: "req-1" });
    expect(result).toMatchObject({ ok: false, kind: "access_denied" });
    expect(publishGate.publishArticleAsAdmin).not.toHaveBeenCalled();
  });
});

describe.each([
  ["withdrawNovelAction", withdrawNovelAction, publishGate.withdrawNovel, "admin.novel.withdraw"] as const,
  ["takedownNovelAction", takedownNovelAction, publishGate.takedownNovel, "admin.novel.takedown"] as const,
  ["restoreNovelAction", restoreNovelAction, publishGate.restoreNovel, "admin.novel.restore"] as const,
])("%s · 鉴权、原因校验与接线", (_name, action, serviceFn, actionId) => {
  it(`以 ${actionId} 请求授权`, async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    serviceFn.mockResolvedValue({ novelId: "n1", novelStatus: "draft", affectedArticleIds: [] });

    await action({ novelId: "n1", requestId: "req-1", reason: "运营决定" });

    expect(guards.requireAdminActionAccess.mock.calls[0][0]).toMatchObject({ actionId });
  });

  it("原因为空白 → invalid_input reason_required，且从不调用 service", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    const result = await action({ novelId: "n1", requestId: "req-1", reason: "   " });
    expect(result).toEqual({ ok: false, kind: "invalid_input", code: "reason_required" });
    expect(serviceFn).not.toHaveBeenCalled();
  });

  it("原因超过 1000 字 → invalid_input reason_too_long，且从不调用 service", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    const result = await action({ novelId: "n1", requestId: "req-1", reason: "字".repeat(1001) });
    expect(result).toEqual({ ok: false, kind: "invalid_input", code: "reason_too_long" });
    expect(serviceFn).not.toHaveBeenCalled();
  });

  it("原因被 trim 后原样透传给 service，novelId/requestId 原样透传", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    serviceFn.mockResolvedValue({ novelId: "n1", novelStatus: "draft", affectedArticleIds: ["a1"] });

    await action({ novelId: "n1", requestId: "req-1", reason: "  运营决定  " });

    expect(serviceFn).toHaveBeenCalledWith(
      { authorization: { ticket: true }, requestId: "req-1", novelId: "n1", reason: "运营决定" },
      { db: { __brand: "prisma-stub" }, identities: "identities-stub", sessions: "sessions-stub" },
    );
  });

  it("service 抛 PublishLifecycleError → lifecycle_error，不是 access_denied", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    serviceFn.mockRejectedValue(new publishGate.PublishLifecycleError("novel_not_found", "gone"));

    const result = await action({ novelId: "n1", requestId: "req-1", reason: "运营决定" });
    expect(result).toEqual({ ok: false, kind: "lifecycle_error", code: "novel_not_found" });
  });

  it("守卫拒绝 → access_denied，且从不调用 service", async () => {
    guards.requireAdminActionAccess.mockRejectedValue(
      new AdminAccessError("admin_capability_denied", 403, "denied", { capability: "content:publish" }),
    );
    const result = await action({ novelId: "n1", requestId: "req-1", reason: "运营决定" });
    expect(result).toMatchObject({ ok: false, kind: "access_denied" });
    expect(serviceFn).not.toHaveBeenCalled();
  });

  it("成功后 revalidate 详情页与列表页", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    serviceFn.mockResolvedValue({ novelId: "n1", novelStatus: "draft", affectedArticleIds: [] });
    await action({ novelId: "n1", requestId: "req-1", reason: "运营决定" });
    expect(cache.revalidatePath).toHaveBeenCalledWith("/novels/n1");
    expect(cache.revalidatePath).toHaveBeenCalledWith("/novels");
  });
});

describe("publishNovelsBatchAction · 选择解析与批量结果分组", () => {
  it("以 admin.article.publish_batch 请求授权", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    readRefs.readPrimaryArticlesForNovels.mockResolvedValue(new Map());
    publishGate.publishArticlesBatchAsAdmin.mockResolvedValue({ results: [] });

    await publishNovelsBatchAction({ novelIds: [], requestId: "req-1" });
    // Empty selection short-circuits before the guard even matters for this
    // assertion — see the dedicated empty-selection test below. This one
    // exists to pin the actionId used once a real selection is supplied.
    await publishNovelsBatchAction({ novelIds: ["n1"], requestId: "req-2" });
    expect(guards.requireAdminActionAccess.mock.calls.at(-1)?.[0]).toMatchObject({
      actionId: "admin.article.publish_batch",
    });
  });

  it("空选择 → invalid_input selection_required，不调用读取或 service", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    const result = await publishNovelsBatchAction({ novelIds: [], requestId: "req-1" });
    expect(result).toEqual({ ok: false, kind: "invalid_input", code: "selection_required" });
    expect(readRefs.readPrimaryArticlesForNovels).not.toHaveBeenCalled();
    expect(publishGate.publishArticlesBatchAsAdmin).not.toHaveBeenCalled();
  });

  it("去重后的 novelId 集合喂给读取，只把有 Article 的 novelId 解析出的 articleId 交给批量发布", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    readRefs.readPrimaryArticlesForNovels.mockResolvedValue(
      new Map([
        ["n1", { articleId: "a1", locale: "en", slug: "s1", status: "draft" }],
        ["n2", { articleId: "a2", locale: "en", slug: "s2", status: "draft" }],
        // n3 deliberately absent — simulates a Novel with no Article yet.
      ]),
    );
    publishGate.publishArticlesBatchAsAdmin.mockResolvedValue({
      results: [
        { articleId: "a1", result: { outcome: "published", articleId: "a1", novelId: "n1", locale: "en", firstPublish: true } },
        { articleId: "a2", result: { outcome: "conflict" } },
      ],
    });

    const result = await publishNovelsBatchAction({
      novelIds: ["n1", "n2", "n3", "n1"],
      requestId: "req-1",
    });

    expect(readRefs.readPrimaryArticlesForNovels).toHaveBeenCalledWith(["n1", "n2", "n3"]);
    expect(publishGate.publishArticlesBatchAsAdmin).toHaveBeenCalledWith(
      { authorization: { ticket: true }, requestId: "req-1", articleIds: ["a1", "a2"] },
      { db: { __brand: "prisma-stub" }, identities: "identities-stub", sessions: "sessions-stub" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.items).toEqual([
      { kind: "resolved", novelId: "n1", articleId: "a1", result: { outcome: "published", articleId: "a1", novelId: "n1", locale: "en", firstPublish: true } },
      { kind: "resolved", novelId: "n2", articleId: "a2", result: { outcome: "conflict" } },
      { kind: "no_article", novelId: "n3" },
    ]);
    expect(result.data.summary).toEqual({ published: 1, rejected: 0, conflict: 1, notFound: 0, noArticle: 1 });
  });

  it("service 抛 PublishLifecycleError('batch_too_large') → lifecycle_error", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    readRefs.readPrimaryArticlesForNovels.mockResolvedValue(
      new Map([["n1", { articleId: "a1", locale: "en", slug: "s1", status: "draft" }]]),
    );
    publishGate.publishArticlesBatchAsAdmin.mockRejectedValue(
      new publishGate.PublishLifecycleError("batch_too_large", "too many"),
    );

    const result = await publishNovelsBatchAction({ novelIds: ["n1"], requestId: "req-1" });
    expect(result).toEqual({ ok: false, kind: "lifecycle_error", code: "batch_too_large" });
  });

  it("守卫拒绝 → access_denied，且从不读取或调用 service", async () => {
    guards.requireAdminActionAccess.mockRejectedValue(
      new AdminAccessError("admin_capability_denied", 403, "denied", { capability: "content:publish" }),
    );
    const result = await publishNovelsBatchAction({ novelIds: ["n1"], requestId: "req-1" });
    expect(result).toMatchObject({ ok: false, kind: "access_denied" });
    expect(readRefs.readPrimaryArticlesForNovels).not.toHaveBeenCalled();
    expect(publishGate.publishArticlesBatchAsAdmin).not.toHaveBeenCalled();
  });

  it("MAX_BATCH_PUBLISH_SELECTION 与服务端 MAX_BATCH_SIZE 保持一致（当前冻结为 200）", () => {
    expect(MAX_BATCH_PUBLISH_SELECTION).toBe(200);
  });
});
