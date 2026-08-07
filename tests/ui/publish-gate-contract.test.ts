import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, expectTypeOf, it } from "vitest";

import { ARTICLE_STATUSES, PREVIEW_MATERIALIZATION_POLICIES } from "@/domain/database-statuses";
import * as publishGate from "@/contracts/publish-gate";
import {
  buildPublishGateResult,
  CHANGDU_PREVIEW_CHAPTER_CAP,
  CHANGDU_PREVIEW_POLICY,
  DEFAULT_PUBLISH_INTENT,
  narrowPublishGateReason,
  narrowPublishIntent,
  PAID_FROM_CHAPTER_POLICY,
  PUBLISH_GATE_REASONS,
  PUBLISH_INTENTS,
  resolveChangduPreviewChapterCount,
} from "@/contracts/publish-gate";
import type { PublishGateReason, PublishGateResult } from "@/contracts/publish-gate";

/**
 * P2-01 发布门禁共享契约的验收测试。
 *
 * 权威依据：Owner P2-01 冻结口径（十三条决策）与
 * `docs/p2/P2_01_PUBLISH_GATE_CONTRACT.md`。
 *
 * 放在 `tests/ui` 而不是 `tests/backend`：`src/contracts/` 的 merge custodian
 * 是 Claude（见 `src/contracts/README.md`），而 `tests/ui` 是 Claude 独占目录、
 * 对应 vitest `ui` project（`tests/ui/**\/*.test.{ts,tsx}`）；契约文件本身零运行时
 * 依赖（仅 `import type` + 唯一放行的 `@/domain/database-statuses` 值引用），
 * 不需要 `tests/backend` 的 node project 环境。
 */

const CONTRACT_PATH = "src/contracts/publish-gate.ts";

/**
 * 剥离字符串/模板字面量与注释后再扫描。
 *
 * 单遍状态机而非两遍正则：早期实现先跑「剥字符串」再跑「剥注释」的正则组合，
 * 对 `"see // pending"` 这种字符串里带 `//` 的字面量会失手——正则不认字符串边界，
 * 会把 `//` 误判成真实行注释的起点，从该处一路吞到行尾，把字符串之后**同一行的
 * 真实代码**也一起吃掉，反而让被吞的禁用词永远进不了扫描结果（假阴性）。
 * 单遍扫描按字符前进、显式维护「代码 / 行注释 / 块注释 / 字符串 / 模板字面量」
 * 五态，字符串状态里的 `//`、`/*` 只是普通字符，注释状态里的引号也只是普通字符，
 * 两者不会互相误判，字面量与注释的内容都被清空，只留下真实可执行的代码结构。
 */
function stripComments(source: string): string {
  type ScanState =
    | "code"
    | "line-comment"
    | "block-comment"
    | "single-quote"
    | "double-quote"
    | "template";

  let output = "";
  let state: ScanState = "code";

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (state === "line-comment") {
      if (ch === "\n") {
        state = "code";
        output += ch;
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
        i++; // 跳过被转义的下一字符，避免它提前结束字面量
        continue;
      }
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
      continue;
    }
    if (ch === '"') {
      state = "double-quote";
      continue;
    }
    if (ch === "`") {
      state = "template";
      continue;
    }
    output += ch;
  }

  return output;
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
      source: stripComments(await readFile(path.join(root, entry.name), "utf8")),
    })),
  );
}

describe("stripComments 自检：字符串里的 // 不能吞掉后面的真实代码", () => {
  it("字面量里的 // 不会把同一行后续的真实标识符一并吃掉", () => {
    const sample = 'const NOTE = "see // pending offline allEpis"; const REAL_MARKER = "pending";';
    const stripped = stripComments(sample);
    // 两个字符串的内容都被当作字面量清空——不是被误判的行注释吞掉，
    // 而是扫描器对字符串内容本就不透出；`const NOTE =` / `const REAL_MARKER =`
    // 这些真实代码结构必须原样保留。
    expect(stripped).toContain("const NOTE =");
    expect(stripped).toContain("const REAL_MARKER =");
  });

  it("真正的行注释仍然被剥离", () => {
    const stripped = stripComments("const x = 1; // pending\nconst y = 2;");
    expect(stripped).not.toContain("pending");
    expect(stripped).toContain("const y = 2;");
  });
});

describe("🔴 生命周期不复制第二套", () => {
  it("PUBLISH_INTENTS 恰好是 draft/now/scheduled", () => {
    expect([...PUBLISH_INTENTS]).toEqual(["draft", "now", "scheduled"]);
  });

  it("剥注释后的源码里没有 pending / offline", async () => {
    const stripped = stripComments(await readContractSource(CONTRACT_PATH));
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

describe("🔴 无 Admission 四态 / 无 Manual Exception", () => {
  it("src/contracts/ 下所有文件剥注释后都没有 admission / manual exception / override / waiver / allowlist", async () => {
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

  it("模块导出名不含 admission/exception；导出值命中时只能是 blocking_exception 字面值本身", () => {
    for (const [name, value] of Object.entries(publishGate)) {
      expect(name, `导出名 ${name} 不得含 admission/exception`).not.toMatch(/admission|exception/i);
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string" && /admission|exception/i.test(item)) {
            expect(item, `${name} 里命中 admission/exception 的值必须是 blocking_exception`).toBe(
              "blocking_exception",
            );
          }
        }
      }
    }
  });
});

describe("🔴 Hard Gate", () => {
  it("🔴 PUBLISH_GATE_REASONS 精确等于冻结注册表（防新增/删除/改序）", () => {
    expect([...PUBLISH_GATE_REASONS]).toEqual([
      "locale_not_publishable",
      "required_metadata_missing",
      "preview_unavailable",
      "promo_link_missing",
      "public_redirect_code_missing",
      "page_identity_conflict",
      "rights_blocked",
      "blocking_exception",
    ]);
  });

  it("PUBLISH_GATE_REASONS 数组本身是冻结的", () => {
    expect(Object.isFrozen(PUBLISH_GATE_REASONS)).toBe(true);
  });

  it("promo_link_missing 与 public_redirect_code_missing 都在注册表里", () => {
    expect(PUBLISH_GATE_REASONS).toContain("promo_link_missing");
    expect(PUBLISH_GATE_REASONS).toContain("public_redirect_code_missing");
  });

  it("promo_link_missing 单独出现即拒绝发布", () => {
    const result = buildPublishGateResult(["promo_link_missing"]);
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

  it("剥注释后的契约源码没有 splitRatio/split_ratio/sourceLabel/source_label/jwt/secret", async () => {
    const stripped = stripComments(await readContractSource(CONTRACT_PATH));
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

describe("Gate 行为", () => {
  it("空输入 → 可发布、无理由", () => {
    const result = buildPublishGateResult([]);
    expect(result.publishable).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("多理由保留、去重、按注册表顺序输出", () => {
    const result = buildPublishGateResult([
      "page_identity_conflict",
      "locale_not_publishable",
      "locale_not_publishable",
    ]);
    expect(result.reasons).toEqual(["locale_not_publishable", "page_identity_conflict"]);
    expect(result.publishable).toBe(false);
  });

  it("未登记的理由不会被丢弃，收敛为 blocking_exception（fail-closed）", () => {
    const result = buildPublishGateResult(["totally_bogus"]);
    expect(result.reasons).toEqual(["blocking_exception"]);
    expect(result.publishable).toBe(false);
  });

  it("🔴 非数组输入同样 fail-closed，不抛异常", () => {
    for (const bogus of [null, undefined, "promo_link_missing", 42, { length: 1 }] as unknown[]) {
      const result = buildPublishGateResult(bogus as readonly unknown[]);
      expect(result).toEqual({ publishable: false, reasons: ["blocking_exception"] });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.reasons)).toBe(true);
    }
  });

  it("结果对象与 reasons 数组都是冻结的", () => {
    const result = buildPublishGateResult(["rights_blocked"]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.reasons)).toBe(true);
  });

  it("结果没有自由文本字段：只有 publishable 和 reasons 两个键", () => {
    const result = buildPublishGateResult(["rights_blocked"]);
    expect(Object.keys(result).sort()).toEqual(["publishable", "reasons"]);
  });

  it("🔴 PublishGateResult 类型形状精确——运行时键检查挡不住新增可选字段，靠类型层再钉一遍", () => {
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

describe("🔴 Changdu 试读上限", () => {
  it("上限恒为 3", () => {
    expect(CHANGDU_PREVIEW_CHAPTER_CAP).toBe(3);
  });

  it("物化策略与 database-statuses 的值导入同源（value-import parity）", () => {
    expect(CHANGDU_PREVIEW_POLICY.materializationPolicy).toBe(PREVIEW_MATERIALIZATION_POLICIES[0]);
    expect(CHANGDU_PREVIEW_POLICY.materializationPolicy).toBe("upstream_returned_preview");
  });

  it("CHANGDU_PREVIEW_POLICY 是冻结的", () => {
    expect(Object.isFrozen(CHANGDU_PREVIEW_POLICY)).toBe(true);
  });

  it.each([
    [1, 1],
    [2, 2],
    [3, 3],
    [10, 3],
    [0, 0],
    [-1, 0],
    [2.5, 0],
    [3.0, 3],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    [Number.NEGATIVE_INFINITY, 0],
    [-0, 0],
    [true, 0],
    ["3", 0],
    [null, 0],
    [undefined, 0],
  ])("resolveChangduPreviewChapterCount(%p) → %p", (input, expected) => {
    expect(resolveChangduPreviewChapterCount(input)).toBe(expected);
  });

  it("🔴 -0 输入被归一化为 +0（Object.is 精确比对，toBe 的宽松打印容易掩盖符号位）", () => {
    expect(Object.is(resolveChangduPreviewChapterCount(-0), 0)).toBe(true);
    expect(Object.is(resolveChangduPreviewChapterCount(-0), -0)).toBe(false);
  });

  it("单一入参：Function.length 为 1", () => {
    expect(resolveChangduPreviewChapterCount.length).toBe(1);
  });
});

describe("🔴 allEpis 不是物化输入", () => {
  it("剥注释后的契约源码没有 allEpis", async () => {
    const stripped = stripComments(await readContractSource(CONTRACT_PATH));
    expect(stripped).not.toContain("allEpis");
  });

  it("CHANGDU_PREVIEW_POLICY 只有 materializationPolicy 与 maxChapters 两个键", () => {
    expect(Object.keys(CHANGDU_PREVIEW_POLICY).sort()).toEqual(["materializationPolicy", "maxChapters"]);
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
