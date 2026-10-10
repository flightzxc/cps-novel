import { describe, expect, it } from "vitest";

import type { IndexNowBackfillEntry } from "@/lib/indexnow/backfill-manifest";

import {
  APPLY_USAGE,
  assertBackfillRuntimeFlags,
  assertBackfillStopConditions,
  assertBackfillWriteGates,
  parseApplyArgs,
  selectCanaryEntries,
  type BackfillGlobalSummary,
} from "../../../scripts/indexnow-backfill-apply";
import { testEnv } from "./fake-db";

function clean(overrides: Partial<BackfillGlobalSummary> = {}): BackfillGlobalSummary {
  return {
    breakerOpen: false,
    breakerTrippedBy: null,
    rateLimitedUntil: null,
    backfillUrls: { total: 0, permanentFailed: 0, deadLetter: 0 },
    failedDeliveryTasks: 0,
    deadLetterUrls: 0,
    invalidUrlCancelledUrls: 0,
    ...overrides,
  };
}

describe("assertBackfillWriteGates — gate 2a", () => {
  it("throws unless both --confirm and INDEXNOW_BACKFILL_ALLOW_WRITE=true are present", () => {
    expect(() => assertBackfillWriteGates(false, undefined)).toThrow();
    expect(() => assertBackfillWriteGates(true, undefined)).toThrow();
    expect(() => assertBackfillWriteGates(false, "true")).toThrow();
    expect(() => assertBackfillWriteGates(true, "false")).toThrow();
    expect(() => assertBackfillWriteGates(true, "true")).not.toThrow();
  });
});

describe("[20] write mode needs the outbox pair AND the delivery pair switched on in this process", () => {
  const ON = {
    FEATURE_INDEXNOW_OUTBOX: "true",
    INDEXNOW_OUTBOX_ALLOW_WRITE: "true",
    FEATURE_INDEXNOW_DELIVERY: "true",
    INDEXNOW_DELIVERY_ALLOW_WRITE: "true",
  };

  it("passes with all four on", () => {
    expect(() => assertBackfillRuntimeFlags(testEnv(ON))).not.toThrow();
  });

  it.each([
    ["delivery feature off", { FEATURE_INDEXNOW_DELIVERY: "false" }, "delivery_disabled_cannot_wait"],
    ["delivery write-allow off", { INDEXNOW_DELIVERY_ALLOW_WRITE: undefined }, "delivery_disabled_cannot_wait"],
    ["outbox feature off", { FEATURE_INDEXNOW_OUTBOX: "false" }, "outbox_disabled"],
    ["outbox write-allow off", { INDEXNOW_OUTBOX_ALLOW_WRITE: "no" }, "outbox_disabled"],
  ])("rejects: %s → %s", (_label, override, code) => {
    expect(() => assertBackfillRuntimeFlags(testEnv({ ...ON, ...override }))).toThrow(code);
  });
});

describe("assertBackfillStopConditions — global summary", () => {
  it("passes for a clean site", () => {
    expect(() => assertBackfillStopConditions(clean())).not.toThrow();
    expect(() => assertBackfillStopConditions(clean(), { urls: 500, notAcceptedUrls: 0 })).not.toThrow();
  });

  it("(a) stops when the breaker is open — ANY 400/403/422 since the last resume, not 'more than 3'", () => {
    expect(() => assertBackfillStopConditions(clean({ breakerOpen: true, breakerTrippedBy: { httpStatus: 422, requestBatchId: "b" } }))).toThrow(/breaker is open.*422/);
    expect(() => assertBackfillStopConditions(clean({ breakerOpen: true, breakerTrippedBy: { httpStatus: 403, requestBatchId: "b" } }))).toThrow(/breaker/);
  });

  it("(b) stops during a global 429 wait", () => {
    expect(() => assertBackfillStopConditions(clean({ rateLimitedUntil: "2026-10-10T00:00:00.000Z" }))).toThrow(/429 wait active until 2026-10-10/);
  });

  it("(c) stops when permanent_failed + dead_letter exceed 5% of ALL backfill rows; exactly 5% passes", () => {
    expect(() => assertBackfillStopConditions(clean({ backfillUrls: { total: 100, permanentFailed: 6, deadLetter: 0 } }))).toThrow(/ratio exceeds 5%/);
    expect(() => assertBackfillStopConditions(clean({ backfillUrls: { total: 100, permanentFailed: 5, deadLetter: 0 } }))).not.toThrow();
    expect(() => assertBackfillStopConditions(clean({ backfillUrls: { total: 20, permanentFailed: 2, deadLetter: 0 } }))).toThrow(/ratio/);
  });

  it("(d) stops when a delivery task of the backfill rows failed", () => {
    expect(() => assertBackfillStopConditions(clean({ failedDeliveryTasks: 1 }))).toThrow(/worker task failed/);
  });

  it("(e) stops when the previous chunk is not fully accepted; the message says what accepted means (200 或 202)", () => {
    expect(() => assertBackfillStopConditions(clean(), { urls: 500, notAcceptedUrls: 3 })).toThrow(/200 或 202/);
    expect(() => assertBackfillStopConditions(clean(), { urls: 500, notAcceptedUrls: 3 })).toThrow(/3 of 500/);
  });

  it("(f) stops on ANY dead letter site-wide, with the Owner-handoff wording", () => {
    expect(() => assertBackfillStopConditions(clean({ deadLetterUrls: 1 }))).toThrow(
      "死信必须交 Owner；原样重跑回填会跳过已有记录，不能代替重排",
    );
  });

  it("(g) stops on ANY row cancelled for url_invalid / url_host_mismatch", () => {
    expect(() => assertBackfillStopConditions(clean({ invalidUrlCancelledUrls: 1 }))).toThrow(/url_invalid \/ url_host_mismatch/);
  });
});

describe("parseApplyArgs — strict --offset / --limit, no upper cap", () => {
  const base = ["--manifest", "m.json"];

  it("defaults: offset 0, no limit (= to the end of the manifest), dry run", () => {
    expect(parseApplyArgs(base)).toMatchObject({ manifest: "m.json", offset: 0, limit: undefined, confirm: false });
  });

  it("accepts integers; there is no 500 cap any more", () => {
    expect(parseApplyArgs([...base, "--offset", "500", "--limit", "31000", "--confirm"])).toMatchObject({ offset: 500, limit: 31000, confirm: true });
  });

  it.each([
    ["--offset", "-1"],
    ["--offset", "1.5"],
    ["--offset", "abc"],
    ["--limit", "0"],
    ["--limit", "-3"],
    ["--limit", "10x"],
    ["--limit", ""],
  ])("rejects %s %s", (flag, value) => {
    expect(() => parseApplyArgs([...base, flag, value])).toThrow();
  });

  it("requires --manifest; --help needs nothing", () => {
    expect(() => parseApplyArgs(["--confirm"])).toThrow("--manifest <path> is required");
    expect(parseApplyArgs(["--help"])).toMatchObject({ help: true });
    expect(APPLY_USAGE).toContain("--canary-locales");
  });

  it("--canary-locales: at least 2 distinct non-empty locales, needs --limit, excludes --offset", () => {
    expect(parseApplyArgs([...base, "--canary-locales", "en,es,ru", "--limit", "30"]).canaryLocales).toEqual(["en", "es", "ru"]);
    expect(() => parseApplyArgs([...base, "--canary-locales", "en", "--limit", "30"])).toThrow(/at least 2/);
    expect(() => parseApplyArgs([...base, "--canary-locales", "en,en", "--limit", "30"])).toThrow(/duplicate/);
    expect(() => parseApplyArgs([...base, "--canary-locales", "en,,es", "--limit", "30"])).toThrow(/empty/);
    expect(() => parseApplyArgs([...base, "--canary-locales", "en,es"])).toThrow(/requires --limit/);
    expect(() => parseApplyArgs([...base, "--canary-locales", "en,es", "--limit", "4", "--offset", "10"])).toThrow(/--offset/);
  });
});

describe("[25] selectCanaryEntries — deterministic, covers every locale, redistributes the remainder", () => {
  function entries(counts: Record<string, number>): IndexNowBackfillEntry[] {
    const result: IndexNowBackfillEntry[] = [];
    for (const [locale, count] of Object.entries(counts)) {
      for (let index = 0; index < count; index++) {
        result.push({
          article_id: `${locale}-${String(index).padStart(4, "0")}`,
          novel_id: "n",
          locale,
          canonical_url: `https://x.example/${locale}/${index}`,
          created_at: "2026-01-01T00:00:00.000Z",
          release_window: "2026-01-01",
          eligibility_result: "eligible",
        });
      }
    }
    // Deliberately scramble the manifest order: the sample must not depend on it.
    return result.reverse();
  }

  it("splits evenly, the remainder going to the earlier-listed locales", () => {
    const picked = selectCanaryEntries(entries({ en: 50, es: 50, ru: 50 }), ["en", "es", "ru"], 10);
    expect(picked.perLocaleUrls).toEqual({ en: 4, es: 3, ru: 3 });
    expect(picked.entries).toHaveLength(10);
  });

  it("takes each locale's entries in ascending article_id", () => {
    const picked = selectCanaryEntries(entries({ en: 5, es: 5 }), ["en", "es"], 6);
    expect(picked.entries.filter((entry) => entry.locale === "en").map((entry) => entry.article_id)).toEqual(["en-0000", "en-0001", "en-0002"]);
    expect(picked.entries.filter((entry) => entry.locale === "es").map((entry) => entry.article_id)).toEqual(["es-0000", "es-0001", "es-0002"]);
  });

  it("a locale with too few entries gives its share to the others", () => {
    const picked = selectCanaryEntries(entries({ en: 2, es: 30, ru: 30 }), ["en", "es", "ru"], 10);
    expect(picked.perLocaleUrls).toEqual({ en: 2, es: 4, ru: 4 });
  });

  it("is deterministic for the same manifest and options, regardless of manifest order", () => {
    const manifestEntries = entries({ en: 12, es: 12, ru: 12 });
    const first = selectCanaryEntries(manifestEntries, ["en", "es", "ru"], 9);
    const second = selectCanaryEntries([...manifestEntries].reverse(), ["en", "es", "ru"], 9);
    expect(second.entries.map((entry) => entry.article_id)).toEqual(first.entries.map((entry) => entry.article_id));
  });

  it("errors when a requested locale is not in the manifest, or fewer than 2 locales are given", () => {
    expect(() => selectCanaryEntries(entries({ en: 3, es: 3 }), ["en", "fr"], 4)).toThrow("not present in the manifest: [fr]");
    expect(() => selectCanaryEntries(entries({ en: 3 }), ["en"], 2)).toThrow(/at least 2/);
  });

  it("returns fewer than the limit when the locales do not have enough entries", () => {
    const picked = selectCanaryEntries(entries({ en: 2, es: 1 }), ["en", "es"], 10);
    expect(picked.entries).toHaveLength(3);
  });
});
