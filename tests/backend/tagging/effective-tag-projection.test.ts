/**
 * B-38 `src/server/tagging/effective-tag-projection.ts` 的单元层契约（不连数据库）：
 * 运行时事务闸、咨询锁、分块、去重排序、计数汇总，以及规则 SQL 里"不许被优化掉"的关键文本。
 * 规则的语义等价（与改造前现场计算逐行相等）由真实库用例
 * `tests/integration/tagging/effective-tag-projection-postgres.test.ts` 证明。
 */
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  buildEffectiveTagFirstBuildSql,
  checkEffectiveTags,
  EFFECTIVE_TAG_NOVEL_ID_CHUNK_SIZE,
  EFFECTIVE_TAG_PROJECTION_ADVISORY_LOCK,
  EFFECTIVE_TAG_RECONCILE_TRANSACTION_TIMEOUT_MS,
  lockEffectiveTagProjectionExclusive,
  lockEffectiveTagProjectionShared,
  reconcileAllEffectiveTags,
  refreshEffectiveTagsForNovels,
} from "@/server/tagging/effective-tag-projection";

type RecordedStatement = { sql: string; values: unknown[] };

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** 事务客户端替身：没有 `$transaction`（和真实 Prisma 事务客户端一样），按 SQL 文本给出替身结果。 */
function fakeTx(options: { apply?: () => Array<{ inserted: number; updated: number; deleted: number }> } = {}) {
  const statements: RecordedStatement[] = [];
  const tx = {
    $queryRaw: vi.fn(async (statement: Prisma.Sql) => {
      statements.push({ sql: statement.sql, values: [...statement.values] });
      if (statement.sql.includes("INSERT INTO novel_effective_tag")) {
        return options.apply ? options.apply() : [{ inserted: 0, updated: 0, deleted: 0 }];
      }
      return [];
    }),
    $executeRawUnsafe: vi.fn(async () => 0),
  };
  return { tx: tx as unknown as Prisma.TransactionClient, statements, raw: tx };
}

function kindOf(sql: string): "lock_shared" | "lock_exclusive" | "lock_novels" | "apply" | "check" | "other" {
  if (sql.includes("pg_advisory_xact_lock_shared")) return "lock_shared";
  if (sql.includes("pg_advisory_xact_lock")) return "lock_exclusive";
  if (sql.includes("FOR NO KEY UPDATE")) return "lock_novels";
  if (sql.includes("INSERT INTO novel_effective_tag")) return "apply";
  if (sql.includes("'summary'::text")) return "check";
  return "other";
}

function wsNormalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

describe("effective-tag projection · 咨询锁常量", () => {
  it("命名空间 50212、作用域 1，不和 50210（站点地图刷新）/ 50211（调度器入队）撞", () => {
    expect(EFFECTIVE_TAG_PROJECTION_ADVISORY_LOCK).toEqual({ namespace: 50_212, scope: 1 });
    expect(Object.isFrozen(EFFECTIVE_TAG_PROJECTION_ADVISORY_LOCK)).toBe(true);
  });
});

describe("refreshEffectiveTagsForNovels · 运行时事务闸", () => {
  it("传进来的是完整 PrismaClient（有 $transaction）→ 直接抛错，一条 SQL 都不发", async () => {
    const wholeClient = { $transaction: vi.fn(), $queryRaw: vi.fn() };
    await expect(refreshEffectiveTagsForNovels(wholeClient as never, [uuid(1)])).rejects.toThrow("必须在事务里调用");
    expect(wholeClient.$queryRaw).not.toHaveBeenCalled();
  });

  it("空书单也先过闸（传错对象的调用方不会因为恰好没有书而被放过）", async () => {
    const wholeClient = { $transaction: vi.fn(), $queryRaw: vi.fn() };
    await expect(refreshEffectiveTagsForNovels(wholeClient as never, [])).rejects.toThrow("必须在事务里调用");
  });

  it("两把锁也是同一个闸", async () => {
    const wholeClient = { $transaction: vi.fn(), $queryRaw: vi.fn() };
    await expect(lockEffectiveTagProjectionShared(wholeClient as never)).rejects.toThrow("必须在事务里调用");
    await expect(lockEffectiveTagProjectionExclusive(wholeClient as never)).rejects.toThrow("必须在事务里调用");
  });
});

describe("refreshEffectiveTagsForNovels · 执行顺序与分块", () => {
  it("空书单：不发任何 SQL，返回零计数", async () => {
    const { tx, statements } = fakeTx();
    await expect(refreshEffectiveTagsForNovels(tx, [])).resolves.toEqual({ inserted: 0, updated: 0, deleted: 0 });
    expect(statements).toEqual([]);
  });

  it("一块以内：共享咨询锁 → 对书行加 FOR NO KEY UPDATE → 比对写入，各一次，顺序固定", async () => {
    const { tx, statements } = fakeTx({ apply: () => [{ inserted: 2, updated: 1, deleted: 3 }] });
    const result = await refreshEffectiveTagsForNovels(tx, [uuid(2), uuid(1)]);
    expect(result).toEqual({ inserted: 2, updated: 1, deleted: 3 });
    expect(statements.map((statement) => kindOf(statement.sql))).toEqual(["lock_shared", "lock_novels", "apply"]);
    expect(statements[0]!.values).toEqual([50_212, 1]);
  });

  it("书 id 去重并按升序排序：行锁按固定顺序取，避免两个重算互相等待成环", async () => {
    const { tx, statements } = fakeTx();
    await refreshEffectiveTagsForNovels(tx, [uuid(3), uuid(1), uuid(3), uuid(2)]);
    const lockNovels = statements.find((statement) => kindOf(statement.sql) === "lock_novels")!;
    expect(lockNovels.values).toEqual([uuid(1), uuid(2), uuid(3)]);
    expect(lockNovels.sql).toMatch(/ORDER BY n\.id\s+FOR NO KEY UPDATE/);
  });

  it("超过一块按 2,000 分块：共享锁只拿一次，每块各自 行锁 + 比对写入，计数累加", async () => {
    expect(EFFECTIVE_TAG_NOVEL_ID_CHUNK_SIZE).toBe(2_000);
    const ids = Array.from({ length: 4_500 }, (_, index) => uuid(index + 1));
    let call = 0;
    const { tx, statements } = fakeTx({ apply: () => [{ inserted: 1, updated: 2, deleted: ++call }] });
    const result = await refreshEffectiveTagsForNovels(tx, ids);
    expect(result).toEqual({ inserted: 3, updated: 6, deleted: 1 + 2 + 3 });
    expect(statements.map((statement) => kindOf(statement.sql))).toEqual([
      "lock_shared",
      "lock_novels", "apply",
      "lock_novels", "apply",
      "lock_novels", "apply",
    ]);
    // 绑定变量上限：同一组 id 在一条比对写入语句里出现 4 次，必须远低于 Prisma 的 32,767。
    const apply = statements.filter((statement) => kindOf(statement.sql) === "apply");
    expect(apply.map((statement) => statement.values.length)).toEqual([8_000, 8_000, 2_000]);
    expect(Math.max(...apply.map((statement) => statement.values.length))).toBeLessThan(32_767);
  });

  it("比对写入语句用 FULL JOIN 求差异，只对差异行做 DELETE / UPDATE / INSERT（不是对全表的 NOT EXISTS）", async () => {
    const { tx, statements } = fakeTx();
    await refreshEffectiveTagsForNovels(tx, [uuid(1)]);
    const apply = wsNormalize(statements.find((statement) => kindOf(statement.sql) === "apply")!.sql);
    expect(apply).toContain("diff AS MATERIALIZED ( SELECT COALESCE(d.novel_id, c.novel_id) AS novel_id");
    expect(apply).toContain("FROM desired d FULL JOIN cur c ON d.novel_id = c.novel_id AND d.canonical_tag_id = c.canonical_tag_id");
    expect(apply).toMatch(/del AS \( DELETE FROM novel_effective_tag target USING diff x WHERE x\.only_current/);
    expect(apply).toMatch(/upd AS \( UPDATE novel_effective_tag target SET provenance = x\.want_provenance, score = x\.want_score, rank = x\.want_rank, computed_at = now\(\) FROM diff x WHERE NOT x\.only_current AND NOT x\.only_desired/);
    expect(apply).toMatch(/ins AS \( INSERT INTO novel_effective_tag \(novel_id, canonical_tag_id, provenance, score, rank\) SELECT x\.novel_id, x\.canonical_tag_id, x\.want_provenance, x\.want_score, x\.want_rank FROM diff x WHERE x\.only_desired/);
    // 整条语句只剩人工模式排除这一处 NOT EXISTS
    expect(apply.match(/NOT EXISTS/g)).toHaveLength(1);
  });

  it("比对写入语句没返回汇总行 → 抛错（不是悄悄当成 0）", async () => {
    const { tx } = fakeTx({ apply: () => [] });
    await expect(refreshEffectiveTagsForNovels(tx, [uuid(1)])).rejects.toThrow("no summary row");
  });
});

describe("reconcileAllEffectiveTags", () => {
  it("传事务客户端：就在调用方事务里执行，先独占咨询锁、再比对写入，自己不开新事务", async () => {
    const { tx, statements } = fakeTx({ apply: () => [{ inserted: 0, updated: 4, deleted: 0 }] });
    await expect(reconcileAllEffectiveTags(tx)).resolves.toEqual({ inserted: 0, updated: 4, deleted: 0 });
    expect(statements.map((statement) => kindOf(statement.sql))).toEqual(["lock_exclusive", "apply"]);
    expect(statements[0]!.values).toEqual([50_212, 1]);
    // 全量版本不带任何 id 列表：除了锁的两个整数，没有别的绑定变量
    expect(statements[1]!.values).toEqual([]);
  });

  it("传完整 PrismaClient：自己开一个 ReadCommitted 事务，超时放宽到 60 秒（Prisma 默认只有 5 秒）", async () => {
    const { tx } = fakeTx();
    const transaction = vi.fn(async (callback: (client: Prisma.TransactionClient) => Promise<unknown>, options: unknown) => {
      void options;
      return callback(tx);
    });
    const client = { $transaction: transaction };
    await reconcileAllEffectiveTags(client as never);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0]![1]).toMatchObject({
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: EFFECTIVE_TAG_RECONCILE_TRANSACTION_TIMEOUT_MS,
    });
    expect(EFFECTIVE_TAG_RECONCILE_TRANSACTION_TIMEOUT_MS).toBe(60_000);
  });
});

describe("checkEffectiveTags", () => {
  it("先把事务标成 READ ONLY，再用一条语句取汇总与样例", async () => {
    const calls: string[] = [];
    const tx = {
      $executeRawUnsafe: vi.fn(async (sql: string) => { calls.push(sql); return 0; }),
      $queryRaw: vi.fn(async (statement: Prisma.Sql) => {
        calls.push(kindOf(statement.sql));
        return [
          { kind: "summary", novel_id: null, canonical_tag_id: null, missing: 1, extra: 2, changed: 3 },
          { kind: "missing", novel_id: uuid(1), canonical_tag_id: uuid(9), missing: null, extra: null, changed: null },
          { kind: "changed", novel_id: uuid(2), canonical_tag_id: uuid(8), missing: null, extra: null, changed: null },
        ];
      }),
    };
    const result = await checkEffectiveTags(tx as never);
    expect(calls).toEqual(["SET TRANSACTION READ ONLY", "check"]);
    expect(result).toEqual({
      missing: 1,
      extra: 2,
      changed: 3,
      samples: [
        { kind: "missing", novelId: uuid(1), canonicalTagId: uuid(9) },
        { kind: "changed", novelId: uuid(2), canonicalTagId: uuid(8) },
      ],
    });
  });

  it("传完整 PrismaClient：在自己开的事务里做（同样先 READ ONLY）", async () => {
    const inner = {
      $executeRawUnsafe: vi.fn(async () => 0),
      $queryRaw: vi.fn(async () => [{ kind: "summary", novel_id: null, canonical_tag_id: null, missing: 0, extra: 0, changed: 0 }]),
    };
    const client = { $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(inner)) };
    await expect(checkEffectiveTags(client as never)).resolves.toEqual({ missing: 0, extra: 0, changed: 0, samples: [] });
    expect(client.$transaction).toHaveBeenCalledTimes(1);
    expect(inner.$executeRawUnsafe).toHaveBeenCalledWith("SET TRANSACTION READ ONLY");
  });
});

describe("规则 SQL · 不许被'优化'掉的关键文本（语义由真实库等价矩阵证明，这里只是防误删的第一道闸）", () => {
  const sql = wsNormalize(buildEffectiveTagFirstBuildSql());

  it("target_source_item 保持 AS MATERIALIZED（统计信息缺失时防坏计划，见 public-taxonomy.ts 长注释）", () => {
    expect(sql).toContain("target_source_item AS MATERIALIZED (");
  });

  it("映射比较保持 COLLATE \"C\" 逐字节比较（范围与原始词两处，两侧都显式写）", () => {
    expect(sql).toContain('e.raw_language_scope COLLATE "C" = il.raw_language_scope COLLATE "C"');
    expect(sql).toContain('slm.raw_token COLLATE "C" = sl.external_label_value::text COLLATE "C"');
  });

  it("只收启用中的分类；同一 (书, 分类) 在 base 与 auto 里都有时留 base（DISTINCT ON … ORDER BY source_rank）", () => {
    expect(sql).toContain("JOIN canonical_tag ct ON ct.id = membership.canonical_tag_id AND ct.status = 'active'");
    expect(sql).toContain("SELECT DISTINCT ON (candidate.novel_id, candidate.canonical_tag_id)");
    expect(sql).toContain("SELECT * FROM base_membership UNION ALL SELECT * FROM auto_membership");
    expect(sql).toContain("ORDER BY candidate.novel_id, candidate.canonical_tag_id, candidate.source_rank");
  });

  it("计划稳定性：映射支路先物化 item_label 与很小的 active_edge，再做三列等值连接；整条 SQL 里只有一处 NOT EXISTS（人工模式排除），没有两个无统计 CTE 之间的反连接", () => {
    expect(sql).toContain("item_label AS MATERIALIZED (");
    expect(sql).toContain("active_edge AS MATERIALIZED (");
    expect(sql).toContain("FROM item_label il JOIN active_edge e ON e.source_label_id = il.source_label_id AND e.channel_app_id = il.channel_app_id");
    expect(sql.match(/NOT EXISTS/g)).toHaveLength(1);
    expect(sql).toMatch(/NOT EXISTS \( SELECT 1 FROM novel_tag_state nts WHERE nts\.novel_id = il\.novel_id AND nts\.mode = 'manual' \)/);
    // 旧写法的逐书目连接 mapping 已经不在了
    expect(sql).not.toMatch(/FROM target_source_item tsi JOIN channel_app ca/);
  });

  it("映射边的启用渠道 / series_type / 同渠道 / 活跃条件都在 active_edge 里", () => {
    expect(sql).toContain("JOIN channel_app ca ON ca.id = sl.channel_app_id AND ca.status = 'active'");
    expect(sql).toContain("ON slm.channel_app_id = sl.channel_app_id");
    expect(sql).toContain("AND slm.active IS TRUE WHERE sl.label_kind = 'series_type'");
  });

  it("rank 的排序表达式原样复制自改造前'自动开'分支（含 score DESC，不加 NULLS LAST）", () => {
    expect(sql).toContain(
      "ORDER BY membership.source_rank, CASE WHEN membership.source_rank = 0 THEN ct.sort_order END, "
      + "CASE WHEN membership.source_rank = 0 THEN ct.slug END, "
      + "CASE WHEN membership.source_rank = 1 THEN membership.score END DESC, "
      + "CASE WHEN membership.source_rank = 1 THEN ct.stable_id END, ct.id",
    );
    expect(sql).not.toMatch(/NULLS (FIRST|LAST)/);
    expect(sql).toContain("PARTITION BY membership.novel_id");
  });

  it("人工模式的书只认人工行、其余书走映射（NOT EXISTS 人工状态）", () => {
    expect(sql).toContain("JOIN novel_tag_state nts ON nts.novel_id = nct.novel_id AND nts.mode = 'manual'");
    expect(sql).toMatch(/WHERE NOT EXISTS \( SELECT 1 FROM novel_tag_state nts WHERE nts\.novel_id = il\.novel_id AND nts\.mode = 'manual' \)/);
  });

  it("自动段只认 mode = 'automatic' 且 classification_run_id = current_auto_run_id 且 source = 'auto'", () => {
    expect(sql).toContain("nct.classification_run_id = nts.current_auto_run_id");
    expect(sql).toContain("nct.source = 'auto'");
    expect(sql).toContain("nts.mode = 'automatic'");
  });

  it("全量版本不带任何 IN 列表、也没有绑定变量", () => {
    expect(buildEffectiveTagFirstBuildSql()).not.toMatch(/\$\d/);
    expect(sql).not.toMatch(/ IN \(/);
  });
});
