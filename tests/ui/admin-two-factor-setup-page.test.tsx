import "./setup-cleanup";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ADMIN_ACTION_REQUEST_FAILED_COPY } from "@/features/admin-ui/error-copy";

import { captureUnhandledRejections, nextRedirectError } from "./capture-unhandled-rejections";

/**
 * PR-C1 / U5 · `/two-factor/setup` — page branching (`page.tsx`) and the
 * idle -> started -> done step machine (`_components/setup-flow.tsx`).
 *
 * Same split as the login and challenge page tests: the Server Action module
 * is replaced, `next/navigation` is replaced, `readActiveContext` /
 * `hasSessionCookie` / `safeNextPath` are mocked (their own logic lives in
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
const hasSessionCookie = vi.hoisted(() => vi.fn(async () => false));
const safeNextPath = vi.hoisted(() => vi.fn((value: string | undefined) => value ?? null));
vi.mock("@/app/(admin-auth)/_lib/auth-session", () => ({
  ADMIN_LANDING_PATH: "/novels",
  LOGIN_PATH: "/login",
  readActiveContext,
  hasSessionCookie,
  safeNextPath,
}));

const logoutAction = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/app/(admin-auth)/_lib/logout-action", () => ({ logoutAction }));

const startSetupAction = vi.hoisted(() => vi.fn());
const confirmSetupAction = vi.hoisted(() => vi.fn());
const finishSetupAction = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/app/(admin-auth)/two-factor/setup/_actions", () => ({
  startSetupAction,
  confirmSetupAction,
  finishSetupAction,
}));

const { default: TwoFactorSetupPage } = await import("@/app/(admin-auth)/two-factor/setup/page");
const { SetupFlow } = await import("@/app/(admin-auth)/two-factor/setup/_components/setup-flow");

const identity = { id: "id-1", username: "root", role: "super_admin", status: "active" as const, sessionVersion: 1, twoFactorEnabled: false };
const session = { id: "session-1" };

beforeEach(() => {
  redirectMock.mockClear();
  routerPush.mockReset();
  readActiveContext.mockReset();
  hasSessionCookie.mockReset();
  hasSessionCookie.mockResolvedValue(false);
  safeNextPath.mockClear();
  startSetupAction.mockReset();
  confirmSetupAction.mockReset();
  finishSetupAction.mockReset();
  finishSetupAction.mockResolvedValue(undefined);
  logoutAction.mockClear();
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

async function reachDone(next: string | null, codes: string[]) {
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
    data: { codes, generatedAt: new Date().toISOString() },
  });
  const view = render(<SetupFlow next={next} />);
  fireEvent.click(screen.getByRole("button", { name: "生成密钥" }));
  await screen.findByText("JBSWY3DPEHPK3PXP");
  fireEvent.change(screen.getByLabelText("身份验证器中显示的 6 位验证码"), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "确认并启用" }));
  expect(await screen.findByText(codes[0]!)).toBeTruthy();
  return view;
}

describe("TwoFactorSetupPage — routing guards", () => {
  it("sends an unauthenticated visitor with no session cookie to /login", async () => {
    readActiveContext.mockResolvedValue(null);
    hasSessionCookie.mockResolvedValue(false);
    expect(await visitPage()).toEqual({ redirectedTo: "/login" });
  });

  it("keeps rendering SetupFlow when the cookie is still present but the session is stale", async () => {
    readActiveContext.mockResolvedValue(null);
    hasSessionCookie.mockResolvedValue(true);
    const { element } = (await visitPage()) as { element: ReactElement };
    render(element);
    expect(screen.getByRole("heading", { name: "启用双重验证" })).toBeTruthy();
    expect(screen.queryByText("A1B2-C3D4-E5F6")).toBeNull();
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

  it("renders a secondary logout control wired to logoutAction", async () => {
    readActiveContext.mockResolvedValue({ identity, session, twoFactorCompleted: false });
    const { element } = (await visitPage()) as { element: ReactElement };
    render(element);

    const button = screen.getByRole("button", { name: "退出登录" });
    expect(button.closest("form")).toBeTruthy();
    fireEvent.click(button);
    await waitFor(() => expect(logoutAction).toHaveBeenCalledTimes(1));
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

  it("shows the recovery codes after confirm and does not leave the page until continue", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    await reachDone("/tags", ["A1B2-C3D4-E5F6", "G7H8-I9J0-K1L2"]);

    expect(screen.getByText("G7H8-I9J0-K1L2")).toBeTruthy();
    expect(screen.getByText(/本页关闭后无法再见/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制全部恢复码" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "复制" }).length).toBeGreaterThanOrEqual(2);
    expect(confirmSetupAction).toHaveBeenCalledWith({ code: "123456" });
    expect(finishSetupAction).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "退出登录" })).toBeNull();
    expect(setItem).not.toHaveBeenCalled();
    expect(window.location.href).not.toContain("A1B2-C3D4-E5F6");
    setItem.mockRestore();
  });

  it("calls finishSetupAction with next on continue, and does not client-navigate itself", async () => {
    await reachDone("/tags", ["A1B2-C3D4-E5F6"]);

    fireEvent.click(screen.getByRole("button", { name: "我已保存，继续" }));
    await waitFor(() => expect(finishSetupAction).toHaveBeenCalledWith({ next: "/tags" }));
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("calls finishSetupAction with a null next when there is no deep link", async () => {
    await reachDone(null, ["A1B2-C3D4-E5F6"]);

    fireEvent.click(screen.getByRole("button", { name: "我已保存，继续" }));
    await waitFor(() => expect(finishSetupAction).toHaveBeenCalledWith({ next: null }));
  });

  it("resets busy and shows an error when finishSetupAction throws a non-redirect failure", async () => {
    finishSetupAction.mockRejectedValueOnce(new Error("same-origin denied"));
    await reachDone("/tags", ["A1B2-C3D4-E5F6"]);

    fireEvent.click(screen.getByRole("button", { name: "我已保存，继续" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("退出失败");
    expect(screen.getByRole("button", { name: "我已保存，继续" })).toBeTruthy();
    expect(screen.getByText("A1B2-C3D4-E5F6")).toBeTruthy();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("does not show recovery codes again after a remount (second visit)", async () => {
    const view = await reachDone(null, ["A1B2-C3D4-E5F6"]);
    view.unmount();
    render(<SetupFlow next={null} />);
    expect(screen.queryByText("A1B2-C3D4-E5F6")).toBeNull();
    expect(screen.getByRole("button", { name: "生成密钥" })).toBeTruthy();
  });
});

describe("SetupFlow — the action throws instead of returning a result (B-9)", () => {
  // Network drop, proxy 401/429 answering with HTML, or a stale Server Action
  // after a deploy: the call rejects. Before B-9 "生成密钥" stayed on "生成中…"
  // and "确认并启用" stayed on "确认中…" with the code input locked, forever.
  const startedSetup = {
    manualKey: "JBSWY3DPEHPK3PXP",
    otpauthUri: "otpauth://totp/root@cps-novel?secret=JBSWY3DPEHPK3PXP",
    pendingExpiresAt: new Date(Date.now() + 600_000).toISOString(),
  };

  async function reachStarted() {
    startSetupAction.mockResolvedValue({ ok: true, data: startedSetup });
    render(<SetupFlow next={null} />);
    fireEvent.click(screen.getByRole("button", { name: "生成密钥" }));
    await screen.findByText("JBSWY3DPEHPK3PXP");
  }

  function submitCode(value = "123456") {
    fireEvent.change(screen.getByLabelText("身份验证器中显示的 6 位验证码"), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "确认并启用" }));
  }

  it("start: shows the shared notice, hands the button back, and a second click starts the setup", async () => {
    let rejectFirst!: (reason: unknown) => void;
    startSetupAction.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectFirst = reject;
      }),
    );
    render(<SetupFlow next={null} />);

    fireEvent.click(screen.getByRole("button", { name: "生成密钥" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "生成中…" })).toBeTruthy());

    rejectFirst(new TypeError("Failed to fetch"));
    expect((await screen.findByRole("alert")).textContent).toBe(ADMIN_ACTION_REQUEST_FAILED_COPY);
    await waitFor(() => {
      const button = screen.getByRole("button", { name: "生成密钥" }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
    });

    startSetupAction.mockResolvedValueOnce({ ok: true, data: startedSetup });
    fireEvent.click(screen.getByRole("button", { name: "生成密钥" }));

    expect(await screen.findByText("JBSWY3DPEHPK3PXP")).toBeTruthy();
    expect(startSetupAction).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(ADMIN_ACTION_REQUEST_FAILED_COPY)).toBeNull();
  });

  it("start: re-throws a NEXT_REDIRECT untouched instead of showing the network notice", async () => {
    const redirect = nextRedirectError("/login");
    startSetupAction.mockRejectedValue(redirect);
    render(<SetupFlow next={null} />);

    await captureUnhandledRejections(async (seen) => {
      fireEvent.click(screen.getByRole("button", { name: "生成密钥" }));
      await waitFor(() => expect(seen).toContain(redirect));
    });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(ADMIN_ACTION_REQUEST_FAILED_COPY)).toBeNull();
  });

  it("confirm: shows the shared notice, keeps the secret and the typed code, and a second submit reaches the recovery codes", async () => {
    await reachStarted();
    let rejectFirst!: (reason: unknown) => void;
    confirmSetupAction.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectFirst = reject;
      }),
    );

    submitCode();
    await waitFor(() => expect(screen.getByRole("button", { name: "确认中…" })).toBeTruthy());
    expect((screen.getByLabelText("身份验证器中显示的 6 位验证码") as HTMLInputElement).disabled).toBe(true);

    rejectFirst(new TypeError("Failed to fetch"));
    expect((await screen.findByRole("alert")).textContent).toBe(ADMIN_ACTION_REQUEST_FAILED_COPY);
    await waitFor(() =>
      expect((screen.getByLabelText("身份验证器中显示的 6 位验证码") as HTMLInputElement).disabled).toBe(false),
    );
    expect((screen.getByLabelText("身份验证器中显示的 6 位验证码") as HTMLInputElement).value).toBe("123456");
    expect(screen.getByText("JBSWY3DPEHPK3PXP")).toBeTruthy();
    const button = screen.getByRole("button", { name: "确认并启用" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    confirmSetupAction.mockResolvedValueOnce({
      ok: true,
      data: { codes: ["A1B2-C3D4-E5F6"], generatedAt: new Date().toISOString() },
    });
    fireEvent.click(button);

    expect(await screen.findByText("A1B2-C3D4-E5F6")).toBeTruthy();
    expect(confirmSetupAction).toHaveBeenCalledTimes(2);
    expect(confirmSetupAction).toHaveBeenLastCalledWith({ code: "123456" });
  });

  it("confirm: re-throws a NEXT_REDIRECT untouched instead of showing the network notice", async () => {
    await reachStarted();
    const redirect = nextRedirectError("/login");
    confirmSetupAction.mockRejectedValue(redirect);

    await captureUnhandledRejections(async (seen) => {
      submitCode();
      await waitFor(() => expect(seen).toContain(redirect));
    });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(ADMIN_ACTION_REQUEST_FAILED_COPY)).toBeNull();
  });

  it("continue (unchanged): a non-redirect failure keeps its own copy, not the shared notice", async () => {
    finishSetupAction.mockRejectedValueOnce(new Error("same-origin denied"));
    await reachDone("/tags", ["A1B2-C3D4-E5F6"]);

    fireEvent.click(screen.getByRole("button", { name: "我已保存，继续" }));

    expect((await screen.findByRole("alert")).textContent).toContain("退出失败");
    expect(screen.queryByText(ADMIN_ACTION_REQUEST_FAILED_COPY)).toBeNull();
  });
});
