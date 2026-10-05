import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

/**
 * offsite-pull.sh 取本地备份 mtime 的跨平台写法 (2026-10-02 修复)。
 *
 * 脚本跑在两类环境:Owner 的 Mac (BSD stat) 和绿联 NAS (GNU coreutils)。旧写法
 *   stat -f '%m' F 2>/dev/null || stat -c '%Y' F 2>/dev/null
 * 只在 Mac 上测过。GNU 上 `-f` 是"文件系统状态":'%m' 被当成第二个文件名报错,
 * F 的文件系统报告 (多行) 照样打到 stdout,退出码 1,`||` 后面的 GNU 写法又输出
 * 一次真实时间戳 —— 保留策略的排序键里混进多行杂讯 (真实 GNU 9.7 / busybox
 * 容器里实测:每次运行 stderr 多出几十行 `OFFSITE_PULL_RETENTION_DELETED=<杂讯>`)。
 *
 * 本文件用 PATH 里的 `stat` shim 逐字模拟两种方言 (含"GNU 下 stat -f 先输出多行
 * 再退出 1"),不依赖本机 stat 是 BSD 还是 GNU,Linux CI 与 Mac 行为一致:
 *   1. shim 保真自检:shim 本身必须还原这两种真实行为,否则下面的变异测试会空转。
 *   2. 直接单元:从脚本源码里抠出探测块与 local_stat_mtime,逐方言断言 stdout
 *      只有一个纯整数、探测结果与方言一致。
 *   3. 端到端:用假 ssh (--gate 传输) 真跑一遍 offsite-pull.sh,断言 --keep 删掉的
 *      恰是 mtime 最旧的几份 (含"文件名字典序最大但实际最旧"的诱饵),且 stderr
 *      里没有任何杂讯行。
 *   4. 失败闭合:两种方言都失败 / 单个文件取不到整数 mtime 时必须明确报错并非零
 *      退出,且一份备份都不删。
 */

const root = process.cwd();
const pullScript = path.join(root, "scripts/preproduction/offsite-pull.sh");

const workDirs: string[] = [];
afterAll(async () => {
  await Promise.all(workDirs.map((d) => rm(d, { recursive: true, force: true })));
});

const STAT_SHIM = `#!/usr/bin/env bash
set -u
mode="\${STAT_SHIM_MODE:?}"

real_mtime() {
  "$STAT_SHIM_NODE" -e 'process.stdout.write(String(Math.floor(require("fs").statSync(process.argv[1]).mtimeMs / 1000)) + "\\n")' "$1"
}

gnu_stat() {
  if [ "\${1:-}" = "-c" ]; then
    fmt="\${2:-}"; shift 2
    if [ "$fmt" != "%Y" ]; then echo "stat-shim(gnu): unsupported format $fmt" >&2; exit 1; fi
    rc=0
    for f in "$@"; do
      if [ ! -e "$f" ]; then echo "stat: cannot statx '$f': No such file or directory" >&2; rc=1; continue; fi
      case "$mode:$f" in
        gnu-metadata-fails:*.metadata) echo "stat: cannot statx '$f': Permission denied" >&2; rc=1 ;;
        gnu-metadata-blank:*.metadata) echo ;;
        gnu-metadata-doubled:*.metadata) real_mtime "$f"; real_mtime "$f" ;;
        *) real_mtime "$f" ;;
      esac
    done
    exit "$rc"
  fi
  if [ "\${1:-}" = "-f" ]; then
    # GNU: -f = --file-system. The would-be "format" is just ANOTHER file operand:
    # it fails on stderr, every real operand prints a multi-line filesystem report
    # on STDOUT, and the exit code is 1 (byte-for-byte what coreutils 9.7 and busybox do).
    shift
    rc=0
    for f in "$@"; do
      if [ -e "$f" ]; then
        printf '  File: "%s"\\n    ID: 0123456789abcdef Namelen: 255     Type: ext2/ext3\\nBlock size: 4096       Fundamental block size: 4096\\nBlocks: Total: 1000       Free: 500        Available: 400\\nInodes: Total: 1000       Free: 900\\n' "$f"
      else
        echo "stat: cannot read file system information for '$f': No such file or directory" >&2; rc=1
      fi
    done
    exit "$rc"
  fi
  echo "stat-shim(gnu): unsupported invocation: $*" >&2; exit 1
}

bsd_stat() {
  if [ "\${1:-}" = "-f" ]; then
    fmt="\${2:-}"; shift 2
    if [ "$fmt" != "%m" ]; then echo "stat-shim(bsd): unsupported format $fmt" >&2; exit 1; fi
    rc=0
    for f in "$@"; do
      if [ -e "$f" ]; then real_mtime "$f"; else echo "stat: $f: stat: No such file or directory" >&2; rc=1; fi
    done
    exit "$rc"
  fi
  # BSD stat has no -c: usage to stderr, nothing on stdout, exit 1.
  echo "stat: illegal option -- \${1#-}" >&2
  echo "usage: stat [-FLnq] [-f format | -l | -r | -s | -x] [-t timefmt] [file ...]" >&2
  exit 1
}

case "$mode" in
  gnu | gnu-*) gnu_stat "$@" ;;
  bsd) bsd_stat "$@" ;;
  none) echo "stat: command unusable (shim mode none)" >&2; exit 1 ;;
  *) echo "stat-shim: unknown mode $mode" >&2; exit 2 ;;
esac
`;

// --gate 传输:offsite-pull.sh 只会调 `ssh <host> list` 和 `ssh <host> get <name>`。
const SSH_SHIM = `#!/usr/bin/env bash
set -u
case "\${2:-}" in
  list) cat "$FAKE_REMOTE_DIR/listing.txt" ;;
  get) cat "$FAKE_REMOTE_DIR/\${3:?}" ;;
  *) echo "fake-ssh: unsupported invocation: $*" >&2; exit 1 ;;
esac
`;

const NOW_S = Math.floor(Date.now() / 1000);
const DAY_S = 86400;

// 故意让"文件名顺序"、"mtime 顺序"两者不一致:
//  - v050 的名字字典序最大 (v > 数字),实际最旧 (真实 haiyue-vps 上就有这种手工命名);
//  - 0903 比 0901/0902 旧。
// 若有人退化成"按文件名排序删除",--keep 3 会删 0901/0902/0903,而不是下面期望的三份。
const LOCAL_BACKUPS: ReadonlyArray<{ name: string; ageDays: number }> = [
  { name: "cps-novel-v050-20260927T051542Z.dump", ageDays: 20 },
  { name: "cps-novel-20260903T000000Z.dump", ageDays: 19 },
  { name: "cps-novel-20260901T000000Z.dump", ageDays: 18 },
  { name: "cps-novel-20260904T000000Z.dump", ageDays: 17 },
  { name: "cps-novel-20260902T000000Z.dump", ageDays: 16 },
];
const REMOTE_NAME = "cps-novel-20260905T000000Z.dump";
// 拉取后本地 .metadata 的 mtime = 现在 (最新),--keep 3 时本地共 6 份,删最旧 3 份。
const EXPECTED_DELETED = [
  "cps-novel-v050-20260927T051542Z.dump",
  "cps-novel-20260903T000000Z.dump",
  "cps-novel-20260901T000000Z.dump",
];
const EXPECTED_REMAINING = [
  "cps-novel-20260902T000000Z.dump",
  "cps-novel-20260904T000000Z.dump",
  "cps-novel-20260905T000000Z.dump",
];

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

interface Sandbox {
  workDir: string;
  binDir: string;
  localDir: string;
  remoteDir: string;
}

async function makeSandbox(): Promise<Sandbox> {
  const workDir = await mkdtemp(path.join(tmpdir(), "offsite-pull-portability-"));
  workDirs.push(workDir);
  const binDir = path.join(workDir, "bin");
  const localDir = path.join(workDir, "local");
  const remoteDir = path.join(workDir, "remote");
  await mkdir(binDir, { recursive: true });
  await mkdir(localDir, { recursive: true });
  await mkdir(remoteDir, { recursive: true });
  await writeFile(path.join(binDir, "stat"), STAT_SHIM, "utf8");
  await chmod(path.join(binDir, "stat"), 0o755);
  await writeFile(path.join(binDir, "ssh"), SSH_SHIM, "utf8");
  await chmod(path.join(binDir, "ssh"), 0o755);
  return { workDir, binDir, localDir, remoteDir };
}

async function writeBackup(dir: string, name: string, mtimeEpoch: number | null): Promise<void> {
  const content = `dump-bytes-${name}\n`;
  await writeFile(path.join(dir, name), content);
  await writeFile(path.join(dir, `${name}.sha256`), `${sha256(content)}  ${name}\n`);
  await writeFile(path.join(dir, `${name}.metadata`), `{"name":"${name}"}\n`);
  if (mtimeEpoch !== null) {
    const when = new Date(mtimeEpoch * 1000);
    await utimes(path.join(dir, `${name}.metadata`), when, when);
  }
}

async function seedScenario(sb: Sandbox): Promise<void> {
  for (const { name, ageDays } of LOCAL_BACKUPS) {
    await writeBackup(sb.localDir, name, NOW_S - ageDays * DAY_S);
  }
  await writeBackup(sb.remoteDir, REMOTE_NAME, NOW_S - DAY_S);
  const content = `dump-bytes-${REMOTE_NAME}\n`;
  await writeFile(
    path.join(sb.remoteDir, "listing.txt"),
    `name=${REMOTE_NAME} size=${Buffer.byteLength(content)} mtime=${NOW_S - DAY_S} sha256=${sha256(content)}\n`,
  );
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function shimEnv(sb: Sandbox, statMode: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    PATH: `${sb.binDir}:${process.env.PATH ?? ""}`,
    HOME: sb.workDir,
    STAT_SHIM_MODE: statMode,
    STAT_SHIM_NODE: process.execPath,
    FAKE_REMOTE_DIR: sb.remoteDir,
  };
}

function runPull(sb: Sandbox, statMode: string, keep: number): RunResult {
  const result = spawnSync(
    "bash",
    [pullScript, "--gate", "--remote-host", "fake-host", "--local-dir", sb.localDir, "--keep", String(keep)],
    { env: shimEnv(sb, statMode), encoding: "utf8", timeout: 60_000 },
  );
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runShim(sb: Sandbox, statMode: string, args: string[]): RunResult {
  const result = spawnSync(path.join(sb.binDir, "stat"), args, { env: shimEnv(sb, statMode), encoding: "utf8", timeout: 30_000 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// 从脚本源码里抠出一段 (按行首标记起止),抠不到就明确报错,不静默跳过。
function sliceSource(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`offsite-pull.sh 里找不到起始标记: ${JSON.stringify(startMarker)}`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`offsite-pull.sh 里找不到结束标记: ${JSON.stringify(endMarker)}`);
  return source.slice(start, end + endMarker.length);
}

const pullSource = readFileSync(pullScript, "utf8");

/** 在 shim 环境里跑一小段 bash,里面先装入脚本里抠出来的真实函数。 */
function runExtracted(sb: Sandbox, statMode: string, body: string): RunResult {
  const result = spawnSync("bash", ["-c", body], { env: shimEnv(sb, statMode), encoding: "utf8", timeout: 30_000 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function listDir(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

describe("offsite-pull.sh：stat shim 保真自检", () => {
  it("GNU 方言:stat -f '%m' F = 文件系统报告打到 stdout (多行) + 退出码 1;stat -c '%Y' F = 纯整数", async () => {
    const sb = await makeSandbox();
    const file = path.join(sb.workDir, "f.metadata");
    await writeFile(file, "x");
    const when = new Date((NOW_S - 5 * DAY_S) * 1000);
    await utimes(file, when, when);

    const fsMode = runShim(sb, "gnu", ["-f", "%m", file]);
    expect(fsMode.status).toBe(1);
    expect(fsMode.stdout.trim().split("\n").length).toBeGreaterThan(1);
    expect(fsMode.stdout).toContain("File:");
    expect(fsMode.stderr).toContain("cannot read file system information for '%m'");

    const cMode = runShim(sb, "gnu", ["-c", "%Y", file]);
    expect(cMode.status).toBe(0);
    expect(cMode.stdout).toBe(`${NOW_S - 5 * DAY_S}\n`);
  });

  it("BSD 方言:stat -c 失败且 stdout 为空;stat -f '%m' F = 纯整数", async () => {
    const sb = await makeSandbox();
    const file = path.join(sb.workDir, "f.metadata");
    await writeFile(file, "x");
    const when = new Date((NOW_S - 5 * DAY_S) * 1000);
    await utimes(file, when, when);

    const cMode = runShim(sb, "bsd", ["-c", "%Y", file]);
    expect(cMode.status).toBe(1);
    expect(cMode.stdout).toBe("");
    expect(cMode.stderr).toContain("illegal option");

    const fMode = runShim(sb, "bsd", ["-f", "%m", file]);
    expect(fMode.status).toBe(0);
    expect(fMode.stdout).toBe(`${NOW_S - 5 * DAY_S}\n`);
  });
});

describe("offsite-pull.sh：探测块 + local_stat_mtime 直接单元 (抠自脚本源码)", () => {
  // 探测块:从 `stat_style=""` 到探测失败的 fail 行;函数:local_stat_mtime / is_epoch_seconds。
  // 旧版没有 is_epoch_seconds 与探测块 —— 对旧版抠取会直接抛错,变异时本组必红。
  const probeBlock = () =>
    sliceSource(pullSource, '\nstat_style=""\n', "fail tool_missing stat_gnu_or_bsd_mtime; fi\n");
  const isEpochFn = () => sliceSource(pullSource, "\nis_epoch_seconds() {", "\n}\n");
  const mtimeFn = () => sliceSource(pullSource, "\nlocal_stat_mtime() {", "\n}\n");

  it.each(["gnu", "bsd"] as const)("%s 方言:探测结果与方言一致,取到的 mtime 是唯一一行纯整数", async (dialect) => {
    const sb = await makeSandbox();
    const file = path.join(sb.workDir, "x.dump.metadata");
    await writeFile(file, "x");
    const when = new Date((NOW_S - 3 * DAY_S) * 1000);
    await utimes(file, when, when);

    const body = [
      "set -euo pipefail",
      'fail() { echo "FAILCALLED $*"; exit 65; }',
      isEpochFn(),
      probeBlock(),
      'echo "STYLE=$stat_style"',
      mtimeFn(),
      `out="$(local_stat_mtime '${file}')"`,
      'printf "MTIME=[%s]\\n" "$out"',
    ].join("\n");
    const r = runExtracted(sb, dialect, body);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`STYLE=${dialect}\nMTIME=[${NOW_S - 3 * DAY_S}]\n`);
  });

  it("两种方言都不可用:探测块明确 fail(tool_missing),非零退出,不静默", async () => {
    const sb = await makeSandbox();
    const body = [
      "set -euo pipefail",
      'fail() { echo "FAILCALLED $*"; exit 65; }',
      isEpochFn(),
      probeBlock(),
      'echo "SHOULD-NOT-REACH style=$stat_style"',
    ].join("\n");
    const r = runExtracted(sb, "none", body);
    expect(r.status).toBe(65);
    expect(r.stdout).toBe("FAILCALLED tool_missing stat_gnu_or_bsd_mtime\n");
  });

  it.each(["gnu-metadata-blank", "gnu-metadata-doubled", "gnu-metadata-fails"] as const)(
    "单个文件取不到纯整数 (%s):local_stat_mtime 返回 1、stdout 为空、stderr 有说明",
    async (mode) => {
      const sb = await makeSandbox();
      const file = path.join(sb.workDir, "x.dump.metadata");
      await writeFile(file, "x");
      const body = [
        "set -uo pipefail",
        isEpochFn(),
        'stat_style="gnu"',
        mtimeFn(),
        `out="$(local_stat_mtime '${file}' 2>/dev/null)"; rc=$?`,
        `err="$(local_stat_mtime '${file}' 2>&1 >/dev/null)"`,
        'printf "RC=%s OUT=[%s] ERR=[%s]\\n" "$rc" "$out" "$err"',
      ].join("\n");
      const r = runExtracted(sb, mode, body);
      expect(r.stdout).toMatch(/^RC=1 OUT=\[\] ERR=\[OFFSITE_PULL_STAT_ERROR=/);
    },
  );
});

describe.each(["gnu", "bsd"] as const)("offsite-pull.sh：%s stat 方言下 --keep 保留策略 (端到端,假 ssh --gate)", (dialect) => {
  it("--keep 3:只删 mtime 最旧的三份 (含 .sha256/.metadata),新的不动;stderr 无杂讯;SHA256SUMS 与留存一致", async () => {
    const sb = await makeSandbox();
    await seedScenario(sb);

    const r = runPull(sb, dialect, 3);
    expect(r.status).toBe(0);

    const stdoutLines = r.stdout.trim().split("\n");
    expect(stdoutLines).toHaveLength(2);
    expect(stdoutLines[0]).toBe("BACKUP_EXPORT_MANIFEST=PASS");
    expect(stdoutLines[1]).toMatch(
      new RegExp(`^OFFSITE_PULL=PASS file=${REMOTE_NAME} size=\\d+ sha256=[0-9a-f]{64} status=pulled manifest=`),
    );

    // stderr 只允许出现脚本自己定义的三类状态行 —— 任何 stat 杂讯都会让这里翻红。
    const stderrLines = r.stderr.trim().split("\n");
    for (const line of stderrLines) {
      expect(line).toMatch(/^OFFSITE_PULL_(TRANSPORT|REMOTE_LATEST|RETENTION_DELETED)=/);
    }
    const deletedLines = stderrLines.filter((l) => l.startsWith("OFFSITE_PULL_RETENTION_DELETED="));
    expect(deletedLines).toEqual(EXPECTED_DELETED.map((n) => `OFFSITE_PULL_RETENTION_DELETED=${n}`));

    const expectedFiles = [
      "SHA256SUMS",
      ...EXPECTED_REMAINING.flatMap((n) => [n, `${n}.metadata`, `${n}.sha256`]),
    ].sort();
    expect(await listDir(sb.localDir)).toEqual(expectedFiles);

    const manifest = await readFile(path.join(sb.localDir, "SHA256SUMS"), "utf8");
    const manifestNames = manifest
      .trim()
      .split("\n")
      .map((l) => l.replace(/^[0-9a-f]{64} [ *]/, ""))
      .sort();
    expect(manifestNames).toEqual(expectedFiles.filter((n) => n !== "SHA256SUMS").map((n) => `./${n}`));
  });

  it("本地份数不超过 --keep:一份都不删,同样无杂讯", async () => {
    const sb = await makeSandbox();
    await seedScenario(sb);

    const r = runPull(sb, dialect, 14);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("OFFSITE_PULL_RETENTION_DELETED");
    for (const line of r.stderr.trim().split("\n")) {
      expect(line).toMatch(/^OFFSITE_PULL_(TRANSPORT|REMOTE_LATEST)=/);
    }
    const dumps = (await listDir(sb.localDir)).filter((n) => n.endsWith(".dump"));
    expect(dumps).toHaveLength(LOCAL_BACKUPS.length + 1);
  });
});

describe("offsite-pull.sh：stat 取不到纯整数时失败闭合 (不删任何备份)", () => {
  it("两种方言都不可用:在传输前就 OFFSITE_PULL=FAIL,退出 65,本地目录原样不动", async () => {
    const sb = await makeSandbox();
    await seedScenario(sb);
    const before = await listDir(sb.localDir);

    const r = runPull(sb, "none", 3);
    expect(r.status).toBe(65);
    expect(r.stdout.trim()).toBe("OFFSITE_PULL=FAIL reason=tool_missing detail=stat_gnu_or_bsd_mtime");
    expect(r.stderr).not.toContain("OFFSITE_PULL_RETENTION_DELETED");
    expect(await listDir(sb.localDir)).toEqual(before);
  });

  it.each(["gnu-metadata-fails", "gnu-metadata-blank", "gnu-metadata-doubled"] as const)(
    "探测通过但某个 .metadata 的 mtime 不是纯整数 (%s):reason=local_mtime_unavailable,非零退出,旧备份一份不删",
    async (mode) => {
      const sb = await makeSandbox();
      await seedScenario(sb);

      const r = runPull(sb, mode, 3);
      expect(r.status).toBe(65);
      expect(r.stdout).toMatch(/OFFSITE_PULL=FAIL reason=local_mtime_unavailable detail=cps-novel-.*\.dump\.metadata/);
      expect(r.stderr).toContain("OFFSITE_PULL_STAT_ERROR=");
      expect(r.stderr).not.toContain("OFFSITE_PULL_RETENTION_DELETED");

      const remaining = await listDir(sb.localDir);
      for (const { name } of LOCAL_BACKUPS) {
        expect(remaining).toContain(name);
        expect(remaining).toContain(`${name}.sha256`);
        expect(remaining).toContain(`${name}.metadata`);
      }
    },
  );
});
