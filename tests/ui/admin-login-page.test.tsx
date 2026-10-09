import "./setup-cleanup";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ADMIN_ACTION_REQUEST_FAILED_COPY } from "@/features/admin-ui/error-copy";

import { captureUnhandledRejections, nextRedirectError } from "./capture-unhandled-rejections";

/**
 * PR-C1 · `/login` — page branching (`login/page.tsx`) and form interaction
 * (`login/_components/login-form.tsx`).
 *
 * 🔴 Only the Server Action module (`login/_actions.ts` — `"use server"`,
 * imports `next/headers` and Prisma, cannot load in jsdom) and the two
 * `next/navigation` boundaries are replaced. `postAuthDestination` /
 * `safeNextPath` are mocked here too, deliberately: their own branching is
 * already covered by `admin-auth-session-lib.test.ts`, so this file only
 * needs to prove the page *calls* them and *acts on* what they return — not
 * re-derive their logic. `<LoginForm>` and `<AuthCard>` are the real
 * components.
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
const postAuthDestination = vi.hoisted(() => vi.fn());
const safeNextPath = vi.hoisted(() => vi.fn((value: string | undefined) => value ?? null));
vi.mock("@/app/(admin-auth)/_lib/auth-session", () => ({
  readActiveContext,
  postAuthDestination,
  safeNextPath,
}));

const loginAction = vi.hoisted(() => vi.fn());
vi.mock("@/app/(admin-auth)/login/_actions", () => ({ loginAction }));

const { default: LoginPage } = await import("@/app/(admin-auth)/login/page");
const { LoginForm } = await import("@/app/(admin-auth)/login/_components/login-form");

beforeEach(() => {
  redirectMock.mockClear();
  routerPush.mockReset();
  readActiveContext.mockReset();
  postAuthDestination.mockReset();
  safeNextPath.mockClear();
  loginAction.mockReset();
});

async function visitPage(next?: string): Promise<{ redirectedTo: string } | { element: ReactElement }> {
  try {
    const element = await LoginPage({ searchParams: Promise.resolve({ next }) });
    return { element };
  } catch (error) {
    if (error instanceof RedirectSignal) return { redirectedTo: error.url };
    throw error;
  }
}

describe("LoginPage — already-authenticated visitors skip the form", () => {
  it("redirects wherever postAuthDestination says, given the current session and ?next=", async () => {
    const context = { identity: { twoFactorEnabled: true }, twoFactorCompleted: true };
    readActiveContext.mockResolvedValue(context);
    postAuthDestination.mockReturnValue("/novels");

    const result = await visitPage("/tags");

    expect(postAuthDestination).toHaveBeenCalledWith(context, "/tags");
    expect(result).toEqual({ redirectedTo: "/novels" });
  });
});

describe("LoginPage — no session renders the real login form", () => {
  it("renders AuthCard + LoginForm with the validated next path", async () => {
    readActiveContext.mockResolvedValue(null);
    safeNextPath.mockReturnValue("/novels");

    const { element } = (await visitPage("/novels")) as { element: ReactElement };
    render(element);

    expect(screen.getByRole("heading", { name: "海外阅读后台" })).toBeTruthy();
    expect(screen.getByLabelText("用户名")).toBeTruthy();
    expect(screen.getByLabelText("密码")).toBeTruthy();
  });
});

describe("LoginForm — every loginAction result branch", () => {
  async function fillAndSubmit(username: string, password: string) {
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: username } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: password } });
    fireEvent.click(screen.getByRole("button", { name: /登录/ }));
  }

  it("navigates to the returned next path on success", async () => {
    loginAction.mockResolvedValue({ ok: true, next: "/two-factor/challenge" });
    render(<LoginForm next={null} />);

    await fillAndSubmit("root", "correct-password");

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/two-factor/challenge"));
    expect(loginAction).toHaveBeenCalledWith({ username: "root", password: "correct-password", next: undefined });
  });

  it("renders the same copy for a wrong password and an unknown username — no enumeration", async () => {
    const envelope = { ok: false as const, status: 401 as const, code: "jwt_invalid" as const };
    loginAction.mockResolvedValue({ ok: false, envelope });
    render(<LoginForm next={null} />);

    await fillAndSubmit("real-admin", "wrong-password");
    const firstMessage = await screen.findByRole("alert");
    const wrongPasswordText = firstMessage.textContent;

    loginAction.mockResolvedValue({ ok: false, envelope });
    await fillAndSubmit("no-such-user", "anything");
    const secondMessage = await screen.findByRole("alert");

    expect(secondMessage.textContent).toBe(wrongPasswordText);
    expect(wrongPasswordText).not.toMatch(/用户名|不存在|密码错误/);
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("surfaces the lockout window from admin_rate_limited", async () => {
    loginAction.mockResolvedValue({
      ok: false,
      envelope: { ok: false, status: 429, code: "admin_rate_limited", details: { retryAfterSeconds: "42" } },
    });
    render(<LoginForm next={null} />);

    await fillAndSubmit("root", "whatever");

    expect((await screen.findByRole("alert")).textContent).toContain("42 秒后重试");
  });

  it("passes the validated next path through to loginAction", async () => {
    loginAction.mockResolvedValue({ ok: true, next: "/two-factor/setup" });
    render(<LoginForm next="/tags" />);

    await fillAndSubmit("root", "pw");

    await waitFor(() =>
      expect(loginAction).toHaveBeenCalledWith({ username: "root", password: "pw", next: "/tags" }),
    );
  });
});

describe("LoginForm — loginAction throws instead of returning a result (B-9)", () => {
  // Network drop, nginx 401/429 answering with HTML, or a page rendered before a
  // deploy whose Server Action id no longer exists: the call itself rejects.
  // Before B-9 the form stayed on "登录中…" with every input disabled, forever.
  async function fillAndSubmit(username: string, password: string) {
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: username } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: password } });
    fireEvent.click(screen.getByRole("button", { name: /登录/ }));
  }

  function expectFormUsable() {
    expect((screen.getByLabelText("用户名") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText("密码") as HTMLInputElement).disabled).toBe(false);
    const button = screen.getByRole("button", { name: "登录" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("登录");
  }

  it("the shared copy is the fixed Chinese sentence (and is not the generic envelope fallback)", () => {
    expect(ADMIN_ACTION_REQUEST_FAILED_COPY).toBe("网络或会话异常，请刷新页面后重试");
  });

  it.each([
    ["a dropped network connection", new TypeError("Failed to fetch")],
    ["a stale Server Action after a deploy", new Error('Failed to find Server Action "7f3a". This request might be from an older or newer deployment.')],
    ["a non-Error rejection", "boom"],
  ])("%s: shows the shared notice and hands the form back", async (_label, thrown) => {
    loginAction.mockRejectedValue(thrown);
    render(<LoginForm next={null} />);

    await fillAndSubmit("root", "pw");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(ADMIN_ACTION_REQUEST_FAILED_COPY);
    await waitFor(() => expectFormUsable());
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("is busy while the call is in flight, recovers when it rejects, and a second submit calls the action again", async () => {
    let rejectFirst!: (reason: unknown) => void;
    loginAction.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectFirst = reject;
      }),
    );
    render(<LoginForm next={null} />);

    await fillAndSubmit("root", "pw");

    await waitFor(() => expect(screen.getByRole("button", { name: "登录中…" })).toBeTruthy());
    expect((screen.getByLabelText("用户名") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("密码") as HTMLInputElement).disabled).toBe(true);

    rejectFirst(new TypeError("Failed to fetch"));
    expect((await screen.findByRole("alert")).textContent).toBe(ADMIN_ACTION_REQUEST_FAILED_COPY);
    await waitFor(() => expectFormUsable());
    expect(loginAction).toHaveBeenCalledTimes(1);

    loginAction.mockResolvedValueOnce({ ok: true, next: "/two-factor/challenge" });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() => expect(loginAction).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/two-factor/challenge"));
    // the notice from the failed attempt is cleared as soon as the retry starts
    expect(screen.queryByRole("alert")).toBeNull();
    // the typed credentials survived the failure — the operator does not retype
    expect(loginAction.mock.calls[1]![0]).toEqual({ username: "root", password: "pw", next: undefined });
  });

  it("a successful sign-in keeps the form busy while it navigates away (no second submit mid-transition)", async () => {
    loginAction.mockResolvedValue({ ok: true, next: "/two-factor/challenge" });
    render(<LoginForm next={null} />);

    await fillAndSubmit("root", "pw");

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/two-factor/challenge"));
    expect((screen.getByRole("button", { name: "登录中…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("用户名") as HTMLInputElement).disabled).toBe(true);
  });

  it("a refused result (ok:false) also hands the form back", async () => {
    loginAction.mockResolvedValue({
      ok: false,
      envelope: { ok: false, status: 401, code: "jwt_invalid" },
    });
    render(<LoginForm next={null} />);

    await fillAndSubmit("root", "wrong");

    expect((await screen.findByRole("alert")).textContent).not.toBe(ADMIN_ACTION_REQUEST_FAILED_COPY);
    await waitFor(() => expectFormUsable());
  });

  it("re-throws a NEXT_REDIRECT untouched instead of showing the network notice", async () => {
    const redirect = nextRedirectError("/two-factor/setup");
    loginAction.mockRejectedValue(redirect);
    render(<LoginForm next={null} />);

    await captureUnhandledRejections(async (seen) => {
      await fillAndSubmit("root", "pw");
      await waitFor(() => expect(seen).toContain(redirect));
    });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(ADMIN_ACTION_REQUEST_FAILED_COPY)).toBeNull();
  });
});
