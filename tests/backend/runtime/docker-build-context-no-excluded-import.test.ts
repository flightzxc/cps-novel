import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Docker 构建上下文守卫（v0.5.7 镜像构建阻断的复发防线）。
 *
 * 事故：scripts/measure-tagging-task-creation-memory.ts 里有一句
 * `await import("../tests/...")`。`next build` 会按 tsconfig.json 对所有 .ts 做类型检查
 * （含 scripts/），而 .dockerignore 排除了 tests/，于是容器里报 TS2307。本地构建能过，
 * 只因为本地有 tests/ 目录——所以只有真跑镜像构建才暴露，这里用静态检查提前拦住。
 *
 * 规则：凡是会进入 Docker 构建上下文、又被 next build 类型检查覆盖的源文件
 * （.dockerignore 未排除的 *.ts / *.tsx / *.mts，覆盖 src/、scripts/、worker/、scheduler/、根目录配置），
 * 不得以任何形式引用以下目标——
 *   1. 被 .dockerignore 排除的路径（容器里不存在）；
 *   2. tests/ 下的模块（即使哪天 tests/ 被放进上下文，生产代码也不得依赖测试代码；
 *      tests/ 内部互相引用不算）；
 *   3. 仓库根目录之外的路径。
 * "引用"包含：静态 import、`import("字面量")`、`require("字面量")`（含 require.resolve）、
 * `export ... from`、`import x = require()`、`import("x").T` 类型引用、`/// <reference path>`。
 * 变量拼出来的动态路径无法静态判定，不在范围内（也不得用它来绕过本守卫）。
 *
 * 候选文件取自 `git ls-files --cached --others --exclude-standard`（已跟踪 + 未跟踪但未被 gitignore 的文件），
 * 再用 .dockerignore 过滤——不硬编码目录。不扫 gitignore 掉的生成物：例如 `next build` 生成的
 * next-env.d.ts 会 import ./.next/...，那是构建自己产出并重写的文件，不是人写的源码。
 */

const root = path.resolve(import.meta.dirname, "../../..");

// ---------------------------------------------------------------------------
// .dockerignore 匹配（与 Docker/moby patternmatcher 同语义的子集）
// ---------------------------------------------------------------------------

interface IgnoreRule {
  /** 以 ! 开头：把之前被排除的路径重新放回上下文 */
  negated: boolean;
  /** 清理后的模式文本（无前导 ! 与 /） */
  pattern: string;
  regex: RegExp;
}

function patternToRegex(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        while (pattern[i + 1] === "*") i += 1;
        if (pattern[i + 1] === "/") i += 1;
        source += i + 1 >= pattern.length ? ".*" : "(.*/)?";
      } else {
        source += "[^/]*";
      }
    } else if (ch === "?") {
      source += "[^/]";
    } else if (ch === "\\") {
      i += 1;
      if (i < pattern.length) source += pattern[i].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    } else if (ch === "[" || ch === "]") {
      source += ch;
    } else {
      source += ch.replace(/[.*+?^${}()|\\/]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

function parseDockerignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1).trim();
    }
    if (!line) continue;
    // Docker：filepath.Clean 后去掉前导 "/"；模式相对构建上下文根，*.log 只匹配根目录下的文件
    const pattern = path.posix.normalize(line).replace(/^\/+/, "").replace(/\/+$/, "");
    if (!pattern || pattern === ".") continue;
    rules.push({ negated, pattern, regex: patternToRegex(pattern) });
  }
  return rules;
}

/** 与 Docker 一致：路径本身或任一祖先目录命中，最后一条命中的规则说了算。 */
function isDockerIgnored(rules: readonly IgnoreRule[], relPath: string): boolean {
  const segments = relPath.split("/");
  const candidates: string[] = [];
  for (let i = 1; i <= segments.length; i += 1) candidates.push(segments.slice(0, i).join("/"));
  let ignored = false;
  for (const rule of rules) {
    if (rule.negated !== ignored) continue; // 与 moby 同款短路：排除规则只在"未命中"时求值，放回规则只在"已命中"时求值
    if (candidates.some((candidate) => rule.regex.test(candidate))) ignored = !rule.negated;
  }
  return ignored;
}

// ---------------------------------------------------------------------------
// 模块引用提取（TypeScript AST，不是正则：注释/字符串里的路径不会误报）
// ---------------------------------------------------------------------------

interface ModuleReference {
  specifier: string;
  line: number;
  /** reference-path 恒按相对当前文件解析；module 引用只有 ./ ../ 开头或命中 tsconfig paths 才解析 */
  kind: "module" | "reference-path";
}

function collectModuleReferences(fileName: string, text: string): ModuleReference[] {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false);
  const references: ModuleReference[] = [];
  const lineOf = (position: number) => sourceFile.getLineAndCharacterOfPosition(position).line + 1;
  const add = (literal: ts.Node, specifier: string) =>
    references.push({ specifier, line: lineOf(literal.getStart(sourceFile)), kind: "module" });

  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      add(node.moduleSpecifier, node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) {
      add(node.moduleReference.expression, node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0])) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      const isRequireResolve =
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "require" &&
        callee.name.text === "resolve";
      if (isDynamicImport || isRequire || isRequireResolve) add(node.arguments[0], node.arguments[0].text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      add(node.argument.literal, node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const reference of sourceFile.referencedFiles) {
    references.push({ specifier: reference.fileName, line: lineOf(reference.pos), kind: "reference-path" });
  }
  return references;
}

// ---------------------------------------------------------------------------
// 引用目标解析（只做路径判断，不做扩展名探测：目录前缀命中即可）
// ---------------------------------------------------------------------------

interface PathAlias {
  prefix: string;
  suffix: string;
  wildcard: boolean;
  targets: string[];
}

function readTsconfigAliases(): PathAlias[] {
  const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const options = (config.config?.compilerOptions ?? {}) as { baseUrl?: string; paths?: Record<string, string[]> };
  const baseUrl = options.baseUrl ?? ".";
  return Object.entries(options.paths ?? {}).map(([key, targets]) => {
    const star = key.indexOf("*");
    return {
      prefix: star < 0 ? key : key.slice(0, star),
      suffix: star < 0 ? "" : key.slice(star + 1),
      wildcard: star >= 0,
      targets: targets.map((target) => path.posix.join(baseUrl, target)),
    };
  });
}

/** 返回目标相对仓库根的 posix 路径；裸包名（node_modules 依赖）返回空数组。 */
function resolveReferenceTargets(
  fromRel: string,
  reference: ModuleReference,
  aliases: readonly PathAlias[],
): string[] {
  const { specifier } = reference;
  const relative = specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");
  if (relative || reference.kind === "reference-path") {
    return [path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), specifier))];
  }
  const targets: string[] = [];
  for (const alias of aliases) {
    if (alias.wildcard) {
      if (specifier.length >= alias.prefix.length + alias.suffix.length && specifier.startsWith(alias.prefix) && specifier.endsWith(alias.suffix)) {
        const middle = specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length);
        for (const target of alias.targets) targets.push(path.posix.normalize(target.replace("*", middle)));
      }
    } else if (specifier === alias.prefix) {
      for (const target of alias.targets) targets.push(path.posix.normalize(target));
    }
  }
  return targets;
}

const isUnderTests = (rel: string) => rel === "tests" || rel.startsWith("tests/");
const isOutsideRoot = (rel: string) => rel === ".." || rel.startsWith("../") || path.posix.isAbsolute(rel);

function violationReasons(fromRel: string, targetRel: string, rules: readonly IgnoreRule[]): string[] {
  const reasons: string[] = [];
  if (isOutsideRoot(targetRel)) {
    reasons.push("目标在仓库根目录之外，不在构建上下文里");
    return reasons;
  }
  if (isDockerIgnored(rules, targetRel)) reasons.push("目标被 .dockerignore 排除，容器里不存在");
  if (isUnderTests(targetRel) && !isUnderTests(fromRel)) reasons.push("非测试代码引用了 tests/ 下的模块");
  return reasons;
}

// ---------------------------------------------------------------------------
// 构建上下文里的源文件
// ---------------------------------------------------------------------------

const SOURCE_FILE = /\.(ts|tsx|mts)$/;

function listCandidateFiles(): string[] {
  let output: string;
  try {
    output = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`docker-build-context guard needs a git checkout to enumerate source files: ${String(error)}`);
  }
  return output.split("\0").filter(Boolean);
}

function listBuildContextSources(rules: readonly IgnoreRule[]): string[] {
  return [...new Set(listCandidateFiles())]
    .filter((rel) => SOURCE_FILE.test(rel))
    .filter((rel) => !isDockerIgnored(rules, rel))
    .filter((rel) => {
      const absolute = path.join(root, rel);
      // 已跟踪但工作区已删除的文件、符号链接都不会作为源文件进入类型检查
      return existsSync(absolute) && !lstatSync(absolute).isSymbolicLink();
    })
    .sort();
}

interface Violation {
  file: string;
  line: number;
  specifier: string;
  reasons: string[];
}

function findViolations(
  files: readonly string[],
  readSource: (rel: string) => string,
  rules: readonly IgnoreRule[],
  aliases: readonly PathAlias[],
): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    for (const reference of collectModuleReferences(file, readSource(file))) {
      for (const target of resolveReferenceTargets(file, reference, aliases)) {
        const reasons = violationReasons(file, target, rules);
        if (reasons.length > 0) violations.push({ file, line: reference.line, specifier: reference.specifier, reasons });
      }
    }
  }
  return violations;
}

const formatViolations = (violations: readonly Violation[]) =>
  violations
    .map((violation) => `${violation.file}:${violation.line}  "${violation.specifier}"  ← ${violation.reasons.join("；")}`)
    .join("\n");

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe("Docker 构建上下文守卫：源文件不得引用 tests/ 或被 .dockerignore 排除的路径", () => {
  const dockerignoreText = readFileSync(path.join(root, ".dockerignore"), "utf8");
  const rules = parseDockerignore(dockerignoreText);
  const aliases = readTsconfigAliases();

  describe("守卫自检（合成输入，证明检测器本身不会假绿）", () => {
    it(".dockerignore 匹配遵循 Docker 语义：根目录相对、祖先目录命中、! 放回、** 跨层", () => {
      const sample = parseDockerignore(
        ["# comment", "", "tests", "/docs/", "*.log", ".env", ".env.*", "!.env.example", "**/fixtures", "build/**/*.map"].join("\n"),
      );
      expect(isDockerIgnored(sample, "tests/backend/a.test.ts")).toBe(true);
      expect(isDockerIgnored(sample, "docs/p2/x.md")).toBe(true);
      expect(isDockerIgnored(sample, "src/tests/a.ts")).toBe(false); // 无斜杠模式只匹配根目录
      expect(isDockerIgnored(sample, "run.log")).toBe(true);
      expect(isDockerIgnored(sample, "logs/run.log")).toBe(false); // Docker 的 *.log 不会匹配子目录
      expect(isDockerIgnored(sample, ".env.local")).toBe(true);
      expect(isDockerIgnored(sample, ".env.example")).toBe(false);
      expect(isDockerIgnored(sample, "a/b/fixtures/x.ts")).toBe(true);
      expect(isDockerIgnored(sample, "fixtures/x.ts")).toBe(true);
      expect(isDockerIgnored(sample, "build/a/b/c.map")).toBe(true);
      expect(isDockerIgnored(sample, "src/app/page.tsx")).toBe(false);
    });

    it("各种引用形式都能被提取，注释与字符串里的路径不会误报，变量路径不在范围内", () => {
      const source = [
        'import a from "../tests/a";', // 1 静态 import
        'import type { T } from "../tests/b";', // 2 type import
        'export { c } from "../tests/c";', // 3 export ... from
        'export * from "../tests/d";', // 4 export * from
        'const e = await import("../tests/e");', // 5 import() 字面量
        'const f = require("../tests/f");', // 6 require 字面量
        'const g = require.resolve("../tests/g");', // 7 require.resolve
        'type H = import("../tests/h").H;', // 8 import 类型
        'import i = require("../tests/i");', // 9 import = require
        '// import("../tests/comment")',
        'const text = "import(\'../tests/string\')";',
        "const dynamic = await import(variablePath);",
        'import ok from "./sibling";',
      ].join("\n");
      const specifiers = collectModuleReferences("src/x.ts", source).map((reference) => reference.specifier);
      expect(specifiers).toEqual(
        expect.arrayContaining([
          "../tests/a",
          "../tests/b",
          "../tests/c",
          "../tests/d",
          "../tests/e",
          "../tests/f",
          "../tests/g",
          "../tests/h",
          "../tests/i",
          "./sibling",
        ]),
      );
      expect(specifiers).not.toContain("../tests/comment");
      expect(specifiers).not.toContain("../tests/string");
      expect(specifiers.filter((specifier) => specifier.startsWith("../tests/"))).toHaveLength(9);

      // /// <reference path> 只有出现在文件顶部才生效，单独验证
      const reference = collectModuleReferences("src/x.ts", '/// <reference path="../tests/j.d.ts" />\nexport {};\n');
      expect(reference).toEqual([{ specifier: "../tests/j.d.ts", line: 1, kind: "reference-path" }]);
    });

    it("行号准确，多行 import 指向说明符所在行", () => {
      const source = ["export {};", "", "import {", "  x,", '} from "../tests/multi";', 'const y = await import("../tests/dyn");'].join("\n");
      const found = collectModuleReferences("src/x.ts", source);
      expect(found.map((reference) => [reference.specifier, reference.line])).toEqual([
        ["../tests/multi", 5],
        ["../tests/dyn", 6],
      ]);
    });

    it("解析 ./ ../ 与 tsconfig paths 别名；裸包名不是文件引用", () => {
      expect(resolveReferenceTargets("scripts/a.ts", { specifier: "../tests/x", line: 1, kind: "module" }, aliases)).toEqual(["tests/x"]);
      expect(resolveReferenceTargets("scripts/lib/a.ts", { specifier: "../../src/lib/x", line: 1, kind: "module" }, aliases)).toEqual(["src/lib/x"]);
      expect(resolveReferenceTargets("scripts/a.ts", { specifier: "@/lib/x", line: 1, kind: "module" }, aliases)).toEqual(["src/lib/x"]);
      expect(resolveReferenceTargets("scripts/a.ts", { specifier: "@prisma/client", line: 1, kind: "module" }, aliases)).toEqual([]);
      expect(resolveReferenceTargets("scripts/a.ts", { specifier: "node:fs", line: 1, kind: "module" }, aliases)).toEqual([]);
      const wildcardAlias: PathAlias[] = [{ prefix: "@t/", suffix: "", wildcard: true, targets: ["tests/*"] }];
      expect(resolveReferenceTargets("src/a.ts", { specifier: "@t/y", line: 1, kind: "module" }, wildcardAlias)).toEqual(["tests/y"]);
    });

    it("违规判定：引用 tests/、引用被排除路径、越出仓库根都会命中；tests/ 内部互相引用与普通引用不会", () => {
      const sample = parseDockerignore("tests\ndocs");
      expect(violationReasons("scripts/a.ts", "tests/x", sample).length).toBe(2);
      expect(violationReasons("scripts/a.ts", "docs/x.json", sample)).toEqual(["目标被 .dockerignore 排除，容器里不存在"]);
      expect(violationReasons("scripts/a.ts", "../outside/x", sample)).toHaveLength(1);
      // tests/ 没被排除时（极端情形），生产代码仍不得依赖它；测试之间互相引用不算
      const noIgnore = parseDockerignore("docs");
      expect(violationReasons("src/a.ts", "tests/x", noIgnore)).toEqual(["非测试代码引用了 tests/ 下的模块"]);
      expect(violationReasons("tests/a.test.ts", "tests/x", noIgnore)).toEqual([]);
      expect(violationReasons("scripts/a.ts", "src/lib/x", sample)).toEqual([]);
    });

    it("端到端：合成文件集里每一种形式的 tests/ 引用都被报出文件和行号", () => {
      const files: Record<string, string> = {
        "scripts/static.ts": 'import x from "../tests/a";\n',
        "scripts/dynamic.ts": 'export {};\nawait import("../tests/b");\n',
        "src/lib/req.ts": 'const x = require("../../tests/c");\n',
        "src/lib/reexport.ts": '// header\nexport * from "../../tests/d";\n',
        "src/lib/clean.ts": 'import { x } from "@/lib/other";\n',
      };
      const found = findViolations(Object.keys(files), (rel) => files[rel], rules, aliases);
      expect(found.map((violation) => `${violation.file}:${violation.line}`).sort()).toEqual([
        "scripts/dynamic.ts:2",
        "scripts/static.ts:1",
        "src/lib/reexport.ts:2",
        "src/lib/req.ts:1",
      ]);
      expect(formatViolations(found)).toContain('scripts/dynamic.ts:2  "../tests/b"');
    });
  });

  describe("真实仓库", () => {
    const files = listBuildContextSources(rules);

    it("构建上下文候选集合理：覆盖 src/ 与 scripts/，不含 tests/ 与 docs/（它们仍被 .dockerignore 排除）", () => {
      expect(files).toEqual(
        expect.arrayContaining([
          "scripts/measure-tagging-task-creation-memory.ts",
          "scripts/lib/tagging-legacy-task-creation.ts",
          "src/server/tagging/tasks.ts",
          "worker/index.ts",
          "next.config.ts",
        ]),
      );
      expect(files.filter((rel) => rel.startsWith("src/")).length).toBeGreaterThan(100);
      expect(files.filter((rel) => rel.startsWith("scripts/")).length).toBeGreaterThan(10);
      expect(files.filter((rel) => isUnderTests(rel) || rel.startsWith("docs/"))).toEqual([]);
      expect(files).not.toContain("next-env.d.ts"); // gitignore 掉的 next build 生成物不扫
    });

    it("构建上下文内的源文件不引用 tests/、被 .dockerignore 排除的路径或仓库根之外", () => {
      const violations = findViolations(files, (rel) => readFileSync(path.join(root, rel), "utf8"), rules, aliases);
      expect(violations, `\n${formatViolations(violations)}\n`).toEqual([]);
    });

    it("B-21 旧实现 oracle 只能被测量脚本引用，不得接进 src/、worker/、scheduler/ 或其它脚本", () => {
      const oracle = "scripts/lib/tagging-legacy-task-creation";
      const allowedUser = "scripts/measure-tagging-task-creation-memory.ts";
      const offenders: string[] = [];
      for (const file of files) {
        if (file === allowedUser || file.startsWith(`${oracle}.`)) continue;
        for (const reference of collectModuleReferences(file, readFileSync(path.join(root, file), "utf8"))) {
          for (const target of resolveReferenceTargets(file, reference, aliases)) {
            if (target === oracle || target.startsWith(`${oracle}.`)) offenders.push(`${file}:${reference.line}`);
          }
        }
      }
      expect(offenders).toEqual([]);
      // 反向钉住：测量脚本确实在用它，位置没有漂回 tests/
      const measure = collectModuleReferences(allowedUser, readFileSync(path.join(root, allowedUser), "utf8"));
      expect(measure.map((reference) => reference.specifier)).toContain("./lib/tagging-legacy-task-creation");
      expect(existsSync(path.join(root, "tests/backend/tagging/_support/legacy-task-creation.ts"))).toBe(false);
    });
  });
});
