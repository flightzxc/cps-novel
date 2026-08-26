"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { buttonClassName } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import type { RecoveryCodesOneTimeResult, TwoFactorSetupResult } from "@/contracts";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";

import { confirmSetupAction, startSetupAction } from "../_actions";

const INPUT_CLASS =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-center font-mono text-lg tracking-[0.3em] text-gray-900 placeholder:tracking-normal placeholder:text-gray-400 placeholder:font-sans placeholder:text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:bg-gray-100";

type Step =
  | { name: "idle" }
  | { name: "started"; setup: TwoFactorSetupResult }
  | { name: "done"; recovery: RecoveryCodesOneTimeResult };

/**
 * QR code note (asked for explicitly in the PR-C1 brief): this shows the
 * `otpauth://` URI as selectable text plus the manual base32 key, not a
 * rendered QR image. Every authenticator app accepts manual key entry, and
 * the "not new dependency first" instruction rules out pulling in a QR
 * library for what is, functionally, one string. A scannable QR is a
 * reasonable later enhancement once there's a real reason to add that
 * dependency.
 */
function IdleStep({ onStart, busy, error }: { onStart: () => void; busy: boolean; error: string | null }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        点击下方按钮生成一个新的双重验证密钥，随后用身份验证器 App（如 Google Authenticator、Authy）扫描或手动输入。
      </p>
      {error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
      <button type="button" disabled={busy} onClick={onStart} className={buttonClassName("primary", "w-full")}>
        {busy ? "生成中…" : "生成密钥"}
      </button>
    </div>
  );
}

function StartedStep({
  setup,
  onDone,
}: {
  setup: TwoFactorSetupResult;
  onDone: (recovery: RecoveryCodesOneTimeResult) => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Math.round((new Date(setup.pendingExpiresAt).getTime() - Date.now()) / 1000)),
  );

  useEffect(() => {
    const id = setInterval(() => {
      setRemaining(Math.max(0, Math.round((new Date(setup.pendingExpiresAt).getTime() - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [setup.pendingExpiresAt]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await confirmSetupAction({ code });
    setBusy(false);
    if (!result.ok) {
      setError(errorEnvelopeCopy(result.envelope));
      return;
    }
    onDone(result.data);
  }

  const minutes = Math.floor(remaining / 60);
  const seconds = String(remaining % 60).padStart(2, "0");

  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
        <div>
          <p className="text-xs font-medium text-gray-500">手动输入密钥</p>
          <div className="mt-1 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1 font-mono text-sm text-gray-900">
              {setup.manualKey}
            </code>
            <CopyButton value={setup.manualKey} />
          </div>
        </div>
        <div>
          <p className="text-xs font-medium text-gray-500">或使用 otpauth 链接</p>
          <div className="mt-1 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1 font-mono text-xs text-gray-700">
              {setup.otpauthUri}
            </code>
            <CopyButton value={setup.otpauthUri} />
          </div>
        </div>
        <p className="text-xs text-gray-500">密钥 {minutes}:{seconds} 后过期，请尽快完成验证</p>
      </div>

      <form className="space-y-4" onSubmit={onSubmit} noValidate>
        {error && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </p>
        )}
        <div>
          <label htmlFor="setup-code" className="mb-1 block text-sm font-medium text-gray-700">
            身份验证器中显示的 6 位验证码
          </label>
          <input
            id="setup-code"
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            required
            disabled={busy}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="000000"
            className={INPUT_CLASS}
          />
        </div>
        <button type="submit" disabled={busy || !code} className={buttonClassName("primary", "w-full")}>
          {busy ? "确认中…" : "确认并启用"}
        </button>
      </form>
    </div>
  );
}

function DoneStep({ recovery, next }: { recovery: RecoveryCodesOneTimeResult; next: string | null }) {
  const router = useRouter();
  const loginHref = next ? `/login?next=${encodeURIComponent(next)}` : "/login";

  return (
    <div className="space-y-4">
      <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
        双重验证已启用。请立即保存以下恢复码——每个只显示这一次，验证器不可用时可用它们登录。
      </p>
      <div className="grid grid-cols-2 gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3 font-mono text-sm text-gray-900">
        {recovery.codes.map((code) => (
          <span key={code} className="rounded bg-white px-2 py-1 text-center">
            {code}
          </span>
        ))}
      </div>
      <CopyButton value={recovery.codes.join("\n")} label="复制全部恢复码" />
      <p className="text-xs text-gray-500">
        为使本次启用生效，当前登录状态需要重新验证——点击下方按钮重新登录，这次会进入刚刚启用的双重验证。
      </p>
      <button
        type="button"
        onClick={() => router.push(loginHref)}
        className={buttonClassName("primary", "w-full")}
      >
        我已保存，重新登录
      </button>
    </div>
  );
}

export function SetupFlow({ next }: { next: string | null }) {
  const [step, setStep] = useState<Step>({ name: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onStart() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await startSetupAction();
    setBusy(false);
    if (!result.ok) {
      setError(errorEnvelopeCopy(result.envelope));
      return;
    }
    setStep({ name: "started", setup: result.data });
  }

  if (step.name === "idle") return <IdleStep onStart={onStart} busy={busy} error={error} />;
  if (step.name === "started") {
    return (
      <StartedStep
        setup={step.setup}
        onDone={(recovery) => setStep({ name: "done", recovery })}
      />
    );
  }
  return <DoneStep recovery={step.recovery} next={next} />;
}
