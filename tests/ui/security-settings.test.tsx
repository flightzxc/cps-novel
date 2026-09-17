import "./setup-cleanup";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/(admin)/settings/security/_actions", () => ({
  startSecuritySetupAction: vi.fn(), confirmSecuritySetupAction: vi.fn(), regenerateSecurityRecoveryCodesAction: vi.fn(),
}));
import { SecurityPanel } from "@/app/(admin)/settings/security/_components/security-panel";

describe("security settings · four states and no self-disable", () => {
  it.each([
    ["disabled", "未启用", "开始设置"], ["pending", "待确认", "重新扫码"],
    ["pending_expired", "待确认已过期", "重新扫码"], ["enabled", "已启用", "重新生成恢复码"],
  ] as const)("renders %s", (status, label, action) => {
    const { unmount } = render(<SecurityPanel initialState={{ username: "admin", status, confirmedAt: null, recoveryCodesRemaining: status === "enabled" ? 10 : 0, recoveryCodesRotatedAt: null, pendingExpiresAt: null }} />);
    expect(screen.getByTestId("two-factor-status").textContent).toBe(label);
    expect(screen.getAllByText(action).length).toBeGreaterThan(0);
    expect(screen.queryByText(/禁用双重验证|关闭双重验证/)).toBeNull();
    unmount();
  });
});
