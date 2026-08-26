/**
 * Local equivalent of U4's time-zone declaration, for PR-C5's task center and
 * promo-link screens.
 *
 * `feature/pr-u4-frontline` (not merged into this branch's base,
 * `feature/pr-c6a-error-taxonomy` @ `32b2f77`) introduces the real
 * `@/features/admin-ui/time-zone-note` (`AdminTimeZoneNote` + a
 * `formatDateTime` pinned to `Asia/Shanghai`) and the same rule this file
 * follows: a bare value with no zone suffix, one declaration per page instead
 * of a repeated "UTC+8" in every cell. This module cannot import that file —
 * it does not exist on this base — so it re-implements the same contract
 * under a different name rather than editing the shared, already-tested
 * `content-view.ts#formatDateTime` (used by `/novels`, `/tags`,
 * `/channel-accounts`, `/catalog-sync` today, unpinned to any zone) out from
 * under those screens.
 *
 * PR-C5's report registers this as a deliberate, temporary duplication:
 * once U4 merges, call sites here should switch to the real
 * `AdminTimeZoneNote` / pinned `formatDateTime` and this file should be
 * deleted.
 */
export const ADMIN_TIME_ZONE = "Asia/Shanghai";
export const ADMIN_TIME_ZONE_LABEL = "UTC+8";
export const ADMIN_TIME_ZONE_NOTE_TEXT = `所有时间为 ${ADMIN_TIME_ZONE_LABEL}（${ADMIN_TIME_ZONE}）`;

/**
 * Pinned to `Asia/Shanghai` regardless of server runtime zone — the note this
 * component renders asserts a specific zone, so the value it labels must
 * actually be computed in that zone, not whatever the process happens to run
 * in. Never appends the zone to the string itself; that is `AdminTimeZoneNote`'s
 * job, once per page.
 */
export function formatAdminTimestamp(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("zh-CN", {
    timeZone: ADMIN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * One per page, next to the title or section heading — not per column, not
 * per cell. Repeating the zone in every table row is what made the U4 audit
 * flag the old per-cell suffix as noise in the first place.
 */
export function AdminTimeZoneNote({ className = "" }: { className?: string }) {
  return (
    <p className={`text-xs text-gray-400 ${className}`} data-testid="admin-time-zone-note">
      {ADMIN_TIME_ZONE_NOTE_TEXT}
    </p>
  );
}
