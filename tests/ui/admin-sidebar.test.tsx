import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdminCapabilityView } from "@/contracts";
import { AdminSidebar } from "@/features/admin-ui/sidebar";

vi.mock("next/navigation", () => ({ usePathname: () => "/channel-accounts" }));

function capabilities(
  overrides: Partial<Record<AdminCapabilityView["capability"], AdminCapabilityView["state"]>> = {},
): readonly AdminCapabilityView[] {
  const base = {
    "credential:manage": "granted",
    "content:takedown": "granted",
    "promo:claim": "denied",
    "revenue:view": "denied",
    ...overrides,
  } as const;
  return Object.entries(base).map(([capability, state]) => ({
    capability,
    state,
  })) as readonly AdminCapabilityView[];
}

// vitest runs without `globals: true`, so Testing Library's auto-cleanup never
// registers and rendered trees would accumulate across cases.
afterEach(cleanup);

describe("admin sidebar", () => {
  it("marks the active entry for the current path", () => {
    render(<AdminSidebar capabilities={capabilities()} version="v0.1.0" />);
    const active = screen.getByRole("link", { name: "渠道账户" });
    expect(active.getAttribute("aria-current")).toBe("page");
    expect(active.className).toContain("bg-blue-50");
    expect(active.className).toContain("text-blue-700");
  });

  it("shows the build version low-key rather than a brand name", () => {
    render(<AdminSidebar capabilities={capabilities()} version="v0.1.0-rc1" />);
    const version = screen.getByTitle("构建版本");
    expect(version.textContent).toBe("v0.1.0-rc1");
    expect(version.className).toContain("text-gray-400");
  });

  it("names the missing capability instead of a generic denial", () => {
    // Acceptance ⑥: the operator must learn which capability to request.
    render(<AdminSidebar capabilities={capabilities({ "credential:manage": "denied" })} version="v" />);
    const entry = screen.getByText("渠道账户").closest("[aria-disabled]");
    expect(entry?.getAttribute("title")).toContain("credential:manage");
    expect(entry?.getAttribute("title")).toContain("凭证管理");
    expect(entry?.getAttribute("aria-disabled")).toBe("true");
  });

  it("distinguishes a pending step-up from a missing grant", () => {
    render(
      <AdminSidebar
        capabilities={capabilities({ "credential:manage": "two_factor_required" })}
        version="v"
      />,
    );
    const entry = screen.getByText("渠道账户").closest("[aria-disabled]");
    expect(entry?.getAttribute("title")).toContain("双重验证");
  });

  it("keeps a blocked entry visible so the feature does not look absent", () => {
    render(<AdminSidebar capabilities={capabilities({ "credential:manage": "denied" })} version="v" />);
    expect(screen.getByText("渠道账户")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "渠道账户" })).toBeNull();
  });

  it("renders every menu entry including the not-yet-built ones", () => {
    render(<AdminSidebar capabilities={capabilities()} version="v" />);
    for (const label of ["仪表盘", "书目管理", "试读管理", "任务中心", "站点设置"]) {
      expect(screen.getByText(label), `${label} must be present`).toBeTruthy();
    }
  });
});
