import { describe, expect, it } from "vitest";
import { deriveParentTaskStatus } from "@/lib/tasks";

describe("P1-07 parent state derivation", () => {
  it.each([
    [{ pending: 1, processing: 0, success: 0, failed: 0, skipped: 0 }, "processing"],
    [{ pending: 0, processing: 1, success: 1, failed: 0, skipped: 0 }, "processing"],
    [{ pending: 0, processing: 0, success: 0, failed: 2, skipped: 0 }, "failed"],
    [{ pending: 0, processing: 0, success: 1, failed: 1, skipped: 0 }, "completed_with_errors"],
    [{ pending: 0, processing: 0, success: 1, failed: 0, skipped: 1 }, "completed"],
  ] as const)("derives from persisted counts %#", (counts, expected) => {
    expect(deriveParentTaskStatus(counts)).toBe(expected);
  });
});
