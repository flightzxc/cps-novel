import { describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";

import { recomputeParentTask } from "@/lib/tasks/store";

/**
 * X10 task control (pause/resume/abort/system-hold): `recomputeParentTask`
 * runs unconditionally at the end of every `claimPendingItem`/
 * `finalizeTaskItem`, in the same transaction, and recomputes `status` from
 * live item counts. Without a guard, a paused task would silently un-pause
 * itself the moment its in-flight item finishes — pending items are, by
 * pause's own definition, left `pending`, so the CASE's
 * `pending + processing > 0` branch would say `'processing'` again.
 *
 * A real end-to-end proof needs a live Postgres (the gated
 * `P1_07_DATABASE_TEST`-style integration suites this repo already has, out
 * of scope to newly wire up here) — this test instead pins the actual SQL
 * text `recomputeParentTask` sends, the same "static"-test discipline this
 * codebase already uses for other CHECK-adjacent invariants (e.g.
 * `tests/backend/database/carousel-check-static.test.ts`), so a future edit
 * that drops or reorders the guard clause fails immediately.
 */
type CapturedQuery = { sql: string; values: readonly unknown[] };

function fakeTx() {
  const executeRawCalls: CapturedQuery[] = [];
  const queryRawCalls: CapturedQuery[] = [];
  const tx = {
    $queryRaw: async (query: Prisma.Sql) => {
      queryRawCalls.push({ sql: query.sql, values: query.values });
      return [{ id: "task-1" }];
    },
    $executeRaw: async (query: Prisma.Sql) => {
      executeRawCalls.push({ sql: query.sql, values: query.values });
      return 1;
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, executeRawCalls, queryRawCalls };
}

describe("recomputeParentTask — disabled-parent guard", () => {
  it("generic_task: never recomputes status away from 'disabled' from item counts", async () => {
    const { tx, executeRawCalls } = fakeTx();
    await recomputeParentTask(tx, "generic", "task-1");
    expect(executeRawCalls).toHaveLength(1);
    expect(executeRawCalls[0]!.sql).toContain("WHEN t.status = 'disabled' THEN t.status");
    // The guard must be the FIRST branch of the CASE — a disabled parent
    // must win outright, never be shadowed by a later, more specific branch
    // (e.g. the article.generate.v1 blockedReasonCounts check) that could
    // otherwise fire first for some taskTypes.
    const caseIndex = executeRawCalls[0]!.sql.indexOf("CASE");
    const guardIndex = executeRawCalls[0]!.sql.indexOf("WHEN t.status = 'disabled'");
    const nextWhenIndex = executeRawCalls[0]!.sql.indexOf("WHEN", guardIndex + 1);
    expect(guardIndex).toBeGreaterThan(caseIndex);
    expect(guardIndex).toBeLessThan(nextWhenIndex);
  });

  it("channel_sync_task: same guard, same position", async () => {
    const { tx, executeRawCalls } = fakeTx();
    await recomputeParentTask(tx, "channel_sync", "task-1");
    expect(executeRawCalls).toHaveLength(1);
    const sql = executeRawCalls[0]!.sql;
    expect(sql).toContain("WHEN t.status = 'disabled' THEN t.status");
    const caseIndex = sql.indexOf("CASE");
    const guardIndex = sql.indexOf("WHEN t.status = 'disabled'");
    const nextWhenIndex = sql.indexOf("WHEN", guardIndex + 1);
    expect(guardIndex).toBeGreaterThan(caseIndex);
    expect(guardIndex).toBeLessThan(nextWhenIndex);
  });
});
