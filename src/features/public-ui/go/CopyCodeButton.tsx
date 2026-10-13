"use client";

import { useEffect, useRef, useState } from "react";

/** 复制成功后"已复制"状态保持的时长（设计稿 1.8 秒）。 */
export const COPIED_STATE_MS = 1800;

/** 剪贴板接口不可用（非安全上下文 / 旧浏览器）时的退路：临时 textarea + execCommand。 */
function legacyCopy(text: string): boolean {
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/**
 * 复制口令码按钮。设计稿：未复制时"复制图标 + Copy code"，复制后 1.8 秒内变成"对勾 + Copied"（成功色）。
 *
 * 口令码是读者此刻要用的公开推广口令（见 `/go/<码>/app` 页），复制它不涉及任何敏感信息；这里只负责把传进来的字符串写进剪贴板，
 * 不记录、不上报（Owner 10-14 拍板：点击记录不做）。
 */
export function CopyCodeButton({
  code,
  label,
  copiedLabel,
}: {
  code: string;
  label: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    let ok = false;
    try {
      await navigator.clipboard.writeText(code);
      ok = true;
    } catch {
      ok = legacyCopy(code);
    }
    if (!ok) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_STATE_MS);
  }

  return (
    <>
      <button
        type="button"
        onClick={copy}
        data-testid="code-mode-copy"
        className="inline-flex h-11 shrink-0 items-center gap-2 rounded-novel-md border border-novel-border-strong bg-novel-bg-raised px-4 text-[0.9375rem] font-semibold text-novel-fg transition-colors hover:bg-novel-bg md:h-12 md:px-5 md:text-base"
      >
        {copied ? (
          <>
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-novel-success">
              <path d="M20 6L9 17l-5-5" />
            </svg>
            <span className="text-novel-success">{copiedLabel}</span>
          </>
        ) : (
          <>
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="12" height="12" rx="2" />
              <path d="M5 15V5a2 2 0 0 1 2-2h10" />
            </svg>
            <span>{label}</span>
          </>
        )}
      </button>
      {/* 读屏提示：复制成功后宣读一次"已复制"，按钮本身的文字变化不会被自动播报。 */}
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? copiedLabel : ""}
      </span>
    </>
  );
}
