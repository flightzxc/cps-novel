"use client";

import { useEffect, useRef, type RefObject } from "react";
import {
  readReadingPosition,
  readingPositionKey,
  writeReadingPosition,
} from "./reader-storage";

/**
 * 阅读位置的记忆与恢复，粒度 `novel + chapter`。
 *
 * **为什么存段落锚点而不是 scrollY。** 裸像素值只在「排版参数一个字都没变」时
 * 才有意义。而这个阅读器的卖点恰恰是字号 / 行高 / 页宽可调——读者上次在 16px
 * 读到 3000px 处，这次改成 22px，同一个 3000px 落在完全不同的段落上。存
 * 「第几段 + 段内高度占比」，换任何排版参数、换任何视口宽度都还原到同一句话。
 *
 * **为什么恢复必须自己做、且必须关掉 App Router 的滚动接管。**
 * App Router 在 `ScrollAndFocusHandler` 的 `componentDidMount` /
 * `componentDidUpdate` 里滚动（`next/dist/client/components/layout-router.js`），
 * 而那一层是章节页的**祖先**。React 的 commit 回调是后代先于祖先，所以无论把恢复
 * 写在 `useLayoutEffect` 还是 `useEffect` 里，都会被祖先随后的滚动盖掉。解法是
 * 章节导航链接带 `scroll={false}`，把滚动控制权整个拿过来——代价是**没有存过位置
 * 的章节必须由我们显式滚到顶**，否则会留在上一章的滚动量上。
 */

/** 低于这个段落数的位置不值得恢复：读者才刚开头，跳一下反而突兀。 */
const RESTORE_MIN_PARAGRAPH_INDEX = 1;

export function useReadingPosition({
  novelKey,
  chapterNumber,
  containerRef,
  enabled = true,
}: {
  novelKey: string;
  chapterNumber: number;
  containerRef: RefObject<HTMLElement | null>;
  /**
   * 排版参数就位之前不要测量。
   *
   * 阅读偏好是补水后才从 localStorage 读回的；在那之前阅读区还是默认档，
   * 此刻算出的段落位置对应的是错误的排版，恢复会落在错的地方。
   */
  enabled?: boolean;
}): void {
  // 恢复完成前不许写入：恢复动作本身会触发 scroll 事件，
  // 若此时已经开始记录，就会把「尚未跳转的位置」覆盖掉真正存着的位置。
  const restoredRef = useRef(false);

  useEffect(() => {
    restoredRef.current = false;
    const container = containerRef.current;
    if (!enabled || !container) {
      return;
    }

    const key = readingPositionKey(novelKey, chapterNumber);
    const paragraphs = () =>
      Array.from(container.querySelectorAll<HTMLElement>("[data-paragraph-index]"));

    // --- 恢复 ---
    const saved = readReadingPosition(key);
    const nodes = paragraphs();
    if (
      saved &&
      saved.paragraphIndex >= RESTORE_MIN_PARAGRAPH_INDEX &&
      saved.paragraphIndex < nodes.length
    ) {
      const target = nodes[saved.paragraphIndex];
      const top = target.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top: top + target.offsetHeight * saved.ratio, behavior: "auto" });
    } else {
      // 没有可恢复的位置——因为链接带了 scroll={false}，这里必须自己回到顶部，
      // 否则切到新章节时会停在上一章的滚动量上。
      window.scrollTo({ top: 0, behavior: "auto" });
    }
    restoredRef.current = true;

    // --- 记录 ---
    let frame = 0;

    function capture() {
      if (!restoredRef.current) {
        return;
      }
      const nodeList = paragraphs();
      if (nodeList.length === 0) {
        return;
      }

      // 视口顶部落在哪一段：取最后一个「顶边已经越过视口顶部」的段落。
      let index = 0;
      for (let i = 0; i < nodeList.length; i += 1) {
        if (nodeList[i].getBoundingClientRect().top <= 0) {
          index = i;
        } else {
          break;
        }
      }

      const node = nodeList[index];
      const rect = node.getBoundingClientRect();
      const ratio = rect.height > 0 ? Math.min(Math.max(-rect.top / rect.height, 0), 1) : 0;
      writeReadingPosition(key, { paragraphIndex: index, ratio });
    }

    function onScroll() {
      // rAF 节流：滚动事件每帧可能来很多次，而我们只需要每帧记一次。
      if (frame) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        capture();
      });
    }

    // pagehide 覆盖了关标签页、前进后退缓存、以及 iOS 上不触发 unload 的情形；
    // visibilitychange 覆盖切到后台后被系统回收的情形。两者都只在离开时补一次。
    function onLeave() {
      capture();
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", onLeave);
    document.addEventListener("visibilitychange", onLeave);

    return () => {
      // 卸载前最后记一次：切换章节时这是唯一能留住当前位置的时机。
      capture();
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", onLeave);
      document.removeEventListener("visibilitychange", onLeave);
    };
  }, [novelKey, chapterNumber, containerRef, enabled]);
}
