"use client";

import { useState, useTransition } from "react";

import { buttonClassName } from "@/components/ui/button";
import type { TwoFactorSecurityState } from "@/lib/auth/two-factor";

import {
  confirmSecuritySetupAction,
  regenerateSecurityRecoveryCodesAction,
  startSecuritySetupAction,
} from "../_actions";

type Setup = { manualKey: string; otpauthUri: string; qrCodeDataUrl: string; pendingExpiresAt: string };

const STATUS_LABEL: Record<TwoFactorSecurityState["status"], string> = {
  disabled: "未启用",
  pending: "待确认",
  pending_expired: "待确认已过期",
  enabled: "已启用",
};

function formatDate(value: string | null): string {
  return value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "-";
}

export function SecurityPanel({ initialState }: { initialState: TwoFactorSecurityState }) {
  const [status, setStatus] = useState(initialState.status);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [setupCode, setSetupCode] = useState("");
  const [regenerateCode, setRegenerateCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<readonly string[]>([]);
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState("");
  const [isPending, startTransition] = useTransition();

  function startSetup() {
    startTransition(async () => {
      setNotice("");
      const result = await startSecuritySetupAction({ requestId: crypto.randomUUID() });
      if (!result.ok) return setNotice("无法开始设置，请刷新后重试。");
      setSetup(result.data);
      setStatus("pending");
    });
  }

  function confirmSetup() {
    startTransition(async () => {
      setNotice("");
      const result = await confirmSecuritySetupAction({ requestId: crypto.randomUUID(), code: setupCode });
      if (!result.ok) return setNotice("动态码无效或设置已过期。");
      setRecoveryCodes(result.data.recoveryCodes);
      setSaved(false);
      setSetup(null);
      setStatus("enabled");
      setNotice("双重验证已启用；当前会话已失效，请先保存恢复码。 ");
    });
  }

  function regenerate() {
    startTransition(async () => {
      setNotice("");
      const result = await regenerateSecurityRecoveryCodesAction({ requestId: crypto.randomUUID(), code: regenerateCode });
      if (!result.ok) return setNotice("动态码无效，恢复码未更改。");
      setRecoveryCodes(result.data.recoveryCodes);
      setSaved(false);
      setRegenerateCode("");
      setNotice("新恢复码已生成，旧恢复码已作废；当前会话已失效。 ");
    });
  }

  return <div className="space-y-6">
    {notice ? <p role="status" className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">{notice}</p> : null}
    <section className="rounded-xl border border-gray-200 bg-white p-6">
      <div className="flex items-start justify-between gap-4">
        <div><h2 className="font-semibold text-gray-900">当前账号</h2><p className="mt-1 text-sm text-gray-500">{initialState.username}</p></div>
        <span data-testid="two-factor-status" className="rounded-full bg-gray-100 px-3 py-1 text-sm">{STATUS_LABEL[status]}</span>
      </div>
      <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-3">
        <div><dt className="text-gray-500">确认时间</dt><dd>{formatDate(initialState.confirmedAt)}</dd></div>
        <div><dt className="text-gray-500">恢复码剩余</dt><dd>{initialState.recoveryCodesRemaining} 个</dd></div>
        <div><dt className="text-gray-500">最近生成</dt><dd>{formatDate(initialState.recoveryCodesRotatedAt)}</dd></div>
      </dl>
      {status !== "enabled" ? <button type="button" disabled={isPending} onClick={startSetup} className={buttonClassName("primary", "mt-5")}>{status === "disabled" ? "开始设置" : "重新扫码"}</button> : null}
    </section>

    {setup ? <section className="rounded-xl border border-gray-200 bg-white p-6">
      <h2 className="font-semibold">扫码并确认</h2>
      {/* QR data URL is generated server-side from the pending secret and is never persisted. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={setup.qrCodeDataUrl} alt="双重验证二维码" className="mt-4 h-56 w-56 bg-white p-2" />
      <p className="mt-3 text-xs text-gray-500">手动密钥：<code>{setup.manualKey}</code></p>
      <p className="mt-1 text-xs text-gray-500">过期：{formatDate(setup.pendingExpiresAt)}</p>
      <div className="mt-4 flex gap-3"><input aria-label="设置动态码" value={setupCode} onChange={(event) => setSetupCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" className="rounded-lg border px-3 py-2" /><button type="button" disabled={isPending || setupCode.length !== 6} onClick={confirmSetup} className={buttonClassName("primary")}>确认启用</button></div>
    </section> : null}

    {status === "enabled" ? <section className="rounded-xl border border-gray-200 bg-white p-6">
      <h2 className="font-semibold">重新生成恢复码</h2>
      <p className="mt-1 text-sm text-gray-500">需输入当前 TOTP；新码会在同一事务中替换全部旧码。此处没有自助禁用入口。</p>
      <div className="mt-4 flex gap-3"><input aria-label="当前动态码" value={regenerateCode} onChange={(event) => setRegenerateCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" className="rounded-lg border px-3 py-2" /><button type="button" disabled={isPending || regenerateCode.length !== 6} onClick={regenerate} className={buttonClassName("secondary")}>重新生成恢复码</button></div>
    </section> : null}

    {recoveryCodes.length > 0 ? <section className="rounded-xl border border-amber-200 bg-amber-50 p-6">
      <h2 className="font-semibold text-amber-950">恢复码只显示一次</h2>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">{recoveryCodes.map((code) => <code key={code} className="rounded bg-white px-3 py-2">{code}</code>)}</div>
      <label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} />我已安全保存恢复码</label>
      <a aria-disabled={!saved} href={saved ? "/login?next=%2Fsettings%2Fsecurity" : undefined} className={buttonClassName("primary", `mt-4 inline-flex ${saved ? "" : "pointer-events-none opacity-50"}`)}>保存后重新登录</a>
    </section> : null}
  </div>;
}
