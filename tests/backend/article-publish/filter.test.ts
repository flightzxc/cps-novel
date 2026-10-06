import { describe, expect, it } from "vitest";

import {
  ARTICLE_PUBLISH_BATCH_MAX,
  ARTICLE_PUBLISH_LEAF_MAX,
  ArticlePublishInputError,
  isArticlePublishBatchTaskType,
  isArticlePublishTaskType,
  normalizeArticlePublishFilter,
} from "@/domain/article-publish-batch";
import { ARTICLE_GENERATE_LEAF_MAX } from "@/domain/article-generation";
import { PARENT_BATCH_TASK_TYPES, isParentBatchTaskType } from "@/lib/tasks/parent-batch";
import {
  articlePublishChildToken,
  articlePublishParentScopeHash,
  enqueueArticlePublishParentBatch,
} from "@/lib/tasks/article-publish";

function code(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof ArticlePublishInputError) return error.code;
    throw error;
  }
  return "no_error";
}

describe("文章后台批量发布 · 常量与任务类型", () => {
  it("子任务条目数与同步批量发布、建稿子任务同口径（200），全选上限 50,000", () => {
    expect(ARTICLE_PUBLISH_LEAF_MAX).toBe(200);
    expect(ARTICLE_PUBLISH_LEAF_MAX).toBe(ARTICLE_GENERATE_LEAF_MAX);
    expect(ARTICLE_PUBLISH_BATCH_MAX).toBe(50_000);
  });

  it("父任务登记进 PARENT_BATCH_TASK_TYPES（进度/状态从子任务汇总），子任务不登记", () => {
    expect(PARENT_BATCH_TASK_TYPES).toContain("article.publish.batch.v1");
    expect(isParentBatchTaskType("article.publish.batch.v1")).toBe(true);
    expect(isParentBatchTaskType("article.publish.v1")).toBe(false);
    expect(isArticlePublishBatchTaskType("article.publish.batch.v1")).toBe(true);
    expect(isArticlePublishBatchTaskType("article.publish.v1")).toBe(false);
    expect(isArticlePublishTaskType("article.publish.v1")).toBe(true);
    expect(isArticlePublishBatchTaskType(null)).toBe(false);
  });
});

describe("normalizeArticlePublishFilter", () => {
  it("空/缺省 → 空快照；只保留列表筛选轴并去掉空串与 all；键序固定（指纹稳定）", () => {
    expect(normalizeArticlePublishFilter(undefined)).toEqual({});
    expect(normalizeArticlePublishFilter({})).toEqual({});
    const a = normalizeArticlePublishFilter({
      search: "  love  ", contentMode: "all", articleType: "", seoVisibility: "all", locale: "en",
      canonicalTagId: "", novelId: "", templateId: "",
    });
    expect(a).toEqual({ locale: "en", search: "love" });
    const b = normalizeArticlePublishFilter({ locale: "en", search: "love" });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = normalizeArticlePublishFilter({ search: "x", locale: "en", contentMode: "manual" });
    expect(Object.keys(c)).toEqual(["locale", "search", "contentMode"]);
  });

  it("status 只接受草稿（或不筛）；明确选了别的状态 → 交集恒空，拒绝而不是静默改写", () => {
    expect(normalizeArticlePublishFilter({ status: "draft" })).toEqual({});
    expect(normalizeArticlePublishFilter({ status: "" })).toEqual({});
    for (const status of ["published", "unpublished", "takedown"]) {
      expect(code(() => normalizeArticlePublishFilter({ status }))).toBe("filter_status_not_draft");
    }
  });

  it("未知键一律拒绝（拼错键名会静默放宽筛选范围）；非对象、非字符串值、超长值拒绝", () => {
    expect(code(() => normalizeArticlePublishFilter({ locales: ["en"] }))).toBe("filter_key_unknown");
    expect(code(() => normalizeArticlePublishFilter("draft"))).toBe("filter_invalid");
    expect(code(() => normalizeArticlePublishFilter([]))).toBe("filter_invalid");
    expect(code(() => normalizeArticlePublishFilter({ locale: 3 }))).toBe("filter_value_invalid");
    expect(code(() => normalizeArticlePublishFilter({ search: "x".repeat(161) }))).toBe("filter_value_too_long");
    expect(code(() => normalizeArticlePublishFilter({ novelId: "x".repeat(65) }))).toBe("filter_value_too_long");
    expect(normalizeArticlePublishFilter({ search: "x".repeat(160) })).toEqual({ search: "x".repeat(160) });
  });
});

describe("入队前置校验（不碰数据库的部分）", () => {
  const db = {} as never; // 校验失败路径在任何数据库访问之前就抛出
  const base = { filter: {}, actorId: "admin-1", requestId: "req-1", draftCount: 10 };

  it("零草稿、超过 50,000、非法计数、缺提交人/请求编号、批次编号过长 → 抛稳定错误码", async () => {
    await expect(enqueueArticlePublishParentBatch(db, { ...base, draftCount: 0 })).rejects.toMatchObject({ code: "no_draft_in_filter" });
    await expect(enqueueArticlePublishParentBatch(db, { ...base, draftCount: 50_001 })).rejects.toMatchObject({ code: "selection_too_large" });
    await expect(enqueueArticlePublishParentBatch(db, { ...base, draftCount: -1 })).rejects.toMatchObject({ code: "draft_count_invalid" });
    await expect(enqueueArticlePublishParentBatch(db, { ...base, draftCount: 1.5 })).rejects.toMatchObject({ code: "draft_count_invalid" });
    await expect(enqueueArticlePublishParentBatch(db, { ...base, actorId: "" })).rejects.toMatchObject({ code: "request_invalid" });
    await expect(enqueueArticlePublishParentBatch(db, { ...base, requestId: "" })).rejects.toMatchObject({ code: "request_invalid" });
    await expect(enqueueArticlePublishParentBatch(db, { ...base, requestId: "r".repeat(101) })).rejects.toMatchObject({ code: "request_invalid" });
    await expect(enqueueArticlePublishParentBatch(db, { ...base, filter: { status: "published" } })).rejects.toMatchObject({ code: "filter_status_not_draft" });
  });

  it("scope hash / 子任务令牌是确定性的，且父任务编号进入子任务令牌", () => {
    expect(articlePublishParentScopeHash({ locale: "en" }, false)).toBe(articlePublishParentScopeHash({ locale: "en" }, false));
    expect(articlePublishParentScopeHash({ locale: "en" }, false)).not.toBe(articlePublishParentScopeHash({ locale: "en" }, true));
    expect(articlePublishParentScopeHash({ locale: "en" }, false)).not.toBe(articlePublishParentScopeHash({ locale: "ko" }, false));
    expect(articlePublishChildToken("p1", "start")).toBe(articlePublishChildToken("p1", "start"));
    expect(articlePublishChildToken("p1", "start")).not.toBe(articlePublishChildToken("p2", "start"));
    expect(articlePublishChildToken("p1", "a")).not.toBe(articlePublishChildToken("p1", "b"));
    expect(articlePublishChildToken("p1", "start")).toMatch(/^article_publish_child:[0-9a-f]{64}$/);
  });
});
