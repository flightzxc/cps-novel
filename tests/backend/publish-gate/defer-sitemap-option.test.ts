import { describe, expect, it, vi } from "vitest";

import { applyPublishTransition } from "@/server/publish-gate/service";

import { FakePublishGateDb } from "./fake-db";

/**
 * 后台批量发布任务（`article.publish.v1`，2026-10-06）给发布核心加的唯一一处可选参数：
 * `deferSitemapRefresh`。它只改**触发站点地图刷新的时机**——默认（同步按钮、同步批量发布
 * 从不传它）行为逐字不变；传 true 时首次发布不逐篇触发站点地图，IndexNow 派发不受影响。
 * 发布检查、写库、审计、试读收集、缓存失效都不因它而变。
 */

const dispatchFirstPublicPublication = vi.fn().mockResolvedValue({ errors: [] });
vi.mock("@/server/publication/dispatcher", () => ({
  dispatchPublicationPreviews: vi.fn(async () => undefined),
  dispatchFirstPublicPublication: (...args: unknown[]) => dispatchFirstPublicPublication(...args),
}));

function seed() {
  const db = new FakePublishGateDb();
  db.seedNovel({ id: "novel-1", status: "ready", locale: "en", deletedAt: null });
  db.seedArticle({
    id: "article-1", novelId: "novel-1", locale: "en", slug: "s", status: "draft", title: "T", body: "B",
    publishedAt: null, publishAt: null, deletedAt: null,
    promoLink: { id: "promo-1", status: "fetched", webUrl: "https://a", appUrl: null },
  });
  db.seedChapter({ id: "chapter-1", novelId: "novel-1", status: "preview", deletedAt: null, body: "chapter body" });
  return db;
}

const INPUT = { articleId: "article-1", requestId: "req-1", actor: { type: "admin" as const, adminId: "admin-1" } };

describe("applyPublishTransition · deferSitemapRefresh", () => {
  it("缺省：首次发布仍同时挂 IndexNow 与站点地图两个派发 handler（同步路径逐字不变）", async () => {
    dispatchFirstPublicPublication.mockClear();
    await applyPublishTransition(seed().asPrismaClient(), INPUT);
    expect(dispatchFirstPublicPublication.mock.calls[0]![2]).toEqual({
      enqueueIndexNow: expect.any(Function),
      enqueueSitemapRefresh: expect.any(Function),
    });
  });

  it("显式传 {} 或 deferSitemapRefresh:false 与缺省完全一致", async () => {
    for (const options of [{}, { deferSitemapRefresh: false }]) {
      dispatchFirstPublicPublication.mockClear();
      await applyPublishTransition(seed().asPrismaClient(), INPUT, undefined, options);
      expect(Object.keys(dispatchFirstPublicPublication.mock.calls[0]![2] as object).sort())
        .toEqual(["enqueueIndexNow", "enqueueSitemapRefresh"]);
    }
  });

  it("deferSitemapRefresh:true：不逐篇挂站点地图 handler，IndexNow handler 仍在，其余结果一字不差", async () => {
    dispatchFirstPublicPublication.mockClear();
    const plainDb = seed();
    const plain = await applyPublishTransition(plainDb.asPrismaClient(), INPUT);
    dispatchFirstPublicPublication.mockClear();
    const deferredDb = seed();
    const collected: string[] = [];
    const deferred = await applyPublishTransition(deferredDb.asPrismaClient(), INPUT, collected, { deferSitemapRefresh: true });
    const handlers = dispatchFirstPublicPublication.mock.calls[0]![2] as Record<string, unknown>;
    expect(Object.keys(handlers)).toEqual(["enqueueIndexNow"]);
    expect(deferred).toEqual(plain);
    expect(deferredDb.audits).toEqual(plainDb.audits);
    expect(deferredDb.articles.get("article-1")?.status).toBe("published");
    expect(deferredDb.novels.get("novel-1")?.status).toBe("published");
    // 试读仍由调用方收集（传了数组就只收集、不逐篇建任务），与是否延后站点地图无关。
    expect(collected).toEqual(["article-1"]);
  });

  it("重放（同一个请求编号）不再触发任何派发，延后与否都一样", async () => {
    const db = seed();
    await applyPublishTransition(db.asPrismaClient(), INPUT, [], { deferSitemapRefresh: true });
    dispatchFirstPublicPublication.mockClear();
    const collected: string[] = [];
    const replay = await applyPublishTransition(db.asPrismaClient(), INPUT, collected, { deferSitemapRefresh: true });
    expect(replay).toMatchObject({ outcome: "published", firstPublish: false });
    expect(dispatchFirstPublicPublication).not.toHaveBeenCalled();
    expect(collected).toEqual([]); // wrote=false：重放不收集试读
  });
});
