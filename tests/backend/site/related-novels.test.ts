import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RELATED_NOVELS_TARGET,
  NEW_RELEASES_TARGET,
  clearRelatedNovelsPoolCacheForTest,
  getRelatedAndNewReleaseNovels,
} from "@/lib/site/related-novels";

/**
 * A4/B3（照搬 CPS v8.5.1 `getRelatedDramas`/`getRelatedDramasPoolCached`，
 * 适配海阅的多标签模型——见 `src/lib/site/related-novels.ts` 头部注释）。
 *
 * 新增用例（交接文档"测试与门禁"一节要求）：推荐模块排除当前书、两个模块
 * 互不重复、候选不足时正常渲染。
 *
 * `Math.random` 打桩为恒定 0：`sampleEntries` 的部分 Fisher-Yates 在
 * `Math.random()` 恒为 0 时每次交换的 `j` 都等于 `i`（不交换），抽样结果退化
 * 成"取数组前 N 项"，让断言可以精确核对具体是哪几本书，而不只是数量。
 */

function novelRow(id: string, publishedAt: string) {
  return {
    id: `article-${id}`,
    title: `Novel ${id}`,
    slug: `novel-${id}`,
    locale: "en",
    publicPageShortId: `short${id}`,
    publishedAt: new Date(publishedAt),
    summary: `Summary ${id}`,
    novel: {
      id: `novel-uuid-${id}`,
      businessId: `biz-${id}`,
      title: `Novel ${id}`,
      description: `Description ${id}`,
      coverUrl: `/covers/${id}.jpg`,
      locale: "en",
      totalChapterCount: 10,
    },
    promoLink: { status: "fetched", webUrl: `https://upstream.example/${id}`, appUrl: null },
  };
}

const CURRENT_NOVEL_ID = "novel-uuid-current";
const CURRENT_ARTICLE_ID = "article-current";

const TAG_ROMANCE = {
  id: "tag-romance",
  slug: "romance",
  requested_display_name: "Romance",
  en_display_name: "Romance",
  zh_display_name: "言情",
  sort_order: 1,
  updated_at: new Date("2026-09-01T00:00:00Z"),
};

function tagRow(novelUuid: string) {
  return { novel_id: novelUuid, ...TAG_ROMANCE };
}

describe("getRelatedAndNewReleaseNovels", () => {
  const randomSpy = vi.spyOn(Math, "random");

  beforeEach(() => {
    clearRelatedNovelsPoolCacheForTest();
    // 🔴 每个 it 都要重新 mockReturnValue，而不是只在 afterAll 里 restore 一次
    // 后就指望 beforeEach 的 mockReturnValue 复活它：`mockRestore()` 会把
    // `Math.random` 换回原生实现，之后在同一个（已 restore 的）spy 对象上
    // 调 `mockReturnValue` 不会重新接管 `Math.random`——那样下一个 it 用的
    // 就是真随机，2 元素数组有 50% 概率顺序对不上，表现为间歇性红（这正是
    // 本文件最初的写法踩到的坑：单独跑这个文件时走运全绿，混进全量套件按
    // 不同顺序跑时就会偶发失败，被 `run-p1-06-postgres-verification.sh`
    // 抓到）。这里改成只在 `afterEach` 里 `mockClear()`（只清调用记录，不
    // 摘除实现），真正的 `mockRestore()` 放到 `afterAll`，全程只有一个
    // 一直生效的 spy 实例。
    randomSpy.mockReturnValue(0);
  });

  afterEach(() => {
    clearRelatedNovelsPoolCacheForTest();
    randomSpy.mockClear();
  });

  afterAll(() => {
    randomSpy.mockRestore();
  });

  it("排除当前书；相关推荐优先选共同标签，不足时用同语种其它书补齐；新书推荐排除相关推荐里已出现的书", async () => {
    // desc publishedAt 顺序：current（最新，将被排除）→ A-D（共享 romance 标签）→ E-L（无共享标签）。
    const current = novelRow("current", "2026-09-20T00:00:00Z");
    const shared = ["A", "B", "C", "D"].map((id, i) => novelRow(id, `2026-09-1${9 - i}T00:00:00Z`));
    const rest = ["E", "F", "G", "H", "I", "J", "K", "L"].map((id, i) =>
      novelRow(id, `2026-09-${10 - i}T00:00:00Z`),
    );

    const findMany = vi.fn().mockResolvedValue([current, ...shared, ...rest]);
    const tagRows = [tagRow(CURRENT_NOVEL_ID), ...shared.map((row) => tagRow(row.novel.id))];
    const db = {
      article: { findMany },
      $queryRaw: vi.fn().mockResolvedValue(tagRows),
    } as unknown as PrismaClient;

    const result = await getRelatedAndNewReleaseNovels(db, "en", CURRENT_ARTICLE_ID, CURRENT_NOVEL_ID);

    expect(result.related).toHaveLength(RELATED_NOVELS_TARGET);
    expect(result.newReleases).toHaveLength(NEW_RELEASES_TARGET);

    const relatedIds = result.related.map((card) => card.id);
    const newReleaseIds = result.newReleases.map((card) => card.id);

    // 排除当前书。
    expect(relatedIds).not.toContain("biz-current");
    expect(newReleaseIds).not.toContain("biz-current");

    // Math.random 恒为 0 时，抽样退化为"取数组前 N 项"：优先取完 4 本共享
    // 标签的书，再从其余候选里补 2 本凑够 6 本。
    expect(relatedIds).toEqual(["biz-A", "biz-B", "biz-C", "biz-D", "biz-E", "biz-F"]);
    // 新书推荐按 publishedAt 倒序排除掉 related 里已出现的书之后，取前 6 本。
    expect(newReleaseIds).toEqual(["biz-G", "biz-H", "biz-I", "biz-J", "biz-K", "biz-L"]);

    // 两个模块互不重复。
    for (const id of relatedIds) {
      expect(newReleaseIds).not.toContain(id);
    }
  });

  it("候选不足 6 本时正常显示已有的几本，不补零、不报错", async () => {
    const current = novelRow("current", "2026-09-20T00:00:00Z");
    const onlyTwo = ["A", "B"].map((id, i) => novelRow(id, `2026-09-1${9 - i}T00:00:00Z`));

    const db = {
      article: { findMany: vi.fn().mockResolvedValue([current, ...onlyTwo]) },
      $queryRaw: vi.fn().mockResolvedValue([]),
    } as unknown as PrismaClient;

    const result = await getRelatedAndNewReleaseNovels(db, "en", CURRENT_ARTICLE_ID, CURRENT_NOVEL_ID);

    // 只有 2 本候选（排除当前书后），相关推荐取到这 2 本就是全部了。
    expect(result.related.map((card) => card.id)).toEqual(["biz-A", "biz-B"]);
    // 两本都被 related 拿走了，新书推荐没有剩余候选——空数组，不是报错。
    expect(result.newReleases).toEqual([]);
  });

  it("候选池为空（只有当前书自己）时两个模块都返回空数组", async () => {
    const current = novelRow("current", "2026-09-20T00:00:00Z");
    const db = {
      article: { findMany: vi.fn().mockResolvedValue([current]) },
      $queryRaw: vi.fn().mockResolvedValue([]),
    } as unknown as PrismaClient;

    const result = await getRelatedAndNewReleaseNovels(db, "en", CURRENT_ARTICLE_ID, CURRENT_NOVEL_ID);
    expect(result.related).toEqual([]);
    expect(result.newReleases).toEqual([]);
  });
});
