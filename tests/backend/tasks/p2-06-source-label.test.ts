import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { MoboreaderBook } from "@/lib/adapters";
import {
  buildSourceLabelWritePlan,
  mergeDroppedLabels,
} from "../../../worker/handlers/moboreader";

function book(overrides: Partial<MoboreaderBook> = {}): MoboreaderBook {
  return {
    externalBookId: "book-1",
    agencyId: " agency-01 ",
    agencyName: " Agency Name ",
    seriesId: "series-1",
    materialType: null,
    title: "Title",
    description: null,
    coverUrl: null,
    projectType: 1,
    language: " language-02 ",
    languageName: " Language Name ",
    allEpis: null,
    payEpisFrom: null,
    splitRatio: null,
    ttoSplitRatio: null,
    createTime: null,
    seriesTypeList: ["  series/type  "],
    recommendList: ["recommend/特别"],
    labelSnapshotComplete: true,
    existingPromo: { upstreamCode: null, webUrl: null },
    rawEvidence: { __boundary: "approved_raw_evidence" },
    ...overrides,
  };
}

describe("P2-06 source label write planning", () => {
  it("keeps four external values exact and assigns display names only to language and agency", () => {
    expect(buildSourceLabelWritePlan(book()).labels).toEqual([
      { kind: "series_type", value: "  series/type  ", displayValue: undefined },
      { kind: "recommend", value: "recommend/特别", displayValue: undefined },
      { kind: "language", value: " language-02 ", displayValue: " Language Name " },
      { kind: "agency", value: " agency-01 ", displayValue: " Agency Name " },
    ]);
  });

  it("uses PostgreSQL character length and emits only safe oversize anomaly fields", () => {
    const longExternal = "x".repeat(301);
    const longDisplay = "😀".repeat(301);
    const plan = buildSourceLabelWritePlan(book({
      seriesTypeList: [longExternal],
      languageName: longDisplay,
    }));
    expect(plan.labels).toEqual(expect.arrayContaining([
      { kind: "language", value: " language-02 ", displayValue: undefined },
    ]));
    expect(plan.labels.some(({ value }) => value === longExternal)).toBe(false);
    expect(plan.droppedLabels).toEqual({
      count: 2,
      groups: expect.arrayContaining([
        {
          kind: "series_type",
          length: 301,
          sha256: createHash("sha256").update(longExternal, "utf8").digest("hex"),
          count: 1,
        },
        {
          kind: "language",
          length: 301,
          sha256: createHash("sha256").update(longDisplay, "utf8").digest("hex"),
          count: 1,
        },
      ]),
    });
    const serialized = JSON.stringify(plan.droppedLabels);
    expect(serialized).not.toContain(longExternal);
    expect(serialized).not.toContain(longDisplay);
  });

  it("aggregates repeated anomalies by kind, length and sha256 without raw values", () => {
    const value = "z".repeat(301);
    const summary = buildSourceLabelWritePlan(book({ seriesTypeList: [value] })).droppedLabels;
    expect(mergeDroppedLabels([summary, summary])).toMatchObject({
      count: 2,
      groups: [{ kind: "series_type", length: 301, count: 2 }],
    });
  });

  it("keeps task anomaly results operator-readable without exposing source raw_payload", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const grants = readFileSync(resolve(root, "infra/postgres/grants.sql"), "utf8");
    expect(grants).toMatch(/catalog_scan_task,[\s\S]*operation_audit,[\s\S]*TO web_app, analyst_ro;/);
    expect(grants).toMatch(/GRANT SELECT \([\s\S]*result, error,[\s\S]*\) ON catalog_scan_task_item TO analyst_ro;/);
    const sourceProjection = grants.match(/GRANT SELECT \([\s\S]*?\) ON novel_source_item TO web_app, analyst_ro;/)?.[0];
    expect(sourceProjection).toBeDefined();
    expect(sourceProjection).not.toContain("raw_payload");
  });

  it("uses incremental facts without absence deactivation or automatic reactivation", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const worker = readFileSync(resolve(root, "worker/handlers/moboreader.ts"), "utf8");
    const start = worker.indexOf("async function persistLabels(");
    const end = worker.indexOf("\nasync function persistCatalogPage", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const persistLabels = worker.slice(start, end);

    expect(persistLabels).not.toContain("updateMany");
    expect(persistLabels).not.toContain("notIn");
    expect(persistLabels).not.toMatch(/update:\s*\{\s*active:/);
    expect(persistLabels).toMatch(/create:\s*\{[\s\S]*?active:\s*true,/);
    expect(persistLabels).toMatch(/update:\s*\{\s*lastSeenAt:\s*now\s*\}/);
  });
});
