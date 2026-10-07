"use client";

import { useEffect } from "react";
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
 * 先例：`src/features/admin-ui/admin-document-lang.tsx`（后台同步 `<html lang>`）。
 */
export function DocumentLocaleSync({ locale }: { locale: SiteLocale }) {
  useEffect(() => {
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
