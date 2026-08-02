"use client";

import { useEffect, useId, useRef } from "react";
import {
  DEFAULT_READER_SETTINGS,
  READER_FONT_SIZES,
  READER_LINE_HEIGHTS,
  READER_MEASURES,
  READER_THEME_OPTIONS,
  type ReaderSettings,
  type ReaderTheme,
} from "./reader-settings";

/**
 * 阅读设置面板。
 *
 * 形态：移动端从底部升起，桌面端锚定在设置按钮下方。
 * 打开时不遮挡正文顶部——移动端贴底，桌面端向下展开。
 *
 * 🔴 这不是静态图形：每个控件都绑在真实状态上，改动会立刻反映到阅读区外观。
 * 本轮不持久化（P1-11 负责），刷新回默认值是预期行为。
 *
 * 无障碍：面板是 dialog 语义，Esc 关闭并把焦点还给触发按钮；档位控件用 radiogroup，
 * 方向键可切换（浏览器原生行为）。
 */
export function ReaderSettingsPanel({
  open,
  settings,
  onChange,
  onClose,
  onReset,
  labelledBy,
}: {
  open: boolean;
  settings: ReaderSettings;
  onChange: (next: ReaderSettings) => void;
  onClose: () => void;
  onReset: () => void;
  labelledBy?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  const isDefault =
    settings.theme === DEFAULT_READER_SETTINGS.theme &&
    settings.fontSizeIndex === DEFAULT_READER_SETTINGS.fontSizeIndex &&
    settings.lineHeightIndex === DEFAULT_READER_SETTINGS.lineHeightIndex &&
    settings.measureIndex === DEFAULT_READER_SETTINGS.measureIndex;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={labelledBy ?? titleId}
      data-testid="reader-settings-panel"
      className={
        // 移动端：贴底浮层，横向铺满 —— 桌面端：锚定在按钮下方的定宽面板
        "fixed inset-x-0 bottom-0 z-40 rounded-t-novel-lg border-t border-novel-border bg-novel-bg-elevated p-5 " +
        "md:absolute md:inset-x-auto md:top-full md:right-0 md:bottom-auto md:mt-2 md:w-[22rem] md:rounded-novel-lg md:border"
      }
    >
      <div className="flex items-center justify-between">
        <h2 id={titleId} className="text-sm font-medium text-novel-fg">
          阅读设置
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="-mr-2 inline-flex h-9 w-9 items-center justify-center rounded-novel-md text-novel-fg-muted transition-colors hover:bg-novel-bg-raised hover:text-novel-fg"
          aria-label="关闭阅读设置"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M4 4l8 8M12 4l-8 8"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      <div className="mt-5 flex flex-col gap-5">
        <OptionRow
          label="主题"
          options={READER_THEME_OPTIONS.map((option) => ({
            key: option.value,
            label: option.label,
            selected: settings.theme === option.value,
            onSelect: () => onChange({ ...settings, theme: option.value as ReaderTheme }),
          }))}
          testId="reader-theme-control"
        />

        <OptionRow
          label="字号"
          options={READER_FONT_SIZES.map((size, index) => ({
            key: size,
            label: size.replace("px", ""),
            selected: settings.fontSizeIndex === index,
            onSelect: () => onChange({ ...settings, fontSizeIndex: index }),
          }))}
          testId="reader-font-size-control"
        />

        <OptionRow
          label="行高"
          options={READER_LINE_HEIGHTS.map((value, index) => ({
            key: value,
            label: ["紧凑", "标准", "宽松"][index] ?? value,
            selected: settings.lineHeightIndex === index,
            onSelect: () => onChange({ ...settings, lineHeightIndex: index }),
          }))}
          testId="reader-line-height-control"
        />

        <OptionRow
          label="页宽"
          options={READER_MEASURES.map((value, index) => ({
            key: value,
            label: ["窄", "标准", "宽"][index] ?? value,
            selected: settings.measureIndex === index,
            onSelect: () => onChange({ ...settings, measureIndex: index }),
          }))}
          testId="reader-measure-control"
        />
      </div>

      <div className="mt-6 flex items-center justify-between border-t border-novel-border pt-4">
        <p className="text-xs text-novel-fg-subtle">设置仅在本次浏览生效</p>
        <button
          type="button"
          onClick={onReset}
          disabled={isDefault}
          className="rounded-novel-sm px-2 py-1 text-xs text-novel-fg-muted transition-colors hover:text-novel-fg disabled:pointer-events-none disabled:opacity-45"
        >
          恢复默认
        </button>
      </div>
    </div>
  );
}

interface Option {
  key: string;
  label: string;
  selected: boolean;
  onSelect: () => void;
}

function OptionRow({
  label,
  options,
  testId,
}: {
  label: string;
  options: Option[];
  testId: string;
}) {
  const groupId = useId();

  return (
    <div>
      <div id={groupId} className="mb-2 text-xs text-novel-fg-subtle">
        {label}
      </div>
      <div
        role="radiogroup"
        aria-labelledby={groupId}
        data-testid={testId}
        className="flex gap-1.5 rounded-novel-md border border-novel-border p-1"
      >
        {options.map((option) => (
          <button
            key={option.key}
            type="button"
            role="radio"
            aria-checked={option.selected}
            onClick={option.onSelect}
            className={
              "flex-1 rounded-novel-sm px-2 py-2 text-xs transition-colors " +
              (option.selected
                ? "bg-novel-accent text-novel-on-accent"
                : "text-novel-fg-muted hover:bg-novel-bg-raised hover:text-novel-fg")
            }
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
