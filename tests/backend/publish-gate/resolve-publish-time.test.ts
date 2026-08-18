import { describe, expect, it } from "vitest";

import { resolveArticlePublishTimeForWrite } from "@/server/publish-gate/resolve-publish-time";

const NOW = new Date("2026-08-18T10:00:00.000Z");

describe("resolveArticlePublishTimeForWrite (CPS article-publish-time.ts port)", () => {
  it("defaults to now when publishing with no explicit or existing time", () => {
    const result = resolveArticlePublishTimeForWrite({ status: "published", now: NOW });
    expect(result).toEqual(NOW);
  });

  it("prefers an explicitly submitted time over now, when publishing", () => {
    const submitted = new Date("2026-08-01T00:00:00.000Z");
    const result = resolveArticlePublishTimeForWrite({
      status: "published",
      submittedPublishTime: submitted,
      now: NOW,
    });
    expect(result).toEqual(submitted);
  });

  it("preserves an existing time (sticky publishedAt across re-saves) when publishing again", () => {
    const existing = new Date("2026-01-01T00:00:00.000Z");
    const result = resolveArticlePublishTimeForWrite({
      status: "published",
      existingPublishTime: existing,
      now: NOW,
    });
    expect(result).toEqual(existing);
  });

  it("submitted time takes precedence over an existing stored time", () => {
    const submitted = new Date("2026-08-01T00:00:00.000Z");
    const existing = new Date("2026-01-01T00:00:00.000Z");
    const result = resolveArticlePublishTimeForWrite({
      status: "published",
      submittedPublishTime: submitted,
      existingPublishTime: existing,
      now: NOW,
    });
    expect(result).toEqual(submitted);
  });

  it("accepts string dates for submitted/existing time, same as CPS", () => {
    const result = resolveArticlePublishTimeForWrite({
      status: "published",
      submittedPublishTime: "2026-08-01T00:00:00.000Z",
      now: NOW,
    });
    expect(result).toEqual(new Date("2026-08-01T00:00:00.000Z"));
  });

  it("does not default to now when status is not published", () => {
    expect(resolveArticlePublishTimeForWrite({ status: "draft", now: NOW })).toBeNull();
    expect(resolveArticlePublishTimeForWrite({ status: "unpublished", now: NOW })).toBeNull();
    expect(resolveArticlePublishTimeForWrite({ status: null, now: NOW })).toBeNull();
  });

  it("treats an empty string / falsy explicit values as absent, same as CPS's toDate", () => {
    const existing = new Date("2026-01-01T00:00:00.000Z");
    const result = resolveArticlePublishTimeForWrite({
      status: "published",
      submittedPublishTime: null,
      existingPublishTime: existing,
      now: NOW,
    });
    expect(result).toEqual(existing);
  });

  it("uses new Date() as the implicit default for now when omitted", () => {
    const before = Date.now();
    const result = resolveArticlePublishTimeForWrite({ status: "published" });
    const after = Date.now();
    expect(result).not.toBeNull();
    expect(result!.getTime()).toBeGreaterThanOrEqual(before);
    expect(result!.getTime()).toBeLessThanOrEqual(after);
  });
});
