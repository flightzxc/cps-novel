import { describe, expect, it } from "vitest";
import { deriveCatalogBatchPhase } from "@/domain/catalog-batch";

describe("catalog batch aggregate phase", () => {
  it.each([
    [{ parentStatus: "pending" }, "queued"],
    [{ parentStatus: "processing" }, "materializing"],
    [{ parentStatus: "failed" }, "failed"],
    [{ parentStatus: "disabled" }, "disabled"],
    [{ parentStatus: "completed", enumerationStatus: "expired" }, "expired"],
    [{ parentStatus: "completed", enumerationStatus: "completed", childStatuses: ["processing", "disabled"] }, "executing"],
    [{ parentStatus: "completed", enumerationStatus: "completed", childStatuses: ["disabled"] }, "disabled"],
    [{ parentStatus: "completed", enumerationStatus: "completed", childStatuses: ["failed", "failed"] }, "failed"],
    [{ parentStatus: "completed", enumerationStatus: "completed", childStatuses: ["completed", "failed"] }, "completed_with_errors"],
    [{ parentStatus: "completed", enumerationStatus: "completed", childStatuses: ["completed"] }, "completed"],
    [{ parentStatus: "completed", enumerationStatus: "completed", blockedCount: 2 }, "completed_with_errors"],
  ] as const)("derives %j as %s", (input, phase) => {
    expect(deriveCatalogBatchPhase(input)).toBe(phase);
  });
});
