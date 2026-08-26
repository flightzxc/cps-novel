/**
 * Operator-facing datetime for the admin UI.
 *
 * Ported from CPS `formatDate` (`src/lib/utils.ts`), then adapted: the runtime
 * has no TZ, so we pin Asia/Shanghai and label UTC+8. Empty / invalid → `-`,
 * same as CPS, so operators reading both backends side by side do not misread.
 */
export const ADMIN_DISPLAY_TIME_ZONE = "Asia/Shanghai";
export const ADMIN_DISPLAY_TIME_ZONE_LABEL = "UTC+8";

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const formatted = date.toLocaleString("zh-CN", {
    timeZone: ADMIN_DISPLAY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${formatted} ${ADMIN_DISPLAY_TIME_ZONE_LABEL}`;
}
