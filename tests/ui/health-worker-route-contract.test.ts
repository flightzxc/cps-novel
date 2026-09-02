import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { WorkerHealthResult } from "@/server/health/worker-status";

/**
 * RC-7b `/api/health/worker` route-handler contract.
 *
 * Same rationale as `health-backup-route-contract.test.ts` for living in
 * `tests/ui/`. `@/app/api/admin/_lib/deps` is mocked so the route never opens
 * a real Postgres connection — the same substitution
 * `health-route-contract.test.ts` uses for `/api/health` itself. Scope is the
 * handler only; evaluation semantics live in
 * `tests/backend/health/rc7b-worker-status.test.ts`.
 */

const harness = vi.hoisted(() => ({
  result: {
    workerStatus: "ok",
    expiredLocks: 0,
    lastHeartbeatAgeSeconds: null,
    checkedAt: "2026-09-03T12:00:00.000Z",
  } as WorkerHealthResult,
  databaseArgument: null as unknown,
}));

vi.mock("@/app/api/admin/_lib/deps", () => ({
  prisma: { $queryRaw: vi.fn() },
}));

vi.mock("@/server/health/worker-status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/health/worker-status")>();
  return {
    ...actual,
    evaluateWorkerStatus: vi.fn(async (database: unknown) => {
      harness.databaseArgument = database;
      return harness.result;
    }),
  };
});

const { prisma } = await import("@/app/api/admin/_lib/deps");
const { GET, runtime, dynamic } = await import("@/app/api/health/worker/route");
const { evaluateWorkerStatus } = await import("@/server/health/worker-status");

async function routeSource(): Promise<string> {
  return readFile(path.resolve(process.cwd(), "src/app/api/health/worker/route.ts"), "utf8");
}

describe("RC-7b /api/health/worker route handler", () => {
  it.each([
    ["ok", 200],
    ["degraded", 503],
    ["failed", 503],
  ] as const)("maps workerStatus %s to HTTP %i", async (workerStatus, expectedStatus) => {
    harness.result = { workerStatus, expiredLocks: 0, lastHeartbeatAgeSeconds: null, checkedAt: "2026-09-03T12:00:00.000Z" };

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(expectedStatus);
    expect(body).toEqual(harness.result);
  });

  it("marks every response no-store regardless of status", async () => {
    for (const workerStatus of ["ok", "degraded", "failed"] as const) {
      harness.result = { workerStatus, expiredLocks: 0, lastHeartbeatAgeSeconds: null, checkedAt: "2026-09-03T12:00:00.000Z" };
      const response = await GET();
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("declares the Node runtime and refuses static generation", () => {
    expect(runtime).toBe("nodejs");
    expect(dynamic).toBe("force-dynamic");
  });

  it("returns the evaluator's result unwrapped and unrenamed", async () => {
    harness.result = { workerStatus: "degraded", expiredLocks: 4, lastHeartbeatAgeSeconds: 12, checkedAt: "2026-09-03T12:00:00.000Z" };
    const response = await GET();
    const body = await response.json();

    expect(Object.keys(body).sort()).toEqual(["checkedAt", "expiredLocks", "lastHeartbeatAgeSeconds", "workerStatus"]);
    for (const wrapper of ["data", "result", "success", "message", "error", "payload"]) {
      expect(body).not.toHaveProperty(wrapper);
    }
  });

  it("probes through the shared client instead of building its own", async () => {
    harness.result = { workerStatus: "ok", expiredLocks: 0, lastHeartbeatAgeSeconds: null, checkedAt: "2026-09-03T12:00:00.000Z" };
    await GET();
    expect(harness.databaseArgument).toBe(prisma);
    expect(evaluateWorkerStatus).toHaveBeenCalled();

    const source = await routeSource();
    expect(source).not.toContain("new PrismaClient");
    expect(source).not.toContain("DATABASE_URL");
  });

  it("exposes only GET and requires no session", async () => {
    const route = await import("@/app/api/health/worker/route");
    expect(Object.keys(route).filter((key) => /^[A-Z]+$/.test(key))).toEqual(["GET"]);

    const source = await routeSource();
    for (const guard of ["guardRead", "guardMutation", "requireAdminRouteAccess", "readSessionToken", "next/headers", "cookies("]) {
      expect(source).not.toContain(guard);
    }
  });
});
