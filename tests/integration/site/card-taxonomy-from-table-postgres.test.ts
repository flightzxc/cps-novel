/**
 * B-38 第二段·真实库用例 4/7：卡片 / 详情页的标签改读归属表，与冻结的改造前实现逐项相等。
 *
 * 权威参照是 `tests/fixtures/public-taxonomy-before-b38.ts`（改造前"现场计算"的冻结快照）。同一批夹具
 * （第一段的场景矩阵 + 400 本确定性随机批：人工 / 映射 / 自动三套来源的每个分支与交叉），对账之后：
 *
 *   新的 `loadPublicTaxonomyByNovelIds`（读 `novel_effective_tag`，`web_app` 角色）=== 冻结旧实现，
 *   覆盖自动标签开 / 关、请求语种 en / es / ko（译名回落链：请求语种 → en → zh → slug）、
 *   标签顺序、`href`（带语种前缀）、`sortOrder`、`updatedAt`，整个对象逐项相等（JSON 序列化也相同）。
 *
 * 还核对：分块（> 一块 2,000 本）不改变结果；开关切换立即生效（表里不存开关）；停用分类实时过滤；
 * `loadPublicCategoryTags`（页脚 / 首页题材导航的名字）与卡片标签用同一个名字投影。
 *
 * 运行：`bash scripts/run-public-list-postgres-verification.sh`（一次性 postgres:16.14，真实角色）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadPublicCategoryTags, loadPublicTaxonomyByNovelIds, PUBLIC_TAXONOMY_NOVEL_ID_CHUNK_SIZE } from "@/lib/site/public-taxonomy";
import { reconcileAllEffectiveTags } from "@/server/tagging/effective-tag-projection";
import * as legacy from "../../fixtures/public-taxonomy-before-b38";
import {
  allNovelIds,
  assertIsolatedDatabase,
  connectRoles,
  disconnectRoles,
  enabled,
  resetDatabase,
  seedFoundation,
  seedRandomNovels,
  seedScenarioMatrix,
  TAG_SPECS,
  type Foundation,
} from "../tagging/effective-tag-fixtures";
import { envFor } from "./site-fixtures";

const roles = connectRoles();
const { owner, web } = roles;

let foundation: Foundation;
let ids: string[];

function plain(map: ReadonlyMap<string, readonly unknown[]>, order: readonly string[]) {
  return order.map((id) => [id, (map.get(id) ?? []) as unknown[]] as const);
}

describe.skipIf(!enabled).sequential("B-38 卡片标签读表 === 冻结旧实现（真实 web_app、真实迁移、真实 grants）", () => {
  beforeAll(async () => {
    await assertIsolatedDatabase(owner);
    await resetDatabase(owner);
    foundation = await seedFoundation(owner);
    // 译名：覆盖回落链的每一环（只有 zh、只有 en、请求语种有、请求语种没有、三种都没有 → slug）。
    await owner.canonicalTagTranslation.createMany({
      data: [
        { canonicalTagId: foundation.tags.alpha!, locale: "es", displayName: "Alfa" },
        { canonicalTagId: foundation.tags.beta!, locale: "en", displayName: "Beta" },
        { canonicalTagId: foundation.tags.beta!, locale: "ko", displayName: "베타" },
        { canonicalTagId: foundation.tags.gamma!, locale: "zh", displayName: "伽马" },
        { canonicalTagId: foundation.tags.delta!, locale: "ko", displayName: "델타" },
        { canonicalTagId: foundation.tags.tie!, locale: "es", displayName: "Empate" },
        { canonicalTagId: foundation.tags.tie!, locale: "en", displayName: "Tie" },
      ],
    });
    await seedScenarioMatrix(owner, foundation);
    await seedRandomNovels(owner, foundation, 400, 20_261_012);
    await reconcileAllEffectiveTags(web);
    ids = await allNovelIds(owner);
  }, 240_000);
  afterAll(async () => { await disconnectRoles(roles); });

  it("用的是真实角色身份", async () => {
    expect(await web.$queryRaw`SELECT current_user AS role`).toEqual([{ role: "web_app" }]);
  });

  for (const autoTags of [true, false]) {
    for (const locale of ["en", "es", "ko"]) {
      it(`自动标签${autoTags ? "开" : "关"} · 请求语种 ${locale}：整个对象逐项相等（含标签顺序、名称回落、href）`, async () => {
        const env = envFor({ autoTags });
        const [actual, expected] = await Promise.all([
          loadPublicTaxonomyByNovelIds(web, ids, locale, env),
          legacy.loadPublicTaxonomyByNovelIds(web, ids, locale, env),
        ]);
        const mismatches = ids.filter((id) => JSON.stringify(actual.get(id) ?? []) !== JSON.stringify(expected.get(id) ?? []));
        expect(mismatches.map((id) => ({ id, actual: actual.get(id), expected: expected.get(id) }))).toEqual([]);
        expect(plain(actual, ids)).toEqual(plain(expected, ids));
        const withTags = ids.filter((id) => (expected.get(id) ?? []).length > 0);
        expect(withTags.length).toBeGreaterThan(autoTags ? 150 : 100);
        // 夹具覆盖：至少有一本书有 ≥ 3 个标签（顺序才有意义），名称回落的每一环都被用到。
        expect(Math.max(...ids.map((id) => (expected.get(id) ?? []).length))).toBeGreaterThanOrEqual(3);
        const labels = new Set([...expected.values()].flat().map((tag) => `${tag.slug}:${tag.label}`));
        if (locale === "es") expect(labels.has("alpha:Alfa")).toBe(true); // 请求语种
        if (locale === "ko") expect(labels.has("beta:베타")).toBe(true);
        if (locale === "en") expect(labels.has("alpha:Alpha")).toBe(true);
        expect([...labels].some((label) => label.startsWith("gamma:伽马"))).toBe(true); // 只有 zh
        expect([...labels].some((label) => label === "theta:theta")).toBe(true); // 都没有 → slug
        // href 带语种前缀（en 无前缀）。
        const sampleHref = [...expected.values()].flat()[0]!.href;
        expect(sampleHref).toBe(locale === "en" ? `/category/${[...expected.values()].flat()[0]!.slug}` : `/${locale}/category/${[...expected.values()].flat()[0]!.slug}`);
      }, 120_000);
    }
  }

  it("分块：超过一块（PUBLIC_TAXONOMY_NOVEL_ID_CHUNK_SIZE）的 id 列表结果不变", async () => {
    expect(PUBLIC_TAXONOMY_NOVEL_ID_CHUNK_SIZE).toBe(2_000);
    // 把 id 列表重复拼成 > 2 块（重复 id 会被去重，所以改用不存在的 uuid 填充）
    const filler = Array.from({ length: 2_500 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    const env = envFor({ autoTags: true });
    const big = await loadPublicTaxonomyByNovelIds(web, [...filler, ...ids], "en", env);
    const plainSmall = await loadPublicTaxonomyByNovelIds(web, ids, "en", env);
    expect(plain(big, ids)).toEqual(plain(plainSmall, ids));
    expect(big.size).toBe(plainSmall.size);
  });

  it("开关切换立即生效（表里不存开关）：同一张表，开时多出 auto 行，关时回到旧'关'分支的结果", async () => {
    const on = await loadPublicTaxonomyByNovelIds(web, ids, "en", envFor({ autoTags: true }));
    const off = await loadPublicTaxonomyByNovelIds(web, ids, "en", envFor({ autoTags: false }));
    const expectedOff = await legacy.loadPublicTaxonomyByNovelIds(web, ids, "en", envFor({ autoTags: false }));
    expect(plain(off, ids)).toEqual(plain(expectedOff, ids));
    const extra = ids.filter((id) => (on.get(id)?.length ?? 0) > (off.get(id)?.length ?? 0));
    expect(extra.length).toBeGreaterThan(20);
  });

  it("停用分类实时过滤：不需要等对账，分类一停用卡片标签里立刻没有它", async () => {
    const env = envFor({ autoTags: true });
    const before = await loadPublicTaxonomyByNovelIds(web, ids, "en", env);
    const holders = ids.filter((id) => (before.get(id) ?? []).some((tag) => tag.slug === "alpha"));
    expect(holders.length).toBeGreaterThan(5);
    await owner.canonicalTag.update({ where: { id: foundation.tags.alpha! }, data: { status: "inactive" } });
    try {
      const after = await loadPublicTaxonomyByNovelIds(web, ids, "en", env);
      for (const id of holders) expect((after.get(id) ?? []).map((tag) => tag.slug)).not.toContain("alpha");
      const expected = await legacy.loadPublicTaxonomyByNovelIds(web, ids, "en", env);
      expect(plain(after, ids)).toEqual(plain(expected, ids)); // 冻结旧实现也是"实时过滤"，两边一致
    } finally {
      await owner.canonicalTag.update({ where: { id: foundation.tags.alpha! }, data: { status: "active" } });
    }
  });

  it("loadPublicCategoryTags（页脚 / 导航的名字）与卡片标签用同一个名字投影；停用的不返回；排序 = sort_order 再 slug", async () => {
    const activeSpecs = TAG_SPECS.filter((spec) => spec.status === "active");
    const allIds = TAG_SPECS.map((spec) => foundation.tags[spec.key]!);
    for (const locale of ["en", "es", "ko"]) {
      const tags = await loadPublicCategoryTags(web, allIds, locale);
      expect(tags.map((tag) => tag.slug)).toEqual(
        [...activeSpecs].sort((a, b) => a.sort - b.sort || a.slug.localeCompare(b.slug, "en")).map((spec) => spec.slug),
      );
      // 与卡片标签同一个投影：同一分类在两处的 label / href 完全相同。
      const onCards = new Map<string, unknown>();
      for (const list of (await loadPublicTaxonomyByNovelIds(web, ids, locale, envFor({ autoTags: true }))).values()) {
        for (const tag of list) onCards.set(tag.slug, { label: tag.label, href: tag.href, sortOrder: tag.sortOrder });
      }
      for (const tag of tags) {
        if (onCards.has(tag.slug)) expect({ label: tag.label, href: tag.href, sortOrder: tag.sortOrder }).toEqual(onCards.get(tag.slug));
      }
    }
    expect(await loadPublicCategoryTags(web, [], "en")).toEqual([]);
  });
});
