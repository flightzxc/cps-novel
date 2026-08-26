import Link from "next/link";

import { formatDateTime } from "@/features/admin-ui/datetime";

import {
  PROMO_LINKS_EMPTY_STATE,
  promoLinkErrorKindCopy,
  promoLinkOriginLabel,
  promoLinkStatusLabel,
} from "../_lib/promo-link-copy";

export type PromoLinkRow = {
  readonly promoLinkId: string;
  readonly novelId: string;
  readonly novelSourceItemId: string;
  readonly channelAppId: string;
  readonly channelAccountId: string;
  readonly offerType: string;
  readonly origin: string;
  readonly publicRedirectCode: string;
  readonly status: string;
  readonly errorKind: string | null;
  readonly fetchedAt: string | null;
  readonly expiresAt: string | null;
  readonly lastAttemptedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

function ErrorKindCell({ status, errorKind }: { status: string; errorKind: string | null }) {
  const copy = promoLinkErrorKindCopy(status, errorKind);
  return (
    <div>
      <p className={errorKind ? "font-medium text-amber-800" : "text-gray-500"}>{copy.label}</p>
      <p className="mt-0.5 max-w-xs text-[11px] leading-snug text-gray-500">{copy.explanation}</p>
      {copy.actionable && (
        <Link
          href="/tasks#manual-review-heading"
          className="mt-1 inline-block text-[11px] font-medium text-blue-700 hover:underline"
          data-testid={`promo-link-goto-manual-review-${errorKind}`}
        >
          去任务中心 · 人工审查区裁决 →
        </Link>
      )}
    </div>
  );
}

export function PromoLinksTable({ links }: { links: readonly PromoLinkRow[] }) {
  if (links.length === 0) {
    return (
      <div
        data-testid="promo-links-empty-state"
        className="rounded-xl border border-gray-200 bg-white px-6 py-16 text-center shadow-sm"
      >
        <p className="text-gray-400">{PROMO_LINKS_EMPTY_STATE}</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
      <table className="w-full text-sm">
        <thead className="border-b border-gray-200 bg-gray-50">
          <tr>
            <th className="px-4 py-3 text-left font-medium text-gray-500">标识</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">状态 / 来源</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">errorKind</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">公开短码</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">获取于</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">最近尝试</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500">过期于</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {links.map((link) => (
            <tr key={link.promoLinkId} data-testid={`promo-link-row-${link.promoLinkId}`} className="align-top hover:bg-gray-50">
              <td className="px-4 py-3">
                <p className="font-mono text-[11px] text-gray-500">novel {link.novelId}</p>
                <p className="font-mono text-[11px] text-gray-400">source_item {link.novelSourceItemId}</p>
                <p className="mt-1 text-xs text-gray-600">{link.offerType}</p>
              </td>
              <td className="px-4 py-3">
                <p data-testid={`promo-link-status-${link.promoLinkId}`}>{promoLinkStatusLabel(link.status)}</p>
                <p className="mt-0.5 text-[11px] text-gray-400">{promoLinkOriginLabel(link.origin)}</p>
              </td>
              <td className="px-4 py-3">
                <ErrorKindCell status={link.status} errorKind={link.errorKind} />
              </td>
              <td className="px-4 py-3 font-mono text-xs text-gray-700">{link.publicRedirectCode}</td>
              <td className="px-4 py-3 text-xs text-gray-500">{formatDateTime(link.fetchedAt)}</td>
              <td className="px-4 py-3 text-xs text-gray-500">{formatDateTime(link.lastAttemptedAt)}</td>
              <td className="px-4 py-3 text-xs text-gray-500">{formatDateTime(link.expiresAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
