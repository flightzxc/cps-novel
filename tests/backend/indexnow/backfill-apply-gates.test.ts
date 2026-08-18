import { describe, expect, it } from "vitest";

import { assertBackfillStopConditions, assertBackfillWriteGates } from "../../../scripts/indexnow-backfill-apply";

describe("assertBackfillWriteGates — gate 2a", () => {
  it("throws unless both --confirm and INDEXNOW_BACKFILL_ALLOW_WRITE=true are present", () => {
    expect(() => assertBackfillWriteGates(false, undefined)).toThrow();
    expect(() => assertBackfillWriteGates(true, undefined)).toThrow();
    expect(() => assertBackfillWriteGates(false, "true")).toThrow();
    expect(() => assertBackfillWriteGates(true, "false")).toThrow();
  });

  it("passes when both are present", () => {
    expect(() => assertBackfillWriteGates(true, "true")).not.toThrow();
  });
});

describe("assertBackfillStopConditions — gate 2b", () => {
  it("halts on any prior HTTP 403 (key/config review required)", () => {
    expect(() => assertBackfillStopConditions([{ status: "permanent_failed", lastHttpStatus: 403 }])).toThrow(/403/);
  });

  it("halts once more than 3 HTTP 422 responses have occurred", () => {
    const rows = Array.from({ length: 4 }, () => ({ status: "permanent_failed", lastHttpStatus: 422 }));
    expect(() => assertBackfillStopConditions(rows)).toThrow(/422/);
  });

  it("does not halt at exactly 3 HTTP 422 responses (isolated from the separate terminal-ratio condition)", () => {
    // `status` deliberately is not `permanent_failed`/`dead_letter` here so
    // this row set only exercises the 422-count condition, not the 5%
    // terminal-failure-ratio condition below (both conditions inspect the
    // same rows independently, per `assertBackfillStopConditions`'s body).
    const rows = Array.from({ length: 3 }, () => ({ status: "accepted", lastHttpStatus: 422 }));
    expect(() => assertBackfillStopConditions(rows)).not.toThrow();
  });

  it("halts when the terminal failure ratio exceeds 5%", () => {
    const rows = [
      ...Array.from({ length: 94 }, () => ({ status: "accepted", lastHttpStatus: 200 })),
      ...Array.from({ length: 6 }, () => ({ status: "dead_letter", lastHttpStatus: 500 })),
    ];
    expect(() => assertBackfillStopConditions(rows)).toThrow(/5%/);
  });

  it("does not halt at exactly 5% (boundary is exclusive of the threshold, not the count)", () => {
    const rows = [
      ...Array.from({ length: 95 }, () => ({ status: "accepted", lastHttpStatus: 200 })),
      ...Array.from({ length: 5 }, () => ({ status: "dead_letter", lastHttpStatus: 500 })),
    ];
    expect(() => assertBackfillStopConditions(rows)).not.toThrow();
  });

  it("halts if any linked worker task already failed, independent of delivery row state", () => {
    expect(() => assertBackfillStopConditions([], 1)).toThrow(/worker task/);
  });

  it("passes for an empty or all-successful delivery set with no failed worker tasks", () => {
    expect(() => assertBackfillStopConditions([])).not.toThrow();
    expect(() => assertBackfillStopConditions([{ status: "accepted", lastHttpStatus: 200 }])).not.toThrow();
  });
});
