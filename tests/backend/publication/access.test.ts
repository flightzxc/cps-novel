import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { checkNovelArticlePublicAccess } from "@/server/publication/access";

function dbReturning(article: unknown): PrismaClient {
  return { article: { findFirst: vi.fn().mockResolvedValue(article) } } as unknown as PrismaClient;
}

function row(overrides: {
  articleStatus?: string;
  novelStatus?: string;
  promoLink?: { status: string; webUrl: string | null; appUrl: string | null } | null;
}) {
  return {
    id: "article-1",
    novelId: "novel-1",
    status: overrides.articleStatus ?? "published",
    novel: { status: overrides.novelStatus ?? "published" },
    promoLink:
      "promoLink" in overrides
        ? overrides.promoLink
        : { status: "fetched", webUrl: "https://a", appUrl: null },
  };
}

describe("checkNovelArticlePublicAccess", () => {
  it("returns not_found when no matching row exists", async () => {
    const db = dbReturning(null);
    const result = await checkNovelArticlePublicAccess(db, { locale: "en", slug: "missing" });
    expect(result).toEqual({ kind: "not_found" });
  });

  it("queries by locale and slug via the primary (non-deleted) where fragment", async () => {
    const db = dbReturning(null);
    await checkNovelArticlePublicAccess(db, { locale: "en", slug: "some-slug" });
    const call = (db.article.findFirst as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where).toEqual({
      AND: [{ deletedAt: null }, { locale: "en", slug: "some-slug" }],
    });
  });

  it("returns published for a fully public article with a ready promo link", async () => {
    const db = dbReturning(row({}));
    const result = await checkNovelArticlePublicAccess(db, { locale: "en", slug: "x" });
    expect(result).toEqual({ kind: "published", articleId: "article-1", novelId: "novel-1" });
  });

  it("returns takedown when the article itself is takedown", async () => {
    const db = dbReturning(row({ articleStatus: "takedown" }));
    const result = await checkNovelArticlePublicAccess(db, { locale: "en", slug: "x" });
    expect(result).toEqual({ kind: "takedown" });
  });

  it("returns takedown when the novel is takedown, even if the article claims published", async () => {
    const db = dbReturning(row({ novelStatus: "takedown" }));
    const result = await checkNovelArticlePublicAccess(db, { locale: "en", slug: "x" });
    expect(result).toEqual({ kind: "takedown" });
  });

  it("takedown wins over unpublished when both are set", async () => {
    const db = dbReturning(row({ novelStatus: "takedown", articleStatus: "unpublished" }));
    const result = await checkNovelArticlePublicAccess(db, { locale: "en", slug: "x" });
    expect(result).toEqual({ kind: "takedown" });
  });

  it("returns unavailable when the article is unpublished", async () => {
    const db = dbReturning(row({ articleStatus: "unpublished" }));
    const result = await checkNovelArticlePublicAccess(db, { locale: "en", slug: "x" });
    expect(result).toEqual({ kind: "unavailable" });
  });

  it("returns unavailable when the novel is unpublished", async () => {
    const db = dbReturning(row({ novelStatus: "unpublished" }));
    const result = await checkNovelArticlePublicAccess(db, { locale: "en", slug: "x" });
    expect(result).toEqual({ kind: "unavailable" });
  });

  it("returns unavailable (not not_found) when both sides are published but the promo link is null", async () => {
    const db = dbReturning(row({ promoLink: null }));
    const result = await checkNovelArticlePublicAccess(db, { locale: "en", slug: "x" });
    expect(result).toEqual({ kind: "unavailable" });
  });

  it("returns unavailable when both sides are published but the promo link is not fetched", async () => {
    const db = dbReturning(row({ promoLink: { status: "failed", webUrl: null, appUrl: null } }));
    const result = await checkNovelArticlePublicAccess(db, { locale: "en", slug: "x" });
    expect(result).toEqual({ kind: "unavailable" });
  });

  it("returns unavailable when both sides are published but promo URLs are blank whitespace", async () => {
    const db = dbReturning(
      row({ promoLink: { status: "fetched", webUrl: "   ", appUrl: "\t" } }),
    );
    const result = await checkNovelArticlePublicAccess(db, { locale: "en", slug: "x" });
    expect(result).toEqual({ kind: "unavailable" });
  });

  it("returns not_found when the article is draft", async () => {
    const db = dbReturning(row({ articleStatus: "draft" }));
    const result = await checkNovelArticlePublicAccess(db, { locale: "en", slug: "x" });
    expect(result).toEqual({ kind: "not_found" });
  });

  it("returns not_found when the novel is only ready (internal readiness, not public)", async () => {
    const db = dbReturning(row({ novelStatus: "ready" }));
    const result = await checkNovelArticlePublicAccess(db, { locale: "en", slug: "x" });
    expect(result).toEqual({ kind: "not_found" });
  });
});
