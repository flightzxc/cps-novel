import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ADMIN_NAV_ITEMS,
  OMITTED_CPS_NAV_ITEMS,
  isNavGroupExpanded,
  isNavItemActive,
} from "@/features/admin-ui/nav-items";
import { ADMIN_PAGE_ROOTS } from "@/server/auth/registry";

/** Frozen by docs/p1/P1_ADMIN_PARITY_SPEC.md §1, in CPS sidebar order. */
const SPEC_MENU: readonly (readonly [string, string])[] = [
  ["/dashboard", "仪表盘"],
  ["/novels", "书目管理"],
  ["/catalog-sync", "目录同步"],
  ["/promo-links", "推广链接"],
  ["/previews", "试读管理"],
  ["/home-carousel", "首页轮播"],
  ["/templates", "模板管理"],
  ["/articles", "文章管理"],
  ["/categories", "分类管理"],
  ["/tags", "标签管理"],
  ["/tasks", "任务中心"],
  ["/revenue", "数据看板"],
  ["/settings", "站点设置"],
  ["/channel-accounts", "渠道账户"],
];

const ADMIN_GROUP = path.resolve(process.cwd(), "src/app/(admin)");

async function pageFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return pageFiles(target);
      return entry.isFile() && entry.name === "page.tsx" ? [target] : [];
    }),
  );
  return nested.flat();
}

describe("admin menu parity", () => {
  it("matches the frozen menu tree in order", () => {
    expect(ADMIN_NAV_ITEMS.map((item) => [item.href, item.label])).toEqual(
      SPEC_MENU.map((entry) => [...entry]),
    );
  });

  it("keeps the settings submenu the spec declares", () => {
    const settings = ADMIN_NAV_ITEMS.find((item) => item.href === "/settings");
    expect(settings?.children?.map((child) => [child.href, child.label])).toEqual([
      ["/settings/api-config", "API 配置"],
      ["/settings/security", "账号安全"],
    ]);
  });

  it("records why each dropped CPS entry is not built", () => {
    // Acceptance ① asks for the "why not", not just the omission.
    expect(OMITTED_CPS_NAV_ITEMS.map((entry) => entry.cps)).toEqual([
      "批量导入",
      "分类规则",
      "畅读链接",
    ]);
    for (const entry of OMITTED_CPS_NAV_ITEMS) {
      expect(entry.reason.trim().length).toBeGreaterThan(0);
    }
  });

  it("only links to paths the route registry protects", () => {
    for (const item of ADMIN_NAV_ITEMS) {
      const root = `/${item.href.split("/")[1]}`;
      expect(ADMIN_PAGE_ROOTS, `${item.href} must be a protected page root`).toContain(root);
    }
  });

  it("expands a group when a child is active", () => {
    const settings = ADMIN_NAV_ITEMS.find((item) => item.href === "/settings")!;
    expect(isNavGroupExpanded("/settings/security", settings)).toBe(true);
    expect(isNavGroupExpanded("/tags", settings)).toBe(false);
    expect(isNavItemActive("/channel-accounts/anything", { ...settings, href: "/channel-accounts" }))
      .toBe(true);
    // A prefix that is not a path segment must not count as active.
    expect(isNavItemActive("/tagsomething", { ...settings, href: "/tags" })).toBe(false);
  });
});

describe("admin page default-deny registration", () => {
  it("makes every admin page declare its own registered path", async () => {
    const files = await pageFiles(ADMIN_GROUP);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const call = source.match(/requireAdminPage\(\s*"([^"]+)"/);
      expect(call, `${path.relative(process.cwd(), file)} must call requireAdminPage`).toBeTruthy();

      const declared = call![1];
      const root = `/${declared.split("/")[1]}`;
      expect(ADMIN_PAGE_ROOTS, `${declared} is not a registered page root`).toContain(root);

      // The declared path must match where the file actually lives, otherwise a
      // page could guard a different route than the one it serves.
      const routeSegments = path
        .relative(ADMIN_GROUP, path.dirname(file))
        .split(path.sep)
        .filter((segment) => segment && !segment.startsWith("(") && !segment.startsWith("_"));
      expect(`/${routeSegments.join("/")}`).toBe(declared);
    }
  });
});
