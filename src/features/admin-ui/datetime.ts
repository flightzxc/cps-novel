/**
 * Operator-facing datetime for the admin UI.
 *
 * Ported from CPS `formatDate` (`src/lib/utils.ts`), then adapted: the runtime
 * has no TZ, so we pin Asia/Shanghai. Empty / invalid → `-`, same as CPS, so
 * operators reading both backends side by side do not misread.
 *
 * The zone is **declared once per page** by `AdminTimeZoneNote`, never appended
 * to the value: a table renders this on every row, and repeating "UTC+8" per
 * cell both widens the column and reads as noise. Any surface that renders a
 * timestamp must carry that note.
 */
export const ADMIN_DISPLAY_TIME_ZONE = "Asia/Shanghai";
export const ADMIN_DISPLAY_TIME_ZONE_LABEL = "UTC+8";
export const ADMIN_TIME_ZONE_NOTE = `所有时间为 ${ADMIN_DISPLAY_TIME_ZONE_LABEL}`;

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("zh-CN", {
    timeZone: ADMIN_DISPLAY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
