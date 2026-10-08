"use client";

import { useEffect, useId, useRef } from "react";
import { ButtonLink } from "@/components/Button";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";

/** 焦点循环要认的"可聚焦元素"。弹窗里目前只有关闭按钮与继续阅读链接，写成通用选择器，将来加控件自动覆盖。 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * 点击锁定章节条目弹出的确认弹窗。只有一个真正的动作——跳
 * `readOnUpstreamHref`——弹窗本身不生成任何新地址、不新增路由。
 *
 * 可访问性（PN-10，2026-10-08）：`role="dialog"` + `aria-modal`；打开时记下
 * 原先拿着焦点的元素（通常是被点的锁定章节按钮），把焦点放进弹窗；Tab /
 * Shift+Tab 在弹窗内的可聚焦元素之间首尾循环（关闭 ↔ 继续阅读），不会落到
 * 遮罩后面的页面内容；Esc 与点击遮罩关闭；关闭（卸载）时若记下的元素仍在
 * 文档中，把焦点还给它。
 *
 * 此前的实现只做了初始聚焦 + Esc，却声明了 `aria-modal`，并明说"不做完整的
 * 焦点陷阱"——审计实测 Tab 会穿过遮罩落到被挡住的相关推荐链接上（PN-10），
 * 所以这里补上焦点循环与焦点归还。没有引入新依赖，也没有改成原生
 * `<dialog>`（jsdom 不支持 `showModal`，现有用例会失效）。
 *
 * 已知边界：Safari 与 macOS 上的 Firefox 点击按钮时按钮不会获得焦点，此时
 * 打开弹窗前的 `document.activeElement` 是 `<body>`，没有可归还的对象，关闭后
 * 焦点留在页面起点（与改动前一致，不会更糟）；键盘触发（Enter / Space）与
 * Chrome 点击都能正确归还。
 *
 * 用 `getPublicT(locale)`（见 `ChapterListBody.tsx` 同一处注释）：不依赖
 * `MessagesProvider`，standalone 渲染（测试）与挂在 `SiteShell` 下（生产）
 * 都能工作。
 */
export function ContinueReadingModal({
  locale,
  chapterNumber,
  href,
  onClose,
}: {
  locale: SiteLocale;
  chapterNumber: number;
  href: string;
  onClose: () => void;
}) {
  const t = getPublicT(locale);
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  // 焦点进出：只在挂载 / 卸载各做一次（不依赖 onClose——父组件每次渲染都会给新的
  // onClose，放进依赖会让焦点在无关重渲染时被反复抢回弹窗或误归还）。
  // 必须先记 activeElement 再聚焦弹窗，顺序不能换。
  useEffect(() => {
    const opener = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      // 记下的元素已不在文档中（例如整页卸载）或根本没有具体元素（opener 是 <body>）就不归还。
      if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected) {
        opener.focus();
      }
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      // 只接管单纯的 Tab / Shift+Tab；带 Ctrl / Alt / Meta 的组合键交给浏览器。
      if (event.key !== "Tab" || event.ctrlKey || event.altKey || event.metaKey) return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) {
        // 弹窗里没有可聚焦元素：焦点就停在弹窗容器上，不放行到页面。
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey) {
        // 在第一个元素（或弹窗容器本身、或已跑到弹窗外）上回退 → 绕到最后一个。
        if (active === first || active === dialog || !dialog.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !dialog.contains(active)) {
        // 在最后一个元素（或已跑到弹窗外）上前进 → 绕回第一个。
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      data-testid="continue-reading-modal-backdrop"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-sm rounded-novel-lg border border-novel-border bg-novel-bg-elevated p-6 shadow-lg"
        data-testid="continue-reading-modal"
      >
        <h2 id={titleId} className="font-novel-serif text-lg font-semibold text-novel-fg">
          {t("novel.continueReadingModalTitle")}
        </h2>
        <p className="mt-2 text-sm text-novel-fg-muted">
          {t("novel.continueReadingModalBody", { number: chapterNumber })}
        </p>
        <div className="mt-5 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-novel-md px-3 py-2 text-sm text-novel-fg-muted hover:bg-novel-bg-raised"
            data-testid="continue-reading-modal-close"
          >
            {t("novel.closeDialog")}
          </button>
          <ButtonLink href={href} variant="accent" size="md" rel="nofollow sponsored">
            {t("novel.readOnUpstream")}
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}
