"use client";

import { useState } from "react";
import { ButtonLink } from "@/components/Button";
import { Container } from "@/components/Container";
import { SiteShell, type SiteChrome } from "@/features/public-ui/layout/SiteShell";
import type { ChapterView } from "@/features/public-ui/types";
import { BookAttributionBar } from "./BookAttributionBar";
import { ChapterPager } from "./ChapterPager";
import { ReaderSettingsPanel } from "./ReaderSettingsPanel";
import {
  DEFAULT_READER_SETTINGS,
  normalizeReaderSettings,
  readerStyleVars,
  type ReaderSettings,
} from "./reader-settings";

/**
 * 章节阅读页。
 *
 * 作用域边界（不可协商）：**只有正文阅读区在阅读作用域里**。
 * 页头、页脚、归属条、章节导航、章末行动区始终留在站点作用域，不随系统偏好或
 * 用户选择翻转。这样浅色阅读模式下，页面仍然明确属于本站，而不是变成一张
 * 来路不明的白纸。
 *
 * 分期：本轮设置真实可切换但不持久化；P1-11 负责持久化、滚动位置恢复、
 * 章节切换不整页刷新。initialSettings 就是 P1-11 从本地存储灌入初值的接入点，
 * 届时不需要改这个组件的结构。
 */
export function ChapterScreen({
  chapter,
  chrome,
  initialSettings,
  onSettingsChange,
}: {
  chapter: ChapterView;
  chrome?: SiteChrome;
  /** P1-11 从本地存储读回的初值。本轮不传，走默认值。 */
  initialSettings?: Partial<ReaderSettings>;
  /** P1-11 的持久化回调挂载点。本轮不传。 */
  onSettingsChange?: (next: ReaderSettings) => void;
}) {
  const [settings, setSettings] = useState<ReaderSettings>(() =>
    normalizeReaderSettings(initialSettings),
  );
  const [panelOpen, setPanelOpen] = useState(false);

  function applySettings(next: ReaderSettings) {
    setSettings(next);
    onSettingsChange?.(next);
  }

  const isLastPreviewChapter =
    chapter.previewPosition.index >= chapter.previewPosition.total;

  return (
    <SiteShell chrome={chrome}>
      <Container>
        <BookAttributionBar novel={chapter.novel} previewPosition={chapter.previewPosition} />

        {/* 章节标题与设置入口，站点作用域 */}
        <div className="relative flex items-start justify-between gap-4 pt-8 md:pt-12">
          <div>
            <p className="text-sm text-novel-fg-subtle tabular-nums">
              第 {chapter.number} 章
            </p>
            <h1 className="mt-2 font-novel-serif text-2xl leading-tight font-semibold tracking-tight text-balance text-novel-fg md:text-3xl">
              {chapter.title}
            </h1>
          </div>

          <button
            type="button"
            onClick={() => setPanelOpen((open) => !open)}
            aria-expanded={panelOpen}
            aria-haspopup="dialog"
            className="mt-1 inline-flex shrink-0 items-center gap-2 rounded-novel-md border border-novel-border-strong px-3 py-2 text-sm text-novel-fg-muted transition-colors hover:bg-novel-bg-raised hover:text-novel-fg"
            data-testid="reader-settings-toggle"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M2 4h12M2 8h12M2 12h7"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
            阅读设置
          </button>

          <ReaderSettingsPanel
            open={panelOpen}
            settings={settings}
            onChange={applySettings}
            onClose={() => setPanelOpen(false)}
            onReset={() => applySettings(DEFAULT_READER_SETTINGS)}
          />
        </div>
      </Container>

      {/* --- 阅读区：唯一处于阅读作用域的部分 --- */}
      <div
        className="reader mt-8 md:mt-12"
        data-reader-theme={settings.theme}
        data-testid="reader-surface"
        style={readerStyleVars(settings)}
      >
        <Container>
          <div
            className="mx-auto py-10 md:py-16"
            style={{
              maxWidth: "var(--reader-measure)",
              fontSize: "var(--reader-font-size)",
              lineHeight: "var(--reader-line-height)",
            }}
            data-testid="reader-body"
          >
            {chapter.paragraphs.map((paragraph, index) => (
              // 西文为主，段间距代替首行缩进
              <p key={index} className="mt-[1em] first:mt-0">
                {paragraph}
              </p>
            ))}
          </div>
        </Container>
      </div>

      {/* --- 章末：导航 + 行动区，回到站点作用域 --- */}
      <Container>
        <div className="pt-10 md:pt-14">
          <ChapterPager previousHref={chapter.previousHref} nextHref={chapter.nextHref} />

          {/* 主次在这里反转：读到最后一章试读时，正式阅读才是那个最重的动作 */}
          {chapter.readOnUpstreamHref ? (
            <div className="mt-10 rounded-novel-lg border border-novel-border bg-novel-bg-elevated p-6 md:mt-14 md:p-8">
              <p className="font-novel-serif text-lg text-novel-fg md:text-xl">
                {isLastPreviewChapter
                  ? "本站的试读到此结束。"
                  : "想连着读下去？"}
              </p>
              <p className="mt-2 max-w-[52ch] text-sm text-novel-fg-muted">
                后续章节在原平台继续阅读。
              </p>
              <ButtonLink
                href={chapter.readOnUpstreamHref}
                variant={isLastPreviewChapter ? "accent" : "outline"}
                size="lg"
                rel="nofollow sponsored"
                className="mt-6"
              >
                前往正式阅读
              </ButtonLink>
            </div>
          ) : null}
        </div>
      </Container>
    </SiteShell>
  );
}
