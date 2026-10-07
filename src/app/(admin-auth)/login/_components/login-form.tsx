"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { buttonClassName } from "@/components/ui/button";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";
import type { AdminLoginTurnstilePublicState } from "@/lib/auth/admin-login-turnstile";

import { loginAction } from "../_actions";
import { TurnstileWidget } from "./turnstile-widget";

const INPUT_CLASS =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:bg-gray-100";

/**
 * `turnstile` is the server's projection of the B-39 switch
 * (`readAdminLoginTurnstilePublicState`). Absent or `{ state: "off" }` — the
 * default — renders exactly the pre-B-39 form: no widget, no Cloudflare script,
 * and `loginAction` receives no `turnstileToken` key.
 */
export function LoginForm({
  next,
  turnstile,
}: {
  next: string | null;
  turnstile?: AdminLoginTurnstilePublicState;
}) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState("");
  // A Turnstile token is single use, so every refused submission remounts the
  // widget (new key) to fetch a fresh one — CPS does the same via `resetKey`.
  const [widgetKey, setWidgetKey] = useState(0);
  const turnstileReady = turnstile?.state === "ready";
  const turnstileUnavailable = turnstile?.state === "misconfigured";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (turnstileUnavailable) {
      setError(errorEnvelopeCopy({ ok: false, status: 403, code: "admin_human_verification_unavailable" }));
      return;
    }
    if (turnstileReady && !turnstileToken) {
      setError("请先完成人机验证");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await loginAction({
      username,
      password,
      next: next ?? undefined,
      ...(turnstileReady ? { turnstileToken } : {}),
    });
    if (!result.ok) {
      if (turnstileReady) {
        setTurnstileToken("");
        setWidgetKey((key) => key + 1);
      }
      // Copy comes from the stable code (`errorEnvelopeCopy`), never a server
      // string — a bad username and a bad password render the exact same
      // sentence, by design (`authenticateAdminLogin` collapses both to one
      // `jwt_invalid`).
      setError(errorEnvelopeCopy(result.envelope));
      setBusy(false);
      return;
    }
    router.push(result.next);
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate>
      {turnstileUnavailable && !error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {errorEnvelopeCopy({ ok: false, status: 403, code: "admin_human_verification_unavailable" })}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
      <div>
        <label htmlFor="login-username" className="mb-1 block text-sm font-medium text-gray-700">
          用户名
        </label>
        <input
          id="login-username"
          name="username"
          type="text"
          autoComplete="username"
          required
          disabled={busy}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          className={INPUT_CLASS}
        />
      </div>
      <div>
        <label htmlFor="login-password" className="mb-1 block text-sm font-medium text-gray-700">
          密码
        </label>
        <input
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          disabled={busy}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className={INPUT_CLASS}
        />
      </div>
      {turnstileReady && (
        <div>
          <span className="mb-1 block text-sm font-medium text-gray-700">人机验证</span>
          <TurnstileWidget key={widgetKey} siteKey={turnstile.siteKey} onTokenChange={setTurnstileToken} />
        </div>
      )}
      <button
        type="submit"
        disabled={busy || turnstileUnavailable}
        className={buttonClassName("primary", "w-full")}
      >
        {busy ? "登录中…" : "登录"}
      </button>
    </form>
  );
}
