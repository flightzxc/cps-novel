import { describe, expect, it } from "vitest";

import { TAGGING_ALL_APPLY_CONFIRMATION } from "@/lib/tagging/task-contract";
import { parseTaggingBackfillArgs } from "../../../scripts/p2-06-5-production/tagging-backfill";

describe("P2-06.5 explicit Tagging task CLI", () => {
  it("defaults to dry-run and requires exactly one explicit scope", () => {
    expect(parseTaggingBackfillArgs([
      "--lifecycle", "initialize_missing", "--request-id", "req-1", "--locale", "zh",
    ])).toMatchObject({ mode: "dry_run", scope: { kind: "locale", locale: "zh" } });
    expect(() => parseTaggingBackfillArgs([
      "--lifecycle", "initialize_missing", "--request-id", "req-1", "--locale", "zh", "--all",
    ])).toThrow(/exactly one/);
    expect(() => parseTaggingBackfillArgs([
      "--lifecycle", "initialize_missing", "--request-id", "req-1",
    ])).toThrow(/exactly one/);
  });

  it("requires literal and all authority fingerprints for all-scope apply", () => {
    const hashes = [
      "--taxonomy-sha256", "a".repeat(64),
      "--keyword-fingerprint", "b".repeat(64),
      "--config-fingerprint", "c".repeat(64),
    ];
    expect(() => parseTaggingBackfillArgs([
      "--lifecycle", "reclassify_existing", "--request-id", "req-2", "--all", "--apply", ...hashes,
    ])).toThrow(/exact confirmation/);
    expect(parseTaggingBackfillArgs([
      "--lifecycle", "reclassify_existing", "--request-id", "req-2", "--all", "--apply",
      "--confirm-all", TAGGING_ALL_APPLY_CONFIRMATION, ...hashes,
    ])).toMatchObject({ mode: "apply", scope: { kind: "all" }, confirmAll: TAGGING_ALL_APPLY_CONFIRMATION });
  });

  it("rejects conflicting modes and unknown options", () => {
    const base = ["--lifecycle", "initialize_missing", "--request-id", "req-3", "--novel-id", "00000000-0000-4000-8000-000000000001"];
    expect(() => parseTaggingBackfillArgs([...base, "--dry-run", "--apply"])).toThrow(/only one/);
    expect(() => parseTaggingBackfillArgs([...base, "--scheduler"])).toThrow(/Unknown argument/);
  });
});

