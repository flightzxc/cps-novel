// RC-3: CPS v8.3.6 caps its catalog page size at 20
// (`worker/handlers/changdu-source-sync.ts:814`,
// `Math.min(positiveInteger(params.pageSize, 20), 20)`). The RC-3 fixup
// clamps BOTH values here to that CPS-parity 20: the hard ceiling
// `MOBOREADER_CATALOG_LIMITS.maxPageSize` (previously an unprobed 100) and
// the new default `MOBOREADER_UPSTREAM_RECOMMENDED_PAGE_SIZE`. The
// happy-path fixtures in `tests/backend/tasks/moboreader.test.ts` moved
// from `pageSize: 100` to `pageSize: 20` in the same fixup.
import { describe, expect, it } from "vitest";
import {
  MOBOREADER_CATALOG_LIMITS,
  MOBOREADER_UPSTREAM_RECOMMENDED_PAGE_SIZE,
  resolveMoboreaderUpstreamRecommendedPageSize,
} from "@/lib/tasks/moboreader";

describe("MOBOREADER_UPSTREAM_RECOMMENDED_PAGE_SIZE (RC-3)", () => {
  it("matches CPS's ported value (20), as does the hard ceiling it must never exceed", () => {
    expect(MOBOREADER_UPSTREAM_RECOMMENDED_PAGE_SIZE).toBe(20);
    expect(MOBOREADER_CATALOG_LIMITS.maxPageSize).toBe(20);
    expect(MOBOREADER_UPSTREAM_RECOMMENDED_PAGE_SIZE)
      .toBeLessThanOrEqual(MOBOREADER_CATALOG_LIMITS.maxPageSize);
  });

  it("defaults to 20 with no env override", () => {
    expect(resolveMoboreaderUpstreamRecommendedPageSize({ NODE_ENV: "test" })).toBe(20);
  });

  it("honors a positive-integer env override", () => {
    expect(resolveMoboreaderUpstreamRecommendedPageSize({
      NODE_ENV: "test",
      MOBOREADER_UPSTREAM_RECOMMENDED_PAGE_SIZE: "15",
    })).toBe(15);
  });

  it("fails fast on an invalid override rather than silently falling back", () => {
    expect(() => resolveMoboreaderUpstreamRecommendedPageSize({
      NODE_ENV: "test",
      MOBOREADER_UPSTREAM_RECOMMENDED_PAGE_SIZE: "0",
    })).toThrow("upstream_recommended_page_size_invalid");
    expect(() => resolveMoboreaderUpstreamRecommendedPageSize({
      NODE_ENV: "test",
      MOBOREADER_UPSTREAM_RECOMMENDED_PAGE_SIZE: "not-a-number",
    })).toThrow("upstream_recommended_page_size_invalid");
  });
});
