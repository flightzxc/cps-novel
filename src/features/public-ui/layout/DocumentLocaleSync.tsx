"use client";

import { useLayoutEffect } from "react";
import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { getTextDirection } from "@/lib/site/text-direction";

/**
 * 公开站页面外壳挂载后，把 `<html lang dir>` 同步成当前页面语种的值。
 *
 * 为什么需要：根布局（`src/app/layout.tsx`）只在**服务端渲染整页**时按请求头写
 * `<html lang dir>`。语言菜单用 `router.push` 做软跳转，根布局不会重渲染，
 * `<html>` 上遗留的是上一个语种的值——例如从英语首页切到阿拉伯语后，页面内容是
 * 阿拉伯语，根属性却仍是 `lang="en" dir="ltr"`，与直接打开 `/ar` 不一致。
 * （PN-02，2026-10-07 审计。）
 *
 * 取值与根布局同源：`lang` 就是页面 `locale`，`dir` 来自站点唯一的方向判定
 * `getTextDirection`（`src/lib/site/text-direction.ts`）。值相同不写，避免无谓的
 * 样式重算；不做卸载还原——下一页的外壳会写它自己的值，卸载时还原只会在两页之间
 * 闪回上一个语种。
 *
 * 🔴 用 `useLayoutEffect` 而不是 `useEffect`（与后台先例 `admin-document-lang.tsx` 的
 * 唯一差别，不是风格选择）：轮播轨道的 `transform` 带 `transition-transform
 * duration-500`，而它的位移公式随 `dir` 翻转。软跳转时新页面的外壳与轮播在同一次提交里
 * 挂载；若根属性要等到绘制之后的被动副作用才改，浏览器会先按**旧方向**算出并画出第一帧，
 * 随后 `dir` 翻转触发 500ms 过渡——轮播从屏幕外「飞入」（本机 390×844 实测首帧
 * x=3674px，约 0.5s 收敛到 36px）。布局副作用在同一次提交内、浏览器第一次计算样式
 * 之前执行，新挂载的轮播第一次样式计算就已是正确方向，不触发过渡（实测首帧 x=36px）。
 * 服务端渲染不执行任何副作用，React 19 对此也不再告警。
 *
 * 先例：`src/features/admin-ui/admin-document-lang.tsx`（后台同步 `<html lang>`）。
 */
export function DocumentLocaleSync({ locale }: { locale: SiteLocale }) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const dir = getTextDirection(locale);
    if (root.lang !== locale) {
      root.lang = locale;
    }
    if (root.dir !== dir) {
      root.dir = dir;
    }
  }, [locale]);

  return null;
}
