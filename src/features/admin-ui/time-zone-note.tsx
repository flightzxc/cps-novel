import { ADMIN_TIME_ZONE_NOTE } from "./datetime";

/**
 * The admin UI's single time-zone declaration.
 *
 * `formatDateTime` deliberately emits a bare timestamp, so every page that
 * renders one owes the reader this note. One per page, next to the page title —
 * not per column and not per cell, which is what made the tables noisy.
 */
export function AdminTimeZoneNote({ className = "" }: { className?: string }) {
  return (
    <p className={`text-xs text-gray-400 ${className}`} data-testid="admin-time-zone-note">
      {ADMIN_TIME_ZONE_NOTE}
    </p>
  );
}
