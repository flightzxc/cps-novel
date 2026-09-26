/**
 * Owner decision 2026-09-18 — 发布与 Preview 解耦.
 *
 * 产品口径：试读是文章页面的增强能力，不是文章发布的硬前置条件。没有试读的
 * 文章照样可以发布，试读由 `src/server/preview-recovery/backfill.ts` 异步补齐。
 *
 * 这份文件走的是**真实写路径** `applyPublishTransition`（不是纯 evaluator），
 * 因为「能不能发布」这件事最终由它落库；evaluator 层的同一批断言在
 * `./evaluator.test.ts` 里。每个用例都同时钉两件事：
 *
 *   1. 该拦的还拦（promo / 权利 / 必填字段 / 页面身份）——解耦不得被当成
 *      "把门禁整体放宽"的借口；
 *   2. 试读缺失仍然被**看见**（`warnings` + 审计 `publishWarnings`）——不得
 *      因为不阻断就把事实采集删掉，补采链路要靠它找书。
 */
import { describe, expect, it, vi } from "vitest";

import { PUBLISH_GATE_WARNING_REASONS } from "@/contracts/publish-gate";
import { applyPublishTransition, publishArticlesBatch } from "@/server/publish-gate/service";

import { FakePublishGateDb } from "./fake-db";

vi.mock("@/server/publication/dispatcher", () => ({
  dispatchPublicationPreviews: vi.fn(async () => undefined),
  dispatchFirstPublicPublication: vi.fn().mockResolvedValue({ errors: [] }),
}));

type SeedOptions = {
  readonly preview?: "complete" | "empty_body" | "none";
  readonly promo?: { id: string; status: string; webUrl: string | null; appUrl: string | null } | null;
  readonly novelStatus?: string;
  readonly articleStatus?: string;
  readonly title?: string;
};

function seed(db: FakePublishGateDb, options: SeedOptions = {}, suffix = "1"): FakePublishGateDb {
  const preview = options.preview ?? "complete";
  db.seedNovel({
    id: `novel-${suffix}`,
    status: options.novelStatus ?? "ready",
    locale: "en",
    deletedAt: null,
  });
  db.seedArticle({
    id: `article-${suffix}`,
    novelId: `novel-${suffix}`,
    locale: "en",
    slug: `slug-${suffix}`,
    status: options.articleStatus ?? "draft",
    title: options.title ?? "Title",
    body: "Body",
    publishedAt: null,
    publishAt: null,
    deletedAt: null,
    promoLink:
      options.promo === undefined
        ? { id: `promo-${suffix}`, status: "fetched", webUrl: "https://example.com/a", appUrl: null }
        : options.promo,
  });
  if (preview !== "none") {
    db.seedChapter({
      id: `chapter-${suffix}`,
      novelId: `novel-${suffix}`,
      status: "preview",
      deletedAt: null,
      body: preview === "complete" ? "chapter body" : null,
    });
  }
  return db;
}

function publish(db: FakePublishGateDb, suffix = "1", requestId = "req-1") {
  return applyPublishTransition(db.asPrismaClient(), {
    articleId: `article-${suffix}`,
    requestId,
    actor: { type: "admin", adminId: "admin-1" },
  });
}

describe("Case 1 — article valid + promo valid + zero preview chapters → publishable", () => {
  it("publishes, and reports the missing preview as a warning rather than swallowing it", async () => {
    const db = seed(new FakePublishGateDb(), { preview: "none" });

    const result = await publish(db);

    expect(result).toMatchObject({
      outcome: "published",
      articleId: "article-1",
      warnings: ["preview_chapter_missing"],
    });
    expect(db.articles.get("article-1")?.status).toBe("published");
    expect(db.novels.get("novel-1")?.status).toBe("published");
  });

  it("records what it published despite, so the decision leaves an audit trace", async () => {
    const db = seed(new FakePublishGateDb(), { preview: "none" });

    await publish(db);

    expect(db.audits).toHaveLength(1);
    const after = db.audits[0]!.afterSnapshot as Record<string, unknown>;
    expect(after.articleStatus).toBe("published");
    expect(after.publishWarnings).toEqual(["preview_chapter_missing"]);
  });

  it("a clean publish carries no warning at all — the field is not decorative", async () => {
    const db = seed(new FakePublishGateDb());
    const result = await publish(db);
    expect(result).toMatchObject({ outcome: "published", warnings: [] });
    expect((db.audits[0]!.afterSnapshot as Record<string, unknown>).publishWarnings).toEqual([]);
  });
});

describe("Case 2 — a preview chapter exists but its body is empty → publishable", () => {
  it("publishes with preview_body_missing as the warning", async () => {
    const db = seed(new FakePublishGateDb(), { preview: "empty_body" });

    const result = await publish(db);

    expect(result).toMatchObject({ outcome: "published", warnings: ["preview_body_missing"] });
    expect(db.articles.get("article-1")?.status).toBe("published");
  });
});

describe("Case 3 — promo gate is untouched", () => {
  it("a missing PromoLink still blocks, even when the preview is complete", async () => {
    const db = seed(new FakePublishGateDb(), { promo: null });

    const result = await publish(db);

    expect(result).toMatchObject({
      outcome: "rejected",
      gate: { publishable: false, reasons: ["promo_link_missing"] },
    });
    expect(db.articles.get("article-1")?.status).toBe("draft");
    expect(db.audits).toHaveLength(0);
  });

  it("an unusable PromoLink (present but blank URLs) still blocks", async () => {
    const db = seed(new FakePublishGateDb(), {
      promo: { id: "promo-1", status: "fetched", webUrl: "   ", appUrl: "\t" },
    });

    const result = await publish(db);

    expect(result).toMatchObject({
      outcome: "rejected",
      gate: { publishable: false, reasons: ["promo_link_not_ready"] },
    });
    expect(db.articles.get("article-1")?.status).toBe("draft");
  });

  it("no preview + no promo → still refused, and the refusal names promo (never the preview)", async () => {
    const db = seed(new FakePublishGateDb(), { preview: "none", promo: null });

    const result = await publish(db);

    expect(result).toMatchObject({
      outcome: "rejected",
      gate: {
        publishable: false,
        reasons: ["promo_link_missing"],
        warnings: ["preview_chapter_missing"],
      },
    });
    expect(db.articles.get("article-1")?.status).toBe("draft");
  });
});

describe("Case 4 — every other pre-existing hard gate still blocks", () => {
  it("a taken-down Novel still blocks, preview or not", async () => {
    const db = seed(new FakePublishGateDb(), { preview: "none", novelStatus: "takedown" });

    const result = await publish(db);

    expect(result).toMatchObject({
      outcome: "rejected",
      gate: { publishable: false, reasons: ["rights_blocked"] },
    });
    expect(db.articles.get("article-1")?.status).toBe("draft");
  });

  it("a taken-down Article still blocks", async () => {
    const db = seed(new FakePublishGateDb(), { preview: "none", articleStatus: "takedown" });

    const result = await publish(db);

    expect(result).toMatchObject({
      outcome: "rejected",
      gate: { publishable: false, reasons: ["rights_blocked"] },
    });
  });

  it("blank required metadata still blocks", async () => {
    const db = seed(new FakePublishGateDb(), { preview: "none", title: "   " });

    const result = await publish(db);

    expect(result).toMatchObject({
      outcome: "rejected",
      gate: {
        publishable: false,
        reasons: ["required_metadata_missing"],
        requiredMetadataMissing: { reason: "required_metadata_missing", missingFields: ["title"] },
      },
    });
  });

  it("a (locale, slug) page-identity conflict still blocks", async () => {
    const db = seed(new FakePublishGateDb(), { preview: "none" });
    // A different live Article already occupying this Article's own (locale, slug).
    db.seedArticle({
      id: "article-squatter",
      novelId: "novel-1",
      locale: "en",
      slug: "slug-1",
      status: "published",
      title: "Other",
      body: "Other",
      publishedAt: new Date("2026-01-01T00:00:00.000Z"),
      publishAt: null,
      deletedAt: null,
      promoLink: { id: "promo-x", status: "fetched", webUrl: "https://example.com/x", appUrl: null },
    });

    const result = await publish(db);

    expect(result).toMatchObject({
      outcome: "rejected",
      gate: { publishable: false, reasons: ["page_identity_conflict"] },
    });
    expect(db.articles.get("article-1")?.status).toBe("draft");
  });

  it("no warning code can ever appear in `reasons` on a rejection", async () => {
    const db = seed(new FakePublishGateDb(), { preview: "none", promo: null, novelStatus: "takedown" });

    const result = await publish(db);

    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") throw new Error("unreachable");
    for (const warning of PUBLISH_GATE_WARNING_REASONS) {
      expect(result.gate.reasons).not.toContain(warning);
    }
    // ...and the genuinely blocking pair is still both reported, in registry order.
    expect(result.gate.reasons).toEqual(["promo_link_missing", "rights_blocked"]);
  });
});

describe("批量与单篇判定一致", () => {
  it("a batch publishes the preview-less book and refuses the promo-less one, in one call", async () => {
    const db = new FakePublishGateDb();
    seed(db, { preview: "none" }, "1");
    seed(db, { preview: "complete", promo: null }, "2");

    const batch = await publishArticlesBatch(db.asPrismaClient(), {
      articleIds: ["article-1", "article-2"],
      requestId: "batch-1",
      actor: { type: "admin", adminId: "admin-1" },
    });

    expect(batch.results[0]).toMatchObject({
      articleId: "article-1",
      result: { outcome: "published", warnings: ["preview_chapter_missing"] },
    });
    expect(batch.results[1]).toMatchObject({
      articleId: "article-2",
      result: { outcome: "rejected", gate: { reasons: ["promo_link_missing"] } },
    });
    expect(db.articles.get("article-1")?.status).toBe("published");
    expect(db.articles.get("article-2")?.status).toBe("draft");
  });
});
