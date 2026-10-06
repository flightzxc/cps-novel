import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ARTICLE_PUBLISH_TASK_TYPE } from "@/domain/article-publish-batch";
import type { TaskHandlerContext, TaskLease } from "@/lib/tasks";

/**
 * 子任务 handler 的决策表（2026-10-06）。发布核心 `applyPublishTransition` 被替换成可编程的
 * 替身——这里只验 handler 自己的契约：稳定请求编号、不逐篇派发试读/站点地图的调用姿势、
 * 各种发布结果到条目状态的映射、"执行时已不是草稿"的保护与重放识别。发布核心本身与数据库
 * 的真实行为在真实库用例里。
 */

const core = vi.hoisted(() => ({ apply: vi.fn() }));
vi.mock("@/server/publish-gate/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/publish-gate/service")>();
  return { ...actual, applyPublishTransition: core.apply };
});
const finalize = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/lib/tasks/article-publish-finalize", () => ({
  finalizeArticlePublishAfterItem: finalize.run,
}));

const { createArticlePublishHandler, createArticlePublishWorkerHandlers } = await import("../../../worker/handlers/article-publish");
const { publishBatchItemRequestId } = await import("@/server/publish-gate/service");

const ARTICLE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BATCH = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADMIN = "admin-7";
const ITEM_REQUEST_ID = `${BATCH}:${ARTICLE_ID}`;

type FakeDb = {
  article: { findFirst: ReturnType<typeof vi.fn> };
  operationAudit: { findFirst: ReturnType<typeof vi.fn> };
};
function fakeDb(article: { status: string; deletedAt: Date | null } | null, ownAudit = false): FakeDb {
  return {
    article: { findFirst: vi.fn().mockResolvedValue(article) },
    operationAudit: { findFirst: vi.fn().mockResolvedValue(ownAudit ? { id: 1n } : null) },
  };
}

function context(payload: unknown = { articleId: ARTICLE_ID, actorId: ADMIN, batchRequestId: BATCH }): TaskHandlerContext {
  const lease: TaskLease = {
    family: "generic", taskType: ARTICLE_PUBLISH_TASK_TYPE, mode: "apply", itemId: "item-1", taskId: "task-1",
    workerId: "w", executionToken: "t", leaseEpoch: 1n, attemptCount: 1, lockedUntil: new Date(), payload,
  };
  return { lease, mode: "apply", signal: new AbortController().signal, heartbeat: async () => true };
}

const run = (db: FakeDb, ctx = context()) => createArticlePublishHandler(db as unknown as PrismaClient)(ctx);

beforeEach(() => {
  core.apply.mockReset();
  finalize.run.mockReset();
});

describe("article.publish.v1 handler", () => {
  it("调用发布核心：提交人作 admin actor、请求编号是 publishBatchItemRequestId(批次, 文章)、传入本地试读收集数组且延后站点地图", async () => {
    core.apply.mockImplementation(async (_db, _input, collector: string[]) => {
      collector.push(ARTICLE_ID); // 发布核心在真实写入时才会往收集数组里放
      return { outcome: "published", articleId: ARTICLE_ID, novelId: "n1", locale: "en", firstPublish: true, warnings: [] };
    });
    const db = fakeDb({ status: "draft", deletedAt: null });
    const outcome = await run(db);
    expect(core.apply).toHaveBeenCalledTimes(1);
    const [, input, collector, options] = core.apply.mock.calls[0]!;
    expect(input).toEqual({ articleId: ARTICLE_ID, requestId: ITEM_REQUEST_ID, actor: { type: "admin", adminId: ADMIN } });
    expect(input.requestId).toBe(publishBatchItemRequestId(BATCH, ARTICLE_ID));
    expect(Array.isArray(collector)).toBe(true);
    expect(options).toEqual({ deferSitemapRefresh: true });
    expect(outcome).toMatchObject({
      status: "success",
      result: { outcome: "published", articleId: ARTICLE_ID, novelId: "n1", firstPublish: true, wrote: true },
    });
  });

  it("请求编号稳定：同一篇文章两次执行得到同一个编号（不含序号/随机数）", async () => {
    core.apply.mockResolvedValue({ outcome: "published", articleId: ARTICLE_ID, novelId: "n1", locale: "en", firstPublish: true, warnings: [] });
    await run(fakeDb({ status: "draft", deletedAt: null }));
    await run(fakeDb({ status: "draft", deletedAt: null }));
    expect(core.apply.mock.calls[0]![1].requestId).toBe(core.apply.mock.calls[1]![1].requestId);
  });

  it("重放（发布核心返回 published 但没写任何东西）→ 成功且 wrote=false、firstPublish=false", async () => {
    core.apply.mockResolvedValue({ outcome: "published", articleId: ARTICLE_ID, novelId: "n1", locale: "en", firstPublish: false, warnings: [] });
    const outcome = await run(fakeDb({ status: "published", deletedAt: null }, true));
    expect(outcome).toMatchObject({ status: "success", result: { outcome: "published", wrote: false, firstPublish: false } });
  });

  it("发布检查拒绝 → 条目失败，带稳定的拒绝原因码与固定错误码", async () => {
    core.apply.mockResolvedValue({
      outcome: "rejected", gate: { publishable: false, reasons: ["promo_link_not_ready", "required_metadata_missing"], warnings: [], requiredMetadataMissing: null },
    });
    const outcome = await run(fakeDb({ status: "draft", deletedAt: null }));
    expect(outcome).toMatchObject({
      status: "failed",
      result: { outcome: "rejected", reasons: ["promo_link_not_ready", "required_metadata_missing"] },
      error: { code: "publish_gate_rejected", detail: { reasons: "promo_link_not_ready,required_metadata_missing" } },
    });
  });

  it("并发冲突（发布核心已回滚）→ retry，不是失败也不是成功", async () => {
    core.apply.mockResolvedValue({ outcome: "conflict" });
    expect(await run(fakeDb({ status: "draft", deletedAt: null }))).toMatchObject({
      status: "retry", error: { code: "publish_conflict" },
    });
  });

  it("文章不存在或已被软删除 → 跳过，不调用发布核心", async () => {
    for (const article of [null, { status: "draft", deletedAt: new Date() }]) {
      core.apply.mockClear();
      expect(await run(fakeDb(article))).toMatchObject({ status: "skipped", result: { outcome: "not_found" } });
      expect(core.apply).not.toHaveBeenCalled();
    }
  });

  it("执行时文章已不是草稿且不是本条目自己发布的 → 跳过 not_draft，不调用发布核心（不会把别人下线的文章重新发布出去）", async () => {
    for (const status of ["published", "unpublished", "takedown"]) {
      core.apply.mockClear();
      const db = fakeDb({ status, deletedAt: null }, false);
      expect(await run(db)).toMatchObject({ status: "skipped", result: { outcome: "not_draft", articleStatus: status } });
      expect(core.apply).not.toHaveBeenCalled();
      // 重放识别按"本条目自己的稳定请求编号"查审计，不是随便哪条发布审计。
      expect(db.operationAudit.findFirst.mock.calls[0]![0].where).toMatchObject({
        actorType: "admin", action: "article.publish", entityType: "Article", entityId: ARTICLE_ID, requestId: ITEM_REQUEST_ID,
      });
    }
  });

  it("不是草稿但本条目自己已发布过 → 走发布核心的重放分支（拿到与第一次一致的结果）", async () => {
    core.apply.mockResolvedValue({ outcome: "published", articleId: ARTICLE_ID, novelId: "n1", locale: "en", firstPublish: false, warnings: [] });
    const outcome = await run(fakeDb({ status: "published", deletedAt: null }, true));
    expect(core.apply).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("success");
  });

  it("发布核心抛出未预期异常时不吞掉：交给 worker 运行时记成条目失败（不当成成功或重放）", async () => {
    core.apply.mockRejectedValue(new Error("boom"));
    await expect(run(fakeDb({ status: "draft", deletedAt: null }))).rejects.toThrow("boom");
  });

  it("载荷畸形 / 租约类型不对 → 直接抛错", async () => {
    await expect(run(fakeDb(null), context({ articleId: "nope", actorId: ADMIN, batchRequestId: BATCH }))).rejects.toThrow("article_publish_payload_invalid");
    await expect(run(fakeDb(null), context({ articleId: ARTICLE_ID, actorId: "", batchRequestId: BATCH }))).rejects.toThrow("article_publish_payload_invalid");
    await expect(run(fakeDb(null), context(null))).rejects.toThrow("article_publish_payload_invalid");
    const wrong = context();
    await expect(createArticlePublishHandler({} as PrismaClient)({ ...wrong, lease: { ...wrong.lease, taskType: "article.generate.v1" } }))
      .rejects.toThrow("article_publish_lease_invalid");
  });
});

describe("注册", () => {
  it("子任务注册在 generic 家族、maxAttempts=3，并挂了 afterItemCommit（子任务收尾 + 整批收尾的唯一入口）", async () => {
    const registry = createArticlePublishWorkerHandlers({} as PrismaClient, { SITE_URL: "x" } as NodeJS.ProcessEnv);
    const registration = registry[ARTICLE_PUBLISH_TASK_TYPE]!;
    expect(registration).toMatchObject({ family: "generic", maxAttempts: 3 });
    await registration.afterItemCommit!("child-1");
    expect(finalize.run).toHaveBeenCalledWith({}, "child-1", { env: { SITE_URL: "x" } });
  });
});
