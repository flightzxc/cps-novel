import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `src/app/(admin)/catalog-sync/_actions.ts` — the Server Action wrapper this
 * file's whole existence is to guard-test. Every other test in this repo that
 * touches an `_actions.ts` module mocks the entire module away
 * (`tests/ui/admin-channel-accounts.test.tsx`) or only greps its source text
 * (`tests/backend/auth/admin-registry-parity.test.ts`,
 * `tests/ui/admin-content-registry.test.ts`) — neither approach exercises the
 * wrapper's own logic (which capability it asks for, whether it hardcodes
 * `mode`/`locale` correctly, how it classifies a thrown error). This file
 * imports the real module and calls its real exported functions, following
 * the one precedent that already does exactly that for a route handler
 * (`tests/ui/health-route-contract.test.ts`): mock everything the module
 * reaches into `src/server/**`/`next/headers`/`next/cache` for, then drive
 * the real function body.
 *
 * `@/server/auth/guards` and `@/server/content-creation` are Codex territory
 * — mocked as test doubles per the task brief, never asserted against their
 * real implementations (those have their own coverage elsewhere). `@/lib/
 * auth/errors` (`AdminAccessError`) is deliberately left real: the action
 * catches it via `instanceof`, and `../../api/admin/_lib/respond.ts`'s
 * `toErrorEnvelope` also does a real `instanceof` check, so a fake shape
 * would silently break the exact wiring this file exists to prove.
 */

const harness = vi.hoisted(() => ({
  origin: "https://admin.example.com" as string | null,
  sessionToken: "session-token-abc" as string | null,
}));

const guards = vi.hoisted(() => ({
  requireAdminActionAccess: vi.fn(),
  requireFreshAdminServiceMutation: vi.fn(),
}));

const service = vi.hoisted(() => {
  class ContentCreationInputError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = "ContentCreationInputError";
      this.code = code;
    }
  }
  return {
    createContentFromSourceItem: vi.fn(),
    ContentCreationInputError,
  };
});

/**
 * `@/lib/tasks/moboreader` and `@/lib/flags` are both Codex territory
 * (`src/lib/tasks/`, `src/lib/flags/`) — mocked as test doubles, same
 * discipline as `@/server/content-creation` above. `flags.state` is mutable
 * per-test so `classifyCatalogScanResult`'s `created_disabled` branch (which
 * re-reads both flags live, independent of what the factory itself decided)
 * can be exercised without needing real env vars.
 */
const moboreader = vi.hoisted(() => {
  class MoboreaderTaskInputError extends Error {
    readonly code: string;
    constructor(code: string) {
      super(code);
      this.name = "MoboreaderTaskInputError";
      this.code = code;
    }
  }
  return {
    createMoboreaderCatalogScanTask: vi.fn(),
    MoboreaderTaskInputError,
    // Phase B: `_actions.ts` now resolves the safety-max-pages / recommended
    // page-size values itself (the operator no longer supplies page
    // params — see `施工工单_PhaseB_实体订正与运营表单Parity_2026-09-06.md`
    // §三), so the fully-mocked module needs these two real exports stubbed.
    // C-13 (`施工工单_C13_每页100本与节流余量_2026-09-07.md`): the action now
    // calls `resolveMoboreaderUpstreamRecommendedPageSize()` (the env
    // resolver) rather than reading the bare `MOBOREADER_UPSTREAM_RECOMMENDED_PAGE_SIZE`
    // constant, so the mock stubs the resolver instead.
    resolveMoboreaderCatalogSafetyMaxPages: vi.fn(() => 2000),
    resolveMoboreaderUpstreamRecommendedPageSize: vi.fn(() => 20),
  };
});

/**
 * RC-4's batch wrapper (`@/server/content-creation/batch`, Codex territory) —
 * mocked as a test double exactly like `@/server/content-creation` above. Its
 * two exported constants have to be re-declared here because
 * `_actions.ts` imports them in a *value* position (they are forwarded as
 * `budgetMs` and used by the pre-check), so an incomplete mock would surface
 * as `undefined` rather than as a missing-export error.
 */
const batchService = vi.hoisted(() => {
  class ContentCreationBatchInputError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = "ContentCreationBatchInputError";
      this.code = code;
    }
  }
  return {
    CONTENT_CREATION_BATCH_MAX_SELECTION: 50,
    CONTENT_CREATION_BATCH_BUDGET_MS: 25_000,
    ContentCreationBatchInputError,
    applyContentCreationBatch: vi.fn(),
    dryRunContentCreationBatch: vi.fn(),
  };
});

const flags = vi.hoisted(() => ({
  state: { featureEnabled: true, writeAllowed: true },
}));

const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (key: string) => (key.toLowerCase() === "origin" ? harness.origin : null),
  })),
}));
vi.mock("next/cache", () => cache);
vi.mock("@/server/auth/guards", () => guards);
vi.mock("@/server/content-creation", () => service);
vi.mock("@/server/content-creation/batch", () => batchService);
vi.mock("@/lib/tasks/moboreader", () => moboreader);
vi.mock("@/lib/flags", () => ({
  isNovelCatalogSyncEnabled: () => flags.state.featureEnabled,
  isNovelCatalogSyncWriteAllowed: () => flags.state.writeAllowed,
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

const { AdminAccessError } = await import("@/lib/auth/errors");
const {
  dryRunContentCreationAction,
  applyContentCreationAction,
  dryRunCatalogScanTaskAction,
  applyCatalogScanTaskAction,
  dryRunContentCreationBatchAction,
  applyContentCreationBatchAction,
} = await import("@/app/(admin)/catalog-sync/_actions");

const IDENTITY = { id: "admin-1", username: "ops", role: "super_admin", status: "active", sessionVersion: 1, twoFactorEnabled: true };
const CONTEXT = { identity: IDENTITY, session: { id: "sess-1" }, twoFactorCompleted: true };

function granted(overrides: Partial<{ serviceAuthorization: unknown }> = {}) {
  return { context: CONTEXT, serviceAuthorization: overrides.serviceAuthorization ?? { ticket: true } };
}

beforeEach(() => {
  guards.requireAdminActionAccess.mockReset();
  guards.requireFreshAdminServiceMutation.mockReset();
  service.createContentFromSourceItem.mockReset();
  batchService.applyContentCreationBatch.mockReset();
  batchService.dryRunContentCreationBatch.mockReset();
  moboreader.createMoboreaderCatalogScanTask.mockReset();
  cache.revalidatePath.mockReset();
  harness.origin = "https://admin.example.com";
  harness.sessionToken = "session-token-abc";
  flags.state = { featureEnabled: true, writeAllowed: true };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dryRunContentCreationAction · 鉴权与参数", () => {
  it("以 admin.content_creation.dry_run 请求授权，并带上 session/origin/requestId", async () => {
    guards.requireAdminActionAccess.mockResolvedValue({ context: CONTEXT });
    service.createContentFromSourceItem.mockResolvedValue({ outcome: "dry_run", plan: { locale: "en" } });

    await dryRunContentCreationAction({ novelSourceItemId: "item-1", requestId: "req-1" });

    expect(guards.requireAdminActionAccess).toHaveBeenCalledTimes(1);
    const [input, deps] = guards.requireAdminActionAccess.mock.calls[0];
    expect(input).toMatchObject({
      actionId: "admin.content_creation.dry_run",
      sessionToken: "session-token-abc",
      origin: "https://admin.example.com",
      canonicalOrigin: "https://admin.example.com",
      requestId: "req-1",
    });
    expect(deps).toMatchObject({ identities: "identities-stub", sessions: "sessions-stub" });
  });

  it("固定 mode: dry_run，不再传 locale（L10N P2：locale 由服务端从来源条目派生），actor 取自会话身份，requestId 原样透传", async () => {
    guards.requireAdminActionAccess.mockResolvedValue({ context: CONTEXT });
    service.createContentFromSourceItem.mockResolvedValue({ outcome: "dry_run", plan: {} });

    await dryRunContentCreationAction({ novelSourceItemId: "item-42", requestId: "req-42" });

    expect(service.createContentFromSourceItem).toHaveBeenCalledTimes(1);
    const [db, input] = service.createContentFromSourceItem.mock.calls[0];
    expect(db).toEqual({ __brand: "prisma-stub" });
    expect(input).toEqual({
      novelSourceItemId: "item-42",
      mode: "dry_run",
      actor: { type: "admin", adminId: "admin-1" },
      requestId: "req-42",
    });
    expect(input).not.toHaveProperty("locale");
  });

  it("成功时原样透传 service 的返回值，套一层 { ok: true, data }", async () => {
    guards.requireAdminActionAccess.mockResolvedValue({ context: CONTEXT });
    const payload = { outcome: "already_exists", novelId: "n1" };
    service.createContentFromSourceItem.mockResolvedValue(payload);

    const result = await dryRunContentCreationAction({ novelSourceItemId: "item-1", requestId: "req-1" });
    expect(result).toEqual({ ok: true, data: payload });
  });

  it("守卫拒绝（AdminAccessError）→ { ok:false, kind:'access_denied' }，envelope 保留 code/status/details", async () => {
    guards.requireAdminActionAccess.mockRejectedValue(
      new AdminAccessError("admin_capability_denied", 403, "denied", { capability: "content:view" }),
    );

    const result = await dryRunContentCreationAction({ novelSourceItemId: "item-1", requestId: "req-1" });
    expect(result).toEqual({
      ok: false,
      kind: "access_denied",
      envelope: {
        ok: false,
        status: 403,
        code: "admin_capability_denied",
        details: { capability: "content:view" },
      },
    });
    expect(service.createContentFromSourceItem).not.toHaveBeenCalled();
  });

  it("service 抛 ContentCreationInputError → { ok:false, kind:'invalid_input', code }，不是当成 access_denied", async () => {
    guards.requireAdminActionAccess.mockResolvedValue({ context: CONTEXT });
    service.createContentFromSourceItem.mockRejectedValue(
      new service.ContentCreationInputError("invalid_novel_source_item_id", "bad id"),
    );

    const result = await dryRunContentCreationAction({ novelSourceItemId: "not-a-uuid", requestId: "req-1" });
    expect(result).toEqual({ ok: false, kind: "invalid_input", code: "invalid_novel_source_item_id" });
  });

  it("非 mutation 的 dry-run 不调用 requireFreshAdminServiceMutation——读操作不要求二次新鲜校验", async () => {
    guards.requireAdminActionAccess.mockResolvedValue({ context: CONTEXT });
    service.createContentFromSourceItem.mockResolvedValue({ outcome: "dry_run", plan: {} });

    await dryRunContentCreationAction({ novelSourceItemId: "item-1", requestId: "req-1" });
    expect(guards.requireFreshAdminServiceMutation).not.toHaveBeenCalled();
  });
});

describe("applyContentCreationAction · 鉴权与参数", () => {
  it("以 admin.content_creation.apply 请求授权，拿到 ticket 后调用 requireFreshAdminServiceMutation(content:publish)", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    guards.requireFreshAdminServiceMutation.mockResolvedValue(CONTEXT);
    service.createContentFromSourceItem.mockResolvedValue({ outcome: "created" });

    await applyContentCreationAction({ novelSourceItemId: "item-1", requestId: "req-1" });

    expect(guards.requireAdminActionAccess.mock.calls[0][0]).toMatchObject({
      actionId: "admin.content_creation.apply",
    });
    expect(guards.requireFreshAdminServiceMutation).toHaveBeenCalledWith(
      { ticket: true },
      "content:publish",
      expect.objectContaining({
        identities: "identities-stub",
        sessions: "sessions-stub",
        entryId: "admin.content_creation.apply",
        requestId: "req-1",
      }),
    );
  });

  it("固定 mode: apply，不再传 locale（L10N P2），actor 取自 requireFreshAdminServiceMutation 返回的新鲜身份", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    guards.requireFreshAdminServiceMutation.mockResolvedValue({
      identity: { ...IDENTITY, id: "fresh-admin-2" },
    });
    service.createContentFromSourceItem.mockResolvedValue({ outcome: "created" });

    await applyContentCreationAction({ novelSourceItemId: "item-9", requestId: "req-9" });

    const [, input] = service.createContentFromSourceItem.mock.calls[0];
    expect(input).toEqual({
      novelSourceItemId: "item-9",
      mode: "apply",
      actor: { type: "admin", adminId: "fresh-admin-2" },
      requestId: "req-9",
    });
    expect(input).not.toHaveProperty("locale");
  });

  it("outcome === created 时才 revalidatePath('/catalog-sync') 与 '/novels'；其它 outcome 不触发", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    guards.requireFreshAdminServiceMutation.mockResolvedValue(CONTEXT);
    service.createContentFromSourceItem.mockResolvedValue({ outcome: "created" });

    await applyContentCreationAction({ novelSourceItemId: "item-1", requestId: "req-1" });
    expect(cache.revalidatePath).toHaveBeenCalledWith("/catalog-sync");
    expect(cache.revalidatePath).toHaveBeenCalledWith("/novels");
    expect(cache.revalidatePath).toHaveBeenCalledTimes(2);

    cache.revalidatePath.mockClear();
    service.createContentFromSourceItem.mockResolvedValue({ outcome: "already_exists" });
    await applyContentCreationAction({ novelSourceItemId: "item-1", requestId: "req-2" });
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it("守卫拒绝 → access_denied，且从不触碰 service 或 revalidatePath", async () => {
    guards.requireAdminActionAccess.mockRejectedValue(
      new AdminAccessError("admin_two_factor_required", 403, "2fa"),
    );

    const result = await applyContentCreationAction({ novelSourceItemId: "item-1", requestId: "req-1" });
    expect(result).toMatchObject({ ok: false, kind: "access_denied" });
    expect(result.ok === false && result.kind === "access_denied" && result.envelope.code).toBe(
      "admin_two_factor_required",
    );
    expect(service.createContentFromSourceItem).not.toHaveBeenCalled();
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it("拿到 ticket 后 requireFreshAdminServiceMutation 再次拒绝（例如会话已失效）→ access_denied，且不写入", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    guards.requireFreshAdminServiceMutation.mockRejectedValue(
      new AdminAccessError("jwt_invalid", 401, "stale session"),
    );

    const result = await applyContentCreationAction({ novelSourceItemId: "item-1", requestId: "req-1" });
    expect(result).toMatchObject({ ok: false, kind: "access_denied" });
    expect(service.createContentFromSourceItem).not.toHaveBeenCalled();
  });

  it("registration 未来若丢了 capability（serviceAuthorization 为空）也 fail-closed 成 access_denied", async () => {
    guards.requireAdminActionAccess.mockResolvedValue({ context: CONTEXT, serviceAuthorization: undefined });

    const result = await applyContentCreationAction({ novelSourceItemId: "item-1", requestId: "req-1" });
    expect(result).toMatchObject({ ok: false, kind: "access_denied" });
    expect(guards.requireFreshAdminServiceMutation).not.toHaveBeenCalled();
    expect(service.createContentFromSourceItem).not.toHaveBeenCalled();
  });

  it("service 抛 ContentCreationInputError → invalid_input，不是 access_denied", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    guards.requireFreshAdminServiceMutation.mockResolvedValue(CONTEXT);
    service.createContentFromSourceItem.mockRejectedValue(
      new service.ContentCreationInputError("invalid_request_id", "bad request id"),
    );

    const result = await applyContentCreationAction({ novelSourceItemId: "item-1", requestId: "req-1" });
    expect(result).toEqual({ ok: false, kind: "invalid_input", code: "invalid_request_id" });
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });
});

/**
 * PR-C2 catalog-scan trigger — `dryRunCatalogScanTaskAction` /
 * `applyCatalogScanTaskAction`. Same real-module discipline as the
 * P0-S13 suite above: only `@/server/auth/guards`, `@/lib/tasks/moboreader`
 * and `@/lib/flags` (all Codex territory) are mocked; `AdminAccessError`
 * stays real so the `instanceof` classification in `_actions.ts` is
 * actually exercised, not assumed.
 */
const SCAN_INPUT = {
  channelAccountId: "acct-1",
  channelAppId: "app-1",
  languages: ["en", "ja"],
  requestId: "req-scan-1",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("dryRunCatalogScanTaskAction · 鉴权与参数", () => {
  it("以 admin.catalog_scan.dry_run 请求授权，并带上 session/origin/requestId", async () => {
    guards.requireAdminActionAccess.mockResolvedValue({ context: CONTEXT });
    moboreader.createMoboreaderCatalogScanTask.mockResolvedValue({
      status: "enqueued",
      taskId: "task-1",
      taskStatus: "pending",
    });

    await dryRunCatalogScanTaskAction(SCAN_INPUT);

    expect(guards.requireAdminActionAccess).toHaveBeenCalledTimes(1);
    const [input, deps] = guards.requireAdminActionAccess.mock.calls[0];
    expect(input).toMatchObject({
      actionId: "admin.catalog_scan.dry_run",
      sessionToken: "session-token-abc",
      origin: "https://admin.example.com",
      canonicalOrigin: "https://admin.example.com",
      requestId: "req-scan-1",
    });
    expect(deps).toMatchObject({ identities: "identities-stub", sessions: "sessions-stub" });
  });

  it("固定 mode: dry_run，actor 取自会话身份，requestToken 是服务端现铸的 UUID（不是调用方传入的任何字段）", async () => {
    guards.requireAdminActionAccess.mockResolvedValue({ context: CONTEXT });
    moboreader.createMoboreaderCatalogScanTask.mockResolvedValue({
      status: "enqueued",
      taskId: "task-1",
      taskStatus: "pending",
    });

    await dryRunCatalogScanTaskAction(SCAN_INPUT);

    expect(moboreader.createMoboreaderCatalogScanTask).toHaveBeenCalledTimes(1);
    const [db, input] = moboreader.createMoboreaderCatalogScanTask.mock.calls[0];
    expect(db).toEqual({ __brand: "prisma-stub" });
    expect(input).toMatchObject({
      channelAccountId: "acct-1",
      channelAppId: "app-1",
      pageStart: 1,
      pageEnd: 2000,
      pageSize: 20,
      languages: ["en", "ja"],
      actorId: "admin-1",
      requestId: "req-scan-1",
      mode: "dry_run",
    });
    expect(input.requestToken).toMatch(UUID_RE);
    expect(input.requestToken).not.toBe(input.requestId);
  });

  it("两次提交各自铸出不同的 requestToken——客户端无法重放或提供自己的幂等键", async () => {
    guards.requireAdminActionAccess.mockResolvedValue({ context: CONTEXT });
    moboreader.createMoboreaderCatalogScanTask.mockResolvedValue({
      status: "enqueued",
      taskId: "task-1",
      taskStatus: "pending",
    });

    await dryRunCatalogScanTaskAction(SCAN_INPUT);
    await dryRunCatalogScanTaskAction(SCAN_INPUT);

    const [firstCall, secondCall] = moboreader.createMoboreaderCatalogScanTask.mock.calls;
    expect(firstCall[1].requestToken).not.toBe(secondCall[1].requestToken);
  });

  it("非 mutation 语义下也不调用 requireFreshAdminServiceMutation——那一步只属于 apply", async () => {
    guards.requireAdminActionAccess.mockResolvedValue({ context: CONTEXT });
    moboreader.createMoboreaderCatalogScanTask.mockResolvedValue({
      status: "enqueued",
      taskId: "task-1",
      taskStatus: "pending",
    });

    await dryRunCatalogScanTaskAction(SCAN_INPUT);
    expect(guards.requireFreshAdminServiceMutation).not.toHaveBeenCalled();
  });

  it("守卫拒绝（AdminAccessError）→ access_denied，且从不触碰工厂函数", async () => {
    guards.requireAdminActionAccess.mockRejectedValue(
      new AdminAccessError("admin_capability_denied", 403, "denied", { capability: "content:view" }),
    );

    const result = await dryRunCatalogScanTaskAction(SCAN_INPUT);
    expect(result).toEqual({
      ok: false,
      kind: "access_denied",
      envelope: {
        ok: false,
        status: 403,
        code: "admin_capability_denied",
        details: { capability: "content:view" },
      },
    });
    expect(moboreader.createMoboreaderCatalogScanTask).not.toHaveBeenCalled();
  });

  it("工厂抛 MoboreaderTaskInputError → invalid_input，不是 access_denied", async () => {
    guards.requireAdminActionAccess.mockResolvedValue({ context: CONTEXT });
    moboreader.createMoboreaderCatalogScanTask.mockRejectedValue(
      new moboreader.MoboreaderTaskInputError("page_range_invalid"),
    );

    const result = await dryRunCatalogScanTaskAction(SCAN_INPUT);
    expect(result).toEqual({ ok: false, kind: "invalid_input", code: "page_range_invalid" });
  });
});

describe("dryRunCatalogScanTaskAction · 结果分类（四种 outcome 各自独立）", () => {
  beforeEach(() => {
    guards.requireAdminActionAccess.mockResolvedValue({ context: CONTEXT });
  });

  it("enqueued + taskStatus pending → created", async () => {
    moboreader.createMoboreaderCatalogScanTask.mockResolvedValue({
      status: "enqueued",
      taskId: "task-1",
      taskStatus: "pending",
    });
    const result = await dryRunCatalogScanTaskAction(SCAN_INPUT);
    expect(result).toEqual({ ok: true, data: { outcome: "created", taskId: "task-1", mode: "dry_run" } });
  });

  it("enqueued + taskStatus disabled → created_disabled，flags 字段是调用时刻两个闸的实时读数", async () => {
    moboreader.createMoboreaderCatalogScanTask.mockResolvedValue({
      status: "enqueued",
      taskId: "task-2",
      taskStatus: "disabled",
    });
    flags.state = { featureEnabled: false, writeAllowed: false };

    const result = await dryRunCatalogScanTaskAction(SCAN_INPUT);
    expect(result).toEqual({
      ok: true,
      data: {
        outcome: "created_disabled",
        taskId: "task-2",
        mode: "dry_run",
        flags: { featureEnabled: false, writeAllowed: false },
      },
    });
  });

  it("created_disabled 的 flags 只反映总闸，不因为 dry_run 就假装写闸已开——两个闸各自独立上报", async () => {
    moboreader.createMoboreaderCatalogScanTask.mockResolvedValue({
      status: "enqueued",
      taskId: "task-3",
      taskStatus: "disabled",
    });
    flags.state = { featureEnabled: true, writeAllowed: false };

    const result = await dryRunCatalogScanTaskAction(SCAN_INPUT);
    expect(result).toMatchObject({
      ok: true,
      data: { flags: { featureEnabled: true, writeAllowed: false } },
    });
  });

  it("duplicate → 幂等命中，不带 mode 字段", async () => {
    moboreader.createMoboreaderCatalogScanTask.mockResolvedValue({
      status: "duplicate",
      taskId: "task-existing",
    });
    const result = await dryRunCatalogScanTaskAction(SCAN_INPUT);
    expect(result).toEqual({ ok: true, data: { outcome: "duplicate", taskId: "task-existing" } });
  });

  it("active_conflict → 已有进行中任务，不带 mode 字段", async () => {
    moboreader.createMoboreaderCatalogScanTask.mockResolvedValue({
      status: "active_conflict",
      taskId: "task-active",
    });
    const result = await dryRunCatalogScanTaskAction(SCAN_INPUT);
    expect(result).toEqual({ ok: true, data: { outcome: "active_conflict", taskId: "task-active" } });
  });
});

describe("applyCatalogScanTaskAction · 鉴权与参数", () => {
  it("以 admin.catalog_scan.apply 请求授权，拿到 ticket 后调用 requireFreshAdminServiceMutation(content:publish)", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    guards.requireFreshAdminServiceMutation.mockResolvedValue(CONTEXT);
    moboreader.createMoboreaderCatalogScanTask.mockResolvedValue({
      status: "enqueued",
      taskId: "task-1",
      taskStatus: "pending",
    });

    await applyCatalogScanTaskAction(SCAN_INPUT);

    expect(guards.requireAdminActionAccess.mock.calls[0][0]).toMatchObject({
      actionId: "admin.catalog_scan.apply",
    });
    expect(guards.requireFreshAdminServiceMutation).toHaveBeenCalledWith(
      { ticket: true },
      "content:publish",
      expect.objectContaining({
        identities: "identities-stub",
        sessions: "sessions-stub",
        entryId: "admin.catalog_scan.apply",
        requestId: "req-scan-1",
      }),
    );
  });

  it("固定 mode: apply，actor 取自 requireFreshAdminServiceMutation 返回的新鲜身份（不是拿票前的旧身份）", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    guards.requireFreshAdminServiceMutation.mockResolvedValue({
      identity: { ...IDENTITY, id: "fresh-admin-2" },
    });
    moboreader.createMoboreaderCatalogScanTask.mockResolvedValue({
      status: "enqueued",
      taskId: "task-1",
      taskStatus: "pending",
    });

    await applyCatalogScanTaskAction(SCAN_INPUT);

    const [, input] = moboreader.createMoboreaderCatalogScanTask.mock.calls[0];
    expect(input).toMatchObject({ mode: "apply", actorId: "fresh-admin-2" });
    expect(input.requestToken).toMatch(UUID_RE);
  });

  it("即便 apply 请求成功入队，写闸仍关闭时工厂本身会把任务写成 disabled——这不是这个 action 的错误分支，是 created_disabled", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    guards.requireFreshAdminServiceMutation.mockResolvedValue(CONTEXT);
    moboreader.createMoboreaderCatalogScanTask.mockResolvedValue({
      status: "enqueued",
      taskId: "task-9",
      taskStatus: "disabled",
    });
    flags.state = { featureEnabled: true, writeAllowed: false };

    const result = await applyCatalogScanTaskAction(SCAN_INPUT);
    expect(result).toEqual({
      ok: true,
      data: {
        outcome: "created_disabled",
        taskId: "task-9",
        mode: "apply",
        flags: { featureEnabled: true, writeAllowed: false },
      },
    });
  });

  it("守卫拒绝 → access_denied，且从不触碰工厂函数或 requireFreshAdminServiceMutation", async () => {
    guards.requireAdminActionAccess.mockRejectedValue(
      new AdminAccessError("admin_two_factor_required", 403, "2fa"),
    );

    const result = await applyCatalogScanTaskAction(SCAN_INPUT);
    expect(result).toMatchObject({ ok: false, kind: "access_denied" });
    expect(result.ok === false && result.kind === "access_denied" && result.envelope.code).toBe(
      "admin_two_factor_required",
    );
    expect(guards.requireFreshAdminServiceMutation).not.toHaveBeenCalled();
    expect(moboreader.createMoboreaderCatalogScanTask).not.toHaveBeenCalled();
  });

  it("拿到 ticket 后 requireFreshAdminServiceMutation 再次拒绝（例如会话已失效）→ access_denied，且不写入", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    guards.requireFreshAdminServiceMutation.mockRejectedValue(
      new AdminAccessError("jwt_invalid", 401, "stale session"),
    );

    const result = await applyCatalogScanTaskAction(SCAN_INPUT);
    expect(result).toMatchObject({ ok: false, kind: "access_denied" });
    expect(moboreader.createMoboreaderCatalogScanTask).not.toHaveBeenCalled();
  });

  it("registration 未来若丢了 capability（serviceAuthorization 为空）也 fail-closed 成 access_denied", async () => {
    guards.requireAdminActionAccess.mockResolvedValue({ context: CONTEXT, serviceAuthorization: undefined });

    const result = await applyCatalogScanTaskAction(SCAN_INPUT);
    expect(result).toMatchObject({ ok: false, kind: "access_denied" });
    expect(guards.requireFreshAdminServiceMutation).not.toHaveBeenCalled();
    expect(moboreader.createMoboreaderCatalogScanTask).not.toHaveBeenCalled();
  });

  it("工厂抛 MoboreaderTaskInputError → invalid_input，不是 access_denied", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    guards.requireFreshAdminServiceMutation.mockResolvedValue(CONTEXT);
    moboreader.createMoboreaderCatalogScanTask.mockRejectedValue(
      new moboreader.MoboreaderTaskInputError("active_channel_binding_required"),
    );

    const result = await applyCatalogScanTaskAction(SCAN_INPUT);
    expect(result).toEqual({ ok: false, kind: "invalid_input", code: "active_channel_binding_required" });
  });

  it("duplicate / active_conflict 在 apply 下同样不带 mode 字段", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    guards.requireFreshAdminServiceMutation.mockResolvedValue(CONTEXT);

    moboreader.createMoboreaderCatalogScanTask.mockResolvedValue({
      status: "duplicate",
      taskId: "task-existing",
    });
    expect(await applyCatalogScanTaskAction(SCAN_INPUT)).toEqual({
      ok: true,
      data: { outcome: "duplicate", taskId: "task-existing" },
    });

    moboreader.createMoboreaderCatalogScanTask.mockResolvedValue({
      status: "active_conflict",
      taskId: "task-active",
    });
    expect(await applyCatalogScanTaskAction(SCAN_INPUT)).toEqual({
      ok: true,
      data: { outcome: "active_conflict", taskId: "task-active" },
    });
  });
});

/**
 * RC-4 批量创建内容的两个 Server Action。
 *
 * 与上方 `applyContentCreationAction` 同款的动作层鉴权用例，逐条对齐：单条
 * apply 已经有"要哪个能力位 / ticket 丢了要 fail-closed / dry_run 不做二次新鲜
 * 校验"这三条守卫测试，批量 apply 是同一条写路径的多条版本，缺了同样的三条就
 * 意味着 `requireFreshAdminServiceMutation(..., "content:publish", ...)` 里的
 * 能力位可以被改成 `content:view` 而整套测试全绿——registry 那张表只锁住了
 * `resolveAdminAction` 的登记值，锁不住动作体内实际传给守卫的那个字符串。
 */
const BATCH_IDS = ["item-a", "item-b"] as const;
const BATCH_APPLY_DATA = {
  items: [
    { novelSourceItemId: "item-a", status: "created" },
    { novelSourceItemId: "item-b", status: "skipped_already_linked" },
  ],
  counts: { created: 1, skipped_already_linked: 1, failed: 0, not_processed: 0 },
};
const BATCH_DRY_RUN_DATA = {
  items: [
    { novelSourceItemId: "item-a", status: "creatable" },
    { novelSourceItemId: "item-b", status: "skipped_already_linked" },
  ],
  counts: { creatable: 1, skipped_already_linked: 1, failed: 0, not_processed: 0 },
};

describe("dryRunContentCreationBatchAction · 鉴权与参数", () => {
  it("以 admin.content_creation.batch_dry_run 请求授权，并带上 session/origin/requestId", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    batchService.dryRunContentCreationBatch.mockResolvedValue(BATCH_DRY_RUN_DATA);

    await dryRunContentCreationBatchAction({ novelSourceItemIds: [...BATCH_IDS], requestId: "req-b1" });

    expect(guards.requireAdminActionAccess.mock.calls[0][0]).toMatchObject({
      actionId: "admin.content_creation.batch_dry_run",
      sessionToken: "session-token-abc",
      origin: "https://admin.example.com",
      requestId: "req-b1",
    });
  });

  it("非 mutation 的批量 dry-run 不调用 requireFreshAdminServiceMutation——与单条 dry-run 同规矩", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    batchService.dryRunContentCreationBatch.mockResolvedValue(BATCH_DRY_RUN_DATA);

    await dryRunContentCreationBatchAction({ novelSourceItemIds: [...BATCH_IDS], requestId: "req-b1" });

    expect(guards.requireFreshAdminServiceMutation).not.toHaveBeenCalled();
  });

  it("不再传 locale（L10N P2）、固定服务端预算，actor 取自会话身份，id 去重后原样透传", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    batchService.dryRunContentCreationBatch.mockResolvedValue(BATCH_DRY_RUN_DATA);

    await dryRunContentCreationBatchAction({
      novelSourceItemIds: ["item-a", "item-b", "item-a"],
      requestId: "req-b2",
    });

    const [, input] = batchService.dryRunContentCreationBatch.mock.calls[0];
    expect(input).toEqual({
      novelSourceItemIds: ["item-a", "item-b"],
      actor: { type: "admin", adminId: "admin-1" },
      requestId: "req-b2",
      budgetMs: 25_000,
    });
    expect(input).not.toHaveProperty("locale");
  });

  it("空选择在到达服务层之前就被拒绝成 invalid_input", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());

    const result = await dryRunContentCreationBatchAction({ novelSourceItemIds: [], requestId: "req-b3" });

    expect(result).toEqual({ ok: false, kind: "invalid_input", code: "items_required" });
    expect(batchService.dryRunContentCreationBatch).not.toHaveBeenCalled();
  });

  it("超过单次上限也在服务层之前被拒绝成 batch_size_exceeded", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    const tooMany = Array.from({ length: 51 }, (_, index) => `item-${index}`);

    const result = await dryRunContentCreationBatchAction({ novelSourceItemIds: tooMany, requestId: "req-b4" });

    expect(result).toEqual({ ok: false, kind: "invalid_input", code: "batch_size_exceeded" });
    expect(batchService.dryRunContentCreationBatch).not.toHaveBeenCalled();
  });

  it("守卫拒绝 → access_denied，且从不触碰服务层", async () => {
    guards.requireAdminActionAccess.mockRejectedValue(
      new AdminAccessError("admin_capability_denied", 403, "denied", { capability: "content:view" }),
    );

    const result = await dryRunContentCreationBatchAction({ novelSourceItemIds: [...BATCH_IDS], requestId: "req-b5" });

    expect(result).toMatchObject({ ok: false, kind: "access_denied" });
    expect(result.ok === false && result.kind === "access_denied" && result.envelope.code).toBe(
      "admin_capability_denied",
    );
    expect(batchService.dryRunContentCreationBatch).not.toHaveBeenCalled();
  });

  it("服务层抛 ContentCreationBatchInputError（后备校验）→ invalid_input，不是 access_denied", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    batchService.dryRunContentCreationBatch.mockRejectedValue(
      new batchService.ContentCreationBatchInputError("batch_size_exceeded", "too many"),
    );

    const result = await dryRunContentCreationBatchAction({ novelSourceItemIds: [...BATCH_IDS], requestId: "req-b6" });

    expect(result).toEqual({ ok: false, kind: "invalid_input", code: "batch_size_exceeded" });
  });
});

describe("applyContentCreationBatchAction · 鉴权与参数", () => {
  it("以 admin.content_creation.batch_apply 请求授权，拿到 ticket 后调用 requireFreshAdminServiceMutation(content:publish)", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    guards.requireFreshAdminServiceMutation.mockResolvedValue(CONTEXT);
    batchService.applyContentCreationBatch.mockResolvedValue(BATCH_APPLY_DATA);

    await applyContentCreationBatchAction({ novelSourceItemIds: [...BATCH_IDS], requestId: "req-c1" });

    expect(guards.requireAdminActionAccess.mock.calls[0][0]).toMatchObject({
      actionId: "admin.content_creation.batch_apply",
    });
    expect(guards.requireFreshAdminServiceMutation).toHaveBeenCalledWith(
      { ticket: true },
      "content:publish",
      expect.objectContaining({
        identities: "identities-stub",
        sessions: "sessions-stub",
        entryId: "admin.content_creation.batch_apply",
        requestId: "req-c1",
      }),
    );
  });

  it("不再传 locale（L10N P2）、固定服务端预算，actor 取自 requireFreshAdminServiceMutation 返回的新鲜身份", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    guards.requireFreshAdminServiceMutation.mockResolvedValue({
      identity: { ...IDENTITY, id: "fresh-admin-7" },
    });
    batchService.applyContentCreationBatch.mockResolvedValue(BATCH_APPLY_DATA);

    await applyContentCreationBatchAction({
      novelSourceItemIds: ["item-a", "item-b", "item-b"],
      requestId: "req-c2",
    });

    const [, input] = batchService.applyContentCreationBatch.mock.calls[0];
    expect(input).toEqual({
      novelSourceItemIds: ["item-a", "item-b"],
      actor: { type: "admin", adminId: "fresh-admin-7" },
      requestId: "req-c2",
      budgetMs: 25_000,
    });
    expect(input).not.toHaveProperty("locale");
  });

  it("counts.created > 0 时才 revalidatePath('/catalog-sync') 与 '/novels'；零创建不触发", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    guards.requireFreshAdminServiceMutation.mockResolvedValue(CONTEXT);
    batchService.applyContentCreationBatch.mockResolvedValue(BATCH_APPLY_DATA);

    await applyContentCreationBatchAction({ novelSourceItemIds: [...BATCH_IDS], requestId: "req-c3" });
    expect(cache.revalidatePath).toHaveBeenCalledWith("/catalog-sync");
    expect(cache.revalidatePath).toHaveBeenCalledWith("/novels");
    expect(cache.revalidatePath).toHaveBeenCalledTimes(2);

    cache.revalidatePath.mockClear();
    batchService.applyContentCreationBatch.mockResolvedValue({
      items: [{ novelSourceItemId: "item-a", status: "not_processed" }],
      counts: { created: 0, skipped_already_linked: 0, failed: 0, not_processed: 1 },
    });
    await applyContentCreationBatchAction({ novelSourceItemIds: [...BATCH_IDS], requestId: "req-c4" });
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it("registration 未来若丢了 capability（serviceAuthorization 为空）也 fail-closed 成 access_denied", async () => {
    guards.requireAdminActionAccess.mockResolvedValue({ context: CONTEXT, serviceAuthorization: undefined });

    const result = await applyContentCreationBatchAction({ novelSourceItemIds: [...BATCH_IDS], requestId: "req-c5" });

    expect(result).toMatchObject({ ok: false, kind: "access_denied" });
    expect(guards.requireFreshAdminServiceMutation).not.toHaveBeenCalled();
    expect(batchService.applyContentCreationBatch).not.toHaveBeenCalled();
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it("拿到 ticket 后 requireFreshAdminServiceMutation 再次拒绝（会话已失效）→ access_denied，且不写入", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    guards.requireFreshAdminServiceMutation.mockRejectedValue(
      new AdminAccessError("jwt_invalid", 401, "stale session"),
    );

    const result = await applyContentCreationBatchAction({ novelSourceItemIds: [...BATCH_IDS], requestId: "req-c6" });

    expect(result).toMatchObject({ ok: false, kind: "access_denied" });
    expect(batchService.applyContentCreationBatch).not.toHaveBeenCalled();
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it("能力位校验先于选择校验：空选择也要先过 content:publish，绝不因为参数不合法就跳过鉴权", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    guards.requireFreshAdminServiceMutation.mockResolvedValue(CONTEXT);

    const result = await applyContentCreationBatchAction({ novelSourceItemIds: [], requestId: "req-c7" });

    expect(result).toEqual({ ok: false, kind: "invalid_input", code: "items_required" });
    expect(guards.requireFreshAdminServiceMutation).toHaveBeenCalledWith(
      { ticket: true },
      "content:publish",
      expect.objectContaining({ entryId: "admin.content_creation.batch_apply" }),
    );
    expect(batchService.applyContentCreationBatch).not.toHaveBeenCalled();
  });

  it("服务层抛 ContentCreationBatchInputError（后备校验）→ invalid_input，且不 revalidate", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    guards.requireFreshAdminServiceMutation.mockResolvedValue(CONTEXT);
    batchService.applyContentCreationBatch.mockRejectedValue(
      new batchService.ContentCreationBatchInputError("items_required", "empty"),
    );

    const result = await applyContentCreationBatchAction({ novelSourceItemIds: [...BATCH_IDS], requestId: "req-c8" });

    expect(result).toEqual({ ok: false, kind: "invalid_input", code: "items_required" });
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });
});
