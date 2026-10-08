import Link from "next/link";

import { StatusBadge } from "@/components/ui/status-badge";
import { formatDateTime } from "@/features/admin-ui/datetime";
import type { RevenueDashboardView } from "@/server/revenue";

import { batchStatusView, credentialStatusView, REVENUE_CREDENTIAL_WARN_DAYS } from "../_lib/copy";

const DAY_MS = 24 * 60 * 60 * 1000;

type CredentialNotice = { readonly tone: "warning" | "danger"; readonly text: string };

/**
 * 凭证到期提示。到期时间由读服务从凭证**元数据**给出（绝不是密文）。
 *  - 已过期：红；
 *  - 3 天内到期：黄，"凭证将于 X 到期，请到渠道账号页续期"；
 *  - 其余：不提示。
 * 凭证不是 active（作废 / 校验失败 / 已过期）时，到期时间已无意义，改提示"没有有效凭证"。
 */
function credentialNotice(credential: RevenueDashboardView["credential"], nowMs: number): CredentialNotice | null {
  if (!credential) {
    return { tone: "danger", text: "还没有配置达人凭证，同步不会成功。请到渠道账号页配置。" };
  }
  if (credential.status !== "active") {
    return { tone: "danger", text: "当前没有有效的达人凭证，同步不会成功。请到渠道账号页续期或替换。" };
  }
  if (!credential.expiresAt) return null;
  const expiresMs = Date.parse(credential.expiresAt);
  if (Number.isNaN(expiresMs)) return null;
  const expiresText = formatDateTime(credential.expiresAt);
  if (expiresMs <= nowMs) {
    return { tone: "danger", text: `凭证已于 ${expiresText} 过期，请到渠道账号页续期。` };
  }
  if (expiresMs - nowMs <= REVENUE_CREDENTIAL_WARN_DAYS * DAY_MS) {
    return { tone: "warning", text: `凭证将于 ${expiresText} 到期，请到渠道账号页续期。` };
  }
  return null;
}

const NOTICE_STYLE: Readonly<Record<CredentialNotice["tone"], string>> = Object.freeze({
  warning: "border-amber-200 bg-amber-50 text-amber-900",
  danger: "border-red-200 bg-red-50 text-red-800",
});

function Field({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="mt-1 text-sm text-gray-900">{children}</dd>
    </div>
  );
}

/**
 * 同步概览：账号、最近一次批次、最近成功同步、凭证、最近批次记录的 StarId 与凭证指纹前缀。
 *
 * 只展示元数据：账号标签是读服务脱敏过的；指纹只有前缀；StarId 是上游的账号标识；
 * 不展示 token、密文。
 */
export function SyncOverview({
  view,
  nowMs,
}: {
  view: Pick<RevenueDashboardView, "account" | "batches" | "credential" | "lastSuccessfulSyncAt">;
  nowMs: number;
}) {
  const latest = view.batches[0] ?? null;
  const latestStatus = latest ? batchStatusView(latest.status) : null;
  const notice = view.account ? credentialNotice(view.credential, nowMs) : null;
  const credential = view.credential ? credentialStatusView(view.credential.status) : null;

  return (
    <section
      aria-labelledby="revenue-overview-heading"
      data-testid="revenue-sync-overview"
      className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
    >
      <h2 id="revenue-overview-heading" className="text-sm font-semibold text-gray-900">
        同步概览
      </h2>

      {view.account ? (
        <dl className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="渠道账号" testId="revenue-overview-account">
            <span className="font-mono text-xs" title="已脱敏">
              {view.account.label}
            </span>
          </Field>
          <Field label="最近一次批次" testId="revenue-overview-latest-batch">
            {latest && latestStatus ? (
              <span className="flex flex-wrap items-center gap-2">
                <StatusBadge tone={latestStatus.tone}>{latestStatus.label}</StatusBadge>
                <span className="text-xs text-gray-500">{formatDateTime(latest.createdAt)}</span>
              </span>
            ) : (
              <span className="text-gray-400">还没有同步过</span>
            )}
          </Field>
          <Field label="最近成功同步" testId="revenue-overview-last-success">
            {view.lastSuccessfulSyncAt ? (
              formatDateTime(view.lastSuccessfulSyncAt)
            ) : (
              <span className="text-gray-400">从未成功</span>
            )}
          </Field>
          <Field label="达人凭证" testId="revenue-overview-credential">
            {credential && view.credential ? (
              <span className="flex flex-wrap items-center gap-2">
                <StatusBadge tone={credential.tone}>{credential.label}</StatusBadge>
                <span className="text-xs text-gray-500">
                  {view.credential.expiresAt ? `到期 ${formatDateTime(view.credential.expiresAt)}` : "无到期时间"}
                </span>
              </span>
            ) : (
              <StatusBadge tone="danger">未配置</StatusBadge>
            )}
          </Field>
          <Field label="最近批次的 StarId" testId="revenue-overview-star-id">
            {latest?.upstreamStarId ? (
              <span className="font-mono text-xs">{latest.upstreamStarId}</span>
            ) : (
              <span className="text-gray-400">—</span>
            )}
          </Field>
          <Field label="最近批次的凭证指纹前缀" testId="revenue-overview-credential-prefix">
            {latest?.credentialFingerprintPrefix ? (
              <span className="font-mono text-xs">{latest.credentialFingerprintPrefix}</span>
            ) : (
              <span className="text-gray-400">—</span>
            )}
          </Field>
        </dl>
      ) : (
        <p
          role="status"
          data-testid="revenue-overview-no-account"
          className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          没有找到唯一可用的海阅渠道账号（网文应用下需要恰好一个启用中的账号），所以下面每一天都显示「未同步」。
          请先到{" "}
          <Link href="/channel-accounts" className="font-medium underline">
            渠道账户
          </Link>{" "}
          页确认。
        </p>
      )}

      {notice && (
        <p
          role="status"
          data-testid="revenue-credential-notice"
          data-tone={notice.tone}
          className={`mt-3 rounded-lg border px-3 py-2 text-sm ${NOTICE_STYLE[notice.tone]}`}
        >
          {notice.text}{" "}
          <Link href="/channel-accounts" className="font-medium underline">
            前往渠道账户
          </Link>
        </p>
      )}
    </section>
  );
}
