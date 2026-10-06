import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { APPROVED_LIGHT_TASK_TYPES, parseTaskTypes, validateWorkerLaneEnvironment } from "@/lib/tasks/worker-lanes.mjs";

/**
 * 文章后台批量发布的两个任务类型只能出现在 `WORKER_LIGHT_TASK_ALLOWLIST`（轻量通道），
 * 不能出现在 `WORKER_TASK_ALLOWLIST`（主通道）。这里把"仓库里所有声明这条白名单的地方"
 * 逐个核对：四份 env 样例、本地 compose 环境脚本的默认值、X8 级别表。
 * （部署时服务器 env 的取值由发布主控按发版提示词追加，不在仓库里。）
 */

const TYPES = ["article.publish.batch.v1", "article.publish.v1"];
const EXAMPLES = [
  ".env.example",
  "infra/preproduction/preprod.env.example",
  "infra/production-like/.env.example",
  "infra/production-like/.env.uat.example",
];

function line(source: string, key: string): string {
  const match = new RegExp(`^${key}=(.*)$`, "m").exec(source);
  if (!match) throw new Error(`${key} missing`);
  return match[1]!;
}

describe("文章后台批量发布 · 轻量白名单配置一致性", () => {
  it.each(EXAMPLES)("%s：两个新类型在轻量白名单里、不在主通道白名单里，且整套配置通过 validateWorkerLaneEnvironment", (file) => {
    const source = readFileSync(file, "utf8");
    const light = parseTaskTypes(line(source, "WORKER_LIGHT_TASK_ALLOWLIST"));
    for (const type of TYPES) expect(light, `${file} light`).toContain(type);
    if (/^WORKER_TASK_ALLOWLIST=/m.test(source)) {
      const main = parseTaskTypes(line(source, "WORKER_TASK_ALLOWLIST"));
      for (const type of TYPES) expect(main, `${file} main`).not.toContain(type);
      expect(() => validateWorkerLaneEnvironment({
        NODE_ENV: "test", WORKER_LANE: "main", WORKER_ID: "main", WORKER_LIGHT_ID: "light",
        WORKER_TASK_ALLOWLIST: main.join(","), WORKER_LIGHT_TASK_ALLOWLIST: light.join(","),
      } as NodeJS.ProcessEnv)).not.toThrow();
    }
    // 样例里的每个轻量类型都在批准清单内（否则 preflight 会报 worker_light_task_unapproved）。
    for (const type of light) expect(APPROVED_LIGHT_TASK_TYPES, `${file} ${type}`).toContain(type);
  });

  it("本地 compose 环境脚本的默认轻量白名单带上新类型，默认主通道白名单不带", () => {
    const source = readFileSync("scripts/lib/p1-12-local-env.sh", "utf8");
    const light = /WORKER_LIGHT_TASK_ALLOWLIST="\$\{WORKER_LIGHT_TASK_ALLOWLIST:-([^}]*)\}"/.exec(source)![1]!;
    const main = /WORKER_TASK_ALLOWLIST="\$\{WORKER_TASK_ALLOWLIST:-([^}]*)\}"/.exec(source)![1]!;
    for (const type of TYPES) {
      expect(parseTaskTypes(light)).toContain(type);
      expect(parseTaskTypes(main)).not.toContain(type);
    }
  });

  it("X8 级别表：每个级别的轻量白名单都带上新类型，主通道白名单都不带（x8-validate-compose 逐字比对这张表）", () => {
    const levels = JSON.parse(readFileSync("scripts/lib/x8-levels.json", "utf8")) as Record<string, Record<string, string>>;
    for (const level of ["0", "uat", "r"]) {
      const light = parseTaskTypes(levels[level]!.workerLightTaskAllowlist);
      const main = parseTaskTypes(levels[level]!.workerTaskAllowlist);
      for (const type of TYPES) {
        expect(light, `level ${level} light`).toContain(type);
        expect(main, `level ${level} main`).not.toContain(type);
      }
      for (const type of light) expect(APPROVED_LIGHT_TASK_TYPES).toContain(type);
    }
  });

  it("预检脚本 preflight 里没有任何一条断言枚举或限定轻量白名单的内容（除 indexnow_delivery 一致性与 worker lane 校验）", () => {
    const lib = readFileSync("scripts/preproduction/lib.sh", "utf8");
    const mentions = lib.split("\n").filter((text) => /WORKER_LIGHT_TASK_ALLOWLIST/.test(text) && !/^\s*#/.test(text));
    // 只有两处代码行引用：indexnow_delivery 成员判定，以及把它交给 validateWorkerLaneEnvironment 的同一份 env。
    expect(mentions.every((text) => /indexnow_delivery/.test(text))).toBe(true);
    expect(lib).not.toMatch(/article\.publish/);
  });
});
