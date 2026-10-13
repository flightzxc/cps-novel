import { codeModeCopy, DEFAULT_CODE_MODE_APP_NAME } from "@/lib/locale/code-mode-copy";

/**
 * 正式阅读入口（书页主按钮、章节页章末按钮、底部浮条）的文案与小字。
 *
 * link 模式（缺省）：返回 `null`——调用方一个字都不改，沿用原来的 `t("novel.readOnUpstream")` / `t("chapter.readOnUpstream")`。
 * 口令码模式（`mode === "code"`，PlotNovel）：按钮写 "Read on {App} App"，按钮下一行小字提示"口令码在下一页"；
 * 点击后走同一个 `/go/<站内码>`（站内码不变），由 `/go` 带到中间页展示口令码。
 */
export function codeModeReadOnCta(
  mode: "code" | undefined,
  appName: string | undefined,
): { label: string; hint: string } | null {
  if (mode !== "code") return null;
  const copy = codeModeCopy(appName ?? DEFAULT_CODE_MODE_APP_NAME);
  return { label: copy.readOnApp, hint: copy.readOnAppHint };
}

/** 按钮上的小箭头（设计稿"书页按钮"里的 ›）。装饰性，不进无障碍树。 */
export function ChevronRightIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}
