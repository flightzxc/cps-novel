import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  PromoClaimLifecycleConfigError,
  resolvePromoClaimLifecycleConfig,
} from "@/lib/tasks/promo-claim-lifecycle";

/**
 * 阶段2 第5步（`docs/adr/ADR-PROMO-CLAIM-BATCH-LIFECYCLE.md`，2.2）：
 * `scripts/preproduction/lib.sh` 的 `preprod_assert_promo_claim_lifecycle_config()`
 * 必须与 `resolvePromoClaimLifecycleConfig`（`src/lib/tasks/
 * promo-claim-lifecycle.ts`）逐条一致——本文件分三组：
 *   1) 直接 source lib.sh 调用该函数的单元行为测试；
 *   2) 真跑 `preflight.sh`，证明调用真的接线且取证行真的被采纳（同
 *      `preproduction-write-gates.test.ts` 的做法：不给 GIT_COMMIT，让脚本
 *      在这道新判定之后稳定停在 `reason=git_commit`）；
 *   3) "双跑"防漂移测试：同一组合法/非法样例同时喂给 TS 解析器和 shell
 *      校验，断言两边对"是否合法"的判断一致——这是任务要求的"一条测试防两边
 *      漂移"，不是泛泛的行为覆盖。
 *
 * 🔴 与 preproduction-write-gates.test.ts 同一条纪律：env 刻意干净，只带
 * PATH/HOME，不 spread process.env，避免本机可能残留的同名变量让测试跟着
 * 本机环境状态漂移。
 */

const root = process.cwd();
const LIB = path.join(root, "scripts/preproduction/lib.sh");
const PREFLIGHT = path.join(root, "scripts/preproduction/preflight.sh");

type LifecycleEnv = Partial<{
  PROMO_CLAIM_LIFECYCLE_V1_ENABLED: string;
  PROMO_CLAIM_BATCH_APPROVAL_TTL_MINUTES: string;
  PROMO_CLAIM_SHARD_WINDOW_MINUTES: string;
  PROMO_CLAIM_SHARD_SIZE_MIN: string;
  PROMO_CLAIM_SHARD_SIZE_MAX: string;
  PROMO_CLAIM_CREDENTIAL_SAFETY_MARGIN_MINUTES: string;
  PROMO_CLAIM_SHARD_DEADLINE_GRACE_MINUTES: string;
}>;

function runGate(overrides: LifecycleEnv) {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    env[key] = value;
  }
  const script = `set -euo pipefail\nsource "${LIB}"\npreprod_assert_promo_claim_lifecycle_config`;
  return spawnSync("bash", ["-c", script], { encoding: "utf8", env });
}

describe("preprod_assert_promo_claim_lifecycle_config: 全部未设置 -> PASS，取回退默认值", () => {
  it("七项全部未设置 -> PASS，报出与 PROMO_CLAIM_LIFECYCLE_DEFAULTS 逐字一致的默认值", () => {
    const r = runGate({});
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      "PREPROD_PROMO_CLAIM_LIFECYCLE_CONFIG=PASS enabled=false approvalTtlMinutes=1440 " +
        "shardWindowMinutes=90 shardSizeMin=50 shardSizeMax=1000 " +
        "credentialSafetyMarginMinutes=30 deadlineGraceMinutes=10",
    );
  });

  it("空字符串等同未设置（trim 后为空）-> PASS 用默认值", () => {
    const r = runGate({ PROMO_CLAIM_SHARD_WINDOW_MINUTES: "   " });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("shardWindowMinutes=90");
  });

  it("数值带前后空白 -> trim 后正常解析", () => {
    const r = runGate({ PROMO_CLAIM_SHARD_WINDOW_MINUTES: "  45  " });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("shardWindowMinutes=45");
  });
});

describe("preprod_assert_promo_claim_lifecycle_config: 开关严格 true/false/未设置", () => {
  it("enabled=true -> PASS", () => {
    const r = runGate({ PROMO_CLAIM_LIFECYCLE_V1_ENABLED: "true" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("enabled=true");
  });

  it("enabled=false -> PASS", () => {
    const r = runGate({ PROMO_CLAIM_LIFECYCLE_V1_ENABLED: "false" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("enabled=false");
  });

  it("enabled=TRUE（大写）-> FAIL，比 TS 更严格（TS 会静默当 false，见 lib.sh 注释）", () => {
    const r = runGate({ PROMO_CLAIM_LIFECYCLE_V1_ENABLED: "TRUE" });
    expect(r.status).toBe(65);
    expect(r.stdout).toContain(
      "promo_claim_lifecycle_config_invalid variable=PROMO_CLAIM_LIFECYCLE_V1_ENABLED value=TRUE reason=must_be_true_false_or_unset",
    );
  });

  it("enabled=1 -> FAIL", () => {
    const r = runGate({ PROMO_CLAIM_LIFECYCLE_V1_ENABLED: "1" });
    expect(r.status).toBe(65);
    expect(r.stdout).toContain("reason=must_be_true_false_or_unset");
  });
});

describe("preprod_assert_promo_claim_lifecycle_config: 六个数值项——非整数/越界/min>max", () => {
  const positiveVars = [
    "PROMO_CLAIM_BATCH_APPROVAL_TTL_MINUTES",
    "PROMO_CLAIM_SHARD_WINDOW_MINUTES",
    "PROMO_CLAIM_SHARD_SIZE_MIN",
    "PROMO_CLAIM_SHARD_SIZE_MAX",
  ] as const;

  for (const key of positiveVars) {
    it(`${key}=abc（非数字）-> FAIL reason=not_an_integer`, () => {
      const r = runGate({ [key]: "abc" } as LifecycleEnv);
      expect(r.status).toBe(65);
      expect(r.stdout).toContain(`variable=${key}`);
      expect(r.stdout).toContain("reason=not_an_integer");
    });

    it(`${key}=12.5（小数）-> FAIL reason=not_an_integer`, () => {
      const r = runGate({ [key]: "12.5" } as LifecycleEnv);
      expect(r.status).toBe(65);
      expect(r.stdout).toContain("reason=not_an_integer");
    });

    it(`${key}=0 -> FAIL reason=must_be_positive`, () => {
      const r = runGate({ [key]: "0" } as LifecycleEnv);
      expect(r.status).toBe(65);
      expect(r.stdout).toContain(`variable=${key}`);
      expect(r.stdout).toContain("reason=must_be_positive");
    });

    it(`${key}=-5（负数）-> FAIL reason=must_be_positive`, () => {
      const r = runGate({ [key]: "-5" } as LifecycleEnv);
      expect(r.status).toBe(65);
      expect(r.stdout).toContain("reason=must_be_positive");
    });
  }

  it("PROMO_CLAIM_SHARD_WINDOW_MINUTES=008（带前导零）-> PASS = 8（不被 bash 算术误判成非法八进制）", () => {
    const r = runGate({ PROMO_CLAIM_SHARD_WINDOW_MINUTES: "008" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("shardWindowMinutes=8");
  });

  const nonNegVars = [
    "PROMO_CLAIM_CREDENTIAL_SAFETY_MARGIN_MINUTES",
    "PROMO_CLAIM_SHARD_DEADLINE_GRACE_MINUTES",
  ] as const;

  for (const key of nonNegVars) {
    it(`${key}=0 -> PASS（非负允许 0）`, () => {
      const r = runGate({ [key]: "0" } as LifecycleEnv);
      expect(r.status).toBe(0);
    });

    it(`${key}=-1 -> FAIL reason=must_be_non_negative`, () => {
      const r = runGate({ [key]: "-1" } as LifecycleEnv);
      expect(r.status).toBe(65);
      expect(r.stdout).toContain(`variable=${key}`);
      expect(r.stdout).toContain("reason=must_be_non_negative");
    });

    it(`${key}=abc -> FAIL reason=not_an_integer`, () => {
      const r = runGate({ [key]: "abc" } as LifecycleEnv);
      expect(r.status).toBe(65);
      expect(r.stdout).toContain("reason=not_an_integer");
    });
  }

  it("shardSizeMin(2000) > shardSizeMax(默认1000) -> FAIL reason=exceeds_max", () => {
    const r = runGate({ PROMO_CLAIM_SHARD_SIZE_MIN: "2000" });
    expect(r.status).toBe(65);
    expect(r.stdout).toContain(
      "promo_claim_lifecycle_config_invalid variable=PROMO_CLAIM_SHARD_SIZE_MIN value=2000 reason=exceeds_max max=1000",
    );
  });

  it("shardSizeMin(500) 与 shardSizeMax(500) 相等 -> PASS（边界不误杀）", () => {
    const r = runGate({ PROMO_CLAIM_SHARD_SIZE_MIN: "500", PROMO_CLAIM_SHARD_SIZE_MAX: "500" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("shardSizeMin=500 shardSizeMax=500");
  });

  it("显式设置 min/max 且合法 -> PASS 报出显式值而不是默认值", () => {
    const r = runGate({ PROMO_CLAIM_SHARD_SIZE_MIN: "100", PROMO_CLAIM_SHARD_SIZE_MAX: "200" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("shardSizeMin=100 shardSizeMax=200");
  });
});

describe("preflight.sh 接线：调用行真的存在，取证行真的在最终 PASS 之前", () => {
  it("调用行本身同时含 $(preprod_assert_promo_claim_lifecycle_config) 与 || fail", async () => {
    const preflight = await readFile(PREFLIGHT, "utf8");
    const code = preflight.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
    expect(code).toMatch(
      /lifecycle_config_evidence="\$\(preprod_assert_promo_claim_lifecycle_config\)"\s*\|\|\s*fail\s+"\$lifecycle_config_evidence"/,
    );
  });

  it("取证行 echo \"$lifecycle_config_evidence\" 在最后一次 echo PREPROD_PREFLIGHT=PASS 之前", async () => {
    const preflight = await readFile(PREFLIGHT, "utf8");
    const code = preflight.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
    const evidenceIndex = code.indexOf('echo "$lifecycle_config_evidence"');
    const finalPassIndex = code.lastIndexOf('echo "PREPROD_PREFLIGHT=PASS"');
    expect(evidenceIndex).toBeGreaterThan(-1);
    expect(finalPassIndex).toBeGreaterThan(-1);
    expect(evidenceIndex).toBeLessThan(finalPassIndex);
  });
});

describe("preflight.sh 真实行为（不 mock）：配置门禁在写闸判定之后、git_commit 判定之前生效", () => {
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
    FEATURE_NOVEL_CATALOG_SYNC: "false",
    NOVEL_CATALOG_SYNC_ALLOW_WRITE: "false",
    FEATURE_PROMO_LINK_CLAIM: "false",
    PROMO_LINK_CLAIM_ALLOW_WRITE: "false",
    FEATURE_NOVEL_TAG_AUTO: "false",
    AUTO_WRITE_AUTHORIZED: "NO",
    ARTICLE_BLOG_ALLOW_WRITE: "false",
    ARTICLE_NOVEL_REBIND_ALLOW_WRITE: "false",
    // 刻意不给 GIT_COMMIT：见文件顶部说明。
  };

  async function writePreflightEnvFile(overrides: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "preflight-lifecycle-env-"));
    const file = path.join(dir, "preprod.env");
    const merged = { ...BASE_ENV, ...overrides };
    const content = `${Object.entries(merged).map(([k, v]) => `${k}=${v}`).join("\n")}\n`;
    await writeFile(file, content, "utf8");
    return file;
  }

  function runPreflight(envFile: string) {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME, PREPROD_ENV_FILE: envFile };
    return spawnSync("bash", [PREFLIGHT], { encoding: "utf8", env });
  }

  it("生命周期配置全部合法（默认）-> 越过该判定，稳定停在 reason=git_commit", async () => {
    const envFile = await writePreflightEnvFile({});
    const r = runPreflight(envFile);
    expect(r.status).toBe(65);
    expect(r.stdout).toContain("PREPROD_PREFLIGHT=FAIL reason=git_commit");
    expect(r.stdout).not.toContain("promo_claim_lifecycle_config_invalid");
  });

  it("PROMO_CLAIM_SHARD_WINDOW_MINUTES 非法 -> 在这道判定处 FAIL，退出码 65，且比 git_commit 判定更早生效", async () => {
    const envFile = await writePreflightEnvFile({ PROMO_CLAIM_SHARD_WINDOW_MINUTES: "-1" });
    const r = runPreflight(envFile);
    expect(r.status).toBe(65);
    expect(r.stdout).toContain(
      "PREPROD_PREFLIGHT=FAIL reason=promo_claim_lifecycle_config_invalid variable=PROMO_CLAIM_SHARD_WINDOW_MINUTES value=-1 reason=must_be_positive",
    );
  });

  it("PROMO_CLAIM_LIFECYCLE_V1_ENABLED=TRUE（大写笔误）-> preflight FAIL，不会静默通过", async () => {
    const envFile = await writePreflightEnvFile({ PROMO_CLAIM_LIFECYCLE_V1_ENABLED: "TRUE" });
    const r = runPreflight(envFile);
    expect(r.status).toBe(65);
    expect(r.stdout).toContain("PREPROD_PREFLIGHT=FAIL reason=promo_claim_lifecycle_config_invalid variable=PROMO_CLAIM_LIFECYCLE_V1_ENABLED");
  });

  it("显式开启且全部合法 -> 越过该判定，取证行会出现在最终 PASS 路径上（此处仍稳定停在 git_commit）", async () => {
    const envFile = await writePreflightEnvFile({
      PROMO_CLAIM_LIFECYCLE_V1_ENABLED: "true",
      PROMO_CLAIM_SHARD_WINDOW_MINUTES: "45",
      PROMO_CLAIM_SHARD_SIZE_MIN: "20",
      PROMO_CLAIM_SHARD_SIZE_MAX: "500",
    });
    const r = runPreflight(envFile);
    expect(r.status).toBe(65);
    expect(r.stdout).toContain("PREPROD_PREFLIGHT=FAIL reason=git_commit");
    expect(r.stdout).not.toContain("promo_claim_lifecycle_config_invalid");
  });
});

/**
 * "双跑"防漂移：同一组合法/非法样例同时喂给 TS 解析器
 * （`resolvePromoClaimLifecycleConfig`）和 shell 校验
 * （`preprod_assert_promo_claim_lifecycle_config`），断言两边对
 * "是否合法"的判断一致。只覆盖六个数值项——开关字段的行为差异是有意为之
 * 的策略叠加，详见 lib.sh 该函数上方的说明，不在本组"一致性"断言范围内。
 *
 * 样例刻意只用双方都无歧义同意的十进制写法（纯数字、可选前导负号、小数点、
 * 空白、越界）——不覆盖 JS 独有的科学计数法/十六进制/前导 "+" 这类写法，
 * lib.sh 的函数注释已说明这个刻意的范围收窄。
 */
describe("TS 解析器 vs shell 校验：数值项判定一致性（防两边漂移）", () => {
  const numericSamples = ["", "  ", "50", "1440", "0", "-1", "-5", "12.5", "abc", "1 2", "008", "3000000"];

  const positiveFields: Array<{ env: keyof LifecycleEnv; tsKey: "approvalTtlMinutes" | "shardWindowMinutes" }> = [
    { env: "PROMO_CLAIM_BATCH_APPROVAL_TTL_MINUTES", tsKey: "approvalTtlMinutes" },
    { env: "PROMO_CLAIM_SHARD_WINDOW_MINUTES", tsKey: "shardWindowMinutes" },
  ];
  const nonNegFields: Array<{ env: keyof LifecycleEnv; tsKey: "credentialSafetyMarginMinutes" | "deadlineGraceMinutes" }> = [
    { env: "PROMO_CLAIM_CREDENTIAL_SAFETY_MARGIN_MINUTES", tsKey: "credentialSafetyMarginMinutes" },
    { env: "PROMO_CLAIM_SHARD_DEADLINE_GRACE_MINUTES", tsKey: "deadlineGraceMinutes" },
  ];

  function tsAccepts(env: LifecycleEnv): boolean {
    const fullEnv: NodeJS.ProcessEnv = { NODE_ENV: "test", ...env };
    try {
      resolvePromoClaimLifecycleConfig(fullEnv);
      return true;
    } catch (error) {
      if (error instanceof PromoClaimLifecycleConfigError) return false;
      throw error;
    }
  }

  function shellAccepts(env: LifecycleEnv): boolean {
    return runGate(env).status === 0;
  }

  for (const field of [...positiveFields, ...nonNegFields]) {
    for (const sample of numericSamples) {
      it(`${field.env}=${JSON.stringify(sample)} -> TS 与 shell 判定一致`, () => {
        const env: LifecycleEnv = { [field.env]: sample } as LifecycleEnv;
        expect(shellAccepts(env)).toBe(tsAccepts(env));
      });
    }
  }

  it("shardSizeMin/shardSizeMax 组合（min>max / min==max / min<max）两边判定一致", () => {
    const combos: Array<[string, string]> = [["100", "50"], ["500", "500"], ["50", "1000"], ["0", "1000"], ["50", "0"]];
    for (const [min, max] of combos) {
      const env: LifecycleEnv = { PROMO_CLAIM_SHARD_SIZE_MIN: min, PROMO_CLAIM_SHARD_SIZE_MAX: max };
      expect(shellAccepts(env), `min=${min} max=${max}`).toBe(tsAccepts(env));
    }
  });
});

describe("bash 5 下的行为对照（docker bash:5.2，不可用则跳过）", () => {
  const BASH5_IMAGE = "bash:5.2";
  const bash5Available = spawnSync("docker", ["image", "inspect", BASH5_IMAGE], { encoding: "utf8" }).status === 0;
  const maybeIt = bash5Available ? it : it.skip;

  function runGateBash5(overrides: LifecycleEnv) {
    const args = ["run", "--rm", "-v", `${root}:/w`, "-w", "/w"];
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) continue;
      args.push("-e", `${key}=${value}`);
    }
    args.push(
      BASH5_IMAGE,
      "bash",
      "-c",
      "set -euo pipefail; source scripts/preproduction/lib.sh; preprod_assert_promo_claim_lifecycle_config",
    );
    return spawnSync("docker", args, { encoding: "utf8" });
  }

  maybeIt("PASS：全部未设置", () => {
    const r = runGateBash5({});
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("PREPROD_PROMO_CLAIM_LIFECYCLE_CONFIG=PASS");
  });

  maybeIt("PASS：带前导零 008 不被误判为非法八进制", () => {
    const r = runGateBash5({ PROMO_CLAIM_SHARD_WINDOW_MINUTES: "008" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("shardWindowMinutes=8");
  });

  maybeIt("FAIL：开关笔误 TRUE", () => {
    const r = runGateBash5({ PROMO_CLAIM_LIFECYCLE_V1_ENABLED: "TRUE" });
    expect(r.status).toBe(65);
    expect(r.stdout).toContain("must_be_true_false_or_unset");
  });

  maybeIt("FAIL：min>max", () => {
    const r = runGateBash5({ PROMO_CLAIM_SHARD_SIZE_MIN: "2000" });
    expect(r.status).toBe(65);
    expect(r.stdout).toContain("reason=exceeds_max");
  });
});
