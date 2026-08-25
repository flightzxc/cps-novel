import "./setup-cleanup";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminSessionView } from "@/contracts";

/**
 * PR-C1 · dead-wiring check for `(admin)/_components/admin-shell.tsx`'s
 * logout button.
 *
 * The lesson this whole takeover is built on: a prior PR imported a module
 * and never rendered it. `admin-shell.tsx`'s diff *looks* right — a
 * `<form action={logoutAction}>` around a submit button — but "looks wired"
 * and "is wired" are exactly the two things that diverged last time. This
 * renders the real `<AdminShell>` (used by every `(admin)` page, per
 * `channel-accounts/page.tsx` etc.) and proves clicking "退出登录" actually
 * invokes the real `logoutAction` import, not a dead one.
 *
 * Only `logoutAction` and `AdminSidebar` are replaced — the former because
 * it is a `"use server"` module that reaches into `next/headers` and
 * Prisma-backed stores (already covered on its own in
 * `admin-logout-action.test.ts`), the latter because its own rendering is
 * `admin-sidebar.test.tsx`'s job and it needs nothing from this test.
 */

const logoutAction = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/app/(admin-auth)/_lib/logout-action", () => ({ logoutAction }));

vi.mock("@/features/admin-ui/sidebar", () => ({
  AdminSidebar: () => <nav data-testid="stub-sidebar" />,
}));

const { AdminShell } = await import("@/app/(admin)/_components/admin-shell");

const session: AdminSessionView = {
  identityId: "id-1",
  username: "root",
  role: "super_admin",
  twoFactorCompleted: true,
  idleExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  absoluteExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  capabilities: [],
};

beforeEach(() => {
  logoutAction.mockClear();
});

describe("AdminShell — the logout control is a real, wired form action", () => {
  it("renders the username/role and a submit button bound to the real logoutAction import", async () => {
    render(
      <AdminShell session={session} title="测试页">
        <p>content</p>
      </AdminShell>,
    );

    expect(screen.getByText("root")).toBeTruthy();
    expect(screen.getByText("(super_admin)")).toBeTruthy();

    const button = screen.getByRole("button", { name: "退出登录" });
    expect(button.closest("form")).toBeTruthy();

    fireEvent.click(button);

    await waitFor(() => expect(logoutAction).toHaveBeenCalledTimes(1));
  });
});
