import { collectCoverPreconnectOrigins } from "@/lib/site/cover-preconnect";

/**
 * 封面图床预连接（B-37 阶段 0）。服务端组件，渲染字面 `<link rel="preconnect">`。
 *
 * 沿用 CPS 先例（`promo-dns-hints.tsx`，v8.7.2）的做法：React 19 会把渲染在 body 里的
 * `<link>` 提升进 `<head>`，因此不需要 `"use client"`，也不需要 react-dom 的
 * `preconnect()`（仓库里此前没有任何 preconnect / dns-prefetch 用法可沿用）。
 * 与 CPS 的区别是这里用 preconnect 而不是 dns-prefetch，理由见
 * `collectCoverPreconnectOrigins` 的注释。
 *
 * 只放在**本页首屏一定会加载这张封面**的页面里（小说详情页、首页的初始轮播项），
 * 不要放进列表卡片——预连接是有成本的，对用不上的 origin 也是浪费。
 */
export function CoverPreconnect({
  urls,
}: {
  urls: ReadonlyArray<string | null | undefined>;
}) {
  const origins = collectCoverPreconnectOrigins(urls);
  if (origins.length === 0) return null;

  return (
    <>
      {origins.map((origin) => (
        <link rel="preconnect" href={origin} key={origin} />
      ))}
    </>
  );
}
