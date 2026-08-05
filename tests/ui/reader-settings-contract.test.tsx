import "./setup-cleanup";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChapterScreen } from "@/features/public-ui/chapter/ChapterScreen";
import { ReaderSettingsProvider } from "@/features/public-ui/chapter/ReaderSettingsProvider";
import { buildReaderBootstrapScript } from "@/features/public-ui/chapter/reader-bootstrap";
import {
  DEFAULT_READER_SETTINGS,
  READER_FONT_SIZES,
  READER_LINE_HEIGHTS,
  READER_MEASURES,
  READER_SETTINGS_STORAGE_KEY,
  normalizeReaderSettings,
  type ReaderSettings,
} from "@/features/public-ui/chapter/reader-settings";
import { MOCK_CHAPTER } from "@/features/public-ui/fixtures/mock-content";

/**
 * 阅读设置契约：normalize / localStorage / 补水前脚本 三者语义必须严格一致。
 *
 * 这三处任何一处偏离，读者都会在补水那一瞬间看到主题或排版跳变——而补水前脚本
 * 存在的全部意义就是消除这种跳变。历史上的实现用 `F[index]` 是否存在代替规范化，
 * 在 `"2"` / `99` / `-99` 三处与 normalize 分歧。本文件把这三处钉死。
 */

/** 覆盖矩阵。每一项都必须在三个层面得到同一个结果。 */
const CASES: { name: string; stored: unknown; expected: ReaderSettings }[] = [
  {
    name: "合法整数",
    stored: { theme: "dark", fontSizeIndex: 3, lineHeightIndex: 0, measureIndex: 2 },
    expected: { theme: "dark", fontSizeIndex: 3, lineHeightIndex: 0, measureIndex: 2 },
  },
  {
    name: '字符串 "2" → 默认档（不做隐式转换）',
    stored: { theme: "light", fontSizeIndex: "2" },
    expected: { ...DEFAULT_READER_SETTINGS, theme: "light" },
  },
  {
    name: "正越界 99 → 最大档",
    stored: { fontSizeIndex: 99, lineHeightIndex: 99, measureIndex: 99 },
    expected: {
      theme: "system",
      fontSizeIndex: READER_FONT_SIZES.length - 1,
      lineHeightIndex: READER_LINE_HEIGHTS.length - 1,
      measureIndex: READER_MEASURES.length - 1,
    },
  },
  {
    name: "负越界 -99 → 最小档",
    stored: { fontSizeIndex: -99, lineHeightIndex: -99, measureIndex: -99 },
    expected: { theme: "system", fontSizeIndex: 0, lineHeightIndex: 0, measureIndex: 0 },
  },
  {
    name: "小数 1.5 → 默认档",
    stored: { fontSizeIndex: 1.5 },
    expected: DEFAULT_READER_SETTINGS,
  },
  {
    name: "NaN / Infinity → 默认档",
    // JSON 里存不下 NaN，但被手改或旧版本写入时可能出现；normalize 必须挡住。
    stored: { fontSizeIndex: Number.NaN, lineHeightIndex: Number.POSITIVE_INFINITY },
    expected: DEFAULT_READER_SETTINGS,
  },
  {
    name: "null → 默认档",
    stored: { theme: null, fontSizeIndex: null, lineHeightIndex: null, measureIndex: null },
    expected: DEFAULT_READER_SETTINGS,
  },
  {
    name: "数组 / 对象 → 默认档",
    stored: { fontSizeIndex: [2], measureIndex: { value: 2 } },
    expected: DEFAULT_READER_SETTINGS,
  },
  {
    name: "非法主题 → system",
    stored: { theme: "sepia", fontSizeIndex: 0 },
    expected: { ...DEFAULT_READER_SETTINGS, fontSizeIndex: 0, theme: "system" },
  },
  {
    name: "部分字段缺失 → 该字段用默认值",
    stored: { theme: "dark" },
    expected: { ...DEFAULT_READER_SETTINGS, theme: "dark" },
  },
  {
    name: "合法历史设置（全部非默认）",
    stored: { theme: "light", fontSizeIndex: 0, lineHeightIndex: 2, measureIndex: 0 },
    expected: { theme: "light", fontSizeIndex: 0, lineHeightIndex: 2, measureIndex: 0 },
  },
];

/** 把 expected 翻译成补水前 `<html>` 上应当出现的三个 CSS 变量与主题属性。 */
function expectedMirror(expected: ReaderSettings) {
  return {
    theme: expected.theme === "system" ? null : expected.theme,
    fontSize: READER_FONT_SIZES[expected.fontSizeIndex],
    lineHeight: READER_LINE_HEIGHTS[expected.lineHeightIndex],
    measure: READER_MEASURES[expected.measureIndex],
  };
}

/** 真的把生成出来的 bootstrap 脚本跑一遍，读回它写到 `<html>` 上的结果。 */
function runBootstrap() {
  const root = document.documentElement;
  root.removeAttribute("data-reader-pref-theme");
  root.removeAttribute("style");

  // 这里必须真的执行产物：断言脚本源码的字符串内容只能证明「写了什么」，
  // 证明不了「跑出什么」——而契约要求的恰恰是运行结果与 normalize 一致。
  new Function(buildReaderBootstrapScript())();

  return {
    theme: root.getAttribute("data-reader-pref-theme"),
    fontSize: root.style.getPropertyValue("--reader-pref-font-size"),
    lineHeight: root.style.getPropertyValue("--reader-pref-line-height"),
    measure: root.style.getPropertyValue("--reader-pref-measure"),
  };
}

describe("阅读设置契约 · normalize 冻结规则", () => {
  for (const { name, stored, expected } of CASES) {
    it(name, () => {
      expect(normalizeReaderSettings(stored as Partial<ReaderSettings>)).toEqual(expected);
    });
  }

  it("malformed JSON 由存储层兜住，回全部默认值", () => {
    window.localStorage.setItem(READER_SETTINGS_STORAGE_KEY, "{ 这不是 JSON");
    // 读回路径已在 reader-persistence 覆盖；这里只钉「结果是全默认」这条语义。
    expect(normalizeReaderSettings(null)).toEqual(DEFAULT_READER_SETTINGS);
  });

  it("规范化是幂等的——重复规范化不改变结果", () => {
    for (const { stored } of CASES) {
      const once = normalizeReaderSettings(stored as Partial<ReaderSettings>);
      expect(normalizeReaderSettings(once)).toEqual(once);
    }
  });
});

describe("阅读设置契约 · 补水前脚本与 normalize 同语义", () => {
  for (const { name, stored, expected } of CASES) {
    it(name, () => {
      window.localStorage.setItem(READER_SETTINGS_STORAGE_KEY, JSON.stringify(stored));
      expect(runBootstrap()).toEqual(expectedMirror(expected));
    });
  }

  it("malformed JSON → 三项排版全默认、主题回 system", () => {
    window.localStorage.setItem(READER_SETTINGS_STORAGE_KEY, "{ 这不是 JSON");
    expect(runBootstrap()).toEqual(expectedMirror(DEFAULT_READER_SETTINGS));
  });

  it("存储里是数组而不是对象 → 全默认", () => {
    window.localStorage.setItem(READER_SETTINGS_STORAGE_KEY, JSON.stringify([1, 2, 3]));
    expect(runBootstrap()).toEqual(expectedMirror(DEFAULT_READER_SETTINGS));
  });

  it("什么都没存过 → 全默认", () => {
    window.localStorage.removeItem(READER_SETTINGS_STORAGE_KEY);
    expect(runBootstrap()).toEqual(expectedMirror(DEFAULT_READER_SETTINGS));
  });

  it("脚本里不出现手抄的档位字面量——档位表只能从 reader-settings 注入", () => {
    const script = buildReaderBootstrapScript();
    // 档位值当然会出现（它们是被 JSON.stringify 注入的），但注入之外不应存在
    // 第二份默认值定义：默认下标必须来自 DEFAULT_READER_SETTINGS。
    expect(script).toContain(JSON.stringify(DEFAULT_READER_SETTINGS));
    expect(script).toContain("Number.isInteger");
    // 旧实现的特征：用下标存在与否代替规范化。不允许再出现。
    expect(script).not.toContain("if(F[p.fontSizeIndex])");
  });
});

describe("阅读设置契约 · 写入路径", () => {
  function renderWithProvider() {
    return render(
      <ReaderSettingsProvider>
        <ChapterScreen chapter={MOCK_CHAPTER} />
      </ReaderSettingsProvider>,
    );
  }

  function openPanel() {
    fireEvent.click(screen.getByTestId("reader-settings-toggle"));
  }

  function storedSettings() {
    const raw = window.localStorage.getItem(READER_SETTINGS_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ReaderSettings) : null;
  }

  it("localStorage 里只会出现 normalized 值，且不经过非法中间态", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    renderWithProvider();
    openPanel();
    fireEvent.click(screen.getByRole("radio", { name: "深色" }));

    const settingsWrites = setItem.mock.calls.filter(
      (call) => call[0] === READER_SETTINGS_STORAGE_KEY,
    );
    expect(settingsWrites.length).toBeGreaterThan(0);

    // 每一次写入——不只是最后一次——都必须已经是规范化的。
    // 「先写非法值、随后再修正」会在这里留下一条不等于自身规范化结果的记录。
    for (const [, payload] of settingsWrites) {
      const parsed = JSON.parse(String(payload)) as ReaderSettings;
      expect(parsed).toEqual(normalizeReaderSettings(parsed));
    }

    setItem.mockRestore();
  });

  it("回调、内存状态、localStorage 三者拿到同一份 normalized 设置", () => {
    const onSettingsChange = vi.fn();
    render(
      <ReaderSettingsProvider>
        <ChapterScreen chapter={MOCK_CHAPTER} onSettingsChange={onSettingsChange} />
      </ReaderSettingsProvider>,
    );
    openPanel();
    fireEvent.click(screen.getByRole("radio", { name: "22" }));

    const fromCallback = onSettingsChange.mock.calls.at(-1)?.[0] as ReaderSettings;
    const fromStorage = storedSettings();

    // 内存状态通过阅读区的实际属性观察，避免测试直接窥探组件内部。
    const surface = screen.getByTestId("reader-surface");
    expect(surface.getAttribute("style")).toContain(
      `--reader-font-size: ${READER_FONT_SIZES[fromCallback.fontSizeIndex]}`,
    );
    expect(surface.getAttribute("data-reader-theme")).toBe(fromCallback.theme);

    expect(fromCallback).toEqual(normalizeReaderSettings(fromCallback));
    expect(fromStorage).toEqual(fromCallback);
  });

  it("补水时就地修复历史脏值，存储字面上也变成 normalized", () => {
    // 只读不修的话，"2" 会一直躺在存储里：语义上没问题（每次读都收敛），
    // 但排查问题的人会看到存储与内存是两个值，且分不清哪个算数。
    window.localStorage.setItem(
      READER_SETTINGS_STORAGE_KEY,
      JSON.stringify({ theme: "light", fontSizeIndex: "2" }),
    );

    renderWithProvider();

    expect(storedSettings()).toEqual({ ...DEFAULT_READER_SETTINGS, theme: "light" });
  });

  it("存储已经是 normalized 时不做多余写入", () => {
    const clean: ReaderSettings = { ...DEFAULT_READER_SETTINGS, theme: "dark" };
    window.localStorage.setItem(READER_SETTINGS_STORAGE_KEY, JSON.stringify(clean));

    const setItem = vi.spyOn(Storage.prototype, "setItem");
    renderWithProvider();

    const settingsWrites = setItem.mock.calls.filter(
      (call) => call[0] === READER_SETTINGS_STORAGE_KEY,
    );
    expect(settingsWrites).toHaveLength(0);

    setItem.mockRestore();
  });

  it("外部灌入非法初值时，回调仍只吐出 normalized 值", () => {
    const onSettingsChange = vi.fn();
    render(
      <ChapterScreen
        chapter={MOCK_CHAPTER}
        initialSettings={
          { fontSizeIndex: 99, theme: "sepia" } as unknown as Partial<ReaderSettings>
        }
        onSettingsChange={onSettingsChange}
      />,
    );
    openPanel();
    fireEvent.click(screen.getByRole("radio", { name: "宽" }));

    const emitted = onSettingsChange.mock.calls.at(-1)?.[0] as ReaderSettings;
    expect(emitted).toEqual(normalizeReaderSettings(emitted));
    // 99 在渲染时就已被夹到最大档，改页宽不应把它带回非法值。
    expect(emitted.fontSizeIndex).toBe(READER_FONT_SIZES.length - 1);
    expect(emitted.theme).toBe("system");
  });
});

describe("阅读设置契约 · 补水前后无跳变", () => {
  for (const { name, stored, expected } of CASES) {
    it(name, () => {
      window.localStorage.setItem(READER_SETTINGS_STORAGE_KEY, JSON.stringify(stored));

      // ① 补水前：脚本写到 <html> 上的值
      const preHydration = runBootstrap();

      // ② 补水后：Provider 读回并交给阅读区的值
      render(
        <ReaderSettingsProvider>
          <ChapterScreen chapter={MOCK_CHAPTER} />
        </ReaderSettingsProvider>,
      );
      const surface = screen.getByTestId("reader-surface");
      const style = surface.getAttribute("style") ?? "";

      // ③ 存储最终内容
      const raw = window.localStorage.getItem(READER_SETTINGS_STORAGE_KEY);
      const finalStored = normalizeReaderSettings(
        raw ? (JSON.parse(raw) as Partial<ReaderSettings>) : null,
      );

      const mirror = expectedMirror(expected);

      // 三者一致：补水前的 CSS 变量 === 补水后阅读区的实际排版 === 存储收敛结果
      expect(preHydration).toEqual(mirror);
      expect(style).toContain(`--reader-font-size: ${mirror.fontSize}`);
      expect(style).toContain(`--reader-line-height: ${mirror.lineHeight}`);
      expect(style).toContain(`--reader-measure: ${mirror.measure}`);
      expect(surface.getAttribute("data-reader-theme")).toBe(expected.theme);
      expect(finalStored).toEqual(expected);
    });
  }
});
