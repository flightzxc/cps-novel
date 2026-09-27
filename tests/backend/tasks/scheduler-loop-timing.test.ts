import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const cases = [
  { name: "normal tick finishing five seconds after boundary", finished: 125, interval: 60, delay: 57 },
  { name: "exact boundary waits for the next boundary", finished: 180, interval: 60, delay: 62 },
  { name: "overrun skips the elapsed boundary without bursting", finished: 247, interval: 60, delay: 55 },
  { name: "non-minute interval", finished: 247, interval: 90, delay: 25 },
];

describe("scheduler interval alignment", () => {
  it.each(cases)("calculates delay: $name", ({ finished, interval, delay }) => {
    const output = execFileSync("bash", ["-c", 'source scripts/lib/scheduler-timing.sh; scheduler_sleep_seconds "$1" "$2"', "test", String(finished), String(interval)], { encoding: "utf8" });
    expect(Number(output.trim())).toBe(delay);
  });
  // 子进程本身全是桩脚本（tsx/date/sleep 都是立即返回的假二进制，没有真的
  // sleep），正常情况下全程亚秒级。这里的 timeout 只是防真挂起的安全网，
  // 不是行为断言——B-16 复核在全量 test:backend 并发抢核时，观测到这条测试
  // 稳定命中过 spawnSync 自带的 5000ms（vitest 测试自身的超时用全局
  // 15000ms）。断言内容一个字没动，只是把两层超时预算都按仓库里同类子进程
  // 测试的先例（30000）放宽，给调度让出的空间。
  it.each(cases)("actual loop uses the aligned delay and handles TERM: $name", ({ finished, interval, delay }) => {
    mkdirSync(".tmp", { recursive: true });
    const root = mkdtempSync(path.resolve(".tmp/scheduler-loop-"));
    const log = path.join(root, "sleep-seconds");
    const executable = (name: string, body: string) => writeFileSync(path.join(root, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
    try {
      executable("tsx", '[[ "$*" == "scheduler/index.ts" ]]');
      executable("date", `echo ${finished}`);
      executable("sleep", 'printf "%s" "$1" > "$SLEEP_LOG"\nkill -TERM "$PPID"');
      const result = spawnSync("bash", ["scripts/run-scheduler-loop.sh"], {
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, SLEEP_LOG: log, SCHEDULER_INTERVAL_SECONDS: String(interval) },
        encoding: "utf8", timeout: 30000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(Number(readFileSync(log, "utf8"))).toBe(delay);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30000);
});
