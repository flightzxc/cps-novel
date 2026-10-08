/**
 * B-38 第一段·真实库用例 1/3：`novel_effective_tag` 与改造前"现场计算"逐行等价。
 *
 * 权威参照是 `tests/fixtures/public-taxonomy-before-b38.ts`——B-38 前 `src/lib/site/public-taxonomy.ts`
 * 的冻结快照（两个 SQL 分支：自动标签开 / 关）。夹具覆盖三套规则的每个分支 + 一批确定性随机的交叉组合，
 * `reconcileAllEffectiveTags` 之后：
 *   - 自动开：按 rank 读出的 (书, 分类) 序列 == 参照"开"分支，逐本逐行；
 *   - 自动关：`provenance <> 'auto'` 按 rank 读出的序列 == 参照"关"分支，逐本逐行。
 * 另外：迁移首建段与全量对账结果逐行一致、稳定状态零写入、检查命令、权限、事务闸。
 *
 * 运行：`bash scripts/run-effective-tag-projection-postgres-verification.sh`（一次性 postgres:16.14，真实角色）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  checkEffectiveTags,
  reconcileAllEffectiveTags,
  refreshEffectiveTagsForNovels,
} from "@/server/tagging/effective-tag-projection";
import * as legacy from "../../fixtures/public-taxonomy-before-b38";
import {
  allNovelIds,
  assertIsolatedDatabase,
  connectRoles,
  disconnectRoles,
  enabled,
  firstBuildSegment,
  readProjectionRows,
  readProjectionSequences,
  resetDatabase,
  seedFoundation,
  seedRandomNovels,
  seedScenarioMatrix,
  TAG_SPECS,
  type Foundation,
} from "./effective-tag-fixtures";

const roles = connectRoles();
const { owner, web, worker, scheduler, analyst } = roles;

let foundation: Foundation;
let novels: Readonly<Record<string, string>>;
const slugById = new Map<string, string>();

function envFor(autoEnabled: boolean): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", FEATURE_NOVEL_TAG_AUTO: autoEnabled ? "true" : "false" };
}

/** 冻结参照：每本小说的分类 id 序列（空数组 = 没有任何分类）。 */
async function legacySequences(autoEnabled: boolean, ids: readonly string[]): Promise<Map<string, string[]>> {
  const grouped = await legacy.loadPublicTaxonomyByNovelIds(web, ids, "en", envFor(autoEnabled));
  return new Map(ids.map((id) => [id, (grouped.get(id) ?? []).map((tag) => tag.id)]));
}

async function tableSequences(autoEnabled: boolean, ids: readonly string[]): Promise<Map<string, string[]>> {
  const rows = await readProjectionSequences(web, autoEnabled);
  return new Map(ids.map((id) => [id, rows.get(id) ?? []]));
}

function describeSequence(ids: readonly string[]): string[] {
  return ids.map((id) => slugById.get(id) ?? id);
}

describe.skipIf(!enabled).sequential("B-38 novel_effective_tag · 与改造前现场计算逐行等价（真实角色、真实迁移、真实 grants）", () => {
  beforeAll(async () => {
    await assertIsolatedDatabase(owner);
    await resetDatabase(owner);
    foundation = await seedFoundation(owner);
    for (const spec of TAG_SPECS) slugById.set(foundation.tags[spec.key]!, spec.slug);
    novels = await seedScenarioMatrix(owner, foundation);
    await seedRandomNovels(owner, foundation, 400, 20_261_009);
    // 夹具由 owner 直接写真源表（绕过写入点），所以这里要显式对账一次，把表带到"应有"状态
    await reconcileAllEffectiveTags(web);
  }, 180_000);
  afterAll(async () => { await disconnectRoles(roles); });

  it("用的是真实角色身份", async () => {
    expect(await web.$queryRaw`SELECT current_user AS role`).toEqual([{ role: "web_app" }]);
    expect(await worker.$queryRaw`SELECT current_user AS role`).toEqual([{ role: "worker_app" }]);
    expect(await scheduler.$queryRaw`SELECT current_user AS role`).toEqual([{ role: "scheduler_app" }]);
    expect(await analyst.$queryRaw`SELECT current_user AS role`).toEqual([{ role: "analyst_ro" }]);
  });

  it("夹具规模与覆盖：矩阵书 + 随机批，投影里同时有 manual / mapped / auto 三种来源与空 score", async () => {
    const ids = await allNovelIds(owner);
    expect(ids.length).toBeGreaterThanOrEqual(430);
    const stats = await owner.$queryRaw<Array<{ provenance: string; n: number; null_scores: number }>>`
      SELECT provenance, count(*)::int AS n, count(*) FILTER (WHERE score IS NULL)::int AS null_scores
      FROM novel_effective_tag GROUP BY provenance ORDER BY provenance
    `;
    expect(stats.map((row) => row.provenance)).toEqual(["auto", "manual", "mapped"]);
    for (const row of stats) expect(row.n).toBeGreaterThan(50);
    // manual / mapped 行的 score 恒为空；auto 行里既有有分数的也有分数为空的
    expect(stats.find((row) => row.provenance === "manual")!.null_scores).toBe(stats.find((row) => row.provenance === "manual")!.n);
    expect(stats.find((row) => row.provenance === "mapped")!.null_scores).toBe(stats.find((row) => row.provenance === "mapped")!.n);
    const auto = stats.find((row) => row.provenance === "auto")!;
    expect(auto.null_scores).toBeGreaterThan(0);
    expect(auto.null_scores).toBeLessThan(auto.n);
  });

  it("自动标签开：按 rank 读出的 (书, 分类) 序列与冻结参照'开'分支逐本逐行相等", async () => {
    const ids = await allNovelIds(owner);
    const expected = await legacySequences(true, ids);
    const actual = await tableSequences(true, ids);
    const mismatches = ids.filter((id) => JSON.stringify(actual.get(id)) !== JSON.stringify(expected.get(id)));
    expect(mismatches.map((id) => ({ id, expected: describeSequence(expected.get(id)!), actual: describeSequence(actual.get(id)!) }))).toEqual([]);
    // 参照本身不能是空壳：有相当数量的书带分类
    expect([...expected.values()].filter((sequence) => sequence.length > 0).length).toBeGreaterThan(150);
  });

  it("自动标签关：provenance <> 'auto' 按 rank 读出的序列与冻结参照'关'分支逐本逐行相等", async () => {
    const ids = await allNovelIds(owner);
    const expected = await legacySequences(false, ids);
    const actual = await tableSequences(false, ids);
    const mismatches = ids.filter((id) => JSON.stringify(actual.get(id)) !== JSON.stringify(expected.get(id)));
    expect(mismatches.map((id) => ({ id, expected: describeSequence(expected.get(id)!), actual: describeSequence(actual.get(id)!) }))).toEqual([]);
    expect([...expected.values()].filter((sequence) => sequence.length > 0).length).toBeGreaterThan(100);
  });

  it("来源与分数语义：manual 只出现在人工模式的书；mapped 恰是'关'分支的结果；auto 恰是'开'减'关'，score 取自 novel_canonical_tag", async () => {
    const ids = await allNovelIds(owner);
    const off = await legacySequences(false, ids);
    const on = await legacySequences(true, ids);
    const rows = await readProjectionRows(owner);

    const manualNovels = new Set((await owner.$queryRaw<Array<{ novel_id: string }>>`
      SELECT novel_id FROM novel_tag_state WHERE mode = 'manual'`).map((row) => row.novel_id));
    for (const row of rows.filter((candidate) => candidate.provenance === "manual")) expect(manualNovels.has(row.novel_id)).toBe(true);
    for (const row of rows.filter((candidate) => candidate.provenance === "mapped")) expect(manualNovels.has(row.novel_id)).toBe(false);
    for (const row of rows.filter((candidate) => candidate.provenance === "auto")) expect(manualNovels.has(row.novel_id)).toBe(false);

    for (const id of ids) {
      const base = new Set(rows.filter((row) => row.novel_id === id && row.provenance !== "auto").map((row) => row.canonical_tag_id));
      const auto = new Set(rows.filter((row) => row.novel_id === id && row.provenance === "auto").map((row) => row.canonical_tag_id));
      expect([...base].sort()).toEqual([...off.get(id)!].sort());
      expect([...new Set([...base, ...auto])].sort()).toEqual([...on.get(id)!].sort());
      expect([...auto].filter((tag) => base.has(tag))).toEqual([]);
    }

    const autoScores = await owner.$queryRaw<Array<{ bad: number }>>`
      SELECT count(*)::int AS bad
      FROM novel_effective_tag e
      JOIN novel_tag_state s ON s.novel_id = e.novel_id
      LEFT JOIN novel_canonical_tag n
        ON n.novel_id = e.novel_id AND n.canonical_tag_id = e.canonical_tag_id
       AND n.source = 'auto' AND n.classification_run_id = s.current_auto_run_id
      WHERE e.provenance = 'auto' AND n.id IS NULL OR (e.provenance = 'auto' AND n.score IS DISTINCT FROM e.score)
    `;
    expect(autoScores[0]!.bad).toBe(0);
  });

  it("rank 每本书从 0 起连续；去掉 auto 行后 base 段的 rank 仍从 0 起连续（开关关闭时顺序仍正确）", async () => {
    const rows = await readProjectionRows(owner);
    const byNovel = new Map<string, typeof rows>();
    for (const row of rows) byNovel.set(row.novel_id, [...(byNovel.get(row.novel_id) ?? []), row]);
    for (const [, list] of byNovel) {
      const ranks = list.map((row) => row.rank).sort((a, b) => a - b);
      expect(ranks).toEqual(ranks.map((_, index) => index));
      const base = list.filter((row) => row.provenance !== "auto").map((row) => row.rank).sort((a, b) => a - b);
      expect(base).toEqual(base.map((_, index) => index));
    }
  });

  it("定向断言：关键夹具书的分类序列（规则的人话版，真正的权威仍是上面的冻结参照）", async () => {
    const rows = await readProjectionRows(owner);
    const sequence = (name: string) => rows
      .filter((row) => row.novel_id === novels[name])
      .sort((a, b) => a.rank - b.rank)
      .map((row) => `${slugById.get(row.canonical_tag_id)}:${row.provenance}`);
    // 人工模式：只认人工行，映射被忽略；同 sort_order 之外按序号
    expect(sequence("manual_with_tags")).toEqual(["alpha:manual", "beta:manual"]);
    // 人工清空 = 不属于任何分类（映射与自动都被压住）
    expect(sequence("manual_cleared")).toEqual([]);
    // 映射：同 sort_order(10) 时按 slug，aaa-tie 在 alpha 前
    expect(sequence("mapped_only")).toEqual(["aaa-tie:mapped", "alpha:mapped", "beta:mapped"]);
    expect(sequence("no_state_row")).toEqual(["aaa-tie:mapped", "alpha:mapped", "beta:mapped"]);
    // 自动：分数降序，同分按 stable_id（zebra 的 stable_id 小，尽管 slug 靠后）
    expect(sequence("auto_only")).toEqual(["epsilon:auto", "zebra:auto", "aardvark:auto", "delta:auto"]);
    // 映射与自动同一分类记 mapped，其余自动行排在映射段之后
    expect(sequence("mapped_and_auto_same_tag")).toEqual(["aaa-tie:mapped", "alpha:mapped", "beta:mapped", "eta:auto"]);
    // 自动分数为空：DESC 的默认 NULLS FIRST，空分数排在前面（同为空按 stable_id）
    expect(sequence("auto_null_score")).toEqual(["delta:auto", "eta:auto", "epsilon:auto", "gamma:auto"]);
    // 一本书多个书目：并集去重
    expect(sequence("multi_source_items")).toEqual(["aaa-tie:mapped", "alpha:mapped", "beta:mapped", "gamma:mapped", "eta:mapped"]);
    // 语言范围：DE 范围走 DE 的映射
    expect(sequence("scope_de")).toEqual(["eta:mapped"]);
    // 停用分类不出现，且 rank 仍连续
    expect(sequence("mapped_tag_inactive")).toEqual(["aaa-tie:mapped", "alpha:mapped", "beta:mapped"]);
    expect(sequence("auto_tag_inactive")).toEqual(["delta:auto"]);
    // 自动打标不是当前这次 / 指针为空 / 指针指向另一次
    expect(sequence("auto_not_current_run")).toEqual(["gamma:auto"]);
    expect(sequence("auto_no_current_pointer")).toEqual([]);
    expect(sequence("auto_pointer_to_other_run")).toEqual(["omega:auto"]);
    // 残留行：自动模式里的人工行不算；人工模式里的自动行不算
    expect(sequence("automatic_with_leftover_manual")).toEqual(["gamma:mapped"]);
    expect(sequence("manual_with_leftover_auto")).toEqual(["theta:manual"]);
    // 小说软删除不影响归属规则（表里收录全部小说）
    expect(sequence("novel_soft_deleted")).toEqual(["aaa-tie:mapped", "alpha:mapped", "beta:mapped"]);
    // 一律没有：映射停用、渠道停用/禁用、书目未绑定/软删除/状态不对、语言范围空/无映射、标签 inactive、
    // 标签类型不对、大小写变体、标签没有映射、完全没有来源
    for (const name of [
      "mapping_inactive", "channel_inactive", "channel_disabled", "source_unbound", "source_soft_deleted",
      "source_status_pending", "source_status_ignored", "source_status_stale", "scope_null", "scope_unmapped",
      "label_inactive", "label_kind_recommend", "token_case_variant", "label_unmapped", "bare",
    ]) {
      expect(sequence(name), name).toEqual([]);
    }
  });

  it("迁移首建段（B38_FIRST_BUILD）与 reconcileAllEffectiveTags 的结果逐行相等：novel_id、canonical_tag_id、provenance、score、rank 全部一致，且首建后检查全 0", async () => {
    const reconciled = await readProjectionRows(owner);
    expect(reconciled.length).toBeGreaterThan(300);

    await owner.$executeRawUnsafe("TRUNCATE TABLE novel_effective_tag");
    expect(await owner.novelEffectiveTag.count()).toBe(0);
    await owner.$executeRawUnsafe(firstBuildSegment());
    const firstBuilt = await readProjectionRows(owner);

    expect(firstBuilt).toEqual(reconciled);
    expect(await checkEffectiveTags(web)).toEqual({ missing: 0, extra: 0, changed: 0, samples: [] });

    // 反方向：清空后用对账重建，结果也完全一致（对账从空表出发等价于首建）
    await owner.$executeRawUnsafe("TRUNCATE TABLE novel_effective_tag");
    const rebuilt = await reconcileAllEffectiveTags(web);
    expect(rebuilt.inserted).toBe(reconciled.length);
    expect(rebuilt.updated).toBe(0);
    expect(rebuilt.deleted).toBe(0);
    expect(await readProjectionRows(owner)).toEqual(reconciled);
  });

  it("按书范围的规则（单本 / 单页重算用）与全量规则逐行一致：清空后按每 40 本一批、再整体一批做范围重算，结果与全量对账完全相同", async () => {
    const reconciled = await readProjectionRows(owner);
    expect(reconciled.length).toBeGreaterThan(300);
    const ids = await allNovelIds(owner);

    await owner.$executeRawUnsafe("TRUNCATE TABLE novel_effective_tag");
    let inserted = 0;
    for (let offset = 0; offset < ids.length; offset += 40) {
      const batch = ids.slice(offset, offset + 40);
      const summary = await web.$transaction((tx) => refreshEffectiveTagsForNovels(tx, batch));
      expect(summary.updated + summary.deleted).toBe(0);
      inserted += summary.inserted;
    }
    expect(inserted).toBe(reconciled.length);
    expect(await readProjectionRows(owner)).toEqual(reconciled);
    expect(await checkEffectiveTags(web)).toEqual({ missing: 0, extra: 0, changed: 0, samples: [] });

    // 整体一批：稳定状态零变化
    expect(await web.$transaction((tx) => refreshEffectiveTagsForNovels(tx, ids))).toEqual({ inserted: 0, updated: 0, deleted: 0 });

    // 范围重算也会删多余行 / 改变了的行：篡改一本书的两行，只重算它
    const victim = novels.mapped_only!;
    await owner.$executeRaw`UPDATE novel_effective_tag SET rank = rank + 3 WHERE novel_id = ${victim}::uuid AND canonical_tag_id = ${foundation.tags.beta!}::uuid`;
    await owner.$executeRaw`INSERT INTO novel_effective_tag (novel_id, canonical_tag_id, provenance, score, rank)
      VALUES (${victim}::uuid, ${foundation.tags.omega!}::uuid, 'auto', 9, 9)`;
    expect(await web.$transaction((tx) => refreshEffectiveTagsForNovels(tx, [victim]))).toEqual({ inserted: 0, updated: 1, deleted: 1 });
    expect(await readProjectionRows(owner)).toEqual(reconciled);
  });

  it("稳定状态零写入：连续对账两次，第二次计数全 0；对账事务没有被分配事务号（= 一次写入都没发生），投影表没有任何行被重写（xmin 不变）", async () => {
    await reconcileAllEffectiveTags(web);
    expect(await reconcileAllEffectiveTags(web)).toEqual({ inserted: 0, updated: 0, deleted: 0 });

    const snapshotRows = () => owner.$queryRaw<Array<{ k: string; x: string }>>`
      SELECT novel_id::text || ':' || canonical_tag_id::text AS k, xmin::text AS x FROM novel_effective_tag ORDER BY 1
    `;
    const before = await snapshotRows();
    expect(before.length).toBeGreaterThan(300);

    // PostgreSQL 只在事务第一次真正写数据（或给行加锁）时才给它分配事务号：全量对账不写不锁行，
    // 所以对账结束时 pg_current_xact_id_if_assigned() 仍然是 NULL——这是"零写入"最硬的证据。
    const outcome = await web.$transaction(async (tx) => {
      const summary = await reconcileAllEffectiveTags(tx);
      const [assigned] = await tx.$queryRaw<Array<{ xid: string | null }>>`SELECT pg_current_xact_id_if_assigned()::text AS xid`;
      return { summary, xid: assigned!.xid };
    });
    expect(outcome.summary).toEqual({ inserted: 0, updated: 0, deleted: 0 });
    expect(outcome.xid).toBeNull();
    expect(await snapshotRows()).toEqual(before);

    // 对照组：真的写一次，事务号就会被分配（证明上面那个探针不是恒为 NULL）
    const control = await web.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO novel_effective_tag (novel_id, canonical_tag_id, provenance, score, rank)
        VALUES (${novels.bare!}::uuid, ${foundation.tags.omega!}::uuid, 'manual', NULL, 0)`;
      await tx.$executeRaw`DELETE FROM novel_effective_tag WHERE novel_id = ${novels.bare!}::uuid`;
      const [assigned] = await tx.$queryRaw<Array<{ xid: string | null }>>`SELECT pg_current_xact_id_if_assigned()::text AS xid`;
      return assigned!.xid;
    });
    expect(control).not.toBeNull();

    // 单本 / 多本重算在稳定状态下同样零写入（投影表的 xmin 不变；它只会对书行加锁）
    const sample = Object.values(novels).slice(0, 10);
    const single = await web.$transaction((tx) => refreshEffectiveTagsForNovels(tx, sample));
    expect(single).toEqual({ inserted: 0, updated: 0, deleted: 0 });
    expect(await snapshotRows()).toEqual(before);
  });

  it("检查命令：篡改后报告缺失 / 多余 / 内容不同并给出样例，对账修复后全 0", async () => {
    const [victim] = await owner.$queryRaw<Array<{ novel_id: string; canonical_tag_id: string }>>`
      SELECT novel_id, canonical_tag_id FROM novel_effective_tag WHERE provenance = 'mapped' ORDER BY novel_id, canonical_tag_id LIMIT 1
    `;
    const [other] = await owner.$queryRaw<Array<{ novel_id: string; canonical_tag_id: string }>>`
      SELECT novel_id, canonical_tag_id FROM novel_effective_tag WHERE provenance = 'mapped'
      ORDER BY novel_id DESC, canonical_tag_id DESC LIMIT 1
    `;
    const bare = novels.bare!;
    await owner.$executeRaw`DELETE FROM novel_effective_tag WHERE novel_id = ${victim!.novel_id}::uuid AND canonical_tag_id = ${victim!.canonical_tag_id}::uuid`;
    await owner.$executeRaw`UPDATE novel_effective_tag SET rank = rank + 7 WHERE novel_id = ${other!.novel_id}::uuid AND canonical_tag_id = ${other!.canonical_tag_id}::uuid`;
    await owner.$executeRaw`INSERT INTO novel_effective_tag (novel_id, canonical_tag_id, provenance, score, rank)
      VALUES (${bare}::uuid, ${foundation.tags.alpha!}::uuid, 'manual', NULL, 0)`;

    const broken = await checkEffectiveTags(web);
    expect(broken).toMatchObject({ missing: 1, extra: 1, changed: 1 });
    expect(broken.samples.map((sample) => sample.kind).sort()).toEqual(["changed", "extra", "missing"]);
    expect(broken.samples.find((sample) => sample.kind === "missing")).toEqual({ kind: "missing", novelId: victim!.novel_id, canonicalTagId: victim!.canonical_tag_id });
    expect(broken.samples.find((sample) => sample.kind === "extra")).toEqual({ kind: "extra", novelId: bare, canonicalTagId: foundation.tags.alpha! });

    // 检查是只读的：它自己不修复任何东西
    expect(await checkEffectiveTags(web)).toMatchObject({ missing: 1, extra: 1, changed: 1 });
    // 检查在 READ ONLY 事务里：试图在里面写会被数据库拒绝
    await expect(web.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      await tx.$executeRawUnsafe("DELETE FROM novel_effective_tag");
    })).rejects.toThrow(/read-only transaction/);

    expect(await reconcileAllEffectiveTags(web)).toEqual({ inserted: 1, updated: 1, deleted: 1 });
    expect(await checkEffectiveTags(web)).toEqual({ missing: 0, extra: 0, changed: 0, samples: [] });
  });

  it("单本重算只动这一本：篡改两本书，只重算其中一本，另一本的篡改原样留着", async () => {
    const ids = [novels.mapped_only!, novels.no_state_row!];
    await owner.$executeRaw`UPDATE novel_effective_tag SET rank = rank + 5 WHERE novel_id = ANY(${ids}::uuid[])`;
    const summary = await web.$transaction((tx) => refreshEffectiveTagsForNovels(tx, [ids[0]!]));
    expect(summary).toEqual({ inserted: 0, updated: 3, deleted: 0 });
    const check = await checkEffectiveTags(web);
    expect(check.changed).toBe(3);
    expect(check.samples.every((sample) => sample.novelId === ids[1])).toBe(true);
    await reconcileAllEffectiveTags(web);
    expect(await checkEffectiveTags(web)).toMatchObject({ missing: 0, extra: 0, changed: 0 });
  });

  it("权限：web_app / worker_app 能查增改删；analyst_ro 只能查；scheduler_app 一律 permission denied（授权矩阵 + 真实语句）", async () => {
    const matrix = await owner.$queryRaw<Array<{ role: string; select: boolean; insert: boolean; update: boolean; delete: boolean }>>`
      SELECT r AS role,
             has_table_privilege(r, 'novel_effective_tag', 'SELECT') AS "select",
             has_table_privilege(r, 'novel_effective_tag', 'INSERT') AS "insert",
             has_table_privilege(r, 'novel_effective_tag', 'UPDATE') AS "update",
             has_table_privilege(r, 'novel_effective_tag', 'DELETE') AS "delete"
      FROM unnest(ARRAY['web_app', 'worker_app', 'analyst_ro', 'scheduler_app']) AS r ORDER BY r
    `;
    expect(matrix).toEqual([
      { role: "analyst_ro", select: true, insert: false, update: false, delete: false },
      { role: "scheduler_app", select: false, insert: false, update: false, delete: false },
      { role: "web_app", select: true, insert: true, update: true, delete: true },
      { role: "worker_app", select: true, insert: true, update: true, delete: true },
    ]);

    const novel = novels.bare!;
    const tag = foundation.tags.omega!;
    for (const [name, db] of [["web_app", web], ["worker_app", worker]] as const) {
      await db.$executeRaw`INSERT INTO novel_effective_tag (novel_id, canonical_tag_id, provenance, score, rank)
        VALUES (${novel}::uuid, ${tag}::uuid, 'manual', NULL, 0)`;
      expect(await db.$queryRaw`SELECT rank FROM novel_effective_tag WHERE novel_id = ${novel}::uuid`, name).toEqual([{ rank: 0 }]);
      expect(await db.$executeRaw`UPDATE novel_effective_tag SET rank = 3 WHERE novel_id = ${novel}::uuid`, name).toBe(1);
      expect(await db.$executeRaw`DELETE FROM novel_effective_tag WHERE novel_id = ${novel}::uuid`, name).toBe(1);
    }
    expect(await analyst.$queryRaw`SELECT count(*)::int AS n FROM novel_effective_tag WHERE novel_id = ${novel}::uuid`).toEqual([{ n: 0 }]);
    for (const statement of [
      `INSERT INTO novel_effective_tag (novel_id, canonical_tag_id, provenance, score, rank) VALUES ('${novel}', '${tag}', 'manual', NULL, 0)`,
      "UPDATE novel_effective_tag SET rank = 1",
      "DELETE FROM novel_effective_tag",
    ]) {
      await expect(analyst.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET TRANSACTION READ WRITE");
        await tx.$executeRawUnsafe(statement);
      }), statement).rejects.toThrow(/permission denied for table novel_effective_tag/);
    }
    await expect(scheduler.$queryRaw`SELECT count(*) FROM novel_effective_tag`).rejects.toThrow(/permission denied for table novel_effective_tag/);
    await expect(scheduler.$executeRawUnsafe(
      `INSERT INTO novel_effective_tag (novel_id, canonical_tag_id, provenance, score, rank) VALUES ('${novel}', '${tag}', 'manual', NULL, 0)`,
    )).rejects.toThrow(/permission denied for table novel_effective_tag/);
  });

  it("物理约束：provenance 三值 CHECK、rank 非负 CHECK、同一 (书, 分类) 只能有一行、外键 CASCADE", async () => {
    const novel = novels.bare!;
    const tag = foundation.tags.omega!;
    await expect(owner.$executeRaw`INSERT INTO novel_effective_tag (novel_id, canonical_tag_id, provenance, score, rank)
      VALUES (${novel}::uuid, ${tag}::uuid, 'guess', NULL, 0)`).rejects.toThrow(/novel_effective_tag_provenance_check/);
    await expect(owner.$executeRaw`INSERT INTO novel_effective_tag (novel_id, canonical_tag_id, provenance, score, rank)
      VALUES (${novel}::uuid, ${tag}::uuid, 'manual', NULL, -1)`).rejects.toThrow(/novel_effective_tag_rank_check/);
    await owner.$executeRaw`INSERT INTO novel_effective_tag (novel_id, canonical_tag_id, provenance, score, rank)
      VALUES (${novel}::uuid, ${tag}::uuid, 'manual', NULL, 0)`;
    await expect(owner.$executeRaw`INSERT INTO novel_effective_tag (novel_id, canonical_tag_id, provenance, score, rank)
      VALUES (${novel}::uuid, ${tag}::uuid, 'mapped', NULL, 1)`).rejects.toThrow(/already exists|duplicate key|23505/);
    // 书被硬删 → 归属行跟着走
    await owner.$executeRaw`DELETE FROM novel WHERE id = ${novel}::uuid`;
    expect(await owner.novelEffectiveTag.count({ where: { novelId: novel } })).toBe(0);
    await reconcileAllEffectiveTags(web);
    expect(await checkEffectiveTags(web)).toMatchObject({ missing: 0, extra: 0, changed: 0 });
  });

  it("事务闸：传入真实的完整 PrismaClient 抛错；传入真实的事务客户端放行（运行时判别式对真实 Prisma 事务客户端成立）", async () => {
    await expect(refreshEffectiveTagsForNovels(web as never, [novels.mapped_only!])).rejects.toThrow("必须在事务里调用");
    await expect(refreshEffectiveTagsForNovels(worker as never, [novels.mapped_only!])).rejects.toThrow("必须在事务里调用");
    await expect(web.$transaction((tx) => refreshEffectiveTagsForNovels(tx, [novels.mapped_only!]))).resolves.toEqual({ inserted: 0, updated: 0, deleted: 0 });
    await expect(worker.$transaction((tx) => refreshEffectiveTagsForNovels(tx, [novels.mapped_only!]))).resolves.toEqual({ inserted: 0, updated: 0, deleted: 0 });
  });
});
