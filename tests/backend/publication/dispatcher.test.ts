import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { dispatchFirstPublicPublication } from "@/server/publication/dispatcher";

const INPUT = {
  articleId: "article-1",
  novelId: "novel-1",
  locale: "en",
  source: "admin.article.publish",
} as const;

const db = {} as PrismaClient;

describe("dispatchFirstPublicPublication", () => {
  it("no-ops safely when no handlers are supplied (Streams D/E not yet wired)", async () => {
    const result = await dispatchFirstPublicPublication(INPUT, db);
    expect(result).toEqual({ errors: [] });
    expect(result.indexnow).toBeUndefined();
    expect(result.sitemap).toBeUndefined();
  });

  it("invokes only the supplied handler(s)", async () => {
    const enqueueIndexNow = vi.fn().mockResolvedValue({ enqueued: 1 });
    const result = await dispatchFirstPublicPublication(INPUT, db, { enqueueIndexNow });
    expect(enqueueIndexNow).toHaveBeenCalledWith(INPUT, db);
    expect(result.indexnow).toEqual({ enqueued: 1 });
    expect(result.sitemap).toBeUndefined();
    expect(result.errors).toEqual([]);
  });

  it("derives the sitemap refresh reason/triggeredBy from the input", async () => {
    const enqueueSitemapRefresh = vi.fn().mockResolvedValue({ refreshed: true });
    await dispatchFirstPublicPublication(
      { ...INPUT, sourceTaskId: "task-9", eventType: "article_republish" },
      db,
      { enqueueSitemapRefresh },
    );
    expect(enqueueSitemapRefresh).toHaveBeenCalledWith(
      { reason: "article_republish", triggeredBy: "admin.article.publish#task-9" },
      db,
    );
  });

  it("defaults reason to article_first_publish and triggeredBy to source alone without sourceTaskId", async () => {
    const enqueueSitemapRefresh = vi.fn().mockResolvedValue(undefined);
    await dispatchFirstPublicPublication(INPUT, db, { enqueueSitemapRefresh });
    expect(enqueueSitemapRefresh).toHaveBeenCalledWith(
      { reason: "article_first_publish", triggeredBy: "admin.article.publish" },
      db,
    );
  });

  it("isolates an IndexNow handler failure into result.errors without throwing", async () => {
    const enqueueIndexNow = vi.fn().mockRejectedValue(new Error("indexnow down"));
    const result = await dispatchFirstPublicPublication(INPUT, db, { enqueueIndexNow });
    expect(result.errors).toEqual(["indexnow:indexnow down"]);
    expect(result.indexnow).toBeUndefined();
  });

  it("isolates a sitemap handler failure into result.errors without throwing", async () => {
    const enqueueSitemapRefresh = vi.fn().mockRejectedValue(new Error("sitemap down"));
    const result = await dispatchFirstPublicPublication(INPUT, db, { enqueueSitemapRefresh });
    expect(result.errors).toEqual(["sitemap:sitemap down"]);
    expect(result.sitemap).toBeUndefined();
  });

  it("runs both handlers and still reports both errors independently on double failure", async () => {
    const enqueueIndexNow = vi.fn().mockRejectedValue(new Error("a"));
    const enqueueSitemapRefresh = vi.fn().mockRejectedValue(new Error("b"));
    const result = await dispatchFirstPublicPublication(INPUT, db, {
      enqueueIndexNow,
      enqueueSitemapRefresh,
    });
    expect(enqueueIndexNow).toHaveBeenCalled();
    expect(enqueueSitemapRefresh).toHaveBeenCalled();
    expect(result.errors).toEqual(["indexnow:a", "sitemap:b"]);
  });

  it("one handler failing does not prevent the other from succeeding", async () => {
    const enqueueIndexNow = vi.fn().mockRejectedValue(new Error("indexnow down"));
    const enqueueSitemapRefresh = vi.fn().mockResolvedValue({ refreshed: true });
    const result = await dispatchFirstPublicPublication(INPUT, db, {
      enqueueIndexNow,
      enqueueSitemapRefresh,
    });
    expect(result.errors).toEqual(["indexnow:indexnow down"]);
    expect(result.sitemap).toEqual({ refreshed: true });
  });
});
