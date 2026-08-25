import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

/**
 * P0-S14：原正则 `/[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/`
 * （即 CJK 统一表意文字、CJK 标点与全角/半角形式）漏了三段——真正的语种
 * 盲点，不是风格问题：
 *
 *   平假名 \u3040-\u309f（ぁ-ゟ）
 *   片假名 \u30a0-\u30ff（゠-ヿ）
 *   谚文（韩文）\uac00-\ud7a3（가-힣，音节区）+ \u1100-\u11ff（ᄀ-ᇿ，字母区）
 *
 * 少了这三段，一段纯假名或纯谚文的占位文案能滑过这条扫描——而它恰恰是
 * 「第二语种上线当天泄漏非 en 文案」这条事故最可能的真实形状（ja/ko 是
 * 站点已登记的 15 语之二）。
 */
const CJK =
  /[\u1100-\u11ff\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3400-\u9fff\uac00-\ud7a3\uff00-\uffef]/;

/**
 * 扫描范围。
 *
 * 🔴 `src/app/dev-preview/**` 刻意排除，不是漏掉——整棵树 noindex/nofollow，
 * 不是公开可索引内容（各 dev-preview `page.tsx` 头部注释都写着
 * `MOCK_ONLY`/`DEV_PREVIEW`），中文占位文案留在那里不构成语种穿透事故。
 * 若 dev-preview 将来对公网开放（目前没有这个计划），必须把它并入扫描。
 *
 * `src/components/ui/**` 刻意排除——那是后台 `(admin)` 专用 UI 原件
 * （唯一调用方是 `channel-accounts-client.tsx`），后台允许中文，不属于本测试
 * 要防的「公开页面语种穿透」范畴。`src/components/` 顶层文件（`Button`、
 * `Container`、`CoverImage`、`MetaList`、`SectionHeader`、`Tag`、`BrandMark`）
 * 是公开 UI 复用的基础组件、被 `public-ui` 直接引用，必须纳入扫描。
 */
const SCAN_ROOTS = [
  "src/app/page.tsx",
  "src/app/layout.tsx",
  "src/app/browse",
  "src/app/novel",
  "src/features/public-ui",
  "src/lib/site/chrome.ts",
  "src/components",
];

/** `src/components/` 里唯一不属于公开面的子树——见上方 SCAN_ROOTS 注释。 */
const EXCLUDED_PREFIXES = ["src/components/ui/"];

function walk(abs: string, acc: string[]): void {
  const stats = statSync(abs);
  if (stats.isDirectory()) {
    for (const entry of readdirSync(abs)) {
      walk(join(abs, entry), acc);
    }
    return;
  }
  if (/\.(ts|tsx)$/.test(abs)) acc.push(abs);
}

function collectFiles(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = join(repoRoot, root);
    try {
      walk(abs, files);
    } catch {
      // optional path
    }
  }
  return files.filter((file) => {
    if (file.endsWith("/fixtures/mock-content.ts")) return false;
    const rel = relative(repoRoot, file);
    return !EXCLUDED_PREFIXES.some((prefix) => rel.startsWith(prefix));
  });
}

/**
 * Strip block comments and line comments without treating `http://` inside
 * strings as comments. Good enough for this scan: remaining CJK after this
 * pass is UI copy, not JSDoc.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let state: "code" | "squote" | "dquote" | "template" | "line" | "block" = "code";

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (state === "line") {
      if (ch === "\n") {
        state = "code";
        out += ch;
      }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") {
        state = "code";
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (state === "squote") {
      out += ch;
      if (ch === "\\") {
        out += source[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === "'") state = "code";
      i += 1;
      continue;
    }
    if (state === "dquote") {
      out += ch;
      if (ch === "\\") {
        out += source[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') state = "code";
      i += 1;
      continue;
    }
    if (state === "template") {
      out += ch;
      if (ch === "\\") {
        out += source[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === "`") state = "code";
      i += 1;
      continue;
    }

    if (ch === "/" && next === "/") {
      state = "line";
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      state = "block";
      i += 2;
      continue;
    }
    if (ch === "'") {
      state = "squote";
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      state = "dquote";
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "`") {
      state = "template";
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

describe("public UI copy has no hardcoded CJK", () => {
  it("scans production public tree + public-ui (comments and mock-content excepted)", () => {
    const hits: string[] = [];

    for (const file of collectFiles()) {
      const source = readFileSync(file, "utf8");
      const code = stripComments(source);
      const lines = code.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (CJK.test(lines[index])) {
          hits.push(`${relative(repoRoot, file)}:${index + 1}: ${lines[index].trim()}`);
        }
      }
    }

    expect(hits, hits.join("\n")).toEqual([]);
  });
});

describe("CJK 正则 · P0-S14 补的三段（平假名/片假名/谚文）", () => {
  it("平假名会命中——旧正则漏掉的第一段", () => {
    expect(CJK.test("これはひらがなです")).toBe(true);
    expect(CJK.test("ぁ")).toBe(true);
    expect(CJK.test("ゟ")).toBe(true);
  });

  it("片假名会命中——旧正则漏掉的第二段", () => {
    expect(CJK.test("カタカナ")).toBe(true);
    expect(CJK.test("゠")).toBe(true);
    expect(CJK.test("ヿ")).toBe(true);
  });

  it("谚文（韩文）音节区与字母区都会命中——旧正则漏掉的第三段", () => {
    expect(CJK.test("이것은 한국어입니다")).toBe(true);
    expect(CJK.test("가")).toBe(true);
    expect(CJK.test("힣")).toBe(true);
    expect(CJK.test("ᄀ")).toBe(true);
    expect(CJK.test("ᇿ")).toBe(true);
  });

  it("旧正则本来就覆盖的三段仍然命中——没有在扩充时退步", () => {
    expect(CJK.test("全部作品")).toBe(true); // CJK 统一表意文字
    expect(CJK.test("、")).toBe(true); // CJK 标点
    expect(CJK.test("ＡＢＣ")).toBe(true); // 全角形式
  });

  it("纯英文与常见西文变体不误命中", () => {
    for (const value of ["Home", "café", "naïve", "Ürün", "Łódź", "Việt"]) {
      expect(CJK.test(value), `${value} 不该被判定成 CJK`).toBe(false);
    }
  });
});

describe("SCAN_ROOTS · P0-S14 纳入 src/components 顶层、排除 src/components/ui", () => {
  it("scan 结果里出现了 src/components 顶层文件，且没有 src/components/ui 下的文件", () => {
    const files = collectFiles().map((file) => relative(repoRoot, file));
    expect(files.some((file) => file === "src/components/Button.tsx")).toBe(true);
    expect(files.some((file) => file.startsWith("src/components/ui/"))).toBe(false);
  });
});
