import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * NAS 异地备份受限只读钥匙 (2026-09-28)。
 *
 * scripts/preproduction/offsite-readonly-gate.sh 是装在 haiyue-vps 上、以
 * `deploy` 身份跑的 ssh forced command:只认 SSH_ORIGINAL_COMMAND 里的
 * "list" 和 "get <文件名>" 两个动作,别的一律拒绝、非零退出,且从不把
 * stdin/参数里的字节当脚本执行 (与旧版 offsite-pull.sh 那种
 * `docker exec ... sh -s` 从 stdin 喂脚本进容器当 root 跑的模式相反 ——
 * 这里唯一一次 `sh -s --` 调用喂的是脚本自己写死的 heredoc)。
 *
 * 这个文件是"静态/单元"层:不起真实容器,用一个假的 `docker` 可执行文件
 * 顶替 PATH 上的 docker —— `docker ps` 回一个固定容器名,
 * `docker exec -u 0 -i <name> sh -s -- <dir>` 剥掉 docker 相关参数后直接把
 * `sh -s -- <dir>` 交给真正的 /bin/sh 去跑 (`<dir>` 由
 * OFFSITE_READONLY_GATE_REMOTE_DIR 指向本地一个真实的 fixture 目录),
 * `docker exec -u 0 <name> cat <path>` 同理转发给真正的 `cat`。这样能在不
 * 依赖 Docker daemon 的前提下,对着真实的 bash/sh/stat/awk 行为验证 gate
 * 脚本的解析、四层文件名校验、list 的完成态判定与排序、审计日志。
 *
 * 真正起 sshd 容器 + backup-timer 容器、用 offsite-pull.sh --gate 走完整
 * ssh 链路、验证 restrict 挡住任意命令与端口转发的"本地真实演练"另见
 * scripts/preproduction/verify-offsite-readonly-gate-rehearsal.sh。
 */

const root = process.cwd();
const gateScript = path.join(root, "scripts/preproduction/offsite-readonly-gate.sh");

let workDir: string;
let fixtureDir: string;
let binDir: string;
let logFile: string;

const FAKE_CONTAINER = "fake-backup-timer-1";

const OLD_NAME = "cps-novel-20260901T000000Z.dump";
const NEW_NAME = "cps-novel-20260902T000000Z.dump";
const INPROGRESS_NAME = "cps-novel-20260903T000000Z.dump";

const OLD_CONTENT = "old-backup-bytes-fixture\n";
const NEW_CONTENT = "new-backup-bytes-fixture-longer-content\n";

// utimes() 需要真实的 Date 对象；list 里 mtime 字段的期望值直接从这两个
// Date 算 epoch 秒，不手写字面量，避免手算出错 (先前一版就因为手算写错
// 而断言了错误的 epoch)。
const OLD_MTIME = new Date("2026-09-01T00:00:00Z");
const NEW_MTIME = new Date("2026-09-02T00:00:00Z");
const OLD_MTIME_EPOCH = Math.floor(OLD_MTIME.getTime() / 1000);
const NEW_MTIME_EPOCH = Math.floor(NEW_MTIME.getTime() / 1000);

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function writeFakeDocker(): Promise<void> {
  const script = `#!/usr/bin/env bash
set -euo pipefail
sub="$1"; shift
case "$sub" in
  ps)
    if [ -n "\${FAKE_CONTAINER_NAME:-}" ]; then
      echo "$FAKE_CONTAINER_NAME"
    fi
    ;;
  exec)
    shift 2 # drop "-u 0"
    if [ "$1" = "-i" ]; then
      shift 2 # drop "-i" "<container>"
      exec "$@"
    else
      shift 1 # drop "<container>"
      exec "$@"
    fi
    ;;
  *)
    echo "fake-docker: unsupported subcommand $sub" >&2
    exit 1
    ;;
esac
`;
  const dockerPath = path.join(binDir, "docker");
  await writeFile(dockerPath, script, "utf8");
  await chmod(dockerPath, 0o755);
}

/**
 * gate 脚本喂给 `docker exec ... sh -s --` 的 heredoc 用的是 GNU stat 的
 * `-c` 语法 (生产里那是 postgres:16.14/Debian 容器，GNU coreutils，有保证)。
 * 假 docker 把这段 heredoc 原样转发给这台 Mac 的真实 /bin/sh 去跑，但这台
 * Mac 的 /usr/bin/stat 是 BSD 版，不认 `-c`。垫一层 shim：把 `-c '%Y'`/
 * `-c '%s'` 翻译成 BSD stat 的 `-f '%m'`/`-f '%z'`，让同一份 gate 脚本源码
 * 在本机也能对着真实文件系统跑完整逻辑，不必为了测试改脚本本身。
 */
async function writeFakeStat(): Promise<void> {
  const script = `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "-c" ]; then
  fmt="$2"; shift 2
  case "$fmt" in
    '%Y') exec /usr/bin/stat -f '%m' "$@" ;;
    '%s') exec /usr/bin/stat -f '%z' "$@" ;;
    *) echo "fake-stat: unsupported format $fmt" >&2; exit 1 ;;
  esac
else
  exec /usr/bin/stat "$@"
fi
`;
  const statPath = path.join(binDir, "stat");
  await writeFile(statPath, script, "utf8");
  await chmod(statPath, 0o755);
}

async function writeFixtures(): Promise<void> {
  await writeFile(path.join(fixtureDir, OLD_NAME), OLD_CONTENT);
  await writeFile(path.join(fixtureDir, `${OLD_NAME}.sha256`), `${sha256(OLD_CONTENT)}  ${OLD_NAME}\n`);
  await writeFile(path.join(fixtureDir, `${OLD_NAME}.metadata`), '{"note":"old"}\n');

  await writeFile(path.join(fixtureDir, NEW_NAME), NEW_CONTENT);
  await writeFile(path.join(fixtureDir, `${NEW_NAME}.sha256`), `${sha256(NEW_CONTENT)}  ${NEW_NAME}\n`);
  await writeFile(path.join(fixtureDir, `${NEW_NAME}.metadata`), '{"note":"new"}\n');

  // In-progress: .dump exists, sidecars do not -- must never appear in list,
  // and `get` on it must be rejected as "not in current list" even though the
  // filename itself matches the naming pattern.
  await writeFile(path.join(fixtureDir, INPROGRESS_NAME), "still-writing\n");

  await utimes(path.join(fixtureDir, `${OLD_NAME}.metadata`), OLD_MTIME, OLD_MTIME);
  await utimes(path.join(fixtureDir, `${NEW_NAME}.metadata`), NEW_MTIME, NEW_MTIME);
}

interface RunResult {
  status: number | null;
  stdout: Buffer;
  stderr: string;
}

function runGate(command: string | undefined, envOverrides: Record<string, string> = {}): RunResult {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    OFFSITE_READONLY_GATE_REMOTE_DIR: fixtureDir,
    OFFSITE_READONLY_GATE_LOG_FILE: logFile,
    FAKE_CONTAINER_NAME: FAKE_CONTAINER,
    HOME: workDir,
    ...envOverrides,
  };
  if (command !== undefined) env.SSH_ORIGINAL_COMMAND = command;
  const result = spawnSync("bash", [gateScript], { env });
  return { status: result.status, stdout: result.stdout ?? Buffer.alloc(0), stderr: (result.stderr ?? "").toString("utf8") };
}

describe("offsite-readonly-gate.sh：受限入口脚本", () => {
  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "offsite-gate-unit-"));
    fixtureDir = path.join(workDir, "backups");
    binDir = path.join(workDir, "bin");
    logFile = path.join(workDir, "gate.log");
    await mkdir(fixtureDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFakeDocker();
    await writeFakeStat();
    await writeFixtures();
  });

  afterEach(async () => {
    // 每个用例后清空日志，方便逐条断言审计行，不跨用例累积。
    await rm(logFile, { force: true });
  });

  it("空命令：拒绝，非零退出，不落 stdout", () => {
    const r = runGate("");
    expect(r.status).not.toBe(0);
    expect(r.stdout.length).toBe(0);
  });

  it("未设置 SSH_ORIGINAL_COMMAND：等同空命令，拒绝", () => {
    const r = runGate(undefined);
    expect(r.status).not.toBe(0);
  });

  it("未知动作 (docker ps)：拒绝", () => {
    const r = runGate("docker ps");
    expect(r.status).not.toBe(0);
    expect(r.stdout.length).toBe(0);
  });

  it("未知动作 (cat /etc/passwd)：拒绝，且从不读该文件", () => {
    const r = runGate("cat /etc/passwd");
    expect(r.status).not.toBe(0);
    expect(r.stdout.length).toBe(0);
  });

  it("换行注入 (list\\nrm -rf /)：整体拒绝，不会只认第一行", () => {
    const r = runGate("list\nrm -rf /");
    expect(r.status).not.toBe(0);
    expect(r.stdout.length).toBe(0);
  });

  it("list 带多余参数：拒绝", () => {
    const r = runGate("list extra-arg");
    expect(r.status).not.toBe(0);
  });

  it("get 不带文件名：拒绝", () => {
    const r = runGate("get");
    expect(r.status).not.toBe(0);
  });

  it("get 带两个文件名：拒绝", () => {
    const r = runGate(`get ${OLD_NAME} ${NEW_NAME}`);
    expect(r.status).not.toBe(0);
  });

  it("get 路径穿越 (../../etc/passwd)：拒绝，不触达 docker，且拒绝原因具体到位", () => {
    // 断言具体拒绝原因 (get_invalid_filename)，不只断言"非零退出"——
    // "../../etc/passwd" 本来就不匹配 ^cps-novel- 前缀，真正拦住它的是正则
    // 这一层，不是 */* 斜杠检查 (虽然它也含斜杠，但正则先一步就否决了，斜杠
    // 检查从未被触达)。只断言退出码非零/无输出，测不出"正则被放宽"这种变异
    // ——把 filename_re 放宽成 '.*' 之后，同一个输入照样会被斜杠检查拦下，
    // 退出码依旧非零、stdout 依旧是空，两条弱断言全部保持通过，测不出任何
    // 变化；只有断言到这个具体原因字符串，才会在正则被放宽时翻红
    // (原因变成 get_filename_contains_slash)。
    const r = runGate("get ../../etc/passwd", { FAKE_CONTAINER_NAME: "" });
    expect(r.status).not.toBe(0);
    expect(r.stdout.length).toBe(0);
    expect(r.stderr).toContain("get_invalid_filename");
  });

  it("get 绝对路径 (/etc/passwd)：拒绝，且拒绝原因具体到位", () => {
    const r = runGate("get /etc/passwd", { FAKE_CONTAINER_NAME: "" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("get_invalid_filename");
  });

  it("get 含 .. 的合法字符集文件名：拒绝 (dotdot 独立校验)", () => {
    const r = runGate("get cps-novel-a..b.dump", { FAKE_CONTAINER_NAME: "" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("dotdot");
  });

  it("get 后缀不对 (.tar.gz)：拒绝", () => {
    const r = runGate("get cps-novel-x.tar.gz", { FAKE_CONTAINER_NAME: "" });
    expect(r.status).not.toBe(0);
  });

  it("get 文件名格式合法但从未出现在当前 list 里：拒绝", () => {
    const r = runGate("get cps-novel-does-not-exist-20260101T000000Z.dump");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("not_in_current_list");
  });

  it("get 写入中的备份 (.dump 存在但无 sidecar)：拒绝，因为不在 list 里", () => {
    const r = runGate(`get ${INPROGRESS_NAME}`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("not_in_current_list");
  });

  it("容器找不到：list 与 get 都失败", () => {
    const rList = runGate("list", { FAKE_CONTAINER_NAME: "" });
    expect(rList.status).not.toBe(0);
    const rGet = runGate(`get ${OLD_NAME}`, { FAKE_CONTAINER_NAME: "" });
    expect(rGet.status).not.toBe(0);
  });

  it("list：只列已完成的两份，按 mtime 升序，字段精确匹配 fixture", () => {
    const r = runGate("list");
    expect(r.status).toBe(0);
    const lines = r.stdout.toString("utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      `name=${OLD_NAME} size=${Buffer.byteLength(OLD_CONTENT)} mtime=${OLD_MTIME_EPOCH} sha256=${sha256(OLD_CONTENT)}`,
    );
    expect(lines[1]).toBe(
      `name=${NEW_NAME} size=${Buffer.byteLength(NEW_CONTENT)} mtime=${NEW_MTIME_EPOCH} sha256=${sha256(NEW_CONTENT)}`,
    );
    // 写入中的那份绝不出现在 list 里。
    expect(r.stdout.toString("utf8")).not.toContain(INPROGRESS_NAME);
  });

  it("get：逐字节吐出 .dump 内容", () => {
    const r = runGate(`get ${NEW_NAME}`);
    expect(r.status).toBe(0);
    expect(r.stdout.toString("utf8")).toBe(NEW_CONTENT);
  });

  it("get：逐字节吐出 .sha256 / .metadata sidecar", async () => {
    const rSha = runGate(`get ${NEW_NAME}.sha256`);
    expect(rSha.status).toBe(0);
    const expectedSha = await readFile(path.join(fixtureDir, `${NEW_NAME}.sha256`));
    expect(rSha.stdout.equals(expectedSha)).toBe(true);

    const rMeta = runGate(`get ${NEW_NAME}.metadata`);
    expect(rMeta.status).toBe(0);
    const expectedMeta = await readFile(path.join(fixtureDir, `${NEW_NAME}.metadata`));
    expect(rMeta.stdout.equals(expectedMeta)).toBe(true);
  });

  it("审计日志：拒绝与放行都各自落一行，含动作与结果", async () => {
    await rm(logFile, { force: true });
    runGate("cat /etc/passwd");
    runGate("list");
    const content = await readFile(logFile, "utf8");
    const lines = content.trim().split("\n");
    expect(lines.some((l) => l.includes("action=cat") && l.includes("result=deny"))).toBe(true);
    expect(lines.some((l) => l.includes("action=list") && l.includes("result=ok"))).toBe(true);
  });
});
