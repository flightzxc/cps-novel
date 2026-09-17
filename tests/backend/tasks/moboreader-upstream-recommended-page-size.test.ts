// C-13 (`施工工单_C13_每页100本与节流余量_2026-09-07.md`, superseding the
// earlier RC-3 fixup this file was originally about): the hard ceiling
// `MOBOREADER_CATALOG_LIMITS.maxPageSize` moved from a CPS-parity 20 to a
// directly-probed 100 (this repo's own `getlistpc` host bills by request
// count, not row count -- see the doc comment on `maxPageSize`). The
// *default* recommended page size, `MOBOREADER_UPSTREAM_RECOMMENDED_PAGE_SIZE`,
// deliberately stays at the conservative CPS-parity 20 -- raising the
// ceiling does not by itself change what an unconfigured environment
// requests; an operator opts into the larger, probed size explicitly via
// the `MOBOREADER_UPSTREAM_RECOMMENDED_PAGE_SIZE` env var. The resolver
// additionally now fails fast if that env override itself exceeds the
// ceiling, so a mis-set env can never create a task the handler will only
// refuse later, item by item.
import { describe, expect, it } from "vitest";
import {
  MOBOREADER_CATALOG_LIMITS,
  MOBOREADER_UPSTREAM_RECOMMENDED_PAGE_SIZE,
  resolveMoboreaderUpstreamRecommendedPageSize,
} from "@/lib/tasks/moboreader";

describe("MOBOREADER_UPSTREAM_RECOMMENDED_PAGE_SIZE (C-13)", () => {
  it("keeps the conservative CPS-parity default (20) strictly under the probed hard ceiling (100)", () => {
    expect(MOBOREADER_UPSTREAM_RECOMMENDED_PAGE_SIZE).toBe(20);
    expect(MOBOREADER_CATALOG_LIMITS.maxPageSize).toBe(100);
    expect(MOBOREADER_UPSTREAM_RECOMMENDED_PAGE_SIZE)
      .toBeLessThanOrEqual(MOBOREADER_CATALOG_LIMITS.maxPageSize);
  });

  it("defaults to 20 with no env override", () => {
    expect(resolveMoboreaderUpstreamRecommendedPageSize({ NODE_ENV: "test" })).toBe(20);
  });

  it("honors a positive-integer env override up to and including the 100 ceiling", () => {
    expect(resolveMoboreaderUpstreamRecommendedPageSize({
      NODE_ENV: "test",
      MOBOREADER_UPSTREAM_RECOMMENDED_PAGE_SIZE: "15",
    })).toBe(15);
    expect(resolveMoboreaderUpstreamRecommendedPageSize({
      NODE_ENV: "test",
      MOBOREADER_UPSTREAM_RECOMMENDED_PAGE_SIZE: "100",
    })).toBe(100);
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

  it("C-13: fails fast on an override above the 100 ceiling rather than creating a task the handler will only refuse later", () => {
    expect(() => resolveMoboreaderUpstreamRecommendedPageSize({
      NODE_ENV: "test",
      MOBOREADER_UPSTREAM_RECOMMENDED_PAGE_SIZE: "101",
    })).toThrow("upstream_recommended_page_size_exceeds_ceiling");
  });
});
