import "./setup-cleanup";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PR-C1 · `/two-factor/setup` — page branching (`page.tsx`) and the
 * idle -> started -> done step machine (`_components/setup-flow.tsx`).
 *
 * Same split as the login and challenge page tests: the Server Action module
 * is replaced, `next/navigation` is replaced, `readActiveContext` /
 * `safeNextPath` are mocked (their own logic lives in
 * `admin-auth-session-lib.test.ts`). `<SetupFlow>` and `<AuthCard>` are real.
 */

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT:${url}`);
  }
}

const redirectMock = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new RedirectSignal(url);
  }),
);
const routerPush = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  redirect: redirectMock,
  useRouter: () => ({ push: routerPush }),
}));

const readActiveContext = vi.hoisted(() => vi.fn());
const safeNextPath = vi.hoisted(() => vi.fn((value: string | undefined) => value ?? null));
vi.mock("@/app/(admin-auth)/_lib/auth-session", () => ({
  ADMIN_LANDING_PATH: "/novels",
  LOGIN_PATH: "/login",
  readActiveContext,
  safeNextPath,
}));

const startSetupAction = vi.hoisted(() => vi.fn());
const confirmSetupAction = vi.hoisted(() => vi.fn());
vi.mock("@/app/(admin-auth)/two-factor/setup/_actions", () => ({ startSetupAction, confirmSetupAction }));

const { default: TwoFactorSetupPage } = await import("@/app/(admin-auth)/two-factor/setup/page");
const { SetupFlow } = await import("@/app/(admin-auth)/two-factor/setup/_components/setup-flow");

const identity = { id: "id-1", username: "root", role: "super_admin", status: "active" as const, sessionVersion: 1, twoFactorEnabled: false };
const session = { id: "session-1" };

beforeEach(() => {
  redirectMock.mockClear();
  routerPush.mockReset();
  readActiveContext.mockReset();
  safeNextPath.mockClear();
  startSetupAction.mockReset();
  confirmSetupAction.mockReset();
});

async function visitPage(next?: string): Promise<{ redirectedTo: string } | { element: ReactElement }> {
  try {
    const element = await TwoFactorSetupPage({ searchParams: Promise.resolve({ next }) });
    return { element };
  } catch (error) {
    if (error instanceof RedirectSignal) return { redirectedTo: error.url };
    throw error;
  }
}

describe("TwoFactorSetupPage — routing guards", () => {
  it("sends an unauthenticated visitor to /login", async () => {
    readActiveContext.mockResolvedValue(null);
    expect(await visitPage()).toEqual({ redirectedTo: "/login" });
  });

  it("skips the forced-enrollment screen once the identity already has 2FA enabled", async () => {
    readActiveContext.mockResolvedValue({ identity: { ...identity, twoFactorEnabled: true }, session, twoFactorCompleted: false });
    safeNextPath.mockReturnValue("/tags");
    expect(await visitPage("/tags")).toEqual({ redirectedTo: "/tags" });
  });

  it("falls back to the landing page when already-enrolled but next is invalid", async () => {
    readActiveContext.mockResolvedValue({ identity: { ...identity, twoFactorEnabled: true }, session, twoFactorCompleted: false });
    safeNextPath.mockReturnValue(null);
    expect(await visitPage()).toEqual({ redirectedTo: "/novels" });
  });

  it("renders the real SetupFlow for an identity that has not enrolled yet", async () => {
    readActiveContext.mockResolvedValue({ identity, session, twoFactorCompleted: false });
    const { element } = (await visitPage()) as { element: ReactElement };
    render(element);
    expect(screen.getByRole("heading", { name: "启用双重验证" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "生成密钥" })).toBeTruthy();
  });
});

describe("SetupFlow — idle -> started -> done, and the failure branch at each step", () => {
  it("shows an error and stays idle when startSetupAction fails", async () => {
    startSetupAction.mockResolvedValue({
      ok: false,
      envelope: { ok: false, status: 403, code: "two_factor_failed" },
    });
    render(<SetupFlow next={null} />);

    fireEvent.click(screen.getByRole("button", { name: "生成密钥" }));

    expect((await screen.findByRole("alert")).textContent).toBeTruthy();
    expect(screen.getByRole("button", { name: "生成密钥" })).toBeTruthy();
  });

  it("advances to the started step with the manual key and otpauth URI on success", async () => {
    startSetupAction.mockResolvedValue({
      ok: true,
      data: {
        manualKey: "JBSWY3DPEHPK3PXP",
        otpauthUri: "otpauth://totp/root@cps-novel?secret=JBSWY3DPEHPK3PXP",
        pendingExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    });
    render(<SetupFlow next={null} />);

    fireEvent.click(screen.getByRole("button", { name: "生成密钥" }));

    expect(await screen.findByText("JBSWY3DPEHPK3PXP")).toBeTruthy();
    expect(screen.getByText(/otpauth:\/\/totp/)).toBeTruthy();
  });

  it("shows an error and keeps the same secret visible when confirmSetupAction fails", async () => {
    startSetupAction.mockResolvedValue({
      ok: true,
      data: {
        manualKey: "JBSWY3DPEHPK3PXP",
        otpauthUri: "otpauth://totp/root@cps-novel?secret=JBSWY3DPEHPK3PXP",
        pendingExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    });
    confirmSetupAction.mockResolvedValue({
      ok: false,
      envelope: { ok: false, status: 403, code: "two_factor_failed" },
    });
    render(<SetupFlow next={null} />);
    fireEvent.click(screen.getByRole("button", { name: "生成密钥" }));
    await screen.findByText("JBSWY3DPEHPK3PXP");

    fireEvent.change(screen.getByLabelText("身份验证器中显示的 6 位验证码"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "确认并启用" }));

    expect((await screen.findByRole("alert")).textContent).toContain("验证码或恢复码不正确");
    expect(screen.getByText("JBSWY3DPEHPK3PXP")).toBeTruthy();
  });

  it("reaches the done step with the one-time recovery codes on a successful confirm", async () => {
    startSetupAction.mockResolvedValue({
      ok: true,
      data: {
        manualKey: "JBSWY3DPEHPK3PXP",
        otpauthUri: "otpauth://totp/root@cps-novel?secret=JBSWY3DPEHPK3PXP",
        pendingExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    });
    confirmSetupAction.mockResolvedValue({
      ok: true,
      data: { codes: ["A1B2-C3D4-E5F6", "G7H8-I9J0-K1L2"], generatedAt: new Date().toISOString() },
    });
    render(<SetupFlow next="/tags" />);
    fireEvent.click(screen.getByRole("button", { name: "生成密钥" }));
    await screen.findByText("JBSWY3DPEHPK3PXP");

    fireEvent.change(screen.getByLabelText("身份验证器中显示的 6 位验证码"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "确认并启用" }));

    expect(await screen.findByText("A1B2-C3D4-E5F6")).toBeTruthy();
    expect(screen.getByText("G7H8-I9J0-K1L2")).toBeTruthy();
    expect(confirmSetupAction).toHaveBeenCalledWith({ code: "123456" });

    fireEvent.click(screen.getByRole("button", { name: "我已保存，重新登录" }));
    expect(routerPush).toHaveBeenCalledWith("/login?next=%2Ftags");
  });

  it("points the post-recovery-codes login link at plain /login when there is no next", async () => {
    startSetupAction.mockResolvedValue({
      ok: true,
      data: {
        manualKey: "K",
        otpauthUri: "otpauth://totp/root@cps-novel?secret=K",
        pendingExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    });
    confirmSetupAction.mockResolvedValue({
      ok: true,
      data: { codes: ["A1B2-C3D4-E5F6"], generatedAt: new Date().toISOString() },
    });
    render(<SetupFlow next={null} />);
    fireEvent.click(screen.getByRole("button", { name: "生成密钥" }));
    await screen.findByText("K");
    fireEvent.change(screen.getByLabelText("身份验证器中显示的 6 位验证码"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "确认并启用" }));
    await screen.findByText("A1B2-C3D4-E5F6");

    fireEvent.click(screen.getByRole("button", { name: "我已保存，重新登录" }));
    expect(routerPush).toHaveBeenCalledWith("/login");
  });
});
