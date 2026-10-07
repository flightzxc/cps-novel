"use client";

import { useCallback, useState } from "react";

/**
 * 封面。
 *
 * 两条设计约束：
 *   1. 比例只能来自 --novel-cover-aspect，组件里**不得**出现 3/4 或 2/3 这样的字面值。
 *      真实上游封面资产已经量过（见下），改比例时仍然只改 globals.css 那一行。
 *   2. 封面是全站唯一允许高饱和的区域。外面加一道极细内描边，让它看起来是「一个
 *      有厚度的物件」而不是「一块贴上去的图」——这是与短剧站海报网格的区隔点之一。
 *
 * 当前事实（2026-10-07，B-37 阶段 0）：
 *   - 书封是**上游图床直链**（cdreader 固定路径，无签名、无查询串、无防盗链），
 *     不经本站转存、不经 `next/image`。实测全部是 250×350、约 18KB 的 JPEG，
 *     用原生 `<img>` 即可，没有可优化的体积。
 *   - 直链意味着图床随时可能失效（换域名、下架、临时故障）。**加载失败时渲染下面的
 *     「无封面占位」**，而不是让浏览器露出原生破图图标——卡片的版面节奏不能因为
 *     一张图失效就塌掉。
 *   - 失败判定有两条路径，缺一不可：
 *       a. `onError`——React 已经接管后才失败的图；
 *       b. 挂载时 `img.complete && img.naturalWidth === 0`——服务端渲染出来的
 *          `<img>` 可能在水合（React 挂上 onError）**之前**就已经失败了，浏览器
 *          不会为一个已经失败的图再补发 error 事件，只剩这条检查能兜住。
 *   - 默认 `loading="lazy"`；首屏一定可见的封面（详情页主封面、首页轮播的初始项）
 *     传 `priority`，改为 `eager` + `fetchPriority="high"`。
 *
 * 缺图（没有 src）与加载失败共用同一个占位块，而不是隐藏——同样是为了版面节奏。
 */
export function CoverImage({
  src,
  alt,
  className = "",
  sizeHint,
  priority = false,
}: {
  src?: string;
  /** 无障碍替代文本。装饰性使用时传空字符串。 */
  alt: string;
  className?: string;
  /** 传给浏览器的尺寸提示，纯性能用途 */
  sizeHint?: string;
  /**
   * 首屏一定可见的封面传 true：`loading="eager"` + `fetchPriority="high"`。
   * 默认 false（lazy）。不要给列表里的每一张都传——优先级是相对的，全部拉高等于没拉。
   */
  priority?: boolean;
}) {
  // 以 src 为 key：src 变化时整棵子树重挂，「是否已失败」的状态天然归零，
  // 不需要在 effect 里手动复位（那会多渲染一帧，还会被 react-hooks 的
  // set-state-in-effect 规则拦下）。
  return (
    <CoverFrame
      key={src ?? ""}
      src={src}
      alt={alt}
      className={className}
      sizeHint={sizeHint}
      priority={priority}
    />
  );
}

function CoverFrame({
  src,
  alt,
  className,
  sizeHint,
  priority,
}: {
  src?: string;
  alt: string;
  className: string;
  sizeHint?: string;
  priority: boolean;
}) {
  const [failed, setFailed] = useState(false);

  // 水合前就已失败的图：ref 回调在提交阶段（挂载 / 水合完成后）触发，此时检查
  // 浏览器已经给出的结果。`complete` 为 true 且 `naturalWidth` 为 0 即「加载结束
  // 但没有拿到图像」。用 ref 回调而不是 effect：这是读 DOM 的一次性同步检查，
  // 不是「根据 props 派生 state」。
  const checkAlreadyBroken = useCallback((img: HTMLImageElement | null) => {
    if (img && img.complete && img.naturalWidth === 0) {
      setFailed(true);
    }
  }, []);

  const showImage = Boolean(src) && !failed;

  return (
    <div
      className={`relative overflow-hidden rounded-novel-md bg-novel-bg-raised ${className}`}
      style={{ aspectRatio: "var(--novel-cover-aspect)" }}
      data-cover-state={showImage ? "image" : src ? "failed" : "empty"}
    >
      {showImage ? (
        // 上游直链，原生 img（理由见组件顶部「当前事实」）。
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={checkAlreadyBroken}
          src={src}
          alt={alt}
          sizes={sizeHint}
          className="h-full w-full object-cover"
          loading={priority ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : undefined}
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <div
          aria-hidden="true"
          className="flex h-full w-full items-center justify-center"
        >
          {/* 无封面占位：一条极简的书脊示意，不表意、不含品牌信息 */}
          <svg
            width="28"
            height="36"
            viewBox="0 0 28 36"
            fill="none"
            className="text-novel-fg-subtle opacity-50"
          >
            <rect
              x="1"
              y="1"
              width="26"
              height="34"
              rx="2"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path d="M8 1v34" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </div>
      )}
      {/* 内描边：不占布局，只给封面一个边界 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-novel-md ring-1 ring-inset ring-novel-border"
      />
    </div>
  );
}
