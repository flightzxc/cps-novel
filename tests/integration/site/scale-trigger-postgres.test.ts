/**
 * B-38 第二段·真实库用例 7/7：规模触发器（方案 4.7）。
 *
 * 深翻页耗时随页数线性增长（`OFFSET`），方案选择"不设上限，加触发器"：任一语种任一分类的列表可见书
 * 超过 40,000 本，或任一语种列表可见总数超过 60,000 本，就要改成游标翻页。触发器两处生效：
 *   - 矩阵计算时记一条结构化告警 `public_list_scale_threshold_exceeded`（站点地图刷新、web 侧缓存加载都会算矩阵）；
 *   - 运维命令 `scripts/ops/effective-tag-projection.ts scale-check`（发版检查清单）超过即退出 3，未超过退出 0。
 *
 * 真实库：未超过 → 无告警、退出 0；一个语种 60,001 本（其中一个分类 40,001 本）→ 告警 + 退出 3；
 * 恰好等于阈值（60,000 / 40,000）→ 不算超过（严格大于）；再补回一本 → 又超过。
 * 阈值常量本身由 `tests/backend/site/public-list.test.ts` 钉住。
 *
 * 运行：`bash scripts/run-public-list-postgres-verification.sh`（一次性 postgres:16.14，真实角色）。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";

import { clearPublicCategoryCountsCacheForTest, getPublicCategoryCounts, PUBLIC_LIST_SCALE_THRESHOLDS, queryPublicCategoryCounts } from "@/lib/site/public-list";
import { reconcileAllEffectiveTags } from "@/server/tagging/effective-tag-projection";
import { EFFECTIVE_TAG_EXIT, runEffectiveTagOps } from "../../../scripts/ops/effective-tag-projection";
import { createChannelFixture, seedBulkPublicArticles, seedManualCategoryRanges } from "../tasks/fixtures/bulk-public-articles";
import { assertIsolatedDatabase, connectRoles, disconnectRoles, enabled, resetDatabase } from "../tagging/effective-tag-fixtures";
import { envFor } from "./site-fixtures";

const roles = connectRoles();
const { owner, web, worker } = roles;

const BIG_LOCALE_COUNT = PUBLIC_LIST_SCALE_THRESHOLDS.perLocaleTotal + 1; // 60,001
const BIG_CATEGORY_COUNT = PUBLIC_LIST_SCALE_THRESHOLDS.perCategoryPerLocale + 1; // 40,001
const env = envFor({ autoTags: false, seoVisibility: false });

const warnEvents = (spy: MockInstance) =>
  spy.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("public_list_scale_threshold_exceeded")).map((line) => JSON.parse(line));

describe.skipIf(!enabled).sequential("B-38 规模触发器：告警日志 + scale-check 退出码（真实库、真实阈值）", () => {
  beforeAll(async () => {
    await assertIsolatedDatabase(owner);
    await resetDatabase(owner);
    const channel = await createChannelFixture(owner);
    const baseUpdatedAt = new Date("2026-01-01T00:00:00.000Z");
    // 一个小语种（ko，30 本、两个分类）：永远不会触发。
    await seedBulkPublicArticles(owner, { prefix: "ko", locale: "ko", count: 30, channel, baseUpdatedAt });
    await seedManualCategoryRanges(owner, {
      prefix: "ko", count: 30, tagUpdatedAt: baseUpdatedAt,
      categories: [{ slug: "ko-a", displayName: "A", ordinals: [[1, 20]] }, { slug: "ko-b", displayName: "B", ordinals: [[21, 30]] }],
    });
    await reconcileAllEffectiveTags(worker);
  }, 120_000);
  afterEach(() => { vi.restoreAllMocks(); clearPublicCategoryCountsCacheForTest(); });
  afterAll(async () => { await disconnectRoles(roles); });

  it("阈值常量（方案 4.7）：单语种单分类 40,000 / 单语种总数 60,000", () => {
    expect(PUBLIC_LIST_SCALE_THRESHOLDS).toEqual({ perCategoryPerLocale: 40_000, perLocaleTotal: 60_000 });
  });

  it("未超过：矩阵计算不告警，scale-check 退出 0 并报出实际最大值", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const counts = await queryPublicCategoryCounts(worker, env);
    expect(counts.visibleTotalByLocale.get("ko")).toBe(30);
    expect(warnEvents(warn)).toEqual([]);
    const result = await runEffectiveTagOps(worker, { mode: "scale-check" });
    expect(result.exitCode).toBe(EFFECTIVE_TAG_EXIT.clean);
    expect(result.lines).toEqual([
      "PUBLIC_LIST_SCALE_CHECK exceeded=false max_category_count=20 max_locale_total=30 category_threshold=40000 locale_threshold=60000",
    ]);
    expect(warnEvents(warn)).toEqual([]);
  });

  it("超过：一个语种 60,001 本、其中一个分类 40,001 本 → 告警（含语种 / 分类 / 数量）+ scale-check 退出 3", async () => {
    const channel = await createChannelFixture(owner);
    const baseUpdatedAt = new Date("2026-01-01T00:00:00.000Z");
    await seedBulkPublicArticles(owner, { prefix: "fr", locale: "fr", count: BIG_LOCALE_COUNT, channel, baseUpdatedAt });
    await seedManualCategoryRanges(owner, {
      prefix: "fr", count: BIG_LOCALE_COUNT, tagUpdatedAt: baseUpdatedAt,
      categories: [
        { slug: "fr-big", displayName: "Big", ordinals: [[1, BIG_CATEGORY_COUNT]] },
        { slug: "fr-mid", displayName: "Mid", ordinals: [[BIG_CATEGORY_COUNT + 1, BIG_LOCALE_COUNT]] },
      ],
    });
    await reconcileAllEffectiveTags(worker);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const counts = await queryPublicCategoryCounts(worker, env);
    expect(counts.visibleTotalByLocale.get("fr")).toBe(BIG_LOCALE_COUNT);
    const events = warnEvents(warn);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      schemaVersion: 1,
      event: "public_list_scale_threshold_exceeded",
      level: "warn",
      thresholds: { perCategoryPerLocale: 40_000, perLocaleTotal: 60_000 },
      categories: [{ locale: "fr", slug: "fr-big", count: BIG_CATEGORY_COUNT }],
      locales: [{ locale: "fr", total: BIG_LOCALE_COUNT }],
    });

    const result = await runEffectiveTagOps(worker, { mode: "scale-check" });
    expect(result.exitCode).toBe(EFFECTIVE_TAG_EXIT.differences);
    expect(result.exitCode).toBe(3);
    expect(result.lines).toEqual([
      `PUBLIC_LIST_SCALE_CHECK exceeded=true max_category_count=${BIG_CATEGORY_COUNT} max_locale_total=${BIG_LOCALE_COUNT} category_threshold=40000 locale_threshold=60000`,
      `PUBLIC_LIST_SCALE_EXCEEDED kind=category locale=fr slug=fr-big count=${BIG_CATEGORY_COUNT}`,
      `PUBLIC_LIST_SCALE_EXCEEDED kind=locale locale=fr total=${BIG_LOCALE_COUNT}`,
    ]);
    expect(result.stderr).toEqual([]);

    // web 侧缓存加载矩阵时同样会告警（缓存未命中时算一次）。
    warn.mockClear();
    await getPublicCategoryCounts(web, env);
    expect(warnEvents(warn)).toHaveLength(1);
    await getPublicCategoryCounts(web, env); // 命中缓存：不再算，不再告警
    expect(warnEvents(warn)).toHaveLength(1);
  }, 300_000);

  it("恰好等于阈值不算超过（严格大于）：下架分类里的 1 本 → 40,000 / 60,000 → 退出 0；补回 → 又超过", async () => {
    // fr-big 里的第 1 本（序号 1）：既在 fr-big 里，又计入 fr 的总数。
    const [{ id }] = await owner.$queryRaw<Array<{ id: string }>>`SELECT md5('fr-a-1')::uuid::text AS id`;
    await owner.article.update({ where: { id }, data: { status: "unpublished" } });
    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const counts = await queryPublicCategoryCounts(worker, env);
      expect(counts.visibleTotalByLocale.get("fr")).toBe(PUBLIC_LIST_SCALE_THRESHOLDS.perLocaleTotal);
      expect(counts.rows.find((row) => row.slug === "fr-big")!.count).toBe(PUBLIC_LIST_SCALE_THRESHOLDS.perCategoryPerLocale);
      expect(warnEvents(warn)).toEqual([]);
      const result = await runEffectiveTagOps(worker, { mode: "scale-check" });
      expect(result.exitCode).toBe(EFFECTIVE_TAG_EXIT.clean);
      expect(result.lines).toEqual([
        "PUBLIC_LIST_SCALE_CHECK exceeded=false max_category_count=40000 max_locale_total=60000 category_threshold=40000 locale_threshold=60000",
      ]);
    } finally {
      await owner.article.update({ where: { id }, data: { status: "published" } });
    }
    expect((await runEffectiveTagOps(worker, { mode: "scale-check" })).exitCode).toBe(3);
  }, 300_000);
});
