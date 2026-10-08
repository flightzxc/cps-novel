import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { parseTaskTypes } from "@/lib/tasks/worker-lanes.mjs";
import { REVENUE_SYNC_TASK_TYPE } from "@/lib/tasks/revenue-sync";

/**
 * 本地 compose 环境脚本的默认白名单。单独成文件、且**不 spawn 任何子进程**：
 * `tests/backend/runtime/runtime-dir-isolation-guard.test.ts` 要求“提到该脚本的测试文件里的每个 spawn 都必须隔离运行目录”，
 * 而这里只是读文本，没有任何进程会读写运行目录。
 */
describe("moboreader.revenue_sync.v1 · 本地 compose 环境脚本", () => {
  it("本地 compose 环境脚本：默认主通道白名单带该类型，默认轻量白名单不带", () => {
    const source = readFileSync("scripts/lib/p1-12-local-env.sh", "utf8");
    const light = /WORKER_LIGHT_TASK_ALLOWLIST="\$\{WORKER_LIGHT_TASK_ALLOWLIST:-([^}]*)\}"/.exec(source)![1]!;
    const main = /WORKER_TASK_ALLOWLIST="\$\{WORKER_TASK_ALLOWLIST:-([^}]*)\}"/.exec(source)![1]!;
    expect(parseTaskTypes(main)).toContain(REVENUE_SYNC_TASK_TYPE);
    expect(parseTaskTypes(light)).not.toContain(REVENUE_SYNC_TASK_TYPE);
  });
});
