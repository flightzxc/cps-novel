import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, expectTypeOf, it } from "vitest";

import { ARTICLE_STATUSES } from "@/domain/database-statuses";
import * as publishGate from "@/contracts/publish-gate";
import {
  createPublishGateResult,
  DEFAULT_PUBLISH_INTENT,
  narrowPublishGateReason,
  narrowPublishIntent,
  PAID_FROM_CHAPTER_POLICY,
  PUBLISH_GATE_REASONS,
  PUBLISH_INTENTS,
  PUBLISH_REQUIRED_METADATA_FIELDS,
} from "@/contracts/publish-gate";
import type {
  PublishGateReason,
  PublishGateResult,
  PublishRequiredMetadataField,
  RequiredMetadataMissingDetail,
} from "@/contracts/publish-gate";

/**
 * P2-01 发布门禁共享契约的验收测试。
 *
 * 权威依据：`docs/p2/P2_01_PUBLISH_GATE_CONTRACT.md`，包括其中记录最新一轮
 * Owner supersession 决策的「Owner supersession（最高权威）」一节。P1 阶段的
 * 十三条决策仍是背景基础，但试读物化上限、promo 理由码、DTO/evaluator 边界的
 * 具体口径以 supersession 为准——本文件按 supersession 之后的形状测试，
 * 不还原被取代的旧四态准入候选或旧动态全量物化口径。
 *
 * 放在 `tests/ui` 而不是 `tests/backend`：`src/contracts/` 的 merge custodian
 * 是 Claude（见 `src/contracts/README.md`），而 `tests/ui` 是 Claude 独占目录、
 * 对应 vitest `ui` project（`tests/ui/**\/*.test.{ts,tsx}`）；契约文件本身零运行时
 * 依赖（本轮甚至没有任何值导入），不需要 `tests/backend` 的 node project 环境。
 */

const CONTRACT_PATH = "src/contracts/publish-gate.ts";

/**
 * 单遍状态机扫描源码，同时产出两种互补变体：
 *
 * - `codeOnly`：注释与字符串/模板字面量内容都被清空，只剩真实代码结构——
 *   适合验证"剥离字面量不会把同一行后续的真实代码一并吃掉"这类结构性断言。
 * - `valueVisible`：只剥注释，字符串/模板字面量内容原样保留——适合"禁用词/
 *   禁用值不能出现在源码里"这类扫描。
 *
 * 为什么必须有 `valueVisible`：早期实现只产出类似 `codeOnly` 的单一变体，
 * 字符串内容被无差别清空，结果对"藏在字符串字面量里的禁用值"完全失明——
 * 例如 `export const NOVEL_LIFECYCLE = ["draft","pending","live","offline"]`
 * 或 `export const NOTE2 = "splitRatio"` 这类导出，`pending`/`offline`/
 * `splitRatio` 是货真价实的运行时字符串值、会被打包进产物，但旧的单变体扫描
 * 会把它们当成字符串内容一并清空，导致"剥注释后源码没有 pending/offline"
 * 之类的断言对这种变异视而不见（mutation-proven gap）。`valueVisible` 只剥
 * 注释、不动字符串内容，堵住这个盲区。
 *
 * 为什么还要保留 `codeOnly`：更早的问题是两遍独立正则（先剥字符串再剥注释）
 * 对 `"see // pending"` 这种字符串里带 `//` 的字面量会失手——正则不认字符串
 * 边界，会把 `//` 误判成真实行注释的起点，从该处一路吞到行尾，把字符串之后
 * **同一行的真实代码**也一起吃掉。单遍状态机按字符前进、显式维护「代码 / 行
 * 注释 / 块注释 / 单引号字符串 / 双引号字符串 / 模板字面量」六态，字符串状态
 * 里的 `//`、`/*` 只是普通字符，注释状态里的引号也只是普通字符，两者不会
 * 互相误判；`codeOnly` 变体证明了这一点——同一行后续的真实标识符原样保留。
 */
function stripSource(source: string): { codeOnly: string; valueVisible: string } {
  type ScanState =
    | "code"
    | "line-comment"
    | "block-comment"
    | "single-quote"
    | "double-quote"
    | "template";

  let codeOnly = "";
  let valueVisible = "";
  let state: ScanState = "code";

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (state === "line-comment") {
      if (ch === "\n") {
        state = "code";
        codeOnly += ch;
        valueVisible += ch;
      }
      continue;
    }

    if (state === "block-comment") {
      if (ch === "*" && next === "/") {
        state = "code";
        i++;
      }
      continue;
    }

    if (state === "single-quote" || state === "double-quote" || state === "template") {
      const quote = state === "single-quote" ? "'" : state === "double-quote" ? '"' : "`";
      if (ch === "\\") {
        // 转义字符与被转义的下一字符对 valueVisible 原样保留（字面量内容不失真）；
        // codeOnly 里字符串内容整体清空，两者都不需要特殊处理转义字符。
        valueVisible += ch;
        if (next !== undefined) valueVisible += next;
        i++;
        continue;
      }
      valueVisible += ch;
      if (ch === quote) {
        state = "code";
      }
      continue;
    }

    // state === "code"
    if (ch === "/" && next === "/") {
      state = "line-comment";
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      state = "block-comment";
      i++;
      continue;
    }
    if (ch === "'") {
      state = "single-quote";
      valueVisible += ch;
      continue;
    }
    if (ch === '"') {
      state = "double-quote";
      valueVisible += ch;
      continue;
    }
    if (ch === "`") {
      state = "template";
      valueVisible += ch;
      continue;
    }
    codeOnly += ch;
    valueVisible += ch;
  }

  return { codeOnly, valueVisible };
}

/** 只取 valueVisible 变体：本文件绝大多数扫描都是"禁用值不能出现"，需要看见字符串内容。 */
function stripToValueVisible(source: string): string {
  return stripSource(source).valueVisible;
}

async function readContractSource(relativePath: string): Promise<string> {
  return readFile(path.resolve(process.cwd(), relativePath), "utf8");
}

async function contractDirSources(): Promise<{ file: string; source: string }[]> {
  const root = path.resolve(process.cwd(), "src/contracts");
  const entries = await readdir(root, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name));
  return Promise.all(
    files.map(async (entry) => ({
      file: `src/contracts/${entry.name}`,
      // valueVisible：admission/manual exception/override/waiver/allowlist 若被藏进
      // 字符串字面量同样要抓到，不能只查裸标识符。
      source: stripToValueVisible(await readFile(path.join(root, entry.name), "utf8")),
    })),
  );
}

describe("stripSource 自检：两种变体互补，禁用值藏不进字符串字面量", () => {
  const smuggleSample =
    'const NOTE = "see // pending offline allEpis"; const REAL_MARKER = "pending";';

  it("codeOnly 变体：字符串内容被清空，同一行后续的真实标识符原样保留", () => {
    const { codeOnly } = stripSource(smuggleSample);
    expect(codeOnly).toContain("const NOTE =");
    expect(codeOnly).toContain("const REAL_MARKER =");
    // codeOnly 对字符串内容是瞎的——这正是需要 valueVisible 变体的原因。
    expect(codeOnly).not.toContain("pending");
    expect(codeOnly).not.toContain("offline");
    expect(codeOnly).not.toContain("allEpis");
  });

  it("valueVisible 变体：字符串内容原样保留，禁用值无处可藏", () => {
    const { valueVisible } = stripSource(smuggleSample);
    expect(valueVisible).toContain("pending");
    expect(valueVisible).toContain("offline");
    expect(valueVisible).toContain("allEpis");
    // 字符串内部的 // 不会被当成注释起点——两个 const 声明都完整保留。
    expect(valueVisible).toContain("const NOTE =");
    expect(valueVisible).toContain("const REAL_MARKER =");
  });

  it("两种变体都正确剥离真正的行注释与块注释", () => {
    const lineSample = "const x = 1; // pending\nconst y = 2;";
    const blockSample = "const x = 1; /* pending */ const y = 2;";
    for (const sample of [lineSample, blockSample]) {
      const { codeOnly, valueVisible } = stripSource(sample);
      for (const stripped of [codeOnly, valueVisible]) {
        expect(stripped).not.toContain("pending");
        expect(stripped).toContain("const y = 2;");
      }
    }
  });

  it("🔴 回归证据：NOVEL_LIFECYCLE 式字符串数组导出，valueVisible 抓到 pending/offline", () => {
    const sample = 'export const NOVEL_LIFECYCLE = ["draft","pending","live","offline"];';
    const { codeOnly, valueVisible } = stripSource(sample);
    // codeOnly 单独看会漏掉——字符串内容被清空；这正是本轮修的 mutation-proven gap。
    expect(codeOnly).not.toContain("pending");
    expect(valueVisible).toContain("pending");
    expect(valueVisible).toContain("offline");
  });

  it("🔴 回归证据：藏进字符串字面量的 splitRatio，valueVisible 抓到", () => {
    const sample = 'export const NOTE2 = "splitRatio";';
    const { codeOnly, valueVisible } = stripSource(sample);
    expect(codeOnly).not.toContain("splitRatio");
    expect(valueVisible).toContain("splitRatio");
  });
});

describe("🔴 生命周期不复制第二套", () => {
  it("PUBLISH_INTENTS 恰好是 draft/now/scheduled", () => {
    expect([...PUBLISH_INTENTS]).toEqual(["draft", "now", "scheduled"]);
  });

  it("剥注释后的源码里没有 pending / offline（valueVisible：字符串里的值也要抓到）", async () => {
    const stripped = stripToValueVisible(await readContractSource(CONTRACT_PATH));
    expect(stripped).not.toContain("pending");
    expect(stripped).not.toContain("offline");
  });

  it("契约模块不会为 ARTICLE_STATUSES 建第二份同值数组", () => {
    const forbidden = [...ARTICLE_STATUSES];
    for (const [name, value] of Object.entries(publishGate)) {
      if (Array.isArray(value)) {
        expect([...value], `导出 ${name} 不得与 ARTICLE_STATUSES 相同`).not.toEqual(forbidden);
      }
    }
  });

  it("🔴 任何导出数组都不得混入 published/unpublished/takedown 字面值——防止改序或部分复制", () => {
    // 只比对整份数组相等挡不住"打乱顺序"或"只抄一部分"的第二套生命周期；
    // 逐元素比对 ARTICLE_STATUSES 里 draft 以外的三个值，覆盖这两种变体。
    // draft 单独出现是合法的（PUBLISH_INTENTS 本身就含 draft）。
    const guardedTerms = ARTICLE_STATUSES.filter((status) => status !== "draft");
    for (const [name, value] of Object.entries(publishGate)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (typeof item !== "string") continue;
        expect(
          guardedTerms as readonly string[],
          `导出 ${name} 里的 "${item}" 疑似复制自 ARTICLE_STATUSES`,
        ).not.toContain(item);
      }
    }
  });
});

describe("🔴 模块导出面精确锁定", () => {
  it("🔴 Object.keys(publishGate) 精确等于冻结的导出名集合——防止复活 cap 常量或新增游离导出", () => {
    // mutation-proven：曾经 `export const PREVIEW_MAX_MATERIALIZED_CHAPTERS = 3;`
    // 这样一个新增导出不会被任何既有断言拦下。按导出名整体锁定是最强的防线。
    expect(Object.keys(publishGate).sort()).toEqual([
      "DEFAULT_PUBLISH_INTENT",
      "PAID_FROM_CHAPTER_POLICY",
      "PUBLISH_GATE_REASONS",
      "PUBLISH_INTENTS",
      "PUBLISH_REQUIRED_METADATA_FIELDS",
      "createPublishGateResult",
      "narrowPublishGateReason",
      "narrowPublishIntent",
    ]);
  });
});

describe("🔴 无 Admission 四态 / 无 Manual Exception", () => {
  it("src/contracts/ 下所有文件（valueVisible）都没有 admission / manual exception / override / waiver / allowlist", async () => {
    const files = await contractDirSources();
    expect(files.length).toBeGreaterThan(0);
    for (const { file, source } of files) {
      expect(source, `${file} 不得出现 admission`).not.toMatch(/admission/i);
      expect(source, `${file} 不得出现 manual exception`).not.toMatch(/manual[_-]?exception/i);
      expect(source, `${file} 不得出现 override/waiver/allowlist`).not.toMatch(
        /\boverride\b|\bwaiver\b|allowlist/i,
      );
    }
  });

  it("模块导出名不含 admission/exception；导出值命中时只能是 blocking_sync_exception 字面值本身", () => {
    for (const [name, value] of Object.entries(publishGate)) {
      expect(name, `导出名 ${name} 不得含 admission/exception`).not.toMatch(/admission|exception/i);
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string" && /admission|exception/i.test(item)) {
            expect(item, `${name} 里命中 admission/exception 的值必须是 blocking_sync_exception`).toBe(
              "blocking_sync_exception",
            );
          }
        }
      }
    }
  });
});

describe("🔴 Hard Gate（PromoLink）", () => {
  it("🔴 PUBLISH_GATE_REASONS 精确等于 supersession 后的十元素冻结注册表（防新增/删除/改序）", () => {
    expect([...PUBLISH_GATE_REASONS]).toEqual([
      "locale_not_publishable",
      "required_metadata_missing",
      "preview_chapter_missing",
      "preview_body_missing",
      "promo_link_missing",
      "promo_link_not_ready",
      "promo_url_invalid",
      "page_identity_conflict",
      "rights_blocked",
      "blocking_sync_exception",
    ]);
  });

  it("PUBLISH_GATE_REASONS 数组本身是冻结的", () => {
    expect(Object.isFrozen(PUBLISH_GATE_REASONS)).toBe(true);
  });

  it("🔴 public_redirect_code_missing 已被移除——该码在业务层不可达，由 DB NOT NULL + UNIQUE 保证", () => {
    expect(PUBLISH_GATE_REASONS).not.toContain("public_redirect_code_missing");
  });

  it("promo_link_missing / promo_link_not_ready / promo_url_invalid 三项都在注册表里", () => {
    expect(PUBLISH_GATE_REASONS).toContain("promo_link_missing");
    expect(PUBLISH_GATE_REASONS).toContain("promo_link_not_ready");
    expect(PUBLISH_GATE_REASONS).toContain("promo_url_invalid");
  });

  it("promo_link_missing 单独出现即拒绝发布", () => {
    const result = createPublishGateResult(["promo_link_missing"]);
    expect(result).toEqual({ publishable: false, reasons: ["promo_link_missing"] });
  });
});

describe("🔴 分成比例/来源标签不进 gate", () => {
  it("PUBLISH_GATE_REASONS 没有任何元素包含 split / label / pay", () => {
    for (const reason of PUBLISH_GATE_REASONS) {
      expect(reason).not.toMatch(/split/i);
      expect(reason).not.toMatch(/label/i);
      expect(reason).not.toMatch(/pay/i);
    }
  });

  it("剥注释后的契约源码（valueVisible）没有 splitRatio/split_ratio/sourceLabel/source_label/jwt/secret", async () => {
    const stripped = stripToValueVisible(await readContractSource(CONTRACT_PATH));
    for (const forbidden of [
      "splitRatio",
      "split_ratio",
      "sourceLabel",
      "source_label",
      "jwt",
      "secret",
    ]) {
      expect(stripped).not.toContain(forbidden);
    }
  });
});

describe("🔴 试读物化规则移出通用 Gate 模块（cap 落在 P2-05 的 NovelPreviewPolicy）", () => {
  it("模块导出不含任何 /^CHANGDU/ 或 /^PREVIEW_MAX/ 前缀的键——试读上限不再是通用 Gate 常量", () => {
    for (const name of Object.keys(publishGate)) {
      expect(name, `导出 ${name} 不应以 CHANGDU 开头`).not.toMatch(/^CHANGDU/);
      expect(name, `导出 ${name} 不应以 PREVIEW_MAX 开头`).not.toMatch(/^PREVIEW_MAX/i);
    }
  });

  it("resolveChangduPreviewChapterCount 不再导出", () => {
    expect((publishGate as Record<string, unknown>).resolveChangduPreviewChapterCount).toBeUndefined();
  });

  it("剥注释后的契约源码（valueVisible）没有 allEpis——即使物化细节已移出，通用层依然不得编码总数补章逻辑", async () => {
    const stripped = stripToValueVisible(await readContractSource(CONTRACT_PATH));
    expect(stripped).not.toContain("allEpis");
  });
});

describe("createPublishGateResult 行为（DTO 归一，不是 evaluator）", () => {
  it("buildPublishGateResult 旧名已不再导出，只有 createPublishGateResult", () => {
    expect(typeof createPublishGateResult).toBe("function");
    expect((publishGate as Record<string, unknown>).buildPublishGateResult).toBeUndefined();
  });

  it("空输入 → 可发布、无理由", () => {
    const result = createPublishGateResult([]);
    expect(result.publishable).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("多理由保留、去重、按注册表顺序输出", () => {
    const result = createPublishGateResult([
      "page_identity_conflict",
      "locale_not_publishable",
      "locale_not_publishable",
    ]);
    expect(result.reasons).toEqual(["locale_not_publishable", "page_identity_conflict"]);
    expect(result.publishable).toBe(false);
  });

  it("未登记的理由不会被丢弃，收敛为 blocking_sync_exception（fail-closed）", () => {
    const result = createPublishGateResult(["totally_bogus"]);
    expect(result.reasons).toEqual(["blocking_sync_exception"]);
    expect(result.publishable).toBe(false);
  });

  it("🔴 非数组输入同样 fail-closed，不抛异常", () => {
    for (const bogus of [null, undefined, "promo_link_missing", 42, { length: 1 }] as unknown[]) {
      const result = createPublishGateResult(bogus as readonly unknown[]);
      expect(result).toEqual({ publishable: false, reasons: ["blocking_sync_exception"] });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.reasons)).toBe(true);
    }
  });

  it("结果对象与 reasons 数组都是冻结的", () => {
    const result = createPublishGateResult(["rights_blocked"]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.reasons)).toBe(true);
  });

  it("结果没有自由文本字段：只有 publishable 和 reasons 两个键", () => {
    const result = createPublishGateResult(["rights_blocked"]);
    expect(Object.keys(result).sort()).toEqual(["publishable", "reasons"]);
  });

  it("🔴 PublishGateResult 类型形状精确——运行时键检查挡不住新增可选字段，靠类型层再钉一遍（此断言在 vitest run 下编译期擦除，把关能力来自 npm run typecheck）", () => {
    expectTypeOf<PublishGateResult>().toEqualTypeOf<{
      readonly publishable: boolean;
      readonly reasons: readonly PublishGateReason[];
    }>();
  });

  it("narrowPublishGateReason 只认登记过的字面值，逐字精确", () => {
    expect(narrowPublishGateReason("promo_link_missing")).toBe("promo_link_missing");
    expect(narrowPublishGateReason("PROMO_LINK_MISSING")).toBeNull();
    expect(narrowPublishGateReason(null)).toBeNull();
    expect(narrowPublishGateReason(1)).toBeNull();
  });

  it("🔴 空 reasons 不证明所有 Gate 已执行——这是 DTO 归一，不是 evaluator", () => {
    // 回归性断言：createPublishGateResult 不做任何隐式检查，传什么候选理由就
    // 归一什么；空输入等于"这次调用没给失败理由"，不等于"locale/metadata/
    // preview/promo/身份/权利检查全部已经跑过"。DTO 形状上也没有第三个字段
    // 能携带"检查已执行"这类证明。
    const result = createPublishGateResult([]);
    expect(result.publishable).toBe(true);
    expect(Object.keys(result)).toEqual(["publishable", "reasons"]);
  });
});

describe("PublishIntent 行为", () => {
  it("三个合法值都能被识别", () => {
    for (const intent of PUBLISH_INTENTS) {
      expect(narrowPublishIntent(intent)).toBe(intent);
    }
  });

  it("未登记值收敛为 null", () => {
    for (const value of ["DRAFT", "publish", "", null, undefined, 2]) {
      expect(narrowPublishIntent(value)).toBeNull();
    }
  });

  it("默认发布意图是 draft", () => {
    expect(DEFAULT_PUBLISH_INTENT).toBe("draft");
  });

  it("PUBLISH_INTENTS 是冻结的", () => {
    expect(Object.isFrozen(PUBLISH_INTENTS)).toBe(true);
  });
});

describe("required_metadata_missing 详情 DTO 形状", () => {
  it("PUBLISH_REQUIRED_METADATA_FIELDS 精确等于 [title, slug, body]，且冻结", () => {
    expect([...PUBLISH_REQUIRED_METADATA_FIELDS]).toEqual(["title", "slug", "body"]);
    expect(Object.isFrozen(PUBLISH_REQUIRED_METADATA_FIELDS)).toBe(true);
  });

  it("RequiredMetadataMissingDetail 类型形状精确（此断言在 vitest run 下编译期擦除，把关能力来自 npm run typecheck）", () => {
    expectTypeOf<RequiredMetadataMissingDetail>().toEqualTypeOf<{
      readonly reason: "required_metadata_missing";
      readonly missingFields: readonly PublishRequiredMetadataField[];
    }>();
  });

  it("RequiredMetadataMissingDetail 不是 PublishGateResult 的一部分——后者形状恒为两个字段", () => {
    const result = createPublishGateResult(["required_metadata_missing"]);
    expect(Object.keys(result).sort()).toEqual(["publishable", "reasons"]);
  });
});

describe("paid_from_chapter 政策", () => {
  it("只存来源值，四个自动动作全部关闭", () => {
    expect(PAID_FROM_CHAPTER_POLICY.storedAsSourceValue).toBe(true);
    expect(PAID_FROM_CHAPTER_POLICY.autoWithdrawOnChange).toBe(false);
    expect(PAID_FROM_CHAPTER_POLICY.autoDeleteContentOnChange).toBe(false);
    expect(PAID_FROM_CHAPTER_POLICY.autoSeoRecomputeOnChange).toBe(false);
    expect(PAID_FROM_CHAPTER_POLICY.autoIndexNowOnChange).toBe(false);
  });

  it("PAID_FROM_CHAPTER_POLICY 是冻结的", () => {
    expect(Object.isFrozen(PAID_FROM_CHAPTER_POLICY)).toBe(true);
  });
});
