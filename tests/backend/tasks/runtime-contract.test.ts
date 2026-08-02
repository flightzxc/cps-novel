import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDrainLoop } from "../../../worker/runtime";

describe("P1-07 SQL and shutdown contracts", () => {
  const source = readFileSync(path.join(process.cwd(), "src/lib/tasks/store.ts"), "utf8");

  it("keeps pending and expired SKIP LOCKED paths separate", () => {
    expect(source.match(/FOR UPDATE OF i SKIP LOCKED/g)).toHaveLength(6);
    expect(source).not.toMatch(/status\s*=\s*'pending'[\s\S]{0,160}\bOR\b[\s\S]{0,160}locked_until/i);
    expect(source).toContain("ORDER BY i.created_at, i.id");
    expect(source).toContain("ORDER BY i.locked_until, i.id");
  });

  it("fences heartbeat and finalize without matching mutable locked_until", () => {
    expect(source).toContain("execution_token = ${lease.executionToken}::uuid");
    expect(source).toContain("lease_epoch = ${lease.leaseEpoch}");
    expect(source).toContain("locked_until > transaction_timestamp()");
    expect(source).not.toContain("locked_until = ${lease.lockedUntil}");
  });

  it("stops new cycles and drains the current one", async () => {
    const controller = new AbortController();
    let cycles = 0;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = runDrainLoop({
      signal: controller.signal,
      pollMs: 1,
      cycle: async () => {
        cycles += 1;
        controller.abort();
        await current;
        return true;
      },
    });
    await Promise.resolve();
    expect(cycles).toBe(1);
    let drained = false;
    void running.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await running;
    expect(cycles).toBe(1);
  });
});
