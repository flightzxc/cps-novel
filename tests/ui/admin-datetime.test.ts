import { describe, expect, it } from "vitest";

import {
  ADMIN_DISPLAY_TIME_ZONE,
  ADMIN_DISPLAY_TIME_ZONE_LABEL,
  ADMIN_TIME_ZONE_NOTE,
  formatDateTime,
} from "@/features/admin-ui/datetime";

describe("formatDateTime", () => {
  it("pins Asia/Shanghai and declares the zone once, in the note", () => {
    expect(ADMIN_DISPLAY_TIME_ZONE).toBe("Asia/Shanghai");
    expect(ADMIN_DISPLAY_TIME_ZONE_LABEL).toBe("UTC+8");
    expect(ADMIN_TIME_ZONE_NOTE).toContain(ADMIN_DISPLAY_TIME_ZONE_LABEL);
  });

  it("renders a UTC midnight instant as Shanghai 08:00", () => {
    const result = formatDateTime("2026-01-01T00:00:00.000Z");
    expect(result).toContain("08:00");
    expect(result).toContain("2026");
  });

  it("crosses the date line when UTC is still the previous day", () => {
    const result = formatDateTime("2025-12-31T16:00:00.000Z");
    expect(result).toContain("2026");
    expect(result).toMatch(/00:00/);
  });

  /**
   * The zone belongs to the label, never the value: a table repeats the value
   * once per row, so a per-cell suffix widens the column and reads as noise.
   */
  it("keeps the zone out of the value", () => {
    expect(formatDateTime("2026-01-01T00:00:00.000Z")).not.toContain(
      ADMIN_DISPLAY_TIME_ZONE_LABEL,
    );
  });

  it("returns - for empty and invalid values", () => {
    expect(formatDateTime(null)).toBe("-");
    expect(formatDateTime(undefined)).toBe("-");
    expect(formatDateTime("")).toBe("-");
    expect(formatDateTime("not-a-date")).toBe("-");
  });
});
