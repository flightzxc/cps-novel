import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DATABASE_STATUS_SEMANTICS,
  REVENUE_BOOK_MATCH_STATUSES,
  REVENUE_BREAKDOWN_STATUSES,
} from "@/domain/database-statuses";

/**
 * 迁移 `20261017120000_revenue_book_country_breakdown`（v0.6.2 按书归因 + 新增用户国家）的静态合同：
 * 只新增（两张表 + 批次表 4 个可空 / 带默认值的列），CHECK 取值域与 TypeScript 真源逐值一致，金额只用 numeric，
 * 外键全部 RESTRICT，grants 只给对的角色对的权限，字典条数与角色一致。真实库上的角色权限与约束见
 * `tests/integration/revenue/revenue-dashboard-postgres.test.ts`。
 */
const root = process.cwd();
const MIGRATION = "20261017120000_revenue_book_country_breakdown";
const NEW_TABLES = ["revenue_book_daily_stat", "revenue_country_daily_stat"] as const;

const read = (relative: string) => readFileSync(path.resolve(root, relative), "utf8");
const migrationCode = read(`prisma/migrations/${MIGRATION}/migration.sql`).replace(/^\s*--.*$/gm, "");

function checkBody(constraintName: string): string {
  const match = migrationCode.match(new RegExp(`ADD CONSTRAINT "${constraintName}"\\s*\\n\\s*CHECK \\(([\\s\\S]*?)\\);`));
  if (!match) throw new Error(`No CHECK constraint "${constraintName}" found in migration SQL`);
  return match[1]!;
}

function inLists(body: string): string[][] {
  return [...body.matchAll(/IN \(([^)]+)\)/g)].map((match) => match[1]!.split(",").map((value) => value.trim().replace(/^'|'$/g, "")));
}

function tableGrants(): Array<{ privileges: string[]; tables: string[]; roles: string[] }> {
  const stripped = read("infra/postgres/grants.sql")
    .split("\n")
    .map((line) => (line.includes("--") ? line.slice(0, line.indexOf("--")) : line))
    .join("\n");
  const statements: Array<{ privileges: string[]; tables: string[]; roles: string[] }> = [];
  for (const match of stripped.matchAll(/GRANT\s+([A-Z,\s]+?)\s+ON\s+(?:TABLE\s+)?([^;]*?)\s+TO\s+([^;]+);/g)) {
    const privileges = match[1]!.split(",").map((value) => value.trim()).filter(Boolean);
    if (privileges.some((privilege) => !/^(SELECT|INSERT|UPDATE|DELETE)$/.test(privilege))) continue;
    if (match[2]!.includes("(")) continue;
    statements.push({
      privileges,
      tables: match[2]!.split(",").map((value) => value.trim()).filter(Boolean),
      roles: match[3]!.split(",").map((value) => value.trim()).filter(Boolean),
    });
  }
  return statements;
}

function privilegesFor(role: string, table: string): string[] {
  const granted = new Set<string>();
  for (const statement of tableGrants()) {
    if (statement.roles.includes(role) && statement.tables.includes(table)) statement.privileges.forEach((p) => granted.add(p));
  }
  return [...granted].sort();
}

describe("v0.6.2 按书 / 国家迁移（静态）", () => {
  it("只新增：两张新表；唯一改到的旧表是 revenue_sync_batch，且只是 ADD COLUMN / ADD CONSTRAINT；没有 DROP / 数据改写", () => {
    const created = [...migrationCode.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((match) => match[1]);
    expect(created.sort()).toEqual([...NEW_TABLES].sort());
    expect(migrationCode).not.toMatch(/\bDROP\b|\bRENAME\b|ALTER COLUMN/i);
    expect(migrationCode).not.toMatch(/\bINSERT\s+INTO\b|^\s*UPDATE\s+"|\bDELETE\s+FROM\b/im);
    for (const match of migrationCode.matchAll(/ALTER TABLE "([a-z_]+)"/g)) {
      expect([...NEW_TABLES, "revenue_sync_batch"]).toContain(match[1]);
    }
    // 批次表的新列全是可空或带常量默认值（PG16 加列不重写表，存量批次不受影响）。
    const added = [...migrationCode.matchAll(/ADD COLUMN\s+"([a-z_]+)" ([^,;\n]+)/g)].map((match) => [match[1], match[2]!.trim()]);
    expect(added).toEqual([
      ["book_row_count", "INTEGER NOT NULL DEFAULT 0"],
      ["book_status", "VARCHAR(32)"],
      ["country_row_count", "INTEGER NOT NULL DEFAULT 0"],
      ["country_status", "VARCHAR(32)"],
    ]);
  });

  it("CHECK 取值域与 TypeScript 状态真源逐值一致（两段状态各自允许 NULL）", () => {
    const breakdown = checkBody("revenue_sync_batch_breakdown_status_check");
    expect(inLists(breakdown)).toEqual([[...REVENUE_BREAKDOWN_STATUSES], [...REVENUE_BREAKDOWN_STATUSES]]);
    expect(breakdown).toContain('"book_status" IS NULL');
    expect(breakdown).toContain('"country_status" IS NULL');
    expect(inLists(checkBody("revenue_book_daily_stat_match_status_check"))).toEqual([[...REVENUE_BOOK_MATCH_STATUSES]]);
    expect(Object.keys(DATABASE_STATUS_SEMANTICS.revenue_sync_batch_breakdown_status)).toEqual([...REVENUE_BREAKDOWN_STATUSES]);
    expect(Object.keys(DATABASE_STATUS_SEMANTICS.revenue_book_daily_stat_match_status)).toEqual([...REVENUE_BOOK_MATCH_STATUSES]);
  });

  it("匹配形状 CHECK：matched ⇔ 有来源条目；unmatched 不得带剧场", () => {
    const shape = checkBody("revenue_book_daily_stat_match_shape_check").replace(/\s+/g, " ");
    expect(shape).toContain(`("match_status" = 'matched') = ("novel_source_item_id" IS NOT NULL)`);
    expect(shape).toContain(`("match_status" <> 'unmatched' OR "channel_app_id" IS NULL)`);
    expect(checkBody("revenue_country_daily_stat_new_users_check")).toContain('"new_real_dev_num" >= 0');
  });

  it("金额 / 比例只用 numeric；两张表的身份唯一索引都在", () => {
    expect(migrationCode).not.toMatch(/\b(FLOAT|DOUBLE PRECISION|REAL)\b/i);
    expect(migrationCode).toMatch(/"real_income" DECIMAL\(18,4\)/);
    expect(migrationCode).toMatch(/"real_dev_num_rate" DECIMAL\(9,6\)/);
    expect(migrationCode).toMatch(
      /CREATE UNIQUE INDEX "revenue_book_daily_stat_scope_date_series_key" ON "revenue_book_daily_stat"\("revenue_sync_scope_id", "stat_date", "upstream_series_key"\)/,
    );
    expect(migrationCode).toMatch(
      /CREATE UNIQUE INDEX "revenue_country_daily_stat_scope_date_label_key" ON "revenue_country_daily_stat"\("revenue_sync_scope_id", "stat_date", "country_label"\)/,
    );
  });

  it("外键 6 条，全部 ON DELETE RESTRICT（统计行长期保留，不随上游对象消失）", () => {
    const foreignKeys = [...migrationCode.matchAll(/ADD CONSTRAINT "([a-z_]+_fkey)" FOREIGN KEY \("([a-z_]+)"\) REFERENCES "([a-z_]+)"\("id"\) ON DELETE ([A-Z ]+?) ON UPDATE CASCADE;/g)]
      .map((match) => ({ name: match[1], column: match[2], ref: match[3], onDelete: match[4] }));
    expect(foreignKeys.map((fk) => `${fk.column}->${fk.ref}`).sort()).toEqual([
      "channel_app_id->channel_app",
      "novel_source_item_id->novel_source_item",
      "revenue_sync_scope_id->revenue_sync_scope",
      "revenue_sync_scope_id->revenue_sync_scope",
      "source_batch_id->revenue_sync_batch",
      "source_batch_id->revenue_sync_batch",
    ]);
    for (const fk of foreignKeys) expect(fk.onDelete, fk.name).toBe("RESTRICT");
  });

  it("迁移目录紧跟在 v0.6.0 的 code_mode_upstream_code_guard 之后（时间戳序）", () => {
    const names = readdirSync(path.resolve(root, "prisma/migrations"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(names.indexOf(MIGRATION)).toBe(names.indexOf("20261014120000_code_mode_upstream_code_guard") + 1);
  });
});

describe("v0.6.2 按书 / 国家 grants（静态）", () => {
  it("worker_app 两张新表 SELECT + INSERT + UPDATE + DELETE（整段替换）；旧四表仍然没有 DELETE", () => {
    for (const table of NEW_TABLES) expect(privilegesFor("worker_app", table), table).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
    for (const table of ["revenue_sync_scope", "revenue_sync_batch", "revenue_raw_snapshot", "revenue_daily_stat"]) {
      expect(privilegesFor("worker_app", table), table).toEqual(["INSERT", "SELECT", "UPDATE"]);
    }
  });

  it("web_app / analyst_ro 只读；scheduler_app 无任何表级授权；没有列级授权", () => {
    const grants = read("infra/postgres/grants.sql");
    for (const table of NEW_TABLES) {
      expect(privilegesFor("web_app", table), `web_app ${table}`).toEqual(["SELECT"]);
      expect(privilegesFor("analyst_ro", table), `analyst_ro ${table}`).toEqual(["SELECT"]);
      expect(privilegesFor("scheduler_app", table), `scheduler_app ${table}`).toEqual([]);
      expect(grants).not.toMatch(new RegExp(`\\)\\s+ON\\s+${table}\\b`));
    }
  });
});

describe("v0.6.2 按书 / 国家字典（静态）", () => {
  const records = read("docs/governance/database-schema-dictionary.jsonl")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const mine = records.filter((record) => record.introduced_in_migration === MIGRATION);

  it("本迁移新增 48 条：2 表 + 29 字段（含批次表 4 个新列）+ 17 约束，全部 active", () => {
    expect(mine).toHaveLength(48);
    expect(mine.filter((record) => record.record_kind === "table")).toHaveLength(2);
    expect(mine.filter((record) => record.record_kind === "field")).toHaveLength(29);
    expect(mine.filter((record) => record.record_kind === "constraint")).toHaveLength(17);
    expect(mine.every((record) => record.status === "active")).toBe(true);
    expect(mine.filter((record) => record.table_name === "revenue_sync_batch" && record.record_kind === "field").map((record) => record.field_name).sort())
      .toEqual(["book_row_count", "book_status", "country_row_count", "country_status"]);
  });

  it("读写角色与 grants 一致：web / analyst 只读、worker 读写、没有 scheduler", () => {
    for (const record of mine) {
      expect(record.read_roles).toEqual(["web_app", "worker_app", "analyst_ro"]);
      expect(record.write_roles).toEqual(["migration_owner", "worker_app"]);
    }
  });
});

describe("v0.6.2 追加·国家激活口径迁移（静态）", () => {
  const ACTIVE_MIGRATION = "20261017180000_revenue_country_active_users";
  const activeCode = read(`prisma/migrations/${ACTIVE_MIGRATION}/migration.sql`).replace(/^\s*--.*$/gm, "");
  const activeCheck = (name: string) => {
    const match = activeCode.match(new RegExp(`ADD CONSTRAINT "${name}"\\s*\\n\\s*CHECK \\(([\\s\\S]*?)\\);`));
    if (!match) throw new Error(`No CHECK constraint "${name}"`);
    return match[1]!.replace(/\s+/g, " ").trim();
  };

  it("只新增两列与两条 CHECK：不建表、不删、不改已有列、不动数据", () => {
    expect(activeCode).not.toMatch(/CREATE TABLE|\bDROP\b|\bRENAME\b|ALTER COLUMN/i);
    expect(activeCode).not.toMatch(/\bINSERT\s+INTO\b|^\s*UPDATE\s+"|\bDELETE\s+FROM\b/im);
    const added = [...activeCode.matchAll(/ALTER TABLE "([a-z_]+)" ADD COLUMN\s+"([a-z_]+)" ([^;\n]+);/g)].map((match) => [match[1], match[2], match[3]!.trim()]);
    expect(added).toEqual([
      ["revenue_sync_batch", "country_active_included", "BOOLEAN NOT NULL DEFAULT false"],
      ["revenue_country_daily_stat", "real_dev_num", "INTEGER"],
    ]);
    expect(activeCheck("revenue_sync_batch_country_active_shape_check")).toBe(`"country_active_included" = false OR "country_status" IS NOT NULL`);
    expect(activeCheck("revenue_country_daily_stat_active_users_check")).toBe(`"real_dev_num" IS NULL OR "real_dev_num" >= 0`);
  });

  it("紧跟在 20261017120000 之后；20261017120000 自己的国家表定义里没有激活列（那一条逐字节不动）", () => {
    const names = readdirSync(path.resolve(root, "prisma/migrations"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(names.indexOf(ACTIVE_MIGRATION)).toBe(names.indexOf(MIGRATION) + 1);
    expect(migrationCode).not.toContain('"real_dev_num" INTEGER,\n    "source_batch_id"');
    expect(migrationCode).not.toContain("country_active_included");
  });

  it("字典新增 4 条（2 字段 + 2 约束），读写角色与表级 grants 一致；grants 没有为它们新增列级授权", () => {
    const records = read("docs/governance/database-schema-dictionary.jsonl")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.introduced_in_migration === ACTIVE_MIGRATION);
    expect(records.map((record) => record.stable_key).sort()).toEqual([
      "db:public:revenue_country_daily_stat:real_dev_num",
      "db:public:revenue_country_daily_stat:revenue_country_daily_stat_active_users_check",
      "db:public:revenue_sync_batch:country_active_included",
      "db:public:revenue_sync_batch:revenue_sync_batch_country_active_shape_check",
    ]);
    for (const record of records) {
      expect(record.read_roles).toEqual(["web_app", "worker_app", "analyst_ro"]);
      expect(record.write_roles).toEqual(["migration_owner", "worker_app"]);
    }
    expect(read("infra/postgres/grants.sql")).not.toMatch(/real_dev_num|country_active_included/);
  });
});
