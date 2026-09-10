import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B-2 · "14 个新 action（template 4 / article 3 / carousel 4 / security 3）
 * 各补一条动作层测试" (RC-4 lesson: 注册表穷举锁不住动作体字符串).
 *
 * `tests/ui/admin-content-registry.test.ts` / `tests/backend/auth/
 * admin-registry-parity.test.ts` only assert the `registry.ts` *table*
 * declares the right capability literal for each action id — they never run
 * the code that actually *asks* for a capability at request time. For
 * template/article/carousel, that ask happens twice: once when
 * `requireAdminActionAccess` resolves the registry entry (already covered
 * by the registry tests), and again inside the *service* function's own
 * `authorize()` helper, which independently hardcodes the capability
 * literal it passes to `requireFreshAdminServiceMutation`
 * (`requireAdminServiceMutation` then checks that literal against the
 * `AdminServiceAuthorization.capability` the guard issued — a genuine
 * second lock, not a redundant one, but one whose literal can drift from
 * the registry's on either side without a source-grep test noticing). This
 * file imports the real `_actions.ts` wrapper *and* the real service module
 * for each surface (only `@/server/auth/guards` and the admin deps wiring
 * are mocked — same discipline as `tests/ui/catalog-sync-actions.test.ts`),
 * so the service's actual hardcoded literal is what gets captured and
 * compared against the registry's independently-resolved declaration.
 *
 * Security's 3 actions have no such second call — `settings/security/_actions.ts`
 * calls `requireAdminActionAccess` directly and never touches
 * `requireFreshAdminServiceMutation` (施工规格 M12: "本人会话，无角色门" —
 * `ADMIN_SECURITY_ACTIONS` in `registry.ts` register no `capability` at
 * all). Their "capability === registry 声明" check is therefore: the
 * `actionId` the action body actually asks for resolves, in the real
 * registry, to `capability: undefined` — proving no role gate was
 * (re)introduced on a personal-account action and that the action body
 * still points at the *right* registered id, not a copy-pasted one that
 * happens to carry a real capability.
 *
 * Mutation proof (施工规格 B-2 "抽 3 个做变异证明"): `article-templates/
 * service.ts`'s `authorize()` and `articles/service.ts`'s `authorize()`
 * each hardcode a single literal shared by every action on that surface (4
 * template actions, 3 article actions respectively) — mutating either
 * literal from `"content:publish"` to `"content:view"` turns every test in
 * that surface's block red at once. Verified by hand during construction of
 * this file (see lane report); not re-run automatically here to keep this
 * suite a pure regression gate rather than a self-mutating one.
 */

const harness = vi.hoisted(() => ({
  origin: "https://admin.example.com" as string | null,
  sessionToken: "session-token-abc" as string | null,
}));

const guards = vi.hoisted(() => ({
  requireAdminActionAccess: vi.fn(),
  requireFreshAdminServiceMutation: vi.fn(),
}));

const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (key: string) => (key.toLowerCase() === "origin" ? harness.origin : null),
  })),
}));
vi.mock("next/cache", () => cache);
vi.mock("@/server/auth/guards", () => guards);
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
/** Security-only extra dependency module (`settings/security/_actions.ts`); unused by every other surface here but must resolve without a real DB. */
vi.mock("@/app/api/admin/_lib/auth-deps", () => ({
  authUnitOfWork: () => ({ __brand: "auth-unit-of-work-stub" }),
  twoFactorStore: () => ({ __brand: "two-factor-store-stub" }),
}));

const { P2_04_ADMIN_REGISTRY } = await import("@/app/api/admin/_lib/registry");
const { resolveAdminAction } = await import("@/server/auth/registry");

const { createTemplateAction, updateTemplateAction, setTemplateStatusAction, deleteTemplateAction } = await import(
  "@/app/(admin)/templates/_actions"
);
const { updateArticleAction, regenerateArticleAction, regenerateArticlesBatchAction } = await import(
  "@/app/(admin)/articles/_actions"
);
const { saveCarouselConfigAction, saveManualCarouselSlotAction, deleteManualCarouselSlotAction, enqueueCarouselComputeAction } = await import(
  "@/app/(admin)/home-carousel/_actions"
);
const { startSecuritySetupAction, confirmSecuritySetupAction, regenerateSecurityRecoveryCodesAction } = await import(
  "@/app/(admin)/settings/security/_actions"
);

const CONTEXT = { identity: { id: "admin-1" }, session: { id: "sess-1" } };

function granted() {
  return { context: CONTEXT, serviceAuthorization: { context: CONTEXT, capability: "stub", requestId: "req-1", entryId: "stub" } };
}

const TEMPLATE_FIXTURE = {
  templateKey: "tpl-1",
  templateName: "模板 1",
  // L10N P3: `ArticleTemplateWrite.locale` is now a required `string`
  // (contract.ts) — this fixture is only used to reach
  // `requireFreshAdminServiceMutation` (which the beforeEach hook rejects
  // before any DB access), so the exact value doesn't matter, but it must be
  // present for the object to satisfy the type.
  locale: "en",
  status: "active" as const,
  titleTemplate: "{novel_title}",
  contentTemplate: [{ type: "paragraph", content: "{novel_title}" }],
};

beforeEach(() => {
  harness.origin = "https://admin.example.com";
  harness.sessionToken = "session-token-abc";
  guards.requireAdminActionAccess.mockReset();
  guards.requireFreshAdminServiceMutation.mockReset();
  cache.revalidatePath.mockReset();
  // Default: the action-access guard succeeds (so control reaches the real
  // service), and the service-level guard rejects immediately — every
  // service call here starts with `await authorize(...)`, before any DB
  // access, so this reliably short-circuits before touching `deps.db`
  // (a plain object stub with no Prisma methods).
  guards.requireAdminActionAccess.mockResolvedValue(granted());
  guards.requireFreshAdminServiceMutation.mockRejectedValue(new Error("stop-before-db"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function capturedServiceCapability(run: () => Promise<unknown>) {
  await run();
  expect(guards.requireFreshAdminServiceMutation).toHaveBeenCalledTimes(1);
  const call = guards.requireFreshAdminServiceMutation.mock.calls[0]!;
  return { capability: call[1] as string, entryId: (call[2] as { entryId: string }).entryId };
}

describe("template/article/carousel · 动作体传给 requireFreshAdminServiceMutation 的 capability === registry 声明", () => {
  it.each([
    ["admin.article_template.create", () => createTemplateAction({ requestId: "r1", template: TEMPLATE_FIXTURE })],
    ["admin.article_template.update", () => updateTemplateAction({ requestId: "r1", id: "t1", template: TEMPLATE_FIXTURE })],
    ["admin.article_template.status", () => setTemplateStatusAction({ requestId: "r1", id: "t1", status: "active" })],
    ["admin.article_template.delete", () => deleteTemplateAction({ requestId: "r1", id: "t1" })],
    [
      "admin.article.update",
      () =>
        updateArticleAction({
          requestId: "r1",
          articleId: "a1",
          expectedUpdatedAt: "2026-09-05T00:00:00.000Z",
          patch: { title: "t", summary: "s", body: "<p>b</p>" },
        }),
    ],
    [
      "admin.article.regenerate",
      () => regenerateArticleAction({ requestId: "r1", articleId: "a1", expectedUpdatedAt: "2026-09-05T00:00:00.000Z" }),
    ],
    ["admin.article.regenerate_batch", () => regenerateArticlesBatchAction({ requestId: "r1", articleIds: ["a1"] })],
    [
      "admin.home_carousel.config",
      () => saveCarouselConfigAction({ requestId: "r1", cronSchedule: "0 3 * * *", cronTimezone: "Asia/Shanghai", cronEnabled: true }),
    ],
    [
      "admin.home_carousel.manual_upsert",
      () => saveManualCarouselSlotAction({ requestId: "r1", locale: "en", position: 1, articleId: "a1", enabled: true }),
    ],
    [
      "admin.home_carousel.manual_delete",
      () => deleteManualCarouselSlotAction({ requestId: "r1", id: "slot-1", locale: "en" }),
    ],
    ["admin.home_carousel.compute", () => enqueueCarouselComputeAction({ requestId: "r1", locale: "en" })],
  ] as const)("%s", async (actionId, run) => {
    const declared = resolveAdminAction(actionId, P2_04_ADMIN_REGISTRY);
    expect(declared, `${actionId} must be registered`).toBeDefined();
    expect(declared!.capability, `${actionId}'s registry entry must declare a capability`).toBeDefined();

    const { capability, entryId } = await capturedServiceCapability(run);
    expect(entryId).toBe(actionId);
    expect(capability).toBe(declared!.capability);
  });
});

describe("security · 本人会话动作不带角色 capability，且指向正确的注册 id", () => {
  it.each([
    ["admin.security.two_factor.start", () => startSecuritySetupAction({ requestId: "r1" })],
    ["admin.security.two_factor.confirm", () => confirmSecuritySetupAction({ requestId: "r1", code: "123456" })],
    ["admin.security.recovery_codes.regenerate", () => regenerateSecurityRecoveryCodesAction({ requestId: "r1", code: "123456" })],
  ] as const)("%s", async (actionId, run) => {
    // Security's guard() has no second, service-level call — short-circuit
    // at `requireAdminActionAccess` itself and inspect what it was asked for.
    guards.requireAdminActionAccess.mockRejectedValueOnce(new Error("stop-before-flow"));
    await run();

    expect(guards.requireAdminActionAccess).toHaveBeenCalledTimes(1);
    const [input] = guards.requireAdminActionAccess.mock.calls[0]!;
    expect(input.actionId).toBe(actionId);

    const declared = resolveAdminAction(input.actionId, P2_04_ADMIN_REGISTRY);
    expect(declared, `${actionId} must be registered`).toBeDefined();
    expect(declared!.capability).toBeUndefined();
  });
});
