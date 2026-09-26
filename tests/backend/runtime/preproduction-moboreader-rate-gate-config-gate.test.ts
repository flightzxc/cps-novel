import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  MOBOREADER_PER_ENDPOINT_INTERVAL_FLOOR_MS,
  MoboreaderRateLimitConfigError,
  isMoboreaderPerEndpointRateGateEnabled,
  resolveMoboreaderPerEndpointRateGateConfig,
} from "@/lib/adapters/moboreader-rate-limit";

/**
 * 阶段 4-A（设计《领推广按接口限速与预读集合化 · 阶段4-5》§5.6）：
 * `scripts/preproduction/lib.sh` 的 `preprod_assert_moboreader_rate_gate_config()`
 * 必须与 `resolveMoboreaderPerEndpointRateGateConfig`
 * （`src/lib/adapters/moboreader-rate-limit.ts`）逐条一致——结构完全照抄
 * `preproduction-promo-claim-lifecycle-config-gate.test.ts` 的四段做法：
 *   1) 直接 source lib.sh 调用该函数的单元行为测试；
 *   2) 真跑 `preflight.sh`，证明调用真的接线且取证行真的在最终 PASS 之前；
 *   3) "双跑"防漂移：同一组样例同时喂给 TS 解析器和 shell 校验；
 *   4) bash 5 下的行为对照。
 *
 * env 刻意干净，只带 PATH/HOME，不 spread process.env——同一条纪律见
 * `preproduction-write-gates.test.ts`。
 */

const root = process.cwd();
const LIB = path.join(root, "scripts/preproduction/lib.sh");
const PREFLIGHT = path.join(root, "scripts/preproduction/preflight.sh");

type RateGateEnv = Partial<{
  MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENABLED: string;
  MOBOREADER_UPSTREAM_MIN_REQUEST_INTERVAL_MS__GETLISTPC: string;
  MOBOREADER_UPSTREAM_MIN_REQUEST_INTERVAL_MS__GETCODE: string;
  MOBOREADER_UPSTREAM_HOST_MIN_GAP_MS: string;
  MOBOREADER_UPSTREAM_REMAINING_FLOOR__GETLISTPC: string;
  MOBOREADER_UPSTREAM_REMAINING_FLOOR__GETCODE: string;
  MOBOREADER_UPSTREAM_RATE_WINDOW_MAX_WAIT_MS: string;
  MOBOREADER_UPSTREAM_RETRY_AFTER_ANOMALY_THRESHOLD_MS: string;
}>;

function runGate(overrides: RateGateEnv) {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    env[key] = value;
  }
  const script = `set -euo pipefail\nsource "${LIB}"\npreprod_assert_moboreader_rate_gate_config`;
  return spawnSync("bash", ["-c", script], { encoding: "utf8", env });
}

describe("preprod_assert_moboreader_rate_gate_config: 全部未设置 -> PASS，取回退默认值", () => {
  it("八项全部未设置 -> PASS，报出与设计 §5.4/E2-E4 逐字一致的默认值（含必改1新增的 cooldownAnomalyThresholdMs）", () => {
    const r = runGate({});
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      "PREPROD_MOBOREADER_RATE_GATE_CONFIG=PASS enabled=false intervalGetlistpcMs=1200 " +
        "intervalGetcodeMs=1200 hostMinGapMs=250 remainingFloorGetlistpc=8 " +
        "remainingFloorGetcode=12 rateWindowMaxWaitMs=60000 cooldownAnomalyThresholdMs=900000",
    );
  });

  it("空字符串等同未设置（trim 后为空）-> PASS 用默认值", () => {
    const r = runGate({ MOBOREADER_UPSTREAM_HOST_MIN_GAP_MS: "   " });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("hostMinGapMs=250");
  });

  it("数值带前后空白 -> trim 后正常解析", () => {
    const r = runGate({ MOBOREADER_UPSTREAM_HOST_MIN_GAP_MS: "  300  " });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("hostMinGapMs=300");
  });
});

describe("preprod_assert_moboreader_rate_gate_config: 开关严格 true/false/未设置", () => {
  it("enabled=true -> PASS", () => {
    const r = runGate({ MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENABLED: "true" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("enabled=true");
  });

  it("enabled=false -> PASS", () => {
    const r = runGate({ MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENABLED: "false" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("enabled=false");
  });

  it("enabled=TRUE（大写）-> FAIL，比 TS 更严格（TS 会静默当 false，见 lib.sh 注释）", () => {
    const r = runGate({ MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENABLED: "TRUE" });
    expect(r.status).toBe(65);
    expect(r.stdout).toContain(
      "moboreader_rate_gate_config_invalid variable=MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENABLED value=TRUE reason=must_be_true_false_or_unset",
    );
  });

  it("enabled=1 -> FAIL", () => {
    const r = runGate({ MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENABLED: "1" });
    expect(r.status).toBe(65);
    expect(r.stdout).toContain("reason=must_be_true_false_or_unset");
  });
});

describe("preprod_assert_moboreader_rate_gate_config: 两个接口间隔——1000ms 安全下限（设计 §5.6）", () => {
  const intervalVars = [
    "MOBOREADER_UPSTREAM_MIN_REQUEST_INTERVAL_MS__GETLISTPC",
    "MOBOREADER_UPSTREAM_MIN_REQUEST_INTERVAL_MS__GETCODE",
  ] as const;

  for (const key of intervalVars) {
    it(`${key}=999（低于 1000ms 下限）-> FAIL reason=below_interval_floor`, () => {
      const r = runGate({ [key]: "999" } as RateGateEnv);
      expect(r.status).toBe(65);
      expect(r.stdout).toContain(`variable=${key}`);
      expect(r.stdout).toContain("reason=below_interval_floor");
    });

    it(`${key}=1000（恰好等于下限）-> PASS（边界不误杀）`, () => {
      const r = runGate({ [key]: "1000" } as RateGateEnv);
      expect(r.status).toBe(0);
    });

    it(`${key}=120（C-13 事故值本身）-> FAIL，正是这道门禁要挡的手误`, () => {
      const r = runGate({ [key]: "120" } as RateGateEnv);
      expect(r.status).toBe(65);
      expect(r.stdout).toContain("reason=below_interval_floor");
    });

    it(`${key}=abc（非数字）-> FAIL reason=not_an_integer`, () => {
      const r = runGate({ [key]: "abc" } as RateGateEnv);
      expect(r.status).toBe(65);
      expect(r.stdout).toContain("reason=not_an_integer");
    });

    it(`${key}=12.5（小数）-> FAIL reason=not_an_integer`, () => {
      const r = runGate({ [key]: "12.5" } as RateGateEnv);
      expect(r.status).toBe(65);
      expect(r.stdout).toContain("reason=not_an_integer");
    });

    it(`${key}=-5（负数）-> FAIL reason=below_interval_floor`, () => {
      const r = runGate({ [key]: "-5" } as RateGateEnv);
      expect(r.status).toBe(65);
      expect(r.stdout).toContain("reason=below_interval_floor");
    });

    it(`${key}=1500（显式设置且合法）-> PASS 报出显式值`, () => {
      const r = runGate({ [key]: "1500" } as RateGateEnv);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(key.endsWith("GETLISTPC") ? "intervalGetlistpcMs=1500" : "intervalGetcodeMs=1500");
    });
  }
});

describe("preprod_assert_moboreader_rate_gate_config: 主机级间隔——非负整数", () => {
  it("MOBOREADER_UPSTREAM_HOST_MIN_GAP_MS=0 -> PASS（非负允许 0）", () => {
    const r = runGate({ MOBOREADER_UPSTREAM_HOST_MIN_GAP_MS: "0" });
    expect(r.status).toBe(0);
  });

  it("MOBOREADER_UPSTREAM_HOST_MIN_GAP_MS=-1 -> FAIL reason=must_be_non_negative", () => {
    const r = runGate({ MOBOREADER_UPSTREAM_HOST_MIN_GAP_MS: "-1" });
    expect(r.status).toBe(65);
    expect(r.stdout).toContain("variable=MOBOREADER_UPSTREAM_HOST_MIN_GAP_MS");
    expect(r.stdout).toContain("reason=must_be_non_negative");
  });

  it("MOBOREADER_UPSTREAM_HOST_MIN_GAP_MS=abc -> FAIL reason=not_an_integer", () => {
    const r = runGate({ MOBOREADER_UPSTREAM_HOST_MIN_GAP_MS: "abc" });
    expect(r.status).toBe(65);
    expect(r.stdout).toContain("reason=not_an_integer");
  });

  it("MOBOREADER_UPSTREAM_HOST_MIN_GAP_MS=008（带前导零）-> PASS = 8（不被 bash 算术误判成非法八进制）", () => {
    const r = runGate({ MOBOREADER_UPSTREAM_HOST_MIN_GAP_MS: "008" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("hostMinGapMs=8");
  });
});

/**
 * 2026-09-25 Opus 复核修正：设计 §5.6 原文"地板必须 ≥ 1"，上一版本这里按
 * "非负整数、允许 0"实现是工单交接时的笔误，不是 Owner 改口——地板是 getcode
 * 撞 429（=结果不明）之前的主动减速保险，配成 0 等于一个配置就能把这道保险
 * 整体关掉。现在两个地板变量与两个接口间隔、窗口重置上限一样按"正整数、拒绝
 * 0"校验，reason 统一复用 `must_be_positive`（与 `MOBOREADER_UPSTREAM_RATE_
 * WINDOW_MAX_WAIT_MS` 的 reason 一致，不再有独立的 `must_be_non_negative`
 * 分支）。
 */
describe("preprod_assert_moboreader_rate_gate_config: 两个地板——正整数（[Opus fix] 不再允许 0，设计 §5.6）", () => {
  const floorVars = [
    "MOBOREADER_UPSTREAM_REMAINING_FLOOR__GETLISTPC",
    "MOBOREADER_UPSTREAM_REMAINING_FLOOR__GETCODE",
  ] as const;

  for (const key of floorVars) {
    it(`${key}=0 -> FAIL reason=must_be_positive（[Opus fix]：不再是"非负允许 0"）`, () => {
      const r = runGate({ [key]: "0" } as RateGateEnv);
      expect(r.status).toBe(65);
      expect(r.stdout).toContain(`variable=${key}`);
      expect(r.stdout).toContain("reason=must_be_positive");
    });

    it(`${key}=1（恰好等于下限）-> PASS（边界不误杀）`, () => {
      const r = runGate({ [key]: "1" } as RateGateEnv);
      expect(r.status).toBe(0);
    });

    it(`${key}=-1 -> FAIL reason=must_be_positive`, () => {
      const r = runGate({ [key]: "-1" } as RateGateEnv);
      expect(r.status).toBe(65);
      expect(r.stdout).toContain(`variable=${key}`);
      expect(r.stdout).toContain("reason=must_be_positive");
    });

    it(`${key}=abc -> FAIL reason=not_an_integer`, () => {
      const r = runGate({ [key]: "abc" } as RateGateEnv);
      expect(r.status).toBe(65);
      expect(r.stdout).toContain("reason=not_an_integer");
    });
  }

  it("MOBOREADER_UPSTREAM_REMAINING_FLOOR__GETLISTPC=008（带前导零）-> PASS = 8", () => {
    const r = runGate({ MOBOREADER_UPSTREAM_REMAINING_FLOOR__GETLISTPC: "008" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("remainingFloorGetlistpc=8");
  });
});

describe("preprod_assert_moboreader_rate_gate_config: 窗口重置上限——正整数", () => {
  it("MOBOREADER_UPSTREAM_RATE_WINDOW_MAX_WAIT_MS=0 -> FAIL reason=must_be_positive", () => {
    const r = runGate({ MOBOREADER_UPSTREAM_RATE_WINDOW_MAX_WAIT_MS: "0" });
    expect(r.status).toBe(65);
    expect(r.stdout).toContain("reason=must_be_positive");
  });

  it("MOBOREADER_UPSTREAM_RATE_WINDOW_MAX_WAIT_MS=45000 -> PASS 报出显式值", () => {
    const r = runGate({ MOBOREADER_UPSTREAM_RATE_WINDOW_MAX_WAIT_MS: "45000" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("rateWindowMaxWaitMs=45000");
  });
});

/**
 * 必改1新增：Retry-After 异常阈值——只决定何时多发一条 cooldown_anomaly
 * 观测事件，不改变实际冷却时长（那部分逻辑在 TS 侧，本门禁只管这个数值
 * 本身合法）。校验规则与窗口重置上限同构（正整数）。
 */
describe("preprod_assert_moboreader_rate_gate_config: Retry-After 异常阈值（必改1新增）——正整数", () => {
  it("MOBOREADER_UPSTREAM_RETRY_AFTER_ANOMALY_THRESHOLD_MS=0 -> FAIL reason=must_be_positive", () => {
    const r = runGate({ MOBOREADER_UPSTREAM_RETRY_AFTER_ANOMALY_THRESHOLD_MS: "0" });
    expect(r.status).toBe(65);
    expect(r.stdout).toContain("variable=MOBOREADER_UPSTREAM_RETRY_AFTER_ANOMALY_THRESHOLD_MS");
    expect(r.stdout).toContain("reason=must_be_positive");
  });

  it("MOBOREADER_UPSTREAM_RETRY_AFTER_ANOMALY_THRESHOLD_MS=-1 -> FAIL reason=must_be_positive", () => {
    const r = runGate({ MOBOREADER_UPSTREAM_RETRY_AFTER_ANOMALY_THRESHOLD_MS: "-1" });
    expect(r.status).toBe(65);
    expect(r.stdout).toContain("reason=must_be_positive");
  });

  it("MOBOREADER_UPSTREAM_RETRY_AFTER_ANOMALY_THRESHOLD_MS=abc -> FAIL reason=not_an_integer", () => {
    const r = runGate({ MOBOREADER_UPSTREAM_RETRY_AFTER_ANOMALY_THRESHOLD_MS: "abc" });
    expect(r.status).toBe(65);
    expect(r.stdout).toContain("reason=not_an_integer");
  });

  it("MOBOREADER_UPSTREAM_RETRY_AFTER_ANOMALY_THRESHOLD_MS=600000 -> PASS 报出显式值", () => {
    const r = runGate({ MOBOREADER_UPSTREAM_RETRY_AFTER_ANOMALY_THRESHOLD_MS: "600000" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("cooldownAnomalyThresholdMs=600000");
  });
});

describe("preflight.sh 接线：调用行真的存在，取证行真的在最终 PASS 之前", () => {
  it("调用行本身同时含 $(preprod_assert_moboreader_rate_gate_config) 与 || fail", async () => {
    const preflight = await readFile(PREFLIGHT, "utf8");
    const code = preflight.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
    expect(code).toMatch(
      /rate_gate_config_evidence="\$\(preprod_assert_moboreader_rate_gate_config\)"\s*\|\|\s*fail\s+"\$rate_gate_config_evidence"/,
    );
  });

  it("取证行 echo \"$rate_gate_config_evidence\" 在最后一次 echo PREPROD_PREFLIGHT=PASS 之前，且在生命周期取证行之后", async () => {
    const preflight = await readFile(PREFLIGHT, "utf8");
    const code = preflight.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
    const lifecycleEvidenceIndex = code.indexOf('echo "$lifecycle_config_evidence"');
    const rateGateEvidenceIndex = code.indexOf('echo "$rate_gate_config_evidence"');
    const finalPassIndex = code.lastIndexOf('echo "PREPROD_PREFLIGHT=PASS"');
    expect(lifecycleEvidenceIndex).toBeGreaterThan(-1);
    expect(rateGateEvidenceIndex).toBeGreaterThan(-1);
    expect(finalPassIndex).toBeGreaterThan(-1);
    expect(rateGateEvidenceIndex).toBeGreaterThan(lifecycleEvidenceIndex);
    expect(rateGateEvidenceIndex).toBeLessThan(finalPassIndex);
  });
});

describe("preflight.sh 真实行为（不 mock）：配置门禁在生命周期判定之后、git_commit 判定之前生效", () => {
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
    // 刻意不给 GIT_COMMIT：见文件顶部说明。
  };

  async function writePreflightEnvFile(overrides: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "preflight-rate-gate-env-"));
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

  it("限速配置全部合法（默认）-> 越过该判定，稳定停在 reason=git_commit", async () => {
    const envFile = await writePreflightEnvFile({});
    const r = runPreflight(envFile);
    expect(r.status).toBe(65);
    expect(r.stdout).toContain("PREPROD_PREFLIGHT=FAIL reason=git_commit");
    expect(r.stdout).not.toContain("moboreader_rate_gate_config_invalid");
  });

  it("MOBOREADER_UPSTREAM_MIN_REQUEST_INTERVAL_MS__GETLISTPC=120 -> 在这道判定处 FAIL，退出码 65，早于 git_commit 判定", async () => {
    const envFile = await writePreflightEnvFile({ MOBOREADER_UPSTREAM_MIN_REQUEST_INTERVAL_MS__GETLISTPC: "120" });
    const r = runPreflight(envFile);
    expect(r.status).toBe(65);
    expect(r.stdout).toContain(
      "PREPROD_PREFLIGHT=FAIL reason=moboreader_rate_gate_config_invalid variable=MOBOREADER_UPSTREAM_MIN_REQUEST_INTERVAL_MS__GETLISTPC value=120 reason=below_interval_floor",
    );
  });

  it("MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENABLED=TRUE（大写笔误）-> preflight FAIL，不会静默通过", async () => {
    const envFile = await writePreflightEnvFile({ MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENABLED: "TRUE" });
    const r = runPreflight(envFile);
    expect(r.status).toBe(65);
    expect(r.stdout).toContain("PREPROD_PREFLIGHT=FAIL reason=moboreader_rate_gate_config_invalid variable=MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENABLED");
  });

  it("显式开启且全部合法（E1 首日 1500ms 爬坡值）-> 越过该判定，取证行会出现在最终 PASS 路径上（此处仍稳定停在 git_commit）", async () => {
    const envFile = await writePreflightEnvFile({
      MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENABLED: "true",
      MOBOREADER_UPSTREAM_MIN_REQUEST_INTERVAL_MS__GETLISTPC: "1500",
      MOBOREADER_UPSTREAM_MIN_REQUEST_INTERVAL_MS__GETCODE: "1500",
    });
    const r = runPreflight(envFile);
    expect(r.status).toBe(65);
    expect(r.stdout).toContain("PREPROD_PREFLIGHT=FAIL reason=git_commit");
    expect(r.stdout).not.toContain("moboreader_rate_gate_config_invalid");
  });
});

/**
 * "双跑"防漂移：同一组样例同时喂给 TS 解析器
 * （`resolveMoboreaderPerEndpointRateGateConfig`）和 shell 校验
 * （`preprod_assert_moboreader_rate_gate_config`），断言两边对"是否合法"的
 * 判断一致——做法与 lifecycle 门禁那份双跑测试完全同构（同一个
 * "一条测试防两边漂移"要求）。
 */
describe("TS 解析器 vs shell 校验：数值项判定一致性（防两边漂移）", () => {
  const numericSamples = [
    "", "  ", "50", "1200", "1500", "0", "-1", "-5", "12.5", "abc", "1 2", "008", "3000000", " 1200", "1200 ",
    String(MOBOREADER_PER_ENDPOINT_INTERVAL_FLOOR_MS - 1),
    String(MOBOREADER_PER_ENDPOINT_INTERVAL_FLOOR_MS),
    String(MOBOREADER_PER_ENDPOINT_INTERVAL_FLOOR_MS + 1),
  ];

  const intervalFields = [
    "MOBOREADER_UPSTREAM_MIN_REQUEST_INTERVAL_MS__GETLISTPC",
    "MOBOREADER_UPSTREAM_MIN_REQUEST_INTERVAL_MS__GETCODE",
  ] as const;
  // 只有主机级间隔仍是"非负、允许 0"。
  const nonNegFields = ["MOBOREADER_UPSTREAM_HOST_MIN_GAP_MS"] as const;
  // [Opus fix] 两个地板从"非负"改为"正整数"，与窗口重置上限同组——设计 §5.6
  // "地板必须 ≥ 1"，0 必须拒绝。
  const positiveFields = [
    "MOBOREADER_UPSTREAM_RATE_WINDOW_MAX_WAIT_MS",
    "MOBOREADER_UPSTREAM_REMAINING_FLOOR__GETLISTPC",
    "MOBOREADER_UPSTREAM_REMAINING_FLOOR__GETCODE",
    // 必改1新增。
    "MOBOREADER_UPSTREAM_RETRY_AFTER_ANOMALY_THRESHOLD_MS",
  ] as const;

  function tsAccepts(env: RateGateEnv): boolean {
    const fullEnv: NodeJS.ProcessEnv = { NODE_ENV: "test", ...env };
    try {
      resolveMoboreaderPerEndpointRateGateConfig(fullEnv);
      return true;
    } catch (error) {
      if (error instanceof MoboreaderRateLimitConfigError) return false;
      throw error;
    }
  }

  function shellAccepts(env: RateGateEnv): boolean {
    return runGate(env).status === 0;
  }

  for (const field of intervalFields) {
    for (const sample of numericSamples) {
      it(`${field}=${JSON.stringify(sample)} -> TS 与 shell 判定一致（含 1000ms 下限边界）`, () => {
        const env: RateGateEnv = { [field]: sample } as RateGateEnv;
        expect(shellAccepts(env)).toBe(tsAccepts(env));
      });
    }
  }

  for (const field of [...nonNegFields, ...positiveFields]) {
    for (const sample of numericSamples) {
      it(`${field}=${JSON.stringify(sample)} -> TS 与 shell 判定一致`, () => {
        const env: RateGateEnv = { [field]: sample } as RateGateEnv;
        expect(shellAccepts(env)).toBe(tsAccepts(env));
      });
    }
  }
});

/**
 * 开关判定必须逐值一致，不得靠 trim 制造假一致——同一条纪律、同一组样例
 * 结构，见 lifecycle 门禁双跑测试文件里 2026-09-24 Opus 复核的说明。
 */
describe("TS 解析器 vs shell 校验：开关判定必须逐值一致（不得靠 trim 制造假一致）", () => {
  const enabledSamples = ["true", "false", "", " true", "true ", "TRUE", "1", "yes", "on", "False"];

  function tsEnabledString(raw: string): "true" | "false" {
    return isMoboreaderPerEndpointRateGateEnabled({
      NODE_ENV: "test", MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENABLED: raw,
    } as NodeJS.ProcessEnv) ? "true" : "false";
  }

  for (const sample of enabledSamples) {
    const isExactMatch = sample === "" || sample === "true" || sample === "false";
    it(`MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENABLED=${JSON.stringify(sample)} -> ${isExactMatch ? "shell PASS 且 enabled= 与 TS 一致" : "shell 必须 FAIL"}`, () => {
      const r = runGate({ MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENABLED: sample });
      if (isExactMatch) {
        expect(r.status).toBe(0);
        expect(r.stdout).toContain(`enabled=${tsEnabledString(sample)}`);
      } else {
        expect(r.status).toBe(65);
        expect(r.stdout).toContain("variable=MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENABLED");
      }
    });
  }
});

describe("bash 5 下的行为对照（docker bash:5.2，不可用则跳过）", () => {
  const BASH5_IMAGE = "bash:5.2";
  const bash5Available = spawnSync("docker", ["image", "inspect", BASH5_IMAGE], { encoding: "utf8" }).status === 0;
  const maybeIt = bash5Available ? it : it.skip;

  function runGateBash5(overrides: RateGateEnv) {
    const args = ["run", "--rm", "-v", `${root}:/w`, "-w", "/w"];
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) continue;
      args.push("-e", `${key}=${value}`);
    }
    args.push(
      BASH5_IMAGE,
      "bash",
      "-c",
      "set -euo pipefail; source scripts/preproduction/lib.sh; preprod_assert_moboreader_rate_gate_config",
    );
    return spawnSync("docker", args, { encoding: "utf8" });
  }

  maybeIt("PASS：全部未设置", () => {
    const r = runGateBash5({});
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("PREPROD_MOBOREADER_RATE_GATE_CONFIG=PASS");
  });

  maybeIt("PASS：带前导零 008 不被误判为非法八进制", () => {
    const r = runGateBash5({ MOBOREADER_UPSTREAM_HOST_MIN_GAP_MS: "008" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("hostMinGapMs=8");
  });

  maybeIt("FAIL：开关笔误 TRUE", () => {
    const r = runGateBash5({ MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENABLED: "TRUE" });
    expect(r.status).toBe(65);
    expect(r.stdout).toContain("must_be_true_false_or_unset");
  });

  maybeIt("FAIL：间隔配成 120（低于 1000ms 下限）", () => {
    const r = runGateBash5({ MOBOREADER_UPSTREAM_MIN_REQUEST_INTERVAL_MS__GETCODE: "120" });
    expect(r.status).toBe(65);
    expect(r.stdout).toContain("reason=below_interval_floor");
  });

  maybeIt("FAIL：地板配成 0（必改1修正后，正整数不再允许 0）", () => {
    const r = runGateBash5({ MOBOREADER_UPSTREAM_REMAINING_FLOOR__GETLISTPC: "0" });
    expect(r.status).toBe(65);
    expect(r.stdout).toContain("reason=must_be_positive");
  });
});
