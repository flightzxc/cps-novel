// C-11 (`施工工单_PhaseE返工2_坏页不崩worker与免费书归一_2026-09-07.md`): the DB
// CHECK on both `novel` and `novel_source_item` is
// `paid_from_chapter IS NULL OR paid_from_chapter > 0`
// (`prisma/migrations/20260803090000_p1_initial_schema/migration.sql:1253-1254`,
// constraints `novel_chapter_metadata_check` /
// `novel_source_item_metadata_check`) and `total_chapter_count >= 0`.
// MoboReader reports `payEpisFrom: 0` (sometimes negative) for a book with
// no paywall; writing that literally violated the CHECK and crashed the
// worker process (see `worker-runtime-finalize-failure.test.ts` for the D-7
// half of this incident). These four functions are the exact values wired
// into `novelSourceItem.upsert`'s `create`/`update` data in
// `worker/handlers/moboreader.ts:535-561` and into `novelSourceItem.update`
// in `src/lib/preview/changdu-materialization.ts:266-276` — no further
// transformation happens between these return values and the Prisma call.
import { describe, expect, it } from "vitest";
import {
  clampTotalChapterCount,
  normalizePaidFromChapter,
  paidFromChapterForUpdate,
  totalChapterCountForUpdate,
} from "@/lib/tasks/moboreader";

describe("normalizePaidFromChapter (CREATE path value, worker/handlers/moboreader.ts:546)", () => {
  it("payEpisFrom = 0 -> null (free / no paywall, not a literal 0 that would violate the CHECK)", () => {
    expect(normalizePaidFromChapter(0)).toBeNull();
  });

  it("payEpisFrom = null -> null (no value reported; a brand-new row simply has no paywall recorded)", () => {
    expect(normalizePaidFromChapter(null)).toBeNull();
  });

  it("payEpisFrom = 5 -> 5 (ordinary positive paywall cut, passed through unchanged)", () => {
    expect(normalizePaidFromChapter(5)).toBe(5);
  });

  it("payEpisFrom = -1 -> null (defensively treated the same as 0: free)", () => {
    expect(normalizePaidFromChapter(-1)).toBeNull();
  });
});

describe("paidFromChapterForUpdate (UPDATE path value, worker/handlers/moboreader.ts:561 and changdu-materialization.ts:275)", () => {
  it("payEpisFrom = 0 -> null, and NOT undefined: an upstream 0 must explicitly overwrite a previously-stored positive value with NULL, never be swallowed into 'leave unchanged' the way a bare `?? undefined` would", () => {
    expect(paidFromChapterForUpdate(0)).toBeNull();
  });

  it("payEpisFrom = null -> undefined: leaves the existing column unchanged, the one case where 'no value reported' should not overwrite prior data", () => {
    expect(paidFromChapterForUpdate(null)).toBeUndefined();
  });

  it("payEpisFrom = undefined -> undefined (optional-field variant of the same 'leave unchanged' case, used by changdu-materialization.ts's optional `payEpisFrom?`)", () => {
    expect(paidFromChapterForUpdate(undefined)).toBeUndefined();
  });

  it("payEpisFrom = 5 -> 5 (ordinary positive paywall cut, written explicitly)", () => {
    expect(paidFromChapterForUpdate(5)).toBe(5);
  });

  it("payEpisFrom = -1 -> null (defensively treated the same as 0: free, written explicitly - not swallowed)", () => {
    expect(paidFromChapterForUpdate(-1)).toBeNull();
  });
});

describe("clampTotalChapterCount / totalChapterCountForUpdate (total_chapter_count >= 0 CHECK)", () => {
  it("allEpis = -3 -> 0 (clamped up to the CHECK's lower bound, CPS-parity Math.max(0, value))", () => {
    expect(clampTotalChapterCount(-3)).toBe(0);
  });

  it("allEpis = 0 -> 0 (already valid, passes through)", () => {
    expect(clampTotalChapterCount(0)).toBe(0);
  });

  it("allEpis = 42 -> 42 (ordinary positive count, passed through unchanged)", () => {
    expect(clampTotalChapterCount(42)).toBe(42);
  });

  it("totalChapterCountForUpdate: allEpis = -3 -> 0 on the update path too", () => {
    expect(totalChapterCountForUpdate(-3)).toBe(0);
  });

  it("totalChapterCountForUpdate: allEpis = null -> undefined (leave unchanged)", () => {
    expect(totalChapterCountForUpdate(null)).toBeUndefined();
  });

  it("totalChapterCountForUpdate: allEpis = undefined -> undefined (optional-field variant)", () => {
    expect(totalChapterCountForUpdate(undefined)).toBeUndefined();
  });
});
