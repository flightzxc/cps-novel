import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = path.join(process.cwd(), "scripts/p1-13-project-isolation-check.sh");
let root: string;
let project: string;
let cps: string;
let cpsHead: string;

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commitAll(cwd: string, message: string) {
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.name=P1-13", "-c", "user.email=p1-13@example.test", "commit", "-m", message);
}

function run(extraEnv: Record<string, string | undefined> = {}) {
  return spawnSync("bash", [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      P1_13_PROJECT_ROOT: project,
      P1_13_CPS_ROOT: cps,
      P1_13_CPS_EXPECTED_HEAD: cpsHead,
      ...extraEnv,
    },
  });
}

describe("P1-13 project isolation check", () => {
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "P1-13 隔离 fixture "));
    project = path.join(root, "小说 项目");
    cps = path.join(root, "CPS 只读参考");
    mkdirSync(path.join(project, "src", "中文 目录"), { recursive: true });
    mkdirSync(cps, { recursive: true });
    git(project, "init", "-q");
    git(cps, "init", "-q");
    writeFileSync(path.join(project, "package.json"), "{\"name\":\"novel-test\"}\n");
    writeFileSync(path.join(project, "src", "中文 目录", "入口.ts"), "export const isolated = true;\n");
    commitAll(project, "project fixture");
    writeFileSync(path.join(cps, "README.md"), "reference\n");
    commitAll(cps, "cps fixture");
    cpsHead = git(cps, "rev-parse", "HEAD");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("passes clean repositories whose paths contain spaces and Chinese", () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("P1_13_PROJECT_ISOLATION=PASS");
  });

  it("fails closed on a tracked Git symlink and names its path", () => {
    symlinkSync("package.json", path.join(project, "链接.ts"));
    git(project, "add", "链接.ts");
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("category=GIT_SYMLINK");
    expect(result.stderr).toContain("链接.ts");
  });

  it("fails closed on a gitlink even without .gitmodules", () => {
    git(project, "update-index", "--add", "--cacheinfo", `160000,${cpsHead},vendor/cps-ref`);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("category=GIT_SUBMODULE");
    expect(result.stderr).toContain("vendor/cps-ref");
  });

  it("fails closed when .gitmodules exists", () => {
    writeFileSync(path.join(project, ".gitmodules"), "[submodule \"bad\"]\n");
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("category=GITMODULES");
  });

  it("rejects runtime and build references to the CPS repository", () => {
    writeFileSync(path.join(project, "src", "bad.ts"), `import x from "${cps}/src/private";\nvoid x;\n`);
    git(project, "add", "src/bad.ts");
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/category=CPS_(ABSOLUTE_REFERENCE|REPOSITORY_REFERENCE|RUNTIME_IMPORT)/);
    expect(result.stderr).toContain("src/bad.ts");
  });

  it("rejects a wrong or dirty CPS checkout without modifying it", () => {
    const wrongHead = run({ P1_13_CPS_EXPECTED_HEAD: "0".repeat(40) });
    expect(wrongHead.status).toBe(1);
    expect(wrongHead.stderr).toContain("category=CPS_HEAD");
    writeFileSync(path.join(cps, "dirty.txt"), "do not clean me\n");
    const dirty = run();
    expect(dirty.status).toBe(1);
    expect(dirty.stderr).toContain("category=CPS_STATUS");
    expect(git(cps, "status", "--porcelain")).toContain("?? dirty.txt");
  });
});
