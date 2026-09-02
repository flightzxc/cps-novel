import { describe, expect, it, vi } from "vitest";

import type { HealthDatabaseClient } from "@/server/health/service";
import { evaluateWorkerStatus } from "@/server/health/worker-status";

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
