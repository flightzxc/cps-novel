import "./setup-cleanup";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  AdminTimeZoneNote,
  ADMIN_TIME_ZONE_LABEL,
  formatAdminTimestamp,
} from "@/features/admin-ui/admin-time-zone-note";

/**
 * PR-C5's local stand-in for U4's not-yet-merged `AdminTimeZoneNote` /
 * pinned `formatDateTime` — see this file's own header. The contract under
 * test is the same one U4 documents: values carry no zone suffix, the zone
 * is declared once per page.
 */
describe("AdminTimeZoneNote · U4 contract equivalent", () => {
  it("renders exactly one declaration naming the zone", () => {
    render(<AdminTimeZoneNote />);
    const note = screen.getByTestId("admin-time-zone-note");
    expect(note.textContent).toContain(ADMIN_TIME_ZONE_LABEL);
  });

  it("formatAdminTimestamp never appends the zone to the value itself", () => {
    const value = formatAdminTimestamp("2026-08-26T03:00:00.000Z");
    expect(value).not.toContain(ADMIN_TIME_ZONE_LABEL);
    expect(value).not.toMatch(/UTC|GMT|Z$/);
  });

  it("is pinned to Asia/Shanghai regardless of what zone the runtime happens to be in", () => {
    // 2026-08-26T03:00:00Z is 11:00 in Asia/Shanghai (UTC+8) — a fixed,
    // unambiguous cross-check independent of the test runner's own TZ env.
    const value = formatAdminTimestamp("2026-08-26T03:00:00.000Z");
    expect(value).toContain("11:00");
  });

  it("renders '-' for null, undefined and an unparsable value — never a raw exception or 'Invalid Date'", () => {
    expect(formatAdminTimestamp(null)).toBe("-");
    expect(formatAdminTimestamp(undefined)).toBe("-");
    expect(formatAdminTimestamp("not-a-date")).toBe("-");
  });
});
