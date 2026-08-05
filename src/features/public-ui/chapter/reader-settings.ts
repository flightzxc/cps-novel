import type { CSSProperties } from "react";

/**
 * 阅读器设置的状态接口。
 *
 * 分期边界：
 *   P1-10 —— 控件外观 + 真实可切换 + 阅读区外观真实变化，不持久化。
 *   P1-11 —— 本地存储持久化、阅读位置恢复、章节切换不整页刷新。
 *
 * 本文件只负责「设置的形状、默认值、合法性收敛、翻译成 CSS 变量」这四件事，
 * 不碰存储本身——读写在 `./reader-storage.ts`，跨章存活在
 * `./ReaderSettingsProvider.tsx`。这样纯函数部分保持可在任意环境直接测试。
 */

export type ReaderTheme = "system" | "light" | "dark";

/** 字号档位。默认档落在既有设计说明给定的正文 17–19px 区间内。 */
export const READER_FONT_SIZES = ["16px", "18px", "20px", "22px"] as const;
/** 行高档位。默认档落在既有设计说明给定的 1.75–1.9 区间内。 */
export const READER_LINE_HEIGHTS = ["1.6", "1.8", "2"] as const;
/** 页宽档位（行长）。默认档落在既有设计说明给定的 68–72 字符区间内。 */
export const READER_MEASURES = ["60ch", "68ch", "76ch"] as const;

/**
 * 合法主题值的唯一清单。
 *
 * 补水前的 bootstrap 脚本与 `normalizeReaderSettings` 都从这里取，避免两处各写
 * 一份判断——两份判断一旦漂移，读者会在补水瞬间看到主题跳变。
 */
export const READER_THEMES = ["system", "light", "dark"] as const;

export const READER_THEME_OPTIONS: { value: ReaderTheme; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

export interface ReaderSettings {
  theme: ReaderTheme;
  fontSizeIndex: number;
  lineHeightIndex: number;
  measureIndex: number;
}

/** 跟随系统是默认；三项排版参数取中间档。 */
export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  theme: "system",
  fontSizeIndex: 1,
  lineHeightIndex: 1,
  measureIndex: 1,
};

/**
 * 阅读偏好的本地存储键。
 * 无账号体系，偏好只在本设备生效——这是预期行为，不是缺陷。
 */
export const READER_SETTINGS_STORAGE_KEY = "novel:reader-settings:v1";

/**
 * 收敛单个档位下标。**这条规则是冻结的**，补水前的 bootstrap 脚本必须逐条照做。
 *
 * | 输入 | 结果 | 为什么 |
 * | --- | --- | --- |
 * | 合法整数（在范围内） | 原样 | 读者确实选过 |
 * | 合法整数（越界） | 夹到最近边界 | 读者选过 22px，后来档位表缩短了，夹到最大档才是他的本意 |
 * | 小数 / NaN / Infinity | 默认档 | 不是「选过但超范围」，是数据坏了 |
 * | 字符串数字 `"2"` | 默认档 | **不做隐式转换**：存储里出现字符串说明写入方不是本模块，值不可信 |
 * | null / undefined / 数组 / 对象 | 默认档 | 同上 |
 *
 * `Number.isInteger` 一次性覆盖「是 number」「是有限值」「是整数」三条：
 * 非 number 返回 false，NaN 与 ±Infinity 也返回 false。
 */
function clampIndex(index: unknown, length: number, fallback: number): number {
  if (!Number.isInteger(index)) {
    return fallback;
  }
  return Math.min(Math.max(index as number, 0), length - 1);
}

/** 合法主题以外的一切（含非字符串）都回 system。 */
function normalizeTheme(theme: unknown): ReaderTheme {
  return (READER_THEMES as readonly string[]).includes(theme as string)
    ? (theme as ReaderTheme)
    : DEFAULT_READER_SETTINGS.theme;
}

/**
 * 把越界或损坏的值收敛回合法范围。
 *
 * 🔴 **这是设置的唯一信任边界。** 从本地存储读回、从外部灌入、从任何调用方传进来
 * 的值，都必须先过这一层再进内存状态 / localStorage / onSettingsChange —— 三者
 * 必须拿到同一份规范化结果，否则读者会在补水瞬间看到跳变。
 *
 * 注意这里**不能**用 `source.x ?? DEFAULT.x` 再交给 clampIndex：`??` 只挡 null 与
 * undefined，挡不住 `"2"`、`1.5`、`[]` 这些。合法性判断必须整个交给 clampIndex。
 */
export function normalizeReaderSettings(
  input: Partial<ReaderSettings> | null | undefined,
): ReaderSettings {
  const source = (input ?? {}) as Record<string, unknown>;

  return {
    theme: normalizeTheme(source.theme),
    fontSizeIndex: clampIndex(
      source.fontSizeIndex,
      READER_FONT_SIZES.length,
      DEFAULT_READER_SETTINGS.fontSizeIndex,
    ),
    lineHeightIndex: clampIndex(
      source.lineHeightIndex,
      READER_LINE_HEIGHTS.length,
      DEFAULT_READER_SETTINGS.lineHeightIndex,
    ),
    measureIndex: clampIndex(
      source.measureIndex,
      READER_MEASURES.length,
      DEFAULT_READER_SETTINGS.measureIndex,
    ),
  };
}

/**
 * 把设置翻译成阅读作用域的 CSS 变量。
 * 主题不在这里——它走 data-reader-theme 属性，因为「跟随系统」必须由 CSS 媒体
 * 查询决定，不能在 JS 里读一次系统偏好然后写死。
 */
export function readerStyleVars(settings: ReaderSettings): CSSProperties {
  return {
    "--reader-font-size": READER_FONT_SIZES[settings.fontSizeIndex],
    "--reader-line-height": READER_LINE_HEIGHTS[settings.lineHeightIndex],
    "--reader-measure": READER_MEASURES[settings.measureIndex],
  } as CSSProperties;
}
