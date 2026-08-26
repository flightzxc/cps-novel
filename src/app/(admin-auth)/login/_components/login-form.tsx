"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { buttonClassName } from "@/components/ui/button";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";

import { loginAction } from "../_actions";

const INPUT_CLASS =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:bg-gray-100";

export function LoginForm({ next }: { next: string | null }) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await loginAction({ username, password, next: next ?? undefined });
    if (!result.ok) {
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
      <button type="submit" disabled={busy} className={buttonClassName("primary", "w-full")}>
        {busy ? "登录中…" : "登录"}
      </button>
    </form>
  );
}
