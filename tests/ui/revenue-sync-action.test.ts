import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `src/app/(admin)/revenue/_actions.ts` · `enqueueRevenueSyncAction`。
 *
 * 照 `tests/ui/catalog-sync-actions.test.ts` 的做法：只替换守卫（`@/server/auth/guards`）、后端入队函数
 * （`@/server/revenue` 的 `enqueueRevenueSync`）与 Next/依赖接线，**动作体本身是真的**。
 * `AdminAccessError` 保持真实——动作按 `instanceof` 把它投影成信封。
 *
 * 要钉死的是授权顺序：能力位 / 会话 / 同源 / 限流 / 请求标识（`requireAdminActionAccess`）→ 写入前
 * 重验（`requireFreshAdminServiceMutation`）→ 才可能触达入队函数。任何一步失败，入队函数一次都不能被调用。
 */

const harness = vi.hoisted(() => ({
  origin: "https://admin.example.com" as string | null,
  sessionToken: "session-token-abc" as string | null,
}));

const guards = vi.hoisted(() => ({
  requireAdminActionAccess: vi.fn(),
  requireFreshAdminServiceMutation: vi.fn(),
}));

const revenue = vi.hoisted(() => ({ enqueueRevenueSync: vi.fn() }));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (key: string) => (key.toLowerCase() === "origin" ? harness.origin : null),
  })),
}));
vi.mock("@/server/auth/guards", () => guards);
vi.mock("@/server/revenue", () => revenue);
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
const { enqueueRevenueSyncAction } = await import("@/app/(admin)/revenue/_actions");
const { P2_04_ADMIN_REGISTRY } = await import("@/app/api/admin/_lib/registry");
const { resolveAdminAction } = await import("@/server/auth/registry");

const ACTION_ID = "admin.revenue.sync.enqueue";
const INPUT = { beginDate: "2026-10-02", endDate: "2026-10-08", requestId: "req-1" };
const TASK_ID = "70000000-0000-4000-8000-0000000000dd";

const AUTHORIZATION = {
  context: { identity: { id: "admin-1" }, session: { id: "sess-1" } },
  capability: "revenue:view",
  requestId: "req-1",
  entryId: ACTION_ID,
};

beforeEach(() => {
  harness.origin = "https://admin.example.com";
  harness.sessionToken = "session-token-abc";
  guards.requireAdminActionAccess.mockReset();
  guards.requireFreshAdminServiceMutation.mockReset();
  revenue.enqueueRevenueSync.mockReset();
  guards.requireAdminActionAccess.mockResolvedValue({
    context: AUTHORIZATION.context,
    serviceAuthorization: AUTHORIZATION,
  });
  guards.requireFreshAdminServiceMutation.mockResolvedValue({ identity: { id: "fresh-admin-9" } });
  revenue.enqueueRevenueSync.mockResolvedValue({ ok: true, taskId: TASK_ID, duplicate: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("登记", () => {
  it("action id 登记在 registry：revenue:view + mutation（同源 / 限流 / 请求标识都生效）", () => {
    expect(resolveAdminAction(ACTION_ID, P2_04_ADMIN_REGISTRY)).toMatchObject({
      id: ACTION_ID,
      capability: "revenue:view",
      mutation: true,
    });
  });
});

describe("授权顺序：未授权调用不会触达入队函数", () => {
  it("第一步（会话 / 能力位 / 同源 / 限流）被拒：返回 access_denied 信封，入队函数与写入前重验都没被调用", async () => {
    guards.requireAdminActionAccess.mockRejectedValue(
      new AdminAccessError("admin_capability_denied", 403, "Missing admin capability: revenue:view", {
        capability: "revenue:view",
      }),
    );

    const result = await enqueueRevenueSyncAction(INPUT);

    expect(result).toMatchObject({
      ok: false,
      kind: "access_denied",
      envelope: { code: "admin_capability_denied", status: 403 },
    });
    expect(guards.requireFreshAdminServiceMutation).not.toHaveBeenCalled();
    expect(revenue.enqueueRevenueSync).not.toHaveBeenCalled();
  });

  it("第一步通过但没有签发服务端授权（登记被改坏时的兜底）：拒绝，不入队", async () => {
    guards.requireAdminActionAccess.mockResolvedValue({ context: AUTHORIZATION.context });

    const result = await enqueueRevenueSyncAction(INPUT);

    expect(result).toMatchObject({
      ok: false,
      kind: "access_denied",
      envelope: { code: "admin_service_authorization_required" },
    });
    expect(guards.requireFreshAdminServiceMutation).not.toHaveBeenCalled();
    expect(revenue.enqueueRevenueSync).not.toHaveBeenCalled();
  });

  it("第二步（写入前重验：会话被吊销 / 2FA 失效 / 授权换绑）被拒：入队函数没被调用", async () => {
    guards.requireFreshAdminServiceMutation.mockRejectedValue(
      new AdminAccessError("admin_two_factor_required", 403, "Completed two-factor authentication is required"),
    );

    const result = await enqueueRevenueSyncAction(INPUT);

    expect(result).toMatchObject({
      ok: false,
      kind: "access_denied",
      envelope: { code: "admin_two_factor_required" },
    });
    expect(revenue.enqueueRevenueSync).not.toHaveBeenCalled();
  });

  it("意外异常（比如入队时数据库故障）：收敛成信封，不外泄异常 message", async () => {
    revenue.enqueueRevenueSync.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2"));

    const result = await enqueueRevenueSyncAction(INPUT);

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
    expect(result).toMatchObject({ kind: "access_denied", envelope: { code: "admin_internal_error" } });
  });
});

describe("授权通过后的入队", () => {
  it("向守卫要的是 revenue:view，绑定到本 action 的 id 与同一个 requestId", async () => {
    await enqueueRevenueSyncAction(INPUT);

    expect(guards.requireAdminActionAccess).toHaveBeenCalledTimes(1);
    expect(guards.requireAdminActionAccess.mock.calls[0]![0]).toMatchObject({
      actionId: ACTION_ID,
      sessionToken: "session-token-abc",
      origin: "https://admin.example.com",
      canonicalOrigin: "https://admin.example.com",
      requestId: "req-1",
    });

    expect(guards.requireFreshAdminServiceMutation).toHaveBeenCalledTimes(1);
    const call = guards.requireFreshAdminServiceMutation.mock.calls[0]!;
    expect(call[0]).toBe(AUTHORIZATION);
    expect(call[1]).toBe("revenue:view");
    expect(call[2]).toMatchObject({
      entryId: ACTION_ID,
      requestId: "req-1",
      identities: "identities-stub",
      sessions: "sessions-stub",
    });
  });

  it("入队参数：区间原样、操作人取重验后的身份、requestToken 由服务端生成（不是客户端的 requestId）", async () => {
    await enqueueRevenueSyncAction(INPUT);

    expect(revenue.enqueueRevenueSync).toHaveBeenCalledTimes(1);
    const [db, input] = revenue.enqueueRevenueSync.mock.calls[0]!;
    expect(db).toEqual({ __brand: "prisma-stub" });
    expect(input).toMatchObject({ beginDate: "2026-10-02", endDate: "2026-10-08", actor: "fresh-admin-9" });
    expect(input.requestToken).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(input.requestToken).not.toBe("req-1");
  });

  it("每次调用都生成新的 requestToken", async () => {
    await enqueueRevenueSyncAction(INPUT);
    await enqueueRevenueSyncAction(INPUT);
    const tokens = revenue.enqueueRevenueSync.mock.calls.map((call) => call[1].requestToken);
    expect(new Set(tokens).size).toBe(2);
  });

  it("成功：返回 taskId 与 duplicate", async () => {
    await expect(enqueueRevenueSyncAction(INPUT)).resolves.toEqual({
      ok: true,
      data: { taskId: TASK_ID, duplicate: false },
    });
    revenue.enqueueRevenueSync.mockResolvedValue({ ok: true, taskId: TASK_ID, duplicate: true });
    await expect(enqueueRevenueSyncAction(INPUT)).resolves.toEqual({
      ok: true,
      data: { taskId: TASK_ID, duplicate: true },
    });
  });

  it.each([
    "invalid_request",
    "invalid_date_range",
    "channel_account_unavailable",
    "channel_account_ambiguous",
    "request_token_conflict",
  ])("后端拒绝 %s：原样带回 code（页面按 code 出中文）", async (code) => {
    revenue.enqueueRevenueSync.mockResolvedValue({ ok: false, code });
    await expect(enqueueRevenueSyncAction(INPUT)).resolves.toEqual({ ok: false, kind: "enqueue_failed", code });
  });

  it("revenue_sync_already_active：带回既有任务编号", async () => {
    revenue.enqueueRevenueSync.mockResolvedValue({
      ok: false,
      code: "revenue_sync_already_active",
      existingTaskId: TASK_ID,
    });
    await expect(enqueueRevenueSyncAction(INPUT)).resolves.toEqual({
      ok: false,
      kind: "enqueue_failed",
      code: "revenue_sync_already_active",
      existingTaskId: TASK_ID,
    });
  });

  it("requestId 不是字符串（被篡改的调用）：按空 requestId 交给守卫，由守卫拒绝，不入队", async () => {
    guards.requireAdminActionAccess.mockImplementation(async (input: { requestId?: string }) => {
      if (!input.requestId) throw new AdminAccessError("admin_mutation_request_id_invalid", 403, "bad request id");
      return { context: AUTHORIZATION.context, serviceAuthorization: AUTHORIZATION };
    });

    const result = await enqueueRevenueSyncAction({ ...INPUT, requestId: 42 as unknown as string });

    expect(result).toMatchObject({ ok: false, kind: "access_denied", envelope: { code: "admin_mutation_request_id_invalid" } });
    expect(revenue.enqueueRevenueSync).not.toHaveBeenCalled();
  });
});
