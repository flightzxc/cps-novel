import "./setup-cleanup";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ADMIN_ACTION_REQUEST_FAILED_COPY } from "@/features/admin-ui/error-copy";

import { captureUnhandledRejections, nextRedirectError } from "./capture-unhandled-rejections";

/**
 * PR-C1 · `/two-factor/challenge` — page branching (`page.tsx`, including
 * `loadChallengeView`) and form interaction (`_components/challenge-form.tsx`).
 *
 * Mirrors `admin-login-page.test.tsx`'s split: the Server Action module
 * (`_actions.ts`) and the two `next/navigation` boundaries are replaced;
 * `readActiveContext` / `safeNextPath` are mocked too (their own branching is
 * `admin-auth-session-lib.test.ts`'s job). `twoFactorStore()` is mocked at
 * the factory boundary so `loadChallengeView` can be driven by a fake
 * `findChallengeByTokenHash` without touching Postgres. `<ChallengeForm>` and
 * `<AuthCard>` are the real components.
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
const routerRefresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  redirect: redirectMock,
  useRouter: () => ({ push: routerPush, refresh: routerRefresh }),
}));

const readActiveContext = vi.hoisted(() => vi.fn());
const readTwoFactorChallengeToken = vi.hoisted(() => vi.fn());
const safeNextPath = vi.hoisted(() => vi.fn((value: string | undefined) => value ?? null));
vi.mock("@/app/(admin-auth)/_lib/auth-session", () => ({
  ADMIN_LANDING_PATH: "/novels",
  LOGIN_PATH: "/login",
  TWO_FACTOR_SETUP_PATH: "/two-factor/setup",
  readActiveContext,
  readTwoFactorChallengeToken,
  safeNextPath,
}));

const findChallengeByTokenHash = vi.hoisted(() => vi.fn());
vi.mock("@/app/api/admin/_lib/auth-deps", () => ({
  twoFactorStore: () => ({ findChallengeByTokenHash }),
}));

const logoutAction = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/app/(admin-auth)/_lib/logout-action", () => ({ logoutAction }));

const completeChallengeAction = vi.hoisted(() => vi.fn());
const resendChallengeAction = vi.hoisted(() => vi.fn());
vi.mock("@/app/(admin-auth)/two-factor/challenge/_actions", () => ({
  completeChallengeAction,
  resendChallengeAction,
}));

const { default: TwoFactorChallengePage } = await import("@/app/(admin-auth)/two-factor/challenge/page");
const { ChallengeForm } = await import("@/app/(admin-auth)/two-factor/challenge/_components/challenge-form");

const identity = { id: "id-1", username: "root", role: "super_admin", status: "active" as const, sessionVersion: 1, twoFactorEnabled: true };
const session = { id: "session-1" };

beforeEach(() => {
  redirectMock.mockClear();
  routerPush.mockReset();
  routerRefresh.mockReset();
  readActiveContext.mockReset();
  readTwoFactorChallengeToken.mockReset();
  safeNextPath.mockClear();
  findChallengeByTokenHash.mockReset();
  completeChallengeAction.mockReset();
  resendChallengeAction.mockReset();
  logoutAction.mockClear();
});

async function visitPage(next?: string): Promise<{ redirectedTo: string } | { element: ReactElement }> {
  try {
    const element = await TwoFactorChallengePage({ searchParams: Promise.resolve({ next }) });
    return { element };
  } catch (error) {
    if (error instanceof RedirectSignal) return { redirectedTo: error.url };
    throw error;
  }
}

describe("TwoFactorChallengePage — routing guards ahead of the form", () => {
  it("sends an unauthenticated visitor to /login", async () => {
    readActiveContext.mockResolvedValue(null);
    expect(await visitPage()).toEqual({ redirectedTo: "/login" });
  });

  it("sends an identity that never enabled 2FA to forced setup, not the challenge form", async () => {
    readActiveContext.mockResolvedValue({ identity: { ...identity, twoFactorEnabled: false }, session, twoFactorCompleted: false });
    expect(await visitPage()).toEqual({ redirectedTo: "/two-factor/setup" });
  });

  it("skips the form entirely once this session already completed the challenge", async () => {
    readActiveContext.mockResolvedValue({ identity, session, twoFactorCompleted: true });
    safeNextPath.mockReturnValue("/tags");
    expect(await visitPage("/tags")).toEqual({ redirectedTo: "/tags" });
  });

  it("falls back to the landing page when twoFactorCompleted but next is invalid", async () => {
    readActiveContext.mockResolvedValue({ identity, session, twoFactorCompleted: true });
    safeNextPath.mockReturnValue(null);
    expect(await visitPage()).toEqual({ redirectedTo: "/novels" });
  });
});

describe("TwoFactorChallengePage — loadChallengeView collapses every non-usable state to null", () => {
  async function renderWithToken(token: string | null) {
    readActiveContext.mockResolvedValue({ identity, session, twoFactorCompleted: false });
    readTwoFactorChallengeToken.mockResolvedValue(token);
    const { element } = (await visitPage()) as { element: ReactElement };
    render(element);
  }

  it("renders the expired/resend state when there is no challenge cookie at all", async () => {
    await renderWithToken(null);
    expect(findChallengeByTokenHash).not.toHaveBeenCalled();
    expect(screen.getByText(/已过期或不可用/)).toBeTruthy();
  });

  it("renders expired when the challenge is bound to a different session", async () => {
    findChallengeByTokenHash.mockResolvedValue({
      identityId: "id-1",
      sessionId: "some-other-session",
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      attemptCount: 0,
    });
    await renderWithToken("raw-token");
    expect(screen.getByText(/已过期或不可用/)).toBeTruthy();
  });

  it("renders expired when the challenge was already consumed", async () => {
    findChallengeByTokenHash.mockResolvedValue({
      identityId: "id-1",
      sessionId: "session-1",
      consumedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      attemptCount: 0,
    });
    await renderWithToken("raw-token");
    expect(screen.getByText(/已过期或不可用/)).toBeTruthy();
  });

  it("renders a secondary logout control wired to logoutAction", async () => {
    readActiveContext.mockResolvedValue({ identity, session, twoFactorCompleted: false });
    readTwoFactorChallengeToken.mockResolvedValue(null);
    const { element } = (await visitPage()) as { element: ReactElement };
    render(element);

    const button = screen.getByRole("button", { name: "退出登录" });
    expect(button.closest("form")).toBeTruthy();
    fireEvent.click(button);
    await waitFor(() => expect(logoutAction).toHaveBeenCalledTimes(1));
  });

  it("renders the real form with remaining attempts once a live challenge is found", async () => {
    findChallengeByTokenHash.mockResolvedValue({
      identityId: "id-1",
      sessionId: "session-1",
      consumedAt: null,
      expiresAt: new Date(Date.now() + 90_000),
      attemptCount: 2,
    });
    await renderWithToken("raw-token");
    expect(screen.getByText(/剩余尝试 3 次/)).toBeTruthy();
  });
});

describe("ChallengeForm — mode toggle and every completeChallengeAction result branch", () => {
  const liveView = { expiresAt: new Date(Date.now() + 120_000).toISOString(), attemptsRemaining: 5 };

  it("submits a TOTP code by default and navigates on success", async () => {
    completeChallengeAction.mockResolvedValue({ ok: true, next: "/novels" });
    render(<ChallengeForm view={liveView} next={null} />);

    fireEvent.change(screen.getByLabelText("6 位验证码"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "验证" }));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/novels"));
    expect(completeChallengeAction).toHaveBeenCalledWith({ code: "123456", next: null });
  });

  it("switches to recovery-code mode and submits recoveryCode instead of code", async () => {
    completeChallengeAction.mockResolvedValue({ ok: true, next: "/novels" });
    render(<ChallengeForm view={liveView} next="/tags" />);

    fireEvent.click(screen.getByRole("button", { name: "恢复码" }));
    fireEvent.change(screen.getByLabelText(/恢复码（形如/), { target: { value: "A1B2-C3D4-E5F6" } });
    fireEvent.click(screen.getByRole("button", { name: "验证" }));

    await waitFor(() =>
      expect(completeChallengeAction).toHaveBeenCalledWith({ recoveryCode: "A1B2-C3D4-E5F6", next: "/tags" }),
    );
  });

  it("shows the failure copy and does not navigate on an invalid code", async () => {
    completeChallengeAction.mockResolvedValue({
      ok: false,
      envelope: { ok: false, status: 403, code: "two_factor_failed" },
    });
    render(<ChallengeForm view={liveView} next={null} />);

    fireEvent.change(screen.getByLabelText("6 位验证码"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "验证" }));

    expect((await screen.findByRole("alert")).textContent).toContain("验证码或恢复码不正确");
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("renders the expired state directly when view is null, and resend issues a fresh challenge", async () => {
    resendChallengeAction.mockResolvedValue({ ok: true });
    render(<ChallengeForm view={null} next={null} />);

    fireEvent.click(screen.getByRole("button", { name: "重新发送验证" }));

    await waitFor(() => expect(resendChallengeAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
  });

  it("surfaces a resend failure without crashing", async () => {
    resendChallengeAction.mockResolvedValue({
      ok: false,
      envelope: { ok: false, status: 403, code: "two_factor_locked" },
    });
    render(<ChallengeForm view={null} next={null} />);

    fireEvent.click(screen.getByRole("button", { name: "重新发送验证" }));

    expect((await screen.findByRole("alert")).textContent).toContain("尝试次数过多");
  });
});

describe("ChallengeForm — the action throws instead of returning a result (B-9)", () => {
  // Network drop, proxy 401/429 answering with HTML, or a stale Server Action
  // after a deploy: the call rejects. Before B-9 the form stayed on "验证中…"
  // with its input locked, and the resend button stayed on "发送中…", forever.
  const liveView = { expiresAt: new Date(Date.now() + 120_000).toISOString(), attemptsRemaining: 5 };

  function submitCode(value = "123456") {
    fireEvent.change(screen.getByLabelText("6 位验证码"), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "验证" }));
  }

  it("submit: shows the shared notice, hands the form back, keeps the typed code, and a second submit calls the action again", async () => {
    let rejectFirst!: (reason: unknown) => void;
    completeChallengeAction.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectFirst = reject;
      }),
    );
    render(<ChallengeForm view={liveView} next={null} />);

    submitCode();
    await waitFor(() => expect(screen.getByRole("button", { name: "验证中…" })).toBeTruthy());
    expect((screen.getByLabelText("6 位验证码") as HTMLInputElement).disabled).toBe(true);

    rejectFirst(new TypeError("Failed to fetch"));
    expect((await screen.findByRole("alert")).textContent).toBe(ADMIN_ACTION_REQUEST_FAILED_COPY);
    await waitFor(() => expect((screen.getByLabelText("6 位验证码") as HTMLInputElement).disabled).toBe(false));
    expect((screen.getByLabelText("6 位验证码") as HTMLInputElement).value).toBe("123456");
    const button = screen.getByRole("button", { name: "验证" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(routerPush).not.toHaveBeenCalled();

    completeChallengeAction.mockResolvedValueOnce({ ok: true, next: "/novels" });
    fireEvent.click(button);

    await waitFor(() => expect(completeChallengeAction).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/novels"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a successful verification keeps the form busy while it navigates away", async () => {
    completeChallengeAction.mockResolvedValue({ ok: true, next: "/novels" });
    render(<ChallengeForm view={liveView} next={null} />);

    submitCode();

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/novels"));
    expect((screen.getByRole("button", { name: "验证中…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("6 位验证码") as HTMLInputElement).disabled).toBe(true);
  });

  it("a refused code (ok:false) also hands the form back", async () => {
    completeChallengeAction.mockResolvedValue({
      ok: false,
      envelope: { ok: false, status: 403, code: "two_factor_failed" },
    });
    render(<ChallengeForm view={liveView} next={null} />);

    submitCode("000000");

    expect((await screen.findByRole("alert")).textContent).toContain("验证码或恢复码不正确");
    await waitFor(() => expect((screen.getByLabelText("6 位验证码") as HTMLInputElement).disabled).toBe(false));
  });

  it("submit: re-throws a NEXT_REDIRECT untouched instead of showing the network notice", async () => {
    const redirect = nextRedirectError("/login");
    completeChallengeAction.mockRejectedValue(redirect);
    render(<ChallengeForm view={liveView} next={null} />);

    await captureUnhandledRejections(async (seen) => {
      submitCode();
      await waitFor(() => expect(seen).toContain(redirect));
    });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(ADMIN_ACTION_REQUEST_FAILED_COPY)).toBeNull();
  });

  it("resend: shows the shared notice, hands the button back, and a second click calls the action again", async () => {
    let rejectFirst!: (reason: unknown) => void;
    resendChallengeAction.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectFirst = reject;
      }),
    );
    render(<ChallengeForm view={null} next={null} />);

    fireEvent.click(screen.getByRole("button", { name: "重新发送验证" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "发送中…" })).toBeTruthy());

    rejectFirst(new TypeError("Failed to fetch"));
    expect((await screen.findByRole("alert")).textContent).toBe(ADMIN_ACTION_REQUEST_FAILED_COPY);
    await waitFor(() => {
      const button = screen.getByRole("button", { name: "重新发送验证" }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
    });
    expect(routerRefresh).not.toHaveBeenCalled();

    resendChallengeAction.mockResolvedValueOnce({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "重新发送验证" }));

    await waitFor(() => expect(resendChallengeAction).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("resend: re-throws a NEXT_REDIRECT untouched instead of showing the network notice", async () => {
    const redirect = nextRedirectError("/login");
    resendChallengeAction.mockRejectedValue(redirect);
    render(<ChallengeForm view={null} next={null} />);

    await captureUnhandledRejections(async (seen) => {
      fireEvent.click(screen.getByRole("button", { name: "重新发送验证" }));
      await waitFor(() => expect(seen).toContain(redirect));
    });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(routerRefresh).not.toHaveBeenCalled();
  });
});
