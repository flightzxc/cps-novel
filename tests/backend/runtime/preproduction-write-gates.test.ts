import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { isSitemapAutoRefreshEnabled, isSitemapAutoRefreshWriteAllowed } from "../../../src/lib/flags/feature-flags";

/**
 * PREPROD_APPROVED_OPEN_WRITE_GATES：写闸从"恒为 false"改成"封闭枚举 + 显式登记制"。
 *
 * 背景与冻结的契约见 scripts/preproduction/lib.sh 里 preprod_assert_write_gates()
 * 上方的注释，以及 docs/adr/ADR-PREPROD-APPROVED-OPEN-WRITE-GATES.md。
 *
 * 大部分测试直接 source lib.sh 调函数。下面还有一组真跑 scripts/preproduction/
 * preflight.sh 的行为测试，但故意不提供 GIT_COMMIT，让脚本在写闸判定之后、
 * secrets-preflight.sh（会读目标机密钥文件，测试环境跑不了）与任何 docker/node
 * 调用之前，稳定停在 `reason=git_commit`——足够证明写闸判定真的被调用、真的被采纳。
 *
 * 🔴 env 刻意干净：只带 PATH/HOME（sed/bash 等外部命令需要），不 spread
 * process.env —— 本机 shell 里如果凑巧导出过同名变量（FEATURE_NOVEL_CATALOG_SYNC
 * 等），继承 process.env 会让测试跟着本机环境状态漂移，静默通过或静默失败。
 */

const root = process.cwd();
const LIB = path.join(root, "scripts/preproduction/lib.sh");
const PREFLIGHT = path.join(root, "scripts/preproduction/preflight.sh");

type GateEnv = {
  FEATURE_SITEMAP_AUTO_REFRESH?: string;
  SITEMAP_AUTO_REFRESH_ALLOW_WRITE?: string;
  PREPROD_APPROVED_OPEN_WRITE_GATES?: string;
  FEATURE_NOVEL_CATALOG_SYNC?: string;
  NOVEL_CATALOG_SYNC_ALLOW_WRITE?: string;
  FEATURE_PROMO_LINK_CLAIM?: string;
  PROMO_LINK_CLAIM_ALLOW_WRITE?: string;
};

/** All six gate variables false and unregistered. */
const ALL_CLOSED: Required<GateEnv> = {
  PREPROD_APPROVED_OPEN_WRITE_GATES: "",
    FEATURE_SITEMAP_AUTO_REFRESH: "false",
    SITEMAP_AUTO_REFRESH_ALLOW_WRITE: "false",
  FEATURE_NOVEL_CATALOG_SYNC: "false",
  NOVEL_CATALOG_SYNC_ALLOW_WRITE: "false",
  FEATURE_PROMO_LINK_CLAIM: "false",
  PROMO_LINK_CLAIM_ALLOW_WRITE: "false",
};

function runGate(overrides: GateEnv) {
  const merged: GateEnv = { ...ALL_CLOSED, ...overrides };
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME };
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
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME };
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

/**
 * Opus 复核（85e9117 之后）：仅靠 `expect(preflight).toContain("preprod_assert_write_gates")`
 * 这种文本断言不承重——删掉真正的调用行 `write_gates_evidence="$(preprod_assert_write_gates)"
 * || fail "$write_gates_evidence"` 之后，这句话仍然被上面解释性注释里同一个函数名满足，
 * 测试照样全绿，而 catalog/promo 两组写闸此时完全不再被检查。
 *
 * 修法两层都要：
 *   1) 去掉注释行后再用正则核查"调用行本身"（同一行既有 `$(preprod_assert_write_gates)`
 *      又有 `|| fail`），而不是只查函数名是否在文件的任意位置出现过（哪怕是注释里）；
 *   2) 补一组真跑 preflight.sh 的行为测试（见下面 describe），不满足于源码字符串匹配。
 */
function stripBashComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

describe("preflight.sh 接线（文本层：去掉注释后核查真正的调用行）", () => {
  it("调用行本身同时含 $(preprod_assert_write_gates) 与 || fail，不是只在注释里提到函数名", async () => {
    const preflight = await readFile(PREFLIGHT, "utf8");
    const code = stripBashComments(preflight);
    expect(code).toMatch(/write_gates_evidence="\$\(preprod_assert_write_gates\)"\s*\|\|\s*fail\s+"\$write_gates_evidence"/);
  });

  it("不再包含原来两条硬编码 catalog_write/promo_write 判定", async () => {
    const preflight = await readFile(PREFLIGHT, "utf8");
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

  it("取证行 echo \"$write_gates_evidence\" 在最后一次 echo PREPROD_PREFLIGHT=PASS 之前", async () => {
    const preflight = await readFile(PREFLIGHT, "utf8");
    const code = stripBashComments(preflight);
    const evidenceIndex = code.indexOf('echo "$write_gates_evidence"');
    const finalPassIndex = code.lastIndexOf('echo "PREPROD_PREFLIGHT=PASS"');
    expect(evidenceIndex).toBeGreaterThan(-1);
    expect(finalPassIndex).toBeGreaterThan(-1);
    expect(evidenceIndex).toBeLessThan(finalPassIndex);
  });
});

/**
 * 行为层：真跑 scripts/preproduction/preflight.sh（不 mock、不 source 局部函数）。
 *
 * 只到写闸判定通过之后、GIT_COMMIT 格式判定（`fail git_commit`，preflight.sh 第 30
 * 行左右）为止——这条判定在 secrets-preflight.sh（第 62 行左右，需要目标机密钥文件与
 * root 权限）与任何 docker/node 调用之前，所以刻意不传 GIT_COMMIT，让脚本在写闸判定
 * 之后稳定停在这一步，既证明了写闸判定真的跑过、真的采纳了它的结果，又不touch 任何
 * 本机文件系统之外的东西。env 用干净对象传入（只带 PATH/HOME/PREPROD_ENV_FILE），
 * 不继承本机可能存在的 GIT_COMMIT / CPS_NOVEL_APP_IMAGE 等变量。
 */
describe("preflight.sh 真实行为（不 mock，走到写闸判定之后稳定停在 reason=git_commit）", () => {
  const BASE_ENV: Record<string, string> = {
    P1_12_COMPOSE_PROJECT: "cps-novel",
    SITE_URL: "https://www.bangbangji.cloud",
    ADMIN_CANONICAL_ORIGIN: "https://zbcwf.bangbangji.cloud",
    PUBLIC_TRACKING_WRITE_DISABLED: "1",
    ADMIN_TWO_FACTOR_ENFORCEMENT: "true",
    FEATURE_INDEXNOW_OUTBOX: "false",
    INDEXNOW_OUTBOX_ALLOW_WRITE: "false",
    FEATURE_INDEXNOW_DELIVERY: "false",
    INDEXNOW_DELIVERY_ALLOW_WRITE: "false",
    PREPROD_APPROVED_OPEN_WRITE_GATES: "",
    FEATURE_SITEMAP_AUTO_REFRESH: "false",
    SITEMAP_AUTO_REFRESH_ALLOW_WRITE: "false",
    FEATURE_NOVEL_CATALOG_SYNC: "false",
    NOVEL_CATALOG_SYNC_ALLOW_WRITE: "false",
    FEATURE_PROMO_LINK_CLAIM: "false",
    PROMO_LINK_CLAIM_ALLOW_WRITE: "false",
    FEATURE_NOVEL_TAG_AUTO: "false",
    AUTO_WRITE_AUTHORIZED: "NO",
    ARTICLE_BLOG_ALLOW_WRITE: "false",
    ARTICLE_NOVEL_REBIND_ALLOW_WRITE: "false",
    // 🔴 刻意不给 GIT_COMMIT：写闸判定通过后，下一条 `fail git_commit` 会稳定拦下，
    // 早于 secrets-preflight.sh 与任何 compose/node 调用，测试环境不用碰任何主机文件。
  };

  async function writePreflightEnvFile(overrides: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "preflight-env-"));
    const file = path.join(dir, "preprod.env");
    const merged = { ...BASE_ENV, ...overrides };
    const content = `${Object.entries(merged)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n")}\n`;
    await writeFile(file, content, "utf8");
    return file;
  }

  function runPreflight(envFile: string) {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME, PREPROD_ENV_FILE: envFile };
    return spawnSync("bash", [PREFLIGHT], { encoding: "utf8", env });
  }

  it.each([false, true])("sitemap preflight integration registered=%s", async (registered) => {
    const file = await writePreflightEnvFile({
      FEATURE_SITEMAP_AUTO_REFRESH: "true", SITEMAP_AUTO_REFRESH_ALLOW_WRITE: "true",
      PREPROD_APPROVED_OPEN_WRITE_GATES: registered ? "sitemap_write" : "",
    });
    const result = runPreflight(file);
    expect(result.status).toBe(65);
    expect(result.stdout).toContain(`PREPROD_PREFLIGHT=FAIL reason=${registered ? "git_commit" : "sitemap_write"}`);
  });

  it("catalog 打开且未登记 -> 在写闸判定处 FAIL reason=catalog_write，退出码 65", async () => {
    const envFile = await writePreflightEnvFile({
      FEATURE_NOVEL_CATALOG_SYNC: "true",
      NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true",
    });
    const r = runPreflight(envFile);
    expect(r.status).toBe(65);
    expect(r.stdout).toContain("PREPROD_PREFLIGHT=FAIL reason=catalog_write");
  });

  it("登记 catalog_write,promo_write 且四个变量全 true -> 越过写闸，稳定停在 reason=git_commit（证明调用存在且放行结果被采纳）", async () => {
    const envFile = await writePreflightEnvFile({
      PREPROD_APPROVED_OPEN_WRITE_GATES: "catalog_write,promo_write",
      FEATURE_NOVEL_CATALOG_SYNC: "true",
      NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true",
      FEATURE_PROMO_LINK_CLAIM: "true",
      PROMO_LINK_CLAIM_ALLOW_WRITE: "true",
    });
    const r = runPreflight(envFile);
    expect(r.status).toBe(65);
    expect(r.stdout).toContain("PREPROD_PREFLIGHT=FAIL reason=git_commit");
    // 反证：如果写闸判定没有真的被采纳，这里会先被 catalog_write/promo_write 拦下。
    expect(r.stdout).not.toContain("reason=catalog_write");
    expect(r.stdout).not.toContain("reason=promo_write");
  });

  it("登记枚举外的值 indexnow_outbox -> FAIL reason=approved_open_write_gate_unknown", async () => {
    const envFile = await writePreflightEnvFile({
      PREPROD_APPROVED_OPEN_WRITE_GATES: "indexnow_outbox",
    });
    const r = runPreflight(envFile);
    expect(r.status).toBe(65);
    expect(r.stdout).toContain("PREPROD_PREFLIGHT=FAIL reason=approved_open_write_gate_unknown");
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

  maybeIt("sitemap bash 5 registration, single-side and invalid checks", () => {
    for (const feature of ["false", "true"]) for (const write of ["false", "true"]) {
      const flags = { FEATURE_SITEMAP_AUTO_REFRESH: feature, SITEMAP_AUTO_REFRESH_ALLOW_WRITE: write };
      expect(runGateBash5(flags).status).toBe(feature === "true" || write === "true" ? 65 : 0);
      expect(runGateBash5({ ...flags, PREPROD_APPROVED_OPEN_WRITE_GATES: "sitemap_write" }).status).toBe(0);
    }
    expect(runGateBash5({ FEATURE_SITEMAP_AUTO_REFRESH: "TRUE" }).stdout.trim()).toBe("sitemap_write_invalid");
  });

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


describe("sitemap registration and runtime parsing", () => {
  for (const feature of ["false", "true"]) for (const write of ["false", "true"]) {
    for (const registered of [false, true]) {
      it(`${feature}/${write}, registered=${registered}`, () => {
        const env = {
          NODE_ENV: "test" as const,
          FEATURE_SITEMAP_AUTO_REFRESH: feature,
          SITEMAP_AUTO_REFRESH_ALLOW_WRITE: write,
          PREPROD_APPROVED_OPEN_WRITE_GATES: registered ? "sitemap_write" : "",
        };
        const result = runGate(env);
        const open = feature === "true" || write === "true";
        expect(result.status).toBe(open && !registered ? 65 : 0);
        expect(result.stdout.trim()).toBe(open && !registered ? "sitemap_write" :
          `PREPROD_WRITE_GATES=PASS approved=${registered ? "sitemap_write" : "none"} open=${open ? "sitemap_write" : "none"}`);
        expect(isSitemapAutoRefreshEnabled(env)).toBe(feature === "true");
        expect(isSitemapAutoRefreshWriteAllowed(env)).toBe(write === "true");
      });
    }
  }
  for (const registered of [false, true]) for (const key of ["FEATURE_SITEMAP_AUTO_REFRESH", "SITEMAP_AUTO_REFRESH_ALLOW_WRITE"] as const) {
    for (const value of [undefined, "", "TRUE", "1", " true", "false "]) {
      it(`rejects ${key}=${String(value)}, registered=${registered}`, () => {
        const env = { NODE_ENV: "test" as const, PREPROD_APPROVED_OPEN_WRITE_GATES: registered ? "sitemap_write" : "", [key]: value };
        const result = runGate(env);
        expect(result.status).toBe(65);
        expect(result.stdout.trim()).toBe("sitemap_write_invalid");
        expect(isSitemapAutoRefreshEnabled(env)).toBe(false);
        expect(isSitemapAutoRefreshWriteAllowed(env)).toBe(false);
      });
    }
  }
  it("accepts the historical template profile and emits all three gates", async () => {
    const template = await readFile(path.join(root, "infra/preproduction/preprod.env.example"), "utf8");
    const keys = Object.keys(ALL_CLOSED);
    const values = Object.fromEntries(template.split("\n").filter((line) => keys.includes(line.split("=")[0]))
      .map((line) => [line.split("=")[0], line.slice(line.indexOf("=") + 1)]));
    const result = runGate(values);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("PREPROD_WRITE_GATES=PASS approved=catalog_write,promo_write,sitemap_write open=catalog_write,promo_write,sitemap_write");
  });

  it("normalizes duplicate approvals; unknown names still fail closed", () => {
    expect(runGate({ PREPROD_APPROVED_OPEN_WRITE_GATES: " sitemap_write ,sitemap_write," }).stdout)
      .toContain("approved=sitemap_write open=none");
    const result = runGate({ PREPROD_APPROVED_OPEN_WRITE_GATES: "sitemap_write,sitemap" });
    expect(result.status).toBe(65);
    expect(result.stdout).toContain("approved_open_write_gate_unknown value=sitemap");
  });
});
