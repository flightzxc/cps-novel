import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ADMIN_CONTENT_ROUTES,
  CONTENT_ROUTE_CAPABILITIES,
  P2_04_ADMIN_REGISTRY,
} from "@/app/api/admin/_lib/registry";
import {
  CONTENT_READ_CAPABILITIES,
  CONTENT_READ_CAPABILITY_CONFIG,
  hasContentReadCapability,
  requireContentReadCapability,
} from "@/app/api/admin/_lib/content-capabilities";
import { ADMIN_REGISTRY } from "@/app/api/admin/_lib/deps";
import type { AdminAuthContext } from "@/lib/auth/types";
import { resolveAdminRoute } from "@/server/auth/registry";
import { P1_08B_ADMIN_REGISTRY } from "@/server/credentials";

const CONTENT_ROUTE_DIR = path.resolve(process.cwd(), "src/app/api/admin/novels");

const EXPECTED_CONTENT_ROUTES = [
  "/api/admin/novels",
  "/api/admin/novels/chapters",
  "/api/admin/novels/chapters/content",
  "/api/admin/novels/detail",
] as const;

type RouteFile = { readonly route: string; readonly file: string; readonly source: string };

async function contentRouteFiles(directory = CONTENT_ROUTE_DIR): Promise<RouteFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return contentRouteFiles(target);
      if (entry.name !== "route.ts") return [];
      const relative = path.relative(path.resolve(process.cwd(), "src/app"), target);
      return [
        {
          route: `/${relative.replace(/\/route\.ts$/, "").split(path.sep).join("/")}`,
          file: path.relative(process.cwd(), target),
          source: await readFile(target, "utf8"),
        },
      ];
    }),
  );
  return nested.flat();
}

const FILES = await contentRouteFiles();

/**
 * P2-04 路由登记与 orphan 检查。
 *
 * `tests/backend/auth/admin-registry-parity.test.ts` 守的是 P1-08B 凭证面，
 * 这个文件守的是内容读取面，且多守一层：登记表里那条 route→能力位的绑定，必须
 * 在 route 源码里真的被调用。只对着 registry 断言的话，一个忘记调
 * `guardContentRead` 的新 route 依然会"登记齐全"地通过。
 */
describe("P2-04 内容路由登记", () => {
  it("磁盘上的每个内容 GET route 都已登记", () => {
    const actual = FILES.map((entry) => entry.route).sort();
    expect(actual).toEqual([...EXPECTED_CONTENT_ROUTES].sort());
    const registered = ADMIN_CONTENT_ROUTES.map((route) => route.path).sort();
    expect(registered).toEqual(actual);
  });

  it("orphan routes = 0：登记表里没有磁盘上不存在的路径", () => {
    const onDisk = new Set(FILES.map((entry) => entry.route));
    const orphans = ADMIN_CONTENT_ROUTES.filter((route) => !onDisk.has(route.path));
    expect(orphans).toEqual([]);
  });

  it("运行时使用的 registry 是 P1-08B 与 P2-04 的并集", () => {
    expect(ADMIN_REGISTRY).toBe(P2_04_ADMIN_REGISTRY);
    const paths = P2_04_ADMIN_REGISTRY.routes.map((route) => route.path);
    for (const route of P1_08B_ADMIN_REGISTRY.routes) expect(paths).toContain(route.path);
    for (const route of ADMIN_CONTENT_ROUTES) expect(paths).toContain(route.path);
    expect(paths.length).toBe(P1_08B_ADMIN_REGISTRY.routes.length + ADMIN_CONTENT_ROUTES.length);
  });

  it("内容路由只登记 GET，未登记的写方法一律默认拒绝", () => {
    for (const route of ADMIN_CONTENT_ROUTES) {
      expect(route.methods).toEqual(["GET"]);
      expect(resolveAdminRoute(route.path, "GET", P2_04_ADMIN_REGISTRY)).not.toBeNull();
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        expect(resolveAdminRoute(route.path, method, P2_04_ADMIN_REGISTRY)).toBeNull();
      }
    }
  });

  it("route 文件本身只导出 GET", () => {
    for (const entry of FILES) {
      expect(entry.source, `${entry.file} 导出了写方法`).not.toMatch(
        /export async function (POST|PUT|PATCH|DELETE)\b/,
      );
      expect(entry.source).toMatch(/export async function GET\b/);
    }
  });

  it("P2-04 没有新增任何 mutation Action", () => {
    expect(P2_04_ADMIN_REGISTRY.actions).toEqual(P1_08B_ADMIN_REGISTRY.actions);
    for (const action of P2_04_ADMIN_REGISTRY.actions) {
      expect(action.capability).toBe("credential:manage");
    }
  });
});

describe("P2-04 路由与能力位绑定", () => {
  it("每条内容路由都绑定了一个读能力位", () => {
    for (const route of ADMIN_CONTENT_ROUTES) {
      expect(CONTENT_READ_CAPABILITIES).toContain(CONTENT_ROUTE_CAPABILITIES[route.id]);
    }
    expect(Object.keys(CONTENT_ROUTE_CAPABILITIES).sort()).toEqual(
      ADMIN_CONTENT_ROUTES.map((route) => route.id).sort(),
    );
  });

  it("route 源码真的调用了登记表绑定的那个能力位", () => {
    for (const route of ADMIN_CONTENT_ROUTES) {
      const entry = FILES.find((candidate) => candidate.route === route.path);
      expect(entry, `找不到 ${route.path} 的 route 文件`).toBeTruthy();
      const capability = CONTENT_ROUTE_CAPABILITIES[route.id];
      expect(
        entry?.source,
        `${route.path} 未按登记调用 guardContentRead(request, "${capability}")`,
      ).toContain(`guardContentRead(request, "${capability}")`);
    }
  });

  it("只有章节正文路由要 content:read，元数据路由一律 content:view", () => {
    expect(CONTENT_ROUTE_CAPABILITIES["admin.api.novel_chapter.content"]).toBe("content:read");
    expect(CONTENT_ROUTE_CAPABILITIES["admin.api.novel.list"]).toBe("content:view");
    expect(CONTENT_ROUTE_CAPABILITIES["admin.api.novel.detail"]).toBe("content:view");
    expect(CONTENT_ROUTE_CAPABILITIES["admin.api.novel_chapter.list"]).toBe("content:view");
  });

  it("route 不自行查库：查询一律走 src/server/admin-content", () => {
    for (const entry of FILES) {
      expect(entry.source, `${entry.file} 直接用了 prisma 查询`).not.toMatch(
        /prisma\.\w+\.(findMany|findFirst|findUnique|count|\$queryRaw)/,
      );
      expect(entry.source).toContain('from "@/server/admin-content"');
    }
  });
});

/**
 * 显式构造 env，而不是 `{}` 或继承 `process.env`。
 *
 * 前者过不了 `NodeJS.ProcessEnv` 的类型（NODE_ENV 必填），后者会让本机 shell 里
 * 恰好设了 CONTENT_* 的开发者跑出与 CI 不同的结果——默认拒绝这一条尤其怕这个。
 */
function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...overrides };
}

function context(role: string, id = "admin-1"): AdminAuthContext {
  return {
    identity: {
      id,
      username: "operator",
      role,
      status: "active",
      sessionVersion: 1,
      twoFactorEnabled: false,
    },
    // 会话本体与 2FA 状态不参与读能力判定，这里给的是"完全没做过 2FA"的会话。
    session: {
      id: "session-1",
      tokenHash: "hash",
      identityId: id,
      sessionVersion: 1,
      issuedAt: new Date(0),
      lastSeenAt: new Date(0),
      absoluteExpiresAt: new Date(0),
      twoFactorCompletedAt: null,
      revokedAt: null,
    },
    twoFactorCompleted: false,
  };
}

describe("P2-04 读能力位语义", () => {
  it("默认拒绝：没有配置 env 时任何角色都读不到", () => {
    for (const capability of CONTENT_READ_CAPABILITIES) {
      expect(CONTENT_READ_CAPABILITY_CONFIG[capability].defaultRoles).toEqual([]);
      expect(hasContentReadCapability(context("super_admin"), capability, env())).toBe(false);
    }
  });

  it("按角色与按用户 ID 两条授予路径都生效", () => {
    expect(
      hasContentReadCapability(context("editor"), "content:view", env({
        CONTENT_VIEW_ROLES: "editor,ops",
      })),
    ).toBe(true);
    expect(
      hasContentReadCapability(context("nobody", "u-9"), "content:read", env({
        CONTENT_READ_USER_IDS: "u-9",
      })),
    ).toBe(true);
    expect(
      hasContentReadCapability(context("nobody", "u-8"), "content:read", env({
        CONTENT_READ_USER_IDS: "u-9",
      })),
    ).toBe(false);
  });

  /**
   * 本轮最关键的一条：读不要求 2FA。
   *
   * 传入的 context 是 `twoFactorCompleted: false`、`twoFactorCompletedAt: null`
   * 的会话——放在 `requireAdminCapability` + `requireAdminTwoFactor` 那条链上会
   * 直接 403。这里必须放行。
   */
  it("已授予能力位的会话即使从未完成 2FA 也能读", () => {
    expect(() =>
      requireContentReadCapability(context("editor"), "content:view", env({
        CONTENT_VIEW_ROLES: "editor",
      })),
    ).not.toThrow();
    expect(() =>
      requireContentReadCapability(context("editor"), "content:read", env({
        CONTENT_READ_ROLES: "editor",
      })),
    ).not.toThrow();
  });

  it("未授予时抛出点名能力位的 403", () => {
    try {
      requireContentReadCapability(context("editor"), "content:read", env());
      expect.unreachable("应当抛出");
    } catch (error) {
      const denied = error as { code: string; status: number; details: Record<string, string> };
      expect(denied.code).toBe("admin_capability_denied");
      expect(denied.status).toBe(403);
      expect(denied.details.capability).toBe("content:read");
    }
  });

  it("读能力位在配置上就标记为不要求 2FA，且实现里不引用 2FA 检查", async () => {
    for (const capability of CONTENT_READ_CAPABILITIES) {
      expect(CONTENT_READ_CAPABILITY_CONFIG[capability].requiresTwoFactor).toBe(false);
    }
    const source = await readFile(
      path.resolve(process.cwd(), "src/app/api/admin/_lib/content-capabilities.ts"),
      "utf8",
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toContain("requireAdminTwoFactor");
  });

  /**
   * 登记表里刻意不给内容路由填 `capability`：guard 的 `enforceCapability` 一旦
   * 看到该字段就会连带强制 2FA。这条断言把"为什么留空"钉住，避免后人"顺手补上"
   * 而在无人察觉的情况下给所有读加上 2FA 门槛。
   */
  it("内容路由在 registry 里不填 capability，以避开 guard 的 2FA 强制", () => {
    for (const route of P2_04_ADMIN_REGISTRY.routes) {
      const isContentRoute = ADMIN_CONTENT_ROUTES.some(
        (candidate) => candidate.path === route.path,
      );
      if (isContentRoute) expect(route.capability).toBeUndefined();
      else expect(route.capability).toBe("credential:manage");
    }
  });
});
