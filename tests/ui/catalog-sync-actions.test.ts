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

const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (key: string) => (key.toLowerCase() === "origin" ? harness.origin : null),
  })),
}));
vi.mock("next/cache", () => cache);
vi.mock("@/server/auth/guards", () => guards);
vi.mock("@/server/content-creation", () => service);
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
const { dryRunContentCreationAction, applyContentCreationAction } = await import(
  "@/app/(admin)/catalog-sync/_actions"
);

const IDENTITY = { id: "admin-1", username: "ops", role: "super_admin", status: "active", sessionVersion: 1, twoFactorEnabled: true };
const CONTEXT = { identity: IDENTITY, session: { id: "sess-1" }, twoFactorCompleted: true };

function granted(overrides: Partial<{ serviceAuthorization: unknown }> = {}) {
  return { context: CONTEXT, serviceAuthorization: overrides.serviceAuthorization ?? { ticket: true } };
}

beforeEach(() => {
  guards.requireAdminActionAccess.mockReset();
  guards.requireFreshAdminServiceMutation.mockReset();
  service.createContentFromSourceItem.mockReset();
  cache.revalidatePath.mockReset();
  harness.origin = "https://admin.example.com";
  harness.sessionToken = "session-token-abc";
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

  it("固定 mode: dry_run 与 locale: en，actor 取自会话身份，requestId 原样透传", async () => {
    guards.requireAdminActionAccess.mockResolvedValue({ context: CONTEXT });
    service.createContentFromSourceItem.mockResolvedValue({ outcome: "dry_run", plan: {} });

    await dryRunContentCreationAction({ novelSourceItemId: "item-42", requestId: "req-42" });

    expect(service.createContentFromSourceItem).toHaveBeenCalledTimes(1);
    const [db, input] = service.createContentFromSourceItem.mock.calls[0];
    expect(db).toEqual({ __brand: "prisma-stub" });
    expect(input).toEqual({
      novelSourceItemId: "item-42",
      locale: "en",
      mode: "dry_run",
      actor: { type: "admin", adminId: "admin-1" },
      requestId: "req-42",
    });
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

  it("固定 mode: apply 与 locale: en，actor 取自 requireFreshAdminServiceMutation 返回的新鲜身份", async () => {
    guards.requireAdminActionAccess.mockResolvedValue(granted());
    guards.requireFreshAdminServiceMutation.mockResolvedValue({
      identity: { ...IDENTITY, id: "fresh-admin-2" },
    });
    service.createContentFromSourceItem.mockResolvedValue({ outcome: "created" });

    await applyContentCreationAction({ novelSourceItemId: "item-9", requestId: "req-9" });

    const [, input] = service.createContentFromSourceItem.mock.calls[0];
    expect(input).toEqual({
      novelSourceItemId: "item-9",
      locale: "en",
      mode: "apply",
      actor: { type: "admin", adminId: "fresh-admin-2" },
      requestId: "req-9",
    });
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
