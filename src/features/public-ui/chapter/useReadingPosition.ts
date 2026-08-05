"use client";

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
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
 *
 * **为什么「离章前的最后一次记录」必须挂在 layout effect 的 cleanup 上。**
 * 记录与恢复本身是 passive effect（`useEffect`），因为它们要在绘制之后才做。
 * 但 passive effect 的 cleanup 是在 commit 的 mutation 阶段**之后**才 flush 的，
 * 那时旧章节的 DOM 子树已经从文档里摘除。对已摘除的节点，
 * `getBoundingClientRect()` 恒返回全 0，于是「最后一个 top <= 0 的段落」对每一段
 * 都成立，位置会被算成末段、`ratio` 落到 0 分支——读者回到该章直接跳到章末。
 * layout effect 的 cleanup 在 mutation 阶段内、host 节点被摘除之前执行，
 * 那是最后一个还能量到真实几何的时机。
 */

/** 低于这个段落数的位置不值得恢复：读者才刚开头，跳一下反而突兀。 */
const RESTORE_MIN_PARAGRAPH_INDEX = 1;

/**
 * SSR 时 `useLayoutEffect` 会告警（服务端根本不跑 effect）。章节页是预渲染的，
 * 所以服务端退回 `useEffect`——两者在服务端都不执行，区别只是不再告警。
 */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * 量一次当前位置并落盘。返回是否真的写了。
 *
 * 🔴 **测不准就不写。** 三道守卫对应三种「DOM 还在、几何已经不可信」的状态，
 * 任何一种下写入都会用假数据覆盖掉上一次合法记录：
 *
 * 1. 阅读根已从文档摘除——切章时 passive cleanup 面对的就是这种树；
 * 2. 选中的段落节点自身已摘除；
 * 3. 段落高度为 0——没参与布局（`display:none`、尚未 layout），
 *    此时 `-rect.top / rect.height` 无意义。
 *
 * 旧实现在第 3 种情况下把 `ratio` 记成 0 继续写，等于把「量不到」当成「在段首」。
 */
function captureReadingPosition(container: HTMLElement, key: string): boolean {
  if (!container.isConnected) {
    return false;
  }

  const nodes = Array.from(container.querySelectorAll<HTMLElement>("[data-paragraph-index]"));
  if (nodes.length === 0) {
    return false;
  }

  // 视口顶部落在哪一段：取最后一个「顶边已经越过视口顶部」的段落。
  let index = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    if (!nodes[i].isConnected) {
      return false;
    }
    if (nodes[i].getBoundingClientRect().top <= 0) {
      index = i;
    } else {
      break;
    }
  }

  const rect = nodes[index].getBoundingClientRect();
  if (rect.height <= 0) {
    return false;
  }

  const ratio = Math.min(Math.max(-rect.top / rect.height, 0), 1);

  // 「停在第 0 段段首」与「没有记录」在恢复时是同一件事——`RESTORE_MIN_PARAGRAPH_INDEX`
  // 让 index 0 走回到顶部那一支。所以没有旧记录时不为它新建一条：只是路过、一眼没读的
  // 章节不该占掉 200 条的存储上限。恢复时那次 `scrollTo(0)` 在真实浏览器里会派发
  // scroll 事件，不挡住就等于「每翻过一章就写一条」。
  // 已有记录则照常更新：读者确实翻回章首时，旧位置必须被改掉。
  if (index === 0 && ratio === 0 && readReadingPosition(key) === null) {
    return false;
  }

  writeReadingPosition(key, { paragraphIndex: index, ratio });
  return true;
}

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
  /**
   * 有没有「比存储里更新」的滚动还没落盘。
   *
   * 只有它为真时离章才补记一次。这样两件事同时成立：读者滚到一半、rAF 那一帧还
   * 没跑就切章，位置不丢；而只是路过、一下都没滚的章节不会凭空多出一条记录——
   * 那种记录既是重复写入，也会挤占 200 条的存储上限。
   */
  const pendingRef = useRef(false);

  useEffect(() => {
    restoredRef.current = false;
    pendingRef.current = false;
    const container = containerRef.current;
    if (!enabled || !container) {
      return;
    }

    const key = readingPositionKey(novelKey, chapterNumber);

    // --- 恢复 ---
    const saved = readReadingPosition(key);
    const nodes = Array.from(container.querySelectorAll<HTMLElement>("[data-paragraph-index]"));
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
      if (captureReadingPosition(container!, key)) {
        pendingRef.current = false;
      }
    }

    function onScroll() {
      // 先置脏再节流：rAF 那一帧可能还没跑就切章，届时由 layout cleanup 补记。
      pendingRef.current = true;
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
      // 🔴 这里**不再** capture()：此刻旧章节的 DOM 已经摘除，量到的是全 0。
      // 离章前的最后一次记录由下面的 layout effect cleanup 负责。
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", onLeave);
      document.removeEventListener("visibilitychange", onLeave);
    };
  }, [novelKey, chapterNumber, containerRef, enabled]);

  /**
   * 离章前的最后一次记录。
   *
   * 与上面的 passive effect 同依赖，所以这里的 `key` 与 `container` 指的一定是
   * 正在离开的那一章。cleanup 在 commit 的 mutation 阶段内执行——host 节点还没被
   * 摘除，几何仍然可信，这是「切章不丢位置」唯一还量得准的时机。
   *
   * 只在有未落盘的滚动时才写：既避免与刚刚 flush 过的 rAF 重复写入，
   * 也让「只是路过、没读过」的章节不留下伪记录。
   */
  useIsomorphicLayoutEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container) {
      return;
    }
    const key = readingPositionKey(novelKey, chapterNumber);

    return () => {
      if (!restoredRef.current || !pendingRef.current) {
        return;
      }
      if (captureReadingPosition(container, key)) {
        pendingRef.current = false;
      }
    };
  }, [novelKey, chapterNumber, containerRef, enabled]);
}
