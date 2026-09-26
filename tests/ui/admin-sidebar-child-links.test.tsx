import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AdminSidebar } from "@/features/admin-ui/sidebar";

vi.mock("next/navigation", () => ({ usePathname: () => "/settings/security" }));
vi.mock("@/features/admin-ui/nav-items", async (original) => {
  const actual = await original<typeof import("@/features/admin-ui/nav-items")>();
  return { ...actual, ADMIN_NAV_ITEMS: [...actual.ADMIN_NAV_ITEMS, {
    href: "/settings/test", label: "测试权限", icon: "settings", children: [
      { href: "/settings/security", label: "受控子项", icon: "shield", capability: "credential:manage" },
    ],
  }] };
});
afterEach(cleanup);
it("links implemented security, leaves placeholder inert, and respects child capability", () => {
  render(<AdminSidebar capabilities={[{ capability: "settings:manage", state: "granted" }, { capability: "credential:manage", state: "denied" }]} version="v" />);
  expect(screen.getByRole("link", { name: "账号安全" }).getAttribute("href")).toBe("/settings/security");
  expect(screen.getByRole("link", { name: "账号安全" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByText("API 配置").closest("[aria-disabled]")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "受控子项" })).toBeNull();
  expect(screen.getByText("受控子项").closest("[aria-disabled]")).toBeTruthy();
});
it("account security remains accessible without settings management, matching its session-only server guard", () => {
  render(<AdminSidebar capabilities={[]} version="v" />);
  expect(screen.getByRole("link", { name: "账号安全" })).toBeTruthy();
});
