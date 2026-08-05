import "./setup-cleanup";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminCapabilityView } from "@/contracts";
import { ADMIN_NAV_ITEMS } from "@/features/admin-ui/nav-items";
import { AdminSidebar } from "@/features/admin-ui/sidebar";

/**
 * 侧栏的**折叠 / 展开 / active 三态**（P1-09 验收 ①）。
 *
 * `admin-nav-parity.test.tsx` 在纯函数层验过 `isNavGroupExpanded`，
 * `admin-sidebar.test.tsx` 验过 active 高亮与能力位受限文案——两者都把 pathname
 * 钉死在 `/channel-accounts`，且都没碰 `collapsed` 这个 useState。于是"折叠"
 * 这一态、以及"子菜单只在展开时才进 DOM"从未被验证过。这里补的就是这两处，
 * 顺带把"16 个入口"这个数字从 spec 落到实际渲染结果上。
 */

const pathname = vi.hoisted(() => ({ current: "/dashboard" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.current }));

const CAPABILITIES: readonly AdminCapabilityView[] = [
  { capability: "credential:manage", state: "granted" },
  { capability: "content:takedown", state: "granted" },
  { capability: "promo:claim", state: "granted" },
  { capability: "revenue:view", state: "granted" },
];

function renderSidebar(path: string) {
  pathname.current = path;
  return render(<AdminSidebar capabilities={CAPABILITIES} version="v0.1.0" />);
}

function nav(): HTMLElement {
  return screen.getByRole("navigation", { name: "后台导航" });
}

/** 顶层 `<li>` 里第一层的可见文案，不含展开出来的子项。 */
function topLevelLabels(): string[] {
  return [...nav().querySelectorAll(":scope > ul > li")].map(
    (li) => (li.firstElementChild?.textContent ?? "").replace("受限", "").trim(),
  );
}

async function toggleCollapse(): Promise<void> {
  const button = within(nav()).getByRole("button");
  await act(async () => {
    fireEvent.click(button);
  });
}

beforeEach(() => {
  pathname.current = "/dashboard";
});

describe("侧栏 · 入口数量", () => {
  it("14 个顶层 + 2 个站点设置子项 = 16 个菜单入口", () => {
    const top = ADMIN_NAV_ITEMS.length;
    const children = ADMIN_NAV_ITEMS.reduce((sum, item) => sum + (item.children?.length ?? 0), 0);
    expect(top).toBe(14);
    expect(children).toBe(2);
    expect(top + children).toBe(16);
  });

  it("顶层 14 项全部渲染，顺序与冻结菜单树一致", () => {
    renderSidebar("/dashboard");
    expect(topLevelLabels()).toEqual(ADMIN_NAV_ITEMS.map((item) => item.label));
  });

  it("站在设置子路由上时，16 个入口同时可见", () => {
    renderSidebar("/settings/security");
    const rendered = [...nav().querySelectorAll("li")].filter(
      (li) => li.querySelector("a, span[aria-disabled]"),
    );
    expect(rendered).toHaveLength(16);
    expect(screen.getByText("API 配置")).toBeTruthy();
    expect(screen.getByText("账号安全")).toBeTruthy();
  });
});

describe("侧栏 · 折叠与展开", () => {
  it("默认展开：文字标签与构建版本都在", () => {
    renderSidebar("/dashboard");
    expect(within(nav()).getByRole("button").getAttribute("aria-expanded")).toBe("true");
    expect(within(nav()).getByRole("button").getAttribute("aria-label")).toBe("收起侧栏");
    expect(screen.getByText("书目管理")).toBeTruthy();
    expect(screen.getByTitle("构建版本")).toBeTruthy();
    expect(nav().className).toContain("w-60");
  });

  it("收起后只剩图标：文字与版本号退场，宽度收窄，按钮语义反转", async () => {
    renderSidebar("/dashboard");
    await toggleCollapse();

    const button = within(nav()).getByRole("button");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-label")).toBe("展开侧栏");
    expect(nav().className).toContain("w-16");
    expect(screen.queryByText("书目管理")).toBeNull();
    expect(screen.queryByTitle("构建版本")).toBeNull();
    // 入口本身还在——收起的是标签，不是导航能力。
    expect(within(nav()).getAllByRole("link").length).toBeGreaterThan(0);
  });

  it("再点一次回到展开态，是可逆开关而不是单向折叠", async () => {
    renderSidebar("/dashboard");
    await toggleCollapse();
    await toggleCollapse();

    expect(within(nav()).getByRole("button").getAttribute("aria-expanded")).toBe("true");
    expect(topLevelLabels()).toEqual(ADMIN_NAV_ITEMS.map((item) => item.label));
  });

  it("收起状态下子菜单不渲染——16 个入口挤进 64px 只会糊成一团", async () => {
    renderSidebar("/settings/security");
    expect(screen.getByText("API 配置")).toBeTruthy();

    await toggleCollapse();
    expect(screen.queryByText("API 配置")).toBeNull();
    expect(screen.queryByText("账号安全")).toBeNull();
  });
});

describe("侧栏 · active 与分组展开", () => {
  it("本期未建的入口不是链接，点不动但仍占位——运营看得到功能存在", () => {
    renderSidebar("/dashboard");
    // 本期只有 /channel-accounts 是真页面，/settings 因为有子项而可展开。
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual([
      "站点设置",
      "渠道账户",
    ]);
    const notBuilt = screen.getByText("书目管理").closest("[aria-disabled]");
    expect(notBuilt?.getAttribute("aria-disabled")).toBe("true");
    expect(notBuilt?.getAttribute("title")).toBe("本期未建");
  });

  it("子路由激活时父级分组自动展开，且父级自身也算 active", () => {
    renderSidebar("/settings/api-config");
    expect(screen.getByText("API 配置")).toBeTruthy();
    expect(screen.getByRole("link", { name: "站点设置" }).className).toContain("bg-blue-50");
  });

  it("不在设置分组下时子项根本不进 DOM，不是靠 CSS 藏起来", () => {
    renderSidebar("/tags");
    expect(screen.queryByText("API 配置")).toBeNull();
    expect(screen.queryByText("账号安全")).toBeNull();
    expect(screen.getByText("站点设置")).toBeTruthy();
  });

  it("激活的子项在展开的分组里被高亮，父子两级都能看出位置", () => {
    renderSidebar("/settings/security");
    // 子项外层 span 是承载 active 配色的那一层，内层 span 只负责截断。
    expect(screen.getByText("账号安全").parentElement?.className).toContain("bg-blue-50");
    expect(screen.getByText("API 配置").parentElement?.className).toContain("text-gray-600");
    expect(screen.getByRole("link", { name: "站点设置" }).getAttribute("aria-current")).toBe("page");
  });
});
