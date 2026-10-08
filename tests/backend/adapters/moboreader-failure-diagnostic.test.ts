/**
 * B-36 — every way `getbydataid` / `getchapterinfo` can be rejected by the
 * adapter's own validation now names itself, without changing what is thrown
 * (class, code, `retryable`, `status`, message) and without carrying a single
 * character of the response.
 *
 * The 2026-10-07 incident: 34 books failed with HTTP 200 from both endpoints,
 * i.e. `parsePreviewChaptersResponse` threw a bare
 * `MoboreaderAdapterError("malformed_payload")` and nothing said which of its
 * eleven checks had fired. These tests pin one `diagnostic.kind` per check.
 */
import { describe, expect, it } from "vitest";

import {
  MOBOREADER_PARSE_FAILURE_KINDS,
  MoboreaderAdapterError,
  createMoboreaderReadAdapter,
  parseBookMaterialResponse,
  parsePreviewChaptersResponse,
  receivedKindOf,
} from "@/lib/adapters";

/** Text that stands in for chapter prose / upstream strings; must never surface in a diagnostic. */
const BODY = "PRIVATE-CHAPTER-BODY-MUST-NOT-LEAK";

function chapter(overrides: Record<string, unknown> = {}) {
  return { i: 1, chapterID: "c-1", chapterName: BODY, chapterShowName: BODY, chapterContent: `${BODY} once upon a time`, ...overrides };
}

function body(chapterList: unknown, extra: Record<string, unknown> = {}) {
  return { data: { bookId: "b-1", currentLanguage: 2, chapterList, ...extra } };
}

function caught(run: () => unknown): MoboreaderAdapterError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(MoboreaderAdapterError);
    return error as MoboreaderAdapterError;
  }
  throw new Error("expected the parser to throw");
}

describe("getchapterinfo: each validation names itself (B-36)", () => {
  const cases: Array<[string, unknown, Record<string, unknown>]> = [
    ["envelope is not an object", null, { kind: "envelope_not_object", receivedType: "null" }],
    ["envelope is an array", [], { kind: "envelope_not_object", receivedType: "array" }],
    ["data is missing", {}, { kind: "data_not_object", receivedType: "undefined" }],
    ["data is a string", { data: "x" }, { kind: "data_not_object", receivedType: "string" }],
    ["chapterList is missing", { data: { bookId: "b", currentLanguage: 1 } }, { kind: "chapter_list_not_array", receivedType: "undefined" }],
    ["chapterList is null", body(null), { kind: "chapter_list_not_array", receivedType: "null" }],
    ["a row is not an object", body([chapter(), "oops"]), { kind: "chapter_row_not_object", receivedType: "string", chapterIndex: 1, chapterCount: 2 }],
    ["a row is null", body([null]), { kind: "chapter_row_not_object", receivedType: "null", chapterIndex: 0, chapterCount: 1 }],
    ["i is missing", body([chapter({ i: undefined })]), { kind: "chapter_ordinal_invalid", receivedType: "undefined", chapterIndex: 0, chapterCount: 1 }],
    ["i is fractional", body([chapter({ i: 1.5 })]), { kind: "chapter_ordinal_invalid", receivedType: "fractional_number", chapterIndex: 0 }],
    ["i is negative", body([chapter({ i: -2 })]), { kind: "chapter_ordinal_invalid", receivedType: "negative_integer" }],
    ["i is a numeric string", body([chapter({ i: "1" })]), { kind: "chapter_ordinal_invalid", receivedType: "string" }],
    ["i is zero", body([chapter({ i: 0 })]), { kind: "chapter_ordinal_below_one", chapterIndex: 0, chapterOrdinal: 0, chapterCount: 1 }],
    ["chapterID is null", body([chapter({ chapterID: null })]), { kind: "chapter_id_invalid", receivedType: "null", chapterIndex: 0, chapterOrdinal: 1 }],
    ["chapterID is empty", body([chapter({ chapterID: "" })]), { kind: "chapter_id_invalid", receivedType: "empty_string" }],
    ["chapterContent is missing", body([chapter({ chapterContent: undefined })]), { kind: "chapter_content_invalid", receivedType: "undefined", chapterIndex: 0, chapterOrdinal: 1, chapterId: "c-1", chapterCount: 1 }],
    ["chapterContent is null", body([chapter({ chapterContent: null })]), { kind: "chapter_content_invalid", receivedType: "null" }],
    ["chapterContent is an empty string", body([chapter({ chapterContent: "" })]), { kind: "chapter_content_invalid", receivedType: "empty_string", valueLength: 0 }],
    ["chapterContent is only whitespace", body([chapter({ chapterContent: "  \n\t " })]), { kind: "chapter_content_invalid", receivedType: "blank_string", valueLength: 5 }],
    ["chapterContent is a number", body([chapter({ chapterContent: 7 })]), { kind: "chapter_content_invalid", receivedType: "integer" }],
    ["a later row has the bad content", body([chapter(), chapter({ i: 2, chapterID: "c-2", chapterContent: "" }), chapter({ i: 3, chapterID: "c-3" })]), { kind: "chapter_content_invalid", chapterIndex: 1, chapterOrdinal: 2, chapterId: "c-2", chapterCount: 3 }],
    ["two rows share (i, chapterID)", body([chapter(), chapter()]), { kind: "chapter_identity_duplicate", chapterIndex: 1, chapterOrdinal: 1, chapterId: "c-1", chapterCount: 2 }],
    ["bookId is null", body([chapter()], { bookId: null }), { kind: "book_id_invalid", receivedType: "null", chapterCount: 1 }],
    ["currentLanguage is missing", body([chapter()], { currentLanguage: undefined }), { kind: "current_language_invalid", receivedType: "undefined", chapterCount: 1 }],
    ["currentLanguage is blank", body([chapter()], { currentLanguage: "  " }), { kind: "current_language_invalid", receivedType: "blank_string", valueLength: 2 }],
  ];

  it.each(cases)("%s", (_label, payload, expected) => {
    const error = caught(() => parsePreviewChaptersResponse(payload));
    // Unchanged contract: same class, code, retryability and (for sites that had
    // no detail text) the same message as before the diagnostic existed.
    expect(error.code).toBe("malformed_payload");
    expect(error.retryable).toBe(false);
    expect(error.status).toBeNull();
    expect(error.diagnostic).toMatchObject(expected);
    // The diagnostic is vocabulary + numbers + (validated) ids; never prose.
    expect(JSON.stringify(error.diagnostic)).not.toContain(BODY);
    expect(error.message).not.toContain(BODY);
  });

  it("keeps the bare message for sites that never had a detail string, and the old detail text where one existed", () => {
    expect(caught(() => parsePreviewChaptersResponse(body([chapter({ chapterContent: "" })]))).message)
      .toBe("MoboReader read failed: malformed_payload");
    const idError = caught(() => parsePreviewChaptersResponse(body([chapter({ chapterID: null })])));
    expect(idError.detail).toBe("chapterID: expected a non-empty string or a finite number, received typeof object (null)");
    expect(idError.message).toContain("chapterID");
  });

  it("every parse kind in the vocabulary is exercised by a case above (no silently dead kind)", () => {
    const exercised = new Set(cases.map(([, , expected]) => expected.kind));
    exercised.add("body_not_json"); // covered through the transport below
    exercised.add("material_item_not_object"); // covered in the getbydataid block
    expect([...MOBOREADER_PARSE_FAILURE_KINDS].filter((kind) => !exercised.has(kind))).toEqual([]);
  });

  it("still accepts exactly what it accepted before", () => {
    const parsed = parsePreviewChaptersResponse(body([chapter({ chapterID: 5001001 }), chapter({ i: 2, chapterID: "c-2" })], { currentLanguage: 3 }));
    expect(parsed.chapterList.map((row) => [row.i, row.chapterID])).toEqual([[1, "5001001"], [2, "c-2"]]);
    expect(parsed.currentLanguage).toBe("3");
    expect(parsed.bookId).toBe("b-1");
    // An empty chapterList is a valid (if useless) response, handled upstream as "skipped".
    expect(parsePreviewChaptersResponse(body([])).chapterList).toEqual([]);
  });
});

describe("getbydataid: the only ways it can be rejected (B-36)", () => {
  it("names the envelope / data / first-list-item checks", () => {
    expect(caught(() => parseBookMaterialResponse(undefined)).diagnostic).toMatchObject({ kind: "envelope_not_object", receivedType: "undefined" });
    expect(caught(() => parseBookMaterialResponse({ data: [] })).diagnostic).toMatchObject({ kind: "data_not_object", receivedType: "array" });
    expect(caught(() => parseBookMaterialResponse({ data: { list: [7] } })).diagnostic).toMatchObject({ kind: "material_item_not_object", receivedType: "integer" });
  });

  it("an empty list or a bare item still parses", () => {
    expect(parseBookMaterialResponse({ data: { list: [] } }).dataId).toBeNull();
    expect(parseBookMaterialResponse({ data: { dataId: "d1" } }).dataId).toBe("d1");
  });
});

describe("transport: a 2xx body that is not JSON (B-36)", () => {
  const notJson = () => new Response(`<html>${BODY}</html>`, { status: 200 });
  const request = { agencyId: "1", seriesId: "2", projectType: 1, language: "1" } as const;

  it("legacy loop → body_not_json with the HTTP status, nothing from the body", async () => {
    const adapter = createMoboreaderReadAdapter({ fetchImpl: async () => notJson(), sleep: async () => undefined });
    const error = await adapter.fetchPreviewChapters(request, "token").catch((e: unknown) => e) as MoboreaderAdapterError;
    expect(error).toBeInstanceOf(MoboreaderAdapterError);
    expect(error).toMatchObject({ code: "malformed_payload", retryable: false, status: 200, diagnostic: { kind: "body_not_json" } });
    expect(JSON.stringify(error.diagnostic)).not.toContain(BODY);
    expect(error.message).not.toContain(BODY);
  });

  it("rate-limit-aware loop → the same", async () => {
    const adapter = createMoboreaderReadAdapter({
      fetchImpl: async () => notJson(),
      sleep: async () => undefined,
      upstreamRateLimitPolicy: {},
    });
    const error = await adapter.fetchPreviewChapters(request, "token").catch((e: unknown) => e) as MoboreaderAdapterError;
    expect(error).toMatchObject({ code: "malformed_payload", status: 200, diagnostic: { kind: "body_not_json" } });
  });

  it("transport/timeout/HTTP codes carry no diagnostic — their code already says everything", async () => {
    const adapter = createMoboreaderReadAdapter({ fetchImpl: async () => new Response("x", { status: 401 }), sleep: async () => undefined });
    const error = await adapter.fetchPreviewChapters(request, "token").catch((e: unknown) => e) as MoboreaderAdapterError;
    expect(error).toMatchObject({ code: "upstream_http_error", status: 401, diagnostic: null });
  });
});

describe("receivedKindOf", () => {
  it.each([
    [undefined, "undefined"], [null, "null"], ["", "empty_string"], ["  ", "blank_string"], ["x", "string"],
    [3, "integer"], [-1, "negative_integer"], [1.5, "fractional_number"], [Number.NaN, "non_finite_number"],
    [Number.POSITIVE_INFINITY, "non_finite_number"], [2 ** 60, "unsafe_integer"], [true, "boolean"], [[], "array"], [{}, "object"],
    [Symbol("s"), "other"], [10n, "other"],
  ])("%s → %s", (value, expected) => {
    expect(receivedKindOf(value)).toBe(expected);
  });
});
