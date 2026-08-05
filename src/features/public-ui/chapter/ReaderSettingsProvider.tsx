"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  DEFAULT_READER_SETTINGS,
  READER_FONT_SIZES,
  READER_LINE_HEIGHTS,
  READER_MEASURES,
  type ReaderSettings,
} from "./reader-settings";
import { readReaderSettings, writeReaderSettings } from "./reader-storage";

/**
 * 阅读偏好的跨章存活容器。
 *
 * **为什么必须是 Provider、而且必须挂在 layout 里**：章节切换走客户端路由，
 * `[chapterNumber]/page.tsx` 这一层会被换掉、组件重挂；而 App Router 在同一
 * 布局下切换兄弟路由时**不会重挂 layout**。把状态放在 layout 里的这个 Provider 上，
 * 设置才能在切章时原样保留——这正是验收项 ④「切换后阅读设置与上下文保持」。
 * 状态若留在 ChapterScreen 里，每切一章就会连同组件一起重建。
 *
 * **Context 默认值是 `null` 而不是一份设置**，这一点是刻意的：`ChapterScreen`
 * 靠「取到的是不是 null」来判断自己是被挂在 Provider 下（受控），还是被独立渲染
 * （自持状态）。给个非 null 的默认值就没法区分这两种情形了。
 */

export interface ReaderSettingsContextValue {
  settings: ReaderSettings;
  setSettings: (next: ReaderSettings) => void;
  /**
   * 是否已从本地存储读回。
   *
   * 补水之前 `settings` 还是默认值，不代表读者的真实档位。两处依赖它：
   * 阅读区在补水前不写内联排版变量（改由 CSS 取脚本写在 :root 上的值，避免闪一
   * 帧默认排版），阅读位置在补水前不做测量（否则会按错误的字号算出错误的段落）。
   */
  hydrated: boolean;
}

const ReaderSettingsContext = createContext<ReaderSettingsContextValue | null>(null);

/** 取当前的阅读偏好上下文；不在 Provider 下时返回 null。 */
export function useReaderSettingsContext(): ReaderSettingsContextValue | null {
  return useContext(ReaderSettingsContext);
}

/** 供防闪脚本与 Provider 共用的 html 属性名，避免两处各写各的字符串。 */
export const READER_THEME_PREF_ATTRIBUTE = "data-reader-pref-theme";

/**
 * 把手动主题覆盖镜像到 `<html>` 上。
 *
 * 这个镜像只服务于「首帧不闪」：SSR 时服务端不知道读者存过什么，阅读区只能先
 * 按 `system` 渲染，等补水后 React 才改 `data-reader-theme`。中间那一帧，手动
 * 选了浅色的读者会看到深色（或反过来）闪一下。防闪脚本在补水前就把偏好写到
 * `<html>` 上，CSS 据此提前压过 `system` 的表现；补水后由这里保持两者同值。
 *
 * `system` 时移除属性而不是写 `"system"`——没有属性就没有额外规则参与，
 * 媒体查询自己说了算，这正是「跟随系统」该有的行为。
 */
function syncPreferenceMirror(settings: ReaderSettings): void {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;

  if (settings.theme === "system") {
    root.removeAttribute(READER_THEME_PREF_ATTRIBUTE);
  } else {
    root.setAttribute(READER_THEME_PREF_ATTRIBUTE, settings.theme);
  }

  // 排版三项同样要镜像：读者下次打开页面时，脚本会把这里写下的值提前放到 :root，
  // 阅读区在补水前就能按正确档位排版。三个变量名与 globals.css 的 fallback 层一致。
  root.style.setProperty("--reader-pref-font-size", READER_FONT_SIZES[settings.fontSizeIndex]);
  root.style.setProperty(
    "--reader-pref-line-height",
    READER_LINE_HEIGHTS[settings.lineHeightIndex],
  );
  root.style.setProperty("--reader-pref-measure", READER_MEASURES[settings.measureIndex]);
}

export function ReaderSettingsProvider({ children }: { children: ReactNode }) {
  // 首次渲染必须与服务端产出逐字节一致，因此这里起步于默认值，读存储放到 effect
  // 里。直接在惰性初始化里读 localStorage 会造成 hydration mismatch——服务端不可能
  // 知道读者本机存了什么。
  const [settings, setSettingsState] = useState<ReaderSettings>(DEFAULT_READER_SETTINGS);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const stored = readReaderSettings();
    // 从 localStorage 读初值是 react-hooks/set-state-in-effect 覆盖不到的正当情形：
    // 值只存在于客户端，渲染期读会破坏 hydration，所以只能在挂载后同步一次。
    //
    // 不改用 useSyncExternalStore 的原因：它要求快照唯一来自那个外部存储，
    // 而这里写入失败（Safari 无痕、配额耗尽）时设置仍必须在本次会话内生效，
    // 需要一层内存兜底；把兜底做成模块级可变状态又会在测试之间泄漏。
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setSettingsState(stored);
    setHydrated(true);
    syncPreferenceMirror(stored);
  }, []);

  const setSettings = useCallback((next: ReaderSettings) => {
    setSettingsState(next);
    writeReaderSettings(next);
    syncPreferenceMirror(next);
  }, []);

  return (
    <ReaderSettingsContext.Provider value={{ settings, setSettings, hydrated }}>
      {children}
    </ReaderSettingsContext.Provider>
  );
}
