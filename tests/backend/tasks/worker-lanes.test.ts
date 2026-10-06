/// <reference types="vite/client" />
import path from "node:path";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { APPROVED_LIGHT_TASK_TYPES, MOBOREADER_UPSTREAM_TASK_TYPES, validateWorkerLaneEnvironment, parseWorkerLane } from "@/lib/tasks/worker-lanes.mjs";
import { createWorkerHandlers, resolveWorkerStartupAllowlist } from "../../../worker";

const env = {
  NODE_ENV: "test" as const,
  WORKER_LANE: "main", WORKER_ID: "main-test", WORKER_LIGHT_ID: "light-test",
  WORKER_TASK_ALLOWLIST: MOBOREADER_UPSTREAM_TASK_TYPES.join(","),
  WORKER_LIGHT_TASK_ALLOWLIST: APPROVED_LIGHT_TASK_TYPES.join(","),
};
const quiet = { info() {}, error() {} };
const modules = import.meta.glob("../../../worker/handlers/*.ts", { eager: true });

// Resolve aliases through arbitrary barrel re-exports, without following unrelated
// imports inside the broad tasks barrel. Comments/type-only imports do not count.
const config = ts.readConfigFile("tsconfig.json", ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
const program = ts.createProgram(Object.keys(modules).map(file => path.resolve("tests/backend/tasks", file)), parsed.options);
const checker = program.getTypeChecker();
function upstreamDependency(file: string): boolean {
  const source = program.getSourceFile(file)!;
  function reaches(symbol: ts.Symbol | undefined, seen = new Set<ts.Symbol>()): boolean {
    if (!symbol || seen.has(symbol)) return false;
    seen.add(symbol);
    if (symbol.flags & ts.SymbolFlags.Alias) return reaches(checker.getAliasedSymbol(symbol), seen);
    if (symbol.declarations?.some(node => /\/adapters\/(moboreader|promo-link-claim)/.test(node.getSourceFile().fileName))) return true;
    if (symbol.flags & ts.SymbolFlags.Module) return checker.getExportsOfModule(symbol).some(child => reaches(child, seen));
    return false;
  }
  return source.statements.some(node => {
    if (!ts.isImportDeclaration(node) || !node.importClause || node.importClause.isTypeOnly) return false;
    const clause = node.importClause;
    if (clause.name && reaches(checker.getSymbolAtLocation(clause.name))) return true;
    const bindings = clause.namedBindings;
    if (!bindings) return false;
    if (ts.isNamespaceImport(bindings)) return reaches(checker.getSymbolAtLocation(bindings.name));
    return bindings.elements.some(binding => !binding.isTypeOnly && reaches(checker.getSymbolAtLocation(binding.name)));
  });
}
function assertRegisteredUpstream(types: string[], registered: readonly string[]) {
  const missing = types.filter(type => !registered.includes(type));
  if (missing.length) throw new Error(`upstream_registration_missing:${missing.join(",")}`);
}

describe("worker lane safety and shared configuration", () => {
  it.each(["indexnow.sweep.v1", "indexnow_delivery"])("IndexNow %s is light-only even without overlap", type => {
    const handlers = createWorkerHandlers({} as PrismaClient);
    expect(resolveWorkerStartupAllowlist(type, handlers, quiet, "light").effective).toEqual([type]);
    expect(() => resolveWorkerStartupAllowlist(type, handlers, quiet, "main")).toThrow("worker_main_indexnow_forbidden");
    expect(() => validateWorkerLaneEnvironment({ ...env, WORKER_TASK_ALLOWLIST: type,
      WORKER_LIGHT_TASK_ALLOWLIST: "sitemap_refresh" })).toThrow("worker_main_indexnow_forbidden");
  });
  it("AST allows IndexNow and article-publish handlers while upstream registration stays enforced", () => {
    // 文章后台批量发布只做数据库操作、不调上游（开发单 §二.4），所以不依赖任何上游适配器。
    for (const file of ["indexnow-delivery.ts", "indexnow-sweep.ts", "article-publish.ts", "article-publish-batch.ts"]) {
      expect(upstreamDependency(path.resolve("worker/handlers", file)), file).toBe(false);
    }
  });
  it("preproduction includes scan but keeps delivery dark", () => {
    const source = readFileSync("infra/preproduction/preprod.env.example", "utf8");
    const light = source.match(/^WORKER_LIGHT_TASK_ALLOWLIST=(.*)$/m)![1].split(",");
    expect(light).toContain("indexnow.sweep.v1");
    expect(light).not.toContain("indexnow_delivery");
  });
  describe("文章后台批量发布任务类型（article.publish.batch.v1 / article.publish.v1）", () => {
    const PUBLISH_TYPES = ["article.publish.batch.v1", "article.publish.v1"];

    it("是轻量通道批准清单的一员，且两个类型都有 handler 注册（否则轻量通道启动后 effective 与批准清单对不上）", () => {
      for (const type of PUBLISH_TYPES) expect(APPROVED_LIGHT_TASK_TYPES).toContain(type);
      const registered = Object.keys(createWorkerHandlers({} as PrismaClient));
      for (const type of PUBLISH_TYPES) expect(registered).toContain(type);
    });

    it("在 light 通道合法：可单独启动，也可与其它轻量类型一起启动", () => {
      const handlers = createWorkerHandlers({} as PrismaClient);
      expect(resolveWorkerStartupAllowlist(PUBLISH_TYPES.join(","), handlers, quiet, "light").effective).toEqual(PUBLISH_TYPES);
      expect(resolveWorkerStartupAllowlist(`sitemap_refresh,${PUBLISH_TYPES.join(",")}`, handlers, quiet, "light").effective)
        .toEqual(["sitemap_refresh", ...PUBLISH_TYPES]);
    });

    it("不属于上游类任务：light 的上游禁令（worker_light_upstream_forbidden）不会命中它们", () => {
      for (const type of PUBLISH_TYPES) expect(MOBOREADER_UPSTREAM_TASK_TYPES).not.toContain(type);
    });

    it("main 通道：校验行为与现有规则一致（和 sitemap_refresh 等轻量类型同口径，不单列禁令）；但与 light 白名单重叠一律拒绝", () => {
      const handlers = createWorkerHandlers({} as PrismaClient);
      // 与 sitemap_refresh 同口径：main 上单独校验不抛（只有 IndexNow 两个类型是 main 禁用的）。
      expect(resolveWorkerStartupAllowlist("sitemap_refresh", handlers, quiet, "main").effective).toEqual(["sitemap_refresh"]);
      expect(resolveWorkerStartupAllowlist(PUBLISH_TYPES[1], handlers, quiet, "main").effective).toEqual([PUBLISH_TYPES[1]]);
      // 部署配置层的硬约束是互斥：同一个类型同时出现在两条白名单里，整套配置拒绝。
      for (const type of PUBLISH_TYPES) {
        expect(() => validateWorkerLaneEnvironment({
          ...env, WORKER_TASK_ALLOWLIST: `${MOBOREADER_UPSTREAM_TASK_TYPES.join(",")},${type}`,
        })).toThrow(`worker_lane_allowlist_overlap: ${type}`);
      }
    });

    it("轻量白名单是批准清单全集时（含新类型）整套部署配置通过", () => {
      const config = validateWorkerLaneEnvironment({ ...env, WORKER_LIGHT_TASK_ALLOWLIST: APPROVED_LIGHT_TASK_TYPES.join(",") });
      expect(config.light).toEqual([...APPROVED_LIGHT_TASK_TYPES]);
      expect(config.main).not.toEqual(expect.arrayContaining(PUBLISH_TYPES));
    });
  });

  it("defaults to main and rejects invalid lanes", () => {
    expect(parseWorkerLane(undefined)).toBe("main");
    expect(() => parseWorkerLane("typo")).toThrow("worker_lane_invalid");
  });
  it.each(MOBOREADER_UPSTREAM_TASK_TYPES)("startup rejects upstream %s on light", type => {
    expect(() => resolveWorkerStartupAllowlist(type, createWorkerHandlers({} as PrismaClient), quiet, "light")).toThrow("worker_light_upstream_forbidden");
  });
  it("light starts with the approved set and rejects empty or unapproved sets", () => {
    const handlers = createWorkerHandlers({} as PrismaClient);
    expect(resolveWorkerStartupAllowlist(env.WORKER_LIGHT_TASK_ALLOWLIST, handlers, quiet, "light").effective).toEqual(APPROVED_LIGHT_TASK_TYPES);
    expect(() => resolveWorkerStartupAllowlist("", handlers, quiet, "light")).toThrow();
    expect(() => resolveWorkerStartupAllowlist("article.generate.v1", handlers, quiet, "light")).toThrow("unapproved");
  });
  it.each([
    {}, { WORKER_LIGHT_TASK_ALLOWLIST: "" }, { WORKER_LIGHT_ID: "main-test" },
    { WORKER_LIGHT_ID: "" }, { WORKER_TASK_ALLOWLIST: "sitemap_refresh" },
    { WORKER_LIGHT_TASK_ALLOWLIST: "catalog_scan" }, { WORKER_LIGHT_TASK_ALLOWLIST: "typo" },
    { WORKER_LANE: "light" },
    // 文章后台批量发布：只写在轻量白名单里 → 通过；同时写进主通道白名单 → 重叠，两侧都拒绝。
    { WORKER_LIGHT_TASK_ALLOWLIST: "article.publish.batch.v1,article.publish.v1" },
    { WORKER_TASK_ALLOWLIST: "catalog_scan,article.publish.v1" },
    { WORKER_TASK_ALLOWLIST: "article.publish.batch.v1", WORKER_LIGHT_TASK_ALLOWLIST: "article.publish.batch.v1" },
  ])("shell preflight and typed consumer agree: %j", overrides => {
    const candidate = { ...env, ...overrides };
    let passes = true;
    try { validateWorkerLaneEnvironment(candidate); } catch { passes = false; }
    const result = spawnSync("bash", ["-c", 'root="$PWD"; source scripts/preproduction/lib.sh; preprod_assert_worker_lanes'], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...candidate }, encoding: "utf8",
    });
    expect(result.status === 0, result.stderr).toBe(passes);
  });
  it("the actual preflight rejects overlap before inspecting secret files or starting services", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "wo5-preflight-"));
    const file = path.join(directory, "test.env");
    try {
      writeFileSync(file, readFileSync("infra/preproduction/preprod.env.example", "utf8")
        + "\nWORKER_TASK_ALLOWLIST=sitemap_refresh\n");
      const result = spawnSync("bash", ["scripts/preproduction/preflight.sh"], {
        encoding: "utf8", env: { NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME,
          PREPROD_ENV_FILE: file, GIT_COMMIT: "a".repeat(40), CPS_NOVEL_APP_IMAGE: "cps-novel:test" },
      });
      expect(result.status).toBe(65);
      expect(result.stdout + result.stderr).toContain("worker_lane_allowlist_overlap");
      expect(result.stdout).toContain("PREPROD_PREFLIGHT=FAIL reason=worker_lanes");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("derives upstream tasks from every handler factory and catches an omitted registration", () => {
    const discovered: string[] = [];
    for (const [file, exports] of Object.entries(modules)) {
      const absolute = path.resolve("tests/backend/tasks", file);
      if (!upstreamDependency(absolute)) continue;
      const factories = Object.entries(exports as Record<string, unknown>).filter(([name]) => /^create.*WorkerHandlers$/.test(name));
      expect(factories.length, file).toBeGreaterThan(0);
      for (const [, factory] of factories) discovered.push(...Object.keys((factory as (db: PrismaClient) => object)({} as PrismaClient)));
    }
    expect(discovered.length).toBeGreaterThan(0);
    assertRegisteredUpstream(discovered, MOBOREADER_UPSTREAM_TASK_TYPES);
    expect(() => assertRegisteredUpstream([...discovered, "new.upstream.handler"], MOBOREADER_UPSTREAM_TASK_TYPES)).toThrow("new.upstream.handler");
    expect(() => assertRegisteredUpstream(discovered, [])).toThrow("upstream_registration_missing");
  });
});
