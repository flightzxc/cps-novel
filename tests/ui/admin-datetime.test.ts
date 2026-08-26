import { describe, expect, it } from "vitest";

import {
  ADMIN_DISPLAY_TIME_ZONE,
  ADMIN_DISPLAY_TIME_ZONE_LABEL,
  formatDateTime,
} from "@/features/admin-ui/datetime";

describe("formatDateTime", () => {
  it("pins Asia/Shanghai and labels UTC+8", () => {
    expect(ADMIN_DISPLAY_TIME_ZONE).toBe("Asia/Shanghai");
    expect(ADMIN_DISPLAY_TIME_ZONE_LABEL).toBe("UTC+8");
  });

  it("renders a UTC midnight instant as Shanghai 08:00 with the zone label", () => {
    const result = formatDateTime("2026-01-01T00:00:00.000Z");
    expect(result).toContain("08:00");
    expect(result).toContain("2026");
    expect(result.endsWith(` ${ADMIN_DISPLAY_TIME_ZONE_LABEL}`)).toBe(true);
  });

  it("crosses the date line when UTC is still the previous day", () => {
    const result = formatDateTime("2025-12-31T16:00:00.000Z");
    expect(result).toContain("2026");
    expect(result).toMatch(/00:00/);
    expect(result.endsWith(` ${ADMIN_DISPLAY_TIME_ZONE_LABEL}`)).toBe(true);
  });

  it("returns - for empty and invalid values", () => {
    expect(formatDateTime(null)).toBe("-");
    expect(formatDateTime(undefined)).toBe("-");
    expect(formatDateTime("")).toBe("-");
    expect(formatDateTime("not-a-date")).toBe("-");
  });
});
