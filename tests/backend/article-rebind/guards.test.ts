import { describe, expect, it } from "vitest";

import { evaluateRebindGuards, type RebindArticleRecord } from "@/server/article-rebind";

import { FakeRebindDb, seedArticle, seedNovel, seedPromoLink } from "./fake-db";

function articleRecord(overrides: Partial<RebindArticleRecord> & { id: string; novelId: string }): RebindArticleRecord {
  return {
    locale: "en",
    status: "draft",
    articleType: "novel_article",
    deletedAt: null,
    ...overrides,
  };
}

/**
 * C-30A (施工工单_C30_换小说_移植CPS换租客_2026-09-08.md §附录 D). One test
 * per guard, plus the 🔴 soft-deleted-still-occupies edge case for guard 8.
 */
describe("evaluateRebindGuards", () => {
  it("guard 1: NOT_NOVEL_ARTICLE — non-novel_article blocks immediately, no further checks run", async () => {
    const db = new FakeRebindDb();
    const target = seedNovel(db, { id: "novel-target" });
    const result = await evaluateRebindGuards(db.asPrismaClient() as never, {
      article: articleRecord({ id: "a1", novelId: "novel-current", articleType: "blog_article" }),
      expectedOldNovelId: "novel-current",
      targetNovelId: target.id,
    });
    expect(result.level).toBe("blocked");
    expect(result.findings).toEqual([{ code: "NOT_NOVEL_ARTICLE", level: "blocked", message: expect.any(String) }]);
    expect(result.targetNovel).toBeNull();
  });

  it("guard 2: REBIND_DRIFT — current novelId no longer matches expectedOldNovelId", async () => {
    const db = new FakeRebindDb();
    const target = seedNovel(db, { id: "novel-target", locale: "en" });
    const result = await evaluateRebindGuards(db.asPrismaClient() as never, {
      article: articleRecord({ id: "a1", novelId: "novel-actual-current", locale: "en" }),
      expectedOldNovelId: "novel-stale-expected",
      targetNovelId: target.id,
    });
    expect(result.findings.map((f) => f.code)).toContain("REBIND_DRIFT");
    expect(result.level).toBe("blocked");
  });

  it("guard 3: TARGET_ALREADY_BOUND — target equals current novel", async () => {
    const db = new FakeRebindDb();
    seedNovel(db, { id: "novel-current", locale: "en" });
    const result = await evaluateRebindGuards(db.asPrismaClient() as never, {
      article: articleRecord({ id: "a1", novelId: "novel-current", locale: "en" }),
      expectedOldNovelId: "novel-current",
      targetNovelId: "novel-current",
    });
    expect(result.findings.map((f) => f.code)).toContain("TARGET_ALREADY_BOUND");
    expect(result.level).toBe("blocked");
  });

  it("guard 4: TARGET_NOT_FOUND — target missing entirely", async () => {
    const db = new FakeRebindDb();
    const result = await evaluateRebindGuards(db.asPrismaClient() as never, {
      article: articleRecord({ id: "a1", novelId: "novel-current" }),
      expectedOldNovelId: "novel-current",
      targetNovelId: "does-not-exist",
    });
    expect(result.level).toBe("blocked");
    expect(result.findings).toEqual([{ code: "TARGET_NOT_FOUND", level: "blocked", message: expect.any(String) }]);
    expect(result.targetNovel).toBeNull();
  });

  it("guard 4: TARGET_NOT_FOUND — target soft-deleted", async () => {
    const db = new FakeRebindDb();
    seedNovel(db, { id: "novel-target", deletedAt: new Date("2026-09-01T00:00:00.000Z") });
    const result = await evaluateRebindGuards(db.asPrismaClient() as never, {
      article: articleRecord({ id: "a1", novelId: "novel-current" }),
      expectedOldNovelId: "novel-current",
      targetNovelId: "novel-target",
    });
    expect(result.findings.map((f) => f.code)).toContain("TARGET_NOT_FOUND");
  });

  it("guard 5: TARGET_LOCALE_MISMATCH — target locale differs from article locale", async () => {
    const db = new FakeRebindDb();
    seedNovel(db, { id: "novel-target", locale: "fr" });
    const result = await evaluateRebindGuards(db.asPrismaClient() as never, {
      article: articleRecord({ id: "a1", novelId: "novel-current", locale: "en" }),
      expectedOldNovelId: "novel-current",
      targetNovelId: "novel-target",
    });
    expect(result.findings.map((f) => f.code)).toContain("TARGET_LOCALE_MISMATCH");
    expect(result.level).toBe("blocked");
  });

  it("guard 6: TARGET_RIGHTS_BLOCKED — target Novel status is takedown", async () => {
    const db = new FakeRebindDb();
    seedNovel(db, { id: "novel-target", locale: "en", status: "takedown" });
    const result = await evaluateRebindGuards(db.asPrismaClient() as never, {
      article: articleRecord({ id: "a1", novelId: "novel-current", locale: "en" }),
      expectedOldNovelId: "novel-current",
      targetNovelId: "novel-target",
    });
    expect(result.findings.map((f) => f.code)).toContain("TARGET_RIGHTS_BLOCKED");
    expect(result.level).toBe("blocked");
  });

  describe("guard 7: TARGET_PROMO_NOT_READY forked by article publish state", () => {
    it("published article + no ready promo link -> blocked", async () => {
      const db = new FakeRebindDb();
      seedNovel(db, { id: "novel-target", locale: "en" });
      const result = await evaluateRebindGuards(db.asPrismaClient() as never, {
        article: articleRecord({ id: "a1", novelId: "novel-current", locale: "en", status: "published" }),
        expectedOldNovelId: "novel-current",
        targetNovelId: "novel-target",
      });
      const finding = result.findings.find((f) => f.code === "TARGET_PROMO_NOT_READY");
      expect(finding?.level).toBe("blocked");
      expect(result.level).toBe("blocked");
    });

    it("draft article + no ready promo link -> needs_ack, not blocked", async () => {
      const db = new FakeRebindDb();
      seedNovel(db, { id: "novel-target", locale: "en" });
      const result = await evaluateRebindGuards(db.asPrismaClient() as never, {
        article: articleRecord({ id: "a1", novelId: "novel-current", locale: "en", status: "draft" }),
        expectedOldNovelId: "novel-current",
        targetNovelId: "novel-target",
      });
      const finding = result.findings.find((f) => f.code === "TARGET_PROMO_NOT_READY");
      expect(finding?.level).toBe("needs_ack");
      expect(result.level).toBe("needs_ack");
      expect(result.resolvedPromoLinkId).toBeNull();
    });

    it("ready promo link present -> guard 7 raises nothing, resolvedPromoLinkId set", async () => {
      const db = new FakeRebindDb();
      seedNovel(db, { id: "novel-target", locale: "en" });
      seedPromoLink(db, { id: "promo-1", novelId: "novel-target" });
      const result = await evaluateRebindGuards(db.asPrismaClient() as never, {
        article: articleRecord({ id: "a1", novelId: "novel-current", locale: "en", status: "published" }),
        expectedOldNovelId: "novel-current",
        targetNovelId: "novel-target",
      });
      expect(result.findings.find((f) => f.code === "TARGET_PROMO_NOT_READY")).toBeUndefined();
      expect(result.resolvedPromoLinkId).toBe("promo-1");
      expect(result.level).toBe("ok");
    });

    it("determinism: fetched+non-blank first by fetchedAt DESC, id ASC — same input picks the same candidate twice", async () => {
      const db = new FakeRebindDb();
      seedNovel(db, { id: "novel-target", locale: "en" });
      seedPromoLink(db, { id: "promo-older", novelId: "novel-target", fetchedAt: new Date("2026-08-01T00:00:00.000Z") });
      seedPromoLink(db, { id: "promo-newer", novelId: "novel-target", fetchedAt: new Date("2026-09-01T00:00:00.000Z") });
      seedPromoLink(db, { id: "promo-blank", novelId: "novel-target", webUrl: "", appUrl: null, fetchedAt: new Date("2026-09-05T00:00:00.000Z") });

      const input = {
        article: articleRecord({ id: "a1", novelId: "novel-current", locale: "en" }),
        expectedOldNovelId: "novel-current",
        targetNovelId: "novel-target",
      };
      const first = await evaluateRebindGuards(db.asPrismaClient() as never, input);
      const second = await evaluateRebindGuards(db.asPrismaClient() as never, input);
      expect(first.resolvedPromoLinkId).toBe("promo-newer");
      expect(second.resolvedPromoLinkId).toBe("promo-newer");
    });
  });

  describe("guard 8: TARGET_LOCALE_OCCUPIED (含软删)", () => {
    it("blocks when target novel already has a published article in the same locale", async () => {
      const db = new FakeRebindDb();
      seedNovel(db, { id: "novel-target", locale: "en" });
      seedArticle(db, { id: "occupying", novelId: "novel-target", locale: "en", status: "published" });
      const result = await evaluateRebindGuards(db.asPrismaClient() as never, {
        article: articleRecord({ id: "a1", novelId: "novel-current", locale: "en" }),
        expectedOldNovelId: "novel-current",
        targetNovelId: "novel-target",
      });
      expect(result.findings.map((f) => f.code)).toContain("TARGET_LOCALE_OCCUPIED");
      expect(result.level).toBe("blocked");
    });

    it("🔴 blocks even when the occupying article is soft-deleted — article_novel_locale_key has no soft-delete exemption", async () => {
      const db = new FakeRebindDb();
      seedNovel(db, { id: "novel-target", locale: "en" });
      seedArticle(db, {
        id: "soft-deleted-occupant",
        novelId: "novel-target",
        locale: "en",
        status: "draft",
        deletedAt: new Date("2026-08-01T00:00:00.000Z"),
      });
      const result = await evaluateRebindGuards(db.asPrismaClient() as never, {
        article: articleRecord({ id: "a1", novelId: "novel-current", locale: "en" }),
        expectedOldNovelId: "novel-current",
        targetNovelId: "novel-target",
      });
      expect(result.findings.map((f) => f.code)).toContain("TARGET_LOCALE_OCCUPIED");
      expect(result.level).toBe("blocked");
    });

    it("does not block on a different locale's article in the target novel", async () => {
      const db = new FakeRebindDb();
      seedNovel(db, { id: "novel-target", locale: "en" });
      seedArticle(db, { id: "other-locale", novelId: "novel-target", locale: "fr", status: "published" });
      const result = await evaluateRebindGuards(db.asPrismaClient() as never, {
        article: articleRecord({ id: "a1", novelId: "novel-current", locale: "en" }),
        expectedOldNovelId: "novel-current",
        targetNovelId: "novel-target",
      });
      expect(result.findings.map((f) => f.code)).not.toContain("TARGET_LOCALE_OCCUPIED");
    });

    it("does not block on the article's own row (id excluded)", async () => {
      const db = new FakeRebindDb();
      seedNovel(db, { id: "novel-target", locale: "en" });
      seedArticle(db, { id: "a1", novelId: "novel-target", locale: "en", status: "published" });
      const result = await evaluateRebindGuards(db.asPrismaClient() as never, {
        article: articleRecord({ id: "a1", novelId: "novel-current", locale: "en" }),
        expectedOldNovelId: "novel-current",
        targetNovelId: "novel-target",
      });
      expect(result.findings.map((f) => f.code)).not.toContain("TARGET_LOCALE_OCCUPIED");
    });
  });

  describe("guard 9: CROSS_LOCALE_SIBLINGS (needs_ack, not blocked)", () => {
    it("raises needs_ack when the CURRENT novel has another published article in a different locale", async () => {
      const db = new FakeRebindDb();
      seedNovel(db, { id: "novel-target", locale: "en" });
      seedPromoLink(db, { id: "promo-1", novelId: "novel-target" });
      seedArticle(db, { id: "sibling", novelId: "novel-current", locale: "fr", status: "published" });
      const result = await evaluateRebindGuards(db.asPrismaClient() as never, {
        article: articleRecord({ id: "a1", novelId: "novel-current", locale: "en" }),
        expectedOldNovelId: "novel-current",
        targetNovelId: "novel-target",
      });
      const finding = result.findings.find((f) => f.code === "CROSS_LOCALE_SIBLINGS");
      expect(finding?.level).toBe("needs_ack");
      expect(result.level).toBe("needs_ack");
    });

    it("does not raise when the sibling in another locale is only draft (not published)", async () => {
      const db = new FakeRebindDb();
      seedNovel(db, { id: "novel-target", locale: "en" });
      seedPromoLink(db, { id: "promo-1", novelId: "novel-target" });
      seedArticle(db, { id: "sibling", novelId: "novel-current", locale: "fr", status: "draft" });
      const result = await evaluateRebindGuards(db.asPrismaClient() as never, {
        article: articleRecord({ id: "a1", novelId: "novel-current", locale: "en" }),
        expectedOldNovelId: "novel-current",
        targetNovelId: "novel-target",
      });
      expect(result.findings.map((f) => f.code)).not.toContain("CROSS_LOCALE_SIBLINGS");
      expect(result.level).toBe("ok");
    });
  });

  it("分档规则: any blocked -> blocked; else any needs_ack -> needs_ack; else ok", async () => {
    const db = new FakeRebindDb();
    seedNovel(db, { id: "novel-target", locale: "en" });
    seedPromoLink(db, { id: "promo-1", novelId: "novel-target" });
    const ok = await evaluateRebindGuards(db.asPrismaClient() as never, {
      article: articleRecord({ id: "a1", novelId: "novel-current", locale: "en", status: "published" }),
      expectedOldNovelId: "novel-current",
      targetNovelId: "novel-target",
    });
    expect(ok.level).toBe("ok");
    expect(ok.findings).toEqual([]);
  });
});
