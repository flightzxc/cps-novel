import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ARTICLE_PUBLISH_TASK_TYPE } from "@/domain/article-publish-batch";
import {
  INDEXNOW_OUTBOX_ALLOW_WRITE_FLAG,
  INDEXNOW_OUTBOX_FEATURE_FLAG,
  isIndexNowOutboxEnabled,
  isIndexNowOutboxWriteAllowed,
} from "@/lib/flags/feature-flags";
import { APPROVED_LIGHT_TASK_TYPES } from "@/lib/tasks/worker-lanes.mjs";

/**
 * B-34 派生式契约：IndexNow 出站双闸（`FEATURE_INDEXNOW_OUTBOX` /
 * `INDEXNOW_OUTBOX_ALLOW_WRITE`）必须透传给**每一个会执行发布核心的服务**，取值逐字相同；
 * 不执行发布核心的服务不得带。
 *
 * 为什么是契约：`enqueueIndexNow` 读的是**当前进程**的 env（`isIndexNowOutbox*` 的 env 参数
 * 默认 `process.env`，调用时才读）。发布核心 `applyPublishTransition` 既在 web（"发布"按钮）里
 * 跑，也在 worker 进程里跑（后台批量发布子任务 `article.publish.v1`）。只给 web 透传的话，
 * 一旦 web 上改成 true，按钮发布写出站记录，后台批量发布不写，两条路径悄悄分叉。
 *
 * 本文件里没有任何手写的服务清单和变量名：
 *   - 变量名来自 `feature-flags.ts` 导出的常量；
 *   - "哪些服务会读这两个变量"由源码导入关系派生——先找出真正调用读取函数的模块（读取点），
 *     再看每个服务的启动入口（从渲染后的 compose `command` → 启动脚本 → `tsx <入口>` 解析）
 *     的静态导入闭包是否含读取点；web 的入口是 Next，用"发布"按钮的 Server Action 文件代表；
 *   - 取值一致性由三套 compose（根文件、预生产叠加、production-like 叠加）真实渲染后逐字比对。
 *
 * 与 `p1-12-compose-contract.test.ts`（静态文本层）、`worker-light-compose-contract.test.ts`
 * （worker 与 worker-light 环境逐项一致）、`scripts/acceptance/x8-validate-compose.mjs`
 * （X8 渲染校验）互为补充。
 */

const root = resolve(import.meta.dirname, "../../..");
const COMPOSE_FILES = ["docker-compose.yml", "infra/preproduction/docker-compose.yml", "infra/production-like/docker-compose.yml"];
const OVERLAYS: ReadonlyArray<string | undefined> = [undefined, COMPOSE_FILES[1], COMPOSE_FILES[2]];
const FEATURE = INDEXNOW_OUTBOX_FEATURE_FLAG;
const ALLOW = INDEXNOW_OUTBOX_ALLOW_WRITE_FLAG;
const OUTBOX_VARS = [FEATURE, ALLOW] as const;

/** web 的 Next 应用没有单一入口文件：用"发布"按钮的 Server Action 文件代表 web 进程里的发布路径。 */
const WEB_PUBLISH_BUTTON_ENTRY = "src/app/(admin)/articles/_actions.ts";
/** 发布核心所在模块（`applyPublishTransition` 的定义处），只用于派生自检。 */
const PUBLISH_CORE_MODULE = "src/server/publish-gate/service.ts";

// ---------------------------------------------------------------------------
// 源码导入关系（静态闭包）
// ---------------------------------------------------------------------------

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

function resolveImport(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(root, "src", specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(from), specifier);
  else return null;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, join(base, "index.ts"), join(base, "index.mjs")];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

const closureCache = new Map<string, ReadonlySet<string>>();
/** 入口文件的静态导入闭包（相对仓库根的路径集合）。不剥注释：宁可多算（用派生自检兜底），不能漏算。 */
function importClosure(entry: string): ReadonlySet<string> {
  const cached = closureCache.get(entry);
  if (cached) return cached;
  const seen = new Set<string>();
  const stack = [resolve(root, entry)];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT_RE)) {
      const target = resolveImport(file, match[1]!);
      if (target) stack.push(target);
    }
  }
  const result = new Set([...seen].map((file) => relative(root, file)));
  closureCache.set(entry, result);
  return result;
}

function walkSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkSources(path));
    else if (/\.(ts|tsx|mjs)$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** 读取点 = 代码行（非注释）里真正引用读取函数或变量名常量的模块；定义它们的 feature-flags.ts 不算。 */
const READER_TOKENS = [
  "isIndexNowOutboxEnabled",
  "isIndexNowOutboxWriteAllowed",
  "INDEXNOW_OUTBOX_FEATURE_FLAG",
  "INDEXNOW_OUTBOX_ALLOW_WRITE_FLAG",
] as const;
function findReaderModules(): string[] {
  const readers: string[] = [];
  for (const dir of ["src", "worker", "scheduler"]) {
    for (const file of walkSources(dir)) {
      if (file === "src/lib/flags/feature-flags.ts") continue;
      const code = readFileSync(resolve(root, file), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .join("\n");
      if (READER_TOKENS.some((token) => code.includes(token))) readers.push(file);
    }
  }
  return readers;
}

// ---------------------------------------------------------------------------
// 三套 compose 的真实渲染
// ---------------------------------------------------------------------------

type RenderedService = { command?: string[]; environment?: Record<string, string> };

const baseEnv: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME };
for (const file of COMPOSE_FILES) {
  for (const match of readFileSync(resolve(root, file), "utf8").matchAll(/\$\{([A-Z0-9_]+):\?/g)) {
    baseEnv[match[1]!] = "/tmp/b34-compose-fixture";
  }
}
Object.assign(baseEnv, {
  CPS_NOVEL_APP_IMAGE: "cps-novel:b34-test",
  APP_VERSION: "0.5.11",
  GIT_COMMIT: "a".repeat(40),
  SITE_URL: "https://example.test",
  TZ: "Asia/Tokyo",
  BUILD_DATE: "2026-10-08T00:00:00Z",
  WORKER_ID: "main-test",
  WORKER_LIGHT_ID: "light-test",
  WORKER_LANE: "main",
  WORKER_TASK_ALLOWLIST: "catalog_scan",
  WORKER_LIGHT_TASK_ALLOWLIST: APPROVED_LIGHT_TASK_TYPES.join(","),
});

function render(overlay: string | undefined, scenario: Record<string, string>): Record<string, RenderedService> {
  const args = [
    "compose",
    "-f", resolve(root, COMPOSE_FILES[0]!),
    ...(overlay ? ["-f", resolve(root, overlay)] : []),
    "config", "--format", "json",
  ];
  const result = spawnSync("docker", args, { cwd: root, env: { ...baseEnv, ...scenario }, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return (JSON.parse(result.stdout) as { services: Record<string, RenderedService> }).services;
}

/** 服务的启动入口：compose command 里的 .sh 启动脚本 → 其中第一条 `tsx <文件>`。web 用按钮 Server Action 代表。 */
function entryOf(service: RenderedService): string | null {
  const script = service.command?.find((arg) => arg.endsWith(".sh"));
  // 不是仓库内的脚本（例如 backup-timer 在宿主机路径下挂载的备份脚本）= 与应用入口无关。
  if (!script || isAbsolute(script) || !existsSync(resolve(root, script))) return null;
  if (script.endsWith("start-web.sh")) return WEB_PUBLISH_BUTTON_ENTRY;
  const match = /^\s*(?:exec\s+)?tsx\s+(\S+\.ts)\b/m.exec(readFileSync(resolve(root, script), "utf8"));
  return match?.[1] ?? null;
}

/** 渲染结果里"会读这对开关"的服务名：入口的导入闭包含任一读取点。 */
function derivePassthroughServices(services: Record<string, RenderedService>, readers: readonly string[]): string[] {
  return Object.entries(services)
    .filter(([, service]) => {
      const entry = entryOf(service);
      return entry !== null && readers.some((reader) => importClosure(entry).has(reader));
    })
    .map(([name]) => name)
    .sort();
}

const READERS = findReaderModules();
const asEnv = (values: Record<string, string | undefined>) => values as unknown as NodeJS.ProcessEnv;

describe("B-34 IndexNow 出站双闸透传契约（服务清单由源码派生，取值由渲染结果逐字比对）", () => {
  it("派生自检：读取点只有 outbox 写入模块；web、worker、worker-light 的入口会走到发布核心和读取点，scheduler 不会", () => {
    expect(READERS).toEqual(["src/lib/indexnow/outbox.ts"]);

    // 读取点必须是发布核心的下游：发布核心的闭包里有它，也就是"谁执行发布核心，谁就读这对开关"。
    expect(importClosure(PUBLISH_CORE_MODULE).has(READERS[0]!)).toBe(true);
    // 后台批量发布的子任务 handler 在 worker 里调用发布核心，且被 worker 入口注册。
    const workerHandler = readFileSync(resolve(root, "worker/handlers/article-publish.ts"), "utf8");
    expect(workerHandler).toContain("applyPublishTransition");
    expect(workerHandler).toContain("ARTICLE_PUBLISH_TASK_TYPE");
    expect(readFileSync(resolve(root, "worker/index.ts"), "utf8")).toContain("createArticlePublishWorkerHandlers(prisma)");
    // 部署上这个任务类型归轻量通道消费（批准清单里有它）。
    expect(APPROVED_LIGHT_TASK_TYPES).toContain(ARTICLE_PUBLISH_TASK_TYPE);

    const services = render(undefined, {});
    expect(derivePassthroughServices(services, READERS)).toEqual(["web", "worker", "worker-light"]);
    // scheduler 的入口闭包里既没有读取点也没有发布核心。
    const schedulerEntry = entryOf(services.scheduler!);
    expect(schedulerEntry).toBe("scheduler/index.ts");
    expect(importClosure(schedulerEntry!).has(PUBLISH_CORE_MODULE)).toBe(false);
    expect(importClosure(schedulerEntry!).has(READERS[0]!)).toBe(false);
    // 两个 worker 服务跑的是同一个入口（同一份 handler 注册表）。
    expect(entryOf(services.worker!)).toBe("worker/index.ts");
    expect(entryOf(services["worker-light"]!)).toBe("worker/index.ts");
  });

  const SCENARIOS: ReadonlyArray<{ name: string; env: Record<string, string>; expected: readonly [string, string] }> = [
    { name: "两个都未设置（默认关）", env: {}, expected: ["false", "false"] },
    { name: "两个都 true", env: { [FEATURE]: "true", [ALLOW]: "true" }, expected: ["true", "true"] },
    { name: "只有总闸 true（dry-run 形状）", env: { [FEATURE]: "true" }, expected: ["true", "false"] },
    { name: "只有写闸 true", env: { [ALLOW]: "true" }, expected: ["false", "true"] },
    { name: "非布尔文本原样到达（不做任何归一化）", env: { [FEATURE]: "TRUE", [ALLOW]: "1" }, expected: ["TRUE", "1"] },
  ];

  describe.each(OVERLAYS.map((overlay) => [overlay ?? "docker-compose.yml（根文件单独渲染）", overlay] as const))("compose 渲染：%s", (_label, overlay) => {
    it.each(SCENARIOS)("$name：执行发布核心的服务逐字相同并等于预期，其余服务不带", ({ env, expected }) => {
      const services = render(overlay, env);
      const publishers = derivePassthroughServices(services, READERS);
      expect(publishers).toEqual(["web", "worker", "worker-light"]);

      for (const [name, service] of Object.entries(services)) {
        const rendered = service.environment ?? {};
        if (publishers.includes(name)) {
          expect([rendered[FEATURE], rendered[ALLOW]], `${name} ${OUTBOX_VARS.join(",")}`).toEqual(expected);
          // 容器里的真实 env 喂给 TS 解析：与预期的布尔语义一致（"TRUE"/"1" 这类被解析为关，正是 preflight 必须拒绝它们的原因）。
          expect(isIndexNowOutboxEnabled(asEnv(rendered)), `${name} feature`).toBe(expected[0] === "true");
          expect(isIndexNowOutboxWriteAllowed(asEnv(rendered)), `${name} allow`).toBe(expected[1] === "true");
        } else {
          for (const variable of OUTBOX_VARS) expect(rendered[variable], `${name} must not carry ${variable}`).toBeUndefined();
        }
      }
      // 逐字相同：所有执行发布核心的服务，两个变量的取值与 web 一模一样。
      for (const name of publishers) {
        expect(services[name]!.environment![FEATURE]).toBe(services.web!.environment![FEATURE]);
        expect(services[name]!.environment![ALLOW]).toBe(services.web!.environment![ALLOW]);
      }
    });
  });

  it("TS 解析 ↔ preflight ↔ 样例/级别表三处一致：同一对变量名、同一个取值域（只认精确的 true/false）", () => {
    // 变量名：preflight 登记制函数、三份 env 样例、X8 级别表里出现的就是 TS 常量导出的这两个名字。
    const lib = readFileSync(resolve(root, "scripts/preproduction/lib.sh"), "utf8");
    const gates = /preprod_assert_indexnow_gates\(\) \{([\s\S]*?)\n\}/.exec(lib)?.[1] ?? "";
    expect(gates).not.toBe("");
    for (const variable of OUTBOX_VARS) expect(gates).toContain(`\${${variable}:-}`);
    for (const sample of [".env.example", "infra/preproduction/preprod.env.example", "infra/production-like/.env.uat.example"]) {
      const source = readFileSync(resolve(root, sample), "utf8");
      // 样例里的默认值保持 false：本单只修透传，不开闸。
      for (const variable of OUTBOX_VARS) expect(source, `${sample} ${variable}`).toMatch(new RegExp(`^${variable}=false$`, "m"));
    }
    const levels = JSON.parse(readFileSync(resolve(root, "scripts/lib/x8-levels.json"), "utf8")) as Record<string, { flags?: Record<string, string> }>;
    for (const level of ["0", "uat", "r"]) {
      for (const variable of OUTBOX_VARS) expect(levels[level]!.flags![variable], `x8 level ${level} ${variable}`).toBe("false");
    }

    // 取值域：preflight 对 outbox 两项只接受精确的 true/false；凡是被它拒绝的文本，TS 都会读成"关"
    // ——也就是容器里会悄悄关闭——所以拒绝是必要的；被接受的文本，TS 的解析恰好等于字面。
    const run = (feature: string, allow: string) =>
      spawnSync(
        "bash",
        ["-c", `set -euo pipefail\nsource "${resolve(root, "scripts/preproduction/lib.sh")}"\npreprod_assert_indexnow_gates public 1 0`],
        {
          encoding: "utf8",
          env: {
            NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME,
            [FEATURE]: feature, [ALLOW]: allow,
            FEATURE_INDEXNOW_DELIVERY: "false", INDEXNOW_DELIVERY_ALLOW_WRITE: "false",
            WORKER_LIGHT_TASK_ALLOWLIST: "sitemap_refresh", WORKER_TASK_ALLOWLIST: "catalog_scan",
          },
        },
      );
    for (const value of ["true", "false", "TRUE", "True", "1", "yes", ""]) {
      const exact = value === "true" || value === "false";
      for (const [feature, allow] of [[value, "false"], ["false", value]] as const) {
        const result = run(feature, allow);
        if (exact) {
          expect(result.status, `${feature}/${allow}: ${result.stdout}${result.stderr}`).toBe(0);
          expect(isIndexNowOutboxEnabled(asEnv({ [FEATURE]: feature }))).toBe(feature === "true");
          expect(isIndexNowOutboxWriteAllowed(asEnv({ [ALLOW]: allow }))).toBe(allow === "true");
        } else {
          expect(result.status, `${feature}/${allow}`).toBe(65);
          expect(result.stdout.trim()).toBe("indexnow_outbox_invalid");
          // 被拒的文本在 TS 里都是"关"：不拒绝的话就是 preflight 说开、容器里其实关。
          expect(isIndexNowOutboxEnabled(asEnv({ [FEATURE]: feature }))).toBe(false);
          expect(isIndexNowOutboxWriteAllowed(asEnv({ [ALLOW]: allow }))).toBe(false);
        }
      }
    }
  });
});
