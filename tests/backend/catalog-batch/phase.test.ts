import { describe, expect, it } from "vitest";
import { deriveCatalogBatchPhase } from "@/domain/catalog-batch";

describe("catalog batch aggregate phase", () => {
  it.each([
    [{ parentStatus: "pending" }, "queued"],
    [{ parentStatus: "processing" }, "materializing"],
    [{ parentStatus: "failed" }, "failed"],
    [{ parentStatus: "disabled" }, "disabled"],
    // X10 task control: paused/cancelled win outright, same as disabled,
    // regardless of enumerationStatus/childStatuses — an admin who paused or
    // aborted a catalog_batch parent must never see it silently recomputed
    // back into materializing/executing/completed*.
    [{ parentStatus: "paused" }, "paused"],
    [{ parentStatus: "paused", enumerationStatus: "completed", childStatuses: ["completed"] }, "paused"],
    [{ parentStatus: "cancelled" }, "cancelled"],
    [{ parentStatus: "cancelled", enumerationStatus: "completed", childStatuses: ["completed"] }, "cancelled"],
    [{ parentStatus: "completed", enumerationStatus: "expired" }, "expired"],
    [{ parentStatus: "completed", enumerationStatus: "completed", childStatuses: ["processing", "disabled"] }, "executing"],
    [{ parentStatus: "completed", enumerationStatus: "completed", childStatuses: ["disabled"] }, "disabled"],
    [{ parentStatus: "completed", enumerationStatus: "completed", childStatuses: ["paused"] }, "paused"],
    [{ parentStatus: "completed", enumerationStatus: "completed", childStatuses: ["cancelled"] }, "cancelled"],
    [{ parentStatus: "completed", enumerationStatus: "completed", childStatuses: ["cancelled", "paused", "disabled"] }, "cancelled"],
    [{ parentStatus: "completed", enumerationStatus: "completed", childStatuses: ["failed", "failed"] }, "failed"],
    [{ parentStatus: "completed", enumerationStatus: "completed", childStatuses: ["completed", "failed"] }, "completed_with_errors"],
    [{ parentStatus: "completed", enumerationStatus: "completed", childStatuses: ["completed"] }, "completed"],
    [{ parentStatus: "completed", enumerationStatus: "completed", blockedCount: 2 }, "completed_with_errors"],
  ] as const)("derives %j as %s", (input, phase) => {
    expect(deriveCatalogBatchPhase(input)).toBe(phase);
  });
});
