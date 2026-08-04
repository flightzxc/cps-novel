"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { buttonClassName } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyButton } from "@/components/ui/copy-button";
import { StatusBadge, type BadgeTone } from "@/components/ui/status-badge";
import { EmptyRow, TBody, TD, TH, THead, Table } from "@/components/ui/table";
import type {
  AdminCapabilityState,
  CredentialMetadataView,
  CredentialOperationAvailability,
  CredentialTaskStatusView,
} from "@/contracts";
import { adminFetch } from "@/features/admin-ui/admin-fetch";
import { capabilityBlockReason } from "@/features/admin-ui/capability-view";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";

import {
  createChannelAccountAction,
  enqueueCredentialAction,
  replaceCredentialAction,
  setChannelAccountStatusAction,
  type ActionResult,
} from "../_actions";
import type { ChannelAccountRow } from "../page";

const CREDENTIAL_TONE: Readonly<Record<CredentialMetadataView["status"], BadgeTone>> = Object.freeze({
  active: "success",
  superseded: "neutral",
  expired: "danger",
  invalid: "danger",
});

const CREDENTIAL_LABEL: Readonly<Record<CredentialMetadataView["status"], string>> = Object.freeze({
  active: "有效",
  superseded: "已作废",
  expired: "已过期",
  invalid: "校验失败",
});

const TASK_STATE_LABEL: Readonly<Record<CredentialTaskStatusView["state"], string>> = Object.freeze({
  queued: "排队中",
  running: "执行中",
  completed: "已完成",
  completed_with_errors: "完成但有错误",
  failed: "失败",
  disabled: "已停用",
  unknown: "未知",
});

function formatTime(value: string | null): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

type Pending =
  | { kind: "disable"; accountId: string; accountName: string }
  | { kind: "supersede"; accountId: string; credentialId: string; prefix: string };

export function ChannelAccountsClient({
  rows,
  channels,
  availability,
  credentialManage,
}: {
  rows: readonly ChannelAccountRow[];
  channels: readonly { id: string; code: string; name: string }[];
  availability: readonly CredentialOperationAvailability[];
  credentialManage: AdminCapabilityState;
}) {
  const router = useRouter();
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState("");
  const [task, setTask] = useState<CredentialTaskStatusView | null>(null);

  const blocked = capabilityBlockReason("credential:manage", credentialManage);
  const canManage = blocked === null;
  const replaceSupported =
    availability.find((entry) => entry.operation === "add_or_replace_credential")?.state
    === "supported";

  async function run<T>(label: string, call: () => Promise<ActionResult<T>>): Promise<T | null> {
    setBusy(true);
    setNotice(null);
    const result = await call();
    setBusy(false);
    if (!result.ok) {
      // Copy comes from the stable code, never from a server string.
      setNotice({ tone: "error", text: `${label}失败：${errorEnvelopeCopy(result.envelope)}` });
      return null;
    }
    setNotice({ tone: "ok", text: `${label}成功` });
    router.refresh();
    return result.data;
  }

  async function refreshTask(taskId: string) {
    const result = await adminFetch<CredentialTaskStatusView>(
      `/api/admin/credential-tasks/status?taskId=${encodeURIComponent(taskId)}`,
    );
    if (result.ok) setTask(result.data);
    else if (result.envelope.code === "credential_task_not_found") {
      setTask(null);
      setNotice({ tone: "error", text: `任务查询失败：${errorEnvelopeCopy(result.envelope)}` });
    } else {
      setNotice({ tone: "error", text: `任务查询失败：${errorEnvelopeCopy(result.envelope)}` });
    }
  }

  return (
    <div className="space-y-5">
      {blocked && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {blocked}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className={`rounded-lg border px-3 py-2 text-sm ${
            notice.tone === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          {notice.text}
        </p>
      )}
      {task && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
          <span className="font-mono text-xs">{task.taskId}</span>
          <StatusBadge tone={task.state === "failed" ? "danger" : "info"}>
            {TASK_STATE_LABEL[task.state]}
          </StatusBadge>
          {task.failureCode && <span className="text-xs">原因：{task.failureCode}</span>}
          {task.result?.code && <span className="text-xs">结果：{task.result.code}</span>}
          <button
            type="button"
            className={buttonClassName("secondary", "px-2 py-1 text-xs")}
            onClick={() => refreshTask(task.taskId)}
          >
            刷新
          </button>
          <button
            type="button"
            className={buttonClassName("ghost", "px-2 py-1 text-xs")}
            onClick={() => setTask(null)}
          >
            关闭
          </button>
        </div>
      )}

      {canManage && (
        <CreateAccountForm
          channels={channels}
          busy={busy}
          onSubmit={(body) =>
            run("新增渠道账号", () =>
              createChannelAccountAction({ requestId: crypto.randomUUID(), ...body }),
            )
          }
        />
      )}

      <Table>
        <THead>
          <tr>
            <TH>渠道</TH>
            <TH>业务ID</TH>
            <TH>账户名</TH>
            <TH>账户状态</TH>
            <TH>凭证</TH>
            <TH>过期时间</TH>
            <TH>最近验证</TH>
            {canManage && <TH>操作</TH>}
          </tr>
        </THead>
        <TBody>
          {rows.map(({ account, channelCode, channelName, credentials }) => {
            const current = credentials[0] ?? null;
            const active = credentials.find((entry) => entry.status === "active") ?? null;
            return (
              <tr key={account.channelAccountId}>
                <TD>
                  <div className="font-medium text-gray-900">{channelName}</div>
                  <div className="text-xs text-gray-500">{channelCode}</div>
                </TD>
                <TD className="font-mono text-xs">{account.businessId}</TD>
                <TD>{account.accountName}</TD>
                <TD>
                  <StatusBadge tone={account.status === "active" ? "success" : "neutral"}>
                    {account.status === "active" ? "启用" : "停用"}
                  </StatusBadge>
                </TD>
                <TD className="space-y-1">
                  {current ? (
                    <>
                      <StatusBadge tone={CREDENTIAL_TONE[current.status]}>
                        {CREDENTIAL_LABEL[current.status]}
                      </StatusBadge>
                      <div className="flex items-center gap-1 font-mono text-xs text-gray-500">
                        {/* Prefix only. The ciphertext and the full fingerprint
                            never leave the server. */}
                        <span title="指纹前缀">{current.fingerprintPrefix}</span>
                        <CopyButton value={current.fingerprintPrefix} />
                      </div>
                    </>
                  ) : (
                    <StatusBadge tone="danger">未配置</StatusBadge>
                  )}
                </TD>
                <TD className="text-xs">{formatTime(current?.expiresAt ?? null)}</TD>
                <TD className="text-xs">{formatTime(account.lastValidatedAt)}</TD>
                {canManage && (
                  <TD className="space-y-2">
                    <ReplaceCredentialForm
                      disabled={busy || !replaceSupported}
                      onSubmit={(body) =>
                        run("更新 JWT", () =>
                          replaceCredentialAction({
                            requestId: crypto.randomUUID(),
                            channelAccountId: account.channelAccountId,
                            ...body,
                          }),
                        )
                      }
                    />
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busy || !active}
                        title={active ? undefined : "没有有效凭证可校验"}
                        className={buttonClassName("secondary", "px-2 py-1 text-xs")}
                        onClick={async () => {
                          const queued = await run("提交校验", () =>
                            enqueueCredentialAction({
                              requestId: crypto.randomUUID(),
                              channelAccountId: account.channelAccountId,
                              credentialId: active!.credentialId,
                              operation: "validate",
                            }),
                          );
                          if (queued) await refreshTask(queued.taskId);
                        }}
                      >
                        验证
                      </button>
                      <button
                        type="button"
                        disabled={busy || !active}
                        className={buttonClassName("secondary", "px-2 py-1 text-xs")}
                        onClick={() =>
                          setPending({
                            kind: "supersede",
                            accountId: account.channelAccountId,
                            credentialId: active!.credentialId,
                            prefix: active!.fingerprintPrefix,
                          })
                        }
                      >
                        作废凭证
                      </button>
                      {account.status === "active" ? (
                        <button
                          type="button"
                          disabled={busy}
                          className={buttonClassName("danger", "px-2 py-1 text-xs")}
                          onClick={() =>
                            setPending({
                              kind: "disable",
                              accountId: account.channelAccountId,
                              accountName: account.accountName,
                            })
                          }
                        >
                          停用账户
                        </button>
                      ) : (
                        <EnableAccountForm
                          busy={busy}
                          onSubmit={(value) =>
                            run("启用账户", () =>
                              setChannelAccountStatusAction({
                                requestId: crypto.randomUUID(),
                                channelAccountId: account.channelAccountId,
                                nextStatus: "active",
                                reason: value,
                              }),
                            )
                          }
                        />
                      )}
                    </div>
                  </TD>
                )}
              </tr>
            );
          })}
          {rows.length === 0 && <EmptyRow colSpan={canManage ? 8 : 7}>暂无渠道账户</EmptyRow>}
        </TBody>
      </Table>

      <ConfirmDialog
        open={pending !== null}
        pending={busy}
        title={pending?.kind === "disable" ? "确认停用该渠道账户？" : "确认作废该凭证？"}
        confirmLabel={pending?.kind === "disable" ? "停用" : "作废"}
        body={<ConfirmBody pending={pending} reason={reason} onReason={setReason} />}
        onCancel={() => {
          setPending(null);
          setReason("");
        }}
        onConfirm={async () => {
          if (!pending || !reason.trim()) return;
          if (pending.kind === "disable") {
            await run("停用账户", () =>
              setChannelAccountStatusAction({
                requestId: crypto.randomUUID(),
                channelAccountId: pending.accountId,
                nextStatus: "disabled",
                reason: reason.trim(),
              }),
            );
          } else {
            const queued = await run("提交作废", () =>
              enqueueCredentialAction({
                requestId: crypto.randomUUID(),
                channelAccountId: pending.accountId,
                credentialId: pending.credentialId,
                operation: "supersede",
                reason: reason.trim(),
              }),
            );
            if (queued) await refreshTask(queued.taskId);
          }
          setPending(null);
          setReason("");
        }}
      />
    </div>
  );
}

function ConfirmBody({
  pending,
  reason,
  onReason,
}: {
  pending: Pending | null;
  reason: string;
  onReason: (value: string) => void;
}): ReactNode {
  return (
    <>
      {pending?.kind === "disable" ? (
        <p>
          停用后账户 <span className="font-medium">{pending.accountName}</span>{" "}
          将无法被任何同步、推广领取或收益任务选中。凭证本身不会被改动，重新启用即可恢复。
        </p>
      ) : (
        <p>
          作废指纹前缀为{" "}
          <span className="font-mono">{pending?.kind === "supersede" ? pending.prefix : ""}</span>{" "}
          的凭证。作废后该账户将没有有效凭证，其同步会失败；
          <span className="font-medium">且无法通过「验证」恢复</span>，只能重新粘贴 JWT。
        </p>
      )}
      <label className="block">
        <span className="mb-1 block text-xs text-gray-500">操作原因（必填，写入审计）</span>
        <input
          value={reason}
          onChange={(event) => onReason(event.target.value)}
          className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
          placeholder="例如：密钥疑似泄漏，立即轮换"
        />
      </label>
    </>
  );
}

function CreateAccountForm({
  channels,
  busy,
  onSubmit,
}: {
  channels: readonly { id: string; code: string; name: string }[];
  busy: boolean;
  onSubmit: (body: { channelId: string; businessId: string; accountName: string }) => void;
}) {
  const [channelId, setChannelId] = useState(channels[0]?.id ?? "");
  const [businessId, setBusinessId] = useState("");
  const [accountName, setAccountName] = useState("");

  return (
    <form
      className="flex flex-wrap items-end gap-2 rounded-lg border border-gray-200 bg-white p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ channelId, businessId, accountName });
        setBusinessId("");
        setAccountName("");
      }}
    >
      <label className="flex flex-col gap-1 text-xs text-gray-500">
        渠道
        <select
          value={channelId}
          onChange={(event) => setChannelId(event.target.value)}
          className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm text-gray-900"
          required
        >
          {channels.map((channel) => (
            <option key={channel.id} value={channel.id}>
              {channel.name}（{channel.code}）
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-gray-500">
        业务ID
        <input
          value={businessId}
          onChange={(event) => setBusinessId(event.target.value)}
          className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-gray-500">
        账户名
        <input
          value={accountName}
          onChange={(event) => setAccountName(event.target.value)}
          className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
          required
        />
      </label>
      <button type="submit" disabled={busy || !channelId} className={buttonClassName("primary")}>
        新增渠道账号
      </button>
    </form>
  );
}

function EnableAccountForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(reason);
        setReason("");
      }}
    >
      <input
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="启用原因"
        required
        className="w-28 rounded border border-gray-300 px-2 py-1 text-xs"
      />
      <button type="submit" disabled={busy} className={buttonClassName("secondary", "px-2 py-1 text-xs")}>
        启用账户
      </button>
    </form>
  );
}

function ReplaceCredentialForm({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (body: { secret: string; reason: string }) => void;
}) {
  const [secret, setSecret] = useState("");
  const [reason, setReason] = useState("");

  return (
    <form
      className="flex flex-wrap items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ secret, reason });
        setSecret("");
      }}
    >
      {/* type=password so the pasted JWT is not shoulder-readable and does not
          land in browser autofill history. */}
      <input
        type="password"
        value={secret}
        onChange={(event) => setSecret(event.target.value)}
        placeholder="粘贴新 JWT"
        autoComplete="off"
        required
        className="w-36 rounded border border-gray-300 px-2 py-1 text-xs"
      />
      <input
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="原因"
        required
        className="w-28 rounded border border-gray-300 px-2 py-1 text-xs"
      />
      <button type="submit" disabled={disabled} className={buttonClassName("primary", "px-2 py-1 text-xs")}>
        更新 JWT
      </button>
    </form>
  );
}
