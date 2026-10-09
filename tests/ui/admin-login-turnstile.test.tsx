import "./setup-cleanup";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ADMIN_ACTION_REQUEST_FAILED_COPY } from "@/features/admin-ui/error-copy";
import { TURNSTILE_SCRIPT_SRC } from "@/lib/auth/admin-login-turnstile";

import { captureUnhandledRejections, nextRedirectError } from "./capture-unhandled-rejections";

/**
 * B-39 — the login page / form / widget with Cloudflare Turnstile.
 *
 * Same boundary as `admin-login-page.test.tsx`: only the Server Action module
 * and the two `next/navigation` hooks are replaced; `LoginForm`,
 * `TurnstileWidget`, `AuthCard` and the page are real. `window.turnstile` is a
 * hand-written stub (Cloudflare's own script is never loaded — jsdom would not
 * execute it, and nothing here may reach the network). Site keys are
 * Cloudflare's published dummy keys.
 */

const TEST_SITE_KEY = "1x00000000000000000000AA";
const SCRIPT_ID = "cf-turnstile-script";

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
vi.mock("@/app/(admin-auth)/_lib/auth-session", () => ({
  readActiveContext,
  postAuthDestination: vi.fn(),
  safeNextPath: (value: string | undefined) => value ?? null,
}));

const loginAction = vi.hoisted(() => vi.fn());
vi.mock("@/app/(admin-auth)/login/_actions", () => ({ loginAction }));

const { default: LoginPage } = await import("@/app/(admin-auth)/login/page");
const { LoginForm } = await import("@/app/(admin-auth)/login/_components/login-form");

type RenderOptions = {
  sitekey: string;
  theme?: string;
  callback: (token: string) => void;
  "expired-callback": () => void;
  "error-callback": () => void;
};

function installTurnstileStub() {
  const renders: RenderOptions[] = [];
  const render = vi.fn((_container: HTMLElement, options: RenderOptions) => {
    renders.push(options);
    return `widget-${renders.length}`;
  });
  const remove = vi.fn();
  (window as unknown as { turnstile?: unknown }).turnstile = { render, remove };
  return { render, remove, renders };
}

function turnstileScripts(): HTMLScriptElement[] {
  return Array.from(document.querySelectorAll("script")).filter((script) =>
    script.src.includes("challenges.cloudflare.com"),
  );
}

beforeEach(() => {
  redirectMock.mockClear();
  routerPush.mockReset();
  readActiveContext.mockReset();
  loginAction.mockReset();
  delete (window as unknown as { turnstile?: unknown }).turnstile;
  document.getElementById(SCRIPT_ID)?.remove();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function fillAndSubmit(username = "root", password = "pw") {
  fireEvent.change(screen.getByLabelText("用户名"), { target: { value: username } });
  fireEvent.change(screen.getByLabelText("密码"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: /登录/ }));
}

describe("switch OFF (default): the form is the pre-B-39 form", () => {
  it.each([
    ["prop absent", undefined],
    ["state off", { state: "off" as const }],
  ])("%s: no widget, no label, no Cloudflare script, no turnstileToken key", async (_label, turnstile) => {
    const turnstileApi = installTurnstileStub();
    loginAction.mockResolvedValue({ ok: true, next: "/two-factor/challenge" });
    render(<LoginForm next={null} turnstile={turnstile} />);

    expect(screen.queryByText("人机验证")).toBeNull();
    expect(document.getElementById(SCRIPT_ID)).toBeNull();
    expect(turnstileScripts()).toHaveLength(0);

    await fillAndSubmit("root", "correct-password");

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/two-factor/challenge"));
    const sent = loginAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(["next", "password", "username"]);
    expect(turnstileApi.render).not.toHaveBeenCalled();
  });

  it("the page reads an unset environment as OFF and renders the same form", async () => {
    vi.stubEnv("ADMIN_LOGIN_TURNSTILE_ENABLED", "");
    readActiveContext.mockResolvedValue(null);
    const element = (await LoginPage({ searchParams: Promise.resolve({}) })) as ReactElement;
    render(element);

    expect(screen.getByRole("heading", { name: "海外阅读后台" })).toBeTruthy();
    expect(screen.queryByText("人机验证")).toBeNull();
    expect(turnstileScripts()).toHaveLength(0);
  });

  it("a mistyped switch value (TRUE) is OFF as well — no widget, no script", async () => {
    vi.stubEnv("ADMIN_LOGIN_TURNSTILE_ENABLED", "TRUE");
    vi.stubEnv("ADMIN_LOGIN_TURNSTILE_SITE_KEY", TEST_SITE_KEY);
    readActiveContext.mockResolvedValue(null);
    render((await LoginPage({ searchParams: Promise.resolve({}) })) as ReactElement);

    expect(screen.queryByText("人机验证")).toBeNull();
    expect(turnstileScripts()).toHaveLength(0);
  });
});

describe("switch ON and fully configured: the widget gates the submit", () => {
  it("the page projects the public site key from the runtime environment (never the secret)", async () => {
    vi.stubEnv("ADMIN_LOGIN_TURNSTILE_ENABLED", "true");
    vi.stubEnv("ADMIN_LOGIN_TURNSTILE_SITE_KEY", TEST_SITE_KEY);
    vi.stubEnv("ADMIN_LOGIN_TURNSTILE_SECRET_KEY", "1x0000000000000000000000000000000AA");
    vi.stubEnv("ADMIN_CANONICAL_ORIGIN", "https://zbcwf.example.test");
    readActiveContext.mockResolvedValue(null);
    const turnstileApi = installTurnstileStub();

    const element = (await LoginPage({ searchParams: Promise.resolve({}) })) as ReactElement;
    // the secret must not be anywhere in the serialized props handed to the client tree
    expect(JSON.stringify(element, (_key, value) => (typeof value === "function" ? undefined : value))).not.toContain(
      "1x0000000000000000000000000000000AA",
    );
    render(element);

    expect(screen.getByText("人机验证")).toBeTruthy();
    await waitFor(() => expect(turnstileApi.render).toHaveBeenCalledTimes(1));
    expect(turnstileApi.renders[0]!.sitekey).toBe(TEST_SITE_KEY);
    expect(turnstileApi.renders[0]!.theme).toBe("light");
  });

  it("loads the explicit-render script once, from Cloudflare, only when the widget mounts", async () => {
    render(<LoginForm next={null} turnstile={{ state: "ready", siteKey: TEST_SITE_KEY }} />);

    await waitFor(() => expect(document.getElementById(SCRIPT_ID)).not.toBeNull());
    const script = document.getElementById(SCRIPT_ID) as HTMLScriptElement;
    expect(script.src).toBe(TURNSTILE_SCRIPT_SRC);
    expect(script.async).toBe(true);
    expect(turnstileScripts()).toHaveLength(1);
  });

  it("a script that fails to load shows the load-error copy", async () => {
    render(<LoginForm next={null} turnstile={{ state: "ready", siteKey: TEST_SITE_KEY }} />);
    const script = (await waitFor(() => {
      const found = document.getElementById(SCRIPT_ID);
      expect(found).not.toBeNull();
      return found;
    })) as HTMLScriptElement;

    act(() => {
      script.dispatchEvent(new Event("error"));
    });

    expect((await screen.findByText("人机验证加载失败，请刷新页面后重试")).getAttribute("role")).toBe("alert");
  });

  it("refuses to submit before the challenge is solved — no server round trip", async () => {
    installTurnstileStub();
    render(<LoginForm next={null} turnstile={{ state: "ready", siteKey: TEST_SITE_KEY }} />);

    await fillAndSubmit();

    expect((await screen.findByRole("alert")).textContent).toBe("请先完成人机验证");
    expect(loginAction).not.toHaveBeenCalled();
  });

  it("sends the token with the credentials once solved, and navigates on success", async () => {
    const turnstileApi = installTurnstileStub();
    loginAction.mockResolvedValue({ ok: true, next: "/two-factor/challenge" });
    render(<LoginForm next="/tags" turnstile={{ state: "ready", siteKey: TEST_SITE_KEY }} />);
    await waitFor(() => expect(turnstileApi.renders).toHaveLength(1));

    act(() => turnstileApi.renders[0]!.callback("XXXX.DUMMY.TOKEN.XXXX"));
    await fillAndSubmit("root", "pw");

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/two-factor/challenge"));
    expect(loginAction).toHaveBeenCalledWith({
      username: "root",
      password: "pw",
      next: "/tags",
      turnstileToken: "XXXX.DUMMY.TOKEN.XXXX",
    });
  });

  it("an expired token blocks the next submit until a fresh one arrives", async () => {
    const turnstileApi = installTurnstileStub();
    render(<LoginForm next={null} turnstile={{ state: "ready", siteKey: TEST_SITE_KEY }} />);
    await waitFor(() => expect(turnstileApi.renders).toHaveLength(1));

    act(() => turnstileApi.renders[0]!.callback("tok"));
    act(() => turnstileApi.renders[0]!["expired-callback"]());
    await fillAndSubmit();

    expect((await screen.findByRole("alert")).textContent).toBe("请先完成人机验证");
    expect(loginAction).not.toHaveBeenCalled();
  });

  it("a widget error clears the token and shows the load-error copy", async () => {
    const turnstileApi = installTurnstileStub();
    render(<LoginForm next={null} turnstile={{ state: "ready", siteKey: TEST_SITE_KEY }} />);
    await waitFor(() => expect(turnstileApi.renders).toHaveLength(1));

    act(() => turnstileApi.renders[0]!.callback("tok"));
    act(() => turnstileApi.renders[0]!["error-callback"]());

    expect(await screen.findByText("人机验证加载失败，请刷新页面后重试")).toBeTruthy();
    await fillAndSubmit();
    expect(loginAction).not.toHaveBeenCalled();
  });

  it("after ANY refused submission the single-use token is dropped and the widget is re-rendered", async () => {
    const turnstileApi = installTurnstileStub();
    loginAction.mockResolvedValue({
      ok: false,
      envelope: { ok: false, status: 401, code: "jwt_invalid" },
    });
    render(<LoginForm next={null} turnstile={{ state: "ready", siteKey: TEST_SITE_KEY }} />);
    await waitFor(() => expect(turnstileApi.renders).toHaveLength(1));

    act(() => turnstileApi.renders[0]!.callback("single-use-token"));
    await fillAndSubmit();
    await screen.findByRole("alert");

    await waitFor(() => expect(turnstileApi.renders).toHaveLength(2));
    expect(turnstileApi.remove).toHaveBeenCalledWith("widget-1");

    // the spent token is gone: submitting again without a fresh one is refused client-side
    await fillAndSubmit();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("请先完成人机验证"));
    expect(loginAction).toHaveBeenCalledTimes(1);

    act(() => turnstileApi.renders[1]!.callback("fresh-token"));
    await fillAndSubmit();
    await waitFor(() => expect(loginAction).toHaveBeenCalledTimes(2));
    expect(loginAction.mock.calls[1]![0]).toMatchObject({ turnstileToken: "fresh-token" });
  });

  it.each([
    ["admin_human_verification_failed", "人机验证未通过，请重新完成验证后再登录"],
    ["admin_human_verification_unavailable", "人机验证服务暂时不可用，请稍后重试；若持续出现，请联系管理员检查配置"],
  ] as const)("renders the fixed Chinese copy for %s", async (code, copy) => {
    const turnstileApi = installTurnstileStub();
    loginAction.mockResolvedValue({ ok: false, envelope: { ok: false, status: 403, code } });
    render(<LoginForm next={null} turnstile={{ state: "ready", siteKey: TEST_SITE_KEY }} />);
    await waitFor(() => expect(turnstileApi.renders).toHaveLength(1));

    act(() => turnstileApi.renders[0]!.callback("tok"));
    await fillAndSubmit();

    expect((await screen.findByRole("alert")).textContent).toBe(copy);
  });
});

describe("B-9: loginAction throws instead of returning a result", () => {
  // A failed request may already have spent the single-use token (the server
  // verifies it before it ever answers), so the throw path must drop it and
  // re-mount the widget exactly like a refused result does.
  it.each([
    ["state off", { state: "off" as const }],
    ["prop absent", undefined],
  ])("%s: shows the shared notice, hands the form back, and the retry still carries no turnstileToken key", async (_label, turnstile) => {
    const turnstileApi = installTurnstileStub();
    loginAction.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<LoginForm next={null} turnstile={turnstile} />);

    await fillAndSubmit("root", "pw");

    expect((await screen.findByRole("alert")).textContent).toBe(ADMIN_ACTION_REQUEST_FAILED_COPY);
    await waitFor(() => expect((screen.getByRole("button", { name: "登录" }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByLabelText("用户名") as HTMLInputElement).disabled).toBe(false);

    loginAction.mockResolvedValueOnce({ ok: true, next: "/two-factor/challenge" });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/two-factor/challenge"));
    expect(loginAction).toHaveBeenCalledTimes(2);
    expect(Object.keys(loginAction.mock.calls[1]![0] as Record<string, unknown>).sort()).toEqual([
      "next",
      "password",
      "username",
    ]);
    expect(turnstileApi.render).not.toHaveBeenCalled();
    expect(screen.queryByText("人机验证")).toBeNull();
  });

  it("ready: shows the shared notice, drops the spent token, re-mounts the widget, and the form is usable again", async () => {
    const turnstileApi = installTurnstileStub();
    loginAction.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<LoginForm next={null} turnstile={{ state: "ready", siteKey: TEST_SITE_KEY }} />);
    await waitFor(() => expect(turnstileApi.renders).toHaveLength(1));

    act(() => turnstileApi.renders[0]!.callback("single-use-token"));
    await fillAndSubmit();

    expect((await screen.findByRole("alert")).textContent).toBe(ADMIN_ACTION_REQUEST_FAILED_COPY);
    await waitFor(() => expect(turnstileApi.renders).toHaveLength(2));
    expect(turnstileApi.remove).toHaveBeenCalledWith("widget-1");
    expect((screen.getByRole("button", { name: "登录" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText("用户名") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText("密码") as HTMLInputElement).disabled).toBe(false);

    // the spent token is gone: submitting again without a fresh one is refused client-side
    await fillAndSubmit();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("请先完成人机验证"));
    expect(loginAction).toHaveBeenCalledTimes(1);

    // a fresh token from the re-mounted widget unlocks the next attempt, with the same credentials
    loginAction.mockResolvedValueOnce({ ok: true, next: "/two-factor/challenge" });
    act(() => turnstileApi.renders[1]!.callback("fresh-token"));
    await fillAndSubmit();
    await waitFor(() => expect(loginAction).toHaveBeenCalledTimes(2));
    expect(loginAction.mock.calls[1]![0]).toEqual({
      username: "root",
      password: "pw",
      next: undefined,
      turnstileToken: "fresh-token",
    });
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/two-factor/challenge"));
  });

  it("ready: a NEXT_REDIRECT is re-thrown untouched — no network notice", async () => {
    const turnstileApi = installTurnstileStub();
    const redirect = nextRedirectError("/two-factor/setup");
    loginAction.mockRejectedValueOnce(redirect);
    render(<LoginForm next={null} turnstile={{ state: "ready", siteKey: TEST_SITE_KEY }} />);
    await waitFor(() => expect(turnstileApi.renders).toHaveLength(1));
    act(() => turnstileApi.renders[0]!.callback("tok"));

    await captureUnhandledRejections(async (seen) => {
      await fillAndSubmit();
      await waitFor(() => expect(seen).toContain(redirect));
    });

    expect(screen.queryByText(ADMIN_ACTION_REQUEST_FAILED_COPY)).toBeNull();
  });
});

describe("switch ON but misconfigured: the form cannot submit and says why", () => {
  it("shows the unavailable copy, disables the button, loads no script and never calls loginAction", async () => {
    render(<LoginForm next={null} turnstile={{ state: "misconfigured" }} />);

    expect((await screen.findByRole("alert")).textContent).toContain("人机验证服务暂时不可用");
    const button = screen.getByRole("button", { name: /登录/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.submit(button.closest("form")!);

    expect(loginAction).not.toHaveBeenCalled();
    expect(turnstileScripts()).toHaveLength(0);
    expect(document.getElementById(SCRIPT_ID)).toBeNull();
  });

  it("the page maps an enabled-but-keyless environment to the misconfigured form", async () => {
    vi.stubEnv("ADMIN_LOGIN_TURNSTILE_ENABLED", "true");
    vi.stubEnv("ADMIN_LOGIN_TURNSTILE_SITE_KEY", TEST_SITE_KEY);
    vi.stubEnv("ADMIN_LOGIN_TURNSTILE_SECRET_KEY", ""); // secret never loaded
    vi.stubEnv("ADMIN_CANONICAL_ORIGIN", "https://zbcwf.example.test");
    readActiveContext.mockResolvedValue(null);

    render((await LoginPage({ searchParams: Promise.resolve({}) })) as ReactElement);

    expect((screen.getByRole("button", { name: /登录/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(turnstileScripts()).toHaveLength(0);
  });
});
