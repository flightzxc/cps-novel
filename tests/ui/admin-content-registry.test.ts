import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ADMIN_CONTENT_ROUTES,
  ADMIN_TASK_ROUTES,
  ADMIN_TAGGING_ROUTES,
  CONTENT_ROUTE_CAPABILITIES,
  P2_04_ADMIN_REGISTRY,
} from "@/app/api/admin/_lib/registry";
import { ADMIN_REGISTRY } from "@/app/api/admin/_lib/deps";
import { ADMIN_CAPABILITY_CONFIG } from "@/lib/auth/capabilities";
import { resolveAdminAction, resolveAdminRoute } from "@/server/auth/registry";
import { P1_08B_ADMIN_REGISTRY } from "@/server/credentials";
import { ADMIN_SITE_SETTING_ROUTES } from "@/server/site-settings";

const CONTENT_ROUTE_DIRS = [
  path.resolve(process.cwd(), "src/app/api/admin/novels"),
  path.resolve(process.cwd(), "src/app/api/admin/tags"),
];

const EXPECTED_CONTENT_ROUTES = [
  "/api/admin/novels",
  "/api/admin/novels/chapters",
  "/api/admin/novels/chapters/content",
  "/api/admin/novels/detail",
  "/api/admin/tags",
] as const;

type RouteFile = { readonly route: string; readonly file: string; readonly source: string };

async function contentRouteFilesIn(directory: string): Promise<RouteFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return contentRouteFilesIn(target);
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

async function contentRouteFiles(directories = CONTENT_ROUTE_DIRS): Promise<RouteFile[]> {
  const nested = await Promise.all(directories.map((directory) => contentRouteFilesIn(directory)));
  return nested.flat();
}

const FILES = await contentRouteFiles();

/**
 * P2-04 路由登记与 orphan 检查。
 *
 * `tests/backend/auth/admin-registry-parity.test.ts` 守的是 P1-08B 凭证面，
 * 这个文件守的是内容读取面，且多守一层：route→能力位的绑定必须由运行时 registry
 * 持有（标准 `capability` 字段，内核每次请求都据此判定），而不是由 route 自行传参或
 * 自行判断。只对着路径断言的话，一个忘记接授权的新 route 依然会"登记齐全"地通过。
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

  it("运行时 registry 组合 P1-08B、P2-04、X6 与 X9 路由且无遗漏", () => {
    expect(ADMIN_REGISTRY).toBe(P2_04_ADMIN_REGISTRY);
    const paths = P2_04_ADMIN_REGISTRY.routes.map((route) => route.path);
    for (const route of P1_08B_ADMIN_REGISTRY.routes) expect(paths).toContain(route.path);
    for (const route of ADMIN_CONTENT_ROUTES) expect(paths).toContain(route.path);
    for (const route of ADMIN_SITE_SETTING_ROUTES) expect(paths).toContain(route.path);
    for (const route of ADMIN_TASK_ROUTES) expect(paths).toContain(route.path);
    for (const route of ADMIN_TAGGING_ROUTES) expect(paths).toContain(route.path);
    expect(paths.length).toBe(
      P1_08B_ADMIN_REGISTRY.routes.length
      + ADMIN_CONTENT_ROUTES.length
      + ADMIN_SITE_SETTING_ROUTES.length
      + ADMIN_TASK_ROUTES.length
      + ADMIN_TAGGING_ROUTES.length,
    );
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

  /**
   * P2-04 itself still adds no Action — the assertion below stays scoped to
   * "everything that is not a P0-S13 content-creation action, not a PR-C2
   * catalog-scan action, and not a PR-C3 publish/rights-transition action"
   * so this file keeps guarding that P2-04 fact rather than being weakened
   * by a later round's real additions.
   *
   * P0-S13 (`src/app/(admin)/catalog-sync/_actions.ts`) is the first
   * mutation Action composed on top of P1-08B's six, added via the same
   * "compose on top, never edit the frozen half" pattern
   * {@link ADMIN_CONTENT_ROUTES} already uses for routes. PR-C2 adds two
   * more on top of that (`admin.catalog_scan.dry_run` /
   * `admin.catalog_scan.apply`). PR-C3 adds five more
   * (`src/app/(admin)/novels/_actions.ts`) for the publish/rights-transition
   * triggers — the first Actions this file guards that are not all bound to
   * the same capability: publish and withdraw take `content:publish`,
   * takedown and restore take the stricter `content:takedown`, mirroring
   * `src/server/publish-gate/service.ts`'s own `RIGHTS_TRANSITION_CAPABILITY`
   * table.
   */
  it("P2-04 没有新增任何 mutation Action；P0-S13 / PR-C2 / PR-C3 / RC-1 / RC-4 各自在其上新增了自己的 Action", () => {
    const p204Actions = P2_04_ADMIN_REGISTRY.actions.filter(
      (action) =>
        !action.id.startsWith("admin.content_creation.") &&
        !action.id.startsWith("admin.catalog_scan.") &&
        !action.id.startsWith("admin.article.") &&
        !action.id.startsWith("admin.novel.") &&
        !action.id.startsWith("admin.promo_link_claim."),
    );
    expect(p204Actions).toEqual(P1_08B_ADMIN_REGISTRY.actions);
    for (const action of p204Actions) {
      expect(action.capability).toBe("credential:manage");
    }

    expect(P2_04_ADMIN_REGISTRY.actions.map((action) => action.id)).toEqual([
      ...P1_08B_ADMIN_REGISTRY.actions.map((action) => action.id),
      "admin.content_creation.dry_run",
      "admin.content_creation.apply",
      "admin.catalog_scan.dry_run",
      "admin.catalog_scan.apply",
      "admin.article.publish",
      "admin.article.publish_batch",
      "admin.novel.withdraw",
      "admin.novel.takedown",
      "admin.novel.restore",
      "admin.promo_link_claim.enqueue",
      "admin.content_creation.batch_dry_run",
      "admin.content_creation.batch_apply",
    ]);
    expect(resolveAdminAction("admin.content_creation.dry_run", P2_04_ADMIN_REGISTRY)).toMatchObject({
      capability: "content:view",
      mutation: false,
    });
    expect(resolveAdminAction("admin.content_creation.apply", P2_04_ADMIN_REGISTRY)).toMatchObject({
      capability: "content:publish",
      mutation: true,
    });
    // Unlike P0-S13's dry run, both PR-C2 actions are mutations — the
    // factory writes a `CatalogScanTask` row in every mode, so even
    // `dry_run` here gets same-origin/rate-limit/request-id enforcement.
    expect(resolveAdminAction("admin.catalog_scan.dry_run", P2_04_ADMIN_REGISTRY)).toMatchObject({
      capability: "content:view",
      mutation: true,
    });
    expect(resolveAdminAction("admin.catalog_scan.apply", P2_04_ADMIN_REGISTRY)).toMatchObject({
      capability: "content:publish",
      mutation: true,
    });
    // PR-C3: publish and withdraw stay at content:publish; takedown and
    // restore step up to content:takedown — see this block's own doc
    // comment above for why restore is not content:publish too.
    expect(resolveAdminAction("admin.article.publish", P2_04_ADMIN_REGISTRY)).toMatchObject({
      capability: "content:publish",
      mutation: true,
    });
    expect(resolveAdminAction("admin.article.publish_batch", P2_04_ADMIN_REGISTRY)).toMatchObject({
      capability: "content:publish",
      mutation: true,
    });
    expect(resolveAdminAction("admin.novel.withdraw", P2_04_ADMIN_REGISTRY)).toMatchObject({
      capability: "content:publish",
      mutation: true,
    });
    expect(resolveAdminAction("admin.novel.takedown", P2_04_ADMIN_REGISTRY)).toMatchObject({
      capability: "content:takedown",
      mutation: true,
    });
    expect(resolveAdminAction("admin.novel.restore", P2_04_ADMIN_REGISTRY)).toMatchObject({
      capability: "content:takedown",
      mutation: true,
    });
    // RC-1: one action, not split by mode — dry_run and apply both require
    // `promo:claim`, so unlike the catalog-scan pair there is no capability
    // that varies with a client-controlled `mode` field to keep out of a
    // single action's branching. See `ADMIN_PROMO_LINK_CLAIM_ACTIONS`'s own
    // doc comment for the full reasoning.
    expect(resolveAdminAction("admin.promo_link_claim.enqueue", P2_04_ADMIN_REGISTRY)).toMatchObject({
      capability: "promo:claim",
      mutation: true,
    });
    // RC-4: two actions, split by static id exactly like
    // `admin.content_creation.dry_run`/`apply` above — `batch_dry_run` and
    // `batch_apply` need different capabilities, so the split (not a
    // client-supplied `mode`) is what keeps the enforced capability out of
    // client-controlled input. See `ADMIN_CONTENT_CREATION_BATCH_ACTIONS`'s
    // own doc comment for the full reasoning.
    expect(resolveAdminAction("admin.content_creation.batch_dry_run", P2_04_ADMIN_REGISTRY)).toMatchObject({
      capability: "content:view",
      mutation: false,
    });
    expect(resolveAdminAction("admin.content_creation.batch_apply", P2_04_ADMIN_REGISTRY)).toMatchObject({
      capability: "content:publish",
      mutation: true,
    });
  });
});

describe("P2-04 路由与能力位绑定", () => {
  /**
   * 绑定由**运行时 registry** 持有，且由内核在每次请求上执行。
   *
   * 用的是标准 `capability` 字段——`requireAdminRouteAccess` 解析出路由后直接把它
   * 交给 `enforceCapability`。route 没有参数可传，也就没有传错的可能；能力位与授权
   * 判定都不再有 P2-04 私有实现。
   */
  it("每条内容路由都用标准 capability 字段登记，且是核心 AdminCapability", () => {
    for (const route of ADMIN_CONTENT_ROUTES) {
      expect(ADMIN_CAPABILITY_CONFIG[route.capability]).toBeTruthy();
      const resolved = resolveAdminRoute(route.path, "GET", P2_04_ADMIN_REGISTRY);
      // 运行时解析出来的那条 registration 必须自带能力位，否则 enforceCapability
      // 会当成"无需能力位"直接放行
      expect(resolved?.capability, `${route.path} 运行时未携带能力位`).toBe(route.capability);
    }
  });

  it("内容读取能力位在内核里登记为不要求 2FA，高风险能力位不受影响", () => {
    expect(ADMIN_CAPABILITY_CONFIG["content:view"].requiresTwoFactor).toBe(false);
    expect(ADMIN_CAPABILITY_CONFIG["content:read"].requiresTwoFactor).toBe(false);
    expect(ADMIN_CAPABILITY_CONFIG["credential:manage"].requiresTwoFactor).toBe(true);
    expect(ADMIN_CAPABILITY_CONFIG["content:takedown"].requiresTwoFactor).toBe(true);
  });

  it("默认拒绝：两个读能力位都没有默认角色", () => {
    expect(ADMIN_CAPABILITY_CONFIG["content:view"].defaultRoles).toEqual([]);
    expect(ADMIN_CAPABILITY_CONFIG["content:read"].defaultRoles).toEqual([]);
  });

  /**
   * 本轮收口的核心：P2-04 不得再有第二套授权源。
   *
   * 既扫源码（不许出现私有 guard / 私有能力位配置），也扫依赖（route 必须走与凭证面
   * 同一个 `guardRead`）。
   */
  it("route 走统一 guardRead，没有 P2-04 专用授权实现", () => {
    for (const entry of FILES) {
      expect(entry.source, `${entry.file} 未走统一 guardRead`).toContain("guardRead(request)");
      expect(entry.source, `${entry.file} 仍引用已删除的专用 guard`).not.toContain(
        "guardContentRead",
      );
      expect(entry.source, `${entry.file} 仍引用第二套授权源`).not.toContain(
        "content-capabilities",
      );
      // 能力位由 registration 决定，route 不得自行判定
      expect(entry.source, `${entry.file} 自行做了能力位判断`).not.toMatch(
        /hasAdminCapability|requireAdminCapability|requireAdminTwoFactor/,
      );
    }
  });

  it("派生表与 registration 同源，不存在第二份手写副本", () => {
    expect(Object.keys(CONTENT_ROUTE_CAPABILITIES).sort()).toEqual(
      ADMIN_CONTENT_ROUTES.map((route) => route.id).sort(),
    );
    for (const route of ADMIN_CONTENT_ROUTES) {
      expect(CONTENT_ROUTE_CAPABILITIES[route.id]).toBe(route.capability);
    }
  });

  it("只有章节正文路由要 content:read，元数据路由一律 content:view", () => {
    expect(CONTENT_ROUTE_CAPABILITIES["admin.api.novel_chapter.content"]).toBe("content:read");
    expect(CONTENT_ROUTE_CAPABILITIES["admin.api.novel.list"]).toBe("content:view");
    expect(CONTENT_ROUTE_CAPABILITIES["admin.api.novel.detail"]).toBe("content:view");
    expect(CONTENT_ROUTE_CAPABILITIES["admin.api.novel_chapter.list"]).toBe("content:view");
    expect(CONTENT_ROUTE_CAPABILITIES["admin.api.source_label.list"]).toBe("content:view");
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
 * 授权唯一真源的源码审计（本轮验收第 7 条）。
 *
 * 前两版 P2-04 都在 `src/app` 里自带了一份 roles/userIds/env/default-deny 的解析。
 * 它现在删掉了，而"删掉了"这件事必须是可回归的——否则下一个需要读能力位的页面又会
 * 就地写一份。判据是：这套解析只允许出现在内核 `src/lib/auth/capabilities.ts` 里。
 */
const KERNEL = "src/lib/auth/capabilities.ts";

async function walk(root: string): Promise<{ file: string; source: string }[]> {
  const directory = path.resolve(process.cwd(), root);
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      const relative = path.relative(process.cwd(), target);
      if (entry.isDirectory()) return walk(relative);
      return /\.tsx?$/.test(entry.name)
        ? [{ file: relative, source: await readFile(target, "utf8") }]
        : [];
    }),
  );
  return nested.flat();
}

/**
 * 注释在扫描前剥掉，沿用 `admin-secret-boundary.test.tsx` 的做法。
 *
 * 守的是代码碰了什么，不是注释怎么说的——本轮好几处注释正当地解释着"这里为什么
 * 不再有私有 guard"，把这种说明判成违规，只会逼人把说明删掉。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const SOURCES = (await walk("src")).map((entry) => ({
  ...entry,
  source: stripComments(entry.source),
}));

describe("P2-04 授权唯一真源", () => {
  it("扫描范围非空且包含内核本身", () => {
    expect(SOURCES.length).toBeGreaterThan(0);
    expect(SOURCES.some((entry) => entry.file === KERNEL)).toBe(true);
  });

  it("第二套授权源已删除，文件不存在", () => {
    expect(
      SOURCES.some((entry) => entry.file.endsWith("_lib/content-capabilities.ts")),
    ).toBe(false);
  });

  it.each([
    ["*_ROLES env 解析", /CONTENT_(VIEW|READ)_ROLES/],
    ["*_USER_IDS env 解析", /CONTENT_(VIEW|READ)_USER_IDS/],
    ["私有能力位类型", /ContentReadCapability/],
    ["私有能力位配置表", /CONTENT_READ_CAPABILITY_CONFIG/],
    ["私有 grant 判定", /hasContentReadCapability|requireContentReadCapability/],
    ["P2-04 专用 guard", /guardContentRead/],
  ])("%s 只允许出现在内核里", (_name, pattern) => {
    const offenders = SOURCES.filter(
      (entry) => entry.file !== KERNEL && pattern.test(entry.source),
    ).map((entry) => entry.file);
    expect(offenders).toEqual([]);
  });

  it("UI 侧一律用内核的 hasAdminCapability 判权，不自行读 role/userId/env", () => {
    const ui = SOURCES.filter((entry) => entry.file.startsWith("src/app/(admin)/novels"));
    expect(ui.length).toBeGreaterThan(0);
    for (const { file, source } of ui) {
      expect(source, `${file} 自行读取 identity.role 判权`).not.toMatch(
        /identity\.role\s*===|identity\.role\s*\)/,
      );
      expect(source, `${file} 自行读取 env 判权`).not.toMatch(/process\.env\.[A-Z_]*(ROLE|USER)/);
    }
    const guard = SOURCES.find(
      (entry) => entry.file === "src/app/(admin)/novels/_lib/content-page-guard.ts",
    );
    expect(guard?.source).toContain("hasAdminCapability");
  });
});
