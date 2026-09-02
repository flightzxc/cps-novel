import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { BackupHealthResult } from "@/server/health/backup-status";

/**
 * RC-7b `/api/health/backup` route-handler contract.
 *
 * Lives in `tests/ui/` for the same reason as `health-route-contract.test.ts`:
 * `tests/backend/**` is Codex's vitest project and would never collect a test
 * placed there for a `src/app/**` route. Scope is the handler only — status
 * code mapping to `BackupStatusValue`, response envelope, and the `no-store`
 * cache header. The evaluation semantics themselves are covered by
 * `tests/backend/health/rc7b-backup-status.test.ts`.
 */

const harness = vi.hoisted(() => ({
  result: {
    backupStatus: "ok",
    checkedAt: "2026-09-03T12:00:00.000Z",
    ageHours: 1,
    source: "status_file",
  } as BackupHealthResult,
}));

vi.mock("@/server/health/backup-status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/health/backup-status")>();
  return {
    ...actual,
    evaluateBackupStatus: vi.fn(async () => harness.result),
  };
});

const { GET, runtime, dynamic } = await import("@/app/api/health/backup/route");
const { evaluateBackupStatus } = await import("@/server/health/backup-status");

async function routeSource(): Promise<string> {
  return readFile(path.resolve(process.cwd(), "src/app/api/health/backup/route.ts"), "utf8");
}

describe("RC-7b /api/health/backup route handler", () => {
  it.each([
    ["ok", 200],
    ["unconfigured", 200],
    ["failed", 503],
    ["stale", 503],
  ] as const)("maps backupStatus %s to HTTP %i", async (backupStatus, expectedStatus) => {
    harness.result = { backupStatus, checkedAt: "2026-09-03T12:00:00.000Z", ageHours: null, source: "none" };

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(expectedStatus);
    expect(body).toEqual(harness.result);
  });

  it("marks every response no-store regardless of status", async () => {
    for (const backupStatus of ["ok", "unconfigured", "failed", "stale"] as const) {
      harness.result = { backupStatus, checkedAt: "2026-09-03T12:00:00.000Z", ageHours: null, source: "none" };
      const response = await GET();
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("declares the Node runtime and refuses static generation", () => {
    expect(runtime).toBe("nodejs");
    expect(dynamic).toBe("force-dynamic");
  });

  it("returns the evaluator's result unwrapped and unrenamed", async () => {
    harness.result = { backupStatus: "ok", checkedAt: "2026-09-03T12:00:00.000Z", ageHours: 2.5, source: "output_dir" };
    const response = await GET();
    const body = await response.json();

    expect(Object.keys(body).sort()).toEqual(["ageHours", "backupStatus", "checkedAt", "source"]);
    for (const wrapper of ["data", "result", "success", "message", "error", "payload"]) {
      expect(body).not.toHaveProperty(wrapper);
    }
  });

  /**
   * RC-7b 唯一的生产合同：外部监控是 UptimeRobot 的 **Keyword** 类型，关键词就是
   * 字面子串 `"backupStatus":"ok"`。本文件其余断言全部走 `response.json()`，解析
   * 会把空白规范化掉，因此看不见序列化方式的改变——把 `Response.json(result)` 换成
   * `JSON.stringify(result, null, 2)` 会输出 `"backupStatus": "ok"`（冒号后多一个
   * 空格），解析后的 body 一模一样、所有既有用例继续绿，而线上监控从此再也匹配不
   * 上关键词。所以这里断言的是**原始字节**，不是解析结果。
   */
  it("在原始响应体里逐字输出监控关键词，且非 ok 时一定不出现", async () => {
    harness.result = { backupStatus: "ok", checkedAt: "2026-09-03T12:00:00.000Z", ageHours: 1, source: "status_file" };
    const okBody = await (await GET()).text();
    expect(okBody).toContain('"backupStatus":"ok"');

    for (const backupStatus of ["unconfigured", "failed", "stale"] as const) {
      harness.result = { backupStatus, checkedAt: "2026-09-03T12:00:00.000Z", ageHours: null, source: "none" };
      const body = await (await GET()).text();
      expect(body, `${backupStatus} 不该满足监控关键词`).not.toContain('"backupStatus":"ok"');
    }
  });

  it("exposes only GET and requires no session", async () => {
    const route = await import("@/app/api/health/backup/route");
    expect(Object.keys(route).filter((key) => /^[A-Z]+$/.test(key))).toEqual(["GET"]);

    const source = await routeSource();
    for (const guard of ["guardRead", "guardMutation", "requireAdminRouteAccess", "readSessionToken", "next/headers", "cookies("]) {
      expect(source).not.toContain(guard);
    }
  });

  it("calls the evaluator through the shared module rather than duplicating logic", async () => {
    harness.result = { backupStatus: "ok", checkedAt: "2026-09-03T12:00:00.000Z", ageHours: 0, source: "status_file" };
    await GET();
    expect(evaluateBackupStatus).toHaveBeenCalled();
  });
});
