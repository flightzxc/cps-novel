import "./setup-cleanup";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { projectAdminSourceLabel } from "@/contracts";
import { LABEL_KINDS, type LabelKind } from "@/domain/database-statuses";
import { LABEL_KIND_BADGES } from "@/features/admin-ui/content-view";
import { TagFilters } from "@/app/(admin)/tags/_components/tag-filters";
import { TagsTable } from "@/app/(admin)/tags/_components/tags-table";

import { sourceLabelListItem } from "./fixtures/admin-content";

/**
 * P2-06 `/tags` 只读标签字典的渲染验收。
 *
 * 组织方式照抄 `admin-novels-list.test.tsx`：driving 组件用真实
 * `projectAdminSourceLabel` 把 kernel 形状的 fixture 投影成 view，而不是手写
 * view fixture——这样投影一旦开始外泄字段，这里就会直接失败。
 */

const LABEL_ROMANCE = sourceLabelListItem();
const LABEL_RECOMMEND = sourceLabelListItem({
  labelId: "24040000-0000-4000-8000-000000000034",
  labelKind: "recommend",
  externalLabelValue: "hot_pick",
  displayValue: "热门推荐",
  novelCount: 5,
});
/** 没有展示名的一行——本文件反补偿断言的主角。 */
const LABEL_LANGUAGE_NO_DISPLAY = sourceLabelListItem({
  labelId: "24040000-0000-4000-8000-000000000035",
  labelKind: "language",
  externalLabelValue: "en",
  displayValue: null,
  novelCount: 0,
});
const LABEL_AGENCY = sourceLabelListItem({
  labelId: "24040000-0000-4000-8000-000000000036",
  labelKind: "agency",
  externalLabelValue: "moboreader",
  displayValue: "摩宝阅读",
  novelCount: 30,
});
/** 大小写、下划线、连字符混杂的原值，用来验证渲染不会做任何归一化。 */
const LABEL_WEIRD_RAW_VALUE = sourceLabelListItem({
  labelId: "24040000-0000-4000-8000-000000000037",
  labelKind: "series_type",
  externalLabelValue: "Weird_MiXed-Value_2026",
  displayValue: "怪异值",
  novelCount: 1,
});

const LABELS = [
  LABEL_ROMANCE,
  LABEL_RECOMMEND,
  LABEL_LANGUAGE_NO_DISPLAY,
  LABEL_AGENCY,
  LABEL_WEIRD_RAW_VALUE,
].map(projectAdminSourceLabel);

function rowFor(container: HTMLElement, labelId: string): HTMLTableRowElement {
  const link = container.querySelector(`[data-testid="view-linked-novels-${labelId}"]`);
  const row = link?.closest("tr");
  if (!row) throw new Error(`未找到 labelId=${labelId} 对应的表格行`);
  return row as HTMLTableRowElement;
}

describe("P2-06 标签字典表 · 严格只读", () => {
  /**
   * 断言落在**可交互元素**上，而不是扫描全文——照
   * `admin-novels-list.test.tsx`「每行只提供查看入口，不提供任何写操作控件」
   * 的写法。这张表连勾选列都没有：P2-06 是纯读向 slice，没有批量操作可言。
   */
  it("表格区域内没有 button / input / form，每行只有一个查看关联小说的链接", () => {
    const { container } = render(<TagsTable labels={LABELS} activity="current" />);

    expect(container.querySelectorAll("button").length).toBe(0);
    expect(container.querySelectorAll("input").length).toBe(0);
    expect(container.querySelectorAll("form").length).toBe(0);

    const links = Array.from(container.querySelectorAll("a"));
    expect(links.length).toBe(LABELS.length);
    for (const link of links) {
      expect(link.textContent).toBe("查看关联小说");
      expect(link.getAttribute("href")).toMatch(/^\/novels\?labelId=[0-9a-f-]+$/);
    }
  });

  it("标签原值原样渲染，不做任何大小写/分隔符归一化", () => {
    render(<TagsTable labels={LABELS} activity="current" />);
    expect(screen.getByText("romance")).toBeTruthy();
    expect(screen.getByText("hot_pick")).toBeTruthy();
    expect(screen.getByText("moboreader")).toBeTruthy();
    // 大小写与连字符/下划线混杂，必须原样出现——不是 "weird-mixed-value-2026"
    // 也不是 "Weird Mixed Value 2026"。
    expect(screen.getByText("Weird_MiXed-Value_2026")).toBeTruthy();
  });
});

describe("P2-06 标签字典表 · 反补偿断言", () => {
  /**
   * 🔴 核心红线：没有 display_value 的行，展示名单元格必须显示 "—"，绝不能拿
   * 原值顶替。原值与展示名是不同字段（且只有 language / agency 才有展示名），
   * 用原值顶替会让运营误判"这行已经有展示名了"，这正是本项目禁止的补偿式 UI
   * （见 `tags-table.tsx` 该单元格的注释）。
   */
  it("displayValue 为 null 的行，展示名单元格是「—」，且不包含原值", () => {
    const { container } = render(<TagsTable labels={LABELS} activity="current" />);
    const row = rowFor(container, LABEL_LANGUAGE_NO_DISPLAY.labelId);
    const cells = row.querySelectorAll("td");
    const displayNameCell = cells[2];

    expect(displayNameCell.textContent).toBe("—");
    expect(displayNameCell.textContent).not.toContain(LABEL_LANGUAGE_NO_DISPLAY.externalLabelValue);
  });

  it("displayValue 有值的行，展示名单元格显示的是展示名，不是原值", () => {
    const { container } = render(<TagsTable labels={LABELS} activity="current" />);
    const row = rowFor(container, LABEL_RECOMMEND.labelId);
    const cells = row.querySelectorAll("td");
    expect(cells[2].textContent).toBe("热门推荐");
  });
});

describe("P2-06 标签字典表 · 类型徽章", () => {
  /**
   * 每个 kind 单元格同时给出两样东西：可发现的原始 kind token（编码进
   * `data-testid`，与 `admin-novels-list.test.tsx` 里 `exception-${code}` 的
   * 用法一致）与中文文案（渲染文本）。中文文案在这里硬编码校验，而不是直接拿
   * `LABEL_KIND_BADGES[kind].label` 去比对自己——那样即使 content-view.ts
   * 里的文案漂移了，测试也会跟着漂移到"永远通过"。
   */
  const EXPECTED_KIND_LABELS: Record<LabelKind, string> = {
    series_type: "题材",
    recommend: "推荐位",
    language: "语言",
    agency: "机构",
  };

  it("LABEL_KIND_BADGES 的中文文案与本文件登记的期望值一致", () => {
    for (const kind of LABEL_KINDS) {
      expect(LABEL_KIND_BADGES[kind].label, `content-view.ts 的 ${kind} 文案已漂移`).toBe(
        EXPECTED_KIND_LABELS[kind],
      );
    }
  });

  it("每种 kind 的徽章同时渲染 raw token（testid）与中文文案（文本）", () => {
    // LABELS 里 series_type 出现了两次（LABEL_ROMANCE 与 LABEL_WEIRD_RAW_VALUE），
    // 这里换一份每种 kind 恰好一行的列表，避免 getByTestId 因命中多个元素而报错。
    const onePerKind = [
      LABEL_ROMANCE,
      LABEL_RECOMMEND,
      LABEL_LANGUAGE_NO_DISPLAY,
      LABEL_AGENCY,
    ].map(projectAdminSourceLabel);
    render(<TagsTable labels={onePerKind} activity="current" />);
    for (const kind of LABEL_KINDS) {
      const badge = screen.getByTestId(`label-kind-${kind}`);
      expect(badge.textContent).toBe(EXPECTED_KIND_LABELS[kind]);
    }
  });
});

describe("P2-06 标签筛选栏", () => {
  it("是纯 GET 表单，字段名即查询参数，且没有 page 字段", () => {
    const { container } = render(<TagFilters values={{}} />);
    const form = container.querySelector("form");
    expect(form).toBeTruthy();
    expect(form?.getAttribute("method")?.toUpperCase()).toBe("GET");
    expect(form?.querySelector('[name="search"]')).toBeTruthy();
    expect(form?.querySelector('[name="labelKind"]')).toBeTruthy();
    expect(form?.querySelector('[name="activity"]')).toBeTruthy();
    // page 不是字段：提交新筛选必须回到第 1 页
    expect(form?.querySelector('[name="page"]')).toBeNull();
  });

  it("类型下拉的选项来自 LABEL_KINDS，不多不少", () => {
    render(<TagFilters values={{}} />);
    const select = screen.getByLabelText("标签类型") as HTMLSelectElement;
    const values = Array.from(select.options).map((option) => option.value);
    expect(values).toEqual(["", ...LABEL_KINDS]);
  });

  it("状态下拉默认「当前有效」，三态齐全", () => {
    render(<TagFilters values={{}} />);
    const select = screen.getByLabelText("标签状态") as HTMLSelectElement;
    expect(select.value).toBe("current");
    const values = Array.from(select.options).map((option) => option.value);
    expect(values).toEqual(["current", "history", "all"]);
  });

  it("回显当前筛选值", () => {
    render(
      <TagFilters values={{ search: "罗曼", labelKind: "recommend", activity: "history" }} />,
    );
    expect((screen.getByLabelText("搜索标签原值") as HTMLInputElement).value).toBe("罗曼");
    expect((screen.getByLabelText("标签类型") as HTMLSelectElement).value).toBe("recommend");
    expect((screen.getByLabelText("标签状态") as HTMLSelectElement).value).toBe("history");
  });
});

describe("P2-06 标签空态", () => {
  it("activity=history 时只显示普通产品空态", () => {
    render(<TagsTable labels={[]} activity="history" />);
    expect(screen.getByText("暂无历史标签")).toBeTruthy();
    expect(screen.queryByTestId("tags-history-empty-note")).toBeNull();
  });

  it("activity=current 时是普通空态，没有历史说明", () => {
    render(<TagsTable labels={[]} activity="current" />);
    expect(screen.getByText("没有符合条件的标签")).toBeTruthy();
    expect(screen.queryByTestId("tags-history-empty-note")).toBeNull();
  });

  it("activity=all 时同样是普通空态，没有历史说明", () => {
    render(<TagsTable labels={[]} activity="all" />);
    expect(screen.getByText("没有符合条件的标签")).toBeTruthy();
    expect(screen.queryByTestId("tags-history-empty-note")).toBeNull();
  });
});

/**
 * P2-06 源码级红线扫描：`/tags` 不得自建第二套语种映射。
 *
 * `src/lib/locale/locale-canonical.ts` 是全项目唯一的语种映射真源
 * （CLAUDE.md §3.2.1）。`LABEL_KIND_BADGES` 的 `language` kind 只标注"这是一个
 * 语言类标签"，从不把某个语种码翻译成语种名——`content-view.ts` 对应位置的注释
 * 明确写了这条边界。这里把它钉成可回归的断言：谁在 `/tags` 底下加了
 * `import { SITE_LOCALES } from "@/lib/locale/locale-canonical"`，或者手写一张
 * `{ en: "English", ja: "日本語" }` 式的码→名字面映射，这个文件就会红。
 */
describe("P2-06 源码红线：/tags 不得自建第二套语种映射", () => {
  const SCAN_ROOT = path.resolve(process.cwd(), "src/app/(admin)/tags");
  const CONTENT_VIEW_PATH = path.resolve(process.cwd(), "src/features/admin-ui/content-view.ts");

  /** 常见语种码，用于探测"码 → 名字"字面映射；不是本项目已登记的 locale 全集。 */
  const LOCALE_CODE_TOKENS = [
    "en",
    "zh",
    "zh-CN",
    "zh-TW",
    "zh-Hans",
    "zh-Hant",
    "ja",
    "ko",
    "fr",
    "de",
    "es",
    "pt",
    "pt-BR",
    "ru",
    "it",
    "vi",
    "th",
    "id",
    "ar",
    "hi",
    "nl",
    "pl",
    "tr",
    "uk",
    "sv",
    "da",
    "no",
    "fi",
    "cs",
    "el",
    "he",
    "ro",
    "hu",
    "bg",
  ];

  /** 形如 `en: "English"` / `"ja": "日本語"` 的 key-value 字面映射。 */
  const LANGUAGE_CODE_TO_NAME_LITERAL = new RegExp(
    `["']?\\b(${LOCALE_CODE_TOKENS.join("|")})\\b["']?\\s*:\\s*["'][^"'\\n]{1,40}["']`,
  );

  /** 与 `admin-content-registry.test.ts` 同款：剥注释，不动字符串字面量内容。 */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  async function walk(directory: string): Promise<{ file: string; source: string }[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) return walk(target);
        if (!/\.tsx?$/.test(entry.name)) return [];
        return [
          {
            file: path.relative(process.cwd(), target),
            source: stripComments(await readFile(target, "utf8")),
          },
        ];
      }),
    );
    return nested.flat();
  }

  it("探测正则本身是有效的：能抓到人为构造的码→名映射（mutation-proof 证据）", () => {
    const smuggled = `
      const LANGUAGE_NAMES = {
        en: "English",
        "ja": '日本語',
        zh: "中文",
      };
    `;
    expect(LANGUAGE_CODE_TO_NAME_LITERAL.test(smuggled)).toBe(true);
    // 正常的 kind 徽章配置——key 是 kind 而不是语种码——不应该被误判
    const legitimate = `
      export const LABEL_KIND_BADGES = {
        series_type: { label: "题材", color: "bg-indigo-100 text-indigo-800" },
        language: { label: "语言", color: "bg-cyan-100 text-cyan-800" },
      };
    `;
    expect(LANGUAGE_CODE_TO_NAME_LITERAL.test(legitimate)).toBe(false);
  });

  /**
   * 站点发布域的符号，一个都不许进 `/tags`。
   *
   * 原实现禁的是 `@/lib/locale/locale-canonical` 这个**导入路径**。P2-06.5 F3
   * 之后该路径同时承载了两个域：站点发布域（`SITE_LOCALES` 一族，回答"哪个
   * locale 能发给读者"）与标签译名域（`TAG_TRANSLATION_LOCALES` 一族，回答
   * "CanonicalTag 的译名能录哪些语种"）。禁路径会连正当的单一真源消费一起禁掉，
   * 于是只能挂文件白名单——而白名单会被后来者当成先例往里加。
   *
   * 改为按**符号**禁：下面五个是 locale-canonical 站点发布域的全部导出面，
   * 逐一封死；剩下的三个 `TAG_*` 导出正是 CLAUDE.md §3.2.1 要求组件必须复用
   * 而不是自己再抄一份的东西。既不需要任何例外，覆盖面还比原来更宽
   * （原来只拦 `SITE_LOCALES` 一个符号）。
   *
   * 本守卫的原始意图——"/tags 不得自建第二套语种映射"——由另外两条断言继续
   * 兜底：手写码→名字面映射（下一个 it）与全仓第二映射表检查
   * （tests/ui/locale-canonical.test.ts）。
   */
  const SITE_LOCALE_DOMAIN_SYMBOLS =
    /\b(SITE_LOCALES|SiteLocale|resolveSiteLocale|isPublishableLocale|listPublishableLocales)\b/;

  it("/tags 目录下没有文件引用站点发布域的语种符号", async () => {
    const files = await walk(SCAN_ROOT);
    expect(files.length).toBeGreaterThan(0);
    for (const { file, source } of files) {
      expect(source, `${file} 引用了站点发布域语种符号`).not.toMatch(
        SITE_LOCALE_DOMAIN_SYMBOLS,
      );
    }
  });

  it("/tags 目录下没有文件手写语种码→语种名的字面映射", async () => {
    const files = await walk(SCAN_ROOT);
    for (const { file, source } of files) {
      expect(
        LANGUAGE_CODE_TO_NAME_LITERAL.test(source),
        `${file} 疑似自建了语种码→语种名映射，唯一真源是 src/lib/locale/locale-canonical.ts`,
      ).toBe(false);
    }
  });

  it("content-view.ts 同样没有 import locale-canonical、引用 SITE_LOCALES 或语种码映射", async () => {
    const source = stripComments(await readFile(CONTENT_VIEW_PATH, "utf8"));
    expect(source).not.toContain("@/lib/locale/locale-canonical");
    expect(source).not.toMatch(/\bSITE_LOCALES\b/);
    expect(LANGUAGE_CODE_TO_NAME_LITERAL.test(source)).toBe(false);
  });
});
