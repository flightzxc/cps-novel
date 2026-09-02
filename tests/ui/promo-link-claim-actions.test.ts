import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `enqueuePromoLinkClaimAction` (`src/app/(admin)/catalog-sync/_actions.ts`,
 * RC-1) — same real-module discipline `catalog-sync-actions.test.ts` already
 * established for the P0-S13 / PR-C2 triggers in that same file: only
 * `@/server/auth/guards`, `@/lib/tasks/promo-link-claim`,
 * `@/lib/tasks/promo-link-claim-limits`, `@/lib/flags` and
 * `@/app/api/admin/_lib/deps` (all Codex territory) are mocked;
 * `AdminAccessError` and `PromoLinkClaimTaskInputError`'s classification
 * stay real so the `instanceof` branches in `_actions.ts` are actually
 * exercised, not assumed.
 *
 * Kept as its own file rather than appended to `catalog-sync-actions.test.ts`
 * — this trigger's DB shape (a `prisma.channelCapability.findUnique`
 * pre-check with no `catalog-scan`/`content-creation` analogue) is different
 * enough from the other two suites in that file that a shared harness would
 * mostly duplicate itself.
 */

const harness = vi.hoisted(() => ({
  origin: "https://admin.example.com" as string | null,
  sessionToken: "session-token-abc" as string | null,
}));

const guards = vi.hoisted(() => ({
  requireAdminActionAccess: vi.fn(),
  requireFreshAdminServiceMutation: vi.fn(),
}));

const factory = vi.hoisted(() => {
  class PromoLinkClaimTaskInputError extends Error {
    readonly code: string;
    constructor(code: string) {
      super(code);
      this.name = "PromoLinkClaimTaskInputError";
      this.code = code;
    }
  }
  return {
    createPromoLinkClaimTask: vi.fn(),
    PromoLinkClaimTaskInputError,
    UPSTREAM_EXISTING_PROMO_OFFER_TYPE: "read",
  };
});

const limits = vi.hoisted(() => ({
  PROMO_LINK_CLAIM_LIMITS: Object.freeze({ maxBatchSize: 50, ttlMs: 21_600_000 }),
  PROMO_LINK_CLAIM_CAPABILITY_KEY: "claimPromo",
}));

const flags = vi.hoisted(() => ({
  state: { featureEnabled: true, writeAllowed: true },
}));

const channelCapability = vi.hoisted(() => ({ findUnique: vi.fn() }));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (key: string) => (key.toLowerCase() === "origin" ? harness.origin : null),
  })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth/guards", () => guards);
vi.mock("@/lib/tasks/promo-link-claim", () => factory);
vi.mock("@/lib/tasks/promo-link-claim-limits", () => limits);
vi.mock("@/lib/tasks/moboreader", () => ({
  createMoboreaderCatalogScanTask: vi.fn(),
  MoboreaderTaskInputError: class extends Error {},
}));
vi.mock("@/server/content-creation", () => ({
  createContentFromSourceItem: vi.fn(),
  ContentCreationInputError: class extends Error {},
}));
vi.mock("@/lib/flags", () => ({
  isNovelCatalogSyncEnabled: () => true,
  isNovelCatalogSyncWriteAllowed: () => true,
  isPromoLinkClaimEnabled: () => flags.state.featureEnabled,
  isPromoLinkClaimWriteAllowed: () => flags.state.writeAllowed,
}));
vi.mock("@/app/api/admin/_lib/deps", () => ({
  prisma: { __brand: "prisma-stub", channelCapability },
  guardDependencies: () => ({
    identities: "identities-stub",
    sessions: "sessions-stub",
    registry: "registry-stub",
  }),
  canonicalOrigin: async () => "https://admin.example.com",
  readSessionToken: async () => harness.sessionToken,
}));

const { AdminAccessError } = await import("@/lib/auth/errors");
const { enqueuePromoLinkClaimAction } = await import("@/app/(admin)/catalog-sync/_actions");

const IDENTITY = { id: "admin-1", username: "ops", role: "super_admin", status: "active", sessionVersion: 1, twoFactorEnabled: true };
const CONTEXT = { identity: IDENTITY, session: { id: "sess-1" }, twoFactorCompleted: true };

function granted(overrides: Partial<{ serviceAuthorization: unknown }> = {}) {
  return { context: CONTEXT, serviceAuthorization: overrides.serviceAuthorization ?? { ticket: true } };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INPUT = {
  channelAccountId: "acct-1",
  channelAppId: "app-1",
  novelSourceItemIds: ["src-1", "src-2"],
  mode: "dry_run" as const,
  requestId: "req-claim-1",
};

function enabledCapability() {
  channelCapability.findUnique.mockResolvedValue({ status: "enabled" });
}

beforeEach(() => {
  guards.requireAdminActionAccess.mockReset();
  guards.requireFreshAdminServiceMutation.mockReset();
  factory.createPromoLinkClaimTask.mockReset();
  channelCapability.findUnique.mockReset();
  harness.origin = "https://admin.example.com";
  harness.sessionToken = "session-token-abc";
  flags.state = { featureEnabled: true, writeAllowed: true };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("enqueuePromoLinkClaimAction · 鉴权与两步新鲜校验", () => {
  it("以 admin.promo_link_claim.enqueue 请求授权，并带上 session/origin/requestId", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    guards.requireFreshAdminServiceMutation.mockResolvedValue(CONTEXT);
    enabledCapability();
    factory.createPromoLinkClaimTask.mockResolvedValue({
      status: "enqueued",
      taskId: "task-1",
      taskStatus: "pending",
      eligibleCount: 2,
      skipReasonCounts: {},
    });

    await enqueuePromoLinkClaimAction(INPUT);

    expect(guards.requireAdminActionAccess).toHaveBeenCalledTimes(1);
    const [input, deps] = guards.requireAdminActionAccess.mock.calls[0];
    expect(input).toMatchObject({
      actionId: "admin.promo_link_claim.enqueue",
      sessionToken: "session-token-abc",
      origin: "https://admin.example.com",
      canonicalOrigin: "https://admin.example.com",
      requestId: "req-claim-1",
    });
    expect(deps).toMatchObject({ identities: "identities-stub", sessions: "sessions-stub" });
  });

  it("dry_run 与 apply 都会请求 requireFreshAdminServiceMutation(promo:claim)——两种模式共用同一个能力位", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    guards.requireFreshAdminServiceMutation.mockResolvedValue(CONTEXT);
    enabledCapability();
    factory.createPromoLinkClaimTask.mockResolvedValue({
      status: "enqueued",
      taskId: "task-1",
      taskStatus: "pending",
      eligibleCount: 2,
      skipReasonCounts: {},
    });

    await enqueuePromoLinkClaimAction({ ...INPUT, mode: "dry_run" });
    expect(guards.requireFreshAdminServiceMutation).toHaveBeenNthCalledWith(
      1,
      { ticket: true },
      "promo:claim",
      expect.objectContaining({
        identities: "identities-stub",
        sessions: "sessions-stub",
        entryId: "admin.promo_link_claim.enqueue",
        requestId: "req-claim-1",
      }),
    );

    await enqueuePromoLinkClaimAction({ ...INPUT, mode: "apply" });
    expect(guards.requireFreshAdminServiceMutation).toHaveBeenNthCalledWith(
      2,
      { ticket: true },
      "promo:claim",
      expect.objectContaining({ entryId: "admin.promo_link_claim.enqueue" }),
    );
  });

  it("守卫拒绝（AdminAccessError）→ access_denied，且从不触碰能力位查询或工厂函数", async () => {
    guards.requireAdminActionAccess.mockRejectedValue(
      new AdminAccessError("admin_capability_denied", 403, "denied", { capability: "promo:claim" }),
    );

    const result = await enqueuePromoLinkClaimAction(INPUT);
    expect(result).toEqual({
      ok: false,
      kind: "access_denied",
      envelope: {
        ok: false,
        status: 403,
        code: "admin_capability_denied",
        details: { capability: "promo:claim" },
      },
    });
    expect(channelCapability.findUnique).not.toHaveBeenCalled();
    expect(factory.createPromoLinkClaimTask).not.toHaveBeenCalled();
  });

  it("拿到 ticket 后 requireFreshAdminServiceMutation 再次拒绝（例如会话已失效）→ access_denied，且不查能力位、不写入", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    guards.requireFreshAdminServiceMutation.mockRejectedValue(
      new AdminAccessError("jwt_invalid", 401, "stale session"),
    );

    const result = await enqueuePromoLinkClaimAction(INPUT);
    expect(result).toMatchObject({ ok: false, kind: "access_denied" });
    expect(channelCapability.findUnique).not.toHaveBeenCalled();
    expect(factory.createPromoLinkClaimTask).not.toHaveBeenCalled();
  });

  it("registration 未来若丢了 capability（serviceAuthorization 为空）也 fail-closed 成 access_denied", async () => {
    guards.requireAdminActionAccess.mockResolvedValue({ context: CONTEXT, serviceAuthorization: undefined });

    const result = await enqueuePromoLinkClaimAction(INPUT);
    expect(result).toMatchObject({ ok: false, kind: "access_denied" });
    expect(guards.requireFreshAdminServiceMutation).not.toHaveBeenCalled();
    expect(factory.createPromoLinkClaimTask).not.toHaveBeenCalled();
  });
});

describe("enqueuePromoLinkClaimAction · 输入校验（非空/去重/上限），不依赖工厂自己的校验", () => {
  beforeEach(() => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    guards.requireFreshAdminServiceMutation.mockResolvedValue(CONTEXT);
  });

  it("channelAppId 为空 → invalid_input channel_app_required，且不查能力位、不调工厂", async () => {
    const result = await enqueuePromoLinkClaimAction({ ...INPUT, channelAppId: "  " });
    expect(result).toEqual({ ok: false, kind: "invalid_input", code: "channel_app_required" });
    expect(channelCapability.findUnique).not.toHaveBeenCalled();
    expect(factory.createPromoLinkClaimTask).not.toHaveBeenCalled();
  });

  it("channelAccountId 为空 → invalid_input channel_account_required", async () => {
    const result = await enqueuePromoLinkClaimAction({ ...INPUT, channelAccountId: "" });
    expect(result).toEqual({ ok: false, kind: "invalid_input", code: "channel_account_required" });
  });

  it("novelSourceItemIds 为空数组 → invalid_input items_required——从构造上就拒绝「按筛选全量」式空选择", async () => {
    const result = await enqueuePromoLinkClaimAction({ ...INPUT, novelSourceItemIds: [] });
    expect(result).toEqual({ ok: false, kind: "invalid_input", code: "items_required" });
  });

  it("超过工厂常量 maxBatchSize → invalid_input batch_size_exceeded，且上限来自导入的常量而非硬编码", async () => {
    const tooMany = Array.from({ length: limits.PROMO_LINK_CLAIM_LIMITS.maxBatchSize + 1 }, (_, i) => `src-${i}`);
    const result = await enqueuePromoLinkClaimAction({ ...INPUT, novelSourceItemIds: tooMany });
    expect(result).toEqual({ ok: false, kind: "invalid_input", code: "batch_size_exceeded" });
    expect(channelCapability.findUnique).not.toHaveBeenCalled();
  });

  it("去重后不超限则放行——重复 id 不计入批量上限", async () => {
    enabledCapability();
    factory.createPromoLinkClaimTask.mockResolvedValue({
      status: "enqueued",
      taskId: "task-1",
      taskStatus: "pending",
      eligibleCount: 1,
      skipReasonCounts: {},
    });
    const duplicated = Array.from({ length: limits.PROMO_LINK_CLAIM_LIMITS.maxBatchSize + 20 }, () => "src-1");
    const result = await enqueuePromoLinkClaimAction({ ...INPUT, novelSourceItemIds: duplicated });
    expect(result.ok).toBe(true);
    const [, factoryInput] = factory.createPromoLinkClaimTask.mock.calls[0];
    expect(factoryInput.items).toHaveLength(1);
  });
});

describe("enqueuePromoLinkClaimAction · ChannelCapability 能力位前置检查", () => {
  beforeEach(() => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    guards.requireFreshAdminServiceMutation.mockResolvedValue(CONTEXT);
  });

  it("查询用的是 (channelAppId, capabilityKey) 复合键，capabilityKey 取自工厂的登记常量", async () => {
    enabledCapability();
    factory.createPromoLinkClaimTask.mockResolvedValue({
      status: "enqueued",
      taskId: "task-1",
      taskStatus: "pending",
      eligibleCount: 2,
      skipReasonCounts: {},
    });

    await enqueuePromoLinkClaimAction(INPUT);

    expect(channelCapability.findUnique).toHaveBeenCalledWith({
      where: {
        channelAppId_capabilityKey: { channelAppId: "app-1", capabilityKey: "claimPromo" },
      },
      select: { status: true },
    });
  });

  it("status 不是 enabled（registered_disabled）→ ok:true, capability_disabled，不调用工厂，不创建任务行", async () => {
    channelCapability.findUnique.mockResolvedValue({ status: "registered_disabled" });

    const result = await enqueuePromoLinkClaimAction(INPUT);
    expect(result).toEqual({
      ok: true,
      data: { outcome: "capability_disabled", channelAppId: "app-1" },
    });
    expect(factory.createPromoLinkClaimTask).not.toHaveBeenCalled();
  });

  it("能力位记录不存在（null）→ 同样按 capability_disabled 处理，不是当成异常", async () => {
    channelCapability.findUnique.mockResolvedValue(null);

    const result = await enqueuePromoLinkClaimAction(INPUT);
    expect(result).toEqual({
      ok: true,
      data: { outcome: "capability_disabled", channelAppId: "app-1" },
    });
    expect(factory.createPromoLinkClaimTask).not.toHaveBeenCalled();
  });
});

describe("enqueuePromoLinkClaimAction · 调用工厂的参数形状", () => {
  beforeEach(() => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    guards.requireFreshAdminServiceMutation.mockResolvedValue(CONTEXT);
    enabledCapability();
    factory.createPromoLinkClaimTask.mockResolvedValue({
      status: "enqueued",
      taskId: "task-1",
      taskStatus: "pending",
      eligibleCount: 2,
      skipReasonCounts: {},
    });
  });

  it("items 数组把每个 novelSourceItemId 都配上硬编码的 offerType（'read'），不是调用方可控字段", async () => {
    await enqueuePromoLinkClaimAction(INPUT);
    const [db, input] = factory.createPromoLinkClaimTask.mock.calls[0];
    expect(db).toEqual({ __brand: "prisma-stub", channelCapability });
    expect(input.items).toEqual([
      { novelSourceItemId: "src-1", offerType: "read" },
      { novelSourceItemId: "src-2", offerType: "read" },
    ]);
  });

  it("actorId 取自 requireFreshAdminServiceMutation 返回的新鲜身份，requestId 原样透传，mode 原样透传", async () => {
    guards.requireFreshAdminServiceMutation.mockResolvedValue({
      identity: { ...IDENTITY, id: "fresh-admin-9" },
    });

    await enqueuePromoLinkClaimAction({ ...INPUT, mode: "apply" });
    const [, input] = factory.createPromoLinkClaimTask.mock.calls[0];
    expect(input).toMatchObject({
      channelAccountId: "acct-1",
      channelAppId: "app-1",
      actorId: "fresh-admin-9",
      requestId: "req-claim-1",
      mode: "apply",
    });
  });

  it("requestToken 是服务端现铸的 UUID，两次提交各自不同——调用方无法重放或提供自己的幂等键", async () => {
    await enqueuePromoLinkClaimAction(INPUT);
    await enqueuePromoLinkClaimAction(INPUT);

    const [firstCall, secondCall] = factory.createPromoLinkClaimTask.mock.calls;
    expect(firstCall[1].requestToken).toMatch(UUID_RE);
    expect(secondCall[1].requestToken).toMatch(UUID_RE);
    expect(firstCall[1].requestToken).not.toBe(secondCall[1].requestToken);
  });
});

describe("enqueuePromoLinkClaimAction · 结果分类（工厂五种 status 各自独立）", () => {
  beforeEach(() => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    guards.requireFreshAdminServiceMutation.mockResolvedValue(CONTEXT);
    enabledCapability();
  });

  it("enqueued + taskStatus pending → enqueued，带 eligibleCount 与 skipReasonCounts", async () => {
    factory.createPromoLinkClaimTask.mockResolvedValue({
      status: "enqueued",
      taskId: "task-1",
      taskStatus: "pending",
      eligibleCount: 2,
      skipReasonCounts: { source_not_linked: 1 },
    });
    const result = await enqueuePromoLinkClaimAction(INPUT);
    expect(result).toEqual({
      ok: true,
      data: {
        outcome: "enqueued",
        taskId: "task-1",
        mode: "dry_run",
        eligibleCount: 2,
        skipReasonCounts: { source_not_linked: 1 },
      },
    });
  });

  it("enqueued + taskStatus disabled → enqueued_disabled，flags 字段是调用时刻两个闸的实时读数", async () => {
    factory.createPromoLinkClaimTask.mockResolvedValue({
      status: "enqueued",
      taskId: "task-2",
      taskStatus: "disabled",
      eligibleCount: 1,
      skipReasonCounts: {},
    });
    flags.state = { featureEnabled: false, writeAllowed: false };

    const result = await enqueuePromoLinkClaimAction(INPUT);
    expect(result).toEqual({
      ok: true,
      data: {
        outcome: "enqueued_disabled",
        taskId: "task-2",
        mode: "dry_run",
        eligibleCount: 1,
        skipReasonCounts: {},
        flags: { featureEnabled: false, writeAllowed: false },
      },
    });
  });

  it("enqueued_disabled 的 flags 两个闸各自独立上报，不因为其中一个开了就都算开", async () => {
    factory.createPromoLinkClaimTask.mockResolvedValue({
      status: "enqueued",
      taskId: "task-3",
      taskStatus: "disabled",
      eligibleCount: 1,
      skipReasonCounts: {},
    });
    flags.state = { featureEnabled: true, writeAllowed: false };

    const result = await enqueuePromoLinkClaimAction(INPUT);
    expect(result).toMatchObject({
      ok: true,
      data: { flags: { featureEnabled: true, writeAllowed: false } },
    });
  });

  it("duplicate → 幂等命中，不带 mode/eligibleCount 字段", async () => {
    factory.createPromoLinkClaimTask.mockResolvedValue({ status: "duplicate", taskId: "task-existing" });
    const result = await enqueuePromoLinkClaimAction(INPUT);
    expect(result).toEqual({ ok: true, data: { outcome: "duplicate", taskId: "task-existing" } });
  });

  it("active_conflict → 已有进行中领取任务，不带 mode 字段", async () => {
    factory.createPromoLinkClaimTask.mockResolvedValue({ status: "active_conflict", taskId: "task-active" });
    const result = await enqueuePromoLinkClaimAction(INPUT);
    expect(result).toEqual({ ok: true, data: { outcome: "active_conflict", taskId: "task-active" } });
  });

  it("no_eligible_sources → 所选条目全部被跳过，skipReasonCounts 逐条透传", async () => {
    factory.createPromoLinkClaimTask.mockResolvedValue({
      status: "no_eligible_sources",
      skipReasonCounts: { source_not_linked: 2, item_already_active_elsewhere: 1 },
    });
    const result = await enqueuePromoLinkClaimAction(INPUT);
    expect(result).toEqual({
      ok: true,
      data: {
        outcome: "no_eligible_sources",
        skipReasonCounts: { source_not_linked: 2, item_already_active_elsewhere: 1 },
      },
    });
  });

  it("工厂抛 PromoLinkClaimTaskInputError → invalid_input，不是 access_denied", async () => {
    factory.createPromoLinkClaimTask.mockRejectedValue(
      new factory.PromoLinkClaimTaskInputError("active_channel_binding_required"),
    );
    const result = await enqueuePromoLinkClaimAction(INPUT);
    expect(result).toEqual({ ok: false, kind: "invalid_input", code: "active_channel_binding_required" });
  });
});
