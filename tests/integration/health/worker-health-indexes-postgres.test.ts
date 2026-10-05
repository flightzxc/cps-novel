import { readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  EXPIRED_LOCKS_QUERY,
  LAST_HEARTBEAT_QUERY,
  evaluateWorkerStatus,
} from "@/server/health/worker-status";

/**
 * Worker 健康检查冷缓存超时误报 503（2026-10-05 生产只读实证）的真实库证据。
 *
 * 根因：`/api/health/worker` 的"最近心跳"查询在 `generic_task_item`（生产约 36.8 万行 /
 * 496 MB）和 `channel_sync_task_item`（约 8 万行）上没有任何索引覆盖 `heartbeat_at`，
 * 整表顺序扫描，缓存冷时 1.5 s，越过 `HEALTH_DATABASE_TIMEOUT_MS = 1500`。修复 = 迁移
 * `20261005100000_worker_health_partial_indexes` 的两个部分索引 + 心跳查询改写。
 * 过期锁查询由初始迁移早已存在的 `*_expired_lease_idx` 服务，本修复不新增索引，这里同样
 * 用 EXPLAIN 钉住"它确实走那个索引"。
 *
 * 本文件在一次性 PostgreSQL 16.14 上造接近生产规模的数据，然后：
 *   1. 基线：撤掉两个心跳索引（= 迁移前的生产状态），证明旧写法心跳查询对两张大表都是
 *      Seq Scan；过期锁查询在基线下就已走既有的 `*_expired_lease_idx`；并在回滚的事务里
 *      撤掉既有索引做对照，证明"走索引"这条断言本身是灵敏的；
 *   2. 执行迁移 SQL 本身（事务内逐条计时，模拟 Prisma 的整文件事务），核对新索引与既有
 *      索引的物理定义与体积；
 *   3. 用 `EXPLAIN (ANALYZE, BUFFERS)` 证明发布的两条查询对两张表都走部分索引、不再有
 *      Seq Scan，且缓冲区读取量是个位数的页，与表的历史规模无关；
 *   4. 新旧查询在同一份数据上结果逐值相等（语义不变）；
 *   5. `evaluateWorkerStatus` 在真实 web_app 角色下的 ok / degraded 端到端输出。
 *
 * 判据用的是执行计划与缓冲区页数，不是墙钟时间——时间受机器负载影响，计划和页数不会。
 * 墙钟时间只打印（`WORKER_HEALTH_PLAN`/`WORKER_HEALTH_INDEX_BUILD` 行）供人看。
 *
 * 变异约定：删掉迁移里任一心跳索引 → 第 3 步断言红；把 `LAST_HEARTBEAT_QUERY` 改回旧写法
 * → 第 3 步心跳断言红；把过期锁查询的 `i.status = 'processing'` 谓词改掉 → 第 3 步
 * 过期锁断言红。
 *
 * 规模可调：WORKER_HEALTH_INDEX_GENERIC_ROWS（默认 400000）、
 * WORKER_HEALTH_INDEX_SYNC_ROWS（默认 80000）、WORKER_HEALTH_INDEX_PAYLOAD_BYTES
 * （默认 300；约 1200 时 generic_task_item 堆约 500 MB，接近生产体积）。
 */
const enabled = process.env.WORKER_HEALTH_INDEX_DATABASE_TEST === "1";

function intEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const GENERIC_ROWS = intEnv("WORKER_HEALTH_INDEX_GENERIC_ROWS", 400_000);
const SYNC_ROWS = intEnv("WORKER_HEALTH_INDEX_SYNC_ROWS", 80_000);
const PAYLOAD_BYTES = intEnv("WORKER_HEALTH_INDEX_PAYLOAD_BYTES", 300);
const GENERIC_PARENTS = 8;
const SYNC_PARENTS = 4;

const owner = new PrismaClient({ datasourceUrl: process.env.WORKER_HEALTH_INDEX_OWNER_DATABASE_URL });
const web = new PrismaClient({ datasourceUrl: process.env.WORKER_HEALTH_INDEX_WEB_DATABASE_URL });

const MIGRATION_PATH = path.resolve(
  process.cwd(),
  "prisma/migrations/20261005100000_worker_health_partial_indexes/migration.sql",
);

/** 迁移改写之前的心跳查询，原样保留，用来证明"旧写法没有索引可用"和"新旧结果相等"。 */
const LEGACY_HEARTBEAT_SQL = `
  SELECT max(heartbeat_at) AS last_heartbeat_at
  FROM (
    SELECT heartbeat_at FROM channel_sync_task_item WHERE heartbeat_at IS NOT NULL
    UNION ALL
    SELECT heartbeat_at FROM generic_task_item WHERE heartbeat_at IS NOT NULL
  ) AS heartbeats
`;

/** 本迁移新增的两个部分索引。 */
const EXPECTED_INDEXES = [
  {
    name: "generic_task_item_heartbeat_idx",
    table: "generic_task_item",
    definition:
      "CREATE INDEX generic_task_item_heartbeat_idx ON public.generic_task_item USING btree (heartbeat_at) WHERE (heartbeat_at IS NOT NULL)",
  },
  {
    name: "channel_sync_task_item_heartbeat_idx",
    table: "channel_sync_task_item",
    definition:
      "CREATE INDEX channel_sync_task_item_heartbeat_idx ON public.channel_sync_task_item USING btree (heartbeat_at) WHERE (heartbeat_at IS NOT NULL)",
  },
] as const;

/** 初始迁移早已存在、过期锁查询赖以走索引的既有部分索引（本迁移不动它们）。 */
const EXISTING_EXPIRED_LEASE_INDEXES = [
  {
    name: "generic_task_item_expired_lease_idx",
    table: "generic_task_item",
    definition:
      "CREATE INDEX generic_task_item_expired_lease_idx ON public.generic_task_item USING btree (locked_until, id) WHERE (((status)::text = 'processing'::text) AND (locked_until IS NOT NULL))",
  },
  {
    name: "channel_sync_task_item_expired_lease_idx",
    table: "channel_sync_task_item",
    definition:
      "CREATE INDEX channel_sync_task_item_expired_lease_idx ON public.channel_sync_task_item USING btree (locked_until, id) WHERE (((status)::text = 'processing'::text) AND (locked_until IS NOT NULL))",
  },
] as const;

const ITEM_TABLES = ["generic_task_item", "channel_sync_task_item"] as const;

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Scan Direction"?: string;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  "Actual Total Time"?: number;
  "Actual Rows"?: number;
  Plans?: PlanNode[];
}

interface ExplainResult {
  root: PlanNode;
  executionMs: number;
  buffers: number;
  nodes: PlanNode[];
}

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

async function explain(db: PrismaClient, sql: string): Promise<ExplainResult> {
  const rows = await db.$queryRawUnsafe<Array<{ "QUERY PLAN": unknown }>>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
  );
  const raw = rows[0]["QUERY PLAN"];
  const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as Array<{
    Plan: PlanNode;
    "Execution Time": number;
  }>;
  const root = parsed[0].Plan;
  return {
    root,
    executionMs: parsed[0]["Execution Time"],
    buffers: (root["Shared Hit Blocks"] ?? 0) + (root["Shared Read Blocks"] ?? 0),
    nodes: flatten(root),
  };
}

function describePlan(result: ExplainResult) {
  return {
    executionMs: Math.round(result.executionMs * 100) / 100,
    sharedBlocks: result.buffers,
    scans: result.nodes
      .filter((node) => node["Relation Name"] && /Scan/.test(node["Node Type"]))
      .map(
        (node) =>
          `${node["Node Type"]}${node["Scan Direction"] === "Backward" ? " Backward" : ""}:${node["Relation Name"]}${node["Index Name"] ? `@${node["Index Name"]}` : ""}`,
      ),
  };
}

function scansOn(result: ExplainResult, table: string): PlanNode[] {
  return result.nodes.filter((node) => node["Relation Name"] === table && /Scan/.test(node["Node Type"]));
}

/** 一个表上"没有 Seq Scan，且至少有一个节点通过指定的部分索引读取"。 */
function expectUsesIndexNotSeqScan(result: ExplainResult, table: string, indexName: string) {
  const scans = scansOn(result, table);
  expect(scans.length, `${table} 必须出现在执行计划里`).toBeGreaterThan(0);
  expect(
    scans.filter((node) => /Seq Scan/.test(node["Node Type"])),
    `${table} 不得 Seq Scan，计划=${JSON.stringify(describePlan(result))}`,
  ).toEqual([]);
  const indexNames = result.nodes.map((node) => node["Index Name"]).filter(Boolean);
  expect(indexNames, `${table} 必须经由 ${indexName} 读取`).toContain(indexName);
}

/**
 * 心跳探针的形状：每表恰好一次"索引末端 Backward 扫描"，最多读 1 行——与在途行数无关，
 * 是 O(1)。旧写法即使有了索引，也只是对全部非空心跳做 Index Only Scan（O(在途行数)），
 * 这条断言正是为了把"改回旧写法"变异抓红。
 */
function expectHeartbeatProbeIsOneRowBackwardScan(result: ExplainResult, table: string, indexName: string) {
  expectUsesIndexNotSeqScan(result, table, indexName);
  const probes = scansOn(result, table).filter((node) => node["Index Name"] === indexName);
  expect(probes, `${table} 的心跳索引必须恰好被探测一次，计划=${JSON.stringify(describePlan(result))}`).toHaveLength(1);
  expect(probes[0]["Scan Direction"], `${table} 必须是索引末端的 Backward 扫描`).toBe("Backward");
  expect(probes[0]["Actual Rows"] ?? Number.POSITIVE_INFINITY, `${table} 心跳探针最多读 1 行`).toBeLessThanOrEqual(1);
}

function splitStatements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function seed() {
  const ids = {
    channel: "00000000-0000-4000-8000-0000000b0001",
    source: "00000000-0000-4000-8000-0000000b0002",
    app: "00000000-0000-4000-8000-0000000b0003",
    account: "00000000-0000-4000-8000-0000000b0004",
  } as const;
  await owner.channel.create({ data: { id: ids.channel, code: "whi-channel", name: "WHI Channel" } });
  await owner.sourceApp.create({ data: { id: ids.source, code: "whi-source", name: "WHI Source" } });
  await owner.channelApp.create({
    data: { id: ids.app, channelId: ids.channel, sourceAppId: ids.source, externalAppId: "whi-app", projectType: 2 },
  });
  await owner.channelAccount.create({
    data: { id: ids.account, channelId: ids.channel, businessId: "whi-account", accountName: "WHI Account" },
  });

  // generic 父任务：全部 completed，避免命中"同 scope 单 active"唯一索引。
  await owner.$executeRawUnsafe(`
    INSERT INTO generic_task (id, task_type, operation_scope_hash, request_token, status, updated_at)
    SELECT gen_random_uuid(), 'worker_health_seed', lpad(to_hex(g), 64, '0'), 'whi-generic-' || g,
           'completed', now()
    FROM generate_series(1, ${GENERIC_PARENTS}) g
  `);
  // 生产形态：绝大多数 item 已是终态，租约字段全为 NULL（store.ts 完成时把它们清空）。
  await owner.$executeRawUnsafe(`
    INSERT INTO generic_task_item
      (id, task_id, target_type, target_id, status, attempt_count, payload, result,
       started_at, finished_at, updated_at)
    SELECT gen_random_uuid(), p.id, 'seed_page', g::text,
           CASE WHEN g % 25 = 0 THEN 'failed' WHEN g % 9 = 0 THEN 'skipped' ELSE 'success' END,
           1,
           jsonb_build_object('pad', repeat('x', ${PAYLOAD_BYTES})),
           jsonb_build_object('ok', true, 'seq', g),
           now() - interval '3 days', now() - interval '3 days', now() - interval '3 days'
    FROM generate_series(1, ${GENERIC_ROWS}) g
    JOIN (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM generic_task) p
      ON p.rn = (g % ${GENERIC_PARENTS}) + 1
  `);
  // 在途行：5 条租约已过期（应被计为过期锁）+ 7 条租约未到期；心跳各不相同。
  await owner.$executeRawUnsafe(`
    INSERT INTO generic_task_item
      (id, task_id, target_type, target_id, status, attempt_count, execution_token, lease_epoch,
       locked_by, locked_until, heartbeat_at, started_at, updated_at)
    SELECT gen_random_uuid(), (SELECT id FROM generic_task ORDER BY id LIMIT 1), 'seed_inflight',
           'inflight-' || g, 'processing', 1, gen_random_uuid(), 1, 'whi-worker-' || g,
           CASE WHEN g <= 5 THEN now() - (g || ' minutes')::interval
                ELSE now() + (g || ' minutes')::interval END,
           now() - (g || ' seconds')::interval,
           now() - interval '10 minutes', now()
    FROM generate_series(1, 12) g
  `);
  // 终态之外再放一批 pending（租约字段必须全 NULL，CHECK 强制）。
  await owner.$executeRawUnsafe(`
    INSERT INTO generic_task_item (id, task_id, target_type, target_id, status, updated_at)
    SELECT gen_random_uuid(), (SELECT id FROM generic_task ORDER BY id LIMIT 1), 'seed_pending',
           'pending-' || g, 'pending', now()
    FROM generate_series(1, 2000) g
  `);

  await owner.$executeRawUnsafe(`
    INSERT INTO channel_sync_task
      (id, task_type, channel_account_id, channel_app_id, operation_scope_hash, request_token, status, updated_at)
    SELECT gen_random_uuid(), 'worker_health_seed', '${ids.account}'::uuid, '${ids.app}'::uuid,
           lpad(to_hex(g), 64, '0'), 'whi-sync-' || g, 'completed', now()
    FROM generate_series(1, ${SYNC_PARENTS}) g
  `);
  await owner.$executeRawUnsafe(`
    INSERT INTO novel_source_item
      (id, channel_app_id, external_book_id, source_language_code, title, description, raw_payload, updated_at)
    SELECT gen_random_uuid(), '${ids.app}'::uuid, 'whi-book-' || g, 'en', 'Title ' || g, 'd', '{}'::jsonb, now()
    FROM generate_series(1, ${SYNC_ROWS}) g
  `);
  await owner.$executeRawUnsafe(`
    INSERT INTO channel_sync_task_item
      (id, task_id, novel_source_item_id, status, attempt_count, payload, result,
       started_at, finished_at, updated_at)
    SELECT gen_random_uuid(), p.id, s.id,
           CASE WHEN s.rn % 30 = 0 THEN 'failed' ELSE 'success' END, 1,
           jsonb_build_object('pad', repeat('x', ${PAYLOAD_BYTES})),
           jsonb_build_object('ok', true),
           now() - interval '3 days', now() - interval '3 days', now() - interval '3 days'
    FROM (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM novel_source_item) s
    JOIN (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM channel_sync_task) p
      ON p.rn = (s.rn % ${SYNC_PARENTS}) + 1
  `);
  // channel_sync：2 条过期 + 2 条未过期的在途行，借用已存在的 source item（换成新的 source item 以满足唯一键）。
  await owner.$executeRawUnsafe(`
    INSERT INTO novel_source_item
      (id, channel_app_id, external_book_id, source_language_code, title, description, raw_payload, updated_at)
    SELECT gen_random_uuid(), '${ids.app}'::uuid, 'whi-inflight-' || g, 'en', 'Inflight ' || g, 'd', '{}'::jsonb, now()
    FROM generate_series(1, 4) g
  `);
  await owner.$executeRawUnsafe(`
    INSERT INTO channel_sync_task_item
      (id, task_id, novel_source_item_id, status, attempt_count, execution_token, lease_epoch,
       locked_by, locked_until, heartbeat_at, started_at, updated_at)
    SELECT gen_random_uuid(), (SELECT id FROM channel_sync_task ORDER BY id LIMIT 1), s.id,
           'processing', 1, gen_random_uuid(), 1, 'whi-sync-worker-' || s.rn,
           CASE WHEN s.rn <= 2 THEN now() - (s.rn || ' minutes')::interval
                ELSE now() + (s.rn || ' minutes')::interval END,
           now() - ((s.rn + 20) || ' seconds')::interval,
           now() - interval '10 minutes', now()
    FROM (SELECT id, row_number() OVER (ORDER BY id) AS rn
          FROM novel_source_item WHERE external_book_id LIKE 'whi-inflight-%') s
  `);
}

async function dropWorkerHealthIndexes() {
  for (const index of EXPECTED_INDEXES) {
    await owner.$executeRawUnsafe(`DROP INDEX IF EXISTS "${index.name}"`);
  }
}

describe.skipIf(!enabled).sequential("worker health partial indexes on disposable PostgreSQL 16.14", () => {
  const baseline: Record<string, ReturnType<typeof describePlan>> = {};

  beforeAll(async () => {
    const [database] = await owner.$queryRaw<Array<{ name: string; version: string }>>`
      SELECT current_database() AS name, current_setting('server_version') AS version
    `;
    if (!database.name.startsWith("cps_novel_worker_health_")) {
      throw new Error(`Refusing worker-health index setup against ${database.name}`);
    }
    if (!database.version.startsWith("16.14")) {
      throw new Error(`PostgreSQL 16.14 required, got ${database.version}`);
    }
    const started = performance.now();
    await seed();
    await owner.$executeRawUnsafe("VACUUM (ANALYZE) generic_task_item");
    await owner.$executeRawUnsafe("VACUUM (ANALYZE) channel_sync_task_item");
    const sizes = await owner.$queryRaw<Array<{ rel: string; rows: bigint; heap_mb: number; total_mb: number }>>`
      SELECT c.relname AS rel, c.reltuples::bigint AS rows,
             round(pg_relation_size(c.oid) / 1048576.0, 1)::float AS heap_mb,
             round(pg_total_relation_size(c.oid) / 1048576.0, 1)::float AS total_mb
      FROM pg_class c WHERE c.relname IN ('generic_task_item', 'channel_sync_task_item') ORDER BY 1
    `;
    console.log(
      "WORKER_HEALTH_SEED",
      JSON.stringify({
        seedSeconds: Math.round((performance.now() - started) / 100) / 10,
        tables: sizes.map((row) => ({ ...row, rows: Number(row.rows) })),
      }),
    );
  }, 1_800_000);

  afterAll(async () => {
    await owner.$disconnect();
    await web.$disconnect();
  });

  it("基线（迁移前的生产状态）：旧写法心跳查询对两张大表都是 Seq Scan；过期锁查询早已走既有的 expired_lease 索引", async () => {
    await dropWorkerHealthIndexes();
    await owner.$executeRawUnsafe("ANALYZE generic_task_item");
    await owner.$executeRawUnsafe("ANALYZE channel_sync_task_item");

    const legacyHeartbeat = await explain(web, LEGACY_HEARTBEAT_SQL);
    const expired = await explain(web, EXPIRED_LOCKS_QUERY.sql);
    baseline.legacyHeartbeat = describePlan(legacyHeartbeat);
    baseline.expired = describePlan(expired);
    console.log("WORKER_HEALTH_PLAN", JSON.stringify({ phase: "baseline_before_migration", query: "legacy_heartbeat", ...baseline.legacyHeartbeat }));
    console.log("WORKER_HEALTH_PLAN", JSON.stringify({ phase: "baseline_before_migration", query: "expired_locks", ...baseline.expired }));

    // 缺陷本身：没有索引覆盖 heartbeat_at → 两张表整表顺序扫描。
    for (const table of ITEM_TABLES) {
      expect(
        scansOn(legacyHeartbeat, table).some((node) => /Seq Scan/.test(node["Node Type"])),
        `legacy_heartbeat 在 ${table} 上应当是 Seq Scan（基线），实际=${JSON.stringify(baseline.legacyHeartbeat)}`,
      ).toBe(true);
    }

    // 过期锁查询的前提：既有的 expired_lease 部分索引已经覆盖它，本修复不需要为它新增索引。
    expectUsesIndexNotSeqScan(expired, "generic_task_item", "generic_task_item_expired_lease_idx");
    expectUsesIndexNotSeqScan(expired, "channel_sync_task_item", "channel_sync_task_item_expired_lease_idx");

    // 对照（回滚的事务）：把既有索引撤掉，过期锁查询立刻变回 Seq Scan——
    // 证明上面"走索引"的断言是灵敏的，且走的确实是那个既有索引、不是别的。
    const sentinel = new Error("rollback-control");
    let control: ExplainResult | undefined;
    await expect(
      owner.$transaction(async (tx) => {
        for (const index of EXISTING_EXPIRED_LEASE_INDEXES) {
          await tx.$executeRawUnsafe(`DROP INDEX "${index.name}"`);
        }
        const rows = await tx.$queryRawUnsafe<Array<{ "QUERY PLAN": unknown }>>(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${EXPIRED_LOCKS_QUERY.sql}`,
        );
        const raw = rows[0]["QUERY PLAN"];
        const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as Array<{ Plan: PlanNode; "Execution Time": number }>;
        control = {
          root: parsed[0].Plan,
          executionMs: parsed[0]["Execution Time"],
          buffers: (parsed[0].Plan["Shared Hit Blocks"] ?? 0) + (parsed[0].Plan["Shared Read Blocks"] ?? 0),
          nodes: flatten(parsed[0].Plan),
        };
        throw sentinel;
      }),
    ).rejects.toBe(sentinel);
    console.log("WORKER_HEALTH_PLAN", JSON.stringify({ phase: "control_expired_lease_idx_dropped_rolled_back", query: "expired_locks", ...describePlan(control!) }));
    const controlIndexes = control!.nodes.map((node) => node["Index Name"]).filter(Boolean);
    for (const index of EXISTING_EXPIRED_LEASE_INDEXES) {
      expect(controlIndexes, `撤掉 ${index.name} 之后计划不得再经由它`).not.toContain(index.name);
    }
    // 撤掉之后规划器退到 (task_id, status) 索引逐父任务探测——读的页数明显多于走专用部分索引。
    expect(control!.buffers).toBeGreaterThan(expired.buffers);
    // 回滚后既有索引仍在。
    const [still] = await owner.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_indexes
      WHERE indexname IN ('generic_task_item_expired_lease_idx', 'channel_sync_task_item_expired_lease_idx')
    `;
    expect(Number(still.n)).toBe(2);
  }, 600_000);

  it("迁移 SQL 本身建出恰好两个心跳部分索引：定义、有效性、体积；既有 expired_lease 索引原样在位", async () => {
    const statements = splitStatements(readFileSync(MIGRATION_PATH, "utf8"));
    expect(statements).toHaveLength(EXPECTED_INDEXES.length);
    expect(statements.every((statement) => /^CREATE INDEX "/.test(statement))).toBe(true);

    // 整个迁移文件在一个事务里执行（Prisma migrate deploy 的行为；CONCURRENTLY 因此不可用）。
    const timings: Array<{ index: string; ms: number }> = [];
    const started = performance.now();
    await owner.$transaction(
      async (tx) => {
        for (const statement of statements) {
          const t0 = performance.now();
          await tx.$executeRawUnsafe(statement);
          timings.push({
            index: statement.match(/^CREATE INDEX "([^"]+)"/)![1],
            ms: Math.round(performance.now() - t0),
          });
        }
      },
      { timeout: 600_000, maxWait: 60_000 },
    );
    console.log(
      "WORKER_HEALTH_INDEX_BUILD",
      JSON.stringify({ totalMs: Math.round(performance.now() - started), perIndex: timings }),
    );
    await owner.$executeRawUnsafe("ANALYZE generic_task_item");
    await owner.$executeRawUnsafe("ANALYZE channel_sync_task_item");

    const all = [...EXPECTED_INDEXES, ...EXISTING_EXPIRED_LEASE_INDEXES];
    const rows = await owner.$queryRaw<Array<{ name: string; table: string; def: string; valid: boolean; ready: boolean; bytes: bigint }>>`
      SELECT i.relname AS name, t.relname AS table, pg_get_indexdef(i.oid) AS def,
             x.indisvalid AS valid, x.indisready AS ready, pg_relation_size(i.oid) AS bytes
      FROM pg_index x
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_class t ON t.oid = x.indrelid
      WHERE i.relname = ANY(${all.map((index) => index.name)}::text[])
      ORDER BY i.relname
    `;
    expect(rows.map((row) => row.name).sort()).toEqual(all.map((index) => index.name).sort());
    for (const expected of all) {
      const actual = rows.find((row) => row.name === expected.name)!;
      expect(actual.def).toBe(expected.definition);
      expect(actual.table).toBe(expected.table);
      expect(actual.valid && actual.ready).toBe(true);
      // 只含在途行：几个页，与表规模无关。
      expect(Number(actual.bytes)).toBeLessThanOrEqual(64 * 1024);
    }
    console.log(
      "WORKER_HEALTH_INDEX_SIZE",
      JSON.stringify(rows.map((row) => ({ index: row.name, bytes: Number(row.bytes) }))),
    );
  }, 900_000);

  it("发布的两条查询都走部分索引：两张表都没有 Seq Scan，缓冲区读取是有界的少数页", async () => {
    // 热缓存下各跑一次预热，再取一次计划作为判据；冷缓存对比见发布说明里的容器重启实验。
    await explain(web, LAST_HEARTBEAT_QUERY.sql);
    await explain(web, EXPIRED_LOCKS_QUERY.sql);
    const heartbeat = await explain(web, LAST_HEARTBEAT_QUERY.sql);
    const expired = await explain(web, EXPIRED_LOCKS_QUERY.sql);
    console.log("WORKER_HEALTH_PLAN", JSON.stringify({ phase: "after_indexes", query: "heartbeat", ...describePlan(heartbeat) }));
    console.log("WORKER_HEALTH_PLAN", JSON.stringify({ phase: "after_indexes", query: "expired_locks", ...describePlan(expired) }));

    expectHeartbeatProbeIsOneRowBackwardScan(heartbeat, "generic_task_item", "generic_task_item_heartbeat_idx");
    expectHeartbeatProbeIsOneRowBackwardScan(heartbeat, "channel_sync_task_item", "channel_sync_task_item_heartbeat_idx");
    expectUsesIndexNotSeqScan(expired, "generic_task_item", "generic_task_item_expired_lease_idx");
    expectUsesIndexNotSeqScan(expired, "channel_sync_task_item", "channel_sync_task_item_expired_lease_idx");

    // 页数上界：与表规模无关（基线 Seq Scan 读的是整张堆）。
    expect(heartbeat.buffers).toBeLessThanOrEqual(40);
    expect(expired.buffers).toBeLessThanOrEqual(120);
    const baselineBlocks = Math.max(
      Number(baseline.legacyHeartbeat?.sharedBlocks ?? 0),
      Number(baseline.expired?.sharedBlocks ?? 0),
    );
    expect(baselineBlocks).toBeGreaterThan((heartbeat.buffers + expired.buffers) * 20);
  }, 600_000);

  it("对照：旧写法文本在有索引后虽不再 Seq Scan，却读全部在途心跳（O(在途行数)）——改写把它收成每表 1 行", async () => {
    const legacy = await explain(web, LEGACY_HEARTBEAT_SQL);
    const current = await explain(web, LAST_HEARTBEAT_QUERY.sql);
    console.log("WORKER_HEALTH_PLAN", JSON.stringify({ phase: "after_indexes", query: "legacy_heartbeat_text", ...describePlan(legacy) }));

    const legacyRows = legacy.nodes
      .filter((node) => node["Index Name"]?.endsWith("_heartbeat_idx"))
      .reduce((sum, node) => sum + (node["Actual Rows"] ?? 0), 0);
    const currentRows = current.nodes
      .filter((node) => node["Index Name"]?.endsWith("_heartbeat_idx"))
      .reduce((sum, node) => sum + (node["Actual Rows"] ?? 0), 0);
    // 种子里有 12 + 4 条在途行（心跳非空）：旧写法读 16 行，新写法只读 2 行（每表 1 行）。
    expect(legacyRows).toBe(16);
    expect(currentRows).toBe(2);
  }, 120_000);

  it("新旧查询在同一份数据上结果逐值相等（语义不变）", async () => {
    const [legacy] = await web.$queryRawUnsafe<Array<{ last_heartbeat_at: Date | null }>>(LEGACY_HEARTBEAT_SQL);
    const [current] = await web.$queryRaw<Array<{ last_heartbeat_at: Date | null }>>(LAST_HEARTBEAT_QUERY);
    expect(current.last_heartbeat_at).not.toBeNull();
    expect(current.last_heartbeat_at!.getTime()).toBe(legacy.last_heartbeat_at!.getTime());

    // 期望值直接从底表按 PRD 语义独立算出（不经过任何被测 SQL 形态）。
    const [truth] = await owner.$queryRaw<Array<{ newest: Date | null }>>`
      SELECT greatest(
        (SELECT max(heartbeat_at) FROM generic_task_item),
        (SELECT max(heartbeat_at) FROM channel_sync_task_item)
      ) AS newest
    `;
    expect(current.last_heartbeat_at!.getTime()).toBe(truth.newest!.getTime());
  }, 120_000);

  it("evaluateWorkerStatus 在 web_app 角色下：无过期锁 → ok 且带心跳年龄；全部完成 → ok 且心跳为 null", async () => {
    // 租约续到未来：没有过期锁，仍有在途心跳 → ok，心跳年龄是最新一次心跳（g=1，约 1 秒前）。
    await owner.$executeRawUnsafe(
      `UPDATE generic_task_item SET locked_until = now() + interval '5 minutes' WHERE status = 'processing' AND locked_until < now()`,
    );
    await owner.$executeRawUnsafe(
      `UPDATE channel_sync_task_item SET locked_until = now() + interval '5 minutes' WHERE status = 'processing' AND locked_until < now()`,
    );
    const ok = await evaluateWorkerStatus(web, { timeoutMs: 20_000 });
    expect(ok.workerStatus).toBe("ok");
    expect(ok.expiredLocks).toBe(0);
    expect(ok.lastHeartbeatAgeSeconds).not.toBeNull();
    expect(ok.lastHeartbeatAgeSeconds!).toBeGreaterThanOrEqual(0);
    expect(ok.lastHeartbeatAgeSeconds!).toBeLessThan(120);

    // 全部完成（store.ts 的 finalize 把租约字段与 heartbeat_at 置 NULL）→ 空闲，心跳为 null。
    await owner.$executeRawUnsafe(`
      UPDATE generic_task_item SET status = 'success', execution_token = NULL, locked_by = NULL,
        locked_until = NULL, heartbeat_at = NULL, finished_at = now(), updated_at = now()
      WHERE status = 'processing'`);
    await owner.$executeRawUnsafe(`
      UPDATE channel_sync_task_item SET status = 'success', execution_token = NULL, locked_by = NULL,
        locked_until = NULL, heartbeat_at = NULL, finished_at = now(), updated_at = now()
      WHERE status = 'processing'`);
    const idle = await evaluateWorkerStatus(web, { timeoutMs: 20_000 });
    expect(idle).toMatchObject({ workerStatus: "ok", expiredLocks: 0, lastHeartbeatAgeSeconds: null });

    // 空闲时索引为空，计划仍走索引（读 0 个堆页）。
    const heartbeatIdle = await explain(web, LAST_HEARTBEAT_QUERY.sql);
    expectHeartbeatProbeIsOneRowBackwardScan(heartbeatIdle, "generic_task_item", "generic_task_item_heartbeat_idx");
    expectHeartbeatProbeIsOneRowBackwardScan(heartbeatIdle, "channel_sync_task_item", "channel_sync_task_item_heartbeat_idx");
  }, 300_000);

  it("web_app 只需要既有的表级 SELECT：不为索引新增任何授权，也读不到不该读的表", async () => {
    // 索引随表由 migration_owner 持有；web_app 不能建/删索引。
    await expect(
      web.$executeRawUnsafe(`DROP INDEX "generic_task_item_heartbeat_idx"`),
    ).rejects.toThrow();
    const [row] = await web.$queryRaw<Array<{ ok: boolean }>>(Prisma.sql`
      SELECT has_table_privilege('web_app', 'generic_task_item', 'SELECT')
         AND has_table_privilege('web_app', 'channel_sync_task_item', 'SELECT')
         AND has_table_privilege('web_app', 'generic_task', 'SELECT')
         AND has_table_privilege('web_app', 'channel_sync_task', 'SELECT') AS ok
    `);
    expect(row.ok).toBe(true);
  }, 60_000);
});
