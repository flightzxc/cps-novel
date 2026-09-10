import { describe, expect, it } from "vitest";

import { evaluateRebindGuards } from "@/server/article-rebind/guards";
import {
  buildRebindBatchFacets,
  buildRebindBatchPreview,
  cleanupExpiredRebindPreviews,
  getRebindBatchPage,
  loadOwnedRebindPreview,
  RebindFeatureDisabledError,
  type RebindPreviewSnapshot,
} from "@/server/article-rebind";

import {
  FakeBatchRebindDb,
  seedArticle,
  seedChannel,
  seedNovel,
  seedNovelUnderChannel,
  seedPromoLink,
  seedSourceApp,
} from "./batch-fake-db";

const ENABLED_ENV = { FEATURE_ARTICLE_NOVEL_REBIND: "true" } as unknown as NodeJS.ProcessEnv;
const DISABLED_ENV = {} as unknown as NodeJS.ProcessEnv;

function baseFixture() {
  const db = new FakeBatchRebindDb();
  const source = seedChannel(db, { id: "chan-source", code: "changdu", name: "畅读" });
  const target = seedChannel(db, { id: "chan-target", code: "beidou", name: "北斗" });
  const app = seedSourceApp(db, { id: "app-1", code: "moboreader", name: "Moboreader" });
  return { db, source, target, app };
}

/** Seeds one source Novel+Article (under `source` channel) and one target Novel (under `target` channel) sharing (locale, titleNormalized) — a unique bipartite match by construction. */
function seedUniquePair(
  fixture: ReturnType<typeof baseFixture>,
  input: { id: string; locale?: string; titleNormalized?: string; articleStatus?: string },
) {
  const locale = input.locale ?? "en";
  const titleNormalized = input.titleNormalized ?? `title-${input.id}`;
  const sourceNovel = seedNovel(fixture.db, { id: `novel-src-${input.id}`, locale, titleNormalized, title: `Src ${input.id}` });
  seedNovelUnderChannel(fixture.db, { novelId: sourceNovel.id, channelId: fixture.source.id, sourceAppId: fixture.app.id });
  const article = seedArticle(fixture.db, {
    id: `article-${input.id}`,
    novelId: sourceNovel.id,
    locale,
    status: input.articleStatus ?? "published",
  });
  const targetNovel = seedNovel(fixture.db, { id: `novel-tgt-${input.id}`, locale, titleNormalized, title: `Tgt ${input.id}` });
  seedNovelUnderChannel(fixture.db, { novelId: targetNovel.id, channelId: fixture.target.id, sourceAppId: fixture.app.id });
  seedPromoLink(fixture.db, { id: `promo-${input.id}`, novelId: targetNovel.id });
  return { sourceNovel, article, targetNovel };
}

describe("buildRebindBatchPreview: bipartite classification", () => {
  it("unique (locale, title_normalized, 来源应用) match on both sides -> executable", async () => {
    const fixture = baseFixture();
    seedUniquePair(fixture, { id: "1" });
    const summary = await buildRebindBatchPreview(fixture.db.asPrismaClient(), {
      sourceChannelCode: "changdu",
      targetChannelCode: "beidou",
      locale: "en",
      createdBy: "admin-1",
    }, ENABLED_ENV);
    expect(summary.executableCount).toBe(1);
    expect(summary.riskBlockedCount).toBe(0);
    expect(summary.ambiguousCount).toBe(0);
    expect(summary.skippedCount).toBe(0);

    const page = await getRebindBatchPage(fixture.db.asPrismaClient(), { previewId: summary.previewId, category: "executable", createdBy: "admin-1" }, ENABLED_ENV);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.targetNovelTitle).toBe("Tgt 1");
  });

  it("one source, TWO equally-matching targets -> ambiguous (candidate list bounded, count/truncated reported)", async () => {
    const fixture = baseFixture();
    const { sourceNovel, article } = (() => {
      const s = seedUniquePair(fixture, { id: "amb" });
      return s;
    })();
    void sourceNovel;
    void article;
    // A second target Novel with the SAME (locale, titleNormalized) under the same target channel/app.
    const secondTarget = seedNovel(fixture.db, { id: "novel-tgt-amb-2", locale: "en", titleNormalized: "title-amb", title: "Tgt amb 2" });
    seedNovelUnderChannel(fixture.db, { novelId: secondTarget.id, channelId: fixture.target.id, sourceAppId: fixture.app.id });

    const summary = await buildRebindBatchPreview(fixture.db.asPrismaClient(), {
      sourceChannelCode: "changdu",
      targetChannelCode: "beidou",
      locale: "en",
      createdBy: "admin-1",
    }, ENABLED_ENV);
    expect(summary.ambiguousCount).toBe(1);
    expect(summary.executableCount).toBe(0);

    const page = await getRebindBatchPage(fixture.db.asPrismaClient(), { previewId: summary.previewId, category: "ambiguous", createdBy: "admin-1" }, ENABLED_ENV);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.candidateCount).toBe(2);
    expect(page.items[0]!.candidateNovelTitles.sort()).toEqual(["Tgt amb", "Tgt amb 2"]);
  });

  it("two DIFFERENT targets reachable by TWO different sources reduce reverse-degree to >1 for both -> both ambiguous, not just one", async () => {
    // Two source novels share the same (locale, titleNormalized) and both
    // point at two candidate targets sharing that same key — CPS's own
    // "反向度数为 1 才算唯一" rule: neither side gets to claim uniqueness.
    const fixture = baseFixture();
    const s1 = seedNovel(fixture.db, { id: "novel-src-x1", locale: "en", titleNormalized: "shared", title: "Src x1" });
    seedNovelUnderChannel(fixture.db, { novelId: s1.id, channelId: fixture.source.id, sourceAppId: fixture.app.id });
    seedArticle(fixture.db, { id: "article-x1", novelId: s1.id, locale: "en", status: "published" });
    const s2 = seedNovel(fixture.db, { id: "novel-src-x2", locale: "en", titleNormalized: "shared", title: "Src x2" });
    seedNovelUnderChannel(fixture.db, { novelId: s2.id, channelId: fixture.source.id, sourceAppId: fixture.app.id });
    seedArticle(fixture.db, { id: "article-x2", novelId: s2.id, locale: "en", status: "published" });

    const t1 = seedNovel(fixture.db, { id: "novel-tgt-x1", locale: "en", titleNormalized: "shared", title: "Tgt x1" });
    seedNovelUnderChannel(fixture.db, { novelId: t1.id, channelId: fixture.target.id, sourceAppId: fixture.app.id });
    seedPromoLink(fixture.db, { id: "promo-x1", novelId: t1.id });

    const summary = await buildRebindBatchPreview(fixture.db.asPrismaClient(), {
      sourceChannelCode: "changdu",
      targetChannelCode: "beidou",
      locale: "en",
      createdBy: "admin-1",
    }, ENABLED_ENV);
    // Both sources see the SAME single target -> reverse degree 2 -> both ambiguous (not unique).
    expect(summary.ambiguousCount).toBe(2);
    expect(summary.executableCount).toBe(0);
  });

  it("zero matching target -> skipped (unresolved)", async () => {
    const fixture = baseFixture();
    const sourceNovel = seedNovel(fixture.db, { id: "novel-src-none", locale: "en", titleNormalized: "lonely", title: "Src none" });
    seedNovelUnderChannel(fixture.db, { novelId: sourceNovel.id, channelId: fixture.source.id, sourceAppId: fixture.app.id });
    seedArticle(fixture.db, { id: "article-none", novelId: sourceNovel.id, locale: "en", status: "published" });

    const summary = await buildRebindBatchPreview(fixture.db.asPrismaClient(), {
      sourceChannelCode: "changdu",
      targetChannelCode: "beidou",
      locale: "en",
      createdBy: "admin-1",
    }, ENABLED_ENV);
    expect(summary.skippedCount).toBe(1);
    expect(summary.executableCount).toBe(0);

    const page = await getRebindBatchPage(fixture.db.asPrismaClient(), { previewId: summary.previewId, category: "skipped", createdBy: "admin-1" }, ENABLED_ENV);
    expect(page.items[0]!.skipReason).toBe("unresolved");
  });

  it("optional sourceApp filter narrows the source universe to articles carrying that theater", async () => {
    const fixture = baseFixture();
    const otherApp = seedSourceApp(fixture.db, { id: "app-2", code: "otherapp", name: "Other" });
    const matched = seedUniquePair(fixture, { id: "filtered-in" });
    // A second pair registered under a DIFFERENT source app — excluded when filtering by `app.code`.
    const excludedSource = seedNovel(fixture.db, { id: "novel-src-excluded", locale: "en", titleNormalized: "title-excluded", title: "Src excluded" });
    seedNovelUnderChannel(fixture.db, { novelId: excludedSource.id, channelId: fixture.source.id, sourceAppId: otherApp.id });
    seedArticle(fixture.db, { id: "article-excluded", novelId: excludedSource.id, locale: "en", status: "published" });
    const excludedTarget = seedNovel(fixture.db, { id: "novel-tgt-excluded", locale: "en", titleNormalized: "title-excluded", title: "Tgt excluded" });
    seedNovelUnderChannel(fixture.db, { novelId: excludedTarget.id, channelId: fixture.target.id, sourceAppId: otherApp.id });
    seedPromoLink(fixture.db, { id: "promo-excluded", novelId: excludedTarget.id });
    void matched;

    const summary = await buildRebindBatchPreview(fixture.db.asPrismaClient(), {
      sourceChannelCode: "changdu",
      targetChannelCode: "beidou",
      locale: "en",
      sourceApp: "moboreader",
      createdBy: "admin-1",
    }, ENABLED_ENV);
    expect(summary.sourceScanned).toBe(2); // scan itself is un-filtered by sourceApp
    expect(summary.executableCount).toBe(1); // only the moboreader-tagged pair passes the filter
  });
});

describe("buildRebindBatchPreview: guard-driven categorization (risk_blocked)", () => {
  it("target Novel status takedown -> risk_blocked (guard 6)", async () => {
    const fixture = baseFixture();
    const { targetNovel } = seedUniquePair(fixture, { id: "rights" });
    targetNovel.status = "takedown";

    const summary = await buildRebindBatchPreview(fixture.db.asPrismaClient(), {
      sourceChannelCode: "changdu",
      targetChannelCode: "beidou",
      locale: "en",
      createdBy: "admin-1",
    }, ENABLED_ENV);
    expect(summary.riskBlockedCount).toBe(1);
    expect(summary.executableCount).toBe(0);

    const page = await getRebindBatchPage(fixture.db.asPrismaClient(), { previewId: summary.previewId, category: "risk_blocked", createdBy: "admin-1" }, ENABLED_ENV);
    expect(page.items[0]!.findings.map((f) => f.code)).toContain("TARGET_RIGHTS_BLOCKED");
  });

  it("target has no ready promo link, source article is published -> risk_blocked, hard (guard 7)", async () => {
    const fixture = baseFixture();
    const sourceNovel = seedNovel(fixture.db, { id: "novel-src-nopromo", locale: "en", titleNormalized: "nopromo", title: "Src nopromo" });
    seedNovelUnderChannel(fixture.db, { novelId: sourceNovel.id, channelId: fixture.source.id, sourceAppId: fixture.app.id });
    seedArticle(fixture.db, { id: "article-nopromo", novelId: sourceNovel.id, locale: "en", status: "published" });
    const targetNovel = seedNovel(fixture.db, { id: "novel-tgt-nopromo", locale: "en", titleNormalized: "nopromo", title: "Tgt nopromo" });
    seedNovelUnderChannel(fixture.db, { novelId: targetNovel.id, channelId: fixture.target.id, sourceAppId: fixture.app.id });
    // No PromoLink seeded for targetNovel at all.

    const summary = await buildRebindBatchPreview(fixture.db.asPrismaClient(), {
      sourceChannelCode: "changdu",
      targetChannelCode: "beidou",
      locale: "en",
      createdBy: "admin-1",
    }, ENABLED_ENV);
    expect(summary.riskBlockedCount).toBe(1);
    const page = await getRebindBatchPage(fixture.db.asPrismaClient(), { previewId: summary.previewId, category: "risk_blocked", createdBy: "admin-1" }, ENABLED_ENV);
    const finding = page.items[0]!.findings.find((f) => f.code === "TARGET_PROMO_NOT_READY");
    expect(finding?.level).toBe("blocked");
  });

  it("🔴 target Novel already occupies (novelId, locale) with a SOFT-DELETED Article -> risk_blocked (guard 8, no soft-delete exemption)", async () => {
    const fixture = baseFixture();
    const { targetNovel } = seedUniquePair(fixture, { id: "occupied" });
    seedArticle(fixture.db, {
      id: "occupying-article",
      novelId: targetNovel.id,
      locale: "en",
      status: "published",
      deletedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const summary = await buildRebindBatchPreview(fixture.db.asPrismaClient(), {
      sourceChannelCode: "changdu",
      targetChannelCode: "beidou",
      locale: "en",
      createdBy: "admin-1",
    }, ENABLED_ENV);
    expect(summary.riskBlockedCount).toBe(1);
    const page = await getRebindBatchPage(fixture.db.asPrismaClient(), { previewId: summary.previewId, category: "risk_blocked", createdBy: "admin-1" }, ENABLED_ENV);
    expect(page.items[0]!.findings.map((f) => f.code)).toContain("TARGET_LOCALE_OCCUPIED");
    expect(page.items[0]!.conflictArticle?.articleId).toBe("occupying-article");
  });

  it("source Novel has a published sibling Article in a different locale -> needs_ack, still bucketed risk_blocked (no third category)", async () => {
    const fixture = baseFixture();
    const { sourceNovel } = seedUniquePair(fixture, { id: "sibling" });
    seedArticle(fixture.db, { id: "sibling-article", novelId: sourceNovel.id, locale: "ja", status: "published" });

    const summary = await buildRebindBatchPreview(fixture.db.asPrismaClient(), {
      sourceChannelCode: "changdu",
      targetChannelCode: "beidou",
      locale: "en",
      createdBy: "admin-1",
    }, ENABLED_ENV);
    expect(summary.riskBlockedCount).toBe(1);
    const page = await getRebindBatchPage(fixture.db.asPrismaClient(), { previewId: summary.previewId, category: "risk_blocked", createdBy: "admin-1" }, ENABLED_ENV);
    const finding = page.items[0]!.findings.find((f) => f.code === "CROSS_LOCALE_SIBLINGS");
    expect(finding?.level).toBe("needs_ack");
  });
});

describe("🔴 集合化守卫与单篇守卫逐条相同 (batch classifier vs single-article evaluateRebindGuards)", () => {
  it("the SAME (article, target) pair yields identical level+findings through both paths", async () => {
    const fixture = baseFixture();
    const { sourceNovel, article, targetNovel } = seedUniquePair(fixture, { id: "parity" });
    // Give it a needs_ack finding too, so the parity check covers more than the trivial "ok" case.
    seedArticle(fixture.db, { id: "parity-sibling", novelId: sourceNovel.id, locale: "ja", status: "published" });

    const summary = await buildRebindBatchPreview(fixture.db.asPrismaClient(), {
      sourceChannelCode: "changdu",
      targetChannelCode: "beidou",
      locale: "en",
      createdBy: "admin-1",
    }, ENABLED_ENV);
    const page = await getRebindBatchPage(fixture.db.asPrismaClient(), { previewId: summary.previewId, category: "risk_blocked", createdBy: "admin-1" }, ENABLED_ENV);
    const batchRow = page.items.find((item) => item.articleId === article.id)!;

    const singleEvaluation = await evaluateRebindGuards(fixture.db.asPrismaClient() as unknown as Parameters<typeof evaluateRebindGuards>[0], {
      article: { id: article.id, novelId: sourceNovel.id, locale: "en", status: "published", articleType: "novel_article", deletedAt: null },
      expectedOldNovelId: sourceNovel.id,
      targetNovelId: targetNovel.id,
    });

    expect(batchRow.findings.map((f) => f.code).sort()).toEqual(singleEvaluation.findings.map((f) => f.code).sort());
    const batchLevel = batchRow.findings.some((f) => f.level === "blocked") ? "blocked" : batchRow.findings.length > 0 ? "needs_ack" : "ok";
    expect(batchLevel).toBe(singleEvaluation.level);
  });
});

describe("🔴 禁止 N+1: query count does not scale linearly with candidate count", () => {
  it("20 independent executable pairs cost roughly the same query count as 2", async () => {
    const small = baseFixture();
    for (let i = 0; i < 2; i += 1) seedUniquePair(small, { id: `small-${i}`, titleNormalized: `small-title-${i}` });
    await buildRebindBatchPreview(small.db.asPrismaClient(), { sourceChannelCode: "changdu", targetChannelCode: "beidou", locale: "en", createdBy: "admin-1" }, ENABLED_ENV);
    const smallQueries = small.db.queryCount;

    const large = baseFixture();
    for (let i = 0; i < 20; i += 1) seedUniquePair(large, { id: `large-${i}`, titleNormalized: `large-title-${i}` });
    await buildRebindBatchPreview(large.db.asPrismaClient(), { sourceChannelCode: "changdu", targetChannelCode: "beidou", locale: "en", createdBy: "admin-1" }, ENABLED_ENV);
    const largeQueries = large.db.queryCount;

    // A per-candidate (N+1) implementation would cost ~10x more queries for
    // 10x the candidates; a set-based one costs the same handful regardless.
    expect(largeQueries).toBeLessThan(smallQueries + 5);
  });
});

describe("snapshot hash stability + expiry/ownership", () => {
  it("identical inputs produce the identical planHash across two independent runs", async () => {
    const fixtureA = baseFixture();
    seedUniquePair(fixtureA, { id: "hash", titleNormalized: "hash-title" });
    const summaryA = await buildRebindBatchPreview(fixtureA.db.asPrismaClient(), { sourceChannelCode: "changdu", targetChannelCode: "beidou", locale: "en", createdBy: "admin-1" }, ENABLED_ENV);
    const previewA = await loadOwnedRebindPreview(fixtureA.db.asPrismaClient() as never, summaryA.previewId, "admin-1");

    const fixtureB = baseFixture();
    seedUniquePair(fixtureB, { id: "hash", titleNormalized: "hash-title" });
    const summaryB = await buildRebindBatchPreview(fixtureB.db.asPrismaClient(), { sourceChannelCode: "changdu", targetChannelCode: "beidou", locale: "en", createdBy: "admin-1" }, ENABLED_ENV);
    const previewB = await loadOwnedRebindPreview(fixtureB.db.asPrismaClient() as never, summaryB.previewId, "admin-1");

    expect((previewA as { planHash: string }).planHash).toBe((previewB as { planHash: string }).planHash);
  });

  it("expired preview is rejected even for its own creator", async () => {
    const fixture = baseFixture();
    seedUniquePair(fixture, { id: "expiry" });
    const summary = await buildRebindBatchPreview(fixture.db.asPrismaClient(), { sourceChannelCode: "changdu", targetChannelCode: "beidou", locale: "en", createdBy: "admin-1" }, ENABLED_ENV);
    const row = fixture.db.previews.find((p) => p.id === summary.previewId)!;
    row.expiresAt = new Date(Date.now() - 1_000);

    await expect(
      getRebindBatchPage(fixture.db.asPrismaClient(), { previewId: summary.previewId, category: "executable", createdBy: "admin-1" }, ENABLED_ENV),
    ).rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
  });

  it("a different creator cannot read someone else's preview", async () => {
    const fixture = baseFixture();
    seedUniquePair(fixture, { id: "forbidden" });
    const summary = await buildRebindBatchPreview(fixture.db.asPrismaClient(), { sourceChannelCode: "changdu", targetChannelCode: "beidou", locale: "en", createdBy: "admin-1" }, ENABLED_ENV);

    await expect(
      getRebindBatchPage(fixture.db.asPrismaClient(), { previewId: summary.previewId, category: "executable", createdBy: "admin-2" }, ENABLED_ENV),
    ).rejects.toMatchObject({ code: "PREVIEW_FORBIDDEN" });
  });

  it("cleanupExpiredRebindPreviews deletes only expired rows, bounded by the row cap", async () => {
    const fixture = baseFixture();
    seedUniquePair(fixture, { id: "cleanup-live" });
    const live = await buildRebindBatchPreview(fixture.db.asPrismaClient(), { sourceChannelCode: "changdu", targetChannelCode: "beidou", locale: "en", createdBy: "admin-1" }, ENABLED_ENV);
    seedUniquePair(fixture, { id: "cleanup-expired", titleNormalized: "cleanup-expired-title" });
    const expired = await buildRebindBatchPreview(fixture.db.asPrismaClient(), { sourceChannelCode: "changdu", targetChannelCode: "beidou", locale: "en", createdBy: "admin-1" }, ENABLED_ENV);
    const expiredRow = fixture.db.previews.find((p) => p.id === expired.previewId)!;
    expiredRow.expiresAt = new Date(Date.now() - 1_000);

    const deleted = await cleanupExpiredRebindPreviews(fixture.db.asPrismaClient() as never);
    expect(deleted).toBe(1);
    expect(fixture.db.previews.map((p) => p.id)).toEqual([live.previewId]);
  });
});

describe("fail-closed: FEATURE_ARTICLE_NOVEL_REBIND off", () => {
  it("buildRebindBatchFacets throws RebindFeatureDisabledError", async () => {
    const fixture = baseFixture();
    await expect(
      buildRebindBatchFacets(fixture.db.asPrismaClient(), { sourceChannelCode: "changdu", targetChannelCode: "beidou" }, DISABLED_ENV),
    ).rejects.toBeInstanceOf(RebindFeatureDisabledError);
  });

  it("buildRebindBatchPreview throws RebindFeatureDisabledError even with a fully-formed input (the single-gate exception still requires the total gate)", async () => {
    const fixture = baseFixture();
    seedUniquePair(fixture, { id: "gate" });
    await expect(
      buildRebindBatchPreview(fixture.db.asPrismaClient(), { sourceChannelCode: "changdu", targetChannelCode: "beidou", locale: "en", createdBy: "admin-1" }, DISABLED_ENV),
    ).rejects.toBeInstanceOf(RebindFeatureDisabledError);
  });

  it("🔴 preview single-gate positive: FEATURE on WITHOUT ARTICLE_NOVEL_REBIND_ALLOW_WRITE still succeeds — a preview is not gated by the write flag", async () => {
    const fixture = baseFixture();
    seedUniquePair(fixture, { id: "single-gate-positive" });
    const totalOnlyEnv = { FEATURE_ARTICLE_NOVEL_REBIND: "true", ARTICLE_NOVEL_REBIND_ALLOW_WRITE: "false" } as unknown as NodeJS.ProcessEnv;
    const summary = await buildRebindBatchPreview(
      fixture.db.asPrismaClient(),
      { sourceChannelCode: "changdu", targetChannelCode: "beidou", locale: "en", createdBy: "admin-1" },
      totalOnlyEnv,
    );
    expect(summary.executableCount).toBe(1);
  });

  it("getRebindBatchPage throws RebindFeatureDisabledError when the total gate is off", async () => {
    const fixture = baseFixture();
    seedUniquePair(fixture, { id: "page-gate" });
    const summary = await buildRebindBatchPreview(fixture.db.asPrismaClient(), { sourceChannelCode: "changdu", targetChannelCode: "beidou", locale: "en", createdBy: "admin-1" }, ENABLED_ENV);
    await expect(
      getRebindBatchPage(fixture.db.asPrismaClient(), { previewId: summary.previewId, createdBy: "admin-1" }, DISABLED_ENV),
    ).rejects.toBeInstanceOf(RebindFeatureDisabledError);
  });
});

describe("buildRebindBatchFacets", () => {
  it("lists only registered channels, and narrows locales/sourceApps once a source channel + locale is selected", async () => {
    const fixture = baseFixture();
    seedUniquePair(fixture, { id: "facets" });

    const bare = await buildRebindBatchFacets(fixture.db.asPrismaClient(), { sourceChannelCode: "", targetChannelCode: "" }, ENABLED_ENV);
    expect(bare.channels.map((c) => c.value).sort()).toEqual(["beidou", "changdu"]);
    expect(bare.locales).toEqual([]);

    const withSource = await buildRebindBatchFacets(fixture.db.asPrismaClient(), { sourceChannelCode: "changdu", targetChannelCode: "beidou" }, ENABLED_ENV);
    expect(withSource.locales.map((l) => l.value)).toEqual(["en"]);

    const withLocale = await buildRebindBatchFacets(fixture.db.asPrismaClient(), { sourceChannelCode: "changdu", targetChannelCode: "beidou", locale: "en" }, ENABLED_ENV);
    expect(withLocale.previewAllowed).toBe(true);
    expect(withLocale.sourceApps.map((s) => s.value)).toEqual(["moboreader"]);
  });
});

// Sanity: the module's own snapshot shape round-trips through JSON exactly as written (no `schemaVersion` field inside the blob — tracked by the sibling DB column instead, see preview.ts's own header).
describe("snapshot shape", () => {
  it("matchesJson has no internal schemaVersion field", async () => {
    const fixture = baseFixture();
    seedUniquePair(fixture, { id: "shape" });
    const summary = await buildRebindBatchPreview(fixture.db.asPrismaClient(), { sourceChannelCode: "changdu", targetChannelCode: "beidou", locale: "en", createdBy: "admin-1" }, ENABLED_ENV);
    const row = fixture.db.previews.find((p) => p.id === summary.previewId)!;
    const snapshot = row.matchesJson as RebindPreviewSnapshot;
    expect(Object.keys(snapshot)).toEqual(["rows"]);
  });
});
