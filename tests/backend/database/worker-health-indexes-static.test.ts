import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 迁移 `20261005100000_worker_health_partial_indexes` 的静态合同（不需要 Docker）：
 * GET /api/health/worker 冷缓存超时误报 503 的修复 = 两张 item 表各加两个部分索引。
 * 真实库上的建索引/执行计划证据见
 * `tests/integration/health/worker-health-indexes-postgres.test.ts`。
 */
const root = process.cwd();
const MIGRATION = "20261005100000_worker_health_partial_indexes";

function read(relative: string): string {
  return readFileSync(path.resolve(root, relative), "utf8");
}

function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

const EXPECTED = [
  'CREATE INDEX "generic_task_item_heartbeat_idx" ON "generic_task_item" ("heartbeat_at") WHERE "heartbeat_at" IS NOT NULL',
  'CREATE INDEX "channel_sync_task_item_heartbeat_idx" ON "channel_sync_task_item" ("heartbeat_at") WHERE "heartbeat_at" IS NOT NULL',
];

describe("worker health partial indexes migration", () => {
  it("contains exactly the two heartbeat partial indexes and nothing else (index-only, no column/CHECK/data change)", () => {
    const parsed = statements(read(`prisma/migrations/${MIGRATION}/migration.sql`));

    expect(parsed).toEqual(EXPECTED);
  });

  it("does not use CREATE INDEX CONCURRENTLY, which cannot run inside the migration transaction", () => {
    const sql = read(`prisma/migrations/${MIGRATION}/migration.sql`);

    expect(sql.replace(/^\s*--.*$/gm, "")).not.toMatch(/CONCURRENTLY/i);
  });

  it("does not add a duplicate of the initial migration's *_expired_lease_idx: the expired-lock query is already covered by it", () => {
    const initial = read("prisma/migrations/20260803090000_p1_initial_schema/migration.sql");
    const mine = read(`prisma/migrations/${MIGRATION}/migration.sql`).replace(/^\s*--.*$/gm, "");

    for (const table of ["generic_task_item", "channel_sync_task_item"]) {
      expect(initial).toContain(
        `CREATE INDEX "${table}_expired_lease_idx" ON "${table}"("locked_until", "id") WHERE "status" = 'processing' AND "locked_until" IS NOT NULL;`,
      );
    }
    expect(mine).not.toMatch(/locked_until/);
  });

  it("sorts after every migration directory that existed before it", () => {
    const names = readdirSync(path.resolve(root, "prisma/migrations"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(names).toContain(MIGRATION);
    expect(names.indexOf(MIGRATION)).toBeGreaterThan(names.indexOf("20260930100000_site_setting_yandex"));
  });

  it("registers the two indexes in the dictionary as migration_sql partial_index records", () => {
    const records = read("docs/governance/database-schema-dictionary.jsonl")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const wanted = [
      ["generic_task_item", "generic_task_item_heartbeat_idx", "heartbeat_at"],
      ["channel_sync_task_item", "channel_sync_task_item_heartbeat_idx", "heartbeat_at"],
    ] as const;

    for (const [table, name, column] of wanted) {
      const record = records.find((item) => item.stable_key === `db:public:${table}:${name}`);
      expect(record, name).toBeDefined();
      expect(record).toMatchObject({
        record_kind: "constraint",
        table_name: table,
        data_type: "partial_index",
        managed_by: "migration_sql",
        physical_name: name,
        introduced_in_migration: MIGRATION,
        status: "active",
      });
      const field = records.find((item) => item.stable_key === `db:public:${table}:${column}`);
      expect(field.indexes, `${table}.${column}`).toContain(name);
    }
  });

  it("keeps the partial indexes out of Prisma @@index (Prisma 6.19 cannot express WHERE) and says why next to the models", () => {
    const schema = read("prisma/schema.prisma");

    for (const name of ["generic_task_item_heartbeat_idx", "channel_sync_task_item_heartbeat_idx"]) {
      expect(schema).not.toContain(`map: "${name}"`);
      expect(schema).toContain(`\`${name}\``);
    }
    expect(schema).toContain(MIGRATION);
  });

  it("needs no new grant: web_app/analyst_ro already hold table-level SELECT on the four tables the health queries read", () => {
    const grants = read("infra/postgres/grants.sql");
    const webSelect = grants.match(
      /-- Tables without restricted columns can be read directly by Web and Analyst\.\nGRANT SELECT ON TABLE([\s\S]*?)TO web_app, analyst_ro;/,
    );

    expect(webSelect, "Web/Analyst 表级 SELECT 清单").not.toBeNull();
    for (const table of ["channel_sync_task", "channel_sync_task_item", "generic_task", "generic_task_item"]) {
      expect(webSelect![1]).toMatch(new RegExp(`\\b${table}\\b`));
    }
    expect(grants).not.toContain("worker_health");
  });
});
