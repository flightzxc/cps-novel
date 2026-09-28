"use client";

import { useEffect, useId, useRef } from "react";
import { ButtonLink } from "@/components/Button";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";

/**
 * 点击锁定章节条目弹出的确认弹窗。只有一个真正的动作——跳
 * `readOnUpstreamHref`——弹窗本身不生成任何新地址、不新增路由。
 *
 * 最小可访问性实现：`role="dialog"` + `aria-modal` + 打开时把焦点放进弹窗、
 * Esc 关闭、点击遮罩关闭。不做完整的焦点陷阱（本组件生命周期很短，且遮罩
 * 点击/Esc 已覆盖主要退出路径）。
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

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    dialogRef.current?.focus();
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
