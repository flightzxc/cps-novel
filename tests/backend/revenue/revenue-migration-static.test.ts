import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DATABASE_STATUS_SEMANTICS,
  REVENUE_BATCH_STATUSES,
  REVENUE_RECONCILIATION_STATUSES,
  REVENUE_SCOPE_STATUSES,
} from "@/domain/database-statuses";

/**
 * 迁移 `20261008120000_revenue_account_level_dashboard` 的静态合同（不需要 Docker）：
 * 四张新表只新增不改旧表、CHECK 取值域与 TypeScript 真源逐值一致、金额只用 numeric、
 * grants 只给对的角色对的权限、字典记录与表数一致。真实库上的角色权限与唯一约束见
 * `tests/integration/revenue/revenue-dashboard-postgres.test.ts`。
 */
const root = process.cwd();
const MIGRATION = "20261008120000_revenue_account_level_dashboard";
const TABLES = ["revenue_sync_scope", "revenue_sync_batch", "revenue_raw_snapshot", "revenue_daily_stat"] as const;

const read = (relative: string) => readFileSync(path.resolve(root, relative), "utf8");
const migration = read(`prisma/migrations/${MIGRATION}/migration.sql`);
const migrationCode = migration.replace(/^\s*--.*$/gm, "");

/** 与 `c30-novel-rebind-checks-static.test.ts` 同一做法：按约束物理名取 CHECK 体，再取 IN (...) 清单。 */
function checkBody(sql: string, constraintName: string): string {
  const match = sql.match(new RegExp(`ADD CONSTRAINT "${constraintName}"\\s*\\n\\s*CHECK \\(([\\s\\S]*?)\\);`));
  if (!match) throw new Error(`No CHECK constraint "${constraintName}" found in migration SQL`);
  return match[1];
}

function inList(body: string): string[] {
  const match = body.match(/IN \(([^)]+)\)/);
  if (!match) throw new Error(`No IN (...) list in CHECK body: ${body}`);
  return match[1].split(",").map((value) => value.trim().replace(/^'|'$/g, ""));
}

interface GrantStatement {
  privileges: string[];
  tables: string[];
  roles: string[];
}

/** 解析表级 GRANT（列级 GRANT 带括号，不在本测试关心范围内）。 */
function tableGrants(sql: string): GrantStatement[] {
  const stripped = sql
    .split("\n")
    .map((line) => (line.includes("--") ? line.slice(0, line.indexOf("--")) : line))
    .join("\n");
  const statements: GrantStatement[] = [];
  for (const match of stripped.matchAll(/GRANT\s+([A-Z,\s]+?)\s+ON\s+(?:TABLE\s+)?([^;]*?)\s+TO\s+([^;]+);/g)) {
    const privileges = match[1].split(",").map((value) => value.trim()).filter(Boolean);
    if (privileges.some((privilege) => !/^(SELECT|INSERT|UPDATE|DELETE)$/.test(privilege))) continue;
    if (match[2].includes("(")) continue;
    statements.push({
      privileges,
      tables: match[2].split(",").map((value) => value.trim()).filter(Boolean),
      roles: match[3].split(",").map((value) => value.trim()).filter(Boolean),
    });
  }
  return statements;
}

function privilegesFor(role: string, table: string): Set<string> {
  const granted = new Set<string>();
  for (const statement of tableGrants(read("infra/postgres/grants.sql"))) {
    if (statement.roles.includes(role) && statement.tables.includes(table)) {
      for (const privilege of statement.privileges) granted.add(privilege);
    }
  }
  return granted;
}

describe("收益看板迁移（静态）", () => {
  it("只新增四张表：没有 ALTER / DROP / INSERT / UPDATE / DELETE 任何旧对象或数据", () => {
    const created = [...migrationCode.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((match) => match[1]);
    expect(created.sort()).toEqual([...TABLES].sort());
    expect(migrationCode).not.toMatch(/\bDROP\b/i);
    expect(migrationCode).not.toMatch(/\bINSERT\s+INTO\b|^\s*UPDATE\s+"|\bDELETE\s+FROM\b/im);
    // 唯一允许的 ALTER TABLE 是给这四张新表加约束。
    for (const match of migrationCode.matchAll(/ALTER TABLE "([a-z_]+)"/g)) {
      expect(TABLES as readonly string[]).toContain(match[1]);
    }
  });

  it("CHECK 取值域与 TypeScript 状态真源逐值一致", () => {
    expect(inList(checkBody(migrationCode, "revenue_sync_scope_status_check"))).toEqual([...REVENUE_SCOPE_STATUSES]);
    expect(inList(checkBody(migrationCode, "revenue_sync_batch_status_check"))).toEqual([...REVENUE_BATCH_STATUSES]);
    expect(inList(checkBody(migrationCode, "revenue_sync_batch_reconciliation_status_check"))).toEqual([
      ...REVENUE_RECONCILIATION_STATUSES,
    ]);
    expect(Object.keys(DATABASE_STATUS_SEMANTICS.revenue_sync_scope)).toEqual([...REVENUE_SCOPE_STATUSES]);
    expect(Object.keys(DATABASE_STATUS_SEMANTICS.revenue_sync_batch)).toEqual([...REVENUE_BATCH_STATUSES]);
    expect(Object.keys(DATABASE_STATUS_SEMANTICS.revenue_sync_batch_reconciliation_status)).toEqual([
      ...REVENUE_RECONCILIATION_STATUSES,
    ]);
  });

  it("对账结论允许 NULL（尚未对账），终态形状 CHECK 要求终态有 finished_at、失败有 error_code", () => {
    expect(checkBody(migrationCode, "revenue_sync_batch_reconciliation_status_check")).toContain('"reconciliation_status" IS NULL');
    const shape = checkBody(migrationCode, "revenue_sync_batch_terminal_shape_check").replace(/\s+/g, " ");
    expect(shape).toContain(`"finished_at" IS NOT NULL`);
    expect(shape).toContain(`"error_code" IS NOT NULL`);
    expect(checkBody(migrationCode, "revenue_sync_batch_date_range_check")).toContain(`"begin_date" <= "end_date"`);
  });

  it("金额与比例只用 numeric，不出现任何浮点类型", () => {
    expect(migrationCode).not.toMatch(/\b(FLOAT|DOUBLE PRECISION|REAL)\b/i);
    for (const column of ["real_income", "real_distrib_income", "real_profit"]) {
      expect(migrationCode).toMatch(new RegExp(`"${column}" DECIMAL\\(18, 4\\)`));
    }
    expect(migrationCode).toMatch(/"real_dev_num_rate" DECIMAL\(9, 6\)/);
  });

  it("幂等所依赖的四个唯一索引与指纹列都在", () => {
    expect(migrationCode).toContain('CREATE UNIQUE INDEX "revenue_sync_scope_account_project_key"');
    expect(migrationCode).toMatch(/"revenue_sync_scope_account_project_key"\s+ON "revenue_sync_scope"\("channel_account_id", "project_type"\)/);
    expect(migrationCode).toMatch(/"revenue_sync_batch_request_fingerprint_key"\s+ON "revenue_sync_batch"\("request_fingerprint"\)/);
    expect(migrationCode).toMatch(/"revenue_raw_snapshot_dedupe_key_key"\s+ON "revenue_raw_snapshot"\("dedupe_key"\)/);
    expect(migrationCode).toMatch(/"revenue_daily_stat_scope_date_key"\s+ON "revenue_daily_stat"\("revenue_sync_scope_id", "stat_date"\)/);
  });

  it("任务头清理不能阻塞或级联批次：generic_task_id 是 SET NULL，其余外键全部 RESTRICT，凭证列不建 FK", () => {
    const foreignKeys = [...migrationCode.matchAll(/ADD CONSTRAINT "([a-z_]+_fkey)"\s+FOREIGN KEY \("([a-z_]+)"\) REFERENCES "([a-z_]+)"\("id"\)\s+ON DELETE ([A-Z ]+?) ON UPDATE CASCADE;/g)].map(
      (match) => ({ name: match[1], column: match[2], ref: match[3], onDelete: match[4] }),
    );
    expect(foreignKeys).toHaveLength(6);
    for (const foreignKey of foreignKeys) {
      expect(foreignKey.onDelete, foreignKey.name).toBe(foreignKey.column === "generic_task_id" ? "SET NULL" : "RESTRICT");
    }
    expect(foreignKeys.map((fk) => fk.column)).not.toContain("credential_id");
  });

  it("迁移目录排在所有既有迁移之后（时间戳序）", () => {
    const names = readdirSync(path.resolve(root, "prisma/migrations"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    // 它被加进来时是最后一条；之后新增的迁移（例如 B-38 的 20261009120000_b38_novel_effective_tag）
    // 按时间戳排在它后面，所以这里钉的是"排在它之前所有既有迁移之后"，不再假定它永远是最后一条。
    expect(names).toContain(MIGRATION);
    expect(names.indexOf(MIGRATION)).toBe(names.indexOf("20261005100000_worker_health_partial_indexes") + 1);
  });
});

describe("收益看板 grants（静态）", () => {
  it("worker_app 四表 SELECT + INSERT + UPDATE，且没有 DELETE（SELECT 与 RETURNING 并列写出）", () => {
    for (const table of TABLES) {
      expect([...privilegesFor("worker_app", table)].sort(), table).toEqual(["INSERT", "SELECT", "UPDATE"]);
    }
  });

  it("web_app / analyst_ro 四表只有 SELECT；scheduler_app 与其它角色没有任何表级授权", () => {
    for (const table of TABLES) {
      expect([...privilegesFor("web_app", table)], `web_app ${table}`).toEqual(["SELECT"]);
      expect([...privilegesFor("analyst_ro", table)], `analyst_ro ${table}`).toEqual(["SELECT"]);
      expect([...privilegesFor("scheduler_app", table)], `scheduler_app ${table}`).toEqual([]);
    }
  });

  it("没有为四张表写任何列级授权（避免绕开上面的表级口径）", () => {
    const grants = read("infra/postgres/grants.sql")
      .split("\n")
      .map((line) => (line.includes("--") ? line.slice(0, line.indexOf("--")) : line))
      .join("\n");
    for (const table of TABLES) {
      expect(grants).not.toMatch(new RegExp(`\\)\\s+ON\\s+${table}\\b`));
    }
  });
});

describe("收益看板字典（静态）", () => {
  const records = read("docs/governance/database-schema-dictionary.jsonl")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const mine = records.filter((record) => record.introduced_in_migration === MIGRATION);

  it("本迁移新增 84 条记录：4 表 + 54 字段 + 26 物理对象，全部 active", () => {
    expect(mine).toHaveLength(84);
    expect(mine.filter((record) => record.record_kind === "table")).toHaveLength(4);
    expect(mine.filter((record) => record.record_kind === "field")).toHaveLength(54);
    expect(mine.filter((record) => record.record_kind === "constraint")).toHaveLength(26);
    expect(mine.every((record) => record.status === "active")).toBe(true);
  });

  it("每张表的 read/write 角色与 grants 一致：web 只读、worker 读写、没有 scheduler", () => {
    for (const record of mine) {
      const readRoles = record.read_roles as string[];
      const writeRoles = record.write_roles as string[];
      expect(readRoles).not.toContain("scheduler_app");
      expect(writeRoles).not.toContain("web_app");
      expect(writeRoles).not.toContain("scheduler_app");
    }
    for (const table of mine.filter((record) => record.record_kind === "table")) {
      expect(table.read_roles).toEqual(["web_app", "worker_app", "analyst_ro"]);
      expect(table.write_roles).toEqual(["migration_owner", "worker_app"]);
    }
  });

  it("没有哪条记录把 token、密文或密钥写进说明里", () => {
    const text = JSON.stringify(mine);
    expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{10,}/);
    expect(text).not.toMatch(/eyJ[A-Za-z0-9._-]{20,}/);
  });
});
