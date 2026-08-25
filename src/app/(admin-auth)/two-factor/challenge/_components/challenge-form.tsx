"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { buttonClassName } from "@/components/ui/button";
import type { TwoFactorChallengeView } from "@/contracts";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";

import { completeChallengeAction, resendChallengeAction } from "../_actions";

const INPUT_CLASS =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-center font-mono text-lg tracking-[0.3em] text-gray-900 placeholder:tracking-normal placeholder:text-gray-400 placeholder:font-sans placeholder:text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:bg-gray-100";

type Mode = "totp" | "recovery";

function useCountdown(expiresAt: string | undefined): number {
  const [remaining, setRemaining] = useState(() =>
    expiresAt ? Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000)) : 0,
  );
  useEffect(() => {
    if (!expiresAt) return;
    const id = setInterval(() => {
      setRemaining(Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  return remaining;
}

function ExpiredState() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onResend() {
    setBusy(true);
    setError(null);
    const result = await resendChallengeAction();
    setBusy(false);
    if (!result.ok) {
      setError(errorEnvelopeCopy(result.envelope));
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
        本次验证已过期或不可用，请重新发送验证。
      </p>
      {error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
      <button type="button" disabled={busy} onClick={onResend} className={buttonClassName("primary", "w-full")}>
        {busy ? "发送中…" : "重新发送验证"}
      </button>
    </div>
  );
}

export function ChallengeForm({
  view,
  next,
}: {
  view: TwoFactorChallengeView | null;
  next: string | null;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("totp");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remaining = useCountdown(view?.expiresAt);

  if (!view || remaining <= 0) return <ExpiredState />;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await completeChallengeAction(
      mode === "totp" ? { code, next } : { recoveryCode: code, next },
    );
    if (!result.ok) {
      setError(errorEnvelopeCopy(result.envelope));
      setBusy(false);
      return;
    }
    router.push(result.next);
  }

  const minutes = Math.floor(remaining / 60);
  const seconds = String(remaining % 60).padStart(2, "0");

  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate>
      <div className="flex items-center justify-between text-xs text-gray-500">
        <div className="inline-flex rounded-lg border border-gray-200 p-0.5">
          <button
            type="button"
            onClick={() => {
              setMode("totp");
              setCode("");
            }}
            className={`rounded-md px-2.5 py-1 ${mode === "totp" ? "bg-blue-50 text-blue-700" : "text-gray-500"}`}
          >
            验证器代码
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("recovery");
              setCode("");
            }}
            className={`rounded-md px-2.5 py-1 ${mode === "recovery" ? "bg-blue-50 text-blue-700" : "text-gray-500"}`}
          >
            恢复码
          </button>
        </div>
        <span>
          剩余尝试 {view.attemptsRemaining} 次 · {minutes}:{seconds} 后过期
        </span>
      </div>

      {error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}

      <div>
        <label htmlFor="challenge-code" className="mb-1 block text-sm font-medium text-gray-700">
          {mode === "totp" ? "6 位验证码" : "恢复码（形如 A1B2-C3D4-E5F6）"}
        </label>
        <input
          id="challenge-code"
          name="code"
          type="text"
          inputMode={mode === "totp" ? "numeric" : "text"}
          autoComplete="one-time-code"
          maxLength={mode === "totp" ? 6 : 14}
          required
          disabled={busy}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder={mode === "totp" ? "000000" : "XXXX-XXXX-XXXX"}
          className={INPUT_CLASS}
        />
      </div>

      <button type="submit" disabled={busy || !code} className={buttonClassName("primary", "w-full")}>
        {busy ? "验证中…" : "验证"}
      </button>
    </form>
  );
}
