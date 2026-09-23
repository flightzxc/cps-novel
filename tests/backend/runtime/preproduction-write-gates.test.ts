import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * PREPROD_APPROVED_OPEN_WRITE_GATES：写闸从"恒为 false"改成"封闭枚举 + 显式登记制"。
 *
 * 背景与冻结的契约见 scripts/preproduction/lib.sh 里 preprod_assert_write_gates()
 * 上方的注释，以及 docs/adr/ADR-PREPROD-APPROVED-OPEN-WRITE-GATES.md。
 *
 * 这组测试直接 source lib.sh 调函数，不跑完整 preflight.sh —— 完整 preflight 会读
 * 目标机密钥文件（secrets-preflight.sh）与 release manifest，测试环境跑不了。
 *
 * 🔴 env 刻意干净：只带 PATH/HOME（sed/bash 等外部命令需要），不 spread
 * process.env —— 本机 shell 里如果凑巧导出过同名变量（FEATURE_NOVEL_CATALOG_SYNC
 * 等），继承 process.env 会让测试跟着本机环境状态漂移，静默通过或静默失败。
 */

const root = process.cwd();
const LIB = path.join(root, "scripts/preproduction/lib.sh");
const PREFLIGHT = path.join(root, "scripts/preproduction/preflight.sh");

type GateEnv = {
  PREPROD_APPROVED_OPEN_WRITE_GATES?: string;
  FEATURE_NOVEL_CATALOG_SYNC?: string;
  NOVEL_CATALOG_SYNC_ALLOW_WRITE?: string;
  FEATURE_PROMO_LINK_CLAIM?: string;
  PROMO_LINK_CLAIM_ALLOW_WRITE?: string;
};

/** All four gate variables false and unregistered -- the pre-change default shape. */
const ALL_CLOSED: Required<GateEnv> = {
  PREPROD_APPROVED_OPEN_WRITE_GATES: "",
  FEATURE_NOVEL_CATALOG_SYNC: "false",
  NOVEL_CATALOG_SYNC_ALLOW_WRITE: "false",
  FEATURE_PROMO_LINK_CLAIM: "false",
  PROMO_LINK_CLAIM_ALLOW_WRITE: "false",
};

function runGate(overrides: GateEnv) {
  const merged: GateEnv = { ...ALL_CLOSED, ...overrides };
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) continue; // deliberately absent from env, not just empty
    env[key] = value;
  }
  const script = `set -euo pipefail\nsource "${LIB}"\npreprod_assert_write_gates`;
  return spawnSync("bash", ["-c", script], { encoding: "utf8", env });
}

/** Variant of runGate that lets a key be forced *unset* even though ALL_CLOSED sets it. */
function runGateUnset(overrides: GateEnv, unset: Array<keyof GateEnv>) {
  const merged: GateEnv = { ...ALL_CLOSED, ...overrides };
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
  for (const [key, value] of Object.entries(merged)) {
    if ((unset as string[]).includes(key)) continue;
    if (value === undefined) continue;
    env[key] = value;
  }
  const script = `set -euo pipefail\nsource "${LIB}"\npreprod_assert_write_gates`;
  return spawnSync("bash", ["-c", script], { encoding: "utf8", env });
}

describe("preprod_assert_write_gates: 未登记写闸 = 恒关", () => {
  it("四个变量都是 false，未登记 -> PASS approved=none open=none", () => {
    const r = runGate({});
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("PREPROD_WRITE_GATES=PASS approved=none open=none");
  });

  it("catalog 任一为 true，未登记 -> FAIL catalog_write", () => {
    const r = runGate({ FEATURE_NOVEL_CATALOG_SYNC: "true", NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true" });
    expect(r.status).toBe(65);
    expect(r.stdout.trim()).toBe("catalog_write");
  });

  it("catalog 只有 FEATURE 为 true（dry-run 形状），未登记 -> FAIL catalog_write", () => {
    const r = runGate({ FEATURE_NOVEL_CATALOG_SYNC: "true" });
    expect(r.status).toBe(65);
    expect(r.stdout.trim()).toBe("catalog_write");
  });

  it("promo 任一为 true，未登记 -> FAIL promo_write", () => {
    const r = runGate({ FEATURE_PROMO_LINK_CLAIM: "true", PROMO_LINK_CLAIM_ALLOW_WRITE: "true" });
    expect(r.status).toBe(65);
    expect(r.stdout.trim()).toBe("promo_write");
  });
});

describe("preprod_assert_write_gates: 登记制放行", () => {
  it("登记 catalog_write，catalog true/true -> PASS open=catalog_write", () => {
    const r = runGate({
      PREPROD_APPROVED_OPEN_WRITE_GATES: "catalog_write",
      FEATURE_NOVEL_CATALOG_SYNC: "true",
      NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("PREPROD_WRITE_GATES=PASS approved=catalog_write open=catalog_write");
  });

  it("登记 catalog_write，但 promo 为 true -> FAIL promo_write（登记不互相授权）", () => {
    const r = runGate({
      PREPROD_APPROVED_OPEN_WRITE_GATES: "catalog_write",
      FEATURE_NOVEL_CATALOG_SYNC: "true",
      NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true",
      FEATURE_PROMO_LINK_CLAIM: "true",
    });
    expect(r.status).toBe(65);
    expect(r.stdout.trim()).toBe("promo_write");
  });

  it("登记 catalog_write,promo_write，全 true -> PASS open=catalog_write,promo_write", () => {
    const r = runGate({
      PREPROD_APPROVED_OPEN_WRITE_GATES: "catalog_write,promo_write",
      FEATURE_NOVEL_CATALOG_SYNC: "true",
      NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true",
      FEATURE_PROMO_LINK_CLAIM: "true",
      PROMO_LINK_CLAIM_ALLOW_WRITE: "true",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("PREPROD_WRITE_GATES=PASS approved=catalog_write,promo_write open=catalog_write,promo_write");
  });

  it("登记值两侧带空格 -> 照常 PASS（trim 生效）", () => {
    const r = runGate({
      PREPROD_APPROVED_OPEN_WRITE_GATES: " catalog_write , promo_write ",
      FEATURE_NOVEL_CATALOG_SYNC: "true",
      NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true",
      FEATURE_PROMO_LINK_CLAIM: "true",
      PROMO_LINK_CLAIM_ALLOW_WRITE: "true",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("PREPROD_WRITE_GATES=PASS approved=catalog_write,promo_write open=catalog_write,promo_write");
  });

  it("已登记 + 两个都 false（登记了但没开）-> PASS open=none", () => {
    const r = runGate({ PREPROD_APPROVED_OPEN_WRITE_GATES: "catalog_write,promo_write" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("PREPROD_WRITE_GATES=PASS approved=catalog_write,promo_write open=none");
  });

  it("已登记 + dry-run 组合 FEATURE=true / ALLOW_WRITE=false -> PASS", () => {
    const r = runGate({
      PREPROD_APPROVED_OPEN_WRITE_GATES: "catalog_write",
      FEATURE_NOVEL_CATALOG_SYNC: "true",
      NOVEL_CATALOG_SYNC_ALLOW_WRITE: "false",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("PREPROD_WRITE_GATES=PASS approved=catalog_write open=catalog_write");
  });
});

describe("preprod_assert_write_gates: 封闭枚举拒绝未知值", () => {
  it("登记 indexnow_outbox（枚举外）-> FAIL approved_open_write_gate_unknown，并带出问题的值", () => {
    const r = runGate({ PREPROD_APPROVED_OPEN_WRITE_GATES: "indexnow_outbox" });
    expect(r.status).toBe(65);
    expect(r.stdout).toContain("approved_open_write_gate_unknown");
    expect(r.stdout).toContain("indexnow_outbox");
  });

  it("登记拼写错误 catalog_writ -> FAIL unknown", () => {
    const r = runGate({ PREPROD_APPROVED_OPEN_WRITE_GATES: "catalog_writ" });
    expect(r.status).toBe(65);
    expect(r.stdout).toContain("approved_open_write_gate_unknown");
    expect(r.stdout).toContain("catalog_writ");
  });

  it("重复的合法值可以容忍，不算 unknown", () => {
    const r = runGate({
      PREPROD_APPROVED_OPEN_WRITE_GATES: "catalog_write,catalog_write",
      FEATURE_NOVEL_CATALOG_SYNC: "true",
      NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("PREPROD_WRITE_GATES=PASS approved=catalog_write open=catalog_write");
  });

  it("结尾多一个逗号（空片段）被忽略", () => {
    const r = runGate({ PREPROD_APPROVED_OPEN_WRITE_GATES: "catalog_write," });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("approved=catalog_write");
  });
});

describe("preprod_assert_write_gates: 严格 true/false 校验", () => {
  it("已登记 + FEATURE 值为 TRUE（大写）-> FAIL catalog_write_invalid", () => {
    const r = runGate({
      PREPROD_APPROVED_OPEN_WRITE_GATES: "catalog_write",
      FEATURE_NOVEL_CATALOG_SYNC: "TRUE",
      NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true",
    });
    expect(r.status).toBe(65);
    expect(r.stdout.trim()).toBe("catalog_write_invalid");
  });

  it("已登记 + ALLOW_WRITE 值为 1 -> FAIL catalog_write_invalid", () => {
    const r = runGate({
      PREPROD_APPROVED_OPEN_WRITE_GATES: "catalog_write",
      FEATURE_NOVEL_CATALOG_SYNC: "true",
      NOVEL_CATALOG_SYNC_ALLOW_WRITE: "1",
    });
    expect(r.status).toBe(65);
    expect(r.stdout.trim()).toBe("catalog_write_invalid");
  });

  it("已登记 + ALLOW_WRITE 为空字符串 -> FAIL catalog_write_invalid", () => {
    const r = runGate({
      PREPROD_APPROVED_OPEN_WRITE_GATES: "catalog_write",
      FEATURE_NOVEL_CATALOG_SYNC: "true",
      NOVEL_CATALOG_SYNC_ALLOW_WRITE: "",
    });
    expect(r.status).toBe(65);
    expect(r.stdout.trim()).toBe("catalog_write_invalid");
  });

  it("已登记 + ALLOW_WRITE 完全未设置 -> FAIL catalog_write_invalid（未设置不等于 false）", () => {
    const r = runGateUnset(
      { PREPROD_APPROVED_OPEN_WRITE_GATES: "catalog_write", FEATURE_NOVEL_CATALOG_SYNC: "true" },
      ["NOVEL_CATALOG_SYNC_ALLOW_WRITE"],
    );
    expect(r.status).toBe(65);
    expect(r.stdout.trim()).toBe("catalog_write_invalid");
  });

  it("已登记 promo_write + FEATURE_PROMO_LINK_CLAIM 为 TRUE -> FAIL promo_write_invalid", () => {
    const r = runGate({
      PREPROD_APPROVED_OPEN_WRITE_GATES: "promo_write",
      FEATURE_PROMO_LINK_CLAIM: "TRUE",
      PROMO_LINK_CLAIM_ALLOW_WRITE: "true",
    });
    expect(r.status).toBe(65);
    expect(r.stdout.trim()).toBe("promo_write_invalid");
  });
});

describe("preflight.sh 接线", () => {
  it("调用 preprod_assert_write_gates，且不再包含原来两条硬编码 catalog_write/promo_write 判定", async () => {
    const preflight = await readFile(PREFLIGHT, "utf8");
    expect(preflight).toContain("preprod_assert_write_gates");
    expect(preflight).not.toMatch(
      /\[\[\s*"\$\{FEATURE_NOVEL_CATALOG_SYNC:-\}"\s*==\s*"false"\s*&&\s*"\$\{NOVEL_CATALOG_SYNC_ALLOW_WRITE:-\}"\s*==\s*"false"\s*\]\]\s*\|\|\s*fail catalog_write/,
    );
    expect(preflight).not.toMatch(
      /\[\[\s*"\$\{FEATURE_PROMO_LINK_CLAIM:-\}"\s*==\s*"false"\s*&&\s*"\$\{PROMO_LINK_CLAIM_ALLOW_WRITE:-\}"\s*==\s*"false"\s*\]\]\s*\|\|\s*fail promo_write/,
    );
  });

  it("其它写闸的硬关判定原样保留（indexnow_outbox / indexnow_delivery / auto_tagging / article_writes）", async () => {
    const preflight = await readFile(PREFLIGHT, "utf8");
    expect(preflight).toContain("|| fail indexnow_outbox");
    expect(preflight).toContain("|| fail indexnow_delivery");
    expect(preflight).toContain("|| fail auto_tagging");
    expect(preflight).toContain("|| fail article_writes");
  });
});

describe("bash 5 下的行为对照（docker bash:5.2，不可用则跳过）", () => {
  const BASH5_IMAGE = "bash:5.2";
  const bash5Available = spawnSync("docker", ["image", "inspect", BASH5_IMAGE], { encoding: "utf8" }).status === 0;
  const maybeIt = bash5Available ? it : it.skip;

  function runGateBash5(overrides: GateEnv) {
    const merged: GateEnv = { ...ALL_CLOSED, ...overrides };
    const args = ["run", "--rm", "-v", `${root}:/w`, "-w", "/w"];
    for (const [key, value] of Object.entries(merged)) {
      if (value === undefined) continue;
      args.push("-e", `${key}=${value}`);
    }
    args.push(
      BASH5_IMAGE,
      "bash",
      "-c",
      "set -euo pipefail; source scripts/preproduction/lib.sh; preprod_assert_write_gates",
    );
    return spawnSync("docker", args, { encoding: "utf8" });
  }

  maybeIt("PASS：全关未登记", () => {
    const r = runGateBash5({});
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("PREPROD_WRITE_GATES=PASS approved=none open=none");
  });

  maybeIt("FAIL catalog_write：未登记但 catalog 打开", () => {
    const r = runGateBash5({ FEATURE_NOVEL_CATALOG_SYNC: "true", NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true" });
    expect(r.status).toBe(65);
    expect(r.stdout.trim()).toBe("catalog_write");
  });

  maybeIt("FAIL unknown：登记了枚举外的值", () => {
    const r = runGateBash5({ PREPROD_APPROVED_OPEN_WRITE_GATES: "indexnow_outbox" });
    expect(r.status).toBe(65);
    expect(r.stdout).toContain("approved_open_write_gate_unknown");
  });

  maybeIt("FAIL invalid：已登记但值不是严格 true/false", () => {
    const r = runGateBash5({
      PREPROD_APPROVED_OPEN_WRITE_GATES: "catalog_write",
      FEATURE_NOVEL_CATALOG_SYNC: "TRUE",
      NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true",
    });
    expect(r.status).toBe(65);
    expect(r.stdout.trim()).toBe("catalog_write_invalid");
  });

  maybeIt("PASS：已登记 dry-run 组合", () => {
    const r = runGateBash5({
      PREPROD_APPROVED_OPEN_WRITE_GATES: "catalog_write",
      FEATURE_NOVEL_CATALOG_SYNC: "true",
      NOVEL_CATALOG_SYNC_ALLOW_WRITE: "false",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("PREPROD_WRITE_GATES=PASS approved=catalog_write open=catalog_write");
  });
});
