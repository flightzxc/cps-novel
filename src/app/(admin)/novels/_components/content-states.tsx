import { capabilityBlockReason } from "@/features/admin-ui/capability-view";
import type { AdminCapability } from "@/lib/auth/capabilities";

/**
 * Loading skeleton for a table.
 *
 * Rows match the real table's `px-4 py-3` rhythm so the page does not jump when
 * data arrives. `aria-busy` plus a visually hidden label keeps the state
 * announced rather than purely visual.
 */
export function ContentTableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      data-testid="content-table-skeleton"
      className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm"
    >
      <span className="sr-only">加载中</span>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-4 border-b border-gray-100 px-4 py-3">
          <div className="h-4 flex-1 animate-pulse rounded bg-gray-100" />
          <div className="h-4 w-20 animate-pulse rounded bg-gray-100" />
          <div className="h-4 w-16 animate-pulse rounded bg-gray-100" />
        </div>
      ))}
    </div>
  );
}

/**
 * Shown in place of the data when the session lacks the read grant.
 *
 * Names the capability rather than saying "无权限" — P1-09 acceptance ⑥. The
 * screen still renders its shell and heading, so an operator can tell the
 * feature exists and that they need a grant, not that the page is broken.
 *
 * The state is fixed at `denied` because it is the only blocked state a read
 * capability can be in: `content:view` / `content:read` are configured
 * `requiresTwoFactor: false`, so `two_factor_required` is unreachable for them
 * and offering a 2FA challenge here would send the operator somewhere useless.
 */
export function ContentCapabilityDenied({ capability }: { capability: AdminCapability }) {
  return (
    <div
      role="status"
      data-testid="content-capability-denied"
      className="rounded-xl border border-amber-200 bg-amber-50 px-6 py-10 text-center"
    >
      <p className="text-sm font-medium text-amber-900">
        {capabilityBlockReason(capability, "denied")}
      </p>
    </div>
  );
}

/** Inline failure panel. Copy is authored by the caller from an error code. */
export function ContentErrorPanel({ message }: { message: string }) {
  return (
    <div
      role="alert"
      data-testid="content-error"
      className="rounded-xl border border-red-200 bg-red-50 px-6 py-6 text-center"
    >
      <p className="text-sm font-medium text-red-800">{message}</p>
    </div>
  );
}
