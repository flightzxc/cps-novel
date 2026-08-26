import "./setup-cleanup";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
