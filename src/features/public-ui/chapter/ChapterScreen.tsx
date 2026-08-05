"use client";

import { useRef, useState } from "react";
import { ButtonLink } from "@/components/Button";
import { Container } from "@/components/Container";
import { SiteShell, type SiteChrome } from "@/features/public-ui/layout/SiteShell";
import type { ChapterView } from "@/features/public-ui/types";
import { BookAttributionBar } from "./BookAttributionBar";
import { ChapterPager } from "./ChapterPager";
import { ReaderSettingsPanel } from "./ReaderSettingsPanel";
import { useReaderSettingsContext } from "./ReaderSettingsProvider";
import { useReadingPosition } from "./useReadingPosition";
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
 * 设置状态有两种模式：
 *
 *   **受控** —— 被挂在 `ReaderSettingsProvider` 下时（正常的章节路由就是这样），
 *   状态住在 layout 层的 Provider 里。切章时这个组件会重挂，但设置不会丢，
 *   这正是「章节切换保持阅读设置」得以成立的原因。
 *
 *   **自持** —— 独立渲染、没有 Provider 时（测试与将来可能的嵌入场景），
 *   退回组件内部的 useState，行为与 P1-10 完全一致。
 *
 * 之所以要两种模式而不是一律受控：`initialSettings` 只在惰性初始化里读一次，
 * 而 Provider 是在首帧之后才从 localStorage 补水的。若把状态留在这里，补水后的
 * 新初值传不进来，就得靠 `key=` 强制重挂——那既会打断滚动，也会丢面板开合状态。
 */
export function ChapterScreen({
  chapter,
  chrome,
  initialSettings,
  onSettingsChange,
}: {
  chapter: ChapterView;
  chrome?: SiteChrome;
  /** 无 Provider 时的初值。有 Provider 时以 Provider 的值为准。 */
  initialSettings?: Partial<ReaderSettings>;
  /** 设置变更的外部观察点。持久化本身由 Provider 负责，这里只是通知。 */
  onSettingsChange?: (next: ReaderSettings) => void;
}) {
  const readerSettingsContext = useReaderSettingsContext();
  const [localSettings, setLocalSettings] = useState<ReaderSettings>(() =>
    normalizeReaderSettings(initialSettings),
  );
  const [panelOpen, setPanelOpen] = useState(false);

  const settings = readerSettingsContext ? readerSettingsContext.settings : localSettings;

  // 自持模式下没有「等存储读回」这回事，settings 从第一帧起就是最终值。
  const hydrated = readerSettingsContext ? readerSettingsContext.hydrated : true;

  const readerBodyRef = useRef<HTMLDivElement>(null);
  useReadingPosition({
    novelKey: chapter.novel.id,
    chapterNumber: chapter.number,
    containerRef: readerBodyRef,
    // 补水前排版还是默认档，此时测量段落位置会算出错误的落点。
    enabled: hydrated,
  });

  /**
   * 设置变更的唯一出口。
   *
   * 🔴 规范化必须发生在**分流之前**：内存状态、localStorage 与 onSettingsChange
   * 三者拿到的是同一个 normalized 对象。若在这里放过一个非法值，受控分支会由
   * Provider 纠正、自持分支不会，回调则两种情形都拿到原始值——同一次点击在三个
   * 出口得到三种结果。
   *
   * 接受部分设置：调用方只描述改了什么，与当前设置的合并在这里完成。
   * 规范化是幂等的，Provider 内部再做一次不会得到不同结果。
   */
  function applySettings(patch: Partial<ReaderSettings>) {
    const normalized = normalizeReaderSettings({ ...settings, ...patch });

    if (readerSettingsContext) {
      readerSettingsContext.setSettings(normalized);
    } else {
      setLocalSettings(normalized);
    }
    onSettingsChange?.(normalized);
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
        /*
         * 补水前**不写**内联排版变量，交给 globals.css 里的 --reader-pref-* 兜底层
         * ——那一层的值由章节布局的防闪脚本在补水前就写好了。若这里在补水前写死
         * 默认档，内联样式会盖掉脚本的成果，排版仍旧闪一次。
         * 服务端与客户端首帧都取不到 context 的 hydrated=true，两边一致，不会 mismatch。
         */
        style={hydrated ? readerStyleVars(settings) : undefined}
      >
        <Container>
          <div
            ref={readerBodyRef}
            className="mx-auto py-10 md:py-16"
            style={{
              maxWidth: "var(--reader-measure)",
              fontSize: "var(--reader-font-size)",
              lineHeight: "var(--reader-line-height)",
            }}
            data-testid="reader-body"
          >
            {chapter.paragraphs.map((paragraph, index) => (
              // 西文为主，段间距代替首行缩进。
              // data-paragraph-index 是阅读位置的锚点：存「第几段 + 段内占比」
              // 而不是像素值，换字号 / 行高 / 页宽后仍然还原到同一句话。
              <p key={index} data-paragraph-index={index} className="mt-[1em] first:mt-0">
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
