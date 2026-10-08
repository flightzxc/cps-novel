import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  APPROVED_LIGHT_TASK_TYPES,
  MOBOREADER_UPSTREAM_TASK_TYPES,
  parseTaskTypes,
  validateWorkerLaneEnvironment,
} from "@/lib/tasks/worker-lanes.mjs";
import { REVENUE_SYNC_TASK_TYPE } from "@/lib/tasks/revenue-sync";
import { createWorkerHandlers, resolveWorkerStartupAllowlist } from "../../../worker";

/**
 * `moboreader.revenue_sync.v1` 调用畅读 GetReport（上游），所以和 catalog_scan / 试读 / 领推广一样：
 * 只能出现在**主通道**白名单，轻量通道不得出现，两条白名单不得重叠。
 */
const TYPE = REVENUE_SYNC_TASK_TYPE;
const quiet = { info() {}, error() {} };
const baseEnv = {
  NODE_ENV: "test" as const,
  WORKER_LANE: "main", WORKER_ID: "main-test", WORKER_LIGHT_ID: "light-test",
  WORKER_TASK_ALLOWLIST: MOBOREADER_UPSTREAM_TASK_TYPES.join(","),
  WORKER_LIGHT_TASK_ALLOWLIST: APPROVED_LIGHT_TASK_TYPES.join(","),
};

function line(source: string, key: string): string {
  const match = new RegExp(`^${key}=(.*)$`, "m").exec(source);
  if (!match) throw new Error(`${key} missing`);
  return match[1]!;
}

describe("moboreader.revenue_sync.v1 · 通道登记", () => {
  it("登记为上游类任务（只能主通道），不在轻量批准清单里；已有 handler 注册", () => {
    expect(TYPE).toBe("moboreader.revenue_sync.v1");
    expect(MOBOREADER_UPSTREAM_TASK_TYPES).toContain(TYPE);
    expect(APPROVED_LIGHT_TASK_TYPES).not.toContain(TYPE);
    const registry = createWorkerHandlers({} as PrismaClient);
    expect(Object.keys(registry)).toContain(TYPE);
    expect(registry[TYPE]).toMatchObject({ family: "generic", maxAttempts: 1 });
  });

  it("主通道启动合法；轻量通道启动被 worker_light_upstream_forbidden 拒绝", () => {
    const handlers = createWorkerHandlers({} as PrismaClient);
    expect(resolveWorkerStartupAllowlist(TYPE, handlers, quiet, "main").effective).toEqual([TYPE]);
    expect(() => resolveWorkerStartupAllowlist(TYPE, handlers, quiet, "light")).toThrow("worker_light_upstream_forbidden");
    expect(() => resolveWorkerStartupAllowlist(`sitemap_refresh,${TYPE}`, handlers, quiet, "light")).toThrow("worker_light_upstream_forbidden");
  });

  it("validateWorkerLaneEnvironment：该类型出现在 worker-light 白名单里被拒绝", () => {
    expect(() =>
      validateWorkerLaneEnvironment({ ...baseEnv, WORKER_LIGHT_TASK_ALLOWLIST: `${APPROVED_LIGHT_TASK_TYPES.join(",")},${TYPE}`, WORKER_TASK_ALLOWLIST: "catalog_scan" }),
    ).toThrow(`worker_light_upstream_forbidden: ${TYPE}`);
    expect(() =>
      validateWorkerLaneEnvironment({ ...baseEnv, WORKER_LIGHT_TASK_ALLOWLIST: TYPE, WORKER_TASK_ALLOWLIST: "catalog_scan" }),
    ).toThrow("worker_light_upstream_forbidden");
  });

  it("validateWorkerLaneEnvironment：主 / 轻量两条白名单重叠被拒绝（worker_lane_allowlist_overlap）", () => {
    expect(() =>
      validateWorkerLaneEnvironment({ ...baseEnv, WORKER_LIGHT_TASK_ALLOWLIST: `sitemap_refresh,${TYPE}` }),
    ).toThrow(`worker_lane_allowlist_overlap: ${TYPE}`);
  });

  it("只写在主通道白名单里：整套配置通过", () => {
    const config = validateWorkerLaneEnvironment({ ...baseEnv, WORKER_TASK_ALLOWLIST: `catalog_scan,${TYPE}` });
    expect(config.main).toContain(TYPE);
    expect(config.light).not.toContain(TYPE);
  });

  it.each([
    ["轻量通道出现该类型", { WORKER_LIGHT_TASK_ALLOWLIST: `sitemap_refresh,${TYPE}`, WORKER_TASK_ALLOWLIST: "catalog_scan" }],
    ["主 / 轻量重叠", { WORKER_LIGHT_TASK_ALLOWLIST: `sitemap_refresh,${TYPE}`, WORKER_TASK_ALLOWLIST: `catalog_scan,${TYPE}` }],
    ["只在主通道（合法）", { WORKER_TASK_ALLOWLIST: `catalog_scan,${TYPE}` }],
  ])("shell preflight 与 TypeScript 校验结论一致：%s", (_name, overrides) => {
    const candidate = { ...baseEnv, ...overrides };
    let passes = true;
    try { validateWorkerLaneEnvironment(candidate); } catch { passes = false; }
    const result = spawnSync("bash", ["-c", 'root="$PWD"; source scripts/preproduction/lib.sh; preprod_assert_worker_lanes'], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...candidate }, encoding: "utf8",
    });
    expect(result.status === 0, result.stderr).toBe(passes);
  });
});

describe("moboreader.revenue_sync.v1 · 仓库里声明白名单的每个地方", () => {
  const MAIN_EXAMPLES = [".env.example", "infra/preproduction/preprod.env.example", "infra/production-like/.env.uat.example"];

  it.each(MAIN_EXAMPLES)("%s：主通道白名单带该类型，轻量白名单不带，且整套配置通过校验", (file) => {
    const source = readFileSync(file, "utf8");
    const main = parseTaskTypes(line(source, "WORKER_TASK_ALLOWLIST"));
    const light = parseTaskTypes(line(source, "WORKER_LIGHT_TASK_ALLOWLIST"));
    expect(main, `${file} main`).toContain(TYPE);
    expect(light, `${file} light`).not.toContain(TYPE);
    expect(() => validateWorkerLaneEnvironment({
      NODE_ENV: "test", WORKER_LANE: "main", WORKER_ID: "main", WORKER_LIGHT_ID: "light",
      WORKER_TASK_ALLOWLIST: main.join(","), WORKER_LIGHT_TASK_ALLOWLIST: light.join(","),
    } as NodeJS.ProcessEnv)).not.toThrow();
  });

  it("infra/production-like/.env.example 只声明轻量白名单（Level 0 模板），不带该类型", () => {
    const light = parseTaskTypes(line(readFileSync("infra/production-like/.env.example", "utf8"), "WORKER_LIGHT_TASK_ALLOWLIST"));
    expect(light).not.toContain(TYPE);
  });

  it("X8 级别表：UAT 与 R 的主通道白名单带该类型；Level 0 保持 launch 原值（不带）；任何级别的轻量白名单都不带", () => {
    const levels = JSON.parse(readFileSync("scripts/lib/x8-levels.json", "utf8")) as Record<string, Record<string, string>>;
    expect(parseTaskTypes(levels.uat!.workerTaskAllowlist)).toContain(TYPE);
    expect(parseTaskTypes(levels.r!.workerTaskAllowlist)).toContain(TYPE);
    expect(parseTaskTypes(levels["0"]!.workerTaskAllowlist)).not.toContain(TYPE);
    for (const level of ["0", "uat", "r"]) {
      expect(parseTaskTypes(levels[level]!.workerLightTaskAllowlist), `level ${level} light`).not.toContain(TYPE);
      expect(() => validateWorkerLaneEnvironment({
        NODE_ENV: "test", WORKER_LANE: "main", WORKER_ID: "main", WORKER_LIGHT_ID: "light",
        WORKER_TASK_ALLOWLIST: levels[level]!.workerTaskAllowlist, WORKER_LIGHT_TASK_ALLOWLIST: levels[level]!.workerLightTaskAllowlist,
      } as NodeJS.ProcessEnv), `level ${level}`).not.toThrow();
    }
  });

  it("发布检查清单（Level UAT）与 X8 级别表逐字一致", () => {
    const levels = JSON.parse(readFileSync("scripts/lib/x8-levels.json", "utf8")) as Record<string, Record<string, string>>;
    const checklist = readFileSync("docs/p2/V020_RELEASE_CHECKLIST.md", "utf8");
    expect(checklist).toContain(`WORKER_TASK_ALLOWLIST=${levels.uat!.workerTaskAllowlist}`);
  });
});
