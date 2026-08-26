import "./setup-cleanup";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  ADMIN_DISPLAY_TIME_ZONE_LABEL,
  formatDateTime,
} from "@/features/admin-ui/datetime";
import { AdminTimeZoneNote } from "@/features/admin-ui/time-zone-note";

/**
 * PR-C5 shipped a local stand-in while U4 was unmerged; the final batch
 * deleted it and repointed these assertions at U4's real modules. They are
 * kept rather than folded into `admin-datetime.test.ts` because two of them
 * are not asserted there: the `/UTC|GMT|Z$/` shape guard, and the fixed
 * 03:00Z → 11:00 cross-check that is independent of the runner's own TZ.
 */
describe("AdminTimeZoneNote · zone declared once, values stay bare", () => {
  it("renders exactly one declaration naming the zone", () => {
    render(<AdminTimeZoneNote />);
    const note = screen.getByTestId("admin-time-zone-note");
    expect(note.textContent).toContain(ADMIN_DISPLAY_TIME_ZONE_LABEL);
  });

  it("formatDateTime never appends the zone to the value itself", () => {
    const value = formatDateTime("2026-08-26T03:00:00.000Z");
    expect(value).not.toContain(ADMIN_DISPLAY_TIME_ZONE_LABEL);
    expect(value).not.toMatch(/UTC|GMT|Z$/);
  });

  it("is pinned to Asia/Shanghai regardless of what zone the runtime happens to be in", () => {
    // 2026-08-26T03:00:00Z is 11:00 in Asia/Shanghai (UTC+8) — a fixed,
    // unambiguous cross-check independent of the test runner's own TZ env.
    const value = formatDateTime("2026-08-26T03:00:00.000Z");
    expect(value).toContain("11:00");
  });

  it("renders '-' for null, undefined and an unparsable value — never a raw exception or 'Invalid Date'", () => {
    expect(formatDateTime(null)).toBe("-");
    expect(formatDateTime(undefined)).toBe("-");
    expect(formatDateTime("not-a-date")).toBe("-");
  });
});
