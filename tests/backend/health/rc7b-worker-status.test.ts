import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { HealthDatabaseClient } from "@/server/health/service";
import {
  EXPIRED_LOCKS_QUERY,
  LAST_HEARTBEAT_QUERY,
  evaluateWorkerStatus,
} from "@/server/health/worker-status";

/**
 * RC-7b — `evaluateWorkerStatus` semantics. Not a CPS port (CPS `v8.3.6` has
 * no equivalent endpoint; `git ls-tree v8.3.6 -- src/app/api/health` only
 * lists `backup/ live/ ready/ route.ts`). The judgement itself is grounded in
 * this repo's own `docs/operations/LAUNCH_DAY_HEALTH_CHECKS.md` §2 (expired
 * processing locks) and `src/lib/tasks/store.ts`'s `heartbeat_at` column.
 *
 * Style follows the neighbouring `p1-12-health-service.test.ts`: a fake
 * `$queryRaw` keyed off the query text (mirroring that file's `database()`
 * helper), no real Postgres connection.
 */

interface FakeQueries {
  expiredRows?: unknown[];
  heartbeatRows?: unknown[];
  hang?: boolean;
  reject?: boolean;
}

function fakeDatabase(queries: FakeQueries): HealthDatabaseClient {
  const $queryRaw = vi.fn(async (query: { text: string }) => {
    if (queries.hang) return new Promise(() => undefined);
    if (queries.reject) throw new Error("connection terminated unexpectedly at 10.0.0.7:5432");
    if (query.text.includes("expired_count")) return queries.expiredRows ?? [];
    return queries.heartbeatRows ?? [{ last_heartbeat_at: null }];
  });
  return { $queryRaw } as unknown as HealthDatabaseClient;
}

const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);

describe("RC-7b evaluateWorkerStatus", () => {
  it("returns ok with expiredLocks 0 and null heartbeat age when no item has ever run", async () => {
    const database = fakeDatabase({ expiredRows: [], heartbeatRows: [{ last_heartbeat_at: null }] });

    const result = await evaluateWorkerStatus(database, { now: () => NOW });

    expect(result).toEqual({
      workerStatus: "ok",
      expiredLocks: 0,
      lastHeartbeatAgeSeconds: null,
      checkedAt: new Date(NOW).toISOString(),
    });
  });

  it("returns ok and reports the heartbeat age when items have run recently", async () => {
    const heartbeatAt = new Date(NOW - 45_000);
    const database = fakeDatabase({ expiredRows: [], heartbeatRows: [{ last_heartbeat_at: heartbeatAt }] });

    const result = await evaluateWorkerStatus(database, { now: () => NOW });

    expect(result.workerStatus).toBe("ok");
    expect(result.lastHeartbeatAgeSeconds).toBe(45);
  });

  it("returns degraded and reports the total expired-lock count across families when any lease is overdue", async () => {
    const database = fakeDatabase({
      expiredRows: [
        { family: "catalog_scan", task_type: "catalog_scan", expired_count: 2n, oldest_expiry: new Date(NOW), maximum_overdue: null },
        { family: "channel_sync", task_type: "moboreader_chapter_sync", expired_count: 3n, oldest_expiry: new Date(NOW), maximum_overdue: null },
      ],
      heartbeatRows: [{ last_heartbeat_at: null }],
    });

    const result = await evaluateWorkerStatus(database, { now: () => NOW });

    expect(result.workerStatus).toBe("degraded");
    expect(result.expiredLocks).toBe(5);
  });

  it("returns failed and never claims expiredLocks is 0 was measured when the query rejects", async () => {
    const database = fakeDatabase({ reject: true });

    const result = await evaluateWorkerStatus(database, { now: () => NOW });

    expect(result.workerStatus).toBe("failed");
    expect(result.lastHeartbeatAgeSeconds).toBeNull();
  });

  it("returns failed when the query hangs past the timeout budget", async () => {
    const database = fakeDatabase({ hang: true });

    const result = await evaluateWorkerStatus(database, { now: () => NOW, timeoutMs: 10 });

    expect(result.workerStatus).toBe("failed");
  });

  it("never leaks driver error text, SQL, or table names into the response", async () => {
    const database = fakeDatabase({ reject: true });

    const result = await evaluateWorkerStatus(database, { now: () => NOW });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("10.0.0.7");
    expect(serialized).not.toContain("connection terminated");
    expect(serialized).not.toMatch(/task_item|catalog_scan|channel_sync|generic_task/i);
    expect(Object.keys(result).sort()).toEqual([
      "checkedAt",
      "expiredLocks",
      "lastHeartbeatAgeSeconds",
      "workerStatus",
    ]);
  });
});

/**
 * 2026-10-05：冷缓存下两条查询整表扫描、越过 1500 ms 探测预算而误报 503。修法是迁移
 * `20261005100000_worker_health_partial_indexes` 的四个部分索引 + 下面的查询形状。
 * 真实库上"确实走索引"的证据在
 * `tests/integration/health/worker-health-indexes-postgres.test.ts`（EXPLAIN 断言）；
 * 这里是不需要 Docker 的静态一半：查询文本与索引谓词必须成对，改任一边都在这里先红。
 */
function squash(sql: string): string {
  return sql.replace(/\s+/g, " ").replace(/;\s*$/, "").trim();
}

function readRepoFile(relative: string): string {
  return readFileSync(path.resolve(process.cwd(), relative), "utf8");
}

describe("worker health queries stay paired with the partial indexes", () => {
  it("heartbeat query probes each table through ORDER BY heartbeat_at DESC LIMIT 1 under heartbeat_at IS NOT NULL", () => {
    const sql = squash(LAST_HEARTBEAT_QUERY.sql);

    for (const table of ["channel_sync_task_item", "generic_task_item"]) {
      expect(sql).toContain(
        `(SELECT heartbeat_at FROM ${table} WHERE heartbeat_at IS NOT NULL ORDER BY heartbeat_at DESC LIMIT 1)`,
      );
    }
    expect(sql.startsWith("SELECT max(heartbeat_at) AS last_heartbeat_at FROM (")).toBe(true);
    // 输出契约不变：单行单列 last_heartbeat_at。
    expect(sql).toContain("AS last_heartbeat_at");
  });

  it("expired-locks query keeps the status = 'processing' predicate verbatim on both item tables", () => {
    const sql = squash(EXPIRED_LOCKS_QUERY.sql);

    expect(sql.split("WHERE i.status = 'processing' AND i.locked_until < transaction_timestamp()")).toHaveLength(3);
    expect(sql).toContain("count(*) AS expired_count");
  });

  it("expired-locks query is byte-for-byte the launch-day runbook §2 block, the alert script and the X8 health SQL", () => {
    const runbook = readRepoFile("docs/operations/LAUNCH_DAY_HEALTH_CHECKS.md");
    const section = runbook.split("## 2. Expired processing locks")[1].split("## 3.")[0];
    const runbookSql = section.match(/```sql\n([\s\S]*?)```/)![1];
    const alertScript = readRepoFile("infra/production-like/alerts/check-worker-locks.sh");
    const alertSql = alertScript.match(/<<'SQL' \|\| true\n([\s\S]*?)\nSQL\n/)![1];
    const x8Sql = readRepoFile("infra/production-like/launch-day-health-checks.sql")
      .split("X8_HEALTH_SQL_GROUP_2_EXPIRED_LOCKS")[1]
      .split("\\echo")[0];

    const expected = squash(EXPIRED_LOCKS_QUERY.sql);
    expect(squash(runbookSql)).toBe(expected);
    expect(squash(alertSql)).toBe(expected);
    expect(squash(x8Sql.replace(/^'\n/, "").replace(/--[^\n]*\n/g, ""))).toBe(expected);
  });

  it("evaluateWorkerStatus issues exactly the two exported queries", async () => {
    const database = fakeDatabase({ expiredRows: [], heartbeatRows: [{ last_heartbeat_at: null }] });

    await evaluateWorkerStatus(database, { now: () => NOW });

    const calls = (database.$queryRaw as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.map(([query]) => query)).toEqual([EXPIRED_LOCKS_QUERY, LAST_HEARTBEAT_QUERY]);
  });

  it("reads the freshest heartbeat from the single last_heartbeat_at column and clamps negative ages to 0", async () => {
    const database = fakeDatabase({
      expiredRows: [],
      heartbeatRows: [{ last_heartbeat_at: new Date(NOW + 5_000) }],
    });

    const result = await evaluateWorkerStatus(database, { now: () => NOW });

    expect(result.workerStatus).toBe("ok");
    expect(result.lastHeartbeatAgeSeconds).toBe(0);
  });
});
