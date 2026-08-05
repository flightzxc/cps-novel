import type { CSSProperties } from "react";

/**
 * 阅读器设置的状态接口。
 *
 * 分期边界：
 *   P1-10（本轮）——控件外观 + 真实可切换 + 阅读区外观真实变化，**不持久化**。
 *                   刷新后回到默认值，这是预期行为，不是缺陷。
 *   P1-11（下一轮）——本地存储持久化、滚动位置恢复、章节切换不整页刷新。
 *
 * 本轮对下一轮的义务：控件不能是静态图形，必须有明确的状态接口，并留出接本地
 * 存储的挂载点。因此这里把「设置的形状」「默认值」「存储键」「序列化」都定义好，
 * P1-11 只需要在 ReaderSettingsProvider 的初值与变更回调上接线，不用改组件。
 */

export type ReaderTheme = "system" | "light" | "dark";

/** 字号档位。默认档落在既有设计说明给定的正文 17–19px 区间内。 */
export const READER_FONT_SIZES = ["16px", "18px", "20px", "22px"] as const;
/** 行高档位。默认档落在既有设计说明给定的 1.75–1.9 区间内。 */
export const READER_LINE_HEIGHTS = ["1.6", "1.8", "2"] as const;
/** 页宽档位（行长）。默认档落在既有设计说明给定的 68–72 字符区间内。 */
export const READER_MEASURES = ["60ch", "68ch", "76ch"] as const;

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
 * P1-11 接本地存储时使用的键。本轮不写不读，只在这里定义，避免下一轮临时起名。
 * 无账号体系，偏好只在本设备生效——这是预期行为。
 */
export const READER_SETTINGS_STORAGE_KEY = "novel:reader-settings:v1";

/**
 * 收敛单个档位下标。
 *
 * 越界的整数夹回两端（读者以前选过 22px，后来档位表缩短了，夹到最大档是对的）；
 * 而**非整数一律回默认档**——那不是「选过但超范围」，那是存储被损坏或被手改，
 * 此时唯一说得通的落点是默认值。
 *
 * 原先非整数回落到中间档 `Math.floor(length / 2)`：字号有 4 档，中间档是 2（20px），
 * 而默认档是 1（18px）——损坏的存储会把读者送到一个他从没选过的档位。
 */
function clampIndex(index: number, length: number, fallback: number): number {
  if (!Number.isInteger(index)) {
    return fallback;
  }
  return Math.min(Math.max(index, 0), length - 1);
}

/** 把越界或损坏的值收敛回合法范围。P1-11 从本地存储读回时应先过这一层。 */
export function normalizeReaderSettings(
  input: Partial<ReaderSettings> | null | undefined,
): ReaderSettings {
  const source = input ?? {};
  const theme: ReaderTheme =
    source.theme === "light" || source.theme === "dark" || source.theme === "system"
      ? source.theme
      : DEFAULT_READER_SETTINGS.theme;

  return {
    theme,
    fontSizeIndex: clampIndex(
      source.fontSizeIndex ?? DEFAULT_READER_SETTINGS.fontSizeIndex,
      READER_FONT_SIZES.length,
      DEFAULT_READER_SETTINGS.fontSizeIndex,
    ),
    lineHeightIndex: clampIndex(
      source.lineHeightIndex ?? DEFAULT_READER_SETTINGS.lineHeightIndex,
      READER_LINE_HEIGHTS.length,
      DEFAULT_READER_SETTINGS.lineHeightIndex,
    ),
    measureIndex: clampIndex(
      source.measureIndex ?? DEFAULT_READER_SETTINGS.measureIndex,
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
