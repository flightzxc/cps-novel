import { ButtonNavLink } from "@/components/Button";

/**
 * 上一章 / 下一章。
 *
 * 边界处按钮不渲染（而不是渲染成禁用的链接）——一个不能去任何地方的链接对键盘
 * 和读屏用户是噪音。首尾位置用一句说明代替，让用户知道是到头了而不是坏了。
 *
 * 走客户端路由（`ButtonNavLink`），因此切章不整页刷新，layout 层的阅读设置与
 * 站点外壳都原样保留。
 *
 * 🔴 `scroll={false}` 不能去掉。App Router 默认会在导航后把页面滚到顶，而那段
 * 滚动发生在章节页**祖先**的 commit 回调里，晚于章节页自己的 effect，会盖掉
 * 阅读位置的恢复。关掉它之后，滚动完全由 `useReadingPosition` 负责——包括
 * 「新章节没有存过位置时显式回到顶部」这一条。
 */
export function ChapterPager({
  previousHref,
  nextHref,
  className = "",
}: {
  previousHref?: string;
  nextHref?: string;
  className?: string;
}) {
  return (
    <nav
      aria-label="章节导航"
      className={`flex items-center justify-between gap-3 ${className}`}
      data-testid="chapter-pager"
    >
      {previousHref ? (
        <ButtonNavLink href={previousHref} variant="outline" rel="prev" scroll={false}>
          上一章
        </ButtonNavLink>
      ) : (
        <span className="text-sm text-novel-fg-subtle">已是第一章</span>
      )}

      {nextHref ? (
        <ButtonNavLink href={nextHref} variant="outline" rel="next" scroll={false}>
          下一章
        </ButtonNavLink>
      ) : (
        <span className="text-sm text-novel-fg-subtle">已是最后一章试读</span>
      )}
    </nav>
  );
}
