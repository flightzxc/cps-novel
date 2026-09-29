"use client";

import { useState } from "react";
import { ButtonLink } from "@/components/Button";
import type { PreviewChapterRef } from "@/features/public-ui/types";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getPublicT } from "@/lib/locale/messages";
import { ContinueReadingModal } from "./ContinueReadingModal";

/**
 * 服务端 HTML 里最多渲染的锁定条目数（`PreviewChapterList.tsx` 头部注释规则 4）。
 * 超过这个数字时展示"展开全部"按钮，其余编号由客户端就地生成，不发请求。
 */
const SERVER_LOCKED_CAP = 30;

function LockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/**
 * 章节列表的可交互主体：真实章节链接 + 锁定条目 + 展开全部 + 阅读更多章节 +
 * 点击锁定条目弹出的续读弹窗。拆成客户端组件是因为锁定条目是按钮（需要
 * onClick 开弹窗）、展开动作是纯前端状态——`PreviewChapterList.tsx` 本身
 * 保持服务端组件，只负责区块标题与这个组件的输入契约。
 *
 * 🔴 用 `getPublicT(locale)` 而不是 `useT()`：本组件与 `PreviewChapterList`
 * 一样，既在 `NovelDetailScreen`/`ChapterScreen`（挂在 `SiteShell` 的
 * `MessagesProvider` 之下）里渲染，也在测试里被直接单独渲染（不经
 * `SiteShell`，比如 `tests/ui/preview-chapter-list-locked.test.tsx`）——
 * `useT()` 在没有 Provider 时会直接抛错，`getPublicT(locale)` 不依赖
 * Provider，两种渲染路径都能工作。
 */
export function ChapterListBody({
  locale,
  chapters,
  lockedStartNumber,
  lockedCount,
  totalChapterCount,
  readOnUpstreamHref,
}: {
  locale: SiteLocale;
  chapters: PreviewChapterRef[];
  /** 第一个锁定章节的编号（= 最大真实章节编号 + 1）。 */
  lockedStartNumber: number;
  /** 已经按"有没有 readOnUpstreamHref"折算过的锁定条目数——0 表示不渲染任何锁定 UI。 */
  lockedCount: number;
  /**
   * 全书总章数（`Novel.totalChapterCount`）。"展开全部 N 章"按钮上的 N 用它，
   * 不用 `lockedCount`：展开后列表显示的是真实章节 + 锁定条目，即整本书，
   * 按钮写"全部 N 章"时 N 必须是全书总数（否则 265 章的书会写成"全部 262 章"）。
   */
  totalChapterCount: number;
  readOnUpstreamHref?: string;
}) {
  const t = getPublicT(locale);
  const [expanded, setExpanded] = useState(false);
  const [modalChapterNumber, setModalChapterNumber] = useState<number | null>(null);

  const hasLocked = lockedCount > 0 && Boolean(readOnUpstreamHref);
  const visibleLockedCount = expanded ? lockedCount : Math.min(lockedCount, SERVER_LOCKED_CAP);
  const lockedNumbers = Array.from({ length: hasLocked ? visibleLockedCount : 0 }, (_, i) => lockedStartNumber + i);

  return (
    <>
      <ol className="list-none border-t border-novel-border p-0" data-testid="preview-chapter-list">
        {chapters.map((chapter) => (
          <li key={`real-${chapter.number}`} className="border-b border-novel-border">
            <a
              href={chapter.href}
              className="flex items-baseline gap-4 py-4 transition-colors hover:bg-novel-bg-elevated md:py-5"
              data-testid="chapter-list-link"
            >
              <span className="w-14 shrink-0 text-sm tabular-nums text-novel-fg-subtle md:w-16">
                {t("novel.chapterHeading", { number: chapter.number })}
              </span>
              <span className="font-novel-serif text-base text-novel-fg md:text-lg">{chapter.title}</span>
            </a>
          </li>
        ))}

        {lockedNumbers.map((number) => (
          <li key={`locked-${number}`} className="border-b border-novel-border">
            <button
              type="button"
              onClick={() => setModalChapterNumber(number)}
              className="flex w-full items-baseline gap-4 py-4 text-left text-novel-fg-subtle transition-colors hover:bg-novel-bg-elevated md:py-5"
              data-testid="locked-chapter-item"
            >
              <span className="flex w-14 shrink-0 items-center text-sm tabular-nums md:w-16">
                <LockIcon />
              </span>
              <span className="font-novel-serif text-base md:text-lg">
                {t("novel.chapterHeading", { number })}
              </span>
              <span className="sr-only">{t("novel.lockedChapterHint")}</span>
            </button>
          </li>
        ))}
      </ol>

      {hasLocked && !expanded && lockedCount > SERVER_LOCKED_CAP ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-4 text-sm font-medium text-novel-accent underline-offset-4 hover:underline"
          data-testid="expand-all-chapters"
        >
          {t("novel.expandAllChapters", { count: totalChapterCount })}
        </button>
      ) : null}

      {hasLocked ? (
        <div className="mt-6">
          <ButtonLink
            href={readOnUpstreamHref!}
            variant="outline"
            size="lg"
            rel="nofollow sponsored"
            data-testid="read-more-chapters"
          >
            {t("novel.readMoreChapters")}
          </ButtonLink>
        </div>
      ) : null}

      {modalChapterNumber !== null && readOnUpstreamHref ? (
        <ContinueReadingModal
          locale={locale}
          chapterNumber={modalChapterNumber}
          href={readOnUpstreamHref}
          onClose={() => setModalChapterNumber(null)}
        />
      ) : null}
    </>
  );
}
