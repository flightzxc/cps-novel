import { describe, expect, it } from "vitest";

import { parseLaneBPage } from "../../../scripts/p2-06-5-lane-b/upstream-parser.mjs";

describe("P2-06.5 Lane B upstream raw parser", () => {
  it("fails closed when numeric identity facts cannot round-trip exactly", () => {
    const row = {
      id: Number.MAX_SAFE_INTEGER + 1,
      seriesName: "Unsafe identity",
      description: "",
      language: 1,
      languageName: "English",
      seriesTypeList: ["tag"],
    };
    const parse = () => parseLaneBPage({
      payload: { data: { totalCount: 1, list: [row] } },
      pageIndex: 1,
      fetchedAt: "2026-08-13T00:00:00.000Z",
      channelAppId: "app",
    });
    expect(parse).toThrow(/exact id or seriesId/u);
    row.id = 1;
    row.language = Number.MAX_SAFE_INTEGER + 1;
    expect(parse).toThrow(/language numeric value is not exact/u);
  });

  it("retains raw rows/lists and exact token structures without normalizing", () => {
    const payload = { data: { totalCount: 95_479, list: [{
      id: 1,
      seriesName: "Title",
      description: "Description",
      language: 2,
      languageName: " English ",
      seriesTypeList: ["", " Mother", { value: "e\u0301" }, { value: "A", name: "B" }, 7],
      upstreamExtra: { keep: true },
    }] } };
    const parsed = parseLaneBPage({ payload, pageIndex: 7, fetchedAt: "2026-08-13T00:00:00.000Z", channelAppId: "app-1" });
    expect(parsed.totalCount).toBe(95_479);
    expect(parsed.books[0]).toMatchObject({
      externalBookIdRaw: 1,
      titleRaw: "Title",
      sourceLanguageNameRaw: " English ",
      siteLocale: null,
      seriesTypeListRaw: payload.data.list[0].seriesTypeList,
      pageIndex: 7,
      rowIndex: 0,
    });
    expect(parsed.books[0].rawRowUtf8Sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.observations.map(({ exactRawToken }) => exactRawToken)).toEqual(["", " Mother", "e\u0301"]);
    expect(parsed.anomalies).toEqual(expect.arrayContaining([
      expect.objectContaining({ listIndex: 3, reason: "AMBIGUOUS_STRING_CANDIDATES" }),
      expect.objectContaining({ listIndex: 4, reason: "UNSUPPORTED_RAW_TOKEN" }),
    ]));
  });

  it("distinguishes languageName missing from explicit null", () => {
    const base = { id: "book", seriesName: "Book", language: 2, seriesTypeList: [] };
    const missing = parseLaneBPage({ payload: { data: { totalCount: 2, list: [base] } }, pageIndex: 1, fetchedAt: "now", channelAppId: "app" });
    const explicitNull = parseLaneBPage({ payload: { data: { totalCount: 2, list: [{ ...base, languageName: null }] } }, pageIndex: 1, fetchedAt: "now", channelAppId: "app" });
    expect(missing.books[0].rawLanguageScope).not.toBe(explicitNull.books[0].rawLanguageScope);
    expect(missing.books[0].sampleBookKey).not.toBe(explicitNull.books[0].sampleBookKey);
  });

  it("preserves a non-string description as its exact JSON value instead of disguising it as null", () => {
    const description = { blocks: ["raw", 7], nested: { enabled: true } };
    const parsed = parseLaneBPage({
      payload: { data: { totalCount: 1, list: [{
        id: "book",
        seriesName: "Book",
        description,
        language: 2,
        seriesTypeList: ["A"],
      }] } },
      pageIndex: 1,
      fetchedAt: "now",
      channelAppId: "app",
    });
    expect(parsed.books[0]).toMatchObject({
      descriptionPresent: true,
      descriptionRaw: description,
      descriptionJsonValueJson: JSON.stringify(description),
    });
  });
});
