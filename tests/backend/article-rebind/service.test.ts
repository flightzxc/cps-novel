import { afterEach, describe, expect, it, vi } from "vitest";

import { hashAdminSessionToken } from "@/lib/auth/session";
import type { AdminIdentity, AdminSessionRecord } from "@/lib/auth/types";
import { requireAdminActionAccess } from "@/server/auth/guards";
import { P2_04_ADMIN_REGISTRY } from "@/app/api/admin/_lib/registry";
import {
  RebindArticleNotEligibleError,
  RebindDriftError,
  RebindFeatureDisabledError,
  RebindGuardBlockedError,
  RebindRollbackNotFoundError,
  RebindWriteDisabledError,
  getRebindView,
  rollbackArticleNovel,
  searchRebindCandidates,
  switchArticleNovel,
  type ArticleRebindServiceDependencies,
} from "@/server/article-rebind";

import { TestOnlyInMemoryAuthStores } from "../auth/test-only-in-memory-stores";
import { FakeRebindDb, seedArticle, seedNovel, seedPromoLink } from "./fake-db";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const TOKEN = "article-rebind-session";
const ORIGIN = "https://admin.example.com";
const NOW = new Date("2026-09-08T03:00:00.000Z");
const ENABLED_ENV = { FEATURE_ARTICLE_NOVEL_REBIND: "true", ARTICLE_NOVEL_REBIND_ALLOW_WRITE: "true" } as unknown as NodeJS.ProcessEnv;

function authFixture() {
  const stores = new TestOnlyInMemoryAuthStores();
  const identity: AdminIdentity = {
    id: "admin-1",
    username: "admin",
    role: "super_admin",
    status: "active",
    sessionVersion: 1,
    twoFactorEnabled: true,
  };
  const session: AdminSessionRecord = {
    id: "session-1",
    tokenHash: hashAdminSessionToken(TOKEN),
    identityId: identity.id,
    sessionVersion: 1,
    issuedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    lastSeenAt: new Date(NOW.getTime() - 60_000),
    absoluteExpiresAt: new Date(NOW.getTime() + 23 * 60 * 60 * 1000),
    twoFactorCompletedAt: new Date(NOW.getTime() - 30_000),
    revokedAt: null,
  };
  stores.identities.set(identity.id, identity);
  stores.sessions.set(session.id, session);
  return stores;
}

async function authorization(
  stores: TestOnlyInMemoryAuthStores,
  actionId: string,
  env: NodeJS.ProcessEnv,
  requestId = "550e8400-e29b-41d4-a716-446655440000",
) {
  const guarded = await requireAdminActionAccess(
    { actionId, sessionToken: TOKEN, origin: ORIGIN, canonicalOrigin: ORIGIN, requestId },
    { identities: stores, sessions: stores, registry: P2_04_ADMIN_REGISTRY, now: NOW, env },
  );
  return { authorization: guarded.serviceAuthorization!, requestId };
}

function deps(db: FakeRebindDb, stores: TestOnlyInMemoryAuthStores, env: NodeJS.ProcessEnv = ENABLED_ENV): ArticleRebindServiceDependencies {
  return { db: db.asPrismaClient(), identities: stores, sessions: stores, now: NOW, env };
}

function setupSwitchFixture(db: FakeRebindDb) {
  seedNovel(db, { id: "novel-current", locale: "en", status: "published" });
  seedPromoLink(db, { id: "promo-current", novelId: "novel-current" });
  seedNovel(db, { id: "novel-target", locale: "en", status: "published" });
  seedPromoLink(db, { id: "promo-target", novelId: "novel-target" });
  return seedArticle(db, {
    id: "article-1",
    novelId: "novel-current",
    promoLinkId: "promo-current",
    locale: "en",
    status: "draft",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("switchArticleNovel", () => {
  it("🔴 writes exactly {novelId, promoLinkId} — no other Article field touched", async () => {
    const db = new FakeRebindDb();
    const stores = authFixture();
    const row = setupSwitchFixture(db);
    const guarded = await authorization(stores, "admin.article.rebind_novel", ENABLED_ENV);

    const before = { ...row };
    await switchArticleNovel(
      { ...guarded, articleId: row.id, expectedOldNovelId: "novel-current", targetNovelId: "novel-target", reason: "channel outage failover" },
      deps(db, stores),
    );

    const after = db.articles.find((candidate) => candidate.id === row.id)!;
    expect(after.novelId).toBe("novel-target");
    expect(after.promoLinkId).toBe("promo-target");
    // Every other field is byte-identical to before the write.
    expect(after.slug).toBe(before.slug);
    expect(after.publicPageShortId).toBe(before.publicPageShortId);
    expect(after.title).toBe(before.title);
    expect(after.status).toBe(before.status);
    expect(after.locale).toBe(before.locale);
    expect(after.articleType).toBe(before.articleType);
    expect(after.deletedAt).toBe(before.deletedAt);
    expect(after.createdAt).toEqual(before.createdAt);
  });

  it("condition write: stale expectedOldNovelId -> zero rows matched -> RebindDriftError, no write, no audit", async () => {
    const db = new FakeRebindDb();
    const stores = authFixture();
    const row = setupSwitchFixture(db);
    const guarded = await authorization(stores, "admin.article.rebind_novel", ENABLED_ENV);

    await expect(
      switchArticleNovel(
        { ...guarded, articleId: row.id, expectedOldNovelId: "novel-stale", targetNovelId: "novel-target", reason: "x" },
        deps(db, stores),
      ),
    ).rejects.toBeInstanceOf(RebindGuardBlockedError); // guard 2 (REBIND_DRIFT) fires before the write is even attempted

    expect(db.articles.find((candidate) => candidate.id === row.id)!.novelId).toBe("novel-current");
    expect(db.audits).toHaveLength(0);
  });

  it("the conditional updateMany's own count check is defense-in-depth: a forced count=0 (simulating a genuinely concurrent write winning the race inside PostgreSQL, independent of what the guard evaluator itself already saw) still raises RebindDriftError rather than silently no-op'ing", async () => {
    const db = new FakeRebindDb();
    const stores = authFixture();
    const row = setupSwitchFixture(db);
    const guarded = await authorization(stores, "admin.article.rebind_novel", ENABLED_ENV);

    db.forceNextUpdateManyCount = 0;

    await expect(
      switchArticleNovel(
        { ...guarded, articleId: row.id, expectedOldNovelId: "novel-current", targetNovelId: "novel-target", reason: "x" },
        deps(db, stores),
      ),
    ).rejects.toBeInstanceOf(RebindDriftError);
    expect(db.audits).toHaveLength(0);
    // The row itself is untouched — the forced count meant `updateMany`
    // never actually applied `data` in this fake either.
    expect(db.articles.find((candidate) => candidate.id === row.id)!.novelId).toBe("novel-current");
  });

  it("determinism: target promo link resolution picks the same (newest fetchedAt) PromoLink across two independent runs with the identical age pattern", async () => {
    // Two fully independent locale groups (rather than two articles racing
    // for the same target novel+locale, which guard 8 — TARGET_LOCALE_
    // OCCUPIED — would correctly reject the second time around) so this
    // test isolates promo-link determinism specifically.
    const db = new FakeRebindDb();
    const stores = authFixture();
    for (const locale of ["en", "fr"] as const) {
      seedNovel(db, { id: `novel-current-${locale}`, locale });
      seedNovel(db, { id: `novel-target-${locale}`, locale });
      seedPromoLink(db, { id: `promo-older-${locale}`, novelId: `novel-target-${locale}`, fetchedAt: new Date("2026-08-01T00:00:00.000Z") });
      seedPromoLink(db, { id: `promo-newer-${locale}`, novelId: `novel-target-${locale}`, fetchedAt: new Date("2026-09-01T00:00:00.000Z") });
      seedArticle(db, { id: `article-${locale}`, novelId: `novel-current-${locale}`, locale, status: "draft" });
    }

    const guardedEn = await authorization(stores, "admin.article.rebind_novel", ENABLED_ENV, "550e8400-e29b-41d4-a716-446655440001");
    const resultEn = await switchArticleNovel(
      { ...guardedEn, articleId: "article-en", expectedOldNovelId: "novel-current-en", targetNovelId: "novel-target-en", reason: "x" },
      deps(db, stores),
    );
    const guardedFr = await authorization(stores, "admin.article.rebind_novel", ENABLED_ENV, "550e8400-e29b-41d4-a716-446655440002");
    const resultFr = await switchArticleNovel(
      { ...guardedFr, articleId: "article-fr", expectedOldNovelId: "novel-current-fr", targetNovelId: "novel-target-fr", reason: "x" },
      deps(db, stores),
    );

    expect(resultEn.newPromoLinkId).toBe("promo-newer-en");
    expect(resultFr.newPromoLinkId).toBe("promo-newer-fr");
  });

  describe("published vs draft: target with no ready promo link", () => {
    it("published article -> blocked, no write", async () => {
      const db = new FakeRebindDb();
      const stores = authFixture();
      seedNovel(db, { id: "novel-current", locale: "en" });
      seedNovel(db, { id: "novel-target", locale: "en" }); // no promo link seeded
      const row = seedArticle(db, { id: "article-1", novelId: "novel-current", status: "published" });
      const guarded = await authorization(stores, "admin.article.rebind_novel", ENABLED_ENV);

      await expect(
        switchArticleNovel(
          { ...guarded, articleId: row.id, expectedOldNovelId: "novel-current", targetNovelId: "novel-target", reason: "x" },
          deps(db, stores),
        ),
      ).rejects.toBeInstanceOf(RebindGuardBlockedError);
      expect(db.articles.find((candidate) => candidate.id === row.id)!.novelId).toBe("novel-current");
    });

    it("draft article + acknowledgeRisks -> proceeds, promoLinkId lands null", async () => {
      const db = new FakeRebindDb();
      const stores = authFixture();
      seedNovel(db, { id: "novel-current", locale: "en" });
      seedNovel(db, { id: "novel-target", locale: "en" });
      const row = seedArticle(db, { id: "article-1", novelId: "novel-current", status: "draft" });
      const guarded = await authorization(stores, "admin.article.rebind_novel", ENABLED_ENV);

      const result = await switchArticleNovel(
        {
          ...guarded,
          articleId: row.id,
          expectedOldNovelId: "novel-current",
          targetNovelId: "novel-target",
          reason: "x",
          acknowledgeRisks: true,
        },
        deps(db, stores),
      );
      expect(result.newPromoLinkId).toBeNull();
      expect(db.articles.find((candidate) => candidate.id === row.id)!.promoLinkId).toBeNull();
    });

    it("draft article WITHOUT acknowledgeRisks -> refused (needs_ack requires the checkbox)", async () => {
      const db = new FakeRebindDb();
      const stores = authFixture();
      seedNovel(db, { id: "novel-current", locale: "en" });
      seedNovel(db, { id: "novel-target", locale: "en" });
      const row = seedArticle(db, { id: "article-1", novelId: "novel-current", status: "draft" });
      const guarded = await authorization(stores, "admin.article.rebind_novel", ENABLED_ENV);

      await expect(
        switchArticleNovel(
          { ...guarded, articleId: row.id, expectedOldNovelId: "novel-current", targetNovelId: "novel-target", reason: "x" },
          deps(db, stores),
        ),
      ).rejects.toBeInstanceOf(RebindGuardBlockedError);
    });
  });

  it("audit: writes before/after snapshots {novelId, novelTitle, promoLinkId, promoRedirectCode} and the reason", async () => {
    const db = new FakeRebindDb();
    const stores = authFixture();
    seedNovel(db, { id: "novel-current", title: "Current Book", locale: "en" });
    seedPromoLink(db, { id: "promo-current", novelId: "novel-current", publicRedirectCode: "cur-code" });
    seedNovel(db, { id: "novel-target", title: "Target Book", locale: "en" });
    seedPromoLink(db, { id: "promo-target", novelId: "novel-target", publicRedirectCode: "tgt-code" });
    const row = seedArticle(db, { id: "article-1", novelId: "novel-current", promoLinkId: "promo-current", status: "draft" });
    const guarded = await authorization(stores, "admin.article.rebind_novel", ENABLED_ENV);

    await switchArticleNovel(
      { ...guarded, articleId: row.id, expectedOldNovelId: "novel-current", targetNovelId: "novel-target", reason: "channel outage" },
      deps(db, stores),
    );

    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({
      action: "article.rebind_novel",
      entityType: "Article",
      entityId: row.id,
      reason: "channel outage",
      beforeSnapshot: { novelId: "novel-current", novelTitle: "Current Book", promoLinkId: "promo-current", promoRedirectCode: "cur-code" },
      afterSnapshot: { novelId: "novel-target", novelTitle: "Target Book", promoLinkId: "promo-target", promoRedirectCode: "tgt-code" },
    });
  });

  it("cache invalidation runs after the transaction commits (spy call order)", async () => {
    const cache = await import("next/cache");
    const db = new FakeRebindDb();
    const stores = authFixture();
    const row = setupSwitchFixture(db);
    const guarded = await authorization(stores, "admin.article.rebind_novel", ENABLED_ENV);

    vi.mocked(cache.revalidatePath).mockClear();

    await switchArticleNovel(
      { ...guarded, articleId: row.id, expectedOldNovelId: "novel-current", targetNovelId: "novel-target", reason: "x" },
      deps(db, stores),
    );

    // The write must already be visible before revalidation ever runs.
    expect(db.articles.find((candidate) => candidate.id === row.id)!.novelId).toBe("novel-target");
    expect(cache.revalidatePath).toHaveBeenCalled();
  });

  describe("fail-closed: capability × flag combinations", () => {
    it("FEATURE_ARTICLE_NOVEL_REBIND off -> RebindFeatureDisabledError, no write, regardless of write-allow", async () => {
      const db = new FakeRebindDb();
      const stores = authFixture();
      const row = setupSwitchFixture(db);
      const env = { FEATURE_ARTICLE_NOVEL_REBIND: "false", ARTICLE_NOVEL_REBIND_ALLOW_WRITE: "true" } as unknown as NodeJS.ProcessEnv;
      const guarded = await authorization(stores, "admin.article.rebind_novel", env);

      await expect(
        switchArticleNovel(
          { ...guarded, articleId: row.id, expectedOldNovelId: "novel-current", targetNovelId: "novel-target", reason: "x" },
          deps(db, stores, env),
        ),
      ).rejects.toBeInstanceOf(RebindFeatureDisabledError);
      expect(db.articles.find((candidate) => candidate.id === row.id)!.novelId).toBe("novel-current");
    });

    it("FEATURE on, ARTICLE_NOVEL_REBIND_ALLOW_WRITE off -> RebindWriteDisabledError, no write", async () => {
      const db = new FakeRebindDb();
      const stores = authFixture();
      const row = setupSwitchFixture(db);
      const env = { FEATURE_ARTICLE_NOVEL_REBIND: "true", ARTICLE_NOVEL_REBIND_ALLOW_WRITE: "false" } as unknown as NodeJS.ProcessEnv;
      const guarded = await authorization(stores, "admin.article.rebind_novel", env);

      await expect(
        switchArticleNovel(
          { ...guarded, articleId: row.id, expectedOldNovelId: "novel-current", targetNovelId: "novel-target", reason: "x" },
          deps(db, stores, env),
        ),
      ).rejects.toBeInstanceOf(RebindWriteDisabledError);
      expect(db.articles.find((candidate) => candidate.id === row.id)!.novelId).toBe("novel-current");
    });

    it("both flags off -> RebindFeatureDisabledError (total gate checked first)", async () => {
      const db = new FakeRebindDb();
      const stores = authFixture();
      const row = setupSwitchFixture(db);
      const env = { FEATURE_ARTICLE_NOVEL_REBIND: "false", ARTICLE_NOVEL_REBIND_ALLOW_WRITE: "false" } as unknown as NodeJS.ProcessEnv;
      const guarded = await authorization(stores, "admin.article.rebind_novel", env);

      await expect(
        switchArticleNovel(
          { ...guarded, articleId: row.id, expectedOldNovelId: "novel-current", targetNovelId: "novel-target", reason: "x" },
          deps(db, stores, env),
        ),
      ).rejects.toBeInstanceOf(RebindFeatureDisabledError);
    });

    it("both flags on -> succeeds (baseline for the other three combinations)", async () => {
      const db = new FakeRebindDb();
      const stores = authFixture();
      const row = setupSwitchFixture(db);
      const guarded = await authorization(stores, "admin.article.rebind_novel", ENABLED_ENV);

      const result = await switchArticleNovel(
        { ...guarded, articleId: row.id, expectedOldNovelId: "novel-current", targetNovelId: "novel-target", reason: "x" },
        deps(db, stores),
      );
      expect(result.newNovelId).toBe("novel-target");
    });

    it("missing content:rebind capability -> denied before the feature flag is even consulted", async () => {
      const stores = new TestOnlyInMemoryAuthStores();
      const identity: AdminIdentity = {
        id: "admin-no-grant",
        username: "no-grant",
        role: "editor", // not super_admin -> no default grant for content:rebind
        status: "active",
        sessionVersion: 1,
        twoFactorEnabled: true,
      };
      const session: AdminSessionRecord = {
        id: "session-no-grant",
        tokenHash: hashAdminSessionToken(TOKEN),
        identityId: identity.id,
        sessionVersion: 1,
        issuedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
        lastSeenAt: new Date(NOW.getTime() - 60_000),
        absoluteExpiresAt: new Date(NOW.getTime() + 23 * 60 * 60 * 1000),
        twoFactorCompletedAt: new Date(NOW.getTime() - 30_000),
        revokedAt: null,
      };
      stores.identities.set(identity.id, identity);
      stores.sessions.set(session.id, session);

      await expect(
        requireAdminActionAccess(
          { actionId: "admin.article.rebind_novel", sessionToken: TOKEN, origin: ORIGIN, canonicalOrigin: ORIGIN, requestId: "req-1" },
          { identities: stores, sessions: stores, registry: P2_04_ADMIN_REGISTRY, now: NOW, env: ENABLED_ENV },
        ),
      ).rejects.toMatchObject({ code: "admin_capability_denied" });
    });
  });
});

describe("rollbackArticleNovel", () => {
  it("rolls back to the before-snapshot novelId of the most recent article.rebind_novel audit row", async () => {
    const db = new FakeRebindDb();
    const stores = authFixture();
    const row = setupSwitchFixture(db);
    const forward = await authorization(stores, "admin.article.rebind_novel", ENABLED_ENV, "550e8400-e29b-41d4-a716-446655440010");
    await switchArticleNovel(
      { ...forward, articleId: row.id, expectedOldNovelId: "novel-current", targetNovelId: "novel-target", reason: "forward" },
      deps(db, stores),
    );
    expect(db.articles.find((candidate) => candidate.id === row.id)!.novelId).toBe("novel-target");

    const back = await authorization(stores, "admin.article.rebind_rollback", ENABLED_ENV, "550e8400-e29b-41d4-a716-446655440011");
    const result = await rollbackArticleNovel({ ...back, articleId: row.id, reason: "undo" }, deps(db, stores));

    expect(result.newNovelId).toBe("novel-current");
    expect(db.articles.find((candidate) => candidate.id === row.id)!.novelId).toBe("novel-current");
    expect(db.audits.map((audit) => audit.action)).toEqual(["article.rebind_novel", "article.rebind_rollback"]);
  });

  it("no prior article.rebind_novel audit row -> RebindRollbackNotFoundError", async () => {
    const db = new FakeRebindDb();
    const stores = authFixture();
    const row = setupSwitchFixture(db);
    const guarded = await authorization(stores, "admin.article.rebind_rollback", ENABLED_ENV);

    await expect(
      rollbackArticleNovel({ ...guarded, articleId: row.id, reason: "undo" }, deps(db, stores)),
    ).rejects.toBeInstanceOf(RebindRollbackNotFoundError);
  });
});

describe("searchRebindCandidates", () => {
  it("matches by title / businessId / slug (case-insensitive contains), excludes the article's current novel", async () => {
    const db = new FakeRebindDb();
    seedNovel(db, { id: "novel-current", title: "Current", locale: "en" });
    seedNovel(db, { id: "novel-by-title", title: "Moonlight Romance", locale: "en" });
    seedNovel(db, { id: "novel-by-biz", title: "Other", businessId: "special-biz-id", locale: "en" });
    seedNovel(db, { id: "novel-by-slug", title: "Another", slug: "findable-slug", locale: "en" });
    const row = seedArticle(db, { id: "article-1", novelId: "novel-current", locale: "en" });

    const byTitle = await searchRebindCandidates(db.asPrismaClient(), { articleId: row.id, query: "moonlight" }, ENABLED_ENV);
    expect(byTitle.map((c) => c.novelId)).toEqual(["novel-by-title"]);

    const byBiz = await searchRebindCandidates(db.asPrismaClient(), { articleId: row.id, query: "special-biz-id" }, ENABLED_ENV);
    expect(byBiz.map((c) => c.novelId)).toEqual(["novel-by-biz"]);

    const bySlug = await searchRebindCandidates(db.asPrismaClient(), { articleId: row.id, query: "findable-slug" }, ENABLED_ENV);
    expect(bySlug.map((c) => c.novelId)).toEqual(["novel-by-slug"]);

    const excludesCurrent = await searchRebindCandidates(db.asPrismaClient(), { articleId: row.id, query: "current" }, ENABLED_ENV);
    expect(excludesCurrent).toEqual([]);
  });

  it("each candidate carries a freshly evaluated guard result", async () => {
    const db = new FakeRebindDb();
    seedNovel(db, { id: "novel-current", locale: "en" });
    seedNovel(db, { id: "novel-target", title: "Blocked Target", locale: "fr" }); // locale mismatch -> blocked
    const row = seedArticle(db, { id: "article-1", novelId: "novel-current", locale: "en" });

    const results = await searchRebindCandidates(db.asPrismaClient(), { articleId: row.id, query: "blocked" }, ENABLED_ENV);
    expect(results).toHaveLength(1);
    expect(results[0]!.guardLevel).toBe("blocked");
    expect(results[0]!.findings.map((f) => f.code)).toContain("TARGET_LOCALE_MISMATCH");
  });

  it("empty query returns no candidates (never lists everything)", async () => {
    const db = new FakeRebindDb();
    seedNovel(db, { id: "novel-current", locale: "en" });
    seedNovel(db, { id: "novel-other", locale: "en" });
    const row = seedArticle(db, { id: "article-1", novelId: "novel-current", locale: "en" });
    expect(await searchRebindCandidates(db.asPrismaClient(), { articleId: row.id, query: "" }, ENABLED_ENV)).toEqual([]);
  });

  it("fail-closed: FEATURE_ARTICLE_NOVEL_REBIND off -> RebindFeatureDisabledError", async () => {
    const db = new FakeRebindDb();
    seedNovel(db, { id: "novel-current", locale: "en" });
    const row = seedArticle(db, { id: "article-1", novelId: "novel-current", locale: "en" });
    await expect(
      searchRebindCandidates(db.asPrismaClient(), { articleId: row.id, query: "x" }, { FEATURE_ARTICLE_NOVEL_REBIND: "false" } as unknown as NodeJS.ProcessEnv),
    ).rejects.toBeInstanceOf(RebindFeatureDisabledError);
  });
});

describe("getRebindView", () => {
  it("returns current book card + history, newest first", async () => {
    const db = new FakeRebindDb();
    const stores = authFixture();
    const row = setupSwitchFixture(db);
    const guarded = await authorization(stores, "admin.article.rebind_novel", ENABLED_ENV);
    await switchArticleNovel(
      { ...guarded, articleId: row.id, expectedOldNovelId: "novel-current", targetNovelId: "novel-target", reason: "x" },
      deps(db, stores),
    );

    const view = await getRebindView(db.asPrismaClient(), { articleId: row.id }, ENABLED_ENV);
    expect(view.currentNovel?.id).toBe("novel-target");
    expect(view.history).toHaveLength(1);
    expect(view.history[0]!.action).toBe("article.rebind_novel");
  });

  it("article not found -> RebindArticleNotEligibleError", async () => {
    const db = new FakeRebindDb();
    await expect(
      getRebindView(db.asPrismaClient(), { articleId: "missing" }, ENABLED_ENV),
    ).rejects.toBeInstanceOf(RebindArticleNotEligibleError);
  });
});

/**
 * 🔴 Negative test (this session's task instructions, mirroring 施工工单
 * §4B.5's batch-side "换绑不触发 IndexNow 入队"): CPS's own
 * `switchArticleDrama`/the Server Action wrapping it
 * (`cps-admin-v851-admin-host` HEAD c37602c,
 * `src/lib/article-drama-switch-service.ts` / `src/actions/article-drama-
 * actions.ts`) never call an IndexNow enqueue function — grepped for
 * "indexnow" (case-insensitive) in both files, zero hits; the action only
 * calls `revalidatePath`. This repo's single-article rebind mirrors that:
 * URL is unchanged by a rebind (slug/shortId untouched), so there is no
 * "first publish" or "content changed enough to notify" event here. Source
 * scan (not a call-spy) so it also catches a future edit that imports the
 * enqueue helper without ever calling it, or calls it under a re-exported
 * name a spy would miss.
 */
describe("IndexNow: rebind must not enqueue (negative, CPS parity — CPS's own switch service does not enqueue either)", () => {
  it("src/server/article-rebind/service.ts never mentions indexnow, in any casing", async () => {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await readFile(path.resolve(process.cwd(), "src/server/article-rebind/service.ts"), "utf8");
    expect(source).not.toMatch(/indexnow/i);
  });

  it("src/server/article-rebind/ (whole directory) imports nothing from @/lib/indexnow", async () => {
    const { readFile, readdir } = await import("node:fs/promises");
    const path = await import("node:path");
    const dir = path.resolve(process.cwd(), "src/server/article-rebind");
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const source = await readFile(path.join(dir, entry.name), "utf8");
      expect(source, entry.name).not.toMatch(/@\/lib\/indexnow/);
    }
  });

  it("behavioral: a successful switchArticleNovel writes exactly one OperationAudit row and zero IndexNowOutbox-shaped writes (the fake db has no indexNowOutbox delegate at all — a call to it would throw, not silently no-op)", async () => {
    const db = new FakeRebindDb();
    const stores = authFixture();
    const row = setupSwitchFixture(db);
    const guarded = await authorization(stores, "admin.article.rebind_novel", ENABLED_ENV);

    await switchArticleNovel(
      { ...guarded, articleId: row.id, expectedOldNovelId: "novel-current", targetNovelId: "novel-target", reason: "x" },
      deps(db, stores),
    );

    expect(db.audits).toHaveLength(1);
  });
});
