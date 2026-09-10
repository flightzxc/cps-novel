import { describe, expect, it } from "vitest";

import { ADMIN_CAPABILITY_CONFIG } from "@/lib/auth/capabilities";
import { ADMIN_CAPABILITY_LABELS, findCapabilityState } from "@/features/admin-ui/capability-view";
import { capabilityViews } from "@/app/(admin)/_lib/page-guard";
import type { AdminAuthContext } from "@/lib/auth/types";

/**
 * C-30A (施工工单_C30_换小说_移植CPS换租客_2026-09-08.md §4A.3): "能力面板会
 * 自动带出这两项（能力视图遍历配置表全集），无需额外接线，但要有一条测试确认
 * 导航与灰置不回归". `capabilityViews` derives its full set from
 * `Object.keys(ADMIN_CAPABILITY_CONFIG)` (`src/app/(admin)/_lib/page-guard.ts`'s
 * `ALL_CAPABILITIES`) — this test pins that the two new capabilities show up
 * there automatically, are labeled, default-deny for a non-super_admin role,
 * and — critically — that adding them did not change any *existing*
 * capability's projected state (the actual non-regression risk: a copy-paste
 * mistake landing a stray default role or an env-var collision).
 */
function context(role: string): AdminAuthContext {
  const now = new Date("2026-09-08T00:00:00.000Z");
  return {
    identity: { id: "admin-1", username: "admin", role, status: "active", sessionVersion: 1, twoFactorEnabled: true },
    session: {
      id: "session-1",
      tokenHash: "hash",
      identityId: "admin-1",
      sessionVersion: 1,
      issuedAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: new Date(now.getTime() + 86_400_000),
      twoFactorCompletedAt: now,
      revokedAt: null,
    },
    twoFactorCompleted: true,
  };
}

describe("C-30A: content:rebind / content:batch-rebind capability projection", () => {
  it("registered in ADMIN_CAPABILITY_CONFIG with the content:publish tier (super_admin default + requiresTwoFactor)", () => {
    for (const capability of ["content:rebind", "content:batch-rebind"] as const) {
      expect(ADMIN_CAPABILITY_CONFIG[capability].defaultRoles).toEqual(["super_admin"]);
      expect(ADMIN_CAPABILITY_CONFIG[capability].requiresTwoFactor).toBe(true);
    }
  });

  it("每个都有中文标签，不落到裸英文 code", () => {
    expect(ADMIN_CAPABILITY_LABELS["content:rebind"]).toBe("单篇换小说");
    expect(ADMIN_CAPABILITY_LABELS["content:batch-rebind"]).toBe("批量换小说");
  });

  it("能力视图遍历配置表全集：无需额外接线，两项自动出现在 super_admin 的视图里且为 granted", () => {
    const env = { ADMIN_TWO_FACTOR_ENFORCEMENT: "true" } as unknown as NodeJS.ProcessEnv;
    const views = capabilityViews(context("super_admin"), env);
    expect(findCapabilityState(views, "content:rebind")).toBe("granted");
    expect(findCapabilityState(views, "content:batch-rebind")).toBe("granted");
  });

  it("默认拒绝：非 super_admin 角色（无 env 覆盖）拿不到这两项，也拿不到同档的 content:publish", () => {
    const env = {} as unknown as NodeJS.ProcessEnv;
    const views = capabilityViews(context("editor"), env);
    expect(findCapabilityState(views, "content:rebind")).toBe("denied");
    expect(findCapabilityState(views, "content:batch-rebind")).toBe("denied");
    expect(findCapabilityState(views, "content:publish")).toBe("denied");
  });

  it("导航/灰置不回归：新增两项后，既有能力（content:publish/credential:manage/content:view）的投影结果不变", () => {
    const env = {} as unknown as NodeJS.ProcessEnv;
    const views = capabilityViews(context("super_admin"), env);
    // content:publish / credential:manage default to ["super_admin"] -> granted with no env override.
    expect(findCapabilityState(views, "content:publish")).toBe("granted");
    expect(findCapabilityState(views, "credential:manage")).toBe("granted");
    // content:view's own defaultRoles is deliberately [] (fail-closed,
    // requires an explicit CONTENT_VIEW_ROLES/CONTENT_VIEW_USER_IDS grant) —
    // unaffected by this round, still denied with no env override, for
    // every role including super_admin.
    expect(findCapabilityState(views, "content:view")).toBe("denied");
  });
});
