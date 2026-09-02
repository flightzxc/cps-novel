// RC-3: CPS v8.3.6 caps its catalog page size at 20
// (`worker/handlers/changdu-source-sync.ts:814`,
// `Math.min(positiveInteger(params.pageSize, 20), 20)`). This port could
// not lower `MOBOREADER_CATALOG_LIMITS.maxPageSize` to 20 to match — see
// the doc comment on `MOBOREADER_UPSTREAM_RECOMMENDED_PAGE_SIZE` in
// `src/lib/tasks/moboreader.ts` for why (frozen fixtures in
// `tests/backend/tasks/moboreader.test.ts` use `pageSize: 100` as their
// happy path). This file only covers the new, additive constant; it does
// not modify or duplicate that frozen file.
import { describe, expect, it } from "vitest";
import {
  MOBOREADER_CATALOG_LIMITS,
  MOBOREADER_UPSTREAM_RECOMMENDED_PAGE_SIZE,
  resolveMoboreaderUpstreamRecommendedPageSize,
} from "@/lib/tasks/moboreader";

describe("MOBOREADER_UPSTREAM_RECOMMENDED_PAGE_SIZE (RC-3)", () => {
  it("matches CPS's ported value (20) without touching the frozen technical ceiling (100)", () => {
    expect(MOBOREADER_UPSTREAM_RECOMMENDED_PAGE_SIZE).toBe(20);
    expect(MOBOREADER_CATALOG_LIMITS.maxPageSize).toBe(100);
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
