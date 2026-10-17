/**
 * B-48：真实库运行器的 postgres 镜像必须钉死 `postgres:16.14`，并且本机已有镜像时不联网拉取。
 *
 * 背景：`scripts/run-p1-05b-postgres-verification.sh` 曾每次都 `docker pull postgres:16`（浮动标签），
 * v0.6.1 发版时公司网络下 Docker Hub 返回 EOF，发版门禁因此停下。其它运行器早就是
 * `if ! docker image inspect postgres:16.14 ...; then docker pull ...; fi` 的写法，这里把它钉成全仓约束。
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptsDir = path.join(process.cwd(), "scripts");
const PINNED_IMAGE = "postgres:16.14";
const PULL_GUARD = `if ! docker image inspect ${PINNED_IMAGE} >/dev/null 2>&1; then`;
/** 守卫行与 `docker pull` 之间允许隔几行（有的运行器先准备 DOCKER_CONFIG 再拉）。 */
const MAX_GUARD_DISTANCE = 4;

function shellScripts(): { name: string; lines: string[] }[] {
  return readdirSync(scriptsDir)
    .filter((name) => name.endsWith(".sh"))
    .sort()
    .map((name) => ({ name, lines: readFileSync(path.join(scriptsDir, name), "utf8").split("\n") }));
}

function isComment(line: string): boolean {
  return line.trimStart().startsWith("#");
}

describe("真实库运行器 postgres 镜像固定（B-48）", () => {
  it("scripts/*.sh 里引用的 postgres 镜像只能是 postgres:16.14", () => {
    const offenders: string[] = [];
    for (const { name, lines } of shellScripts()) {
      lines.forEach((line, index) => {
        if (isComment(line)) return;
        for (const match of line.matchAll(/\bpostgres:[A-Za-z0-9._-]+/g)) {
          if (match[0] !== PINNED_IMAGE) offenders.push(`${name}:${index + 1}: ${match[0]}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("每一处 docker pull postgres 都在“本机没有镜像才拉”的守卫里", () => {
    const unguarded: string[] = [];
    let pullCount = 0;
    for (const { name, lines } of shellScripts()) {
      lines.forEach((line, index) => {
        if (isComment(line) || !/\bdocker pull postgres:/.test(line)) return;
        pullCount += 1;
        const window = lines.slice(Math.max(0, index - MAX_GUARD_DISTANCE), index);
        if (!window.some((candidate) => candidate.trim() === PULL_GUARD)) {
          unguarded.push(`${name}:${index + 1}`);
        }
      });
    }
    expect(pullCount).toBeGreaterThan(0);
    expect(unguarded).toEqual([]);
  });

  it("p1-05b 运行器用固定镜像起容器，且只在守卫内拉取", () => {
    const script = readFileSync(path.join(scriptsDir, "run-p1-05b-postgres-verification.sh"), "utf8");
    expect(script).toContain(`${PULL_GUARD}\n  docker pull ${PINNED_IMAGE} >/dev/null\nfi\n`);
    expect(script).toMatch(/docker run -d \\\n[\s\S]*?\n {2}postgres:16\.14 >\/dev\/null\n/);
    const codeLines = script.split("\n").filter((line) => !isComment(line));
    expect(codeLines.filter((line) => line.includes("docker pull"))).toHaveLength(1);
  });
});
